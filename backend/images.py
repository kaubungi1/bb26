"""사진 한 장을 화면에 올릴 수 있는 크기로 줄인다.

멤버 프로필 사진과 길드 문장이 같은 규칙을 쓴다.

원칙(2026-10-30): **자르지 않는다.** 비율 그대로 긴 변 512px 로만 줄여 저장하고,
원·육각 같은 모양은 보여 줄 때 CSS/SVG 마스크로 씌운다. 전에는 화면(crop.js)이 올릴 때
육각·원으로 잘라 보냈고 서버는 그것만 저장해서, 나중에 네모로 쓰려 하니 원본이 없었다.
그래서 2026-10-30 이전에 올린 그림은 모서리가 투명한 육각/원이다 — 다시 올리면 원본이 된다.
"""
import io

from fastapi import HTTPException
from PIL import Image, ImageOps

SIDE = 512                 # 긴 변. 길드 홈 머리·프로필 크게 보기까지 이 정도면 된다
MAX_UPLOAD = 8 * 1024 * 1024
MAX_STORED = 300 * 1024


def fit_webp(data):
    """비율 그대로 긴 변 SIDE 안에 들어오게만 줄인다. 캔버스를 덧대지도, 자르지도 않는다. 알파는 그대로."""
    try:
        im = Image.open(io.BytesIO(data))
        im = ImageOps.exif_transpose(im)
        im = im.convert('RGBA') if im.mode in ('RGBA', 'LA', 'P') else im.convert('RGB')
    except Exception:
        raise HTTPException(400, '이미지 파일이 아닙니다.')
    if im.width > SIDE or im.height > SIDE:
        im = ImageOps.contain(im, (SIDE, SIDE), method=Image.LANCZOS)
    for q in (85, 70, 55, 40):
        buf = io.BytesIO()
        im.save(buf, 'WEBP', quality=q, method=4)
        if buf.tell() <= MAX_STORED:
            return buf.getvalue()
    return buf.getvalue()
