"""곡에 남기는 한마디.

자켓 아래에서 한 줄씩 돌아가며 보이는 게 전부라 구조는 단순하게 둔다.
신원은 닉네임 문자열이고, 지우는 건 본인 것만 가능하다.
"""
from fastapi import APIRouter, HTTPException

from db import get_db

router = APIRouter()

BODY_MAX = 80
NICK_MAX = 20


@router.get('/{song_id}/comments')
def list_comments(song_id: int):
    """오래된 것부터 준다. 화면이 순서대로 돌리기 때문이다."""
    conn = get_db()
    try:
        if not conn.execute('SELECT 1 FROM songs WHERE "id"=%s', (song_id,)).fetchone():
            raise HTTPException(404, '곡을 찾을 수 없습니다.')
        rows = conn.execute(
            'SELECT * FROM songComments WHERE "songId"=%s ORDER BY "id"', (song_id,)
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


@router.post('/{song_id}/comments')
def add_comment(song_id: int, body: dict):
    nickname = (body.get('nickname') or '').strip()[:NICK_MAX]
    text = (body.get('body') or '').strip()[:BODY_MAX]
    if not nickname:
        raise HTTPException(400, 'nickname은 필수입니다.')
    if not text:
        raise HTTPException(400, '내용을 입력하세요.')
    conn = get_db()
    try:
        if not conn.execute('SELECT 1 FROM songs WHERE "id"=%s', (song_id,)).fetchone():
            raise HTTPException(404, '곡을 찾을 수 없습니다.')
        cid = conn.execute(
            'INSERT INTO songComments ("songId", nickname, body) VALUES (%s,%s,%s) RETURNING "id"',
            (song_id, nickname, text),
        ).fetchone()['id']
        conn.commit()
        return dict(conn.execute('SELECT * FROM songComments WHERE "id"=%s', (cid,)).fetchone())
    finally:
        conn.close()


@router.delete('/{song_id}/comments/{comment_id}')
def delete_comment(song_id: int, comment_id: int, nickname: str = ''):
    """본인 것만 지운다. 닉네임이 곧 신원이라 그 이상은 막을 수 없다."""
    who = (nickname or '').strip()
    if not who:
        raise HTTPException(400, 'nickname은 필수입니다.')
    conn = get_db()
    try:
        row = conn.execute(
            'SELECT * FROM songComments WHERE "id"=%s AND "songId"=%s', (comment_id, song_id)
        ).fetchone()
        if not row:
            raise HTTPException(404, '댓글을 찾을 수 없습니다.')
        if row['nickname'] != who:
            raise HTTPException(403, '본인이 쓴 댓글만 지울 수 있습니다.')
        conn.execute('DELETE FROM songComments WHERE "id"=%s', (comment_id,))
        conn.commit()
        return {'ok': True}
    finally:
        conn.close()
