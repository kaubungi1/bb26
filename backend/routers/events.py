"""일정. 날짜 투표 → 확정 → 셋리스트와 라인업 저장. 길드 합주도 같은 달력에 놓인다."""
from datetime import date as _date
from datetime import timedelta

from fastapi import APIRouter, HTTPException, Request

from db import get_db
import listcache
from helpers import PART_ROLES, attach_guilds, guild_where, resolve_guild_id

router = APIRouter()

# 후보 날짜 상한. 한 달치를 넘기지 않는다 — 매트릭스가 그만큼 길어지고,
# 아무도 안 찍을 날이 줄로 남는다.
MAX_DATES = 40


# ---------- 직렬화 ----------
def _setlists(conn, event_ids):
    """eventId -> [ {songId, order, note, title, artist, guild, lineup:[{role,nickname}]} ]"""
    out = {eid: [] for eid in event_ids}
    if not event_ids:
        return out
    ph = ','.join('%s' for _ in event_ids)
    rows = conn.execute(
        f'SELECT es."eventId", es."songId", es."order", es."note", s."title", s."artist", '
        f's."youtubeUrl", s."guildId" FROM eventSongs es JOIN songs s ON s."id"=es."songId" '
        f'WHERE es."eventId" IN ({ph}) ORDER BY es."order", es."id"', event_ids
    ).fetchall()
    items = [dict(r) for r in rows]
    attach_guilds(conn, items)
    for it in items:
        it['lineup'] = []
        out[it['eventId']].append(it)
    lineups = conn.execute(
        f'SELECT "eventId", "songId", "role", "nickname" FROM eventLineups '
        f'WHERE "eventId" IN ({ph}) ORDER BY "id"', event_ids
    ).fetchall()
    for l in lineups:
        for it in out[l['eventId']]:
            if it['songId'] == l['songId']:
                it['lineup'].append({'role': l['role'], 'nickname': l['nickname']})
    return out


def serialize_events(conn, rows):
    events = [dict(r) for r in rows]
    if not events:
        return []
    ids = [e['id'] for e in events]
    ph = ','.join('%s' for _ in ids)
    for e in events:
        e['dates'] = []
        e['avails'] = []
    for d in conn.execute(
        f'SELECT * FROM eventDates WHERE "eventId" IN ({ph}) ORDER BY "date"', ids
    ).fetchall():
        for e in events:
            if e['id'] == d['eventId']:
                e['dates'].append(dict(d))
    for a in conn.execute(
        f'SELECT * FROM eventAvails WHERE "eventId" IN ({ph}) ORDER BY "date", nickname', ids
    ).fetchall():
        for e in events:
            if e['id'] == a['eventId']:
                e['avails'].append(dict(a))
    setlists = _setlists(conn, ids)
    for e in events:
        e['songs'] = setlists.get(e['id'], [])
    attach_guilds(conn, events)
    return events


def serialize_event(conn, row):
    return serialize_events(conn, [row])[0]


def _load(conn, event_id):
    event = conn.execute('SELECT * FROM events WHERE "id"=%s', (event_id,)).fetchone()
    if not event:
        conn.close()
        raise HTTPException(404, '일정을 찾을 수 없습니다.')
    return event


# ---------- 목록·생성·삭제 ----------
@router.get('')
def list_events(request: Request, guild: str | None = None):
    """5초마다 폴링된다. 바뀐 게 없으면 DB 를 다시 읽지 않는다(listcache.py)."""
    def build(conn):
        clause, params = guild_where(conn, guild)
        rows = conn.execute(f'SELECT * FROM events{clause} ORDER BY "createdAt" DESC', params).fetchall()
        return serialize_events(conn, rows)
    return listcache.serve(request, 'events', listcache.EVENTS, build)


@router.post('')
def create_event(body: dict):
    title = (body.get('title') or '').strip()
    date_from = body.get('dateFrom')
    date_to = body.get('dateTo')
    if not title:
        raise HTTPException(400, 'title은 필수입니다.')
    if not date_from or not date_to:
        raise HTTPException(400, 'dateFrom과 dateTo는 필수입니다.')
    if date_from > date_to:
        raise HTTPException(400, '후보 기간이 올바르지 않습니다.')

    # 요일 고르기. 0=일 … 6=토 (자바스크립트 getDay 과 같은 번호).
    # 비어 있으면 기간 안 모든 날이 후보다. 주말 정기합주는 [0, 6] 을 준다.
    try:
        weekdays = {int(x) for x in (body.get('weekdays') or [])}
    except (TypeError, ValueError):
        raise HTTPException(400, 'weekdays 가 올바르지 않습니다.')
    if weekdays - set(range(7)):
        raise HTTPException(400, 'weekdays 는 0(일)~6(토) 입니다.')

    d0 = _date.fromisoformat(date_from)
    d1 = _date.fromisoformat(date_to)
    if (d1 - d0).days > 400:
        raise HTTPException(400, '후보 기간이 너무 깁니다.')
    days = []
    d = d0
    while d <= d1:
        # date.weekday() 는 0=월 이라 자바스크립트 번호로 옮긴다
        if not weekdays or ((d.weekday() + 1) % 7) in weekdays:
            days.append(d.isoformat())
        d += timedelta(days=1)
    if not days:
        raise HTTPException(400, '고른 요일이 기간 안에 없습니다.')
    if len(days) > MAX_DATES:
        raise HTTPException(
            400, f'후보 날짜가 {len(days)}일입니다. {MAX_DATES}일까지만 만들 수 있습니다. '
                 f'기간을 줄이거나 요일을 고르세요.')

    conn = get_db()
    guild_id = resolve_guild_id(conn, body)
    cur = conn.execute(
        'INSERT INTO events (title, status, note, "createdBy", "guildId") VALUES (%s,%s,%s,%s,%s) RETURNING "id"',
        (title, 'poll', body.get('note'), body.get('createdBy'), guild_id),
    )
    event_id = cur.fetchone()['id']
    for day in days:
        conn.execute(
            'INSERT INTO eventDates ("eventId", "date") VALUES (%s,%s) ON CONFLICT DO NOTHING',
            (event_id, day),
        )
    conn.commit()
    row = conn.execute('SELECT * FROM events WHERE "id"=%s', (event_id,)).fetchone()
    result = serialize_event(conn, row)
    conn.close()
    return result


@router.delete('/{event_id}')
def delete_event(event_id: int):
    conn = get_db()
    cur = conn.execute('DELETE FROM events WHERE "id"=%s', (event_id,))
    conn.commit()
    conn.close()
    if cur.rowcount == 0:
        raise HTTPException(404, '일정을 찾을 수 없습니다.')
    return {'ok': True}


# ---------- 후보 날짜 끄고 켜기 ----------
@router.post('/{event_id}/dates/{day}/toggle')
def toggle_date(event_id: int, day: str, body: dict | None = None):
    """후보 날짜를 끄거나 켠다. 지우지 않으므로 그 날 찍어 둔 기록은 그대로 남는다.
    10/24 가 정모일이라 후보에서 빠지는 것 같은 경우를 위한 것이다.
    active(true/false)를 보내면 그 상태로 맞춘다 — 화면이 누르는 즉시 바꾸고 보내므로 같은 요청이 두 번 가도
    결과가 같아야 한다. active 가 없으면 예전처럼 뒤집는다(배포 직후의 옛 화면용)."""
    conn = get_db()
    event = _load(conn, event_id)
    row = conn.execute(
        'SELECT * FROM eventDates WHERE "eventId"=%s AND "date"=%s', (event_id, day)
    ).fetchone()
    if not row:
        conn.close()
        raise HTTPException(400, '후보 기간에 없는 날짜입니다.')
    want = (body or {}).get('active')
    nxt = want if isinstance(want, bool) else not row['active']
    if event['status'] == 'confirmed' and event['date'] == day and not nxt:
        conn.close()
        raise HTTPException(400, '확정된 날짜는 끌 수 없습니다. 확정을 먼저 해제하세요.')
    conn.execute('UPDATE eventDates SET "active"=%s WHERE "id"=%s', (nxt, row['id']))
    conn.commit()
    kept = conn.execute(
        'SELECT COUNT(*) AS n FROM eventAvails WHERE "eventId"=%s AND "date"=%s', (event_id, day)
    ).fetchone()['n']
    conn.close()
    return {'date': day, 'active': nxt, 'keptAvails': kept}


# ---------- 참석 토글 ----------
@router.post('/{event_id}/avail/toggle')
def toggle_avail(event_id: int, body: dict):
    """참석 표시. checked(true/false)를 보내면 그 상태로 맞춘다 — 같은 요청을 두 번 보내도 결과가 같다.
    화면이 누르는 즉시 칸을 바꾸고 요청을 보내므로, 폰·PC 에서 동시에 눌러도, 응답을 못 받아
    다시 보내도 어긋나지 않아야 한다. checked 가 없으면 예전처럼 뒤집는다(배포 직후의 옛 화면용)."""
    day = (body.get('date') or '').strip()
    nickname = (body.get('nickname') or '').strip()
    if not day or not nickname:
        raise HTTPException(400, 'date와 nickname은 필수입니다.')
    if len(nickname) > 20:
        raise HTTPException(400, '닉네임은 20자까지 입력할 수 있습니다.')
    conn = get_db()
    event = _load(conn, event_id)
    if event['status'] == 'confirmed' and day != event['date']:
        conn.close()
        raise HTTPException(400, '확정된 일정은 확정 날짜의 인원만 변경할 수 있습니다.')
    date_row = conn.execute(
        'SELECT * FROM eventDates WHERE "eventId"=%s AND "date"=%s AND "active"', (event_id, day)
    ).fetchone()
    if not date_row:
        conn.close()
        raise HTTPException(400, '후보에 없거나 꺼 둔 날짜입니다.')
    want = body.get('checked')
    if isinstance(want, bool):
        if want:
            conn.execute(
                'INSERT INTO eventAvails ("eventId", "date", nickname) VALUES (%s,%s,%s) ON CONFLICT DO NOTHING',
                (event_id, day, nickname),
            )
        else:
            conn.execute('DELETE FROM eventAvails WHERE "eventId"=%s AND "date"=%s AND nickname=%s',
                         (event_id, day, nickname))
        conn.commit()
        conn.close()
        return {'checked': want}
    existing = conn.execute(
        'SELECT "id" FROM eventAvails WHERE "eventId"=%s AND "date"=%s AND nickname=%s',
        (event_id, day, nickname),
    ).fetchone()
    if existing:
        conn.execute('DELETE FROM eventAvails WHERE "id"=%s', (existing['id'],))
        conn.commit()
        conn.close()
        return {'checked': False}
    conn.execute(
        'INSERT INTO eventAvails ("eventId", "date", nickname) VALUES (%s,%s,%s)',
        (event_id, day, nickname),
    )
    conn.commit()
    conn.close()
    return {'checked': True}


# ---------- 확정·해제 ----------
@router.post('/{event_id}/confirm')
def confirm_event(event_id: int, body: dict):
    day = (body.get('date') or '').strip()
    if not day:
        raise HTTPException(400, 'date는 필수입니다.')
    conn = get_db()
    _load(conn, event_id)
    date_row = conn.execute(
        'SELECT * FROM eventDates WHERE "eventId"=%s AND "date"=%s AND "active"', (event_id, day)
    ).fetchone()
    if not date_row:
        conn.close()
        raise HTTPException(400, '후보에 없거나 꺼 둔 날짜입니다.')
    conn.execute(
        'UPDATE events SET status=\'confirmed\', "date"=%s, "startTime"=%s, "endTime"=%s, place=%s, '
        '"updatedAt"=now() WHERE "id"=%s',
        (day, body.get('startTime'), body.get('endTime'), body.get('place'), event_id),
    )
    conn.commit()
    row = conn.execute('SELECT * FROM events WHERE "id"=%s', (event_id,)).fetchone()
    result = serialize_event(conn, row)
    conn.close()
    return result


@router.post('/{event_id}/unconfirm')
def unconfirm_event(event_id: int):
    conn = get_db()
    event = _load(conn, event_id)
    if event['status'] != 'confirmed':
        conn.close()
        raise HTTPException(400, '확정된 일정이 아닙니다.')
    conn.execute(
        'UPDATE events SET status=\'poll\', "date"=NULL, "startTime"=NULL, "endTime"=NULL, '
        'place=NULL, "updatedAt"=now() WHERE "id"=%s',
        (event_id,),
    )
    conn.commit()
    row = conn.execute('SELECT * FROM events WHERE "id"=%s', (event_id,)).fetchone()
    result = serialize_event(conn, row)
    conn.close()
    return result


# ---------- 날짜별 가능 곡 ----------
def _attendees(conn, event_id, day):
    return {
        r['nickname']
        for r in conn.execute(
            'SELECT nickname FROM eventAvails WHERE "eventId"=%s AND "date"=%s', (event_id, day)
        ).fetchall()
    }


def _song_map(conn):
    """곡 → 세션 → 지원자. 풀 전체를 한 번에 읽는다. 길드 곡도 섞여 들어온다.

    꺼 둔 자리(active=false)는 뺀다. 안 쓰는 자리가 needed 에 들어가면 같은 곡이
    곡 페이지에서는 4/5, 일정에서는 4/6 으로 보인다."""
    rows = conn.execute(
        'SELECT s."id" AS "songId", s.title, s.artist, s."youtubeUrl", s."guildId", '
        'se."id" AS "sessionId", se.role, se.label, sp.nickname '
        'FROM songs s '
        'JOIN sessions se ON se."songId"=s."id" AND se."active" '
        'LEFT JOIN sessionSupports sp ON sp."sessionId"=se."id" '
        'ORDER BY s."id", se."id"'
    ).fetchall()
    songs = {}
    for r in rows:
        song = songs.setdefault(
            r['songId'],
            {'songId': r['songId'], 'title': r['title'], 'artist': r['artist'],
             'youtubeUrl': r['youtubeUrl'], 'guildId': r['guildId'], 'sessions': {}},
        )
        sess = song['sessions'].setdefault(
            r['sessionId'], {'role': r['role'], 'label': r['label'], 'supports': []}
        )
        if r['nickname']:
            sess['supports'].append(r['nickname'])
    return songs


def _playable(conn, event, day):
    att = _attendees(conn, event['id'], day)
    songs = _song_map(conn)
    result = []
    for song in songs.values():
        roles = []
        members = set()
        for sess in song['sessions'].values():
            here = [n for n in sess['supports'] if n in att]
            members.update(here)
            roles.append({'role': sess['role'], 'label': sess['label'], 'members': here, 'ok': bool(here)})
        filled = sum(1 for r in roles if r['ok'])
        result.append({
            'songId': song['songId'], 'title': song['title'], 'artist': song['artist'],
            'youtubeUrl': song['youtubeUrl'], 'guildId': song['guildId'],
            'roles': roles, 'needed': len(roles), 'filled': filled, 'attending': len(members),
        })
    attach_guilds(conn, result)
    result.sort(key=lambda x: (-x['filled'], -x['attending'], x['title']))
    return {'date': day, 'attendees': sorted(att), 'songs': result}


@router.get('/{event_id}/playable')
def playable_songs(event_id: int, date: str | None = None):
    """어느 날짜의 가능 인원 기준으로 곡별 세션 충족도를 계산한다.
    조율 중에는 후보 날짜 아무거나, 확정 후에는 확정일이 기본이다."""
    conn = get_db()
    event = _load(conn, event_id)
    day = (date or '').strip() or event['date']
    if not day:
        conn.close()
        raise HTTPException(400, 'date를 지정하세요.')
    if not conn.execute(
        'SELECT 1 FROM eventDates WHERE "eventId"=%s AND "date"=%s AND "active"', (event_id, day)
    ).fetchone():
        conn.close()
        raise HTTPException(400, '후보에 없거나 꺼 둔 날짜입니다.')
    result = _playable(conn, event, day)
    conn.close()
    return result


# ---------- 셋리스트·라인업 ----------
@router.put('/{event_id}/songs')
def set_songs(event_id: int, body: dict):
    """셋리스트를 통째로 바꾼다. 새로 들어온 곡은 '그날 참석자 ∩ 지원자'로 라인업을 미리 채운다."""
    try:
        song_ids = list(dict.fromkeys(int(i) for i in (body.get('songIds') or [])))
    except (TypeError, ValueError):
        raise HTTPException(400, 'songIds가 올바르지 않습니다.')
    conn = get_db()
    event = _load(conn, event_id)
    if event['status'] != 'confirmed' or not event['date']:
        conn.close()
        raise HTTPException(400, '확정된 일정에만 셋리스트를 넣을 수 있습니다.')
    if song_ids:
        ph = ','.join('%s' for _ in song_ids)
        valid = {r['id'] for r in conn.execute(f'SELECT "id" FROM songs WHERE "id" IN ({ph})', song_ids).fetchall()}
        song_ids = [i for i in song_ids if i in valid]

    existing = {r['songId'] for r in conn.execute(
        'SELECT "songId" FROM eventSongs WHERE "eventId"=%s', (event_id,)).fetchall()}
    wanted = set(song_ids)
    removed = existing - wanted
    if removed:
        ph = ','.join('%s' for _ in removed)
        conn.execute(f'DELETE FROM eventSongs WHERE "eventId"=%s AND "songId" IN ({ph})', [event_id, *removed])
        conn.execute(f'DELETE FROM eventLineups WHERE "eventId"=%s AND "songId" IN ({ph})', [event_id, *removed])

    att = _attendees(conn, event_id, event['date'])
    songs = _song_map(conn) if (wanted - existing) else {}
    for order, song_id in enumerate(song_ids):
        conn.execute(
            'INSERT INTO eventSongs ("eventId","songId","order") VALUES (%s,%s,%s) '
            'ON CONFLICT ("eventId","songId") DO UPDATE SET "order"=EXCLUDED."order"',
            (event_id, song_id, order),
        )
        if song_id in existing:
            continue
        for sess in songs.get(song_id, {}).get('sessions', {}).values():
            for n in sess['supports']:
                if n in att:
                    conn.execute(
                        'INSERT INTO eventLineups ("eventId","songId","role","nickname") '
                        'VALUES (%s,%s,%s,%s) ON CONFLICT DO NOTHING',
                        (event_id, song_id, sess['role'], n),
                    )
    conn.commit()
    row = conn.execute('SELECT * FROM events WHERE "id"=%s', (event_id,)).fetchone()
    result = serialize_event(conn, row)
    conn.close()
    return result


@router.post('/{event_id}/songs/{song_id}/lineup')
def toggle_lineup(event_id: int, song_id: int, body: dict):
    """라인업 한 칸. 지원 여부와 상관없이 그날 실제로 친 사람을 적는다.
    on(true/false)을 보내면 그 상태로 맞춘다 — 같은 요청을 두 번 보내도 결과가 같다(화면이 누르는 즉시
    칸을 바꾸고 보내기 때문). on 이 없으면 예전처럼 뒤집는다(배포 직후의 옛 화면용)."""
    role = (body.get('role') or '').strip()
    nickname = (body.get('nickname') or '').strip()
    if not role or not nickname:
        raise HTTPException(400, 'role과 nickname은 필수입니다.')
    conn = get_db()
    _load(conn, event_id)
    if not conn.execute(
        'SELECT 1 FROM eventSongs WHERE "eventId"=%s AND "songId"=%s', (event_id, song_id)
    ).fetchone():
        conn.close()
        raise HTTPException(400, '셋리스트에 없는 곡입니다.')
    want = body.get('on')
    cur = conn.execute(
        'DELETE FROM eventLineups WHERE "eventId"=%s AND "songId"=%s AND "role"=%s AND "nickname"=%s',
        (event_id, song_id, role, nickname),
    )
    on = want if isinstance(want, bool) else cur.rowcount == 0
    # 넣을 때는 표준 여섯 파트만 받는다. 전에는 파트를 글로 쳐 넣어 'D'·'EG'·'드럼' 이 섞였고
    # 순서도 어긋났다. 곡마다 붙인 별칭(니지카 등)은 sessions.label 이 맡는다 — 표시만 바꾼다.
    # 빼기는 막지 않는다. 예전에 약어로 들어간 줄도 지울 수 있어야 한다.
    if on and role not in PART_ROLES:
        conn.rollback()
        conn.close()
        raise HTTPException(400, f'파트는 {"·".join(PART_ROLES)} 중 하나입니다.')
    if on:
        conn.execute(
            'INSERT INTO eventLineups ("eventId","songId","role","nickname") VALUES (%s,%s,%s,%s)',
            (event_id, song_id, role, nickname),
        )
    conn.commit()
    conn.close()
    return {'on': on}
