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
    '"fileName", "viewPrefs", "uploadedBy", "folderId", "createdAt", "updatedAt", '
    'octet_length(content) AS "sizeBytes"'
)
FOLDER_NAME_MAX = 30


def _folder_id(conn, raw):
    """폴더 값 하나를 읽는다. None·''·'none' 은 미분류. 없는 폴더면 400."""
    if raw in (None, '', 'none'):
        return None
    try:
        fid = int(raw)
    except (TypeError, ValueError):
        raise HTTPException(400, '폴더가 올바르지 않습니다.')
    if not conn.execute('SELECT 1 FROM sheetFolders WHERE "id"=%s', (fid,)).fetchone():
        raise HTTPException(400, '없는 폴더입니다.')
    return fid


def _folder_name(raw):
    name = str(raw or '').strip()
    if not name:
        raise HTTPException(400, '폴더 이름을 넣어 주세요.')
    if len(name) > FOLDER_NAME_MAX:
        raise HTTPException(400, f'폴더 이름은 {FOLDER_NAME_MAX}자까지입니다.')
    return name
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


# ---------- 폴더(파일철) ----------
@router.get('/folders')
def list_folders():
    """폴더와 각 폴더의 악보 수, 미분류 수, 전체 수. 화면의 폴더 줄이 이걸로 그려진다."""
    conn = get_db()
    try:
        rows = conn.execute(
            'SELECT f."id", f."name", f."order", f."createdBy", '
            '(SELECT count(*) FROM sheets s WHERE s."folderId"=f."id") AS "count" '
            'FROM sheetFolders f ORDER BY f."order", f."id"').fetchall()
        unfiled = conn.execute('SELECT count(*) AS n FROM sheets WHERE "folderId" IS NULL').fetchone()['n']
        total = conn.execute('SELECT count(*) AS n FROM sheets').fetchone()['n']
        return {'folders': [dict(r) for r in rows], 'unfiled': unfiled, 'total': total}
    finally:
        conn.close()


@router.post('/folders')
def create_folder(body: dict):
    name = _folder_name(body.get('name'))
    conn = get_db()
    try:
        nxt = conn.execute('SELECT coalesce(max("order"), 0) + 1 AS n FROM sheetFolders').fetchone()['n']
        row = conn.execute(
            'INSERT INTO sheetFolders ("name","order","createdBy") VALUES (%s,%s,%s) '
            'RETURNING "id","name","order","createdBy"', (name, nxt, body.get('createdBy'))).fetchone()
        conn.commit()
        return {**dict(row), 'count': 0}
    finally:
        conn.close()


@router.post('/folders/order')
def order_folders(body: dict):
    """폴더 순서를 이 목록대로. 목록에 없는 폴더는 뒤에 그대로 남는다."""
    ids = body_ids(body)
    conn = get_db()
    try:
        for i, fid in enumerate(ids):
            conn.execute('UPDATE sheetFolders SET "order"=%s WHERE "id"=%s', (i + 1, fid))
        conn.commit()
        return {'ok': True}
    finally:
        conn.close()


@router.put('/folders/{folder_id}')
def rename_folder(folder_id: int, body: dict):
    name = _folder_name(body.get('name'))
    conn = get_db()
    try:
        cur = conn.execute('UPDATE sheetFolders SET "name"=%s WHERE "id"=%s', (name, folder_id))
        conn.commit()
        if cur.rowcount == 0:
            raise HTTPException(404, '폴더를 찾을 수 없습니다.')
        return {'id': folder_id, 'name': name}
    finally:
        conn.close()


@router.delete('/folders/{folder_id}')
def delete_folder(folder_id: int):
    """폴더만 지운다. 안의 악보는 미분류로 돌아간다(FK ON DELETE SET NULL)."""
    conn = get_db()
    try:
        n = conn.execute('SELECT count(*) AS n FROM sheets WHERE "folderId"=%s', (folder_id,)).fetchone()['n']
        cur = conn.execute('DELETE FROM sheetFolders WHERE "id"=%s', (folder_id,))
        conn.commit()
        if cur.rowcount == 0:
            raise HTTPException(404, '폴더를 찾을 수 없습니다.')
        return {'ok': True, 'unfiled': n}
    finally:
        conn.close()


@router.get('')
def list_sheets(q: str | None = None, role: str | None = None, tag: str | None = None,
                folder: str | None = None):
    """태그는 하나만 붙으므로 정확히 일치하는 것만 거른다.
    folder 는 폴더 id 또는 'none'(미분류). 순서는 제목순이다(2026-10-29) — 올린 순서는 파일철로 쓰기에 맞지 않았다."""
    where = []
    params = []
    if folder == 'none':
        where.append('"folderId" IS NULL')
    elif folder:
        try:
            params.append(int(folder))
        except ValueError:
            raise HTTPException(400, '폴더가 올바르지 않습니다.')
        where.append('"folderId" = %s')
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
        f'SELECT {SHEET_COLS} FROM sheets{clause} ORDER BY lower("title"), "id"', params
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


@router.post('')
async def upload_sheets(
    role: str = Form(...),
    tags: str | None = Form(None),
    uploadedBy: str | None = Form(None),
    meta: str | None = Form(None),
    folderId: str | None = Form(None),
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
    try:
        folder = _folder_id(conn, folderId)      # 올릴 때 고른 폴더. 없으면 미분류
    except HTTPException:
        conn.close()
        raise
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
                '"content","uploadedBy","folderId") VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING "id"',
                (title, artist, role, row_tags, bpm, pages, f.filename or '', data, uploadedBy, folder),
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
    if 'folderId' in body:
        # 폴더로 옮기기(2026-10-29). null 이면 미분류로
        try:
            folder = _folder_id(conn, body.get('folderId'))
        except HTTPException:
            conn.close()
            raise
        conn.execute(
            f'UPDATE sheets SET "folderId"=%s, "updatedAt"=now() WHERE "id" IN ({ph})',
            [folder] + ids,
        )
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
        f'SELECT {SHEET_COLS} FROM sheets WHERE "id" IN ({ph}) ORDER BY lower("title"), "id"', ids
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


@router.post('/{sheet_id}/file')
async def replace_sheet_file(sheet_id: int, file: UploadFile = File(...)):
    """PDF 만 갈아끼운다(2026-10-29). 번호·제목·파트·태그·BPM·메모·보기 설정은 그대로라
    페어가 기억하는 악보와 목록의 자리가 유지된다. 전에는 지우고 다시 올려야 했다.
    쪽수는 새 파일에서 다시 세고, 그려 둔 쪽 이미지·쪽수·여백은 버린다(render.forget).
    쪽 이미지 주소에는 화면이 수정 시각을 붙이므로 브라우저의 한 시간 캐시도 비켜 간다."""
    data = await file.read()
    name = file.filename or ''
    if not data.startswith(b'%PDF-'):
        raise HTTPException(400, 'PDF 파일이 아닙니다.')
    if len(data) > MAX_SHEET_BYTES:
        raise HTTPException(400, '30MB를 넘습니다.')
    conn = get_db()
    try:
        cur = conn.execute(
            'UPDATE sheets SET "content"=%s, "fileName"=%s, "pages"=NULL, "updatedAt"=now() WHERE "id"=%s',
            (data, name, sheet_id))
        if cur.rowcount == 0:
            raise HTTPException(404, '악보를 찾을 수 없습니다.')
        conn.commit()
    finally:
        conn.close()          # 쪽수 세기가 제 연결을 열므로 먼저 닫는다
    render.forget(sheet_id)
    try:
        pages = render.page_count(sheet_id)
    except Exception:         # 못 세면 비워 둔다 — 뷰어의 /pages 가 다음에 다시 센다
        pages = None
    conn = get_db()
    try:
        if pages:
            conn.execute('UPDATE sheets SET "pages"=%s WHERE "id"=%s', (pages, sheet_id))
            conn.commit()
        row = conn.execute(f'SELECT {SHEET_COLS} FROM sheets WHERE "id"=%s', (sheet_id,)).fetchone()
        return dict(row)
    finally:
        conn.close()


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
