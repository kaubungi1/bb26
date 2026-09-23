"""관리 탭. 멤버·길드 삭제와 파딱·핑딱 딱지. 누가 무엇을 할 수 있는지는 admin.py 가 정한다.

목록은 따로 두지 않는다. 화면은 공개 목록(/api/members, /api/guilds)을 그대로 읽는다 —
이미 캐시되고 있고, 관리 탭 때문에 같은 데이터를 한 벌 더 만들 이유가 없다.
여기에는 되돌릴 수 없는 쓰기와, 그 직전에 무엇이 사라지는지 세는 조회만 있다."""
from fastapi import APIRouter, HTTPException, Request, Response

import admin
import imageserve
from db import get_db
from guildtheme import cache_clear

router = APIRouter()

# 멤버를 지울 때 같이 지우는 참여 기록. (테이블, 화면에 쓸 이름)
# 탈퇴한 사람의 지원이 남아 있으면 참여하는 것처럼 보여 오히려 헷갈린다(사용자 결정, 2026-09-23).
# 그 사람이 올린 곡·일정·길드·악보는 모두가 쓰는 자료라 남긴다. 작성자 이름만 글자로 남는다.
MEMBER_TRACES = (
    ('sessionSupports', '세션 지원'),
    ('eventLineups', '일정 편성'),
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
