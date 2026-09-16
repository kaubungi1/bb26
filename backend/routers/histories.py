"""합주 이력(수기). 셋리스트가 생기기 전 데이터와 옛 대파밀수단 이력을 담는다."""
from fastapi import APIRouter, HTTPException

from db import get_db
from helpers import SONG_COLS

router = APIRouter()


@router.get('')
def list_histories():
    conn = get_db()
    rows = conn.execute('SELECT * FROM sessionHistories ORDER BY "date" DESC').fetchall()
    result = []
    for hr in rows:
        h = dict(hr)
        song = conn.execute(f'{SONG_COLS} WHERE "id"=%s', (h['songId'],)).fetchone()
        h['song'] = dict(song) if song else None
        result.append(h)
    conn.close()
    return result


@router.post('')
def create_history(body: dict):
    song_id = body.get('songId')
    day = body.get('date')
    if not song_id or not day:
        raise HTTPException(400, 'songId와 date는 필수입니다.')
    conn = get_db()
    song = conn.execute(f'{SONG_COLS} WHERE "id"=%s', (song_id,)).fetchone()
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


@router.delete('/{history_id}')
def delete_history(history_id: int):
    conn = get_db()
    cur = conn.execute('DELETE FROM sessionHistories WHERE "id"=%s', (history_id,))
    conn.commit()
    conn.close()
    if cur.rowcount == 0:
        raise HTTPException(404, '합주 이력을 찾을 수 없습니다.')
    return {'ok': True}
