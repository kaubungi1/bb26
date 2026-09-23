"""멤버 프로필. 닉네임이 열쇠이고, 본인이 자기 캐릭터를 꾸민다. 권한 확인은 없다."""
import io

from fastapi import APIRouter, File, HTTPException, Request, UploadFile
from PIL import Image, ImageOps

from psycopg.types.json import Json

from db import get_db
import admin
import imageserve
import listcache
from images import MAX_UPLOAD, square_webp

router = APIRouter()

EDITABLE = ('mainRoles', 'availability', 'intro', 'color', 'avatar', 'title', 'status', 'lines')
TEXT_MAX = {'mainRoles': 60, 'availability': 80, 'intro': 200, 'color': 20, 'avatar': 8, 'title': 30, 'status': 60}
NICK_MAX = 20
# 사진을 줄이는 규칙은 images.py 한 곳에 있다. 길드 문장도 같은 규칙을 쓴다.
COLS = '"nickname", "mainRoles", "availability", "intro", "color", "avatar", "title", "status", ' \
       '"lines", "badge", "createdAt", "updatedAt", ("image" IS NOT NULL) AS "hasImage", "imageUpdatedAt"'


LINES_MAX = 3          # 대사 줄 수
LINE_MAX = 40          # 한 줄 길이


def _clean_lines(value):
    """대사 세 줄. 빈 줄은 버리고, 길면 자른다. 하나도 안 남으면 None.
       화면에 말풍선으로 그대로 나가는 값이라 개수와 길이를 여기서 못박는다."""
    if not isinstance(value, list):
        return None
    out = []
    for v in value[:LINES_MAX]:
        if not isinstance(v, str):
            continue
        t = v.strip()[:LINE_MAX]
        if t:
            out.append(t)
    return Json(out) if out else None


def _clean(key, value):
    if key == 'lines':
        return _clean_lines(value)
    if value is None:
        return None
    return str(value).strip()[:TEXT_MAX[key]] or None


def _not_reserved(nickname):
    """관리자 이름은 멤버가 되지 않는다. 멤버 목록에 카드가 생기지 않게 한다(admin.py)."""
    if nickname == admin.ADMIN_NICK:
        raise HTTPException(400, '쓸 수 없는 닉네임입니다.')


def _row(conn, nickname):
    row = conn.execute(f'SELECT {COLS} FROM members WHERE "nickname"=%s', (nickname,)).fetchone()
    return imageserve.with_member_image(dict(row)) if row else None


@router.get('/roster')
def roster():
    """등록된 닉네임 목록. 이름을 처음 넣을 때 오타인지 확인하는 데 쓴다.
       인증이 아니다. 한 사람이 이름을 여럿 만들어 기록이 갈라지는 것을 막는 장치다."""
    conn = get_db()
    try:
        rows = conn.execute('SELECT "nickname" FROM members ORDER BY "nickname"').fetchall()
        return [r['nickname'] for r in rows]
    finally:
        conn.close()


@router.post('/register')
def register(body: dict):
    """새 이름을 명단에 넣는다. 막지는 않되 한 번 되묻고 들어온다."""
    nickname = (body.get('nickname') or '').strip()[:NICK_MAX]
    if not nickname:
        raise HTTPException(400, '닉네임을 입력하세요.')
    _not_reserved(nickname)
    conn = get_db()
    try:
        conn.execute('INSERT INTO members ("nickname") VALUES (%s) ON CONFLICT DO NOTHING', (nickname,))
        conn.commit()
        return {'nickname': nickname}
    finally:
        conn.close()


@router.get('')
def list_members(request: Request):
    """15초마다 폴링된다. 바뀐 게 없으면 DB 를 다시 읽지 않는다(listcache.py)."""
    return listcache.serve(request, 'members', listcache.MEMBERS, _build_members)


def _build_members(conn):
    rows = [imageserve.with_member_image(dict(r))
            for r in conn.execute(f'SELECT {COLS} FROM members ORDER BY "nickname"').fetchall()]
    # 길드 소속도 같이 내려준다 — 카드에 소속 배지를 달기 위해
    by_nick = {}
    for m in conn.execute(
        'SELECT gm."nickname", gm."role", g."slug", g."name", g."color" FROM guildMembers gm '
        'JOIN guilds g ON g."id"=gm."guildId" ORDER BY gm."id"'
    ).fetchall():
        by_nick.setdefault(m['nickname'], []).append(dict(m))
    for r in rows:
        r['guilds'] = by_nick.get(r['nickname'], [])

    # 본인이 쓴 프로필이 비어 있어도 카드에 보여 줄 것은 있다.
    # 누가 어느 파트로 몇 곡에 들어갔는지는 지원 기록이 이미 알고 있다.
    played = {}
    for r in conn.execute(
        'SELECT sp."nickname" nick, s."role" role, count(*) n '
        'FROM sessionSupports sp JOIN sessions s ON s."id"=sp."sessionId" '
        'GROUP BY sp."nickname", s."role" ORDER BY count(*) DESC'
    ).fetchall():
        played.setdefault(r['nick'], []).append(r['role'])

    counts, recent = {}, {}
    seen = {}
    # sessionSupports.id 가 곧 지원한 순서다. 뒤에서부터 훑어 최근 곡을 뽑는다.
    for r in conn.execute(
        'SELECT sp."nickname" nick, so."id" sid, so."title" title '
        'FROM sessionSupports sp '
        'JOIN sessions s ON s."id"=sp."sessionId" '
        'JOIN songs so ON so."id"=s."songId" '
        'ORDER BY sp."id" DESC'
    ).fetchall():
        nick = r['nick']
        bag = seen.setdefault(nick, set())
        counts[nick] = counts.get(nick, 0) + 1
        if r['sid'] in bag:
            continue
        bag.add(r['sid'])
        if len(recent.setdefault(nick, [])) < 3:
            recent[nick].append({'id': r['sid'], 'title': r['title']})

    for r in rows:
        nick = r['nickname']
        r['playedRoles'] = played.get(nick, [])
        r['supportCount'] = counts.get(nick, 0)
        r['songCount'] = len(seen.get(nick, ()))
        r['recentSongs'] = recent.get(nick, [])
    return rows


@router.get('/{nickname}')
def get_member(nickname: str):
    conn = get_db()
    row = _row(conn, nickname)
    conn.close()
    if not row:
        raise HTTPException(404, '멤버를 찾을 수 없습니다.')
    return row


@router.put('/{nickname}')
def upsert_member(nickname: str, body: dict):
    nickname = nickname.strip()
    if not nickname or len(nickname) > NICK_MAX:
        raise HTTPException(400, f'닉네임은 1~{NICK_MAX}자입니다.')
    _not_reserved(nickname)
    cols = ['"nickname"']
    vals = [nickname]
    sets = []
    for key in EDITABLE:
        if key in body:
            cols.append(f'"{key}"')
            vals.append(_clean(key, body[key]))
            sets.append(f'"{key}"=EXCLUDED."{key}"')
    sets.append('"updatedAt"=now()')
    ph = ','.join('%s' for _ in vals)
    conn = get_db()
    conn.execute(
        f'INSERT INTO members ({", ".join(cols)}) VALUES ({ph}) '
        f'ON CONFLICT ("nickname") DO UPDATE SET {", ".join(sets)}',
        vals,
    )
    conn.commit()
    row = _row(conn, nickname)
    conn.close()
    return row


# 멤버 삭제는 관리 탭에만 있다(routers/admin.py). 참여 기록까지 같이 지운다.


# ---------- 캐릭터 이미지 ----------
@router.post('/{nickname}/image')
async def upload_image(nickname: str, file: UploadFile = File(...)):
    nickname = nickname.strip()
    if not nickname or len(nickname) > NICK_MAX:
        raise HTTPException(400, f'닉네임은 1~{NICK_MAX}자입니다.')
    _not_reserved(nickname)
    data = await file.read(MAX_UPLOAD + 1)
    if not data:
        raise HTTPException(400, '파일이 비어 있습니다.')
    if len(data) > MAX_UPLOAD:
        raise HTTPException(400, '8MB 아래로 올려주세요.')
    webp = square_webp(data)
    conn = get_db()
    conn.execute(
        'INSERT INTO members ("nickname", "image", "imageUpdatedAt") VALUES (%s,%s,now()) '
        'ON CONFLICT ("nickname") DO UPDATE SET "image"=EXCLUDED."image", "imageUpdatedAt"=now(), "updatedAt"=now()',
        (nickname, webp),
    )
    conn.commit()
    imageserve.forget('member', nickname)
    row = _row(conn, nickname)
    conn.close()
    return row


@router.get('/{nickname}/image')
def get_image(nickname: str, request: Request):
    """주소·캐시 규칙은 imageserve.py. 버전은 imageUpdatedAt 이다."""
    def version_of(conn):
        row = conn.execute('SELECT ("image" IS NOT NULL) has, "imageUpdatedAt" ts FROM members '
                           'WHERE "nickname"=%s', (nickname,)).fetchone()
        return imageserve.stamp_or_legacy(row and row['has'], row and row['ts'])

    def load(conn):
        row = conn.execute('SELECT "image" FROM members WHERE "nickname"=%s', (nickname,)).fetchone()
        return row and row['image']

    return imageserve.serve(request, 'member', nickname, version_of, load, 'image/webp',
                            '이미지가 없습니다.', private=True)


@router.delete('/{nickname}/image')
def delete_image(nickname: str):
    conn = get_db()
    cur = conn.execute(
        'UPDATE members SET "image"=NULL, "imageUpdatedAt"=NULL, "updatedAt"=now() WHERE "nickname"=%s AND "image" IS NOT NULL',
        (nickname,),
    )
    conn.commit()
    imageserve.forget('member', nickname)
    conn.close()
    if cur.rowcount == 0:
        raise HTTPException(404, '이미지가 없습니다.')
    return {'ok': True}
