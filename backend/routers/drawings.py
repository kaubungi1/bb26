"""길드 배경 낙서.

다 같이 한 벽에 그리고, 지우는 것은 자기 줄뿐이다. 한 사람이 한 길드에 한 장이고
다시 그리면 자기 줄을 덮어쓴다.

좌표는 1600x1000 고정 캔버스 기준이다. 화면 폭에 맞춰 늘려 그리므로 누가 어떤
기기에서 봐도 같은 그림이 나온다. 뷰포트 좌표로 저장하면 사람마다 다른 그림이 된다.

로그인이 없어 닉네임은 자기 신고다. 그래서 이 확인은 보안이 아니라 실수 방지다 —
사이트의 다른 기능과 같은 수준이다(꾸미기·명단도 마찬가지).
"""
import json
import re

from fastapi import APIRouter, HTTPException
from psycopg.types.json import Json

from db import get_db

router = APIRouter()

CANVAS_W, CANVAS_H = 1600, 1000
MAX_STROKES = 200          # 한 사람이 그을 수 있는 획
MAX_POINTS = 400           # 획 하나의 점
MAX_BYTES = 60 * 1024      # 한 장의 JSON 크기
MIN_WIDTH, MAX_WIDTH = 1, 24
HEX_RE = re.compile(r'^#[0-9a-fA-F]{6}$')
PAD = 60                   # 캔버스 밖으로 이만큼은 삐져나가도 받는다


def _num(v, lo, hi):
    if not isinstance(v, (int, float)) or isinstance(v, bool):
        return None
    if v != v or v in (float('inf'), float('-inf')):     # NaN, 무한대
        return None
    return round(max(lo, min(hi, float(v))), 1)


def _clean_strokes(value):
    """받아들이는 모양만 남긴다. 하나라도 어긋나면 그 획을 버린다.

    자유 값을 그대로 넣으면 화면의 stroke 속성으로 들어가므로 색은 목록 검사를 한다."""
    if not isinstance(value, list):
        raise HTTPException(400, '그림 형식이 올바르지 않습니다.')
    out = []
    for s in value[:MAX_STROKES]:
        if not isinstance(s, dict):
            continue
        color = str(s.get('c') or '')
        if not HEX_RE.match(color):
            continue
        width = s.get('w')
        if not isinstance(width, (int, float)) or isinstance(width, bool):
            continue
        width = int(max(MIN_WIDTH, min(MAX_WIDTH, width)))
        pts = s.get('p')
        if not isinstance(pts, list) or len(pts) < 1:
            continue
        clean = []
        for pt in pts[:MAX_POINTS]:
            if not isinstance(pt, list) or len(pt) != 2:
                continue
            x = _num(pt[0], -PAD, CANVAS_W + PAD)
            y = _num(pt[1], -PAD, CANVAS_H + PAD)
            if x is None or y is None:
                continue
            clean.append([x, y])
        if len(clean) < 1:
            continue
        out.append({'c': color, 'w': width, 'p': clean})
    size = len(json.dumps(out, separators=(',', ':')).encode('utf-8'))
    if size > MAX_BYTES:
        raise HTTPException(400, f'그림이 너무 큽니다. {MAX_BYTES // 1024}KB 아래로 줄여주세요.')
    return out


def _guild_id(conn, slug):
    row = conn.execute('SELECT "id" FROM guilds WHERE "slug"=%s', (slug,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(404, '길드를 찾을 수 없습니다.')
    return row['id']


def _require_member(conn, gid, nickname):
    if not nickname:
        conn.close()
        raise HTTPException(400, '닉네임이 필요합니다.')
    row = conn.execute(
        'SELECT 1 FROM guildMembers WHERE "guildId"=%s AND "nickname"=%s LIMIT 1',
        (gid, nickname)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(403, '길드원만 그릴 수 있습니다.')


@router.get('/{slug}/drawings')
def list_drawings(slug: str):
    """이 길드 벽에 그려진 것 전부. 누가 그렸는지가 같이 온다 — 화면이 자기 것만 지우게."""
    conn = get_db()
    try:
        gid = _guild_id(conn, slug)
        rows = conn.execute(
            'SELECT "nickname", "strokes", "updatedAt" FROM guildDrawings '
            'WHERE "guildId"=%s ORDER BY "id"', (gid,)).fetchall()
        return [dict(r) for r in rows]
    finally:
        if not conn.closed:
            conn.close()


@router.put('/{slug}/drawings')
def save_drawing(slug: str, body: dict):
    """내 그림 한 장을 덮어쓴다. 빈 배열이면 줄을 지운다."""
    nickname = str(body.get('nickname') or '').strip()
    strokes = _clean_strokes(body.get('strokes'))
    conn = get_db()
    try:
        gid = _guild_id(conn, slug)
        _require_member(conn, gid, nickname)
        if not strokes:
            conn.execute('DELETE FROM guildDrawings WHERE "guildId"=%s AND "nickname"=%s',
                         (gid, nickname))
        else:
            conn.execute(
                'INSERT INTO guildDrawings ("guildId","nickname","strokes") VALUES (%s,%s,%s) '
                'ON CONFLICT ("guildId","nickname") DO UPDATE '
                'SET "strokes"=EXCLUDED."strokes", "updatedAt"=now()',
                (gid, nickname, Json(strokes)))
        conn.commit()
        return {'nickname': nickname, 'strokes': strokes}
    finally:
        if not conn.closed:
            conn.close()


@router.delete('/{slug}/drawings/{nickname}')
def delete_drawing(slug: str, nickname: str):
    """내 그림을 통째로 지운다. 화면은 자기 것에만 이 버튼을 내준다."""
    conn = get_db()
    try:
        gid = _guild_id(conn, slug)
        cur = conn.execute('DELETE FROM guildDrawings WHERE "guildId"=%s AND "nickname"=%s',
                           (gid, nickname.strip()))
        conn.commit()
        return {'deleted': cur.rowcount}
    finally:
        if not conn.closed:
            conn.close()
