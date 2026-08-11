import json
import os
from datetime import date as _date
from datetime import timedelta

from fastapi import FastAPI, File, Form, HTTPException, Response, UploadFile
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles

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
        s['sheets'] = []
    song_ids = [s['id'] for s in songs]
    song_ph = ','.join('%s' for _ in song_ids)

    session_rows = conn.execute(
        f'SELECT * FROM sessions WHERE "songId" IN ({song_ph}) ORDER BY "id"', song_ids
    ).fetchall()
    sessions = [dict(r) for r in session_rows]
    for s in sessions:
        s['isFilled'] = bool(s['isFilled'])
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

    by_song_sheets = {}
    for x in conn.execute(
        f'SELECT * FROM sheets WHERE "songId" IN ({song_ph}) ORDER BY "createdAt" DESC', song_ids
    ).fetchall():
        sh = dict(x)
        sh.pop('content', None)
        by_song_sheets.setdefault(sh['songId'], []).append(sh)
    for s in songs:
        s['sheets'] = by_song_sheets.get(s['id'], [])

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
        'INSERT INTO songs (title, artist, category, "youtubeUrl", status, "isCandidate", note, "createdBy") '
        'VALUES (%s,%s,%s,%s,%s,%s,%s,%s) RETURNING "id"',
        (
            title,
            artist,
            body.get('category'),
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
    for key in ('title', 'artist', 'category', 'youtubeUrl', 'status', 'isCandidate', 'note'):
        if key in body:
            fields.append(f'"{key}"=%s')
            values.append(1 if key == 'isCandidate' and body[key] else body[key])
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
        s['isFilled'] = bool(s['isFilled'])
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
    s['isFilled'] = bool(s['isFilled'])
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
@app.get('/api/sheets')
def list_sheets():
    conn = get_db()
    rows = conn.execute(
        'SELECT * FROM sheets ORDER BY "createdAt" DESC'
    ).fetchall()
    result = []
    for sr in rows:
        s = dict(sr)
        s.pop('content', None)
        result.append(s)
    song_ids = list({s['songId'] for s in result})
    songs = {}
    if song_ids:
        ph = ','.join('%s' for _ in song_ids)
        for r in conn.execute(f'SELECT * FROM songs WHERE "id" IN ({ph})', song_ids).fetchall():
            songs[r['id']] = dict(r)
    for s in result:
        s['song'] = songs.get(s['songId'])
    conn.close()
    return result


@app.post('/api/sheets')
async def upload_sheet(
    songId: int = Form(...),
    title: str = Form(...),
    uploadedBy: str | None = Form(None),
    file: UploadFile = File(...),
):
    data = await file.read()
    conn = get_db()
    song = conn.execute('SELECT * FROM songs WHERE "id"=%s', (songId,)).fetchone()
    if not song:
        conn.close()
        raise HTTPException(404, '곡을 찾을 수 없습니다.')
    cur = conn.execute(
        'INSERT INTO sheets ("songId", title, "fileName", content, "uploadedBy") '
        'VALUES (%s,%s,%s,%s,%s) RETURNING "id"',
        (songId, title, file.filename or '', data, uploadedBy),
    )
    sheet_id = cur.fetchone()['id']
    conn.commit()
    row = conn.execute('SELECT * FROM sheets WHERE "id"=%s', (sheet_id,)).fetchone()
    s = dict(row)
    s.pop('content', None)
    s['song'] = dict(song)
    conn.close()
    return s


@app.get('/api/sheets/{sheet_id}/file')
def sheet_file(sheet_id: int):
    conn = get_db()
    row = conn.execute('SELECT * FROM sheets WHERE "id"=%s', (sheet_id,)).fetchone()
    conn.close()
    if not row:
        raise HTTPException(404, '악보를 찾을 수 없습니다.')
    content = row['content'] or b''
    filename = row['fileName'] or 'sheet'
    return Response(
        content=content,
        media_type='application/octet-stream',
        headers={'Content-Disposition': f'attachment; filename="{filename}"'},
    )


@app.delete('/api/sheets/{sheet_id}')
def delete_sheet(sheet_id: int):
    conn = get_db()
    cur = conn.execute('DELETE FROM sheets WHERE "id"=%s', (sheet_id,))
    conn.commit()
    conn.close()
    if cur.rowcount == 0:
        raise HTTPException(404, '악보를 찾을 수 없습니다.')
    return {'ok': True}


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
    conn = get_db()
    event = conn.execute('SELECT * FROM events WHERE "id"=%s', (event_id,)).fetchone()
    if not event:
        conn.close()
        raise HTTPException(404, '일정을 찾을 수 없습니다.')
    if event['status'] != 'poll':
        conn.close()
        raise HTTPException(400, '확정된 일정입니다.')
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


@app.get('/api/health')
def health():
    return {'status': 'ok'}


# ---------- 정적 프론트 ----------
@app.get('/')
def index():
    return RedirectResponse('/songs/')


app.mount('/', StaticFiles(directory=FRONTEND_DIR, html=True), name='frontend')
