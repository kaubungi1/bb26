"""자켓 그림. 유튜브 섬네일을 한 번 받아 두고 우리가 직접 준다.

받는 시점은 하나다. 이미지를 처음 보여줄 때다.
곡을 만들거나 고칠 때는 영상 id 만 적어 둔다. 그래야 등록이 기다리지 않는다.
주소가 바뀌면 저장분을 비운다. 다음에 누가 보는 순간 새 섬네일로 채워진다.
실패해도 저장하지 않으므로 다음 요청 때 자연히 다시 시도한다.
"""
import io
import re
import urllib.error
import urllib.request

from PIL import Image

import imageserve

# 큰 것부터 시도한다. maxres 가 없는 영상이 많아 순서대로 떨어진다.
SIZES = ('maxresdefault.jpg', 'sddefault.jpg', 'hqdefault.jpg')
UA = {'User-Agent': 'Mozilla/5.0 (compatible; bulbeobiryuk/1.0)'}
TIMEOUT = 12
# 유튜브는 없는 크기를 요청하면 120x90 회색 자리표시자를 준다. 그건 섬네일이 아니다.
MIN_BYTES = 3000
# 자켓은 화면에 260px 로 그려진다. 1280x720 원본을 그대로 두면 장당 100KB 라
# 넘길 때마다 받느라 끊긴다. 화면에 필요한 크기로 줄여 저장한다.
BOX = (854, 480)
QUALITY = 80


def shrink(data: bytes) -> bytes:
    """자켓에 필요한 크기로 줄인다. 실패하면 원본을 그대로 쓴다."""
    try:
        im = Image.open(io.BytesIO(data))
        im = im.convert('RGB')
        im.thumbnail(BOX, Image.LANCZOS)
        buf = io.BytesIO()
        im.save(buf, 'JPEG', quality=QUALITY, optimize=True, progressive=True)
        out = buf.getvalue()
        return out if len(out) < len(data) else data
    except Exception:
        return data


def video_id(url: str | None) -> str | None:
    """유튜브 주소에서 11자 영상 id 를 뽑는다. 못 뽑으면 None."""
    m = re.search(r'(?:v=|youtu\.be/|/embed/|/shorts/)([A-Za-z0-9_-]{11})', url or '')
    return m.group(1) if m else None


def fetch(vid: str) -> bytes | None:
    """가장 큰 섬네일을 받는다. 전부 실패하면 None."""
    for size in SIZES:
        try:
            req = urllib.request.Request(f'https://img.youtube.com/vi/{vid}/{size}', headers=UA)
            with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
                data = r.read()
            if len(data) >= MIN_BYTES:
                return shrink(data)
        except (urllib.error.HTTPError, urllib.error.URLError, OSError):
            continue
    return None


def remember(conn, song_id: int, url: str | None, previous: str | None = None) -> None:
    """곡을 만들거나 고칠 때 부른다. 영상 id 만 적고 이미지는 받지 않는다.
       주소가 달라졌으면 저장돼 있던 그림을 비워 다음 요청 때 새로 받게 한다."""
    vid = video_id(url)
    if vid == previous:
        return
    imageserve.forget('thumb', song_id)      # 서버 메모리의 옛 자켓을 버린다
    conn.execute(
        'UPDATE songs SET "thumbVideoId"=%s, thumb=NULL, "thumbUpdatedAt"=NULL WHERE "id"=%s',
        (vid, song_id),
    )


def ensure(conn, song_id: int) -> bytes | None:
    """저장된 그림을 준다. 없으면 그 자리에서 받아 저장하고 준다."""
    row = conn.execute(
        'SELECT thumb, "thumbVideoId" vid, "youtubeUrl" url FROM songs WHERE "id"=%s',
        (song_id,),
    ).fetchone()
    if row is None:
        return None
    if row['thumb']:
        return bytes(row['thumb'])

    vid = row['vid'] or video_id(row['url'])
    if not vid:
        return None
    data = fetch(vid)
    if not data:
        return None            # 저장하지 않는다. 다음 요청 때 다시 시도한다.
    conn.execute(
        'UPDATE songs SET thumb=%s, "thumbVideoId"=%s, "thumbUpdatedAt"=now() WHERE "id"=%s',
        (data, vid, song_id),
    )
    conn.commit()
    return data


def warm(song_id: int) -> None:
    """곡을 만들거나 주소를 고친 직후 배경에서 부른다.
       응답은 이미 나갔으므로 여기서 느려도 사용자는 기다리지 않는다.
       실패해도 아무 일도 하지 않는다. ensure() 가 다음 요청 때 다시 시도한다."""
    from db import get_db
    conn = get_db()
    try:
        ensure(conn, song_id)
    except Exception:
        conn.rollback()        # 배경 작업이라 예외를 밖으로 올려봐야 받을 곳이 없다
    finally:
        conn.close()
