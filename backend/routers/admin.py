"""관리 탭. 멤버·길드 삭제와 파딱·핑딱 딱지. 누가 무엇을 할 수 있는지는 admin.py 가 정한다.

목록은 따로 두지 않는다. 화면은 공개 목록(/api/members, /api/guilds)을 그대로 읽는다 —
이미 캐시되고 있고, 관리 탭 때문에 같은 데이터를 한 벌 더 만들 이유가 없다.
여기에는 되돌릴 수 없는 쓰기와, 그 직전에 무엇이 사라지는지 세는 조회만 있다."""
from fastapi import APIRouter, HTTPException, Request, Response
from psycopg import errors as pg_errors

import admin
import imageserve
import songmatch
from db import get_db
from guildtheme import cache_clear
from helpers import SONG_COLS, SONG_IN_USE, attach_guilds, build_songs, release_song_refs, resolve_guild_id

router = APIRouter()

# 멤버를 지울 때 같이 지우는 참여 기록. (테이블, 화면에 쓸 이름)
# 탈퇴한 사람의 지원이 남아 있으면 참여하는 것처럼 보여 오히려 헷갈린다(사용자 결정, 2026-09-23).
# 그 사람이 올린 곡·일정·길드·악보는 모두가 쓰는 자료라 남긴다. 작성자 이름만 글자로 남는다.
MEMBER_TRACES = (
    ('sessionSupports', '세션 지원'),
    ('eventLineups', '일정 편성'),
    ('eventLineupSkips', '셋리스트 대기실'),
    ('eventAvails', '가능 날짜'),
    ('guildMembers', '길드 소속'),
    ('guildDrawings', '낙서'),
    ('songComments', '한마디'),
)


@router.post('/login')
def login(body: dict, request: Request, response: Response):
    admin.login(str(body.get('password') or ''), request, response)
    return {'role': 'root'}


@router.post('/logout')
def logout(response: Response):
    admin.logout(response)
    return {'ok': True}


@router.get('/me')
def me(request: Request):
    """지금 이 화면의 권한. 탭을 보여줄지, 표에서 무엇을 켤지 화면이 정하는 데 쓴다.
    실제 허락은 쓰기마다 서버가 다시 본다."""
    conn = get_db()
    try:
        return {'role': admin.role_of(conn, request)}
    finally:
        conn.close()


# ---------- 멤버 ----------
def _member_badge(conn, nickname):
    row = conn.execute('SELECT "badge" FROM members WHERE "nickname"=%s', (nickname,)).fetchone()
    if not row:
        raise HTTPException(404, '멤버를 찾을 수 없습니다.')
    return row['badge']


@router.get('/members/{nickname}/impact')
def member_impact(nickname: str, request: Request):
    """지우면 사라지는 것의 건수. 확인 창이 이걸 그대로 보여준다."""
    conn = get_db()
    try:
        admin.require(conn, request)
        _member_badge(conn, nickname)
        counts = [
            {'label': label,
             'count': conn.execute(f'SELECT count(*) n FROM {table} WHERE "nickname"=%s',
                                   (nickname,)).fetchone()['n']}
            for table, label in MEMBER_TRACES
        ]
        bumps = conn.execute('SELECT count(*) n FROM songs WHERE "bumpedBy"=%s', (nickname,)).fetchone()['n']
        counts.append({'label': '끌어올림 표시', 'count': bumps})
        return {'nickname': nickname, 'counts': counts}
    finally:
        conn.close()


@router.delete('/members/{nickname}')
def delete_member(nickname: str, request: Request):
    """멤버와 참여 기록을 한 트랜잭션으로 지운다. 중간에 실패하면 아무것도 지워지지 않는다."""
    conn = get_db()
    try:
        role = admin.require(conn, request)
        admin.require_above(role, _member_badge(conn, nickname))
        for table, _ in MEMBER_TRACES:
            conn.execute(f'DELETE FROM {table} WHERE "nickname"=%s', (nickname,))
        # 끌어올림은 곡에 붙은 표시다. 곡은 두고 표시만 뗀다.
        conn.execute('UPDATE songs SET "bumpedBy"=NULL, "bumpedAt"=NULL, "bumpNote"=NULL '
                     'WHERE "bumpedBy"=%s', (nickname,))
        conn.execute('DELETE FROM members WHERE "nickname"=%s', (nickname,))
        conn.commit()
    finally:
        conn.close()
    imageserve.forget('member', nickname)
    return {'ok': True}


@router.put('/members/{nickname}/badge')
def set_badge(nickname: str, body: dict, request: Request):
    """딱지 붙이기·떼기. 파딱은 늘 한 명이다 — 새로 붙이면 옛 파딱은 내려온다.
    파딱이 다른 사람에게 파딱을 붙이면 위임이다. 본인은 딱지 없이 내려온다."""
    badge = body.get('badge') or None
    if badge not in (None, *admin.BADGES):
        raise HTTPException(400, '딱지는 blue, pink, 없음 중 하나입니다.')
    conn = get_db()
    try:
        role = admin.require(conn, request, 'blue')
        current = _member_badge(conn, nickname)
        admin.require_above(role, current)
        # 파딱을 붙이면 지금의 파딱이 내려온다. 파딱 본인이 하면 그게 위임이다.
        if badge == 'blue':
            conn.execute('UPDATE members SET "badge"=NULL, "updatedAt"=now() WHERE "badge"=%s', ('blue',))
        conn.execute('UPDATE members SET "badge"=%s, "updatedAt"=now() WHERE "nickname"=%s', (badge, nickname))
        conn.commit()
        return {'nickname': nickname, 'badge': badge}
    finally:
        conn.close()


# ---------- 길드 ----------
def _guild_id(conn, slug):
    row = conn.execute('SELECT "id" FROM guilds WHERE "slug"=%s', (slug,)).fetchone()
    if not row:
        raise HTTPException(404, '길드를 찾을 수 없습니다.')
    return row['id']


@router.get('/guilds/{slug}/impact')
def guild_impact(slug: str, request: Request):
    """길드를 지우면 명단과 낙서는 사라지고, 곡·일정은 남되 소속만 풀린다(ON DELETE SET NULL)."""
    conn = get_db()
    try:
        admin.require(conn, request)
        gid = _guild_id(conn, slug)
        n = lambda sql: conn.execute(sql, (gid,)).fetchone()['n']
        return {'slug': slug, 'counts': [
            {'label': '길드 소속', 'count': n('SELECT count(*) n FROM guildMembers WHERE "guildId"=%s')},
            {'label': '낙서', 'count': n('SELECT count(*) n FROM guildDrawings WHERE "guildId"=%s')},
        ], 'released': [
            {'label': '곡', 'count': n('SELECT count(*) n FROM songs WHERE "guildId"=%s')},
            {'label': '일정', 'count': n('SELECT count(*) n FROM events WHERE "guildId"=%s')},
        ]}
    finally:
        conn.close()


@router.delete('/guilds/{slug}')
def delete_guild(slug: str, request: Request):
    conn = get_db()
    try:
        admin.require(conn, request)
        conn.execute('DELETE FROM guilds WHERE "id"=%s', (_guild_id(conn, slug),))
        conn.commit()
    finally:
        conn.close()
    imageserve.forget('crest', slug)
    # 서버가 HTML 에 박아 보내는 테마가 메모리에 남아 있다(guildtheme.py).
    cache_clear()
    return {'ok': True}


# ---------- 곡 이전(소속 바꾸기) ----------
def _leader_of(conn, guild_id):
    if guild_id is None:
        return None
    row = conn.execute('SELECT "leader" FROM guilds WHERE "id"=%s', (guild_id,)).fetchone()
    return (row['leader'] or '').strip() if row else None


def can_move(conn, request, from_gid, to_gid):
    """관리자(파딱·핑딱·root)는 언제나. 길드장은 자기 길드 곡을 내보낼 때,
    그리고 프리길드 곡을 자기 길드로 가져올 때(사용자 결정, 2026-10-02). 길드장은 guilds.leader 닉네임이다."""
    if admin.rank(admin.role_of(conn, request)) >= admin.rank('pink'):
        return True
    me = admin.nickname_of(request)
    if not me:
        return False
    if from_gid is not None:
        return me == _leader_of(conn, from_gid)
    return me == _leader_of(conn, to_gid)


@router.post('/songs/{song_id}/guild')
def move_song(song_id: int, body: dict, request: Request):
    """곡의 소속을 바꾼다. 지원자·댓글·합주 기록은 곡에 붙어 있어 그대로 따라간다.
    길드원이 아닌 지원자는 화면에서 용병으로 보인다(명단으로 계산하므로 따로 할 일이 없다).
    옮겨 갈 곳에 같은 곡이 이미 있으면 막는다 — 그때는 관리자가 병합한다."""
    conn = get_db()
    try:
        song = conn.execute('SELECT "id","title","titleKo","youtubeUrl","guildId" FROM songs WHERE "id"=%s',
                            (song_id,)).fetchone()
        if not song:
            raise HTTPException(404, '곡을 찾을 수 없습니다.')
        target = resolve_guild_id(conn, body)          # 비우면 프리길드
        if target != song['guildId']:
            if not can_move(conn, request, song['guildId'], target):
                raise HTTPException(403, '관리자나 길드장만 길드를 옮길 수 있습니다.')
            found = songmatch.conflicts(
                songmatch.find(conn, song['title'], song['titleKo'], song['youtubeUrl'], exclude=song_id), target)
            if found:
                attach_guilds(conn, found)
                err = songmatch.duplicate_error(found)
                err['message'] = '옮길 곳에 같은 곡이 이미 있습니다. 관리자에게 두 곡 병합을 부탁해 주세요.'
                raise HTTPException(409, err)
            conn.execute('UPDATE songs SET "guildId"=%s, "updatedAt"=now() WHERE "id"=%s', (target, song_id))
            conn.commit()
        row = conn.execute(f'{SONG_COLS} WHERE "id"=%s', (song_id,)).fetchone()
        return build_songs(conn, [row])[0]
    finally:
        conn.close()


# ---------- 곡 삭제 ----------
def can_delete(conn, request, created_by):
    """관리자(파딱·핑딱·root)와 그 곡을 등록한 사람(createdBy 닉네임)만(사용자 결정, 2026-10-02).
    '시트 가져오기' 로 들어온 곡이나 등록자가 비어 있는 옛 곡은 관리자만 지운다."""
    if admin.rank(admin.role_of(conn, request)) >= admin.rank('pink'):
        return True
    me = admin.nickname_of(request)
    return bool(me) and me == (created_by or '').strip()


@router.delete('/songs/{song_id}')
def delete_song(song_id: int, request: Request):
    """파트·지원·댓글·셋리스트·합주 기록은 곡에 매여 함께 지워진다(ON DELETE CASCADE)."""
    conn = get_db()
    try:
        row = conn.execute('SELECT "createdBy" FROM songs WHERE "id"=%s', (song_id,)).fetchone()
        if not row:
            raise HTTPException(404, '곡을 찾을 수 없습니다.')
        if not can_delete(conn, request, row['createdBy']):
            raise HTTPException(403, '관리자나 곡을 등록한 사람만 지울 수 있습니다.')
        release_song_refs(conn, song_id)
        conn.execute('DELETE FROM songs WHERE "id"=%s', (song_id,))
        conn.commit()
    except pg_errors.ForeignKeyViolation:
        conn.rollback()
        raise HTTPException(409, SONG_IN_USE)
    finally:
        conn.close()
    imageserve.forget('thumb', song_id)
    return {'ok': True}


# ---------- 정기합주·정기공연 참가 길드 ----------
@router.put('/events/{event_id}/guilds')
def set_event_guilds(event_id: int, body: dict, request: Request):
    """참가 길드를 이 목록으로 맞춘다(멱등). 관리자만. 확정 뒤에도 바꿀 수 있다 — 늦게 합류하는 길드가 있다."""
    from routers.events import UNION_KINDS, _guild_ids, serialize_event
    conn = get_db()
    try:
        admin.require(conn, request)
        event = conn.execute('SELECT * FROM events WHERE "id"=%s', (event_id,)).fetchone()
        if not event:
            raise HTTPException(404, '일정을 찾을 수 없습니다.')
        kind = event['kind'] or ('guild' if event['guildId'] else 'regular')
        if kind not in UNION_KINDS:
            raise HTTPException(400, '참가 길드는 정기합주·정기공연에만 있습니다.')
        ids = _guild_ids(conn, body)
        if ids:
            ph = ','.join('%s' for _ in ids)
            conn.execute(f'DELETE FROM eventGuilds WHERE "eventId"=%s AND "guildId" NOT IN ({ph})', [event_id, *ids])
        else:
            conn.execute('DELETE FROM eventGuilds WHERE "eventId"=%s', (event_id,))
        for gid in ids:
            conn.execute('INSERT INTO eventGuilds ("eventId", "guildId") VALUES (%s,%s) ON CONFLICT DO NOTHING',
                         (event_id, gid))
        conn.commit()
        return serialize_event(conn, conn.execute('SELECT * FROM events WHERE "id"=%s', (event_id,)).fetchone())
    finally:
        conn.close()
