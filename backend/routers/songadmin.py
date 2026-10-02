"""관리 탭의 '곡 정리'. 몰아서 하는 정리 작업 — 제목 확인 표시, 같은 곡 쌍 찾기, 두 곡 병합.

전부 관리자(파딱·핑딱·root)만 쓴다(사용자 결정, 2026-10-02). 한 곡씩 고치는 일(제목·번역·이전·삭제)은
곡 정보 창이 하고, 여기서는 같은 API 를 여러 번 부를 뿐이다. 새로 생긴 것은 아래뿐이다.

  cleanup     정리용 목록. 공개 목록(/api/songs)에 없는 titleCheckedAt 과 곡별 기록 수를 싣는다.
  checked     '제목 확인함' 표시. 한글 원제가 맞는 곡(진짜 한국 곡)이 정리 목록에 계속 남지 않게.
  duplicates  songmatch 가 같은 곡이라 보는 쌍. 2026-10-02 기준 39쌍.
  merge       drop 곡의 지원·댓글·셋리스트·합주 기록을 keep 곡으로 모으고 drop 을 지운다. 한 트랜잭션.

병합은 되돌리기 어렵다. 화면이 먼저 impact(옮겨지는 건수)를 보여 주고 확인을 받는다.
"""
import itertools

from fastapi import APIRouter, HTTPException, Request

import admin
import imageserve
import songmatch
import thumbs
from db import get_db
from helpers import attach_guilds

router = APIRouter()

_BRIEF = ('SELECT s."id", s."title", s."titleKo", s."artist", s."youtubeUrl", s."thumbVideoId", s."guildId", '
          's."tags", s."createdBy", s."createdAt", s."titleCheckedAt", '
          '(SELECT count(*) FROM sessionSupports sp JOIN sessions se ON se."id"=sp."sessionId" '
          ' WHERE se."songId"=s."id") AS "supports", '
          '(SELECT count(*) FROM songComments c WHERE c."songId"=s."id") AS "comments", '
          '(SELECT count(*) FROM eventSongs e WHERE e."songId"=s."id") AS "setlists", '
          '(SELECT count(*) FROM eventLineups l WHERE l."songId"=s."id") AS "lineups", '
          '(SELECT count(*) FROM sessionHistories h WHERE h."songId"=s."id") AS "histories" '
          'FROM songs s')


def _rows(conn, where='', args=()):
    rows = [dict(r) for r in conn.execute(f'{_BRIEF}{where} ORDER BY s."id"', args).fetchall()]
    for r in rows:
        vid = r['thumbVideoId'] or thumbs.video_id(r['youtubeUrl'])
        r['thumbUrl'] = imageserve.thumb_url(r['id'], vid) if vid else None
    return attach_guilds(conn, rows)


@router.get('/songs/cleanup')
def cleanup_list(request: Request):
    conn = get_db()
    try:
        admin.require(conn, request)
        return _rows(conn)
    finally:
        conn.close()


@router.post('/songs/{song_id}/checked')
def mark_checked(song_id: int, body: dict, request: Request):
    """제목을 확인했다(또는 취소). 제목 자체는 PUT /api/songs/{id} 로 고친다 — 중복 규칙이 거기 있다."""
    conn = get_db()
    try:
        admin.require(conn, request)
        on = bool(body.get('checked', True))
        cur = conn.execute(f'UPDATE songs SET "titleCheckedAt"={"now()" if on else "NULL"} WHERE "id"=%s',
                           (song_id,))
        if cur.rowcount == 0:
            raise HTTPException(404, '곡을 찾을 수 없습니다.')
        conn.commit()
        return {'id': song_id, 'checked': on}
    finally:
        conn.close()


def duplicate_pairs(rows):
    """같은 곡일 수 있는 쌍. 열쇠(영상·이름)가 겹치는 곡끼리만 비교해 296곡도 금방 끝난다."""
    by_key = {}
    for r in rows:
        vid = r.get('thumbVideoId') or thumbs.video_id(r.get('youtubeUrl'))
        keys = [('v', vid)] if vid else []
        keys += [('n', n) for n in songmatch.names(r.get('title'), r.get('titleKo'))[1]]
        for k in keys:
            by_key.setdefault(k, []).append(r)
    seen = set()
    pairs = []
    for group in by_key.values():
        for a, b in itertools.combinations(group, 2):
            key = (min(a['id'], b['id']), max(a['id'], b['id']))
            if key in seen:
                continue
            seen.add(key)
            why = songmatch.reasons(a, b)
            if why:
                pairs.append({'a': a if a['id'] < b['id'] else b, 'b': b if a['id'] < b['id'] else a,
                              'reasons': why})
    pairs.sort(key=lambda p: (p['a']['id'], p['b']['id']))
    return pairs


@router.get('/songs/duplicates')
def duplicates(request: Request):
    conn = get_db()
    try:
        admin.require(conn, request)
        return duplicate_pairs(_rows(conn))
    finally:
        conn.close()


def _pair(conn, keep, drop):
    if keep == drop:
        raise HTTPException(400, '같은 곡끼리는 병합할 수 없습니다.')
    found = {r['id']: r for r in conn.execute('SELECT "id","titleKo","guildId" FROM songs WHERE "id" IN (%s,%s)',
                                              (keep, drop)).fetchall()}
    if keep not in found or drop not in found:
        raise HTTPException(404, '곡을 찾을 수 없습니다.')
    return found[keep], found[drop]


def _impact(conn, keep, drop):
    """drop 에서 keep 으로 옮겨지는 것과, 겹쳐서 하나로 합쳐지는(사라지는) 것의 건수."""
    one = lambda sql: conn.execute(sql, {'k': keep, 'd': drop}).fetchone()['n']
    return [
        {'label': '파트 지원', 'move': one(
            'SELECT count(*) n FROM sessionSupports sp JOIN sessions se ON se."id"=sp."sessionId" '
            'WHERE se."songId"=%(d)s AND NOT EXISTS (SELECT 1 FROM sessions k JOIN sessionSupports ks '
            'ON ks."sessionId"=k."id" WHERE k."songId"=%(k)s AND k."role"=se."role" AND ks."nickname"=sp."nickname")'),
         'merged': one(
            'SELECT count(*) n FROM sessionSupports sp JOIN sessions se ON se."id"=sp."sessionId" '
            'WHERE se."songId"=%(d)s AND EXISTS (SELECT 1 FROM sessions k JOIN sessionSupports ks '
            'ON ks."sessionId"=k."id" WHERE k."songId"=%(k)s AND k."role"=se."role" AND ks."nickname"=sp."nickname")')},
        {'label': '한마디', 'move': one('SELECT count(*) n FROM songComments WHERE "songId"=%(d)s'), 'merged': 0},
        {'label': '합주 기록', 'move': one('SELECT count(*) n FROM sessionHistories WHERE "songId"=%(d)s'), 'merged': 0},
        {'label': '셋리스트', 'move': one(
            'SELECT count(*) n FROM eventSongs e WHERE e."songId"=%(d)s AND NOT EXISTS '
            '(SELECT 1 FROM eventSongs x WHERE x."eventId"=e."eventId" AND x."songId"=%(k)s)'),
         'merged': one(
            'SELECT count(*) n FROM eventSongs e WHERE e."songId"=%(d)s AND EXISTS '
            '(SELECT 1 FROM eventSongs x WHERE x."eventId"=e."eventId" AND x."songId"=%(k)s)')},
        {'label': '그날 라인업', 'move': one(
            'SELECT count(*) n FROM eventLineups l WHERE l."songId"=%(d)s AND NOT EXISTS '
            '(SELECT 1 FROM eventLineups x WHERE x."eventId"=l."eventId" AND x."songId"=%(k)s '
            'AND x."role"=l."role" AND x."nickname"=l."nickname")'),
         'merged': one(
            'SELECT count(*) n FROM eventLineups l WHERE l."songId"=%(d)s AND EXISTS '
            '(SELECT 1 FROM eventLineups x WHERE x."eventId"=l."eventId" AND x."songId"=%(k)s '
            'AND x."role"=l."role" AND x."nickname"=l."nickname")')},
    ]


@router.get('/songs/merge/impact')
def merge_impact(keep: int, drop: int, request: Request):
    conn = get_db()
    try:
        admin.require(conn, request)
        _pair(conn, keep, drop)
        return {'keep': keep, 'drop': drop, 'counts': _impact(conn, keep, drop)}
    finally:
        conn.close()


@router.post('/songs/merge')
def merge(body: dict, request: Request):
    """drop 을 keep 에 합친다. 한 트랜잭션이라 중간에 실패하면 아무것도 바뀌지 않는다.

    파트는 역할(보컬·일렉1…)이 같은 자리끼리 합친다. 같은 사람이 양쪽에 있으면 하나만 남는다.
    drop 에서만 켜져 있던 자리는 keep 에서도 켠다(그 자리에 지원자가 있었을 수 있다).
    keep 에 없는 역할의 자리는 통째로 keep 으로 옮긴다. 소속·제목·주소·태그는 keep 의 것을 쓰고,
    번역만 keep 이 비어 있으면 drop 의 것을 가져온다. 끝나면 drop 을 지운다(남은 것은 CASCADE)."""
    try:
        keep, drop = int(body.get('keep')), int(body.get('drop'))
    except (TypeError, ValueError):
        raise HTTPException(400, 'keep·drop 이 올바르지 않습니다.')
    conn = get_db()
    try:
        admin.require(conn, request)
        k, d = _pair(conn, keep, drop)
        args = {'k': keep, 'd': drop}
        keep_roles = {r['role']: r['id'] for r in conn.execute(
            'SELECT "id","role" FROM sessions WHERE "songId"=%(k)s', args).fetchall()}
        for s in conn.execute('SELECT "id","role","active" FROM sessions WHERE "songId"=%(d)s', args).fetchall():
            target = keep_roles.get(s['role'])
            if target is None:
                conn.execute('UPDATE sessions SET "songId"=%s WHERE "id"=%s', (keep, s['id']))
                keep_roles[s['role']] = s['id']
                continue
            conn.execute(
                'INSERT INTO sessionSupports ("sessionId","nickname","label","createdAt") '
                'SELECT %s, "nickname", "label", "createdAt" FROM sessionSupports WHERE "sessionId"=%s '
                'ON CONFLICT ("sessionId","nickname") DO NOTHING', (target, s['id']))
            if s['active']:
                conn.execute('UPDATE sessions SET "active"=true WHERE "id"=%s', (target,))
        conn.execute('UPDATE songComments SET "songId"=%(k)s WHERE "songId"=%(d)s', args)
        conn.execute('UPDATE sessionHistories SET "songId"=%(k)s WHERE "songId"=%(d)s', args)
        conn.execute(
            'INSERT INTO eventSongs ("eventId","songId","order","note","createdAt") '
            'SELECT "eventId", %(k)s, "order", "note", "createdAt" FROM eventSongs WHERE "songId"=%(d)s '
            'ON CONFLICT ("eventId","songId") DO NOTHING', args)
        conn.execute(
            'INSERT INTO eventLineups ("eventId","songId","role","nickname","createdAt") '
            'SELECT "eventId", %(k)s, "role", "nickname", "createdAt" FROM eventLineups WHERE "songId"=%(d)s '
            'ON CONFLICT ("eventId","songId","role","nickname") DO NOTHING', args)
        if not k['titleKo'] and d['titleKo']:
            conn.execute('UPDATE songs SET "titleKo"=%s WHERE "id"=%s', (d['titleKo'], keep))
        conn.execute('UPDATE songs SET "updatedAt"=now() WHERE "id"=%(k)s', args)
        conn.execute('DELETE FROM songs WHERE "id"=%(d)s', args)
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
    imageserve.forget('thumb', drop)
    return {'ok': True, 'keep': keep, 'drop': drop}
