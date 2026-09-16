"""길드. 이름·색·엠블럼·슬로건은 팀장이 정하고, 명단은 누구나 고친다."""
import hashlib
import re

from fastapi import APIRouter, File, HTTPException, Request, Response, UploadFile
from psycopg.types.json import Json

from db import get_db
from images import MAX_UPLOAD, square_webp
from guildtheme import THEMES, cache_clear

router = APIRouter()

SLUG_RE = re.compile(r'^[a-z0-9][a-z0-9-]{1,30}$')
EDITABLE = ('name', 'leader', 'slogan', 'recruitNote', 'color', 'emblem', 'style')
TEXT_MAX = {'name': 30, 'leader': 20, 'slogan': 60, 'recruitNote': 200, 'color': 20, 'emblem': 8}

# ---------- 꾸미기 값 검증 ----------
# 이 값들은 화면에서 CSS 변수와 SVG 로 그대로 들어간다. 자유 문자열을 통과시키면
# "red; } body{display:none} /*" 같은 값이 사이트를 부순다. 목록에 있는 것만 받는다.
# 테마 목록은 guildtheme.py 에 있다(main.py 도 같은 값을 본다). 문양은 여기서 관리한다.
# 문양은 Tabler Icons(MIT) 세트에서 왔고, 이름은 그 세트의 것이 아니라 우리 키다.
# frontend/common/crest.js 와 한쪽만 고치면 화면에서는 고를 수 있는데 서버가 버린다.
CREST_SHAPES = {
    'pick', 'keys', 'keyboard', 'mic', 'mega', 'amp', 'headphone', 'speaker',
    'note', 'wave', 'takeoff', 'plane', 'propeller', 'rocket', 'cloud', 'snow',
    'rain', 'snowman', 'bolt', 'moon', 'sun', 'daepa', 'ramen', 'coffee',
    'donut', 'leaf', 'plant', 'car', 'bus', 'bike', 'star', 'heart',
    'crown', 'cat', 'ghost', 'bone',
}
HEX_RE = re.compile(r'^#[0-9a-fA-F]{6}$')


def _clean_style(value):
    """받아들이는 키만 남기고 나머지는 버린다. 모르는 키는 저장하지 않는다."""
    if not isinstance(value, dict):
        return None
    out = {}
    theme = value.get('theme')
    if theme in THEMES:
        out['theme'] = theme
    # 판 위 글자색. 길드가 직접 고른 값이고, 없으면 화면이 강조색에서 계산한다.
    ink = str(value.get('ink') or '')
    if HEX_RE.match(ink):
        out['ink'] = ink
    crest = value.get('crest')
    if isinstance(crest, dict) and crest.get('shape') in CREST_SHAPES:
        bg, fg = str(crest.get('bg') or ''), str(crest.get('fg') or '')
        out['crest'] = {
            'shape': crest['shape'],
            'bg': bg if HEX_RE.match(bg) else '#00b8ad',
            'fg': fg if HEX_RE.match(fg) else '#ffffff',
        }
    return out or None


def _clean(key, value):
    if key == 'style':
        return Json(_clean_style(value))
    if value is None:
        return None
    return str(value).strip()[:TEXT_MAX[key]] or None


def _members_for(conn, guilds):
    for g in guilds:
        g['members'] = []
    ids = [g['id'] for g in guilds]
    if not ids:
        return
    ph = ','.join('%s' for _ in ids)
    by_guild = {}
    for m in conn.execute(
        f'SELECT * FROM guildMembers WHERE "guildId" IN ({ph}) ORDER BY "id"', ids
    ).fetchall():
        by_guild.setdefault(m['guildId'], []).append(dict(m))
    for g in guilds:
        g['members'] = by_guild.get(g['id'], [])


# 문장 사진은 최대 200KB 라 목록에 실으면 열세 길드에 2.6MB 가 된다. 있는지만 알린다.
# 화면은 /api/guilds/{slug}/image 주소로 따로 받는다 — 멤버 사진과 같은 방식이다.
COLS = ('"id","slug","name","leader","slogan","recruitNote","color","emblem",'
        '"createdBy","createdAt","updatedAt","style",("image" IS NOT NULL) AS "hasImage"')


def _get(conn, slug):
    row = conn.execute(f'SELECT {COLS} FROM guilds WHERE "slug"=%s', (slug,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(404, '길드를 찾을 수 없습니다.')
    g = dict(row)
    _members_for(conn, [g])
    return g


@router.get('')
def list_guilds():
    conn = get_db()
    guilds = [dict(r) for r in conn.execute(f'SELECT {COLS} FROM guilds ORDER BY "createdAt"').fetchall()]
    _members_for(conn, guilds)
    conn.close()
    return guilds


@router.post('')
def create_guild(body: dict):
    slug = (body.get('slug') or '').strip().lower()
    name = _clean('name', body.get('name'))
    if not name:
        raise HTTPException(400, 'name은 필수입니다.')
    if not SLUG_RE.match(slug):
        raise HTTPException(400, 'slug는 영문 소문자·숫자·하이픈 2~31자입니다.')
    conn = get_db()
    if conn.execute('SELECT 1 FROM guilds WHERE "slug"=%s', (slug,)).fetchone():
        conn.close()
        raise HTTPException(409, '이미 쓰는 주소입니다.')
    conn.execute(
        'INSERT INTO guilds ("slug","name","leader","slogan","recruitNote","color","emblem","createdBy") '
        'VALUES (%s,%s,%s,%s,%s,%s,%s,%s)',
        (slug, name, _clean('leader', body.get('leader')), _clean('slogan', body.get('slogan')),
         _clean('recruitNote', body.get('recruitNote')), _clean('color', body.get('color')),
         _clean('emblem', body.get('emblem')), body.get('createdBy')),
    )
    conn.commit()
    g = _get(conn, slug)
    conn.close()
    return g


@router.get('/{slug}')
def get_guild(slug: str):
    conn = get_db()
    g = _get(conn, slug)
    conn.close()
    return g


@router.put('/{slug}')
def update_guild(slug: str, body: dict):
    fields = []
    values = []
    for key in EDITABLE:
        if key in body:
            fields.append(f'"{key}"=%s')
            values.append(_clean(key, body[key]))
    if not fields:
        raise HTTPException(400, '수정할 내용이 없습니다.')
    conn = get_db()
    # 꾸미기는 길드원만 바꾼다. 로그인이 없어 닉네임은 자기 신고이므로 이 확인은
    # 보안이 아니라 실수 방지다 — 남의 길드를 지나가다 갈아엎는 일을 막는 정도다.
    # 사이트 전체가 같은 성격이다(닉네임 모달의 오타 확인도 마찬가지).
    if 'style' in body:
        who = str(body.get('nickname') or '').strip()
        row = conn.execute(
            'SELECT 1 FROM guildMembers m JOIN guilds g ON g."id"=m."guildId" '
            'WHERE g."slug"=%s AND m."nickname"=%s LIMIT 1', (slug, who)).fetchone()
        if not row:
            conn.close()
            raise HTTPException(403, '길드원만 꾸미기를 바꿀 수 있습니다.')
    fields.append('"updatedAt"=now()')
    values.append(slug)
    cur = conn.execute(f'UPDATE guilds SET {", ".join(fields)} WHERE "slug"=%s', values)
    conn.commit()
    if cur.rowcount == 0:
        conn.close()
        raise HTTPException(404, '길드를 찾을 수 없습니다.')
    # 서버가 HTML 에 박아 보내는 테마가 메모리에 남아 있다. 안 비우면 바꾼 뒤에도
    # 옛 테마로 한 번 그려졌다가 바뀐다 — 없애려던 번쩍임이 반대로 생긴다.
    if 'style' in body:
        cache_clear()
    g = _get(conn, slug)
    conn.close()
    return g


@router.delete('/{slug}')
def delete_guild(slug: str):
    """길드를 지워도 곡과 일정은 남고 소속만 풀린다 (ON DELETE SET NULL)."""
    conn = get_db()
    cur = conn.execute('DELETE FROM guilds WHERE "slug"=%s', (slug,))
    conn.commit()
    conn.close()
    if cur.rowcount == 0:
        raise HTTPException(404, '길드를 찾을 수 없습니다.')
    return {'ok': True}


@router.post('/{slug}/members')
def add_member(slug: str, body: dict):
    nickname = (body.get('nickname') or '').strip()[:20]
    role = (body.get('role') or '').strip()[:20]
    if not nickname or not role:
        raise HTTPException(400, 'nickname과 role은 필수입니다.')
    conn = get_db()
    g = _get(conn, slug)
    conn.execute(
        'INSERT INTO guildMembers ("guildId","nickname","role") VALUES (%s,%s,%s) ON CONFLICT DO NOTHING',
        (g['id'], nickname, role),
    )
    conn.commit()
    g = _get(conn, slug)
    conn.close()
    return g


@router.delete('/{slug}/members/{member_id}')
def remove_member(slug: str, member_id: int):
    conn = get_db()
    g = _get(conn, slug)
    cur = conn.execute('DELETE FROM guildMembers WHERE "id"=%s AND "guildId"=%s', (member_id, g['id']))
    conn.commit()
    if cur.rowcount == 0:
        conn.close()
        raise HTTPException(404, '명단에 없는 사람입니다.')
    g = _get(conn, slug)
    conn.close()
    return g


# ---------- 길드 문장 사진 ----------
# 문양 서른여섯 개 안에서만 고르게 두면 길드마다 같은 그림이 겹친다.
# 사진을 올리면 그게 문양을 이긴다 — 프로필의 사진 > 이모지 > 첫 글자와 같은 규칙이다.
# 줄이는 규칙은 images.py 한 곳에 있고 멤버 프로필 사진과 똑같다.
@router.post('/{slug}/image')
async def upload_crest(slug: str, nickname: str = '', file: UploadFile = File(...)):
    data = await file.read(MAX_UPLOAD + 1)
    if not data:
        raise HTTPException(400, '파일이 비어 있습니다.')
    if len(data) > MAX_UPLOAD:
        raise HTTPException(400, '8MB 아래로 올려주세요.')
    webp = square_webp(data)
    conn = get_db()
    try:
        row = conn.execute('SELECT "id" FROM guilds WHERE "slug"=%s', (slug,)).fetchone()
        if not row:
            raise HTTPException(404, '길드를 찾을 수 없습니다.')
        _require_member(conn, row['id'], nickname)
        conn.execute('UPDATE guilds SET "image"=%s, "imageUpdatedAt"=now(), "updatedAt"=now() '
                     'WHERE "id"=%s', (webp, row['id']))
        conn.commit()
        return {'hasImage': True}
    finally:
        if not conn.closed:
            conn.close()


@router.get('/{slug}/image')
def crest_image(slug: str, request: Request):
    conn = get_db()
    row = conn.execute('SELECT "image" FROM guilds WHERE "slug"=%s', (slug,)).fetchone()
    conn.close()
    if not row or not row['image']:
        raise HTTPException(404, '문장 그림이 없습니다.')
    data = bytes(row['image'])
    etag = '"' + hashlib.sha1(data).hexdigest()[:20] + '"'
    cache = 'public, max-age=3600'
    if request.headers.get('if-none-match') == etag:
        return Response(status_code=304, headers={'ETag': etag, 'Cache-Control': cache})
    return Response(content=data, media_type='image/webp',
                    headers={'ETag': etag, 'Cache-Control': cache, 'Content-Length': str(len(data))})


@router.delete('/{slug}/image')
def delete_crest(slug: str, nickname: str = ''):
    conn = get_db()
    try:
        row = conn.execute('SELECT "id" FROM guilds WHERE "slug"=%s', (slug,)).fetchone()
        if not row:
            raise HTTPException(404, '길드를 찾을 수 없습니다.')
        _require_member(conn, row['id'], nickname)
        conn.execute('UPDATE guilds SET "image"=NULL, "imageUpdatedAt"=NULL, "updatedAt"=now() '
                     'WHERE "id"=%s', (row['id'],))
        conn.commit()
        return {'hasImage': False}
    finally:
        if not conn.closed:
            conn.close()


def _require_member(conn, gid, nickname):
    """꾸미기와 같은 확인이다. 로그인이 없어 자기 신고이므로 보안이 아니라 실수 방지다."""
    who = str(nickname or '').strip()
    if not who:
        raise HTTPException(400, '닉네임이 필요합니다.')
    row = conn.execute('SELECT 1 FROM guildMembers WHERE "guildId"=%s AND "nickname"=%s LIMIT 1',
                       (gid, who)).fetchone()
    if not row:
        raise HTTPException(403, '길드원만 문장을 바꿀 수 있습니다.')
