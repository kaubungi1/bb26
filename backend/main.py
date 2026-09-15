"""불법이륙 밴드 사이트 — 앱 생성, 라우터 등록, 정적 프론트 서빙만 여기서 한다.
API 는 routers/ 아래 역할별 파일에 있다."""
import os

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from db import init_db
from routers import (comments, events, guilds, histories, home, members, pairs, sessions, sheets, songs)

BASE_DIR = os.path.dirname(__file__)
FRONTEND_DIR = os.path.normpath(os.path.join(BASE_DIR, '..', 'frontend'))

init_db()

app = FastAPI(title='불법이륙 API')

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
    (members, '/api/members', '멤버'),
    (home, '/api/home', '홈'),
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


@app.get('/guild/{slug}/{path:path}')
def guild_page(slug: str, path: str, request: Request):
    """길드 사이트는 같은 정적 페이지를 /guild/<slug>/ 아래서 그대로 낸다.
    화면은 주소에서 slug 를 읽어 그 길드 것만 보여준다. 데이터는 하나, 얼굴만 여럿."""
    if not path:
        return FileResponse(os.path.join(FRONTEND_DIR, 'index.html'))
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


app.mount('/', StaticFiles(directory=FRONTEND_DIR, html=True), name='frontend')
