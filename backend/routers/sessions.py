"""세션(파트)과 지원. 파트는 곡마다 여섯이고 쓰지 않는 자리는 꺼 둔다.
   파트명은 곡마다 라벨로 덮어쓸 수 있고, 지원자도 표시 이름(label)을 따로 가질 수 있다."""
from fastapi import APIRouter, HTTPException

from db import get_db
from helpers import SONG_COLS

router = APIRouter()

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
        for r in conn.execute(f'{SONG_COLS} WHERE "id" IN ({ph})', song_ids).fetchall():
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
    song = conn.execute(f'{SONG_COLS} WHERE "id"=%s', (song_id,)).fetchone()
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
    """라벨(표시 이름)·메모·사용 여부를 바꾼다. role 은 정렬 기준이라 고정이다."""
    fields = []
    values = []
    if 'label' in body:
        fields.append('"label"=%s')
        values.append((body.get('label') or '').strip()[:LABEL_MAX] or None)
    if 'note' in body:
        fields.append('"note"=%s')
        values.append(body.get('note'))
    conn = get_db()
    if 'active' in body:
        # 지원자가 남은 자리는 끌 수 없다. 끄고 나서 사람이 남아 있으면 그게 꼬인 자리다.
        # 먼저 정리하게 하고, 정리가 끝나면 그때 끈다.
        if not body['active']:
            n = conn.execute(
                'SELECT count(*) n FROM sessionSupports WHERE "sessionId"=%s', (session_id,)
            ).fetchone()['n']
            if n:
                conn.close()
                raise HTTPException(409, f'지원자 {n}명이 있습니다. 먼저 정리해 주세요.')
        fields.append('"active"=%s')
        values.append(bool(body['active']))
    if not fields:
        conn.close()
        raise HTTPException(400, '수정할 내용이 없습니다.')
    values.append(session_id)
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
    conn = get_db()
    session = conn.execute('SELECT * FROM sessions WHERE "id"=%s', (session_id,)).fetchone()
    if not session:
        conn.close()
        raise HTTPException(404, '세션을 찾을 수 없습니다.')
    # 꺼 둔 자리에는 사람이 들어가지 않는다. 화면에서는 누를 수 없지만
    # 열어 둔 창이 오래돼 꺼진 줄 모르고 보낼 수 있다. 여기서 막아야 기록이 꼬이지 않는다.
    if session.get('active') is False:
        conn.close()
        raise HTTPException(409, '쓰지 않는 자리입니다.')
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


@router.put('/{session_id}/support/{support_id}')
def update_support(session_id: int, support_id: int, body: dict):
    """표시 이름을 바꾼다. nickname 은 신원이라 여기서 바꾸지 않는다.
       label 을 비우면 표시 이름이 없어지고 화면에는 nickname 이 그대로 나온다.

       지원 한마디는 뺐다. 604번 지원하는 동안 한 번 쓰였고, 그 한 칸이
       지원 버튼 앞을 막고 있었다. 말할 자리는 곡 한마디와 끌올 한마디로 충분하다."""
    fields = []
    values = []
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
