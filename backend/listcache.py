"""폴링되는 목록 응답(곡·일정·멤버·길드)을 DB 변경 번호로 캐시한다.

화면은 곡·일정을 5초, 멤버·길드를 15초마다 다시 받는다. 전에는 그때마다 목록 전체를 DB 에서
다시 읽고, 휴대폰은 바뀐 게 없어도 전부 다시 그렸다. 일정 탭 하나가 Neon 에서 시간당 약 144MB 를
읽었고(2026-09-23 실측), 곡 화면은 휴대폰에서 폴링마다 1~1.5초씩 다시 그렸다.

이제는 이렇게 한다.
  변경 번호   테이블마다 쓰기가 일어나면 트리거가 "changeLog" 에 한 줄을 더한다(db.py).
              앱의 쓰기든 손으로 친 SQL 이든 경로를 가리지 않는다.
              번호 = 테이블별 (줄 수, 가장 큰 id). 한 줄만 고치는 방식은 동시에 쓸 때 잠금이
              겹쳐 교착될 수 있고, 시퀀스는 커밋 전에 보여 옛 데이터를 새 번호로 캐시할 수 있어 쓰지 않는다.
  읽는 순서   번호를 먼저 읽고 그다음 데이터를 읽는다. 그 사이에 커밋이 끼면 새 데이터가 옛 번호로
              캐시될 뿐이고, 다음 요청에서 번호가 달라 다시 만든다. 반대 순서면 옛 데이터가 새 번호로 남는다.
  캐시        (목록, 쿼리) 마다 번호가 같으면 만들어 둔 응답 바이트를 그대로 준다. 여러 탭이 나눠 쓴다.
  304         브라우저가 같은 번호를 갖고 있으면 본문 없이 304 로 끝낸다. 화면은 다시 그리지 않는다.
  압축        만들 때 한 번만 gzip 한다. 요청마다 압축하면 0.1 CPU 에서 오히려 느려진다.

목록이 새로 의존하는 테이블이 생기면 아래 목록에 더해야 한다. 빠뜨리면 그 테이블이 바뀌어도 옛 목록이 나간다.
"""
import gzip
import hashlib
import threading

from fastapi import Request, Response
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse

from db import get_db

# 목록이 읽는 테이블. 트리거의 TG_TABLE_NAME 은 소문자다.
SONGS = ('songs', 'sessions', 'sessionsupports', 'events', 'eventsongs', 'guilds')
EVENTS = ('events', 'eventdates', 'eventavails', 'eventsongs', 'eventlineups', 'songs', 'guilds')
MEMBERS = ('members', 'guildmembers', 'guilds', 'sessions', 'sessionsupports', 'songs')
GUILDS = ('guilds', 'guildmembers')

PRUNE_OVER = 5000      # changeLog 가 이만큼 쌓이면 테이블마다 마지막 줄만 남긴다
GZIP_MIN = 1024
MAX_ENTRIES = 64       # (목록, 쿼리) 조합. 길드 필터가 슬러그마다 하나씩이다

_lock = threading.Lock()
_cache = {}            # (이름, 쿼리) -> (etag, raw, gz)


def _version(conn, tables):
    rows = conn.execute(
        'SELECT "tableName" t, count(*) c, max("id") m FROM "changeLog" '
        'WHERE "tableName" = ANY(%s) GROUP BY 1', (list(tables),),
    ).fetchall()
    sig = '|'.join(f"{r['t']}:{r['c']}:{r['m']}" for r in sorted(rows, key=lambda r: r['t']))
    return hashlib.sha1(sig.encode()).hexdigest()[:16], sum(r['c'] for r in rows)


def _prune(conn):
    """테이블마다 마지막 줄만 남긴다. 줄 수가 바뀌므로 목록이 한 번씩 다시 만들어진다(그뿐이다)."""
    conn.execute('DELETE FROM "changeLog" c WHERE c."id" < '
                 '(SELECT max(m."id") FROM "changeLog" m WHERE m."tableName" = c."tableName")')
    conn.commit()


def _same(etag, header):
    """If-None-Match 비교. W/ 는 떼고 본다 — 중간(Cloudflare)이 약한 ETag 로 바꿔 넘길 수 있다."""
    if not header:
        return False
    want = etag.removeprefix('W/')
    return any(t.strip().removeprefix('W/') == want for t in header.split(','))


def serve(request: Request, name, tables, build):
    """name: 목록 이름.  tables: 의존 테이블.  build(conn) -> 응답으로 보낼 파이썬 값."""
    key = (name, request.url.query)
    conn = get_db()
    try:
        version, total = _version(conn, tables)
        etag = f'W/"{name}-{version}"'
        headers = {'ETag': etag, 'Cache-Control': 'no-cache', 'Vary': 'Accept-Encoding'}
        if _same(etag, request.headers.get('if-none-match')):
            return Response(status_code=304, headers=headers)
        with _lock:
            hit = _cache.get(key)
        if hit is not None and hit[0] == etag:
            raw, gz = hit[1], hit[2]
        else:
            # FastAPI 가 dict 를 돌려줄 때와 같은 바이트가 되도록 같은 길로 직렬화한다.
            raw = JSONResponse(content=jsonable_encoder(build(conn))).body
            gz = gzip.compress(raw, 6) if len(raw) >= GZIP_MIN else None
            with _lock:
                if key not in _cache and len(_cache) >= MAX_ENTRIES:
                    _cache.pop(next(iter(_cache)))
                _cache[key] = (etag, raw, gz)
        if total > PRUNE_OVER:
            _prune(conn)
    finally:
        conn.close()
    if gz is not None and 'gzip' in request.headers.get('accept-encoding', ''):
        headers['Content-Encoding'] = 'gzip'
        return Response(content=gz, media_type='application/json', headers=headers)
    return Response(content=raw, media_type='application/json', headers=headers)


def stats():
    with _lock:
        return {'entries': len(_cache), 'bytes': sum(len(v[1]) for v in _cache.values())}
