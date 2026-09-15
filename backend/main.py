import asyncio
import hashlib
import json
import mimetypes
import os
from datetime import date as _date
from datetime import timedelta
from urllib.parse import quote

from fastapi import (FastAPI, File, Form, HTTPException, Request, Response,
                     UploadFile, WebSocket, WebSocketDisconnect)
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles

import pairing
import render
from db import get_db, init_db

BASE_DIR = os.path.dirname(__file__)
FRONTEND_DIR = os.path.join(BASE_DIR, '..', 'frontend')

init_db()

app = FastAPI(title='대파밀수단 API')


def build_songs(conn, song_rows):
    if not song_rows:
        return []
    songs = [dict(r) for r in song_rows]
    for s in songs:
        s['isCandidate'] = bool(s['isCandidate'])
        s['sessions'] = []
    song_ids = [s['id'] for s in songs]
    song_ph = ','.join('%s' for _ in song_ids)

    session_rows = conn.execute(
        f'SELECT * FROM sessions WHERE "songId" IN ({song_ph}) ORDER BY "id"', song_ids
    ).fetchall()
    sessions = [dict(r) for r in session_rows]
    for s in sessions:
        s['supports'] = []
    by_song = {}
    for s in sessions:
        by_song.setdefault(s['songId'], []).append(s)
    for s in songs:
        s['sessions'] = by_song.get(s['id'], [])

    sess_ids = [s['id'] for s in sessions]
    if sess_ids:
        sess_ph = ','.join('%s' for _ in sess_ids)
        by_sess = {}
        for sp in conn.execute(
            f'SELECT * FROM sessionSupports WHERE "sessionId" IN ({sess_ph}) ORDER BY "id"', sess_ids
        ).fetchall():
            by_sess.setdefault(sp['sessionId'], []).append(dict(sp))
        for s in sessions:
            s['supports'] = by_sess.get(s['id'], [])

    return songs


# ---------- 곡 ----------
@app.get('/api/songs')
def list_songs():
    conn = get_db()
    rows = conn.execute(
        'SELECT * FROM songs ORDER BY "createdAt" DESC'
    ).fetchall()
    result = build_songs(conn, rows)
    conn.close()
    return result


@app.post('/api/songs')
def create_song(body: dict):
    title = (body.get('title') or '').strip()
    artist = (body.get('artist') or '').strip()
    if not title or not artist:
        raise HTTPException(400, 'title과 artist는 필수입니다.')
    conn = get_db()
    cur = conn.execute(
        'INSERT INTO songs (title, artist, category, "tags", "youtubeUrl", status, "isCandidate", note, "createdBy") '
        'VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING "id"',
        (
            title,
            artist,
            body.get('category'),
            _norm_tag(body.get('tags')),
            body.get('youtubeUrl'),
            body.get('status') or 'candidate',
            1 if body.get('isCandidate') else 0,
            body.get('note'),
            body.get('createdBy'),
        ),
    )
    song_id = cur.fetchone()['id']
    conn.commit()
    row = conn.execute('SELECT * FROM songs WHERE "id"=%s', (song_id,)).fetchone()
    result = build_songs(conn, [row])[0]
    conn.close()
    return result


@app.get('/api/songs/{song_id}')
def get_song(song_id: int):
    conn = get_db()
    row = conn.execute('SELECT * FROM songs WHERE "id"=%s', (song_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(404, '곡을 찾을 수 없습니다.')
    result = build_songs(conn, [row])[0]
    conn.close()
    return result


@app.put('/api/songs/{song_id}')
def update_song(song_id: int, body: dict):
    conn = get_db()
    fields = []
    values = []
    for key in ('title', 'artist', 'category', 'tags', 'youtubeUrl', 'status', 'isCandidate', 'note'):
        if key in body:
            value = body[key]
            if key == 'isCandidate':
                value = 1 if value else 0
            elif key == 'tags':
                value = _norm_tag(value)
            fields.append(f'"{key}"=%s')
            values.append(value)
    if not fields:
        conn.close()
        raise HTTPException(400, '수정할 내용이 없습니다.')
    fields.append('"updatedAt"=now()')
    values.append(song_id)
    cur = conn.execute(f'UPDATE songs SET {", ".join(fields)} WHERE "id"=%s', values)
    conn.commit()
    if cur.rowcount == 0:
        conn.close()
        raise HTTPException(404, '곡을 찾을 수 없습니다.')
    row = conn.execute('SELECT * FROM songs WHERE "id"=%s', (song_id,)).fetchone()
    result = build_songs(conn, [row])[0]
    conn.close()
    return result


@app.delete('/api/songs/{song_id}')
def delete_song(song_id: int):
    conn = get_db()
    cur = conn.execute('DELETE FROM songs WHERE "id"=%s', (song_id,))
    conn.commit()
    conn.close()
    if cur.rowcount == 0:
        raise HTTPException(404, '곡을 찾을 수 없습니다.')
    return {'ok': True}


# ---------- 세션 ----------
@app.get('/api/sessions')
def list_sessions(songId: int | None = None):
    conn = get_db()
    if songId is not None:
        rows = conn.execute('SELECT * FROM sessions WHERE "songId"=%s ORDER BY "createdAt" DESC', (songId,)).fetchall()
    else:
        rows = conn.execute('SELECT * FROM sessions ORDER BY "createdAt" DESC').fetchall()
    sessions = [dict(r) for r in rows]
    for s in sessions:
        s['supports'] = []
    sess_ids = [s['id'] for s in sessions]
    if sess_ids:
        ph = ','.join('%s' for _ in sess_ids)
        by_sess = {}
        for sp in conn.execute(
            f'SELECT * FROM sessionSupports WHERE "sessionId" IN ({ph}) ORDER BY "id"', sess_ids
        ).fetchall():
            by_sess.setdefault(sp['sessionId'], []).append(dict(sp))
        for s in sessions:
            s['supports'] = by_sess.get(s['id'], [])
    song_ids = list({s['songId'] for s in sessions})
    songs = {}
    if song_ids:
        ph = ','.join('%s' for _ in song_ids)
        for r in conn.execute(f'SELECT * FROM songs WHERE "id" IN ({ph})', song_ids).fetchall():
            songs[r['id']] = dict(r)
    for s in sessions:
        s['song'] = songs.get(s['songId'])
    conn.close()
    return sessions


@app.post('/api/sessions')
def create_session(body: dict):
    song_id = body.get('songId')
    role = (body.get('role') or '').strip()
    if not song_id or not role:
        raise HTTPException(400, 'songId와 role은 필수입니다.')
    conn = get_db()
    song = conn.execute('SELECT * FROM songs WHERE "id"=%s', (song_id,)).fetchone()
    if not song:
        conn.close()
        raise HTTPException(404, '곡을 찾을 수 없습니다.')
    cur = conn.execute(
        'INSERT INTO sessions ("songId", role, note) VALUES (%s,%s,%s) RETURNING "id"',
        (song_id, role, body.get('note')),
    )
    session_id = cur.fetchone()['id']
    conn.commit()
    row = conn.execute('SELECT * FROM sessions WHERE "id"=%s', (session_id,)).fetchone()
    s = dict(row)
    s['supports'] = []
    conn.close()
    return s


@app.post('/api/sessions/{session_id}/support')
def support_session(session_id: int, body: dict):
    nickname = (body.get('nickname') or '').strip()
    if not nickname:
        raise HTTPException(400, 'nickname은 필수입니다.')
    conn = get_db()
    session = conn.execute('SELECT * FROM sessions WHERE "id"=%s', (session_id,)).fetchone()
    if not session:
        conn.close()
        raise HTTPException(404, '세션을 찾을 수 없습니다.')
    try:
        cur = conn.execute(
            'INSERT INTO sessionSupports ("sessionId", nickname) VALUES (%s,%s) RETURNING "id"',
            (session_id, nickname),
        )
        support_id = cur.fetchone()['id']
        conn.commit()
    except Exception:
        conn.close()
        raise HTTPException(400, '이미 지원한 세션입니다.')
    row = conn.execute('SELECT * FROM sessionSupports WHERE "id"=%s', (support_id,)).fetchone()
    conn.close()
    return dict(row)


@app.delete('/api/sessions/{session_id}/support/{support_id}')
def unsupport_session(session_id: int, support_id: int):
    conn = get_db()
    cur = conn.execute('DELETE FROM sessionSupports WHERE "id"=%s AND "sessionId"=%s', (support_id, session_id))
    conn.commit()
    conn.close()
    if cur.rowcount == 0:
        raise HTTPException(404, '지원을 찾을 수 없습니다.')
    return {'ok': True}


@app.delete('/api/sessions/{session_id}')
def delete_session(session_id: int):
    conn = get_db()
    cur = conn.execute('DELETE FROM sessions WHERE "id"=%s', (session_id,))
    conn.commit()
    conn.close()
    if cur.rowcount == 0:
        raise HTTPException(404, '세션을 찾을 수 없습니다.')
    return {'ok': True}


# ---------- 합주 이력 ----------
@app.get('/api/histories')
def list_histories():
    conn = get_db()
    rows = conn.execute(
        'SELECT * FROM sessionHistories ORDER BY "date" DESC'
    ).fetchall()
    result = []
    for hr in rows:
        h = dict(hr)
        song = conn.execute('SELECT * FROM songs WHERE "id"=%s', (h['songId'],)).fetchone()
        h['song'] = dict(song) if song else None
        result.append(h)
    conn.close()
    return result


@app.post('/api/histories')
def create_history(body: dict):
    song_id = body.get('songId')
    day = body.get('date')
    if not song_id or not day:
        raise HTTPException(400, 'songId와 date는 필수입니다.')
    conn = get_db()
    song = conn.execute('SELECT * FROM songs WHERE "id"=%s', (song_id,)).fetchone()
    if not song:
        conn.close()
        raise HTTPException(404, '곡을 찾을 수 없습니다.')
    cur = conn.execute(
        'INSERT INTO sessionHistories ("songId", "date", note) VALUES (%s,%s,%s) RETURNING "id"',
        (song_id, day, body.get('note')),
    )
    history_id = cur.fetchone()['id']
    conn.commit()
    row = conn.execute('SELECT * FROM sessionHistories WHERE "id"=%s', (history_id,)).fetchone()
    h = dict(row)
    h['song'] = dict(song)
    conn.close()
    return h


@app.delete('/api/histories/{history_id}')
def delete_history(history_id: int):
    conn = get_db()
    cur = conn.execute('DELETE FROM sessionHistories WHERE "id"=%s', (history_id,))
    conn.commit()
    conn.close()
    if cur.rowcount == 0:
        raise HTTPException(404, '합주 이력을 찾을 수 없습니다.')
    return {'ok': True}


# ---------- 악보 ----------
# 악보는 곡 목록과 독립이다. 파트(role)로 나누고 태그와 검색으로 찾는다.
SHEET_COLS = (
    '"id", "title", "artist", "role", "tags", "bpm", "pages", "note", '
    '"fileName", "viewPrefs", "uploadedBy", "createdAt", "updatedAt", '
    'octet_length(content) AS "sizeBytes"'
)
SHEET_EDITABLE = ('title', 'artist', 'role', 'tags', 'bpm', 'pages', 'note', 'viewPrefs')
MAX_SHEET_BYTES = 30 * 1024 * 1024

def _like_escape(text):
    """LIKE/ILIKE 패턴에서 %, _ 가 와일드카드로 해석되지 않게 이스케이프한다."""
    return text.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_')


def _body_ids(body):
    try:
        ids = [int(i) for i in (body.get('ids') or [])]
    except (TypeError, ValueError):
        raise HTTPException(400, 'ids가 올바르지 않습니다.')
    if not ids:
        raise HTTPException(400, '대상이 없습니다.')
    return ids


def _norm_tag(value):
    """태그는 한 곡(악보)에 하나다. 예전 데이터가 쉼표로 여러 개를 갖고 있으면
    첫 번째만 남긴다. 빈 값은 None 으로 저장해 '태그 없음'과 구분되지 않게 한다."""
    if not value:
        return None
    first = str(value).split(',')[0].strip()
    return first or None


@app.get('/api/sheets/tag-counts')
def sheet_tag_counts():
    """필터 칩에 개수를 붙이기 위한 집계."""
    conn = get_db()
    rows = conn.execute(
        'SELECT "tags" AS t, COUNT(*) AS c FROM sheets '
        "WHERE \"tags\" IS NOT NULL AND \"tags\" <> '' GROUP BY \"tags\""
    ).fetchall()
    conn.close()
    return {r['t']: r['c'] for r in rows}


@app.get('/api/sheets')
def list_sheets(q: str | None = None, role: str | None = None, tag: str | None = None):
    """태그는 하나만 붙으므로 정확히 일치하는 것만 거른다."""
    where = []
    params = []
    if q and q.strip():
        like = f'%{_like_escape(q.strip())}%'
        where.append('("title" ILIKE %s OR "artist" ILIKE %s OR "tags" ILIKE %s)')
        params += [like, like, like]
    if role:
        where.append('"role" = %s')
        params.append(role)
    if tag and tag.strip():
        where.append('"tags" = %s')
        params.append(tag.strip())
    clause = (' WHERE ' + ' AND '.join(where)) if where else ''
    conn = get_db()
    rows = conn.execute(
        f'SELECT {SHEET_COLS} FROM sheets{clause} ORDER BY "createdAt" DESC', params
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


@app.post('/api/sheets')
async def upload_sheets(
    role: str = Form(...),
    tags: str | None = Form(None),
    uploadedBy: str | None = Form(None),
    meta: str | None = Form(None),
    files: list[UploadFile] = File(...),
):
    """파트를 한 번 고르고 여러 파일을 한꺼번에 올린다.
    meta 는 파일 순서와 같은 길이의 JSON 배열로, 브라우저가 악보에서 뽑아낸
    제목·아티스트·BPM·태그가 들어온다. 없으면 파일명과 묶음 기본값을 쓴다."""
    try:
        per_file = json.loads(meta) if meta else []
        if not isinstance(per_file, list):
            per_file = []
    except (ValueError, TypeError):
        per_file = []

    tag_text = _norm_tag(tags)
    conn = get_db()
    created = []
    skipped = []                # 문제 있는 파일은 묶음 전체를 깨지 않고 하나만 빼고 알려준다
    try:
        for i, f in enumerate(files):
            data = await f.read()
            if not data:
                continue
            name = f.filename or ''
            # 뷰어가 PDF만 그릴 수 있다. 다른 형식이 들어오면 영영 못 여는 악보가 된다.
            if not data.startswith(b'%PDF-'):
                skipped.append({'fileName': name, 'reason': 'PDF 파일이 아닙니다'})
                continue
            if len(data) > MAX_SHEET_BYTES:
                skipped.append({'fileName': name, 'reason': '30MB를 넘습니다'})
                continue
            info = per_file[i] if i < len(per_file) and isinstance(per_file[i], dict) else {}
            title = (info.get('title') or '').strip()
            if not title:
                title = os.path.splitext(f.filename or '')[0].strip() or '제목 없음'
            bpm = info.get('bpm')
            bpm = int(bpm) if isinstance(bpm, (int, float)) and 20 <= bpm <= 300 else None
            artist = (info.get('artist') or '').strip() or None
            # 파일마다 태그를 다르게 줄 수 있다. 안 넘어오면 묶음 기본값을 쓴다.
            row_tags = _norm_tag(info['tags']) if 'tags' in info else tag_text
            pages = info.get('pages')
            pages = int(pages) if isinstance(pages, (int, float)) and pages > 0 else None
            cur = conn.execute(
                'INSERT INTO sheets ("title","artist","role","tags","bpm","pages","fileName",'
                '"content","uploadedBy") VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING "id"',
                (title, artist, role, row_tags, bpm, pages, f.filename or '', data, uploadedBy),
            )
            created.append(cur.fetchone()['id'])
        if not created:
            detail = ' / '.join(f"{s['fileName']}: {s['reason']}" for s in skipped) \
                or '올릴 파일이 없습니다.'
            raise HTTPException(400, detail)
        conn.commit()
        ph = ','.join('%s' for _ in created)
        rows = conn.execute(
            f'SELECT {SHEET_COLS} FROM sheets WHERE "id" IN ({ph}) ORDER BY "createdAt" DESC',
            created,
        ).fetchall()
        return {'created': [dict(r) for r in rows], 'skipped': skipped}
    except HTTPException:
        conn.rollback()
        raise
    finally:
        conn.close()


@app.post('/api/sheets/bulk')
def bulk_update_sheets(body: dict):
    """여러 악보의 태그나 파트를 한꺼번에 바꾼다.
    태그는 하나뿐이므로 더하고 빼는 것이 아니라 그대로 갈아끼운다."""
    ids = _body_ids(body)
    role = body.get('role')

    conn = get_db()
    ph = ','.join('%s' for _ in ids)
    if 'tag' in body:
        conn.execute(
            f'UPDATE sheets SET "tags"=%s, "updatedAt"=now() WHERE "id" IN ({ph})',
            [_norm_tag(body.get('tag'))] + ids,
        )
    if role:
        conn.execute(
            f'UPDATE sheets SET "role"=%s, "updatedAt"=now() WHERE "id" IN ({ph})',
            [role] + ids,
        )
    conn.commit()
    rows = conn.execute(
        f'SELECT {SHEET_COLS} FROM sheets WHERE "id" IN ({ph}) ORDER BY "createdAt" DESC', ids
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


@app.post('/api/sheets/bulk-delete')
def bulk_delete_sheets(body: dict):
    ids = _body_ids(body)
    conn = get_db()
    ph = ','.join('%s' for _ in ids)
    cur = conn.execute(f'DELETE FROM sheets WHERE "id" IN ({ph})', ids)
    conn.commit()
    conn.close()
    for sheet_id in ids:
        render.forget(sheet_id)
    return {'ok': True, 'deleted': cur.rowcount}


@app.put('/api/sheets/{sheet_id}')
def update_sheet(sheet_id: int, body: dict):
    fields = []
    values = []
    for key in SHEET_EDITABLE:
        if key in body:
            value = _norm_tag(body[key]) if key == 'tags' else body[key]
            fields.append(f'"{key}"=%s')
            values.append(value)
    if not fields:
        raise HTTPException(400, '수정할 내용이 없습니다.')
    fields.append('"updatedAt"=now()')
    values.append(sheet_id)
    conn = get_db()
    cur = conn.execute(f'UPDATE sheets SET {", ".join(fields)} WHERE "id"=%s', values)
    conn.commit()
    if cur.rowcount == 0:
        conn.close()
        raise HTTPException(404, '악보를 찾을 수 없습니다.')
    row = conn.execute(f'SELECT {SHEET_COLS} FROM sheets WHERE "id"=%s', (sheet_id,)).fetchone()
    conn.close()
    return dict(row)


@app.get('/api/sheets/{sheet_id}/pages')
def sheet_pages(sheet_id: int):
    """쪽수. 뷰어가 열자마자 전 페이지를 미리 받으려면 먼저 이게 필요하다.
    쪽수 컬럼이 비어 있던 예전 악보는 이때 채워 넣어, 다음부터는 목록만으로 알 수 있게 한다."""
    try:
        pages = render.page_count(sheet_id)
    except render.SheetNotFound:
        raise HTTPException(404, '악보를 찾을 수 없습니다.')
    conn = get_db()
    conn.execute('UPDATE sheets SET "pages"=%s WHERE "id"=%s AND "pages" IS NULL',
                 (pages, sheet_id))
    conn.commit()
    conn.close()
    return {'pages': pages}


@app.get('/api/sheets/{sheet_id}/page/{page_no}')
def sheet_page(sheet_id: int, page_no: int, request: Request,
               w: int = render.DEFAULT_WIDTH):
    """페이지 한 장을 WebP 이미지로. PDF 원본은 브라우저로 내보내지 않는다.

    캐시는 한 시간 동안은 재검증 없이 그대로 쓰고(공연 중 네트워크가 끊겨도
    브라우저 캐시로 버틴다), 그 뒤에는 ETag 재검증으로 다룬다. 내용을 그대로
    해싱하므로 렌더링 방식을 바꾸면 지문이 달라져 브라우저가 새로 받는다."""
    try:
        data = render.render_page(sheet_id, page_no, w)
    except render.SheetNotFound:
        raise HTTPException(404, '악보를 찾을 수 없습니다.')
    except IndexError as exc:
        raise HTTPException(404, str(exc))

    etag = '"' + hashlib.sha1(data).hexdigest()[:20] + '"'
    cache = 'private, max-age=3600'
    if request.headers.get('if-none-match') == etag:
        return Response(status_code=304, headers={'ETag': etag, 'Cache-Control': cache})

    return Response(
        content=data,
        media_type='image/webp',
        headers={
            'ETag': etag,
            'Cache-Control': cache,
            'Content-Length': str(len(data)),
        },
    )


@app.delete('/api/sheets/{sheet_id}')
def delete_sheet(sheet_id: int):
    conn = get_db()
    cur = conn.execute('DELETE FROM sheets WHERE "id"=%s', (sheet_id,))
    conn.commit()
    conn.close()
    if cur.rowcount == 0:
        raise HTTPException(404, '악보를 찾을 수 없습니다.')
    render.forget(sheet_id)
    return {'ok': True}


# ---------- 페어링 (두 아이패드) ----------
@app.post('/api/pairs')
def create_pair():
    return {'code': pairing.create_pair()}


@app.delete('/api/pairs/{code}')
def delete_pair(code: str):
    if not pairing.delete_pair(code):
        raise HTTPException(404, '페어를 찾을 수 없습니다.')
    return {'ok': True}


@app.websocket('/ws/pair/{code}')
async def pair_ws(ws: WebSocket, code: str):
    """페어 방. 한쪽이 보낸 {sheetId, spread}를 다른 쪽에 그대로 중계한다.
    DB 조회/저장은 스레드로 보내 이벤트 루프를 막지 않는다."""
    code = code.strip().upper()
    state = await asyncio.to_thread(pairing.get_state, code)
    if not state:
        await ws.close(code=4404)
        return
    await ws.accept()
    pairing.join(code, ws)
    try:
        # 방금 들어온 기기가 바로 따라잡도록 저장된 상태부터 보낸다.
        await ws.send_json({
            'type': 'state', 'sheetId': state['sheetId'], 'spread': state['spread'],
            'title': state['title'], 'pages': state['pages'],
        })
        await pairing.broadcast(code, {'type': 'peers', 'count': pairing.peer_count(code)})
        while True:
            msg = await ws.receive_json()
            kind = msg.get('type')
            if kind == 'state':
                sheet_id = msg.get('sheetId')
                try:
                    spread = max(1, int(msg.get('spread') or 1))
                except (TypeError, ValueError):
                    spread = 1
                await asyncio.to_thread(pairing.set_state, code, sheet_id, spread)
                await pairing.broadcast(code, {
                    'type': 'state', 'sheetId': sheet_id, 'spread': spread,
                    'title': msg.get('title'), 'pages': msg.get('pages'),
                }, sender=ws)
            elif kind == 'unpair':
                # 어느 쪽이 끊든 페어는 끝난다. 기록을 지우고 방 전체에 알린 뒤 문을 닫는다.
                await asyncio.to_thread(pairing.delete_pair, code)
                await pairing.broadcast(code, {'type': 'closed'})
                break
            elif kind == 'ping':
                await ws.send_json({'type': 'pong'})
    except WebSocketDisconnect:
        pass
    finally:
        pairing.leave(code, ws)
        await pairing.broadcast(code, {'type': 'peers', 'count': pairing.peer_count(code)})


# ---------- 추첨 ----------
@app.get('/api/lotteries')
def list_lotteries():
    conn = get_db()
    rows = conn.execute(
        'SELECT "id" FROM lotteries ORDER BY "createdAt" DESC'
    ).fetchall()
    ids = [r['id'] for r in rows]
    conn.close()
    return [_get_lottery(i) for i in ids]


@app.post('/api/lotteries')
def create_lottery(body: dict):
    selected = list(dict.fromkeys(int(i) for i in (body.get('songIds') or [])))
    pool_ids = list(dict.fromkeys(int(i) for i in (body.get('poolIds') or [])))
    drawn_by = (body.get('drawnBy') or '').strip() or None
    if not selected:
        raise HTTPException(400, 'songIds 배열이 필요합니다.')

    conn = get_db()

    def valid(ids):
        if not ids:
            return []
        ph = ','.join('%s' for _ in ids)
        return [r['id'] for r in conn.execute(f'SELECT "id" FROM songs WHERE "id" IN ({ph})', ids).fetchall()]

    sel_valid = valid(selected)
    if not sel_valid:
        conn.close()
        raise HTTPException(400, '유효한 곡이 없습니다.')
    pool_valid = valid(pool_ids) if pool_ids else sel_valid

    cur = conn.execute(
        'INSERT INTO lotteries ("drawnBy", "poolJson") VALUES (%s,%s) RETURNING "id"',
        (drawn_by, json.dumps(pool_valid)),
    )
    lottery_id = cur.fetchone()['id']
    for song_id in sel_valid:
        conn.execute(
            'INSERT INTO lotteryItems ("lotteryId", "songId") VALUES (%s,%s)',
            (lottery_id, song_id),
        )
    conn.commit()
    conn.close()
    return _get_lottery(lottery_id)


@app.delete('/api/lotteries/{lottery_id}')
def delete_lottery(lottery_id: int):
    conn = get_db()
    cur = conn.execute('DELETE FROM lotteries WHERE "id"=%s', (lottery_id,))
    conn.commit()
    conn.close()
    if cur.rowcount == 0:
        raise HTTPException(404, '추첨 기록을 찾을 수 없습니다.')
    return {'ok': True}


def _get_lottery(lottery_id):
    conn = get_db()
    lr = conn.execute('SELECT * FROM lotteries WHERE "id"=%s', (lottery_id,)).fetchone()
    try:
        pool_ids = json.loads(lr['poolJson'] or '[]')
    except Exception:
        pool_ids = []
    pool = []
    if pool_ids:
        ph = ','.join('%s' for _ in pool_ids)
        pool = [
            dict(r)
            for r in conn.execute(
                f'SELECT "id", title, artist FROM songs WHERE "id" IN ({ph})', pool_ids
            ).fetchall()
        ]
    items = []
    for ir in conn.execute(
        'SELECT * FROM lotteryItems WHERE "lotteryId"=%s ORDER BY "id"', (lottery_id,)
    ).fetchall():
        item = dict(ir)
        song = conn.execute('SELECT * FROM songs WHERE "id"=%s', (item['songId'],)).fetchone()
        item['song'] = dict(song) if song else None
        items.append(item)
    lot = dict(lr)
    lot['pool'] = pool
    lot['items'] = items
    conn.close()
    return lot


# ---------- 일정 ----------
def serialize_event(conn, row):
    ev = dict(row)
    ev['dates'] = [
        dict(x)
        for x in conn.execute(
            'SELECT * FROM eventDates WHERE "eventId"=%s ORDER BY "date"', (ev['id'],)
        ).fetchall()
    ]
    ev['avails'] = [
        dict(x)
        for x in conn.execute(
            'SELECT * FROM eventAvails WHERE "eventId"=%s ORDER BY "date", nickname', (ev['id'],)
        ).fetchall()
    ]
    return ev


@app.get('/api/events')
def list_events():
    conn = get_db()
    rows = conn.execute('SELECT * FROM events ORDER BY "createdAt" DESC').fetchall()
    result = [serialize_event(conn, r) for r in rows]
    conn.close()
    return result


@app.post('/api/events')
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
    conn = get_db()
    cur = conn.execute(
        'INSERT INTO events (title, status, note, "createdBy") VALUES (%s,%s,%s,%s) RETURNING "id"',
        (title, 'poll', body.get('note'), body.get('createdBy')),
    )
    event_id = cur.fetchone()['id']
    d = _date.fromisoformat(date_from)
    d1 = _date.fromisoformat(date_to)
    while d <= d1:
        conn.execute(
            'INSERT INTO eventDates ("eventId", "date") VALUES (%s,%s) ON CONFLICT DO NOTHING',
            (event_id, d.isoformat()),
        )
        d += timedelta(days=1)
    conn.commit()
    row = conn.execute('SELECT * FROM events WHERE "id"=%s', (event_id,)).fetchone()
    result = serialize_event(conn, row)
    conn.close()
    return result


@app.delete('/api/events/{event_id}')
def delete_event(event_id: int):
    conn = get_db()
    cur = conn.execute('DELETE FROM events WHERE "id"=%s', (event_id,))
    conn.commit()
    conn.close()
    if cur.rowcount == 0:
        raise HTTPException(404, '일정을 찾을 수 없습니다.')
    return {'ok': True}


@app.post('/api/events/{event_id}/avail/toggle')
def toggle_avail(event_id: int, body: dict):
    day = (body.get('date') or '').strip()
    nickname = (body.get('nickname') or '').strip()
    if not day or not nickname:
        raise HTTPException(400, 'date와 nickname은 필수입니다.')
    if len(nickname) > 20:
        raise HTTPException(400, '닉네임은 20자까지 입력할 수 있습니다.')
    conn = get_db()
    event = conn.execute('SELECT * FROM events WHERE "id"=%s', (event_id,)).fetchone()
    if not event:
        conn.close()
        raise HTTPException(404, '일정을 찾을 수 없습니다.')
    if event['status'] == 'confirmed' and day != event['date']:
        conn.close()
        raise HTTPException(400, '확정된 일정은 확정 날짜의 인원만 변경할 수 있습니다.')
    date_row = conn.execute(
        'SELECT * FROM eventDates WHERE "eventId"=%s AND "date"=%s', (event_id, day)
    ).fetchone()
    if not date_row:
        conn.close()
        raise HTTPException(400, '후보 기간에 없는 날짜입니다.')
    existing = conn.execute(
        'SELECT "id" FROM eventAvails WHERE "eventId"=%s AND "date"=%s AND nickname=%s',
        (event_id, day, nickname),
    ).fetchone()
    if existing:
        conn.execute(
            'DELETE FROM eventAvails WHERE "id"=%s', (existing['id'],)
        )
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


@app.post('/api/events/{event_id}/confirm')
def confirm_event(event_id: int, body: dict):
    day = (body.get('date') or '').strip()
    if not day:
        raise HTTPException(400, 'date는 필수입니다.')
    conn = get_db()
    event = conn.execute('SELECT * FROM events WHERE "id"=%s', (event_id,)).fetchone()
    if not event:
        conn.close()
        raise HTTPException(404, '일정을 찾을 수 없습니다.')
    date_row = conn.execute(
        'SELECT * FROM eventDates WHERE "eventId"=%s AND "date"=%s', (event_id, day)
    ).fetchone()
    if not date_row:
        conn.close()
        raise HTTPException(400, '후보 기간에 없는 날짜입니다.')
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


@app.post('/api/events/{event_id}/unconfirm')
def unconfirm_event(event_id: int):
    conn = get_db()
    event = conn.execute('SELECT * FROM events WHERE "id"=%s', (event_id,)).fetchone()
    if not event:
        conn.close()
        raise HTTPException(404, '일정을 찾을 수 없습니다.')
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


@app.get('/api/events/{event_id}/playable')
def playable_songs(event_id: int):
    """확정된 합주의 참석자 기준으로 곡별 세션 충족도를 계산한다."""
    conn = get_db()
    event = conn.execute('SELECT * FROM events WHERE "id"=%s', (event_id,)).fetchone()
    if not event:
        conn.close()
        raise HTTPException(404, '일정을 찾을 수 없습니다.')
    if event['status'] != 'confirmed' or not event['date']:
        conn.close()
        raise HTTPException(400, '확정된 일정이 아닙니다.')

    attendees = [
        r['nickname']
        for r in conn.execute(
            'SELECT nickname FROM eventAvails WHERE "eventId"=%s AND "date"=%s',
            (event_id, event['date']),
        ).fetchall()
    ]
    att = set(attendees)

    rows = conn.execute(
        'SELECT s."id" AS "songId", s.title, s.artist, s.status, s."youtubeUrl", '
        'se."id" AS "sessionId", se.role, sp.nickname '
        'FROM songs s '
        'JOIN sessions se ON se."songId"=s."id" '
        'LEFT JOIN sessionSupports sp ON sp."sessionId"=se."id" '
        'ORDER BY s."id", se."id"'
    ).fetchall()
    conn.close()

    songs = {}
    for r in rows:
        song = songs.setdefault(
            r['songId'],
            {
                'songId': r['songId'],
                'title': r['title'],
                'artist': r['artist'],
                'status': r['status'],
                'youtubeUrl': r['youtubeUrl'],
                'sessions': {},
            },
        )
        sess = song['sessions'].setdefault(r['sessionId'], {'role': r['role'], 'supports': []})
        if r['nickname']:
            sess['supports'].append(r['nickname'])

    result = []
    for song in songs.values():
        roles = []
        members = set()
        for sess in song['sessions'].values():
            here = [n for n in sess['supports'] if n in att]
            members.update(here)
            roles.append({'role': sess['role'], 'members': here, 'ok': bool(here)})
        filled = sum(1 for r in roles if r['ok'])
        result.append(
            {
                'songId': song['songId'],
                'title': song['title'],
                'artist': song['artist'],
                'status': song['status'],
                'youtubeUrl': song['youtubeUrl'],
                'roles': roles,
                'needed': len(roles),
                'filled': filled,
                'attending': len(members),
            }
        )

    result.sort(key=lambda x: (-x['filled'], -x['attending'], x['title']))
    return {'date': event['date'], 'attendees': sorted(att), 'songs': result}


@app.get('/api/health')
def health():
    return {'status': 'ok'}


# ---------- 정적 프론트 ----------
@app.get('/')
def index():
    return RedirectResponse('/songs/')


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
    if path.startswith('/vendor/'):
        response.headers['Cache-Control'] = 'public, max-age=604800'
    else:
        response.headers['Cache-Control'] = 'no-cache'
    return response


app.mount('/', StaticFiles(directory=FRONTEND_DIR, html=True), name='frontend')
