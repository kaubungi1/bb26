"""세션(파트)과 지원. 파트명은 곡마다 라벨로 덮어쓸 수 있고, 지원에는 한 줄 코멘트가 붙는다."""
from fastapi import APIRouter, HTTPException

from db import get_db

router = APIRouter()

COMMENT_MAX = 40
LABEL_MAX = 20


def _supports_for(conn, sessions):
    for s in sessions:
        s['supports'] = []
    sess_ids = [s['id'] for s in sessions]
    if not sess_ids:
        return
    ph = ','.join('%s' for _ in sess_ids)
    by_sess = {}
    for sp in conn.execute(
        f'SELECT * FROM sessionSupports WHERE "sessionId" IN ({ph}) ORDER BY "id"', sess_ids
    ).fetchall():
        by_sess.setdefault(sp['sessionId'], []).append(dict(sp))
    for s in sessions:
        s['supports'] = by_sess.get(s['id'], [])


@router.get('')
def list_sessions(songId: int | None = None):
    conn = get_db()
    if songId is not None:
        rows = conn.execute('SELECT * FROM sessions WHERE "songId"=%s ORDER BY "createdAt" DESC', (songId,)).fetchall()
    else:
        rows = conn.execute('SELECT * FROM sessions ORDER BY "createdAt" DESC').fetchall()
    sessions = [dict(r) for r in rows]
    _supports_for(conn, sessions)
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


@router.post('')
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
    label = (body.get('label') or '').strip()[:LABEL_MAX] or None
    cur = conn.execute(
        'INSERT INTO sessions ("songId", role, label, note) VALUES (%s,%s,%s,%s) RETURNING "id"',
        (song_id, role, label, body.get('note')),
    )
    session_id = cur.fetchone()['id']
    conn.commit()
    row = conn.execute('SELECT * FROM sessions WHERE "id"=%s', (session_id,)).fetchone()
    s = dict(row)
    s['supports'] = []
    conn.close()
    return s


@router.put('/{session_id}')
def update_session(session_id: int, body: dict):
    """라벨(표시 이름)과 메모만 바꾼다. role 은 정렬 기준이라 고정이다."""
    fields = []
    values = []
    if 'label' in body:
        fields.append('"label"=%s')
        values.append((body.get('label') or '').strip()[:LABEL_MAX] or None)
    if 'note' in body:
        fields.append('"note"=%s')
        values.append(body.get('note'))
    if not fields:
        raise HTTPException(400, '수정할 내용이 없습니다.')
    values.append(session_id)
    conn = get_db()
    cur = conn.execute(f'UPDATE sessions SET {", ".join(fields)} WHERE "id"=%s', values)
    conn.commit()
    if cur.rowcount == 0:
        conn.close()
        raise HTTPException(404, '세션을 찾을 수 없습니다.')
    row = conn.execute('SELECT * FROM sessions WHERE "id"=%s', (session_id,)).fetchone()
    s = dict(row)
    _supports_for(conn, [s])
    conn.close()
    return s


@router.post('/{session_id}/support')
def support_session(session_id: int, body: dict):
    nickname = (body.get('nickname') or '').strip()
    if not nickname:
        raise HTTPException(400, 'nickname은 필수입니다.')
    comment = (body.get('comment') or '').strip()[:COMMENT_MAX] or None
    conn = get_db()
    session = conn.execute('SELECT * FROM sessions WHERE "id"=%s', (session_id,)).fetchone()
    if not session:
        conn.close()
        raise HTTPException(404, '세션을 찾을 수 없습니다.')
    try:
        cur = conn.execute(
            'INSERT INTO sessionSupports ("sessionId", nickname, comment) VALUES (%s,%s,%s) RETURNING "id"',
            (session_id, nickname, comment),
        )
        support_id = cur.fetchone()['id']
        conn.commit()
    except Exception:
        conn.close()
        raise HTTPException(400, '이미 지원한 세션입니다.')
    row = conn.execute('SELECT * FROM sessionSupports WHERE "id"=%s', (support_id,)).fetchone()
    conn.close()
    return dict(row)


@router.put('/{session_id}/support/{support_id}')
def update_support(session_id: int, support_id: int, body: dict):
    """한마디와 표시 이름을 바꾼다. nickname 은 신원이라 여기서 바꾸지 않는다.
       label 을 비우면 표시 이름이 없어지고 화면에는 nickname 이 그대로 나온다."""
    fields = []
    values = []
    if 'comment' in body:
        fields.append('comment=%s')
        values.append((body.get('comment') or '').strip()[:COMMENT_MAX] or None)
    if 'label' in body:
        fields.append('"label"=%s')
        values.append((body.get('label') or '').strip()[:LABEL_MAX] or None)
    if not fields:
        raise HTTPException(400, '수정할 내용이 없습니다.')
    values.extend([support_id, session_id])
    conn = get_db()
    cur = conn.execute(
        f'UPDATE sessionSupports SET {", ".join(fields)} WHERE "id"=%s AND "sessionId"=%s',
        values,
    )
    conn.commit()
    if cur.rowcount == 0:
        conn.close()
        raise HTTPException(404, '지원을 찾을 수 없습니다.')
    row = conn.execute('SELECT * FROM sessionSupports WHERE "id"=%s', (support_id,)).fetchone()
    conn.close()
    return dict(row)


@router.delete('/{session_id}/support/{support_id}')
def unsupport_session(session_id: int, support_id: int):
    conn = get_db()
    cur = conn.execute('DELETE FROM sessionSupports WHERE "id"=%s AND "sessionId"=%s', (support_id, session_id))
    conn.commit()
    conn.close()
    if cur.rowcount == 0:
        raise HTTPException(404, '지원을 찾을 수 없습니다.')
    return {'ok': True}


@router.delete('/{session_id}')
def delete_session(session_id: int):
    conn = get_db()
    cur = conn.execute('DELETE FROM sessions WHERE "id"=%s', (session_id,))
    conn.commit()
    conn.close()
    if cur.rowcount == 0:
        raise HTTPException(404, '세션을 찾을 수 없습니다.')
    return {'ok': True}
