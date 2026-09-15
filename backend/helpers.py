"""라우터들이 같이 쓰는 작은 도구. 곡 묶기, 태그 정규화, 길드 해석."""
from fastapi import HTTPException

GUILD_BRIEF = ('id', 'slug', 'name', 'color', 'emblem')


def like_escape(text):
    """LIKE/ILIKE 패턴에서 %, _ 가 와일드카드로 해석되지 않게 이스케이프한다."""
    return text.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_')


def body_ids(body):
    try:
        ids = [int(i) for i in (body.get('ids') or [])]
    except (TypeError, ValueError):
        raise HTTPException(400, 'ids가 올바르지 않습니다.')
    if not ids:
        raise HTTPException(400, '대상이 없습니다.')
    return ids


def norm_tag(value):
    """태그는 한 곡(악보)에 하나다. 예전 데이터가 쉼표로 여러 개를 갖고 있으면
    첫 번째만 남긴다. 빈 값은 None 으로 저장해 '태그 없음'과 구분되지 않게 한다."""
    if not value:
        return None
    first = str(value).split(',')[0].strip()
    return first or None


def guild_brief(row):
    if not row:
        return None
    return {k: row[k] for k in GUILD_BRIEF}


def resolve_guild_id(conn, body):
    """요청 본문의 guildId 또는 guildSlug 를 길드 id 로 바꾼다.
    둘 다 없거나 빈 값이면 None(소속 없음 = 전체)."""
    gid = body.get('guildId')
    slug = (body.get('guildSlug') or '').strip()
    if gid in (None, '', 0) and not slug:
        return None
    if slug:
        row = conn.execute('SELECT "id" FROM guilds WHERE "slug"=%s', (slug,)).fetchone()
    else:
        row = conn.execute('SELECT "id" FROM guilds WHERE "id"=%s', (int(gid),)).fetchone()
    if not row:
        raise HTTPException(404, '길드를 찾을 수 없습니다.')
    return row['id']


def guild_where(conn, guild, column='"guildId"'):
    """목록 API 의 guild 파라미터를 WHERE 조각으로.
    없음 → 전체, 'none' → 소속 없음만, 그 외 → 그 slug 의 것만."""
    if not guild:
        return '', []
    if guild == 'none':
        return f' WHERE {column} IS NULL', []
    row = conn.execute('SELECT "id" FROM guilds WHERE "slug"=%s', (guild,)).fetchone()
    if not row:
        raise HTTPException(404, '길드를 찾을 수 없습니다.')
    return f' WHERE {column}=%s', [row['id']]


def attach_guilds(conn, rows):
    """guildId 를 가진 dict 목록에 guild 요약을 붙인다."""
    ids = list({r['guildId'] for r in rows if r.get('guildId')})
    found = {}
    if ids:
        ph = ','.join('%s' for _ in ids)
        for g in conn.execute(f'SELECT * FROM guilds WHERE "id" IN ({ph})', ids).fetchall():
            found[g['id']] = guild_brief(g)
    for r in rows:
        r['guild'] = found.get(r.get('guildId'))
    return rows


def build_songs(conn, song_rows):
    """곡 행 목록에 세션·지원자·길드·마지막 합주일을 붙인다."""
    if not song_rows:
        return []
    songs = [dict(r) for r in song_rows]
    for s in songs:
        s['isCandidate'] = bool(s['isCandidate'])
        s['sessions'] = []
        s['lastPlayed'] = None
    song_ids = [s['id'] for s in songs]
    song_ph = ','.join('%s' for _ in song_ids)

    session_rows = conn.execute(
        f'SELECT * FROM sessions WHERE "songId" IN ({song_ph}) ORDER BY "id"', song_ids
    ).fetchall()
    sessions = [dict(r) for r in session_rows]
    for s in sessions:
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

    # 마지막으로 합주한 날 — 확정 일정의 셋리스트에서 가장 늦은 날짜
    last = {}
    for r in conn.execute(
        f'SELECT es."songId", MAX(e."date") AS "last" FROM eventSongs es '
        f'JOIN events e ON e."id"=es."eventId" '
        f'WHERE es."songId" IN ({song_ph}) AND e."status"=%s AND e."date" IS NOT NULL '
        f'GROUP BY es."songId"', song_ids + ['confirmed']
    ).fetchall():
        last[r['songId']] = r['last']
    for s in songs:
        s['lastPlayed'] = last.get(s['id'])

    attach_guilds(conn, songs)
    return songs
