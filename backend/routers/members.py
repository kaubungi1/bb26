"""멤버 프로필. 닉네임이 열쇠이고, 본인이 자기 캐릭터를 꾸민다. 권한 확인은 없다."""
import hashlib
import io

from fastapi import APIRouter, File, HTTPException, Request, Response, UploadFile
from PIL import Image, ImageOps

from db import get_db

router = APIRouter()

EDITABLE = ('mainRoles', 'availability', 'intro', 'color', 'avatar', 'title', 'status')
TEXT_MAX = {'mainRoles': 60, 'availability': 80, 'intro': 200, 'color': 20, 'avatar': 8, 'title': 30, 'status': 60}
NICK_MAX = 20
IMAGE_SIDE = 256               # 무대에 서는 캐릭터. 이보다 크게 볼 일이 없다
IMAGE_MAX_UPLOAD = 8 * 1024 * 1024
IMAGE_MAX_STORED = 200 * 1024
COLS = '"nickname", "mainRoles", "availability", "intro", "color", "avatar", "title", "status", ' \
       '"createdAt", "updatedAt", ("image" IS NOT NULL) AS "hasImage"'


def _clean(key, value):
    if value is None:
        return None
    return str(value).strip()[:TEXT_MAX[key]] or None


def _row(conn, nickname):
    row = conn.execute(f'SELECT {COLS} FROM members WHERE "nickname"=%s', (nickname,)).fetchone()
    return dict(row) if row else None


@router.get('')
def list_members():
    conn = get_db()
    rows = [dict(r) for r in conn.execute(f'SELECT {COLS} FROM members ORDER BY "nickname"').fetchall()]
    # 길드 소속도 같이 내려준다 — 카드에 소속 배지를 달기 위해
    by_nick = {}
    for m in conn.execute(
        'SELECT gm."nickname", gm."role", g."slug", g."name", g."color" FROM guildMembers gm '
        'JOIN guilds g ON g."id"=gm."guildId" ORDER BY gm."id"'
    ).fetchall():
        by_nick.setdefault(m['nickname'], []).append(dict(m))
    for r in rows:
        r['guilds'] = by_nick.get(r['nickname'], [])
    conn.close()
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


@router.delete('/{nickname}')
def delete_member(nickname: str):
    conn = get_db()
    cur = conn.execute('DELETE FROM members WHERE "nickname"=%s', (nickname,))
    conn.commit()
    conn.close()
    if cur.rowcount == 0:
        raise HTTPException(404, '멤버를 찾을 수 없습니다.')
    return {'ok': True}


# ---------- 캐릭터 이미지 ----------
def _to_square_webp(data):
    """전체 구도를 유지해 투명한 256px 캔버스에 맞춘다."""
    try:
        im = Image.open(io.BytesIO(data))
        im = ImageOps.exif_transpose(im)
        im = im.convert('RGBA') if im.mode in ('RGBA', 'LA', 'P') else im.convert('RGB')
    except Exception:
        raise HTTPException(400, '이미지 파일이 아닙니다.')
    im = ImageOps.contain(im, (IMAGE_SIDE, IMAGE_SIDE), method=Image.LANCZOS)
    canvas = Image.new('RGBA', (IMAGE_SIDE, IMAGE_SIDE), (0, 0, 0, 0))
    canvas.paste(im, ((IMAGE_SIDE - im.width) // 2, (IMAGE_SIDE - im.height) // 2))
    im = canvas
    for q in (85, 70, 55, 40):
        buf = io.BytesIO()
        im.save(buf, 'WEBP', quality=q, method=4)
        if buf.tell() <= IMAGE_MAX_STORED:
            return buf.getvalue()
    return buf.getvalue()


@router.post('/{nickname}/image')
async def upload_image(nickname: str, file: UploadFile = File(...)):
    nickname = nickname.strip()
    if not nickname or len(nickname) > NICK_MAX:
        raise HTTPException(400, f'닉네임은 1~{NICK_MAX}자입니다.')
    data = await file.read(IMAGE_MAX_UPLOAD + 1)
    if not data:
        raise HTTPException(400, '파일이 비어 있습니다.')
    if len(data) > IMAGE_MAX_UPLOAD:
        raise HTTPException(400, '8MB 아래로 올려주세요.')
    webp = _to_square_webp(data)
    conn = get_db()
    conn.execute(
        'INSERT INTO members ("nickname", "image", "imageUpdatedAt") VALUES (%s,%s,now()) '
        'ON CONFLICT ("nickname") DO UPDATE SET "image"=EXCLUDED."image", "imageUpdatedAt"=now(), "updatedAt"=now()',
        (nickname, webp),
    )
    conn.commit()
    row = _row(conn, nickname)
    conn.close()
    return row


@router.get('/{nickname}/image')
def get_image(nickname: str, request: Request):
    conn = get_db()
    row = conn.execute('SELECT "image" FROM members WHERE "nickname"=%s', (nickname,)).fetchone()
    conn.close()
    if not row or not row['image']:
        raise HTTPException(404, '이미지가 없습니다.')
    data = bytes(row['image'])
    etag = '"' + hashlib.sha1(data).hexdigest()[:20] + '"'
    cache = 'private, max-age=3600'
    if request.headers.get('if-none-match') == etag:
        return Response(status_code=304, headers={'ETag': etag, 'Cache-Control': cache})
    return Response(content=data, media_type='image/webp',
                    headers={'ETag': etag, 'Cache-Control': cache, 'Content-Length': str(len(data))})


@router.delete('/{nickname}/image')
def delete_image(nickname: str):
    conn = get_db()
    cur = conn.execute(
        'UPDATE members SET "image"=NULL, "imageUpdatedAt"=NULL, "updatedAt"=now() WHERE "nickname"=%s AND "image" IS NOT NULL',
        (nickname,),
    )
    conn.commit()
    conn.close()
    if cur.rowcount == 0:
        raise HTTPException(404, '이미지가 없습니다.')
    return {'ok': True}
