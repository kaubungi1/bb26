"""메인(홈) 화면 한 번에. 무대 = 다음 합주에 오는 사람들이 주 파트 자리에 선다."""
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, HTTPException

from db import get_db
from helpers import attach_guilds
from routers.songs import _current_bump

router = APIRouter()

MIN_FILLED_FOR_TODO = 3    # 이만큼 찬 곡의 내 파트가 비어 있으면 '할 일'로 센다
MEMBER_COLS = '"nickname", "mainRoles", "color", "avatar", "title", "status", "updatedAt", ("image" IS NOT NULL) AS "hasImage"'
SITE_TIMEZONE = timezone(timedelta(hours=9))


def today_kst():
    return datetime.now(SITE_TIMEZONE).date().isoformat()


def _profiles(conn, nicknames):
    if not nicknames:
        return {}
    ph = ','.join('%s' for _ in nicknames)
    rows = conn.execute(f'SELECT {MEMBER_COLS} FROM members WHERE "nickname" IN ({ph})', list(nicknames)).fetchall()
    return {r['nickname']: dict(r) for r in rows}


def main_role(profile, guessed):
    """주 파트. 프로필에 적은 첫 파트, 없으면 지원 이력에서 가장 많이 맡은 파트."""
    if profile and profile.get('mainRoles'):
        first = str(profile['mainRoles']).split(',')[0].strip()
        if first:
            return first
    return guessed


def _guess_roles(conn, nicknames):
    """닉네임별로 가장 많이 지원한 파트."""
    if not nicknames:
        return {}
    ph = ','.join('%s' for _ in nicknames)
    rows = conn.execute(
        f'SELECT sp."nickname", se."role", COUNT(*) AS c FROM sessionSupports sp '
        f'JOIN sessions se ON se."id"=sp."sessionId" WHERE sp."nickname" IN ({ph}) '
        f'GROUP BY sp."nickname", se."role" ORDER BY c DESC, se."role"', list(nicknames)
    ).fetchall()
    out = {}
    for r in rows:
        out.setdefault(r['nickname'], r['role'])
    return out


def _next_event(conn, guild_id, today):
    """다음 합주. 오늘 이후 가장 가까운 확정 일정, 없으면 조율 중인 일정(가장 먼저 만든 것)."""
    where = ''
    params = []
    if guild_id is not None:
        where = ' AND "guildId"=%s'
        params = [guild_id]
    row = conn.execute(
        f'SELECT * FROM events WHERE "status"=%s AND "date" >= %s{where} ORDER BY "date" LIMIT 1',
        ['confirmed', today, *params],
    ).fetchone()
    if row:
        return dict(row)
    row = conn.execute(
        f'SELECT * FROM events WHERE "status"=%s{where} AND EXISTS '
        f'(SELECT 1 FROM eventDates d WHERE d."eventId"=events."id" AND d."date">=%s) '
        f'ORDER BY "createdAt", "id" LIMIT 1',
        ['poll', *params, today],
    ).fetchone()
    return dict(row) if row else None


def _stage(conn, event, nickname, today=None):
    """무대에 설 사람들. 확정이면 확정일, 조율 중이면 가장 많이 되는 날짜 기준."""
    dates = [r['date'] for r in conn.execute(
        'SELECT "date" FROM eventDates WHERE "eventId"=%s ORDER BY "date"', (event['id'],)).fetchall()]
    avails = conn.execute(
        'SELECT "date", "nickname" FROM eventAvails WHERE "eventId"=%s ORDER BY "id"', (event['id'],)).fetchall()
    if event['status'] == 'confirmed':
        day = event['date']
    else:
        dates = [d for d in dates if d >= (today or today_kst())]
        counts = {}
        for a in avails:
            counts[a['date']] = counts.get(a['date'], 0) + 1
        day = max(dates, key=lambda d: (counts.get(d, 0), -dates.index(d))) if dates else None
    people = []
    seen = set()
    for a in avails:
        if a['date'] == day and a['nickname'] not in seen:
            seen.add(a['nickname'])
            people.append(a['nickname'])
    profiles = _profiles(conn, people)
    guessed = _guess_roles(conn, people)
    attendees = [
        {'nickname': n, 'role': main_role(profiles.get(n), guessed.get(n)), 'profile': profiles.get(n)}
        for n in people
    ]
    songs = conn.execute(
        'SELECT es."songId", s."title" FROM eventSongs es JOIN songs s ON s."id"=es."songId" '
        'WHERE es."eventId"=%s ORDER BY es."order", es."id"', (event['id'],)).fetchall()
    return {
        'event': event,
        'isPoll': event['status'] != 'confirmed',
        'stageDate': day,
        'dates': dates,
        'attendees': attendees,
        'myChecked': bool(nickname) and nickname in seen,
        'songs': [dict(r) for r in songs],
    }


def _todo(conn, nickname, my_role, guild_id, today=None):
    """빨간 점 두 개: 투표 안 한 조율 중 일정 수, 내 파트가 비어 있는(다른 파트는 찬) 곡 수."""
    if not nickname:
        return {'pollsUnvoted': 0, 'emptyMySongs': 0}
    where = ''
    params = [nickname]
    if guild_id is not None:
        where = ' AND e."guildId"=%s'
        params.append(guild_id)
    unvoted = conn.execute(
        f'SELECT COUNT(*) AS c FROM events e WHERE e."status"=\'poll\' AND NOT EXISTS '
        f'(SELECT 1 FROM eventAvails a WHERE a."eventId"=e."id" AND a."nickname"=%s){where} '
        f'AND EXISTS (SELECT 1 FROM eventDates d WHERE d."eventId"=e."id" AND d."date">=%s)',
        [*params, today or today_kst()]
    ).fetchone()['c']
    empty = 0
    if my_role:
        rows = conn.execute(
            'SELECT se."songId", se."role", COUNT(sp."id") AS c FROM sessions se '
            'JOIN songs s ON s."id"=se."songId" '
            'LEFT JOIN sessionSupports sp ON sp."sessionId"=se."id" '
            + ('WHERE s."guildId"=%s ' if guild_id is not None else '')
            + 'GROUP BY se."songId", se."role"',
            [guild_id] if guild_id is not None else []
        ).fetchall()
        by_song = {}
        for r in rows:
            by_song.setdefault(r['songId'], {})[r['role']] = r['c']
        for roles in by_song.values():
            if roles.get(my_role) == 0 and sum(1 for c in roles.values() if c) >= MIN_FILLED_FOR_TODO:
                empty += 1
    return {'pollsUnvoted': unvoted, 'emptyMySongs': empty}


@router.get('')
def home(nickname: str | None = None, guild: str | None = None):
    nickname = (nickname or '').strip() or None
    today = today_kst()
    conn = get_db()

    guild_row = None
    guild_id = None
    if guild:
        guild_row = conn.execute('SELECT * FROM guilds WHERE "slug"=%s', (guild,)).fetchone()
        if guild_row:
            guild_id = guild_row['id']
        else:
            conn.close()
            raise HTTPException(404, '길드를 찾을 수 없습니다.')

    me = _profiles(conn, [nickname]).get(nickname) if nickname else None
    my_role = main_role(me, _guess_roles(conn, [nickname]).get(nickname)) if nickname else None

    event = _next_event(conn, guild_id, today)
    stage = _stage(conn, event, nickname, today) if event else None
    if stage:
        attach_guilds(conn, [stage['event']])

    result = {
        'me': me,
        'myRole': my_role,
        'bump': _current_bump(conn),
        'next': stage,
        'todo': _todo(conn, nickname, my_role, guild_id, today),
        'counts': {
            'guilds': conn.execute('SELECT COUNT(*) AS c FROM guilds').fetchone()['c'],
            'members': conn.execute('SELECT COUNT(*) AS c FROM members').fetchone()['c'],
        },
        'guild': None,
    }
    if guild_row:
        g = dict(guild_row)
        members = [dict(r) for r in conn.execute(
            'SELECT * FROM guildMembers WHERE "guildId"=%s ORDER BY "id"', (guild_id,)).fetchall()]
        profiles = _profiles(conn, {m['nickname'] for m in members})
        for m in members:
            m['profile'] = profiles.get(m['nickname'])
        g['members'] = members
        result['guild'] = g
    conn.close()
    return result
