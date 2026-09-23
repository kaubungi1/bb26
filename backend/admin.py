"""관리 권한. 누가 멤버·길드를 지우고 딱지를 붙일 수 있는가를 여기 한 곳에서 정한다.

사이트에는 로그인이 없다. 신원은 브라우저에 적힌 닉네임뿐이고, 그건 그대로 둔다.
관리 권한만 세 단계로 나눈다.

  root   닉네임 창에 ADMIN_NICK 을 넣고 비밀번호까지 맞힌 사람. 쿠키로 30일 유지된다. 무엇이든 한다.
         모든 신뢰의 뿌리다 — 딱지가 엉켜도 여기서 되돌린다.
  blue   파딱(방장). 닉네임 기준. 멤버·길드 삭제, 핑딱 지정·해제, 파딱 위임.
  pink   핑딱(부방장). 닉네임 기준. 멤버·길드 삭제.

파딱·핑딱은 닉네임만 맞으면 권한이 선다. 이름을 사칭하면 뚫린다는 뜻이고,
사용자가 그 위험을 알고 받아들였다(2026-09-23). 그래서 root 는 비밀번호로 따로 둔다.

비밀번호는 코드에 그대로 둔다. 공개돼도 상관없다는 것이 사용자 판단이다(2026-09-23) —
지키려는 것은 실수로 누르는 삭제이지 공격이 아니다. 바꿀 때는 아래 한 줄만 고친다.

자기보다 낮은 딱지에게만 손댈 수 있다. 핑딱이 방장을 지우거나 다른 핑딱을 지울 수 없다.
"""
import hashlib
import hmac
import threading
import time
from urllib.parse import unquote

from fastapi import HTTPException, Request, Response

ADMIN_NICK = '불법이륙'
ADMIN_PASSWORD = 'bb26'

COOKIE = 'bb_admin'
SESSION_SECONDS = 30 * 24 * 3600
MAX_FAILS = 5
LOCK_SECONDS = 10 * 60

# 딱지의 높낮이. 없는 딱지는 0.
RANK = {'root': 3, 'blue': 2, 'pink': 1}
BADGES = ('blue', 'pink')

_lock = threading.Lock()
_fails = 0
_locked_until = 0.0


def _key():
    """쿠키 서명 열쇠. 비밀번호에서 만든다 — 비밀번호를 바꾸면 발급된 쿠키가 모두 무효가 된다."""
    return hashlib.sha256(b'bb26-admin-cookie:' + ADMIN_PASSWORD.encode()).digest()


def _sign(expires: int) -> str:
    mac = hmac.new(_key(), str(expires).encode(), hashlib.sha256).hexdigest()
    return f'{expires}.{mac}'


def _cookie_ok(value: str) -> bool:
    if not value:
        return False
    expires = value.partition('.')[0]
    if not expires.isdigit() or int(expires) < time.time():
        return False
    return hmac.compare_digest(_sign(int(expires)), value)


def login(password: str, request: Request, response: Response):
    """맞으면 쿠키를 건다. 5번 틀리면 10분 동안 아무 비밀번호도 받지 않는다.
    잠금은 전체에 하나다. 관리자는 한 사람이고, 프로세스도 하나다(main.py 의 메모리 캐시와 같은 전제)."""
    global _fails, _locked_until
    with _lock:
        now = time.time()
        if now < _locked_until:
            raise HTTPException(429, f'잠시 뒤에 다시 시도하세요. ({int(_locked_until - now) // 60 + 1}분)')
        if not hmac.compare_digest(password.encode(), ADMIN_PASSWORD.encode()):
            _fails += 1
            if _fails >= MAX_FAILS:
                _fails = 0
                _locked_until = now + LOCK_SECONDS
            raise HTTPException(401, '비밀번호가 틀렸습니다.')
        _fails = 0
    # 로컬(http://127.0.0.1)에서도 쓸 수 있게 https 일 때만 Secure 를 건다. Render 는 앞단이 https 다.
    secure = request.headers.get('x-forwarded-proto', request.url.scheme) == 'https'
    response.set_cookie(COOKIE, _sign(int(time.time()) + SESSION_SECONDS), max_age=SESSION_SECONDS,
                        httponly=True, secure=secure, samesite='strict', path='/api/admin')


def logout(response: Response):
    response.delete_cookie(COOKIE, path='/api/admin')


def nickname_of(request: Request) -> str:
    """화면이 X-Nickname 머리에 닉네임을 실어 보낸다. 한글이라 퍼센트 인코딩돼 있다."""
    return unquote(request.headers.get('x-nickname', '')).strip()


def badge_of(conn, nickname: str):
    if not nickname:
        return None
    row = conn.execute('SELECT "badge" FROM members WHERE "nickname"=%s', (nickname,)).fetchone()
    return row['badge'] if row else None


def role_of(conn, request: Request):
    """root > 닉네임의 딱지 > None."""
    if _cookie_ok(request.cookies.get(COOKIE, '')):
        return 'root'
    badge = badge_of(conn, nickname_of(request))
    return badge if badge in BADGES else None


def rank(role) -> int:
    return RANK.get(role, 0)


def require(conn, request: Request, at_least: str = 'pink'):
    """권한이 모자라면 403. 있으면 그 역할을 돌려준다."""
    role = role_of(conn, request)
    if rank(role) < RANK[at_least]:
        raise HTTPException(403, '권한이 없습니다.')
    return role


def require_above(role, target_badge):
    """자기보다 낮은 딱지에게만 손댄다. root 는 예외 없이 된다."""
    if role != 'root' and rank(target_badge) >= rank(role):
        raise HTTPException(403, '같거나 높은 딱지에게는 할 수 없습니다.')
