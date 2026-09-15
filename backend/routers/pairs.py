"""두 아이패드 페어링. HTTP 는 /api/pairs, 실시간 중계는 /ws/pair 라 prefix 없이 전체 경로를 쓴다."""
import asyncio

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect

import pairing

router = APIRouter()


@router.post('/api/pairs')
def create_pair():
    return {'code': pairing.create_pair()}


@router.delete('/api/pairs/{code}')
def delete_pair(code: str):
    if not pairing.delete_pair(code):
        raise HTTPException(404, '페어를 찾을 수 없습니다.')
    return {'ok': True}


@router.websocket('/ws/pair/{code}')
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
