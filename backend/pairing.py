# 두 아이패드 페어링.
# 페어 하나 = 코드 하나 = {보는 악보(sheetId), 펼침 위치(spread)} 상태 하나.
# 상태는 DB에 저장해 서버가 재시작(Render 슬립)해도 살아남고,
# 접속 중인 기기 사이의 실시간 중계는 메모리의 방(room)으로 한다.

import secrets

from db import get_db

# 헷갈리는 글자(I/L/O/0/1)를 뺀 알파벳. QR을 못 쓸 때 손으로도 칠 수 있게.
CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
CODE_LEN = 6

_rooms = {}   # code -> set[WebSocket]. asyncio 단일 루프에서만 만지므로 락이 필요 없다.


# ---------- DB 상태 ----------
def create_pair():
    conn = get_db()
    while True:
        code = ''.join(secrets.choice(CODE_ALPHABET) for _ in range(CODE_LEN))
        cur = conn.execute(
            'INSERT INTO pairs ("code") VALUES (%s) ON CONFLICT ("code") DO NOTHING', (code,)
        )
        if cur.rowcount:
            break
    conn.commit()
    conn.close()
    return code


def get_state(code):
    """페어 상태 + (있으면) 악보 제목·쪽수. 재접속한 기기가 바로 따라잡을 수 있게."""
    conn = get_db()
    row = conn.execute(
        'SELECT p."code", p."sheetId", p."spread", s."title", s."pages" '
        'FROM pairs p LEFT JOIN sheets s ON s."id" = p."sheetId" '
        'WHERE p."code"=%s',
        (code,),
    ).fetchone()
    conn.close()
    return dict(row) if row else None


def set_state(code, sheet_id, spread):
    conn = get_db()
    cur = conn.execute(
        'UPDATE pairs SET "sheetId"=%s, "spread"=%s, "updatedAt"=now() WHERE "code"=%s',
        (sheet_id, spread, code),
    )
    conn.commit()
    conn.close()
    return cur.rowcount > 0


def delete_pair(code):
    conn = get_db()
    cur = conn.execute('DELETE FROM pairs WHERE "code"=%s', (code,))
    conn.commit()
    conn.close()
    return cur.rowcount > 0


# ---------- 접속 방 ----------
def join(code, ws):
    _rooms.setdefault(code, set()).add(ws)


def leave(code, ws):
    room = _rooms.get(code)
    if room:
        room.discard(ws)
        if not room:
            _rooms.pop(code, None)


def peer_count(code):
    return len(_rooms.get(code, ()))


async def broadcast(code, payload, sender=None):
    """방의 모든(보낸 쪽 제외) 기기에 보낸다. 끊긴 소켓은 조용히 넘긴다."""
    for ws in list(_rooms.get(code, ())):
        if ws is sender:
            continue
        try:
            await ws.send_json(payload)
        except Exception:
            pass
