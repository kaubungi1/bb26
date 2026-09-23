"""그림(자켓·멤버 사진·길드 문장)의 주소와 응답을 한 곳에서.

전에는 그림을 줄 때마다 DB 에서 원본을 꺼냈다. 브라우저가 "그대로냐"고만 물어도(304)
ETag 를 만들려고 원본을 읽었다. Neon 전송 한도(월 5GB)를 넘긴 원인 가운데 하나다.

이제는 이렇게 한다.
  주소에 버전을 붙인다    /api/songs/12/thumb?v=<버전>. 그림이 바뀌면 버전이 바뀌어 주소가 바뀐다.
                          그래서 브라우저가 한 달 동안 묻지 않고 써도 틀릴 일이 없다.
  서버는 메모리에 둔다    재시작 뒤 그림마다 처음 한 번만 DB 에서 읽는다. 사용자·기기가 늘어도
                          Neon 전송은 늘지 않는다. 배포·재시작 때 비워지므로 서버 쪽에 낡은 것이 남지 않는다.
  버전이 맞으면 DB 도 안 본다  요청의 v 가 메모리에 든 버전과 같으면 그대로 준다.
                          다르거나 v 가 없으면 DB 에서 버전(몇 바이트)만 확인하고, 바뀐 때만 원본을 읽는다.
  바꾸거나 지우면 잊는다  위의 지름길 때문에, 사진을 지운 뒤에도 옛 주소로 오면 메모리 사본이 나갔다
                          (2026-09-23 검증에서 발견). 그림을 바꾸거나 지우는 곳은 반드시 forget() 을 부른다.
                          members.py·guilds.py 의 사진 올리기·빼기·삭제, songs.py 의 곡 삭제, thumbs.remember.
                          배포 중 겹침 구간에 '다른' 서버가 지운 것은 여기서 알 수 없다 — 재시작 때 비워진다.

버전은 그림이 바뀔 때만 바뀌는 값이다. 사진은 imageUpdatedAt, 자켓은 유튜브 영상 id.
화면은 주소를 스스로 만들지 않고 API 가 주는 thumbUrl·imageUrl 을 쓴다 — 규칙이 여기 한 곳에만 있다.
"""
import threading
from collections import OrderedDict
from urllib.parse import quote

from fastapi import HTTPException, Request, Response

from db import get_db

# 저장된 그림을 일괄로 다시 만들 때(크기·화질을 바꿔 전부 재처리) 올린다.
# 그러면 모든 주소가 한 번에 바뀌어 브라우저가 새 그림을 받는다. 올리지 않으면 최대 한 달 옛 그림이 보인다.
IMAGE_REV = 1
LONG_CACHE = 30 * 24 * 3600      # 버전이 붙은 주소. 잊어도 한 달이면 자연히 바뀐다
CACHE_MAX_BYTES = 48 * 1024 * 1024  # 자켓 213장이 10.6MB. 악보 렌더 캐시(128MB)와 합쳐도 512MB 안에 넉넉하다

_lock = threading.Lock()
_cache = OrderedDict()           # (종류, 키) -> (버전, bytes)
_cache_bytes = 0


# ---------- 버전과 주소 ----------
def stamp_version(ts):
    """imageUpdatedAt -> 버전. 같은 초에 두 번 올려도 갈리도록 마이크로초까지 쓴다."""
    if ts is None:
        return None
    return f'{int(ts.timestamp() * 1_000_000)}.{IMAGE_REV}'


def thumb_version(video_id):
    return f'{video_id or "x"}.{IMAGE_REV}'


def thumb_url(song_id, video_id):
    return f'/api/songs/{song_id}/thumb?v={thumb_version(video_id)}'


def member_image_url(nickname, image_updated_at):
    v = stamp_version(image_updated_at)
    return f'/api/members/{quote(nickname, safe="")}/image?v={v}' if v else None


def crest_url(slug, image_updated_at):
    v = stamp_version(image_updated_at)
    return f'/api/guilds/{quote(slug, safe="")}/image?v={v}' if v else None


def with_member_image(m):
    """멤버 행(dict)에 imageUrl 을 단다. 버전 재료인 imageUpdatedAt 은 화면에 필요 없어 뺀다."""
    ts = m.pop('imageUpdatedAt', None)
    m['imageUrl'] = member_image_url(m['nickname'], ts) if m.get('hasImage') else None
    return m


def with_crest(g):
    """길드 행(dict)에 imageUrl 을 단다."""
    ts = g.pop('imageUpdatedAt', None)
    g['imageUrl'] = crest_url(g['slug'], ts) if g.get('hasImage') else None
    return g


def stamp_or_legacy(has_image, ts):
    """GET 쪽 버전. 사진은 있는데 imageUpdatedAt 이 비어 있는 옛 행은 고정 버전을 쓴다
    (그런 행은 주소에 v 가 없으니 브라우저가 매번 묻는다 — 틀리지는 않는다)."""
    if not has_image:
        return None
    return stamp_version(ts) or f'legacy.{IMAGE_REV}'


# ---------- 메모리 ----------
def _get(key):
    with _lock:
        hit = _cache.get(key)
        if hit is not None:
            _cache.move_to_end(key)
        return hit


def _put(key, version, data):
    global _cache_bytes
    with _lock:
        old = _cache.pop(key, None)
        if old is not None:
            _cache_bytes -= len(old[1])
        _cache[key] = (version, data)
        _cache_bytes += len(data)
        while _cache_bytes > CACHE_MAX_BYTES and _cache:
            _, (_, dropped) = _cache.popitem(last=False)
            _cache_bytes -= len(dropped)


def _drop(key):
    global _cache_bytes
    with _lock:
        old = _cache.pop(key, None)
        if old is not None:
            _cache_bytes -= len(old[1])


# ---------- 응답 ----------
def _reply(request, key, version, data, media_type, private):
    etag = f'"{key[0]}-{version}"'
    # 요청 주소의 버전이 지금 버전과 같을 때만 오래 두게 한다. 버전 없는 옛 주소는 매번 묻게 한다.
    if request.query_params.get('v') == version:
        cache = f'{"private" if private else "public"}, max-age={LONG_CACHE}'
    else:
        cache = 'no-cache'
    headers = {'ETag': etag, 'Cache-Control': cache}
    if request.headers.get('if-none-match') == etag:
        return Response(status_code=304, headers=headers)
    headers['Content-Length'] = str(len(data))
    return Response(content=data, media_type=media_type, headers=headers)


def serve(request: Request, kind, key, version_of, load, media_type, missing, private=False):
    """kind: 'thumb'|'member'|'crest'.  key: 곡 id·닉네임·슬러그.
    version_of(conn) -> 지금 버전, 그림이 없으면 None.   load(conn) -> bytes, 없으면 None.
    missing: 그림이 없을 때의 404 문구."""
    ck = (kind, key)
    v = request.query_params.get('v')
    hit = _get(ck)
    if hit is not None and v and hit[0] == v:
        return _reply(request, ck, hit[0], hit[1], media_type, private)

    conn = get_db()
    try:
        version = version_of(conn)
        if version is None:
            _drop(ck)
            raise HTTPException(404, missing)
        if hit is not None and hit[0] == version:
            return _reply(request, ck, version, hit[1], media_type, private)
        # 브라우저가 이미 이 버전을 갖고 있으면 원본을 읽지 않는다.
        if request.headers.get('if-none-match') == f'"{kind}-{version}"':
            return _reply(request, ck, version, b'', media_type, private)
        data = load(conn)
    finally:
        conn.close()
    if not data:
        _drop(ck)
        raise HTTPException(404, missing)
    data = bytes(data)
    _put(ck, version, data)
    return _reply(request, ck, version, data, media_type, private)


def forget(kind, key):
    """그림을 바꾸거나 지웠을 때 메모리 사본을 버린다. kind: 'thumb'|'member'|'crest'."""
    _drop((kind, key))


def stats():
    with _lock:
        return {'entries': len(_cache), 'bytes': _cache_bytes}
