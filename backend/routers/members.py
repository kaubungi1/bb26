"""멤버 프로필. 닉네임이 열쇠이고, 본인이 자기 카드를 꾸민다. 권한 확인은 없다."""
from fastapi import APIRouter, HTTPException

from db import get_db

router = APIRouter()

EDITABLE = ('mainRoles', 'availability', 'intro', 'color', 'avatar', 'title', 'status')
TEXT_MAX = {'mainRoles': 60, 'availability': 80, 'intro': 200, 'color': 20, 'avatar': 8, 'title': 30, 'status': 60}
NICK_MAX = 20


def _clean(key, value):
    if value is None:
        return None
    return str(value).strip()[:TEXT_MAX[key]] or None


@router.get('')
def list_members():
    conn = get_db()
    rows = [dict(r) for r in conn.execute('SELECT * FROM members ORDER BY "nickname"').fetchall()]
    # 길드 소속도 같이 내려준다 — 카드에 소속 배지를 달기 위해
    by_nick = {}
    for m in conn.execute(
        'SELECT gm."nickname", gm."role", g."slug", g."name", g."color" FROM guildMembers gm '
        'JOIN guilds g ON g."id"=gm."guildId" ORDER BY gm."id"'
    ).fetchall():
        by_nick.setdefault(m['nickname'], []).append(dict(m))
    for r in rows:
        r['guilds'] = by_nick.get(r['nickname'], [])
    conn.close()
    return rows


@router.get('/{nickname}')
def get_member(nickname: str):
    conn = get_db()
    row = conn.execute('SELECT * FROM members WHERE "nickname"=%s', (nickname,)).fetchone()
    conn.close()
    if not row:
        raise HTTPException(404, '멤버를 찾을 수 없습니다.')
    return dict(row)


@router.put('/{nickname}')
def upsert_member(nickname: str, body: dict):
    nickname = nickname.strip()
    if not nickname or len(nickname) > NICK_MAX:
        raise HTTPException(400, f'닉네임은 1~{NICK_MAX}자입니다.')
    cols = ['"nickname"']
    vals = [nickname]
    sets = []
    for key in EDITABLE:
        if key in body:
            cols.append(f'"{key}"')
            vals.append(_clean(key, body[key]))
            sets.append(f'"{key}"=EXCLUDED."{key}"')
    sets.append('"updatedAt"=now()')
    ph = ','.join('%s' for _ in vals)
    conn = get_db()
    conn.execute(
        f'INSERT INTO members ({", ".join(cols)}) VALUES ({ph}) '
        f'ON CONFLICT ("nickname") DO UPDATE SET {", ".join(sets)}',
        vals,
    )
    conn.commit()
    row = conn.execute('SELECT * FROM members WHERE "nickname"=%s', (nickname,)).fetchone()
    conn.close()
    return dict(row)


@router.delete('/{nickname}')
def delete_member(nickname: str):
    conn = get_db()
    cur = conn.execute('DELETE FROM members WHERE "nickname"=%s', (nickname,))
    conn.commit()
    conn.close()
    if cur.rowcount == 0:
        raise HTTPException(404, '멤버를 찾을 수 없습니다.')
    return {'ok': True}
