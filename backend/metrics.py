"""전송량 계측. Neon 에서 받은 바이트와 브라우저로 보낸 바이트를 API 별로 센다.

Neon 무료 한도(월 5GB)를 사흘 만에 넘긴 적이 있다. 그때 원인을 코드와 컬럼 크기로만
추정해야 했다. 여유가 있는지는 추정이 아니라 센 값으로 판단한다.

  dbBytes   db.py 의 row_factory 가 행을 만들 때마다 더한다. 페이로드 기준 근사치다.
            실제 전선 바이트는 libpq(C) 안에 있어 파이썬에서 볼 수 없다.
            bytes 는 텍스트 형식에서 16진수로 오가므로 2배 + 2 로 센다.
  outBytes  main.py 의 미들웨어가 응답 본문을 센다. 서버가 내보낸 그대로(압축 전)다.
            WebSocket(악보 페어링)은 세지 않는다 — 작은 제어 메시지뿐이다.

요청 밖에서 일어난 DB 읽기는 이름을 따로 붙인다.
  (boot)        기동 때 init_db
  (background)  요청 문맥이 없는 스레드(악보 렌더 뒤처리 등)

재시작하면 메모리의 값은 사라진다. 그래서 한 시간이 넘어갈 때마다 지난 시간 요약을
로그로 한 줄 남긴다 — Render 로그에는 남는다.
"""
import contextvars
import threading
import time
from datetime import datetime, timezone

HOURS_KEPT = 48            # 시간당 구간 보관 개수
TOP_IN_LOG = 3             # 시간 요약 로그에 적을 API 수

_lock = threading.Lock()
_started = time.time()
_total = {'calls': 0, 'dbBytes': 0, 'outBytes': 0}
_routes = {}               # 'GET /api/songs' -> {'calls','dbBytes','outBytes'}
_hours = {}                # UTC 기준 시(epoch // 3600) -> {'calls','dbBytes','outBytes','routes':{}}
_last_hour = None


class Tally:
    """요청 하나(또는 기동 한 번)에서 쌓인 바이트."""
    __slots__ = ('db', 'out')

    def __init__(self):
        self.db = 0
        self.out = 0


# 스레드풀에서 도는 동기 엔드포인트에도 문맥이 복사되어 넘어간다.
# 복사되더라도 담긴 Tally 는 같은 객체라 거기서 더한 값이 미들웨어로 돌아온다.
_current = contextvars.ContextVar('metrics_tally', default=None)


def begin(tally):
    return _current.set(tally)


def end(token):
    _current.reset(token)


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


def _bucket(store, key):
    b = store.get(key)
    if b is None:
        b = store[key] = {'calls': 0, 'dbBytes': 0, 'outBytes': 0}
    return b


def _add(b, calls, db, out):
    b['calls'] += calls
    b['dbBytes'] += db
    b['outBytes'] += out


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
    print(f"[traffic] {_hour_label(h)} db={_mb(b['dbBytes'])} out={_mb(b['outBytes'])} "
          f"calls={b['calls']} | {tops}", flush=True)


def commit(name, tally=None, db=0, out=0, calls=1):
    global _last_hour
    if tally is not None:
        db, out = tally.db, tally.out
    h = int(time.time() // 3600)
    with _lock:
        if _last_hour is not None and h != _last_hour:
            _log_hour(_last_hour)
            for old in [k for k in _hours if k <= h - HOURS_KEPT]:
                del _hours[old]
        _last_hour = h
        _add(_total, calls, db, out)
        _add(_bucket(_routes, name), calls, db, out)
        hour = _hours.get(h)
        if hour is None:
            hour = _hours[h] = {'calls': 0, 'dbBytes': 0, 'outBytes': 0, 'routes': {}}
        _add(hour, calls, db, out)
        _add(_bucket(hour['routes'], name), calls, db, out)


class tagged:
    """요청 밖의 작업(기동 등)에 이름을 붙여 센다.  with metrics.tagged('(boot)'): ..."""

    def __init__(self, name):
        self.name = name
        self.tally = Tally()

    def __enter__(self):
        self.token = begin(self.tally)
        return self.tally

    def __exit__(self, *exc):
        end(self.token)
        commit(self.name, self.tally, calls=0)
        return False


def snapshot():
    with _lock:
        total = dict(_total)
        routes = [{'route': k, **v} for k, v in _routes.items()]
        hours = [{'hour': _hour_label(h), 'calls': b['calls'],
                  'dbBytes': b['dbBytes'], 'outBytes': b['outBytes']}
                 for h, b in sorted(_hours.items())]
    routes.sort(key=lambda r: r['dbBytes'], reverse=True)
    return {
        'since': datetime.fromtimestamp(_started, timezone.utc).isoformat(timespec='seconds'),
        'uptimeSec': int(time.time() - _started),
        'total': total,
        'routes': routes,
        'hours': hours,
    }
