"""전송량 계측. Neon 에서 받은 바이트와 브라우저로 보낸 바이트를 API 별로 센다.

Neon 무료 한도(월 5GB)를 사흘 만에 넘긴 적이 있다. 그때 원인을 코드와 컬럼 크기로만
추정해야 했다. 여유가 있는지는 추정이 아니라 센 값으로 판단한다.

  dbBytes   db.py 의 row_factory 가 행을 만들 때마다 더한다. 페이로드 기준 근사치다.
            실제 전선 바이트는 libpq(C) 안에 있어 파이썬에서 볼 수 없다.
            bytes 는 텍스트 형식에서 16진수로 오가므로 2배 + 2 로 센다.
  outBytes  main.py 의 미들웨어가 응답 본문을 센다. 서버가 내보낸 그대로(압축 전)다.
            WebSocket(악보 페어링)은 세지 않는다 — 작은 제어 메시지뿐이다.
  ms        요청이 들어와서 응답을 시작하기까지. 스레드풀에서 줄 선 시간은 들고,
            휴대폰까지 가는 네트워크 시간은 빠진다. 최근 SAMPLES_KEPT 건으로 p50·p95 를 낸다.
  dbMs      그 요청 동안 Neon 연결·쿼리·커밋에 걸린 시간의 합(db.py 가 잰다).
            ms 에서 dbMs 를 빼면 서버 CPU(조립·직렬화)와 대기 시간이 남는다.
  inFlight  동시에 처리 중인 요청 수. 0.1 CPU 에서 요청이 줄을 서는지 본다.

  awake     Neon 이 켜져 있었을 시간의 추정. get_db() 가 연결을 연 분(minute)마다 어느 API 였는지
            적어 두고(dbMinutes), 연 뒤 NEON_SUSPEND_MIN 분은 켜져 있다고 본다.
            실제 값은 Neon API 의 active_time_seconds 다(bb26-backup 의 collect 가 모은다).
            이 추정은 그 실제 값을 API 별로 나누는 데 쓴다. 우리 서버 밖(run.bat, 백업)은 안 보인다.
  awakeSavedMin  그 API 가 DB 를 건드리지 않았다면 Neon 이 덜 켜졌을 분. 기록된 분 지도로 계산한다.
  kinds     응답 종류별 개수·바이트(그림 / JSON / JSON.gz / HTML / CSS·JS / 304 ...).
            Render 는 Cloudflare 가 압축한 뒤를 센다. 서버가 압축하지 않은 글자 응답은
            실제보다 크게 잡히므로, 종류를 나눠 Render API 의 실제 값과 맞대어 본다.
  clients   /api 가 아닌 요청(정적 파일·HTML)을 누가 보냈나. 봇은 이름을, 브라우저는
            mobile/desktop 만 남긴다. IP 는 남기지 않는다.
  counters  그 밖에 센 것(그림을 메모리에서 줬나 DB 에서 읽었나 등).

요청 밖에서 일어난 DB 읽기는 이름을 따로 붙인다.
  (boot)        기동 때 init_db
  (background)  요청 문맥이 없는 스레드(악보 렌더 뒤처리 등)

재시작하면 메모리의 값은 사라진다. 그래서 한 시간이 넘어갈 때마다 지난 시간 요약을
로그로 한 줄 남기고, 지난 시간들을 /api/stats/hours 로 내준다 — collect 가 매시 받아 쌓는다.
"""
import contextvars
import math
import re
import threading
from collections import deque
import time
from datetime import datetime, timezone

from fastapi.requests import HTTPConnection

HOURS_KEPT = 48            # 시간당 구간 보관 개수
TOP_IN_LOG = 3             # 시간 요약 로그에 적을 API 수
SAMPLES_KEPT = 500         # 라우트마다 처리 시간 표본 수(p50·p95 계산용)
MAX_ROUTES = 200           # 라우트는 70개 남짓(메서드 포함). 틀을 못 만든 경로가 키로 새도 이 이상 늘지 않는다
NEON_SUSPEND_MIN = 5       # Neon 'Scale to 0 after'. 콘솔 Edit compute 의 값과 맞춘다
MINUTES_KEPT = HOURS_KEPT * 60
TOP_PER_HOUR = 30          # 시간마다 남길 정적 경로·요청자 가짓수. 넘치면 (other)

_lock = threading.Lock()
_started = time.time()
_total = {'calls': 0, 'dbBytes': 0, 'outBytes': 0, 'ms': 0.0, 'dbMs': 0.0}
_routes = {}               # 'GET /api/songs' -> {'calls','dbBytes','outBytes'}
_hours = {}                # UTC 기준 시(epoch // 3600) -> {'calls','dbBytes','outBytes','routes':{}}
_last_hour = None
_samples = {}              # 라우트 -> deque(최근 처리 시간 ms)
_in_flight = 0
_peak_in_flight = 0
_db_minutes = {}           # 분(epoch // 60) -> {라우트: 그 분에 DB 연결을 연 횟수}
_counters = {}             # 이름 -> 누적 횟수


class Tally:
    """요청 하나(또는 기동 한 번)에서 쌓인 바이트와, 그 요청이 걸린 라우트 틀.
    kind·client·path 는 응답이 시작될 때 main.py 의 TrafficMeter 가 채운다."""
    __slots__ = ('db', 'out', 'route', 'db_ms', 'kind', 'client', 'path')

    def __init__(self):
        self.db = 0
        self.out = 0
        self.route = None
        self.db_ms = 0.0
        self.kind = None
        self.client = None
        self.path = None


# 스레드풀에서 도는 동기 엔드포인트에도 문맥이 복사되어 넘어간다.
# 복사되더라도 담긴 Tally 는 같은 객체라 거기서 더한 값이 미들웨어로 돌아온다.
_current = contextvars.ContextVar('metrics_tally', default=None)


def begin(tally):
    return _current.set(tally)


def end(token):
    _current.reset(token)


async def tag_route(conn: HTTPConnection):
    """앱 전역 의존성. 라우트 안에서 돌기 때문에 그 요청의 경로 변수(path_params)를 안다.

    미들웨어에서 scope['route'].path 를 읽으면 안 된다. FastAPI 0.115 는 바깥 scope 에
    '/api/songs/{song_id}' 를 남겨 주지만, 0.141 은 include_router 로 붙인 라우트를 감싸서
    처리해 바깥에는 감싼 쪽만 남고, 안쪽 route.path 에는 prefix 가 빠진 '/{song_id}' 만 있다.
    실제로 운영(최신판)에서 API 가 전부 (unmatched) 로 잡혔다.
    그래서 판마다 다른 route 객체 대신, 두 판 모두 주는 실제 경로와 path_params 로 틀을 만든다.
    async 로 둔다 — 동기 의존성은 스레드풀로 넘어가 굳이 한 번 더 옮겨 탈 이유가 없다.
    Request 대신 HTTPConnection 을 받는다 — 전역 의존성은 WebSocket(악보 페어링)에도 걸린다."""
    tally = _current.get()
    if tally is not None:
        tally.route = f"{conn.scope.get('method', 'WS')} {route_template(conn.url.path, conn.path_params)}"


def route_template(path, params):
    """'/api/songs/12/thumb', {'song_id': 12} -> '/api/songs/{song_id}/thumb'.

    params 는 경로에 나오는 순서를 따른다. 뒤의 변수부터, 앞 변수가 차지할 수 없는 오른쪽에서
    찾아 바꾼다. 그래서 '/api/guilds/3/members/3' 처럼 값이 같아도 자리가 맞게 들어간다."""
    end = len(path)
    for name, value in reversed(list(params.items())):
        v = str(value)
        if not v:
            continue
        at = path.rfind('/' + v, 0, end)
        while at >= 0 and at + 1 + len(v) < len(path) and path[at + 1 + len(v)] != '/':
            at = path.rfind('/' + v, 0, at)      # '/12' 가 '/123' 의 앞부분인 경우는 건너뛴다
        if at < 0:
            continue
        path = path[:at + 1] + '{' + name + '}' + path[at + 1 + len(v):]
        end = at
    return path


def row_size(values):
    """행 하나가 전선에서 차지하는 대략의 바이트. 필드마다 길이 4바이트, 행마다 7바이트."""
    n = 7
    for v in values:
        n += 4
        if v is None:
            continue
        if isinstance(v, (bytes, bytearray, memoryview)):
            n += 2 * len(v) + 2
        elif isinstance(v, str):
            n += len(v.encode('utf-8'))
        else:
            n += len(str(v))
    return n


def add_db(n):
    tally = _current.get()
    if tally is not None:
        tally.db += n
    else:
        commit('(background)', db=n, calls=0)


def add_db_time(seconds):
    """DB 연결·쿼리·커밋에 걸린 시간. 요청 밖(기동·뒤처리)의 것은 버린다 — 누가 기다린 시간이 아니다."""
    tally = _current.get()
    if tally is not None:
        tally.db_ms += seconds * 1000


def touch_db():
    """db.get_db() 가 연결을 열 때 부른다. 이 순간 Neon 이 깨어 있어야 한다(꺼져 있었으면 깨운다)."""
    tally = _current.get()
    name = tally.route if tally is not None and tally.route else '(background)'
    m = int(time.time() // 60)
    with _lock:
        b = _db_minutes.get(m)
        if b is None:
            b = _db_minutes[m] = {}
            for old in [k for k in _db_minutes if k <= m - MINUTES_KEPT]:
                del _db_minutes[old]
        b[name] = b.get(name, 0) + 1


def count(name, n=1):
    """그 밖에 셀 것. 시간 구간과 누적에 함께 더한다.  metrics.count('image.thumb.memory')"""
    h = int(time.time() // 3600)
    with _lock:
        _counters[name] = _counters.get(name, 0) + n
        c = _hour_bucket(h)['counters']
        c[name] = c.get(name, 0) + n


def response_kind(status, content_type, content_encoding):
    """응답 하나의 종류. Render 전송량을 종류별로 나눠 보려고 쓴다."""
    if status == 304:
        return '304'
    if status >= 400:
        return 'error'
    ct = (content_type or '').split(';')[0].strip().lower()
    if ct.startswith('image/'):
        kind = 'image'
    elif ct == 'application/json':
        kind = 'json'
    elif ct == 'text/html':
        kind = 'html'
    elif ct in ('text/css', 'text/javascript', 'application/javascript'):
        kind = 'asset'
    elif ct == 'application/pdf':
        kind = 'pdf'
    elif not ct:
        kind = 'empty'
    else:
        kind = 'other'
    return f'{kind}.{content_encoding}' if content_encoding else kind


# 봇·도구는 User-Agent 에 이름을 밝힌다. 그 이름만 남긴다. 브라우저는 mobile/desktop 만.
_BOT = re.compile(r'([\w.-]*(?:bot|crawl|spider|monitor|uptime|check|preview|fetch|scan|externalhit|scrap)[\w.-]*)', re.I)
_TOOL = re.compile(r'^(curl|wget|python-requests|python-urllib|go-http-client|okhttp|axios|node-fetch'
                   r'|java|libwww-perl|httpx|aiohttp)\b', re.I)


def client_of(user_agent):
    ua = (user_agent or '').strip()
    if not ua:
        return '(no user-agent)'
    tool = _TOOL.match(ua)
    if tool:
        return 'tool:' + tool.group(1).lower()
    bot = _BOT.search(ua)
    if bot:
        return 'bot:' + bot.group(1)[:40]
    if 'Mozilla/' in ua:
        return 'browser:mobile' if re.search(r'Mobile|Android|iPhone|iPad', ua) else 'browser:desktop'
    return 'other:' + ua[:40]


def _tick(store, key, out):
    """시간마다 가짓수를 TOP_PER_HOUR 로 묶어 둔 칸에 더한다. 호출하는 쪽이 락을 쥐고 있다."""
    if key not in store and len(store) >= TOP_PER_HOUR:
        key = '(other)'
    b = store.get(key)
    if b is None:
        b = store[key] = {'calls': 0, 'outBytes': 0}
    b['calls'] += 1
    b['outBytes'] += out


def enter():
    global _in_flight, _peak_in_flight
    with _lock:
        _in_flight += 1
        _peak_in_flight = max(_peak_in_flight, _in_flight)
        hour = _hour_bucket(int(time.time() // 3600))
        hour['peakInFlight'] = max(hour['peakInFlight'], _in_flight)


def leave():
    global _in_flight
    with _lock:
        _in_flight -= 1


def _bucket(store, key):
    b = store.get(key)
    if b is None:
        b = store[key] = {'calls': 0, 'dbBytes': 0, 'outBytes': 0, 'ms': 0.0, 'dbMs': 0.0, 'n304': 0}
    return b


def _hour_bucket(h):
    """호출하는 쪽이 락을 쥐고 있다."""
    b = _hours.get(h)
    if b is None:
        b = _hours[h] = {'calls': 0, 'dbBytes': 0, 'outBytes': 0, 'ms': 0.0, 'dbMs': 0.0,
                         'maxMs': 0.0, 'peakInFlight': 0, 'routes': {},
                         'kinds': {}, 'paths': {}, 'clients': {}, 'counters': {}}
    return b


def _awake(minutes):
    """DB 연결을 연 분들 -> Neon 이 켜져 있었을 분의 집합(연 분부터 NEON_SUSPEND_MIN 분)."""
    on = set()
    for m in minutes:
        on.update(range(m, m + NEON_SUSPEND_MIN))
    return on


def _awake_in_hour(on, h):
    start = h * 60
    return sum(1 for m in on if start <= m < start + 60)


def _add(b, calls, db, out, ms=0.0, db_ms=0.0):
    b['calls'] += calls
    b['dbBytes'] += db
    b['outBytes'] += out
    b['ms'] += ms
    b['dbMs'] += db_ms


def _pct(values, p):
    """정렬된 목록의 p 백분위(최근접 순위). 표본이 없으면 None."""
    if not values:
        return None
    k = max(0, min(len(values) - 1, math.ceil(p / 100 * len(values)) - 1))
    return round(values[k], 1)


def _hour_label(h):
    return datetime.fromtimestamp(h * 3600, timezone.utc).strftime('%Y-%m-%dT%HZ')


def _mb(n):
    return f'{n / 1_000_000:.2f}MB'


def _log_hour(h):
    """지난 한 시간 요약. 호출하는 쪽이 락을 쥐고 있다."""
    b = _hours.get(h)
    if not b:
        return
    top = sorted(b['routes'].items(), key=lambda kv: kv[1]['dbBytes'], reverse=True)[:TOP_IN_LOG]
    tops = ', '.join(f"{k} db={_mb(v['dbBytes'])} out={_mb(v['outBytes'])}" for k, v in top)
    awake = _awake_in_hour(_awake(m for m in _db_minutes if h * 60 - NEON_SUSPEND_MIN < m < h * 60 + 60), h)
    print(f"[traffic] {_hour_label(h)} db={_mb(b['dbBytes'])} out={_mb(b['outBytes'])} "
          f"calls={b['calls']} awake={awake}m maxMs={b['maxMs']:.0f} peak={b['peakInFlight']} | {tops}",
          flush=True)


def commit(name, tally=None, db=0, out=0, calls=1, ms=None):
    """ms 는 요청 처리 시간. 요청이 아닌 것(기동·뒤처리)은 None 이라 시간 통계에 넣지 않는다."""
    global _last_hour
    db_ms = 0.0
    kind = client = path = None
    if tally is not None:
        db, out, db_ms = tally.db, tally.out, tally.db_ms
        kind, client, path = tally.kind, tally.client, tally.path
    h = int(time.time() // 3600)
    with _lock:
        if name not in _routes and len(_routes) >= MAX_ROUTES:
            name = '(other)'
        if _last_hour is not None and h != _last_hour:
            _log_hour(_last_hour)
            for old in [k for k in _hours if k <= h - HOURS_KEPT]:
                del _hours[old]
        _last_hour = h
        spent = ms or 0.0
        _add(_total, calls, db, out, spent, db_ms)
        _add(_bucket(_routes, name), calls, db, out, spent, db_ms)
        hour = _hour_bucket(h)
        _add(hour, calls, db, out, spent, db_ms)
        _add(_bucket(hour['routes'], name), calls, db, out, spent, db_ms)
        if kind is not None:
            _tick(hour['kinds'], kind, out)
            if kind == '304':
                _routes[name]['n304'] += 1
                hour['routes'][name]['n304'] += 1
        if client is not None:
            _tick(hour['clients'], client, out)
        if path is not None:
            _tick(hour['paths'], path, out)
        if ms is not None:
            hour['maxMs'] = max(hour['maxMs'], ms)
            ring = _samples.get(name)
            if ring is None:
                ring = _samples[name] = deque(maxlen=SAMPLES_KEPT)
            ring.append(ms)


class tagged:
    """요청 밖의 작업(기동 등)에 이름을 붙여 센다.  with metrics.tagged('(boot)'): ..."""

    def __init__(self, name):
        self.name = name
        self.tally = Tally()
        self.tally.route = name          # DB 사용 지도(touch_db)에도 이 이름으로 적힌다

    def __enter__(self):
        self.token = begin(self.tally)
        return self.tally

    def __exit__(self, *exc):
        end(self.token)
        commit(self.name, self.tally, calls=0)
        return False


def _timing(b, ring):
    """누적 합과 표본으로 사람이 읽을 값을 만든다. ms·dbMs 합계는 평균으로 바꿔 내보낸다."""
    calls = b['calls']
    out = {k: b[k] for k in ('calls', 'dbBytes', 'outBytes', 'n304') if k in b}
    out['avgMs'] = round(b['ms'] / calls, 1) if calls else None
    out['avgDbMs'] = round(b['dbMs'] / calls, 1) if calls else None
    ordered = sorted(ring) if ring else []
    out['p50Ms'] = _pct(ordered, 50)
    out['p95Ms'] = _pct(ordered, 95)
    out['maxMs'] = round(ordered[-1], 1) if ordered else None
    return out


def _top(store, n=10):
    return dict(sorted(store.items(), key=lambda kv: kv[1]['calls'], reverse=True)[:n])


def _saved_by_route(minutes):
    """라우트마다: 그 라우트가 DB 를 건드리지 않았다면 Neon 이 덜 켜졌을 분.
    다른 라우트가 같은 때 깨워 두었으면 아낄 게 없으므로 0 에 가깝다. 기록된 분 지도로만 센다."""
    on = _awake(minutes)
    names = {r for v in minutes.values() for r in v}
    saved = {}
    for r in names:
        rest = [m for m, v in minutes.items() if any(k != r for k in v)]
        saved[r] = len(on) - len(_awake(rest))
    return len(on), saved


def snapshot():
    with _lock:
        total = _timing(_total, None)
        routes = [{'route': k, **_timing(v, _samples.get(k))} for k, v in _routes.items()]
        minutes = {m: dict(v) for m, v in _db_minutes.items()}
        hour_items = sorted(_hours.items())
        hours = [{'hour': _hour_label(h), **_timing(b, None), 'maxMs': round(b['maxMs'], 1),
                  'peakInFlight': b['peakInFlight'], 'kinds': dict(b['kinds']),
                  'clients': _top(b['clients']), 'counters': dict(b['counters'])}
                 for h, b in hour_items]
        in_flight = {'now': _in_flight, 'peak': _peak_in_flight}
        counters = dict(_counters)
    awake_total, saved = _saved_by_route(minutes)
    on = _awake(minutes)
    for row, (h, _) in zip(hours, hour_items):
        row['awakeMin'] = _awake_in_hour(on, h)
    for r in routes:
        r['awakeSavedMin'] = saved.get(r['route'], 0)
    routes.sort(key=lambda r: r['dbBytes'], reverse=True)
    return {
        'since': datetime.fromtimestamp(_started, timezone.utc).isoformat(timespec='seconds'),
        'uptimeSec': int(time.time() - _started),
        'inFlight': in_flight,
        'neon': {'suspendMin': NEON_SUSPEND_MIN, 'awakeMin': awake_total,
                 'windowMin': (max(minutes) - min(minutes) + 1) if minutes else 0},
        'total': total,
        'counters': counters,
        'routes': routes,
        'hours': hours,
    }


def hours_since(since_label=None):
    """다 지난 시간 구간들을 통째로 준다(지금 진행 중인 시간은 뺀다). collect 가 매시 받아 쌓는다.
    since_label('2026-10-02T07Z') 를 주면 그 뒤 시간만. 재시작하면 그 전 시간은 없다."""
    now_h = int(time.time() // 3600)
    after = None
    if since_label:
        try:
            after = int(datetime.strptime(since_label, '%Y-%m-%dT%HZ')
                        .replace(tzinfo=timezone.utc).timestamp() // 3600)
        except ValueError:
            after = None
    with _lock:
        picked = [(h, b) for h, b in sorted(_hours.items()) if h < now_h and (after is None or h > after)]
        minutes = {m: dict(v) for m, v in _db_minutes.items()}
        out = []
        for h, b in picked:
            out.append({
                'hour': _hour_label(h),
                **_timing(b, None), 'maxMs': round(b['maxMs'], 1), 'peakInFlight': b['peakInFlight'],
                'routes': {k: _timing(v, None) for k, v in b['routes'].items()},
                'kinds': dict(b['kinds']), 'clients': dict(b['clients']), 'paths': dict(b['paths']),
                'counters': dict(b['counters']),
            })
    on = _awake(minutes)
    for row, (h, _) in zip(out, picked):
        row['awakeMin'] = _awake_in_hour(on, h)
        # 그 시간의 분 지도. 키는 시 안의 분(0~59). 어느 API 묶음이든 나중에 다시 계산할 수 있게 원자료로 둔다.
        row['dbMinutes'] = {str(m - h * 60): v for m, v in sorted(minutes.items()) if h * 60 <= m < h * 60 + 60}
    return {'since': datetime.fromtimestamp(_started, timezone.utc).isoformat(timespec='seconds'),
            'suspendMin': NEON_SUSPEND_MIN, 'hours': out}
