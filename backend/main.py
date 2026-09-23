"""불법이륙 밴드 사이트 — 앱 생성, 라우터 등록, 정적 프론트 서빙만 여기서 한다.
API 는 routers/ 아래 역할별 파일에 있다."""
import os
import time

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

import metrics
from db import init_db
from guildtheme import theme_of
from routers import (comments, drawings, events, guilds, histories, home, members, pairs,
                     sessions, sheets, songs)
from routers import metrics as metrics_router

BASE_DIR = os.path.dirname(__file__)
FRONTEND_DIR = os.path.normpath(os.path.join(BASE_DIR, '..', 'frontend'))

init_db()

# 전역 의존성은 계측이 요청의 라우트 틀을 알아내는 자리다(metrics.tag_route 참고).
app = FastAPI(title='불법이륙 API', dependencies=[Depends(metrics.tag_route)])

# (모듈, prefix, 태그). 새 리소스는 여기 한 줄만 보태면 된다.
ROUTERS = [
    (songs, '/api/songs', '곡'),
    (comments, '/api/songs', '곡 한마디'),
    (sessions, '/api/sessions', '세션'),
    (histories, '/api/histories', '합주 이력'),
    (sheets, '/api/sheets', '악보'),
    (pairs, '', '페어링'),
    (events, '/api/events', '일정'),
    (guilds, '/api/guilds', '길드'),
    (drawings, '/api/guilds', '길드 낙서'),
    (members, '/api/members', '멤버'),
    (home, '/api/home', '홈'),
    (metrics_router, '/api/stats', '계측'),
]
for module, prefix, tag in ROUTERS:
    app.include_router(module.router, prefix=prefix, tags=[tag])


@app.get('/api/health')
def health():
    return {'status': 'ok'}


# ---------- 정적 프론트 ----------
@app.get('/')
def index():
    return FileResponse(os.path.join(FRONTEND_DIR, 'index.html'))


@app.get('/guild/{slug}')
def guild_root(slug: str):
    return RedirectResponse(f'/guild/{slug}/')


# ---------- 길드 테마를 첫 그림에 박아 보내기 ----------
# 전에는 화면이 밝은 테마로 한 번 그려진 뒤, common.js 가 /api/guilds/<slug> 응답을 받고서야
# 테마를 걸었다. 그래서 어두운 테마인 길드는 페이지를 옮길 때마다 흰 화면이 번쩍였다.
# HTML 에 data-theme 을 미리 박으면 그 왕복을 기다리지 않는다.
# 목록과 캐시는 guildtheme.py 에 있다 — 저장하는 쪽과 읽는 쪽이 같은 값을 봐야 한다.
def _html_with_theme(path: str, slug: str):
    """<html lang="ko"> 에 data-theme 을 끼워 넣는다. 테마가 없으면 파일 그대로 보낸다."""
    name = theme_of(slug)
    if not name:
        return FileResponse(path)
    with open(path, encoding='utf-8') as f:
        html = f.read()
    # 값은 THEMES 목록을 통과한 것이라 따옴표나 꺾쇠가 들어올 수 없다.
    html = html.replace('<html lang="ko">', f'<html lang="ko" data-theme="{name}">', 1)
    return HTMLResponse(html, headers={'Cache-Control': 'no-cache'})


@app.get('/guild/{slug}/{path:path}')
def guild_page(slug: str, path: str, request: Request):
    """길드 아래의 곡·일정은 같은 정적 페이지를 그대로 낸다.
    화면은 주소에서 slug 를 읽어 그 길드 것만 보여준다. 데이터는 하나, 얼굴만 여럿.

    다만 길드 첫 화면만은 자기 파일을 갖는다. 전에는 여기서도 메인(frontend/index.html)을
    내려줘서 길드 페이지라는 것이 따로 없었다 — 메인에 분기를 덧댄 화면이었다.

    그 파일이 frontend/guild/ 가 아니라 frontend/guild-home/ 에 있는 이유가 있다.
    이 라우트가 /guild/ 로 시작하는 주소를 전부 삼키기 때문이다. /guild/css/guild.css 를
    걸면 여기서 slug="css", path="guild.css" 로 읽혀 404 가 난다 — CSS 와 JS 가 통째로
    안 실려서 화면이 백지가 된다. 예외를 두는 대신 이름이 겹칠 수 없게 했다."""
    if not path:
        return _html_with_theme(os.path.join(FRONTEND_DIR, 'guild-home', 'index.html'), slug)
    full = os.path.normpath(os.path.join(FRONTEND_DIR, path))
    if not full.startswith(FRONTEND_DIR):
        raise HTTPException(404)
    if os.path.isdir(full):
        # 디렉터리인데 슬래시가 없으면 상대 경로(css/…)가 어긋난다. 슬래시를 붙여 보낸다.
        if not request.url.path.endswith('/'):
            return RedirectResponse(request.url.path + '/')
        full = os.path.join(full, 'index.html')
    if not os.path.isfile(full):
        raise HTTPException(404)
    # HTML 을 내려줄 때만 테마를 조회한다. CSS·JS 요청까지 타면 낭비다.
    if full.endswith('.html'):
        return _html_with_theme(full, slug)
    return FileResponse(full)


@app.middleware('http')
async def static_cache_headers(request: Request, call_next):
    """프론트 파일은 브라우저가 매번 서버에 물어보게 한다.

    Safari 는 헤더가 없으면 알아서 캐시를 오래 잡아, 고친 화면이 아니라 옛 화면에
    갇히는 일이 생긴다. no-cache 는 '저장은 하되 쓰기 전에 확인하라'는 뜻이라
    바뀐 게 없으면 304 만 오간다 — 트래픽은 거의 그대로다.

    vendor 는 버전이 박힌 외부 라이브러리(PDF.js 등)라 오래 캐시해도 안전하고,
    /api 는 각 엔드포인트가 이미 자기 캐시 정책을 정해 두었으므로 건드리지 않는다.
    (악보 페이지 이미지의 1시간 캐시가 여기 해당한다)"""
    response = await call_next(request)
    path = request.url.path
    if path.startswith('/api/'):
        return response
    if '/vendor/' in path:
        response.headers['Cache-Control'] = 'public, max-age=604800'
    else:
        response.headers['Cache-Control'] = 'no-cache'
    return response


# ---------- 전송량 계측 ----------
def _route_name(scope, tally):
    """API 별로 묶을 이름. 실제 경로 대신 라우트 틀(/api/songs/{song_id}/thumb)을 쓴다.
    실제 경로를 키로 쓰면 곡 id·닉네임마다 칸이 생겨 끝없이 늘어난다.
    틀은 라우트 안에서 metrics.tag_route 가 적어 둔다. 없으면 라우트에 닿지 못한 요청이다."""
    if tally.route:
        return tally.route
    return '(unmatched)' if scope['path'].startswith('/api/') else '(static)'


class TrafficMeter:
    """응답 본문 바이트, 그 요청 동안 DB 에서 받은 바이트, 처리 시간을 metrics 에 적는다.
    다른 미들웨어보다 바깥에 둔다 — 나중에 압축을 넣으면 압축된 크기가 잡혀야 한다.
    처리 시간은 응답을 시작한 순간까지다. 휴대폰까지 보내는 시간은 서버가 어쩔 수 없으니 뺀다."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http':
            await self.app(scope, receive, send)
            return
        tally = metrics.Tally()
        token = metrics.begin(tally)
        started = time.perf_counter()
        answered = None

        async def counting_send(message):
            nonlocal answered
            if message['type'] == 'http.response.start' and answered is None:
                answered = time.perf_counter()
            elif message['type'] == 'http.response.body':
                tally.out += len(message.get('body', b''))
            await send(message)

        metrics.enter()
        try:
            await self.app(scope, receive, counting_send)
        finally:
            metrics.leave()
            metrics.end(token)
            ms = ((answered or time.perf_counter()) - started) * 1000
            metrics.commit(_route_name(scope, tally), tally, ms=ms)


# add_middleware 는 나중에 붙인 것이 가장 바깥이 된다. 그래서 다른 미들웨어 뒤에 붙인다.
app.add_middleware(TrafficMeter)

app.mount('/', StaticFiles(directory=FRONTEND_DIR, html=True), name='frontend')
