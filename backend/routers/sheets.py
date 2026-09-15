"""악보. 곡 목록과 독립이고 길드 밖 공용이다. 파트(role)로 나누고 태그와 검색으로 찾는다."""
import hashlib
import json
import os

from fastapi import APIRouter, File, Form, HTTPException, Request, Response, UploadFile

import render
from db import get_db
from helpers import body_ids, like_escape, norm_tag

router = APIRouter()

SHEET_COLS = (
    '"id", "title", "artist", "role", "tags", "bpm", "pages", "note", '
    '"fileName", "viewPrefs", "uploadedBy", "createdAt", "updatedAt", '
    'octet_length(content) AS "sizeBytes"'
)
SHEET_EDITABLE = ('title', 'artist', 'role', 'tags', 'bpm', 'pages', 'note', 'viewPrefs')
MAX_SHEET_BYTES = 30 * 1024 * 1024


@router.get('/tag-counts')
def sheet_tag_counts():
    """필터 칩에 개수를 붙이기 위한 집계."""
    conn = get_db()
    rows = conn.execute(
        'SELECT "tags" AS t, COUNT(*) AS c FROM sheets '
        "WHERE \"tags\" IS NOT NULL AND \"tags\" <> '' GROUP BY \"tags\""
    ).fetchall()
    conn.close()
    return {r['t']: r['c'] for r in rows}


@router.get('')
def list_sheets(q: str | None = None, role: str | None = None, tag: str | None = None):
    """태그는 하나만 붙으므로 정확히 일치하는 것만 거른다."""
    where = []
    params = []
    if q and q.strip():
        like = f'%{like_escape(q.strip())}%'
        where.append('("title" ILIKE %s OR "artist" ILIKE %s OR "tags" ILIKE %s)')
        params += [like, like, like]
    if role:
        where.append('"role" = %s')
        params.append(role)
    if tag and tag.strip():
        where.append('"tags" = %s')
        params.append(tag.strip())
    clause = (' WHERE ' + ' AND '.join(where)) if where else ''
    conn = get_db()
    rows = conn.execute(
        f'SELECT {SHEET_COLS} FROM sheets{clause} ORDER BY "createdAt" DESC', params
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


@router.post('')
async def upload_sheets(
    role: str = Form(...),
    tags: str | None = Form(None),
    uploadedBy: str | None = Form(None),
    meta: str | None = Form(None),
    files: list[UploadFile] = File(...),
):
    """파트를 한 번 고르고 여러 파일을 한꺼번에 올린다.
    meta 는 파일 순서와 같은 길이의 JSON 배열로, 브라우저가 악보에서 뽑아낸
    제목·아티스트·BPM·태그가 들어온다. 없으면 파일명과 묶음 기본값을 쓴다."""
    try:
        per_file = json.loads(meta) if meta else []
        if not isinstance(per_file, list):
            per_file = []
    except (ValueError, TypeError):
        per_file = []

    tag_text = norm_tag(tags)
    conn = get_db()
    created = []
    skipped = []                # 문제 있는 파일은 묶음 전체를 깨지 않고 하나만 빼고 알려준다
    try:
        for i, f in enumerate(files):
            data = await f.read()
            if not data:
                continue
            name = f.filename or ''
            # 뷰어가 PDF만 그릴 수 있다. 다른 형식이 들어오면 영영 못 여는 악보가 된다.
            if not data.startswith(b'%PDF-'):
                skipped.append({'fileName': name, 'reason': 'PDF 파일이 아닙니다'})
                continue
            if len(data) > MAX_SHEET_BYTES:
                skipped.append({'fileName': name, 'reason': '30MB를 넘습니다'})
                continue
            info = per_file[i] if i < len(per_file) and isinstance(per_file[i], dict) else {}
            title = (info.get('title') or '').strip()
            if not title:
                title = os.path.splitext(f.filename or '')[0].strip() or '제목 없음'
            bpm = info.get('bpm')
            bpm = int(bpm) if isinstance(bpm, (int, float)) and 20 <= bpm <= 300 else None
            artist = (info.get('artist') or '').strip() or None
            # 파일마다 태그를 다르게 줄 수 있다. 안 넘어오면 묶음 기본값을 쓴다.
            row_tags = norm_tag(info['tags']) if 'tags' in info else tag_text
            pages = info.get('pages')
            pages = int(pages) if isinstance(pages, (int, float)) and pages > 0 else None
            cur = conn.execute(
                'INSERT INTO sheets ("title","artist","role","tags","bpm","pages","fileName",'
                '"content","uploadedBy") VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING "id"',
                (title, artist, role, row_tags, bpm, pages, f.filename or '', data, uploadedBy),
            )
            created.append(cur.fetchone()['id'])
        if not created:
            detail = ' / '.join(f"{s['fileName']}: {s['reason']}" for s in skipped) \
                or '올릴 파일이 없습니다.'
            raise HTTPException(400, detail)
        conn.commit()
        ph = ','.join('%s' for _ in created)
        rows = conn.execute(
            f'SELECT {SHEET_COLS} FROM sheets WHERE "id" IN ({ph}) ORDER BY "createdAt" DESC',
            created,
        ).fetchall()
        return {'created': [dict(r) for r in rows], 'skipped': skipped}
    except HTTPException:
        conn.rollback()
        raise
    finally:
        conn.close()


@router.post('/bulk')
def bulk_update_sheets(body: dict):
    """여러 악보의 태그나 파트를 한꺼번에 바꾼다.
    태그는 하나뿐이므로 더하고 빼는 것이 아니라 그대로 갈아끼운다."""
    ids = body_ids(body)
    role = body.get('role')

    conn = get_db()
    ph = ','.join('%s' for _ in ids)
    if 'tag' in body:
        conn.execute(
            f'UPDATE sheets SET "tags"=%s, "updatedAt"=now() WHERE "id" IN ({ph})',
            [norm_tag(body.get('tag'))] + ids,
        )
    if role:
        conn.execute(
            f'UPDATE sheets SET "role"=%s, "updatedAt"=now() WHERE "id" IN ({ph})',
            [role] + ids,
        )
    conn.commit()
    rows = conn.execute(
        f'SELECT {SHEET_COLS} FROM sheets WHERE "id" IN ({ph}) ORDER BY "createdAt" DESC', ids
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


@router.post('/bulk-delete')
def bulk_delete_sheets(body: dict):
    ids = body_ids(body)
    conn = get_db()
    ph = ','.join('%s' for _ in ids)
    cur = conn.execute(f'DELETE FROM sheets WHERE "id" IN ({ph})', ids)
    conn.commit()
    conn.close()
    for sheet_id in ids:
        render.forget(sheet_id)
    return {'ok': True, 'deleted': cur.rowcount}


@router.put('/{sheet_id}')
def update_sheet(sheet_id: int, body: dict):
    fields = []
    values = []
    for key in SHEET_EDITABLE:
        if key in body:
            value = norm_tag(body[key]) if key == 'tags' else body[key]
            fields.append(f'"{key}"=%s')
            values.append(value)
    if not fields:
        raise HTTPException(400, '수정할 내용이 없습니다.')
    fields.append('"updatedAt"=now()')
    values.append(sheet_id)
    conn = get_db()
    cur = conn.execute(f'UPDATE sheets SET {", ".join(fields)} WHERE "id"=%s', values)
    conn.commit()
    if cur.rowcount == 0:
        conn.close()
        raise HTTPException(404, '악보를 찾을 수 없습니다.')
    row = conn.execute(f'SELECT {SHEET_COLS} FROM sheets WHERE "id"=%s', (sheet_id,)).fetchone()
    conn.close()
    return dict(row)


@router.get('/{sheet_id}/pages')
def sheet_pages(sheet_id: int):
    """쪽수. 뷰어가 열자마자 전 페이지를 미리 받으려면 먼저 이게 필요하다.
    쪽수 컬럼이 비어 있던 예전 악보는 이때 채워 넣어, 다음부터는 목록만으로 알 수 있게 한다."""
    try:
        pages = render.page_count(sheet_id)
    except render.SheetNotFound:
        raise HTTPException(404, '악보를 찾을 수 없습니다.')
    conn = get_db()
    conn.execute('UPDATE sheets SET "pages"=%s WHERE "id"=%s AND "pages" IS NULL',
                 (pages, sheet_id))
    conn.commit()
    conn.close()
    return {'pages': pages}


@router.get('/{sheet_id}/page/{page_no}')
def sheet_page(sheet_id: int, page_no: int, request: Request,
               w: int = render.DEFAULT_WIDTH):
    """페이지 한 장을 WebP 이미지로. PDF 원본은 브라우저로 내보내지 않는다.

    캐시는 한 시간 동안은 재검증 없이 그대로 쓰고(공연 중 네트워크가 끊겨도
    브라우저 캐시로 버틴다), 그 뒤에는 ETag 재검증으로 다룬다. 내용을 그대로
    해싱하므로 렌더링 방식을 바꾸면 지문이 달라져 브라우저가 새로 받는다."""
    try:
        data = render.render_page(sheet_id, page_no, w)
    except render.SheetNotFound:
        raise HTTPException(404, '악보를 찾을 수 없습니다.')
    except IndexError as exc:
        raise HTTPException(404, str(exc))

    etag = '"' + hashlib.sha1(data).hexdigest()[:20] + '"'
    cache = 'private, max-age=3600'
    if request.headers.get('if-none-match') == etag:
        return Response(status_code=304, headers={'ETag': etag, 'Cache-Control': cache})

    return Response(
        content=data,
        media_type='image/webp',
        headers={
            'ETag': etag,
            'Cache-Control': cache,
            'Content-Length': str(len(data)),
        },
    )


@router.delete('/{sheet_id}')
def delete_sheet(sheet_id: int):
    conn = get_db()
    cur = conn.execute('DELETE FROM sheets WHERE "id"=%s', (sheet_id,))
    conn.commit()
    conn.close()
    if cur.rowcount == 0:
        raise HTTPException(404, '악보를 찾을 수 없습니다.')
    render.forget(sheet_id)
    return {'ok': True}
