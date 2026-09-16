"""곡. 풀은 하나이고 길드는 꼬리표다. 끌올은 전체에서 한 곡만 30분 독점."""
from fastapi import APIRouter, BackgroundTasks, HTTPException, Request, Response

from db import get_db
import hashlib

import thumbs
from helpers import PART_ROLES, SONG_COLS, build_songs, guild_where, norm_tag, resolve_guild_id

router = APIRouter()

BUMP_MINUTES = 30
NOTE_MAX = 60

_BUMP_ACTIVE = f'"bumpedAt" > now() - interval \'{BUMP_MINUTES} minutes\''
_BUMP_COLS = (
    '"id" AS "songId", "title", "artist", "bumpedBy", "bumpedAt", "bumpNote", '
    f'"bumpedAt" + interval \'{BUMP_MINUTES} minutes\' AS "expiresAt"'
)


def _current_bump(conn):
    row = conn.execute(
        f'SELECT {_BUMP_COLS} FROM songs WHERE {_BUMP_ACTIVE} ORDER BY "bumpedAt" DESC LIMIT 1'
    ).fetchone()
    if not row:
        return None
    # 409 본문(dict)에도 실리므로 시각은 미리 문자열로 바꿔 둔다
    cur = dict(row)
    for key in ('bumpedAt', 'expiresAt'):
        if cur.get(key) is not None:
            cur[key] = cur[key].isoformat()
    return cur


@router.get('')
def list_songs(guild: str | None = None):
    conn = get_db()
    clause, params = guild_where(conn, guild)
    rows = conn.execute(f'{SONG_COLS}{clause} ORDER BY "createdAt" DESC', params).fetchall()
    result = build_songs(conn, rows)
    conn.close()
    return result


@router.get('/bump')
def get_bump():
    """지금 끌올된 곡. 없으면 null."""
    conn = get_db()
    cur = _current_bump(conn)
    conn.close()
    return cur


@router.post('')
def create_song(body: dict, background: BackgroundTasks):
    title = (body.get('title') or '').strip()
    artist = (body.get('artist') or '').strip()
    if not title or not artist:
        raise HTTPException(400, 'title과 artist는 필수입니다.')
    conn = get_db()
    guild_id = resolve_guild_id(conn, body)
    cur = conn.execute(
        'INSERT INTO songs (title, artist, category, "tags", "youtubeUrl", status, "isCandidate", note, "createdBy", "guildId") '
        'VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING "id"',
        (
            title, artist, body.get('category'), norm_tag(body.get('tags')), body.get('youtubeUrl'),
            body.get('status') or 'candidate', 1 if body.get('isCandidate') else 0,
            body.get('note'), body.get('createdBy'), guild_id,
        ),
    )
    song_id = cur.fetchone()['id']
    # 파트 여섯은 곡을 만들 때 다 깔아 둔다. 고르지 않은 자리는 꺼진 채로 남는다.
    # 나중에 켜면 되므로 자리를 새로 만들 일이 없고, 곡마다 파트 구성이 어긋나지 않는다.
    # roles 를 안 보내면 여섯 다 켠다.
    wanted = body.get('roles')
    on = set(wanted) if isinstance(wanted, list) else set(PART_ROLES)
    for role in PART_ROLES:
        conn.execute(
            'INSERT INTO sessions ("songId", "role", "active") VALUES (%s,%s,%s)',
            (song_id, role, role in on),
        )
    thumbs.remember(conn, song_id, body.get('youtubeUrl'))
    conn.commit()
    # 응답을 먼저 보내고 섬네일은 뒤에서 받는다. 등록한 사람도, 처음 보는 사람도 안 기다린다.
    background.add_task(thumbs.warm, song_id)
    row = conn.execute(f'{SONG_COLS} WHERE "id"=%s', (song_id,)).fetchone()
    result = build_songs(conn, [row])[0]
    conn.close()
    return result


@router.get('/{song_id}')
def get_song(song_id: int):
    conn = get_db()
    row = conn.execute(f'{SONG_COLS} WHERE "id"=%s', (song_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(404, '곡을 찾을 수 없습니다.')
    result = build_songs(conn, [row])[0]
    conn.close()
    return result


@router.put('/{song_id}')
def update_song(song_id: int, body: dict, background: BackgroundTasks):
    conn = get_db()
    before = conn.execute('SELECT "thumbVideoId" v FROM songs WHERE "id"=%s', (song_id,)).fetchone()
    fields = []
    values = []
    for key in ('title', 'artist', 'category', 'tags', 'youtubeUrl', 'status', 'isCandidate', 'note'):
        if key in body:
            value = body[key]
            if key == 'isCandidate':
                value = 1 if value else 0
            elif key == 'tags':
                value = norm_tag(value)
            fields.append(f'"{key}"=%s')
            values.append(value)
    if 'guildId' in body or 'guildSlug' in body:
        fields.append('"guildId"=%s')
        values.append(resolve_guild_id(conn, body))
    if not fields:
        conn.close()
        raise HTTPException(400, '수정할 내용이 없습니다.')
    fields.append('"updatedAt"=now()')
    values.append(song_id)
    cur = conn.execute(f'UPDATE songs SET {", ".join(fields)} WHERE "id"=%s', values)
    changed_url = 'youtubeUrl' in body and before
    if changed_url:
        thumbs.remember(conn, song_id, body.get('youtubeUrl'), before['v'])
    conn.commit()
    if changed_url:
        background.add_task(thumbs.warm, song_id)
    if cur.rowcount == 0:
        conn.close()
        raise HTTPException(404, '곡을 찾을 수 없습니다.')
    row = conn.execute(f'{SONG_COLS} WHERE "id"=%s', (song_id,)).fetchone()
    result = build_songs(conn, [row])[0]
    conn.close()
    return result


@router.delete('/{song_id}')
def delete_song(song_id: int):
    conn = get_db()
    cur = conn.execute('DELETE FROM songs WHERE "id"=%s', (song_id,))
    conn.commit()
    conn.close()
    if cur.rowcount == 0:
        raise HTTPException(404, '곡을 찾을 수 없습니다.')
    return {'ok': True}


@router.post('/{song_id}/bump')
def bump_song(song_id: int, body: dict):
    """끌올. 전체에서 살아 있는 끌올이 없을 때만 조건부 UPDATE 한 문장으로 잡는다.
    동시에 눌러도 DB 가 한 명만 통과시키므로 락이 필요 없다."""
    nickname = (body.get('nickname') or '').strip()
    if not nickname:
        raise HTTPException(400, 'nickname은 필수입니다.')
    note = (body.get('note') or '').strip()[:NOTE_MAX] or None
    conn = get_db()
    cur = conn.execute(
        f'UPDATE songs SET "bumpedBy"=%s, "bumpedAt"=now(), "bumpNote"=%s '
        f'WHERE "id"=%s AND NOT EXISTS (SELECT 1 FROM songs WHERE {_BUMP_ACTIVE})',
        (nickname, note, song_id),
    )
    conn.commit()
    if cur.rowcount == 0:
        holder = _current_bump(conn)
        exists = conn.execute('SELECT 1 FROM songs WHERE "id"=%s', (song_id,)).fetchone()
        conn.close()
        if not exists:
            raise HTTPException(404, '곡을 찾을 수 없습니다.')
        raise HTTPException(409, {'message': '아직 다른 곡이 끌올 중입니다.', 'current': holder})
    result = _current_bump(conn)
    conn.close()
    return result


@router.delete('/{song_id}/bump')
def release_bump(song_id: int, nickname: str):
    """끌올한 본인이 일찍 내린다."""
    conn = get_db()
    cur = conn.execute(
        'UPDATE songs SET "bumpedAt"=NULL, "bumpNote"=NULL WHERE "id"=%s AND "bumpedBy"=%s',
        (song_id, nickname.strip()),
    )
    conn.commit()
    conn.close()
    if cur.rowcount == 0:
        raise HTTPException(403, '끌올한 사람만 내릴 수 있습니다.')
    return {'ok': True}


@router.get('/{song_id}/thumb')
def song_thumb(song_id: int, request: Request):
    """자켓 그림. 저장돼 있으면 바로 주고, 없으면 그 자리에서 받아 저장한 뒤 준다.
       같은 그림을 다시 안 받도록 ETag 를 붙인다."""
    conn = get_db()
    try:
        data = thumbs.ensure(conn, song_id)
    finally:
        conn.close()
    if not data:
        raise HTTPException(404, '자켓 그림이 없습니다.')
    etag = '"%s"' % hashlib.md5(data).hexdigest()
    cache = 'public, max-age=604800'
    if request.headers.get('if-none-match') == etag:
        return Response(status_code=304, headers={'ETag': etag, 'Cache-Control': cache})
    return Response(content=data, media_type='image/jpeg',
                    headers={'ETag': etag, 'Cache-Control': cache})
