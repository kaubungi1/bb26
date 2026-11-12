"""불법위키. 문서는 사람이 제목으로 만들고, 누구나 그 자리에서 고친다.

신원은 닉네임 문자열이다(사이트의 다른 곳과 같다). 막는 장치가 없으므로 되돌릴 수 있는 것이 전부다.
  고침      블록 하나씩 "이 상태로" 받는다(PUT, 같은 요청을 두 번 보내도 같다). 블록 번호(cid)는 화면이 만든다.
  이력      고칠 때마다 문서 전체를 판(wikiRevisions)으로 남긴다. 한 사람이 이어서 고친 것은 한 판으로 묶는다 —
            문단마다 저장하므로 묶지 않으면 한 번 쓴 글이 수십 판이 된다.
  삭제      지운 문서는 표시만 바뀐다. 본문과 이력은 그대로 있고 누구나 되살린다. DB 에서 지우는 길은 없다.
  충돌      블록마다 번호(rev)가 있다. 내가 본 번호와 다르면 409 로 지금 내용을 돌려준다.
            서로 다른 문단을 고친 두 사람은 부딪히지 않는다.

전송량(AI_MEMORY '설계 유의점'):
  문서는 폴링하지 않는다. 열 때 한 번 받고, 판 번호가 같으면 304 다.
  폴링되는 것은 제목 목록과 최근 바뀜 둘이고 listcache 를 탄다. 블록을 고쳐도 wikiPages 는 건드리지 않는다 —
  건드리면 문단 하나 고칠 때마다 모든 탭이 제목 목록을 다시 받는다.
  그림은 imageserve(버전 주소 + 서버 메모리 + 30일 캐시). 올린 그림은 바뀌지 않아 forget() 할 일이 없다.
  wikiImages 의 "image"(BYTEA)는 그림을 줄 때만 읽는다.
"""
import io

from fastapi import APIRouter, File, HTTPException, Request, Response, UploadFile
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse
from PIL import Image
from psycopg.types.json import Json

import imageserve
import listcache
import wikitext
from db import get_db
from helpers import like_escape
from images import MAX_UPLOAD, fit_webp

router = APIRouter()

MERGE_MINUTES = 10                     # 같은 사람이 이 안에 이어 고치면 한 판
IMAGE_BUDGET = 150 * 1024 * 1024       # 위키 그림 전체. Neon 저장 한도 안에 머물게 하는 천장이다
NOTE_KEEP = 12                         # 한 판에 남기는 요약 줄 수
SEALED = ('revert', 'delete', 'restore')   # 이 판들은 뒤의 고침과 묶지 않는다(_record)
SNIPPET = 200
TALK_MAX = 300
RECENT = 60
HISTORY = 100
SEARCH = 30

PAGE_COLS = '"id","title","key","categories","deleted","autoProfile"'


# ---------- 공통 ----------
def _nick(value):
    nick = wikitext.line(value, wikitext.NICK_MAX + 1)
    if not nick or len(nick) > wikitext.NICK_MAX:
        raise HTTPException(400, 'nickname은 필수입니다.')
    return nick


def _guard(fn, *args):
    """wikitext 의 Bad 를 400 으로."""
    try:
        return fn(*args)
    except wikitext.Bad as exc:
        raise HTTPException(400, str(exc))


def _page(conn, page_id, lock=False):
    """lock: 이 문서의 쓰기를 줄 세운다. 두 사람이 동시에 고칠 때 판(문서 전체 사본)이 서로를 빠뜨리지 않게."""
    row = conn.execute(f'SELECT {PAGE_COLS} FROM wikiPages WHERE "id"=%s' + (' FOR UPDATE' if lock else ''),
                       (page_id,)).fetchone()
    if not row:
        raise HTTPException(404, '문서를 찾을 수 없습니다.')
    return row


def _find(conn, key):
    """열쇠로 문서를 찾는다. 제목이 먼저고 다음이 다른 이름이다. (문서, 거쳐 온 다른 이름)"""
    row = conn.execute(f'SELECT {PAGE_COLS} FROM wikiPages WHERE "key"=%s', (key,)).fetchone()
    if row:
        return row, None
    alias = conn.execute('SELECT "pageId","alias" FROM wikiAliases WHERE "key"=%s', (key,)).fetchone()
    if not alias:
        return None, None
    return _page(conn, alias['pageId']), alias['alias']


def _aliases(conn, page_id):
    rows = conn.execute('SELECT "alias" FROM wikiAliases WHERE "pageId"=%s ORDER BY "id"', (page_id,)).fetchall()
    return [r['alias'] for r in rows]


def _blocks(conn, page_id):
    rows = conn.execute('SELECT "cid","kind","data","rev" FROM wikiBlocks WHERE "pageId"=%s ORDER BY "pos","id"',
                        (page_id,)).fetchall()
    return [dict(r) for r in rows]


def _last(conn, page_id):
    """마지막 판의 번호·시각·고친 사람. 사본(snapshot)은 읽지 않는다."""
    return conn.execute('SELECT "id","updatedAt","nickname" FROM wikiRevisions WHERE "pageId"=%s '
                        'ORDER BY "id" DESC LIMIT 1', (page_id,)).fetchone()


def _version(conn, page_id):
    """문서의 판 번호. 무엇을 고치든 판이 새로 생기거나 고쳐지므로 마지막 판의 (번호, 고친 시각)이면 된다."""
    row = _last(conn, page_id)
    return f"{row['id']}.{int(row['updatedAt'].timestamp() * 1_000_000)}" if row else '0'


def _image_ids(blocks):
    ids = set()
    for b in blocks:
        if b['kind'] in ('img', 'infobox') and b['data'].get('image'):
            ids.add(b['data']['image'])
    return ids


def _image_url(image_id):
    return f'/api/wiki/images/{image_id}?v=1.{imageserve.IMAGE_REV}'


def _images(conn, blocks):
    """블록이 쓰는 그림의 주소와 크기. 화면은 주소를 만들지 않고 이것을 쓴다(imageserve.py 의 규칙)."""
    ids = list(_image_ids(blocks))
    if not ids:
        return {}
    rows = conn.execute('SELECT "id","width","height" FROM wikiImages WHERE "id" = ANY(%s)', (ids,)).fetchall()
    return {str(r['id']): {'url': _image_url(r['id']), 'w': r['width'], 'h': r['height']} for r in rows}


def _doc(conn, page, via=None):
    blocks = _blocks(conn, page['id'])
    last = _last(conn, page['id'])
    return {'exists': True, 'id': page['id'], 'title': page['title'], 'key': page['key'],
            'deleted': page['deleted'], 'categories': page['categories'], 'aliases': _aliases(conn, page['id']),
            'autoProfile': page['autoProfile'],
            'blocks': blocks, 'images': _images(conn, blocks), 'version': _version(conn, page['id']), 'via': via,
            # 문서 머리의 '최근 수정 시각'
            'updatedAt': last and last['updatedAt'], 'updatedBy': last and last['nickname']}


def _meta(conn, page_id):
    page = _page(conn, page_id)
    return {'id': page['id'], 'title': page['title'], 'key': page['key'], 'deleted': page['deleted'],
            'autoProfile': page['autoProfile'], 'categories': page['categories'], 'aliases': _aliases(conn, page_id), 'version': _version(conn, page_id)}


def _snippet(text):
    text = ' '.join((text or '').split())
    return text if len(text) <= SNIPPET else text[:SNIPPET - 1] + '…'


def _added(old, new):
    """새 글에서 옛 글에 없던 가운데 토막. 앞뒤로 같은 부분을 걷어 낸다."""
    n = min(len(old), len(new))
    i = 0
    while i < n and old[i] == new[i]:
        i += 1
    j = 0
    while j < n - i and old[-1 - j] == new[-1 - j]:
        j += 1
    return new[i:len(new) - j]


def _record(conn, page_id, nickname, slot, kind, text='', fresh=False):
    """판을 남긴다. 요약 줄 하나."""
    _record_many(conn, page_id, nickname, [(slot, kind, text)], fresh)


def _record_many(conn, page_id, nickname, items, fresh=False):
    """판을 남긴다. 같은 사람이 MERGE_MINUTES 안에 이어 고친 것이면 마지막 판을 고쳐 쓴다(fresh 면 늘 새 판).
    items 는 (slot, kind, text) 들이다. slot 은 요약 줄의 자리다 — 같은 문단을 여러 번 고치면 그 문단의 줄 하나만 남는다."""
    page = _page(conn, page_id)
    snapshot = {'title': page['title'], 'categories': page['categories'], 'deleted': page['deleted'],
                'blocks': [{'cid': b['cid'], 'kind': b['kind'], 'data': b['data']} for b in _blocks(conn, page_id)]}
    fresh_notes = [{'c': slot, 'k': kind, 't': _snippet(text)} for slot, kind, text in items]
    slots = {n['c'] for n in fresh_notes}
    last = None
    if not fresh:
        last = conn.execute(
            'SELECT "id","nickname","notes", (now() - "createdAt" < %s * interval \'1 minute\') AS "open" '
            'FROM wikiRevisions WHERE "pageId"=%s ORDER BY "id" DESC LIMIT 1', (MERGE_MINUTES, page_id)).fetchone()
    # 되돌린 판·지운 판·되살린 판에는 이어 붙이지 않는다. 그 판의 사본은 '그때의 문서'로 남아야 다시 그리로 돌아갈 수 있다.
    sealed = last and any(n.get('k') in SEALED for n in (last['notes'] or []))
    if last and last['open'] and last['nickname'] == nickname and not sealed:
        notes = [n for n in (last['notes'] or []) if n.get('c') not in slots] + fresh_notes
        conn.execute('UPDATE wikiRevisions SET "snapshot"=%s, "notes"=%s, "updatedAt"=now() WHERE "id"=%s',
                     (Json(snapshot), Json(notes[-NOTE_KEEP:]), last['id']))
    else:
        conn.execute('INSERT INTO wikiRevisions ("pageId","nickname","snapshot","notes") VALUES (%s,%s,%s,%s)',
                     (page_id, nickname, Json(snapshot), Json(fresh_notes[-NOTE_KEEP:])))


def _taken(conn, key, page_id):
    """이 열쇠를 다른 문서가 제목이나 다른 이름으로 쓰고 있으면 그 문서 제목."""
    row = conn.execute('SELECT "title" FROM wikiPages WHERE "key"=%s AND "id"<>%s', (key, page_id)).fetchone()
    if row:
        return row['title']
    row = conn.execute('SELECT p."title" FROM wikiAliases a JOIN wikiPages p ON p."id"=a."pageId" '
                       'WHERE a."key"=%s AND a."pageId"<>%s', (key, page_id)).fetchone()
    return row['title'] if row else None


# ---------- 폴링되는 목록 ----------
@router.get('/titles')
def list_titles(request: Request):
    """지워지지 않은 문서의 제목·다른 이름·분류. 화면의 자동 링크·찾기·분류 목록이 모두 이것 하나로 돈다."""
    def build(conn):
        pages = conn.execute('SELECT "id","title","key","categories" FROM wikiPages WHERE NOT "deleted" '
                             'ORDER BY "title"').fetchall()
        by_page = {}
        for a in conn.execute('SELECT a."pageId",a."alias",a."key" FROM wikiAliases a JOIN wikiPages p '
                              'ON p."id"=a."pageId" WHERE NOT p."deleted" ORDER BY a."id"').fetchall():
            by_page.setdefault(a['pageId'], []).append({'alias': a['alias'], 'key': a['key']})
        return [{**dict(p), 'aliases': by_page.get(p['id'], [])} for p in pages]
    return listcache.serve(request, 'wiki-titles', listcache.WIKI_TITLES, build)


@router.get('/recent')
def list_recent(request: Request):
    """최근 바뀜. 누가 어느 문서에 무엇을 썼는지 — 판 사본(snapshot)은 읽지 않는다."""
    def build(conn):
        rows = conn.execute(
            'SELECT r."id",r."nickname",r."notes",r."updatedAt",p."id" AS "pageId",p."title",p."deleted" '
            'FROM wikiRevisions r JOIN wikiPages p ON p."id"=r."pageId" '
            'ORDER BY r."updatedAt" DESC, r."id" DESC LIMIT %s', (RECENT,)).fetchall()
        return [{'id': r['id'], 'nickname': r['nickname'], 'at': r['updatedAt'], 'lines': (r['notes'] or [])[-3:],
                 'page': {'id': r['pageId'], 'title': r['title'], 'deleted': r['deleted']}} for r in rows]
    return listcache.serve(request, 'wiki-recent', listcache.WIKI_RECENT, build)


# ---------- 문서 ----------
def _same_tag(etag, header):
    want = etag.removeprefix('W/')
    return any(t.strip().removeprefix('W/') == want for t in (header or '').split(','))


@router.get('/page')
def get_page(title: str, request: Request):
    """제목(또는 다른 이름)으로 문서를 받는다. 없으면 exists:false — 없는 문서는 오류가 아니라 쓸 자리다."""
    clean = wikitext.line(title, wikitext.TITLE_MAX)
    conn = get_db()
    try:
        page, via = _find(conn, wikitext.key(clean)) if clean else (None, None)
        if not page:
            return {'exists': False, 'title': clean}
        etag = f'W/"wikipage-{page["id"]}-{_version(conn, page["id"])}"'
        headers = {'ETag': etag, 'Cache-Control': 'no-cache'}
        if _same_tag(etag, request.headers.get('if-none-match')):
            return Response(status_code=304, headers=headers)
        doc = _doc(conn, page, via)
    finally:
        conn.close()
    return JSONResponse(content=jsonable_encoder(doc), headers=headers)


@router.post('/pages')
def create_page(body: dict):
    """제목으로 문서를 만든다. 열쇠가 같은 문서(띄어쓰기만 다른 제목, 다른 이름)가 있으면 그 문서를 돌려준다."""
    nickname = _nick(body.get('nickname'))
    clean = _guard(wikitext.title, body.get('title'))
    key = wikitext.key(clean)
    conn = get_db()
    try:
        page, via = _find(conn, key)
        if not page:
            row = conn.execute(
                'INSERT INTO wikiPages ("title","key","createdBy") VALUES (%s,%s,%s) '
                'ON CONFLICT ("key") DO NOTHING RETURNING "id"', (clean, key, nickname)).fetchone()
            if row:
                _record(conn, row['id'], nickname, '@new', 'new', clean, fresh=True)
                conn.commit()
            page, via = _find(conn, key)      # 동시에 같은 제목을 만들었으면 먼저 만든 쪽이 나온다
        return _doc(conn, page, via)
    finally:
        conn.close()


@router.put('/pages/{page_id}')
def update_page(page_id: int, body: dict):
    """제목·다른 이름·분류·지움 표시. 보낸 칸만 그 값으로 맞춘다."""
    nickname = _nick(body.get('nickname'))
    conn = get_db()
    try:
        page = _page(conn, page_id, lock=True)
        changed = False
        if 'title' in body:
            clean = _guard(wikitext.title, body['title'])
            key = wikitext.key(clean)
            if clean != page['title']:
                if key != page['key']:
                    other = _taken(conn, key, page_id)
                    if other:
                        raise HTTPException(409, f"'{other}' 문서가 이미 그 이름을 씁니다.")
                    # 옛 제목은 다른 이름으로 남긴다. 다른 문서들이 옛 제목으로 부르던 링크가 끊기지 않는다.
                    conn.execute('DELETE FROM wikiAliases WHERE "pageId"=%s AND "key"=%s', (page_id, key))
                    conn.execute('INSERT INTO wikiAliases ("pageId","alias","key") VALUES (%s,%s,%s) '
                                 'ON CONFLICT ("key") DO NOTHING', (page_id, page['title'], page['key']))
                conn.execute('UPDATE wikiPages SET "title"=%s, "key"=%s, "updatedAt"=now() WHERE "id"=%s',
                             (clean, key, page_id))
                _record(conn, page_id, nickname, '@title', 'title', clean)
                page = _page(conn, page_id)
                changed = True
        if 'aliases' in body:
            wanted = _guard(wikitext.names, body['aliases'], wikitext.ALIAS_MAX, wikitext.TITLE_MAX)
            wanted = [a for a in wanted if wikitext.key(a) != page['key']]
            if wanted != _aliases(conn, page_id):
                for a in wanted:
                    other = _taken(conn, wikitext.key(a), page_id)
                    if other:
                        raise HTTPException(409, f"'{a}' 은(는) 이미 '{other}' 문서로 가는 이름입니다.")
                conn.execute('DELETE FROM wikiAliases WHERE "pageId"=%s', (page_id,))
                for a in wanted:
                    conn.execute('INSERT INTO wikiAliases ("pageId","alias","key") VALUES (%s,%s,%s)',
                                 (page_id, a, wikitext.key(a)))
                _record(conn, page_id, nickname, '@alias', 'alias', ', '.join(wanted))
                changed = True
        if 'categories' in body:
            wanted = _guard(wikitext.names, body['categories'], wikitext.CATEGORY_MAX, wikitext.CATEGORY_LEN)
            if wanted != page['categories']:
                conn.execute('UPDATE wikiPages SET "categories"=%s, "updatedAt"=now() WHERE "id"=%s',
                             (Json(wanted), page_id))
                _record(conn, page_id, nickname, '@cats', 'cats', ', '.join(wanted))
                changed = True
        if 'deleted' in body and bool(body['deleted']) != page['deleted']:
            gone = bool(body['deleted'])
            conn.execute('UPDATE wikiPages SET "deleted"=%s, "updatedAt"=now() WHERE "id"=%s', (gone, page_id))
            _record(conn, page_id, nickname, '@gone', 'delete' if gone else 'restore', page['title'], fresh=True)
            changed = True
        if 'autoProfile' in body and bool(body['autoProfile']) != page['autoProfile']:
            # 멤버 문서의 프로필 표를 지웠다(또는 다시 켠다). 화면이 표를 지우고 저장할 때 false 로 보낸다.
            on = bool(body['autoProfile'])
            conn.execute('UPDATE wikiPages SET "autoProfile"=%s, "updatedAt"=now() WHERE "id"=%s', (on, page_id))
            _record(conn, page_id, nickname, '@profile', 'profile', '켬' if on else '끔')
            changed = True
        if changed:
            conn.commit()
        return _meta(conn, page_id)
    finally:
        conn.close()


# ---------- 블록 ----------
def _place(conn, page_id, cid, after):
    """after(블록 번호, None 이면 맨 앞) 바로 뒤의 자리값. 사이가 너무 좁아지면 문서 전체를 다시 매긴다."""
    def spot():
        prev = None
        if after is not None and after != cid:
            row = conn.execute('SELECT "pos" FROM wikiBlocks WHERE "pageId"=%s AND "cid"=%s', (page_id, after)).fetchone()
            if not row:      # 기준 블록이 그새 지워졌다. 맨 뒤에 놓는다
                last = conn.execute('SELECT max("pos") m FROM wikiBlocks WHERE "pageId"=%s AND "cid"<>%s',
                                    (page_id, cid)).fetchone()['m']
                return (last or 0) + 1, None
            prev = row['pos']
        nxt = conn.execute(
            'SELECT min("pos") m FROM wikiBlocks WHERE "pageId"=%s AND "cid"<>%s' +
            (' AND "pos">%s' if prev is not None else ''),
            (page_id, cid, prev) if prev is not None else (page_id, cid)).fetchone()['m']
        if prev is None:
            return (nxt - 1 if nxt is not None else 1), None
        if nxt is None:
            return prev + 1, None
        return (prev + nxt) / 2, nxt - prev
    pos, gap = spot()
    if gap is not None and gap < 1e-6:
        rows = conn.execute('SELECT "id" FROM wikiBlocks WHERE "pageId"=%s ORDER BY "pos","id"', (page_id,)).fetchall()
        for i, r in enumerate(rows):
            conn.execute('UPDATE wikiBlocks SET "pos"=%s WHERE "id"=%s', (float(i + 1), r['id']))
        pos, _ = spot()
    return pos


def _note_for(kind, data, old_text):
    """요약 줄. 글 블록은 새로 쓴 토막을, 짧게 고친 것은 문단 전체를 보여 준다."""
    text = wikitext.shown(kind, data)
    if kind in wikitext.TEXT_KINDS or kind == 'fold':
        added = _added(old_text, text).strip()
        return 'text', (added if len(added) >= 8 else text)
    return kind, text


def _apply(conn, page_id, nickname, cid, kind, data, base, moving, after):
    """블록 하나를 이 내용으로 맞춘다. (겹쳐 쓴 블록 | None, 요약 줄 (kind, text) | None) 을 돌려준다.
    겹쳐 썼으면 아무것도 바꾸지 않는다. 내용도 자리도 그대로면 요약 줄이 없다."""
    old = conn.execute('SELECT "id","kind","data","rev" FROM wikiBlocks WHERE "pageId"=%s AND "cid"=%s',
                       (page_id, cid)).fetchone()
    text = wikitext.plain(kind, data)
    if old:
        same = old['kind'] == kind and old['data'] == data
        if old['rev'] != base and not same:
            return {'cid': cid, 'kind': old['kind'], 'data': old['data'], 'rev': old['rev']}, None
        if same and not moving:
            return None, None
        if moving:
            conn.execute('UPDATE wikiBlocks SET "pos"=%s WHERE "id"=%s', (_place(conn, page_id, cid, after), old['id']))
        if not same:
            conn.execute('UPDATE wikiBlocks SET "kind"=%s,"data"=%s,"text"=%s,"textKey"=%s,"rev"="rev"+1,'
                         '"updatedBy"=%s,"updatedAt"=now() WHERE "id"=%s',
                         (kind, Json(data), text, wikitext.key(text), nickname, old['id']))
        return None, (_note_for(kind, data, wikitext.shown(old['kind'], old['data'])) if not same else ('move', ''))
    count = conn.execute('SELECT count(*) c FROM wikiBlocks WHERE "pageId"=%s', (page_id,)).fetchone()['c']
    if count >= wikitext.BLOCK_MAX:
        raise HTTPException(400, f'한 문서는 {wikitext.BLOCK_MAX}블록까지입니다.')
    if moving:
        pos = _place(conn, page_id, cid, after)
    else:
        pos = (conn.execute('SELECT max("pos") m FROM wikiBlocks WHERE "pageId"=%s', (page_id,)).fetchone()['m'] or 0) + 1
    conn.execute('INSERT INTO wikiBlocks ("pageId","cid","pos","kind","data","text","textKey","updatedBy") '
                 'VALUES (%s,%s,%s,%s,%s,%s,%s,%s)',
                 (page_id, cid, pos, kind, Json(data), text, wikitext.key(text), nickname))
    return None, _note_for(kind, data, '')


def _block_input(cid, body):
    """요청에 실린 블록 하나를 검증해 (cid, kind, data, base, moving, after) 로."""
    cid = _guard(wikitext.cid, cid)
    kind = body.get('kind')
    data = _guard(wikitext.block, kind, body.get('data'))
    if wikitext.empty(kind, data):
        raise HTTPException(400, '빈 블록은 저장하지 않습니다.')
    after = body.get('after')
    if after is not None:
        after = _guard(wikitext.cid, after)
    return cid, kind, data, body.get('base'), 'after' in body, after


@router.put('/pages/{page_id}/blocks/{cid}')
def put_block(page_id: int, cid: str, body: dict):
    """블록을 이 내용으로. 없으면 만든다. base 는 화면이 보고 있던 번호(새 블록은 0).
    after 를 보내면 그 블록 뒤로 놓는다(None 이면 맨 앞). 안 보내면 있던 자리, 새 블록은 맨 뒤."""
    nickname = _nick(body.get('nickname'))
    cid, kind, data, base, moving, after = _block_input(cid, body)
    conn = get_db()
    try:
        page = _page(conn, page_id, lock=True)
        if page['deleted']:
            raise HTTPException(409, '지워진 문서입니다. 되살린 뒤에 고칠 수 있습니다.')
        theirs, note = _apply(conn, page_id, nickname, cid, kind, data, base, moving, after)
        if theirs:
            raise HTTPException(409, {'message': '다른 사람이 먼저 고쳤습니다.', 'code': 'conflict', 'block': theirs})
        if note:
            _record(conn, page_id, nickname, cid, note[0], note[1])
            conn.commit()
        row = conn.execute('SELECT "cid","kind","data","rev" FROM wikiBlocks WHERE "pageId"=%s AND "cid"=%s',
                           (page_id, cid)).fetchone()
        return {'block': dict(row), 'images': _images(conn, [row]), 'version': _version(conn, page_id)}
    finally:
        conn.close()


@router.post('/pages/{page_id}/save')
def save_page(page_id: int, body: dict):
    """편집 화면의 '저장'. 뺀 블록과 고친 블록을 한 번의 요청·한 번의 트랜잭션으로 받는다.
      {"nickname": …, "removed": [cid, …], "blocks": [{"cid", "kind", "data", "base", "after"(옮기거나 새로 만든 것만)}, …]}
    blocks 는 문서 순서대로 온다. 새 블록의 after 가 같은 요청의 앞 블록이어도 된다(차례로 넣는다).
    한 블록이라도 겹쳐 썼으면 아무것도 저장하지 않고 409 로 겹친 블록들을 돌려준다 — 반쯤 저장된 문서를 남기지 않는다.
    블록마다 요청을 보내던 때에는 나무위키 문서 하나(블록 150개)를 붙여넣으면 저장에 1분이 넘게 걸리고
    그때마다 문서 전체 사본(판)을 다시 썼다. 판은 여기서 한 번만 쓴다."""
    nickname = _nick(body.get('nickname'))
    removed = body.get('removed') if isinstance(body.get('removed'), list) else []
    removed = [_guard(wikitext.cid, c) for c in removed]
    raw = body.get('blocks') if isinstance(body.get('blocks'), list) else []
    if len(raw) > wikitext.BLOCK_MAX:
        raise HTTPException(400, f'한 문서는 {wikitext.BLOCK_MAX}블록까지입니다.')
    items = []
    for b in raw:
        if not isinstance(b, dict):
            raise HTTPException(400, '블록이 올바르지 않습니다.')
        try:
            items.append(_block_input(b.get('cid'), b))
        except HTTPException as exc:
            # 어느 블록이 걸렸는지 화면이 표시할 수 있게 번호를 같이 준다
            raise HTTPException(exc.status_code, {'message': exc.detail, 'code': 'invalid', 'cid': b.get('cid')})
    conn = get_db()
    try:
        page = _page(conn, page_id, lock=True)
        if page['deleted']:
            raise HTTPException(409, '지워진 문서입니다. 되살린 뒤에 고칠 수 있습니다.')
        notes, conflicts = [], []
        for cid in removed:
            old = conn.execute('SELECT "id","kind","data" FROM wikiBlocks WHERE "pageId"=%s AND "cid"=%s',
                               (page_id, cid)).fetchone()
            if old:
                conn.execute('DELETE FROM wikiBlocks WHERE "id"=%s', (old['id'],))
                notes.append((cid, 'del', wikitext.shown(old['kind'], old['data'])))
        for cid, kind, data, base, moving, after in items:
            theirs, note = _apply(conn, page_id, nickname, cid, kind, data, base, moving, after)
            if theirs:
                conflicts.append(theirs)
            elif note:
                notes.append((cid, note[0], note[1]))
        if conflicts:
            conn.rollback()
            raise HTTPException(409, {'message': '다른 사람이 먼저 고친 문단이 있습니다.', 'code': 'conflicts', 'blocks': conflicts})
        if notes:
            _record_many(conn, page_id, nickname, notes)
            conn.commit()
        rows = conn.execute('SELECT "cid","kind","data","rev" FROM wikiBlocks WHERE "pageId"=%s AND "cid" = ANY(%s)',
                            (page_id, [i[0] for i in items])).fetchall() if items else []
        return {'blocks': [dict(r) for r in rows], 'images': _images(conn, rows), 'version': _version(conn, page_id)}
    finally:
        conn.close()


@router.delete('/pages/{page_id}/blocks/{cid}')
def delete_block(page_id: int, cid: str, nickname: str = ''):
    """블록을 지운다. 이미 없으면 그대로 성공이다. 지운 내용은 앞선 판에 남아 있다."""
    nickname = _nick(nickname)
    cid = _guard(wikitext.cid, cid)
    conn = get_db()
    try:
        page = _page(conn, page_id, lock=True)
        if page['deleted']:
            raise HTTPException(409, '지워진 문서입니다. 되살린 뒤에 고칠 수 있습니다.')
        old = conn.execute('SELECT "id","kind","data" FROM wikiBlocks WHERE "pageId"=%s AND "cid"=%s',
                           (page_id, cid)).fetchone()
        if old:
            conn.execute('DELETE FROM wikiBlocks WHERE "id"=%s', (old['id'],))
            _record(conn, page_id, nickname, cid, 'del', wikitext.shown(old['kind'], old['data']))
            conn.commit()
        return {'ok': True, 'version': _version(conn, page_id)}
    finally:
        conn.close()


# ---------- 이력 ----------
@router.get('/pages/{page_id}/history')
def list_history(page_id: int):
    conn = get_db()
    try:
        _page(conn, page_id)
        rows = conn.execute('SELECT "id","nickname","notes","createdAt","updatedAt" FROM wikiRevisions '
                            'WHERE "pageId"=%s ORDER BY "id" DESC LIMIT %s', (page_id, HISTORY)).fetchall()
        return [{'id': r['id'], 'nickname': r['nickname'], 'at': r['updatedAt'], 'lines': r['notes'] or []}
                for r in rows]
    finally:
        conn.close()


def _revision(conn, page_id, revision_id):
    row = conn.execute('SELECT "id","nickname","snapshot","updatedAt" FROM wikiRevisions WHERE "id"=%s AND "pageId"=%s',
                       (revision_id, page_id)).fetchone()
    if not row:
        raise HTTPException(404, '그 판을 찾을 수 없습니다.')
    return row


@router.get('/pages/{page_id}/history/{revision_id}')
def get_revision(page_id: int, revision_id: int):
    """그 판이 끝났을 때의 문서. 화면이 미리 보여 주고 되돌릴지 묻는다."""
    conn = get_db()
    try:
        row = _revision(conn, page_id, revision_id)
        blocks = [{**b, 'rev': 0} for b in row['snapshot'].get('blocks', [])]
        return {'id': row['id'], 'nickname': row['nickname'], 'at': row['updatedAt'],
                'blocks': blocks, 'images': _images(conn, blocks)}
    finally:
        conn.close()


@router.post('/pages/{page_id}/revert')
def revert_page(page_id: int, body: dict):
    """본문을 그 판으로 되돌린다. 되돌린 것도 새 판으로 남으므로 되돌리기를 다시 되돌릴 수 있다.
    제목·다른 이름은 건드리지 않는다 — 그새 다른 문서가 그 이름을 쓰고 있을 수 있다."""
    nickname = _nick(body.get('nickname'))
    conn = get_db()
    try:
        page = _page(conn, page_id, lock=True)
        if page['deleted']:
            raise HTTPException(409, '지워진 문서입니다. 되살린 뒤에 고칠 수 있습니다.')
        try:
            row = _revision(conn, page_id, int(body.get('revisionId')))
        except (TypeError, ValueError):
            raise HTTPException(400, 'revisionId가 올바르지 않습니다.')
        clean = []
        for b in row['snapshot'].get('blocks', []):
            try:      # 옛 판의 블록이 지금 규칙에 안 맞으면 그 블록만 건너뛴다
                data = wikitext.block(b.get('kind'), b.get('data'))
                clean.append((wikitext.cid(b.get('cid')), b['kind'], data))
            except wikitext.Bad:
                continue
        # 번호는 지금까지의 어느 번호보다 크게 준다. 이 문서를 열어 둔 다른 화면의 저장이 옛 번호로 들어와 덮지 못한다.
        top = conn.execute('SELECT coalesce(max("rev"),0) m FROM wikiBlocks WHERE "pageId"=%s', (page_id,)).fetchone()['m']
        conn.execute('DELETE FROM wikiBlocks WHERE "pageId"=%s', (page_id,))
        for i, (cid, kind, data) in enumerate(clean):
            text = wikitext.plain(kind, data)
            conn.execute('INSERT INTO wikiBlocks ("pageId","cid","pos","kind","data","text","textKey","rev","updatedBy") '
                         'VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)',
                         (page_id, cid, float(i + 1), kind, Json(data), text, wikitext.key(text), top + 1, nickname))
        _record(conn, page_id, nickname, '@revert', 'revert', row['nickname'], fresh=True)
        conn.commit()
        return _doc(conn, _page(conn, page_id))
    finally:
        conn.close()


# ---------- 역링크 · 찾기 ----------
@router.get('/pages/{page_id}/backlinks')
def list_backlinks(page_id: int):
    """이 문서를 가리키는 문서. 본문이 제목이나 다른 이름을 '한 낱말로' 부르는 문서다(wikitext.mentions).
    열쇠가 들어 있는 블록만 DB 에서 추린 뒤 낱말 경계를 본다."""
    conn = get_db()
    try:
        page = _page(conn, page_id)
        keys = [page['key']] + [r['key'] for r in conn.execute(
            'SELECT "key" FROM wikiAliases WHERE "pageId"=%s', (page_id,)).fetchall()]
        keys = [k for k in keys if len(k) >= wikitext.AUTO_MIN]
        if not keys:
            return []
        rows = conn.execute(
            'SELECT b."text", p."id", p."title" FROM wikiBlocks b JOIN wikiPages p ON p."id"=b."pageId" '
            'WHERE NOT p."deleted" AND p."id"<>%s AND b."textKey" LIKE ANY(%s) LIMIT 400',
            (page_id, ['%' + like_escape(k) + '%' for k in keys])).fetchall()
        found = {}
        for r in rows:
            if r['id'] not in found and any(wikitext.mentions(r['text'], k) for k in keys):
                found[r['id']] = r['title']
        return [{'id': i, 'title': t} for i, t in sorted(found.items(), key=lambda x: x[1])]
    finally:
        conn.close()


@router.get('/search')
def search(q: str = ''):
    """본문 찾기. 띄어쓰기·기호를 무시하고 찾는다. 제목 찾기는 화면이 제목 목록으로 한다."""
    key = wikitext.key(wikitext.line(q, wikitext.TITLE_MAX))
    if len(key) < 2:
        return []
    conn = get_db()
    try:
        rows = conn.execute(
            'SELECT b."text", p."id", p."title" FROM wikiBlocks b JOIN wikiPages p ON p."id"=b."pageId" '
            'WHERE NOT p."deleted" AND b."textKey" LIKE %s ORDER BY p."title", b."pos" LIMIT 200',
            ('%' + like_escape(key) + '%',)).fetchall()
    finally:
        conn.close()
    out, seen = [], set()
    for r in rows:
        if r['id'] in seen:
            continue
        seen.add(r['id'])
        text = ' '.join(r['text'].split())
        at = text.lower().find(wikitext.line(q, wikitext.TITLE_MAX).lower())
        start = max(0, at - 30) if at >= 0 else 0
        out.append({'id': r['id'], 'title': r['title'],
                    'snippet': ('…' if start else '') + text[start:start + 120] + ('…' if len(text) > start + 120 else '')})
        if len(out) >= SEARCH:
            break
    return out


# ---------- 토론 ----------
@router.get('/pages/{page_id}/talks')
def list_talks(page_id: int):
    conn = get_db()
    try:
        _page(conn, page_id)
        rows = conn.execute('SELECT "id","nickname","body","createdAt" FROM wikiTalks WHERE "pageId"=%s ORDER BY "id"',
                            (page_id,)).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


@router.post('/pages/{page_id}/talks')
def add_talk(page_id: int, body: dict):
    nickname = _nick(body.get('nickname'))
    text = wikitext.line(body.get('body'), TALK_MAX)
    if not text:
        raise HTTPException(400, '내용을 입력하세요.')
    conn = get_db()
    try:
        _page(conn, page_id)
        row = conn.execute('INSERT INTO wikiTalks ("pageId","nickname","body") VALUES (%s,%s,%s) '
                           'RETURNING "id","nickname","body","createdAt"', (page_id, nickname, text)).fetchone()
        conn.commit()
        return dict(row)
    finally:
        conn.close()


@router.delete('/pages/{page_id}/talks/{talk_id}')
def delete_talk(page_id: int, talk_id: int, nickname: str = ''):
    """본인 것만 지운다. 닉네임이 곧 신원이라 그 이상은 막을 수 없다(곡 한마디와 같다)."""
    who = _nick(nickname)
    conn = get_db()
    try:
        row = conn.execute('SELECT "nickname" FROM wikiTalks WHERE "id"=%s AND "pageId"=%s', (talk_id, page_id)).fetchone()
        if row:
            if row['nickname'] != who:
                raise HTTPException(403, '본인이 쓴 글만 지울 수 있습니다.')
            conn.execute('DELETE FROM wikiTalks WHERE "id"=%s', (talk_id,))
            conn.commit()
        return {'ok': True}
    finally:
        conn.close()


# ---------- 그림 ----------
@router.post('/images')
async def upload_image(file: UploadFile = File(...), nickname: str = ''):
    """그림 한 장. images.py 의 규칙(자르지 않고 긴 변 512px WebP)으로 줄여 둔다.
    위키 그림 전체가 IMAGE_BUDGET 을 넘으면 받지 않는다 — 끝없이 늘 수 있는 것은 이것뿐이다."""
    who = _nick(nickname)
    raw = await file.read()
    if not raw:
        raise HTTPException(400, '빈 파일입니다.')
    if len(raw) > MAX_UPLOAD:
        raise HTTPException(413, '그림이 너무 큽니다.')
    data = fit_webp(raw)
    width, height = Image.open(io.BytesIO(data)).size
    conn = get_db()
    try:
        used = conn.execute('SELECT coalesce(sum(octet_length("image")),0) s FROM wikiImages').fetchone()['s']
        if used + len(data) > IMAGE_BUDGET:
            raise HTTPException(507, '위키 그림 저장 공간이 찼습니다.')
        row = conn.execute('INSERT INTO wikiImages ("image","width","height","nickname") VALUES (%s,%s,%s,%s) '
                           'RETURNING "id"', (data, width, height, who)).fetchone()
        conn.commit()
    finally:
        conn.close()
    return {'id': row['id'], 'url': _image_url(row['id']), 'w': width, 'h': height}


@router.get('/images/{image_id}')
def get_image(image_id: int, request: Request):
    """주소·캐시 규칙은 imageserve.py. 올린 그림은 바뀌지 않으므로 버전이 고정이다."""
    def version_of(conn):
        row = conn.execute('SELECT 1 AS x FROM wikiImages WHERE "id"=%s', (image_id,)).fetchone()
        return f'1.{imageserve.IMAGE_REV}' if row else None

    def load(conn):
        row = conn.execute('SELECT "image" FROM wikiImages WHERE "id"=%s', (image_id,)).fetchone()
        return row and row['image']

    return imageserve.serve(request, 'wiki', image_id, version_of, load, 'image/webp', '그림을 찾을 수 없습니다.')
