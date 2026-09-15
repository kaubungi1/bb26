"""악보 PDF를 페이지 이미지로 렌더링한다.

DB(Neon)가 싱가포르에 있어 조회 한 번에 300ms가 걸린다. 페이지를 넘길 때마다
DB를 타면 눈에 띄게 밀리므로, 악보를 처음 열 때 한 번만 꺼내 렌더해두고
그다음부터는 메모리에서 내준다. 악보 41개를 전부 렌더해도 20MB 남짓이다.
"""
import io
import threading
from collections import OrderedDict

import pypdfium2 as pdfium
from PIL import Image, ImageChops

from db import get_db

DEFAULT_WIDTH = 1620          # 10.2인치 세로(CSS 810px) × 화소밀도 2배
MIN_WIDTH = 400
MAX_WIDTH = 2400
WEBP_QUALITY = 80
WEBP_METHOD = 2            # 4는 인코딩이 두 배 느리고 용량 차이는 미미하다
CACHE_MAX_BYTES = 128 * 1024 * 1024
BBOX_PROBE_WIDTH = 400     # 내용 범위를 잴 때 쓰는 저해상도 폭
BBOX_PAD = 0.012           # 가장자리에 음표가 닿지 않게 남기는 여유
BBOX_THRESHOLD = 12        # 이보다 어두우면 내용으로 본다

_lock = threading.Lock()
_cache = OrderedDict()        # (sheetId, page, width) -> bytes
_cache_bytes = 0
_page_counts = {}             # sheetId -> 쪽수
_boxes = {}                   # sheetId -> 잘라낼 범위 (l, t, r, b) 비율

# PDFium은 스레드 안전하지 않다. 요청 스레드풀과 워밍 스레드가 겹치면
# 세그폴트가 날 수 있으므로 PDFium을 만지는 구간 전체를 이 락으로 직렬화한다.
_pdfium = threading.Lock()

# 같은 악보를 여는 요청들을 하나로 합류시킨다. 첫 요청만 DB에서 PDF를 받아
# 전 페이지를 그리고, 나머지 요청은 끝나기를 기다렸다가 캐시에서 꺼낸다.
_warm_events = {}             # (sheetId, width) -> threading.Event
WARM_TIMEOUT = 60
WARM_MIN_WIDTH = 800          # 목록 썸네일 같은 저해상도 요청은 나머지 페이지를 미리 그리지 않는다


class SheetNotFound(Exception):
    pass


def _load_pdf(sheet_id):
    conn = get_db()
    row = conn.execute('SELECT content FROM sheets WHERE "id"=%s', (sheet_id,)).fetchone()
    conn.close()
    if not row or not row['content']:
        raise SheetNotFound()
    return bytes(row['content'])


def _store(key, data):
    global _cache_bytes
    with _lock:
        if key in _cache:
            _cache_bytes -= len(_cache.pop(key))
        _cache[key] = data
        _cache_bytes += len(data)
        while _cache_bytes > CACHE_MAX_BYTES and _cache:
            _, dropped = _cache.popitem(last=False)
            _cache_bytes -= len(dropped)


def _get(key):
    with _lock:
        data = _cache.get(key)
        if data is not None:
            _cache.move_to_end(key)
        return data


def page_count(sheet_id):
    """쪽수. 한 번 알아내면 기억한다."""
    cached = _page_counts.get(sheet_id)
    if cached is not None:
        return cached
    pdf = _load_pdf(sheet_id)
    with _pdfium:
        doc = pdfium.PdfDocument(io.BytesIO(pdf))
        try:
            n = len(doc)
        finally:
            doc.close()
    _page_counts[sheet_id] = n
    return n


def _content_box(doc):
    """전 페이지를 훑어 내용이 들어찬 범위를 하나로 구한다.
    페이지마다 따로 재면 마지막 장처럼 짧은 페이지가 확대돼 크기가 들쭉날쭉해진다."""
    left = top = 1.0
    right = bottom = 0.0
    found = False
    for i in range(len(doc)):
        page = doc[i]
        image = page.render(scale=BBOX_PROBE_WIDTH / page.get_size()[0]).to_pil().convert('L')
        w, h = image.size
        mask = ImageChops.difference(image, Image.new('L', image.size, 255))
        box = mask.point(lambda v: 255 if v > BBOX_THRESHOLD else 0).getbbox()
        if not box:
            continue
        found = True
        left = min(left, box[0] / w)
        top = min(top, box[1] / h)
        right = max(right, box[2] / w)
        bottom = max(bottom, box[3] / h)
    if not found:
        return (0.0, 0.0, 1.0, 1.0)
    return (max(0.0, left - BBOX_PAD), max(0.0, top - BBOX_PAD),
            min(1.0, right + BBOX_PAD), min(1.0, bottom + BBOX_PAD))


def _encode(doc, index, width, box):
    """잘라낸 뒤의 폭이 요청한 width 가 되도록 배율을 맞춰 그린다."""
    left, top, right, bottom = box
    page = doc[index]
    span = max(0.05, right - left)
    scale = width / (page.get_size()[0] * span)
    image = page.render(scale=scale).to_pil().convert('RGB')
    w, h = image.size
    image = image.crop((round(left * w), round(top * h), round(right * w), round(bottom * h)))
    buf = io.BytesIO()
    image.save(buf, 'WEBP', quality=WEBP_QUALITY, method=WEBP_METHOD)
    return buf.getvalue()


def _render_rest(sheet_id, pdf, width, skip, box):
    """나머지 페이지를 뒤에서 그려 캐시에 넣는다. DB를 다시 타지 않으려고 PDF를 넘겨받는다."""
    try:
        with _pdfium:
            doc = pdfium.PdfDocument(io.BytesIO(pdf))
            try:
                for i in range(len(doc)):
                    if i + 1 == skip:
                        continue
                    key = (sheet_id, i + 1, width)
                    if _get(key) is None:
                        _store(key, _encode(doc, i, width, box))
            finally:
                doc.close()
    except Exception as exc:                      # 미리 그리기 실패는 조용히 넘긴다
        print(f'[render] 미리 그리기 실패 sheet={sheet_id}: {exc}')
    finally:
        with _lock:
            evt = _warm_events.pop((sheet_id, width), None)
        if evt:
            evt.set()


def render_page(sheet_id, page_no, width=DEFAULT_WIDTH):
    """1-based 페이지 번호를 WebP 바이트로. 이미 그린 적 있으면 그대로 돌려준다."""
    width = max(MIN_WIDTH, min(MAX_WIDTH, int(width)))
    key = (sheet_id, page_no, width)
    hit = _get(key)
    if hit is not None:
        return hit

    # 첫 요청(leader)만 실제로 그린다. 나머지는 워밍이 끝나기를 기다렸다가
    # 캐시에서 꺼낸다 — 페이지마다 DB에서 PDF를 다시 받는 것을 막는다.
    with _lock:
        evt = _warm_events.get((sheet_id, width))
        leader = evt is None
        if leader:
            evt = threading.Event()
            _warm_events[(sheet_id, width)] = evt
    if not leader:
        evt.wait(WARM_TIMEOUT)
        hit = _get(key)
        if hit is not None:
            return hit
        # 워밍이 실패했거나 늦으면 직접 그린다. (아래로 계속)

    try:
        pdf = _load_pdf(sheet_id)
        with _pdfium:
            doc = pdfium.PdfDocument(io.BytesIO(pdf))
            try:
                total = len(doc)
                _page_counts[sheet_id] = total
                if page_no < 1 or page_no > total:
                    raise IndexError(f'{page_no}쪽은 없습니다 (전체 {total}쪽).')
                box = _boxes.get(sheet_id)
                if box is None:
                    box = _content_box(doc)
                    _boxes[sheet_id] = box
                data = _encode(doc, page_no - 1, width, box)
            finally:
                doc.close()
        _store(key, data)
    except BaseException:
        # 실패하면 기다리는 쪽을 깨워 각자 물러나게 한다.
        if leader:
            with _lock:
                _warm_events.pop((sheet_id, width), None)
            evt.set()
        raise

    # 요청한 쪽을 먼저 돌려주고, 나머지는 뒤에서 그려둔다.
    if leader:
        if total > 1 and width >= WARM_MIN_WIDTH:
            threading.Thread(target=_render_rest,
                             args=(sheet_id, pdf, width, page_no, box),
                             daemon=True).start()
        else:
            with _lock:
                _warm_events.pop((sheet_id, width), None)
            evt.set()
    return data


def forget(sheet_id):
    """악보가 지워지거나 바뀌면 기억한 것도 버린다."""
    global _cache_bytes
    with _lock:
        for key in [k for k in _cache if k[0] == sheet_id]:
            _cache_bytes -= len(_cache.pop(key))
    _page_counts.pop(sheet_id, None)
    _boxes.pop(sheet_id, None)


def stats():
    with _lock:
        return {'entries': len(_cache), 'bytes': _cache_bytes}
