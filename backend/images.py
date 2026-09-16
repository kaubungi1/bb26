"""사진 한 장을 화면에 올릴 수 있는 크기로 줄인다.

멤버 프로필 사진과 길드 문장이 같은 규칙을 쓴다. 전에는 members.py 안에만 있어서
길드가 쓰려면 복사해야 했다 — 복사하면 한쪽만 고쳐질 자리가 생긴다.

전체 구도를 유지한 채 투명한 정사각 캔버스에 맞춘다. 잘라 내지 않는다 —
무엇을 남길지는 화면의 자르기 창(crop.js)에서 사용자가 이미 정했다.
"""
import io

from fastapi import HTTPException
from PIL import Image, ImageOps

SIDE = 256                 # 무대에 서는 캐릭터도, 길드 문장도 이보다 크게 볼 일이 없다
MAX_UPLOAD = 8 * 1024 * 1024
MAX_STORED = 200 * 1024


def square_webp(data):
    """전체 구도를 유지해 투명한 256px 캔버스에 맞춘다."""
    try:
        im = Image.open(io.BytesIO(data))
        im = ImageOps.exif_transpose(im)
        im = im.convert('RGBA') if im.mode in ('RGBA', 'LA', 'P') else im.convert('RGB')
    except Exception:
        raise HTTPException(400, '이미지 파일이 아닙니다.')
    im = ImageOps.contain(im, (SIDE, SIDE), method=Image.LANCZOS)
    canvas = Image.new('RGBA', (SIDE, SIDE), (0, 0, 0, 0))
    canvas.paste(im, ((SIDE - im.width) // 2, (SIDE - im.height) // 2))
    im = canvas
    for q in (85, 70, 55, 40):
        buf = io.BytesIO()
        im.save(buf, 'WEBP', quality=q, method=4)
        if buf.tell() <= MAX_STORED:
            return buf.getvalue()
    return buf.getvalue()
