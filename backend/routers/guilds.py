"""길드. 이름·색·엠블럼·슬로건은 팀장이 정하고, 명단은 누구나 고친다."""
import re

from fastapi import APIRouter, HTTPException

from db import get_db

router = APIRouter()

SLUG_RE = re.compile(r'^[a-z0-9][a-z0-9-]{1,30}$')
EDITABLE = ('name', 'leader', 'slogan', 'recruitNote', 'color', 'emblem')
TEXT_MAX = {'name': 30, 'leader': 20, 'slogan': 60, 'recruitNote': 200, 'color': 20, 'emblem': 8}


def _clean(key, value):
    if value is None:
        return None
    return str(value).strip()[:TEXT_MAX[key]] or None


def _members_for(conn, guilds):
    for g in guilds:
        g['members'] = []
    ids = [g['id'] for g in guilds]
    if not ids:
        return
    ph = ','.join('%s' for _ in ids)
    by_guild = {}
    for m in conn.execute(
        f'SELECT * FROM guildMembers WHERE "guildId" IN ({ph}) ORDER BY "id"', ids
    ).fetchall():
        by_guild.setdefault(m['guildId'], []).append(dict(m))
    for g in guilds:
        g['members'] = by_guild.get(g['id'], [])


def _get(conn, slug):
    row = conn.execute('SELECT * FROM guilds WHERE "slug"=%s', (slug,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(404, '길드를 찾을 수 없습니다.')
    g = dict(row)
    _members_for(conn, [g])
    return g


@router.get('')
def list_guilds():
    conn = get_db()
    guilds = [dict(r) for r in conn.execute('SELECT * FROM guilds ORDER BY "createdAt"').fetchall()]
    _members_for(conn, guilds)
    conn.close()
    return guilds


@router.post('')
def create_guild(body: dict):
    slug = (body.get('slug') or '').strip().lower()
    name = _clean('name', body.get('name'))
    if not name:
        raise HTTPException(400, 'name은 필수입니다.')
    if not SLUG_RE.match(slug):
        raise HTTPException(400, 'slug는 영문 소문자·숫자·하이픈 2~31자입니다.')
    conn = get_db()
    if conn.execute('SELECT 1 FROM guilds WHERE "slug"=%s', (slug,)).fetchone():
        conn.close()
        raise HTTPException(409, '이미 쓰는 주소입니다.')
    conn.execute(
        'INSERT INTO guilds ("slug","name","leader","slogan","recruitNote","color","emblem","createdBy") '
        'VALUES (%s,%s,%s,%s,%s,%s,%s,%s)',
        (slug, name, _clean('leader', body.get('leader')), _clean('slogan', body.get('slogan')),
         _clean('recruitNote', body.get('recruitNote')), _clean('color', body.get('color')),
         _clean('emblem', body.get('emblem')), body.get('createdBy')),
    )
    conn.commit()
    g = _get(conn, slug)
    conn.close()
    return g


@router.get('/{slug}')
def get_guild(slug: str):
    conn = get_db()
    g = _get(conn, slug)
    conn.close()
    return g


@router.put('/{slug}')
def update_guild(slug: str, body: dict):
    fields = []
    values = []
    for key in EDITABLE:
        if key in body:
            fields.append(f'"{key}"=%s')
            values.append(_clean(key, body[key]))
    if not fields:
        raise HTTPException(400, '수정할 내용이 없습니다.')
    fields.append('"updatedAt"=now()')
    values.append(slug)
    conn = get_db()
    cur = conn.execute(f'UPDATE guilds SET {", ".join(fields)} WHERE "slug"=%s', values)
    conn.commit()
    if cur.rowcount == 0:
        conn.close()
        raise HTTPException(404, '길드를 찾을 수 없습니다.')
    g = _get(conn, slug)
    conn.close()
    return g


@router.delete('/{slug}')
def delete_guild(slug: str):
    """길드를 지워도 곡과 일정은 남고 소속만 풀린다 (ON DELETE SET NULL)."""
    conn = get_db()
    cur = conn.execute('DELETE FROM guilds WHERE "slug"=%s', (slug,))
    conn.commit()
    conn.close()
    if cur.rowcount == 0:
        raise HTTPException(404, '길드를 찾을 수 없습니다.')
    return {'ok': True}


@router.post('/{slug}/members')
def add_member(slug: str, body: dict):
    nickname = (body.get('nickname') or '').strip()[:20]
    role = (body.get('role') or '').strip()[:20]
    if not nickname or not role:
        raise HTTPException(400, 'nickname과 role은 필수입니다.')
    conn = get_db()
    g = _get(conn, slug)
    conn.execute(
        'INSERT INTO guildMembers ("guildId","nickname","role") VALUES (%s,%s,%s) ON CONFLICT DO NOTHING',
        (g['id'], nickname, role),
    )
    conn.commit()
    g = _get(conn, slug)
    conn.close()
    return g


@router.delete('/{slug}/members/{member_id}')
def remove_member(slug: str, member_id: int):
    conn = get_db()
    g = _get(conn, slug)
    cur = conn.execute('DELETE FROM guildMembers WHERE "id"=%s AND "guildId"=%s', (member_id, g['id']))
    conn.commit()
    if cur.rowcount == 0:
        conn.close()
        raise HTTPException(404, '명단에 없는 사람입니다.')
    g = _get(conn, slug)
    conn.close()
    return g
