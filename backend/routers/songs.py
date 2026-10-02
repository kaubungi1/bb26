"""곡. 모든 곡은 길드 하나 또는 프리길드(길드 없음)에 속한다. 끌올은 전체에서 한 곡만 30분 독점.

같은 곡을 여러 길드가 하면 길드마다 따로 둔다 — 지원자 명단이 섞이지 않게(사용자 결정, 2026-10-02).
같은 소속 안의 중복, 길드에 있는 곡의 프리길드 등록은 막는다(songmatch.py).
길드 곡은 그 길드 멤버(와 관리자)만 등록한다. 프리길드 곡은 누구나 등록한다(사용자 결정, 2026-10-02).
태그는 꼭 하나 고른다(SONG_TAGS).
소속을 바꾸는 것(이전)은 여기가 아니라 /api/admin/songs/{id}/guild 에서 한다 — 관리자·길드장만 된다.
삭제도 /api/admin/songs/{id} 에서 한다 — 관리자와 등록한 사람만 된다."""
from fastapi import APIRouter, BackgroundTasks, HTTPException, Request

from db import get_db

import imageserve
import admin
import listcache
import songmatch
import thumbs
from helpers import (PART_ROLES, SONG_COLS, SONG_TAGS, attach_guilds, build_songs, guild_where, norm_tag,
                     resolve_guild_id)

router = APIRouter()

BUMP_MINUTES = 30
NOTE_MAX = 60
TITLE_MAX = 120


def _title_ko(body):
    """한국어 번역은 선택이다. 비우면 None."""
    return (str(body.get('titleKo') or '').strip()[:TITLE_MAX]) or None


def _tag(value):
    """태그는 꼭 하나, 목록 안에서. 옛 데이터의 '쉼표로 여럿' 은 norm_tag 가 첫 번째만 남긴다."""
    tag = norm_tag(value)
    if tag not in SONG_TAGS:
        raise HTTPException(400, '태그를 골라 주세요.')
    return tag


def _require_member(conn, guild_id, nickname):
    """길드 곡은 그 길드 멤버만 등록한다. 관리자(파딱·핑딱, 관리자 닉네임)는 어느 길드든 된다(사용자 결정 (a)).
    신원은 닉네임뿐이라 화면 실수를 막는 정도다 — 사이트의 다른 권한과 같은 수준이다."""
    if guild_id is None:
        return
    nick = (nickname or '').strip()
    if admin.is_admin_nick(conn, nick):
        return
    if nick and conn.execute('SELECT 1 FROM guildMembers WHERE "guildId"=%s AND "nickname"=%s LIMIT 1',
                             (guild_id, nick)).fetchone():
        return
    conn.close()
    raise HTTPException(403, '그 길드의 멤버만 길드 곡으로 등록할 수 있습니다. 프리길드로 등록해 주세요.')


def _check_duplicate(conn, title, title_ko, url, guild_id, not_same, exclude=None, already=()):
    """중복 규칙에 걸리면 409. 본문의 candidates 로 화면이 '혹시 이 곡인가요?' 를 그린다.
    already: 수정 전부터 부딪히던 곡 id. 수정은 '새로' 생기는 중복만 막는다 — 정리 전의 중복 쌍(2026-10-02 기준
    38쌍)이 번역 한 줄 고치는 것까지 막으면 안 된다. 원래 있던 중복은 관리자 병합으로 정리한다."""
    found = songmatch.conflicts(songmatch.find(conn, title, title_ko, url, exclude), guild_id, not_same)
    found = [f for f in found if f['id'] not in already]
    if found:
        attach_guilds(conn, found)
        conn.close()
        raise HTTPException(409, songmatch.duplicate_error(found))

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
def list_songs(request: Request, guild: str | None = None):
    """5초마다 폴링된다. 바뀐 게 없으면 DB 를 다시 읽지 않는다(listcache.py)."""
    def build(conn):
        clause, params = guild_where(conn, guild)
        rows = conn.execute(f'{SONG_COLS}{clause} ORDER BY "createdAt" DESC', params).fetchall()
        return build_songs(conn, rows)
    return listcache.serve(request, 'songs', listcache.SONGS, build)


@router.get('/bump')
def get_bump():
    """지금 끌올된 곡. 없으면 null."""
    conn = get_db()
    cur = _current_bump(conn)
    conn.close()
    return cur


@router.get('/similar')
def similar_songs(title: str = '', titleKo: str = '', youtubeUrl: str = '', exclude: int | None = None):
    """입력하는 동안 '혹시 이 곡인가요?' 후보. 폴링이 아니다 — 입력이 멈출 때 한 번씩 부른다.
    여기서는 막지 않고 후보만 준다. 어느 소속과 부딪히는지는 화면이 고른 길드로 따진다(conflicts 와 같은 규칙)."""
    if not (title.strip() or titleKo.strip() or youtubeUrl.strip()):
        return []
    conn = get_db()
    try:
        return attach_guilds(conn, songmatch.find(conn, title, titleKo, youtubeUrl, exclude))
    finally:
        conn.close()


@router.post('')
def create_song(body: dict, background: BackgroundTasks):
    title = (body.get('title') or '').strip()[:TITLE_MAX]
    artist = (body.get('artist') or '').strip()
    if not title or not artist:
        raise HTTPException(400, 'title과 artist는 필수입니다.')
    title_ko = _title_ko(body)
    tag = _tag(body.get('tags'))
    conn = get_db()
    guild_id = resolve_guild_id(conn, body)
    _require_member(conn, guild_id, body.get('createdBy'))
    _check_duplicate(conn, title, title_ko, body.get('youtubeUrl'), guild_id, body.get('notSame'))
    cur = conn.execute(
        'INSERT INTO songs (title, "titleKo", artist, category, "tags", "youtubeUrl", status, "isCandidate", note, '
        '"createdBy", "guildId") VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING "id"',
        (
            title, title_ko, artist, body.get('category'), tag, body.get('youtubeUrl'),
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
    if 'guildId' in body or 'guildSlug' in body:
        # 소속 변경은 권한을 따지는 이전 API 로만 한다. 여기서 받으면 누구나 옮길 수 있게 된다.
        raise HTTPException(400, '길드는 곡 정보 창의 길드 칸(관리자·길드장)에서 바꿉니다.')
    if 'tags' in body:
        body['tags'] = _tag(body['tags'])       # 비우는 것도 막는다
    conn = get_db()
    before = conn.execute('SELECT "thumbVideoId" v, "title", "titleKo", "youtubeUrl", "guildId" '
                          'FROM songs WHERE "id"=%s', (song_id,)).fetchone()
    if not before:
        conn.close()
        raise HTTPException(404, '곡을 찾을 수 없습니다.')
    if 'title' in body and not str(body['title'] or '').strip():
        conn.close()
        raise HTTPException(400, '원제는 비울 수 없습니다.')
    # 제목·주소를 바꾸면 그 소속에 같은 곡이 생길 수 있다. 바꾼 뒤의 모습으로 따지되, 바꾸기 전부터
    # 부딪히던 곡은 빼고 새로 생기는 것만 막는다.
    if any(k in body for k in ('title', 'titleKo', 'youtubeUrl')):
        already = {f['id'] for f in songmatch.conflicts(
            songmatch.find(conn, before['title'], before['titleKo'], before['youtubeUrl'], song_id), before['guildId'])}
        _check_duplicate(
            conn,
            str(body.get('title', before['title']) or '').strip(),
            _title_ko(body) if 'titleKo' in body else before['titleKo'],
            body.get('youtubeUrl', before['youtubeUrl']),
            before['guildId'], body.get('notSame'), exclude=song_id, already=already,
        )
    fields = []
    values = []
    for key in ('title', 'titleKo', 'artist', 'category', 'tags', 'youtubeUrl', 'status', 'isCandidate', 'note'):
        if key in body:
            value = body[key]
            if key == 'isCandidate':
                value = 1 if value else 0
            elif key == 'tags':
                value = norm_tag(value)
            elif key == 'titleKo':
                value = _title_ko(body)
            elif key == 'title':
                value = str(value).strip()[:TITLE_MAX]
            fields.append(f'"{key}"=%s')
            values.append(value)
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


# 곡 삭제는 /api/admin/songs/{id} 에 있다 — 관리자와 등록한 사람만 지운다(사용자 결정, 2026-10-02).
# 여기 두면 화면을 거치지 않고 누구나 지울 수 있어 없앴다.


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
    """자켓 그림. 저장돼 있으면 주고, 없으면 그 자리에서 받아 저장한 뒤 준다(thumbs.ensure).
       버전은 유튜브 영상 id 다 — 주소가 바뀌어야 그림이 바뀐다. 주소·캐시 규칙은 imageserve.py."""
    def version_of(conn):
        row = conn.execute(
            'SELECT "thumbVideoId" vid, "youtubeUrl" url, (thumb IS NOT NULL) has FROM songs WHERE "id"=%s',
            (song_id,),
        ).fetchone()
        if not row:
            return None
        vid = row['vid'] or thumbs.video_id(row['url'])
        if not vid and not row['has']:
            return None
        return imageserve.thumb_version(vid)

    return imageserve.serve(request, 'thumb', song_id, version_of,
                            lambda conn: thumbs.ensure(conn, song_id),
                            'image/jpeg', '자켓 그림이 없습니다.')
