"""길드 테마 한 곳 — 고를 수 있는 목록과, 슬러그→테마 캐시.

두 파일이 이 값을 쓴다.
  main.py            HTML 을 내려줄 때 <html data-theme="…"> 을 박으려고 읽는다.
  routers/guilds.py  꾸미기를 저장할 때 검증하고, 캐시를 비운다.

값을 둘 중 한쪽에 두면 서로를 import 해야 해서 순환이 된다. 그래서 어느 쪽도 아닌
여기에 둔다. 이 파일은 db 만 본다.

캐시를 TTL 로 두지 않는 이유: 테마를 바꾼 직후 한 번은 옛 테마로 그려지는데,
그 번쩍임을 없애려고 만든 장치가 스스로 번쩍임을 만드는 꼴이 된다. 실제로 그랬다.
바뀌는 곳이 PUT /guilds/{slug} 하나뿐이므로 거기서 비우는 편이 확실하다.
"""
from db import get_db

# frontend/common/themes.css 와 frontend/common/common.js 의 THEMES 를 따라간다.
# 한쪽만 고치면 화면에서는 고를 수 있는데 서버가 버리는 상태가 된다.
THEMES = {'takeoff', 'miku', 'melody', 'city', 'temple', 'wood', 'nature', 'medieval', 'sea', 'deepsea'}

_CACHE: dict[str, str] | None = None


def cache_clear():
    """꾸미기가 저장될 때 routers/guilds.py 가 부른다."""
    global _CACHE
    _CACHE = None


def theme_of(slug: str) -> str | None:
    """이 길드가 고른 테마. 안 골랐으면 None.

    길드가 열몇 개라 통째로 메모리에 얹는다. 슬러그 하나를 물어도 전부 담아 둔다."""
    global _CACHE
    if _CACHE is None:
        conn = get_db()
        try:
            rows = conn.execute('SELECT "slug", "style" FROM guilds').fetchall()
        finally:
            conn.close()
        cache = {}
        for r in rows:
            style = r['style'] if isinstance(r['style'], dict) else None
            name = (style or {}).get('theme')
            if name in THEMES:
                cache[r['slug']] = name
        _CACHE = cache
    return _CACHE.get(slug)
