/* 악보 — 탐색기(폴더 트리) + 전체화면 PDF 뷰어 + 두 아이패드 페어.
   PDF 를 떨어뜨리면 올라가고, 제목·아티스트·BPM 은 악보 본문에서 자동으로 뽑는다. */

import { extractSheetInfo } from './extract.js?v=2';
import * as Pair from './pair.js?v=2';

/* PDF.js(1.7MB)는 올릴 때 제목·BPM 을 뽑는 데만 쓴다. 악보를 볼 때는 서버가 그려준
   이미지만 받으므로 필요 없다. 그래서 파일을 고르는 순간에만 불러온다. */
let pdfjsPromise = null;
function getPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import('/vendor/pdfjs/pdf.min.mjs').then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
      return lib;
    });
  }
  return pdfjsPromise;
}

/* ---------- 탐색기 (2026-10-30 사용자 결정) ----------
   악보는 폴더 트리 안에 든다 — 파일 앱처럼 폴더를 누르면 들어가고 악보를 누르면 바로 뷰어다.
   관리는 우클릭(아이패드·폰은 길게 누르기) 메뉴, 옮기기는 끌어다 놓기, 올리기는 PDF 를 떨어뜨리는 것.
   PDF 를 폴더에 놓으면 그 안에, 빈 곳에 놓으면 보는 폴더에, 악보 위에 놓으면 그 악보의 파일이 바뀐다.
   파트·태그·거르기·칩·일괄 바·올리기 판은 걷어냈다. 검색 칸 하나만 남고 폴더를 가로지른다. */

/* 264ppi급 아이패드(10.2·11인치)는 CSS 1mm ≈ 5.2px. 실물 크기 환산용 근사값. */
const PX_PER_MM = 5.2;
const PT_PER_MM = 72 / 25.4;
const LOCK_MS = 380;
const TAP_MAX_MOVE = 14;
const CLOSE_SWIPE = 90;   /* 이만큼 아래로 쓸어내리면 뷰어를 닫는다 */
const CROP_LIMIT = 0.015; /* 세로 화면에서 위·아래 각각 이만큼까지만 잘라낸다 */
const LONG_PRESS_MS = 500;
const FOLDER_SVG = '<svg viewBox="0 0 64 48" aria-hidden="true"><path d="M4 10a4 4 0 0 1 4-4h14l6 6h28a4 4 0 0 1 4 4v24a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4z"/></svg>';

let folders = [];            /* 모든 폴더 {id,name,parentId,count,folders} */
let rootCount = 0;
let cur = null;              /* 보는 폴더 id. null = 맨 위 */
let sheets = [];             /* 보는 폴더의 악보. 검색 중이면 결과 */
let query = '';
let selected = new Set();    /* 'f:3' | 's:12' */
let renaming = null;         /* 그 자리에서 이름 고치는 폴더 id */
let lastRole = localStorage.getItem('sheetRole') || '공용';   /* 올릴 때 묻지 않는 파트 — 마지막 값 */

const $ = (id) => document.getElementById(id);
const explorerEl = $('explorer');
const gridEl = $('grid');
const crumbsEl = $('crumbs');
const searchEl = $('search');
const statusEl = $('ex-status');
const ctxEl = $('ctx');
const fileInput = $('file-input');
const replaceInput = $('replace-input');

const folderById = (id) => folders.find((f) => f.id === id);
const sheetById = (id) => sheets.find((s) => s.id === id);
const childrenOf = (id) => folders.filter((f) => (f.parentId ?? null) === (id ?? null));
function pathOf(id) {
  const out = [];
  let f = folderById(id);
  for (let guard = 0; f && guard < 50; guard++) { out.unshift(f); f = folderById(f.parentId); }
  return out;
}
function descendants(id) {
  const out = new Set([id]);
  let frontier = [id];
  while (frontier.length) {
    frontier = folders.filter((f) => frontier.includes(f.parentId) && !out.has(f.id)).map((f) => f.id);
    frontier.forEach((x) => out.add(x));
  }
  return out;
}
const keyOf = (tile) => (tile.dataset.f ? 'f:' + tile.dataset.f : 's:' + tile.dataset.s);
const splitKeys = (keys) => ({
  sheets: keys.filter((k) => k.startsWith('s:')).map((k) => Number(k.slice(2))),
  folders: keys.filter((k) => k.startsWith('f:')).map((k) => Number(k.slice(2))),
});
const fmtSize = (b) => (!b ? '' : b >= 1048576 ? (b / 1048576).toFixed(1) + 'MB' : Math.round(b / 1024) + 'KB');

let statusTimer = null;
function say(text, keep) {
  clearTimeout(statusTimer);
  statusEl.textContent = text;
  statusEl.hidden = !text;
  if (text && !keep) statusTimer = setTimeout(() => { statusEl.hidden = true; }, 4000);
}

/* ---------- 받기 · 그리기 ---------- */
let refreshSeq = 0;
async function refresh() {
  const seq = ++refreshSeq;
  const params = new URLSearchParams();
  if (query) params.set('q', query);
  else params.set('folder', cur === null ? 'root' : String(cur));
  const [rows, fl] = await Promise.all([api.get('/sheets?' + params), api.get('/sheets/folders')]);
  if (seq !== refreshSeq) return;       /* 뒤늦게 온 이전 응답은 버린다 */
  sheets = rows;
  folders = fl.folders;
  rootCount = fl.rootCount;
  if (cur !== null && !folderById(cur)) cur = null;      /* 남이 지운 폴더에 서 있었다 */
  selected = new Set([...selected].filter((k) => {
    const { sheets: s, folders: f } = splitKeys([k]);
    return s.length ? sheetById(s[0]) : folderById(f[0]);
  }));
  paint();
}

function paint() {
  /* 경로. 맨 위는 '악보'. 검색 중이면 경로 대신 검색어 */
  if (query) {
    crumbsEl.innerHTML = `<span class="crumb is-cur">검색 “${escapeHtml(query)}”</span>`
      + '<button type="button" class="crumb-clear" data-clear-search>지우기</button>';
  } else {
    const trail = [{ id: null, name: '악보' }, ...pathOf(cur)];
    crumbsEl.innerHTML = trail.map((f, i) => {
      const last = i === trail.length - 1;
      return (i ? '<span class="crumb-sep">›</span>' : '')
        + `<button type="button" class="crumb${last ? ' is-cur' : ''}" data-crumb="${f.id === null ? 'root' : f.id}">${escapeHtml(f.name)}</button>`;
    }).join('');
  }
  $('list-count').textContent = rootCount + folders.reduce((n, f) => n + f.count, 0) || '';

  const q = query.toLowerCase();
  const fList = query ? folders.filter((f) => f.name.toLowerCase().includes(q)) : childrenOf(cur);
  const pathHtml = (fid) => (query ? `<span class="tile-path">${escapeHtml(['악보', ...pathOf(fid).map((x) => x.name)].join(' › '))}</span>` : '');
  const check = (key) => (selected.size ? `<i class="tile-check" aria-hidden="true">${selected.has(key) ? '✓' : ''}</i>` : '');
  let html = fList.map((f) => {
    const key = 'f:' + f.id;
    const name = renaming === f.id
      ? `<input class="tile-rename" value="${escapeHtml(f.name)}" maxlength="30" aria-label="폴더 이름" />`
      : `<span class="tile-name">${escapeHtml(f.name)}</span>`;
    const sub = [f.count ? `${f.count}장` : '', f.folders ? `폴더 ${f.folders}` : ''].filter(Boolean).join(' · ') || '비어 있음';
    return `<div class="tile folder${selected.has(key) ? ' is-sel' : ''}" data-f="${f.id}" draggable="true" tabindex="0" role="button" aria-label="${escapeHtml(f.name)} 폴더">`
      + check(key) + `<span class="tile-icon">${FOLDER_SVG}</span>${name}<small>${sub}</small>${pathHtml(f.parentId)}</div>`;
  }).join('');
  html += sheets.map((s) => {
    const key = 's:' + s.id;
    const sub = [s.artist, s.pages ? s.pages + '쪽' : '', fmtSize(s.sizeBytes)].filter(Boolean).map(escapeHtml).join(' · ');
    return `<div class="tile sheet${selected.has(key) ? ' is-sel' : ''}" data-s="${s.id}" draggable="true" tabindex="0" role="button" aria-label="${escapeHtml(s.title || '제목 없음')}">`
      + check(key)
      + `<span class="tile-thumb genre-${songTone(s)}"><img loading="lazy" alt="" src="/api/sheets/${s.id}/page/1?w=400&v=${sheetVer(s)}" /></span>`
      + `<span class="tile-name">${escapeHtml(s.title || '제목 없음')}</span><small>${sub}</small>${pathHtml(s.folderId)}</div>`;
  }).join('');
  if (!html) {
    html = `<p class="ex-empty">${query ? `“${escapeHtml(query)}” 에 맞는 것이 없습니다.`
      : '빈 폴더입니다. PDF 를 끌어다 놓으면 올라가고, 우클릭(길게 누르기)으로 새 폴더를 만듭니다.'}</p>`;
  }
  gridEl.innerHTML = html;
  $('ex-select').hidden = !selected.size;
  $('ex-select-n').textContent = selected.size ? `${selected.size}개 선택` : '';
  if (renaming !== null) {
    const inp = gridEl.querySelector('.tile-rename');
    if (inp) { inp.focus(); inp.select(); }
  }
}

function enter(id) {
  cur = id;
  query = '';
  searchEl.value = '';
  selected.clear();
  renaming = null;
  refresh().catch(console.error);
}

/* ---------- 누르기 · 고르기 ---------- */
let suppressClick = false;        /* 길게 눌러 메뉴를 띄운 직후의 click 은 버린다 */
function toggleSel(tile) {
  const key = keyOf(tile);
  if (selected.has(key)) selected.delete(key); else selected.add(key);
  paint();
}
gridEl.addEventListener('click', (e) => {
  if (suppressClick) { suppressClick = false; return; }
  if (e.target.closest('.tile-rename')) return;
  const tile = e.target.closest('.tile');
  if (!tile) return;
  if (e.ctrlKey || e.metaKey || selected.size) { toggleSel(tile); return; }
  if (tile.dataset.f) enter(Number(tile.dataset.f));
  else { const s = sheetById(Number(tile.dataset.s)); if (s) openViewer(s); }
});
gridEl.addEventListener('keydown', (e) => {
  const tile = e.target.closest('.tile');
  if (!tile || e.target.closest('.tile-rename')) return;
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); tile.click(); }
});
crumbsEl.addEventListener('click', (e) => {
  if (e.target.closest('[data-clear-search]')) { query = ''; searchEl.value = ''; refresh().catch(console.error); return; }
  const c = e.target.closest('[data-crumb]');
  if (c) enter(c.dataset.crumb === 'root' ? null : Number(c.dataset.crumb));
});
$('ex-select-clear').addEventListener('click', () => { selected.clear(); paint(); });

let searchTimer = null;
searchEl.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    query = searchEl.value.trim();
    renaming = null;
    refresh().catch(console.error);
  }, 250);
});

/* ---------- 그 자리에서 이름 고치기 ---------- */
gridEl.addEventListener('keydown', async (e) => {
  const inp = e.target.closest('.tile-rename');
  if (!inp) return;
  if (e.key === 'Enter') { e.preventDefault(); await commitRename(inp); }
  else if (e.key === 'Escape') { e.preventDefault(); renaming = null; paint(); }
});
gridEl.addEventListener('focusout', (e) => {
  const inp = e.target.closest && e.target.closest('.tile-rename');
  if (inp && renaming !== null) commitRename(inp);      /* 탐색기처럼 밖을 누르면 그대로 확정 */
});
async function commitRename(inp) {
  const id = renaming;
  const name = inp.value.trim();
  renaming = null;
  const f = folderById(id);
  if (!f || !name || name === f.name) { paint(); return; }
  const ok = await Writes.commit(null, 'folders', () => api.put('/sheets/folders/' + id, { name }), (err) => say(err.message));
  if (ok) f.name = name;
  refresh().catch(console.error);
}

/* ---------- 우클릭 · 길게 누르기 메뉴 ---------- */
let ctxTarget = null;     /* {kind:'empty'|'folder'|'sheet'|'multi', id, keys} */
function openCtx(x, y, tile) {
  const key = tile ? keyOf(tile) : null;
  let items;
  if (tile && selected.size > 1 && selected.has(key)) {
    ctxTarget = { kind: 'multi', keys: [...selected] };
    items = [['move', `${selected.size}개 이동…`], ['delete', `${selected.size}개 삭제`], ['unselect', '선택 해제']];
  } else if (tile && tile.dataset.f) {
    ctxTarget = { kind: 'folder', id: Number(tile.dataset.f), keys: [key] };
    items = [['open', '열기'], ['rename', '이름 바꾸기'], ['move', '이동…'], ['delete', '삭제'], ['select', '선택']];
  } else if (tile) {
    ctxTarget = { kind: 'sheet', id: Number(tile.dataset.s), keys: [key] };
    items = [['open', '열기'], ['move', '이동…'], ['replace', '파일 바꾸기'], ['edit', '정보 수정'], ['delete', '삭제'], ['select', '선택']];
  } else {
    ctxTarget = { kind: 'empty' };
    items = [['new', '새 폴더'], ['upload', '올리기…']];
    if (selected.size) items.push(['unselect', '선택 해제']);
  }
  ctxEl.innerHTML = items.map(([act, label]) =>
    `<button type="button" class="menu-item${act === 'delete' ? ' is-danger' : ''}" role="menuitem" data-act="${act}">${escapeHtml(label)}</button>`).join('');
  ctxEl.hidden = false;
  const r = ctxEl.getBoundingClientRect();
  ctxEl.style.left = Math.max(4, Math.min(x, innerWidth - r.width - 4)) + 'px';
  ctxEl.style.top = Math.max(4, Math.min(y, innerHeight - r.height - 4)) + 'px';
  ctxEl.querySelector('.menu-item').focus();
}
function closeCtx() { ctxEl.hidden = true; }
gridEl.addEventListener('contextmenu', (e) => {
  if (e.target.closest('.tile-rename')) return;
  e.preventDefault();
  openCtx(e.clientX, e.clientY, e.target.closest('.tile'));
});
/* 길게 누르기(터치). 움직이거나 끌기가 시작되면 메뉴가 아니다 */
let pressTimer = null;
let pressAt = null;
gridEl.addEventListener('pointerdown', (e) => {
  if (e.pointerType !== 'touch') return;
  pressAt = { x: e.clientX, y: e.clientY, tile: e.target.closest('.tile') };
  clearTimeout(pressTimer);
  pressTimer = setTimeout(() => {
    suppressClick = true;
    openCtx(pressAt.x, pressAt.y, pressAt.tile);
  }, LONG_PRESS_MS);
});
gridEl.addEventListener('pointermove', (e) => {
  if (pressAt && Math.hypot(e.clientX - pressAt.x, e.clientY - pressAt.y) > 8) clearTimeout(pressTimer);
});
['pointerup', 'pointercancel', 'dragstart'].forEach((ev) => gridEl.addEventListener(ev, () => clearTimeout(pressTimer)));
document.addEventListener('click', (e) => { if (!ctxEl.hidden && !e.target.closest('#ctx')) closeCtx(); });
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!ctxEl.hidden) { closeCtx(); return; }
  if (renaming !== null) { renaming = null; paint(); return; }
  if (selected.size && viewer.hidden) { selected.clear(); paint(); }
});
addEventListener('scroll', closeCtx, { passive: true });
addEventListener('resize', closeCtx);

ctxEl.addEventListener('click', async (e) => {
  const item = e.target.closest('[data-act]');
  if (!item) return;
  const t = ctxTarget;
  closeCtx();
  switch (item.dataset.act) {
    case 'new': return newFolder();
    case 'upload': return fileInput.click();
    case 'open':
      if (t.kind === 'folder') enter(t.id);
      else { const s = sheetById(t.id); if (s) openViewer(s); }
      return;
    case 'rename': renaming = t.id; paint(); return;
    case 'move': return moveByPicker(t.keys);
    case 'delete': return deleteKeys(t.keys);
    case 'replace': replaceInput.dataset.sheet = String(t.id); replaceInput.value = ''; replaceInput.click(); return;
    case 'edit': return editInfo(sheetById(t.id));
    case 'select': t.keys.forEach((k) => selected.add(k)); paint(); return;
    case 'unselect': selected.clear(); paint(); return;
    default:
  }
});

/* ---------- 동작 ---------- */
async function newFolder() {
  const made = await Writes.commit(null, 'folders',
    () => api.post('/sheets/folders', { parentId: cur, createdBy: Nick.get() || null }), (err) => say(err.message));
  if (!made) return;
  renaming = made.id;          /* 탐색기처럼 '새 폴더' 로 생기자마자 이름을 고친다 */
  await refresh();
}

async function move(keys, folderId) {
  const { sheets: sIds, folders: fIds } = splitKeys(keys);
  const target = folderId === null ? '악보(맨 위)' : (folderById(folderId) || {}).name || '폴더';
  if (fIds.some((id) => folderId !== null && descendants(id).has(folderId))) { say('폴더를 자기 안으로 옮길 수는 없습니다.'); return; }
  const ok = await Writes.commit(null, 'sheets:move', async () => {
    if (sIds.length) await api.post('/sheets/bulk', { ids: sIds, folderId });
    for (const id of fIds) await api.put('/sheets/folders/' + id, { parentId: folderId });
    return true;
  }, (err) => say(err.message));
  if (!ok) return;
  selected.clear();
  say(`${keys.length}개 → ${target}`);
  refresh().catch(console.error);
}

/* 폴더 고르기 창 — 끌기가 어려울 때. 옮기는 폴더와 그 아래는 고를 수 없다 */
function moveByPicker(keys) {
  const { folders: fIds } = splitKeys(keys);
  const blocked = new Set();
  fIds.forEach((id) => descendants(id).forEach((x) => blocked.add(x)));
  const rows = [];
  const walk = (parent, depth) => childrenOf(parent).forEach((f) => {
    rows.push(`<button type="button" class="menu-item" data-pick="${f.id}" style="padding-left:${30 + depth * 16}px"${blocked.has(f.id) ? ' disabled' : ''}>${escapeHtml(f.name)}</button>`);
    walk(f.id, depth + 1);
  });
  walk(null, 0);
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal pick-modal" role="dialog" aria-modal="true" aria-labelledby="pick-title">
      <h3 class="modal-title" id="pick-title">어디로 옮길까요</h3>
      <div class="pick-list"><button type="button" class="menu-item" data-pick="root">악보 (맨 위)</button>${rows.join('')}</div>
      <div class="modal-form"><button type="button" class="ghost" data-no>취소</button></div>
    </div>`;
  const close = () => { document.removeEventListener('keydown', onKey); backdrop.remove(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop || e.target.closest('[data-no]')) { close(); return; }
    const b = e.target.closest('[data-pick]');
    if (!b || b.disabled) return;
    close();
    move(keys, b.dataset.pick === 'root' ? null : Number(b.dataset.pick));
  });
  document.body.appendChild(backdrop);
}

async function deleteKeys(keys) {
  const { sheets: sIds, folders: fIds } = splitKeys(keys);
  const lifted = fIds.reduce((n, id) => { const f = folderById(id); return n + (f ? f.count + f.folders : 0); }, 0);
  const what = [sIds.length ? `악보 ${sIds.length}장` : '', fIds.length ? `폴더 ${fIds.length}개` : ''].filter(Boolean).join('과 ');
  const ok = await confirmModal({
    title: `${what} 삭제`,
    body: (sIds.length ? '악보는 되돌릴 수 없습니다. ' : '') + (lifted ? `폴더 안의 <b>${lifted}개</b>는 지워지지 않고 한 단계 위로 올라갑니다.` : ''),
    confirm: '삭제', danger: true,
  });
  if (!ok) return;
  const done = await Writes.commit(null, 'sheets:delete', async () => {
    if (sIds.length) await api.post('/sheets/bulk-delete', { ids: sIds });
    for (const id of fIds) await api.del('/sheets/folders/' + id);
    return true;
  }, (err) => say(err.message));
  if (!done) return;
  selected.clear();
  refresh().catch(console.error);
}

async function replaceFile(sheet, file) {
  if (!sheet || !file) return;
  const ok = await confirmModal({
    title: `'${sheet.title}' 파일 바꾸기`,
    body: `<b>${escapeHtml(file.name)}</b> 로 바꿉니다. 번호·제목·정보는 그대로입니다.`,
    confirm: '바꾸기',
  });
  if (!ok) return;
  const form = new FormData();
  form.append('file', file);
  say(`'${sheet.title}' 파일 바꾸는 중…`, true);
  const saved = await Writes.commit(null, `sheet:${sheet.id}`, () => api.post('/sheets/' + sheet.id + '/file', form), (err) => say(err.message));
  if (!saved) return;
  say(`'${saved.title}' 파일을 바꿨습니다${saved.pages ? ' · ' + saved.pages + '쪽' : ''}`);
  refresh().catch(console.error);
}
replaceInput.addEventListener('change', () => {
  const s = sheetById(Number(replaceInput.dataset.sheet));
  const f = replaceInput.files && replaceInput.files[0];
  replaceInput.value = '';
  replaceFile(s, f);
});

/* 정보 수정 — 제목·아티스트·BPM·메모. 파트·태그는 더 쓰지 않는다 */
function editInfo(sheet) {
  if (!sheet) return;
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="ei-title">
      <h3 class="modal-title" id="ei-title">정보 수정</h3>
      <form class="modal-form">
        <input name="title" maxlength="80" value="${escapeHtml(sheet.title || '')}" placeholder="제목" aria-label="제목" required />
        <input name="artist" maxlength="80" value="${escapeHtml(sheet.artist || '')}" placeholder="아티스트" aria-label="아티스트" />
        <input name="bpm" type="number" min="20" max="300" value="${sheet.bpm || ''}" placeholder="BPM" aria-label="BPM" />
        <textarea name="note" maxlength="300" placeholder="메모" aria-label="메모">${escapeHtml(sheet.note || '')}</textarea>
        <p class="form-error" role="alert" hidden></p>
        <button type="submit" class="pink">저장</button>
        <button type="button" class="ghost" data-no>취소</button>
      </form>
    </div>`;
  const close = () => { document.removeEventListener('keydown', onKey); backdrop.remove(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop || e.target.closest('[data-no]')) close(); });
  const form = backdrop.querySelector('form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {
      title: form.elements.title.value.trim(), artist: form.elements.artist.value.trim() || null,
      bpm: Number(form.elements.bpm.value) || null, note: form.elements.note.value.trim() || null,
    };
    const err = form.querySelector('.form-error');
    if (!body.title) { err.textContent = '제목을 넣어 주세요.'; err.hidden = false; return; }
    const saved = await Writes.commit(form.querySelector('[type=submit]'), `sheet:${sheet.id}`,
      () => api.put('/sheets/' + sheet.id, body), (ex) => { err.textContent = ex.message; err.hidden = false; });
    if (!saved) return;
    close();
    refresh().catch(console.error);
  });
  document.body.appendChild(backdrop);
  form.elements.title.focus();
}

/* ---------- 올리기 — PDF 를 떨어뜨리거나 메뉴의 '올리기…' ---------- */
async function uploadFiles(fileList, folderId) {
  const pdfs = [...fileList].filter((f) => /\.pdf$/i.test(f.name || '') || f.type === 'application/pdf');
  if (!pdfs.length) { say('PDF 파일만 올릴 수 있습니다.'); return; }
  const who = await Nick.ensure();
  if (!who) return;
  const target = folderId === null ? '' : ` → ${(folderById(folderId) || {}).name || '폴더'}`;
  const meta = [];
  try {
    const pdfjs = await getPdfjs();
    for (let i = 0; i < pdfs.length; i++) {
      say(`읽는 중 ${i + 1}/${pdfs.length}…`, true);
      const info = await extractSheetInfo(pdfjs, pdfs[i]);      /* 제목·아티스트·BPM 은 본문에서 */
      meta.push({ title: info.title, artist: info.artist, bpm: info.bpm, pages: info.pages || null, tags: '' });
    }
  } catch (e) { pdfs.forEach((_, i) => { if (!meta[i]) meta[i] = {}; }); }
  const form = new FormData();
  form.append('role', lastRole);
  form.append('uploadedBy', who);
  if (folderId !== null) form.append('folderId', String(folderId));
  form.append('meta', JSON.stringify(meta));
  pdfs.forEach((f) => form.append('files', f));
  say(`올리는 중 ${pdfs.length}개${target}…`, true);
  try {
    const res = await api.post('/sheets', form);
    const skipped = res.skipped || [];
    say(`${res.created.length}개 올렸습니다${target}` + (skipped.length ? ' · 제외: ' + skipped.map((s) => `${s.fileName} (${s.reason})`).join(', ') : ''));
  } catch (err) {
    say('올리지 못했습니다. ' + (err.message || ''));
  }
  refresh().catch(console.error);
}
fileInput.addEventListener('change', () => {
  const files = fileInput.files;
  if (files && files.length) uploadFiles(files, cur);
  fileInput.value = '';
});

/* ---------- 끌어다 놓기 ----------
   창 안의 타일을 끌면 옮기기, 밖에서 PDF 를 끌어오면 올리기. dataTransfer 의 종류로 가른다.
   놓는 자리: 폴더 타일(그 안에) · 경로 글자(그 폴더에) · 빈 곳(보는 폴더에). PDF 를 악보 위에 놓으면 그 악보의 파일 바꾸기. */
const KIND = 'text/x-sheets';
const hasFiles = (dt) => dt && [...(dt.types || [])].includes('Files');
const hasTiles = (dt) => dt && [...(dt.types || [])].includes(KIND);
let dragKeys = null;

gridEl.addEventListener('dragstart', (e) => {
  const tile = e.target.closest('.tile');
  if (!tile || e.target.closest('.tile-rename')) { e.preventDefault(); return; }
  const key = keyOf(tile);
  dragKeys = selected.has(key) ? [...selected] : [key];
  e.dataTransfer.setData(KIND, JSON.stringify(dragKeys));
  e.dataTransfer.effectAllowed = 'move';
  tile.classList.add('is-dragging');
});
gridEl.addEventListener('dragend', () => {
  dragKeys = null;
  explorerEl.querySelectorAll('.is-dragging, .is-over').forEach((el) => el.classList.remove('is-dragging', 'is-over'));
  explorerEl.classList.remove('is-over');
});

/* 놓을 곳을 정한다. 돌려주는 것: {folderId} | {sheet} | null */
function dropTarget(e) {
  const dt = e.dataTransfer;
  const files = hasFiles(dt), tiles = hasTiles(dt) || !!dragKeys;
  if (!files && !tiles) return null;
  const crumb = e.target.closest('[data-crumb]');
  if (crumb) return { folderId: crumb.dataset.crumb === 'root' ? null : Number(crumb.dataset.crumb), el: crumb };
  const tile = e.target.closest('.tile');
  if (tile && tile.dataset.f) {
    const id = Number(tile.dataset.f);
    if (tiles && (dragKeys || []).includes('f:' + id)) return null;      /* 자기 위에 놓기 */
    return { folderId: id, el: tile };
  }
  if (tile && files) return { sheet: sheetById(Number(tile.dataset.s)), el: tile };
  if (tile) return null;
  if (!e.target.closest('#grid')) return null;
  return { folderId: cur, el: null };
}
explorerEl.addEventListener('dragover', (e) => {
  const t = dropTarget(e);
  explorerEl.querySelectorAll('.is-over').forEach((el) => el.classList.remove('is-over'));
  explorerEl.classList.toggle('is-over', !!t && !t.el);
  if (!t) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = hasFiles(e.dataTransfer) ? 'copy' : 'move';
  if (t.el) t.el.classList.add('is-over');
});
explorerEl.addEventListener('dragleave', (e) => {
  if (!explorerEl.contains(e.relatedTarget)) {
    explorerEl.querySelectorAll('.is-over').forEach((el) => el.classList.remove('is-over'));
    explorerEl.classList.remove('is-over');
  }
});
explorerEl.addEventListener('drop', (e) => {
  const t = dropTarget(e);
  explorerEl.querySelectorAll('.is-over').forEach((el) => el.classList.remove('is-over'));
  explorerEl.classList.remove('is-over');
  if (!t) return;
  e.preventDefault();
  if (hasFiles(e.dataTransfer)) {
    if (t.sheet) replaceFile(t.sheet, e.dataTransfer.files[0]);
    else uploadFiles(e.dataTransfer.files, t.folderId);
    return;
  }
  let keys = dragKeys;
  if (!keys) { try { keys = JSON.parse(e.dataTransfer.getData(KIND) || '[]'); } catch { keys = []; } }
  if (keys && keys.length && 'folderId' in t) move(keys, t.folderId);
});
/* 탐색기 밖에 떨어뜨리면 브라우저가 PDF 를 열어 버린다 — 막는다 */
document.addEventListener('dragover', (e) => { if (hasFiles(e.dataTransfer)) e.preventDefault(); });
document.addEventListener('drop', (e) => { if (hasFiles(e.dataTransfer)) e.preventDefault(); });

/* ---------- 뷰어 ----------
   서버가 그려준 이미지 한 장을 화면에 꽉 맞춰 보여준다. 스크롤은 없다.
   열 때 전 페이지를 미리 받아두므로 넘길 때 네트워크를 타지 않는다 —
   곡 도중 와이파이가 끊겨도 계속 넘어간다. */

const stage = $('viewer-stage');
const pageImg = $('page-img');
const viewer = $('viewer');
const loadingEl = $('viewer-loading');

let currentSheet = null;
let pageNo = 1;
let pageTotal = 1;
let locked = false;
let touchStart = null;
let hintTimer = null;
let pageBlobs = [];   /* n -> objectURL. 받아둔 페이지는 네트워크 없이 넘긴다 */
let bareTimer = null; /* 컨트롤 자동 숨김 */
let readyTimer = null;

/* 쪽 이미지 주소에 수정 시각을 붙인다. 서버가 한 시간 캐시를 주므로, 파일을 바꾸면 주소가 바뀌어야
   브라우저가 옛 그림을 안 쓴다(2026-10-29). 서버는 v 를 읽지 않는다 — 주소만 다르면 된다. */
const sheetVer = (s) => String((s && s.updatedAt) || '').replace(/\D/g, '').slice(0, 14);
let pageVer = '';
const pageUrl = (id, n) => '/api/sheets/' + id + '/page/' + n + (pageVer ? '?v=' + pageVer : '');

/* 합주 중 화면이 자동 잠금되지 않게 뷰어가 열려 있는 동안 깨워 둔다. */
let wakeLock = null;
async function keepAwake() {
  if (!('wakeLock' in navigator)) return;
  try { wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { /* 거부돼도 무해 */ }
}
function releaseAwake() {
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}
/* 다른 앱에 다녀오면 잠금 해제 요청이 풀린다. 돌아왔을 때 다시 건다. */
document.addEventListener('visibilitychange', () => {
  if (!viewer.hidden && document.visibilityState === 'visible') keepAwake();
});

/* 진입 경로(카메라 QR·즐겨찾기)와 무관하게 Safari 주소창·탭바를 걷어낸다.
   사용자 탭 안에서만 허용되므로, 보조 기기는 대기 화면을 한 번 탭해서 들어간다.
   미지원 기기(iPhone 등)에선 조용히 넘어간다. */
const FS_OK = !!(document.fullscreenEnabled || document.webkitFullscreenEnabled);
const isFull = () => !!(document.fullscreenElement || document.webkitFullscreenElement);

async function enterFullscreen() {
  const el = document.documentElement;
  try {
    if (isFull()) return;
    if (el.requestFullscreen) await el.requestFullscreen();
    else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
  } catch (e) { /* 제스처 밖이거나 거부됨 — 띠가 그대로 남아 다시 누를 수 있다 */ }
  paintFs();
}
function exitFullscreen() {
  try {
    if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen();
    else if (document.webkitFullscreenElement && document.webkitExitFullscreen) document.webkitExitFullscreen();
  } catch (e) { /* 무시 */ }
  paintFs();
}

/* 전체화면이 풀려 있으면 띠를 걸어 둔다 — 시스템 제스처로 빠져나와도 바로 되돌아갈
   자리가 생긴다. 악보를 보는 중이거나 페어 중일 때만 띄워 평소엔 방해하지 않는다. */
function paintFs() {
  const full = isFull();
  const want = FS_OK && !full && (!viewer.hidden || Pair.active());
  $('fs-cue').hidden = !want;
  document.body.classList.toggle('has-fs-cue', want);
  const btn = $('viewer-fs');
  btn.hidden = !FS_OK;
  btn.classList.toggle('is-on', full);
  btn.setAttribute('aria-label', full ? '전체화면 나가기' : '전체화면');
}

document.addEventListener('fullscreenchange', paintFs);
document.addEventListener('webkitfullscreenchange', paintFs);

/* ---------- 페어 (두 아이패드) ----------
   1번(main)은 홀수쪽, 2번(sub)은 짝수쪽을 맡는다. 넘김은 보면대처럼 한 번에 한 쪽씩 번갈아 간다
   (2026-10-29 사용자 결정): 1,2 → 3,2 → 3,4 → 5,4 … 어느 기기에서 넘겨도 뒤처진 쪽만 두 쪽 앞으로 가고,
   지금 보고 치는 쪽은 바뀌지 않는다. 그래서 3쪽짜리는 3,2 에서 끝나고 빈 화면이 없다(악보 절반이 3쪽).
   전에는 두 기기가 펼침(1,2 → 3,4) 단위로 같이 넘어가 3쪽짜리 끝이 '3, (마지막 쪽)' 이었고,
   2쪽을 치는 동안엔 넘길 수 없었다.
   pageNo 변수는 솔로일 땐 쪽 번호, 페어일 땐 걸음(step) 번호다 — 걸음 k 의 두 쪽은 pairPages(k). */
let pairLinked = false;
let peerCount = 0;
let lastTitle = '';

let shownPage = 1;   /* 화면에 실제로 떠 있는 쪽 번호 — 페어가 풀릴 때 기준이 된다 */

/* 걸음 k(1부터)에서 두 기기가 보이는 쪽. 걸음마다 한쪽만 두 쪽 간다.
     k:    1    2    3    4
     main: 1    3    3    5
     sub:  2    2    4    4
   쪽수 N 이면 걸음은 N-1 개(N≥2). 1쪽짜리는 걸음 하나, 2번 기기엔 보일 쪽이 없다. */
function pairPages(k) {
  return { main: 2 * Math.ceil((k - 1) / 2) + 1, sub: 2 * Math.floor((k - 1) / 2) + 2 };
}
function maxStep() { return Pair.active() ? Math.max(1, pageTotal - 1) : pageTotal; }
function stepPage(n) { return Pair.active() ? pairPages(n)[Pair.isSub() ? 'sub' : 'main'] : n; }

/* 페어가 끝난 직후 — 보조 기기는 페어 전용 화면에 갇혀 있으니 메인으로 내보내고,
   주 기기는 펼침 번호를 실제 쪽 번호로 되돌려 표시가 어긋나지 않게 한다. */
function afterUnpair(role) {
  if (role === 'sub') { location.replace('/songs/'); return; }
  $('pair-modal').hidden = true;
  if (currentSheet) showPage(Math.min(Math.max(1, shownPage), pageTotal));
  paintPairBtn();
  paintLink();
  if (viewer.hidden) exitFullscreen();   /* 악보를 보는 중이면 전체화면은 그대로 둔다 */
  else paintFs();
  updateStandby();
}

function broadcastState() {
  if (!Pair.active() || !currentSheet) return;
  Pair.send({ sheetId: currentSheet.id, spread: pageNo,
              title: currentSheet.title, pages: pageTotal });
}

/* 상대가 보낸 상태를 이 화면에 반영한다. 여기서 다시 send 하지 않는다(메아리 방지). */
async function applyPairState(st) {
  if (st.sheetId == null) {
    if (!viewer.hidden) closeViewer(true);
    updateStandby();
    return;
  }
  if (currentSheet && currentSheet.id === st.sheetId) {
    if (st.spread && st.spread !== pageNo) showPage(st.spread, true);
    return;
  }
  openViewer(await resolveSheet(st), { spread: st.spread || 1 });
}

/* 상대가 열라고 한 악보를 내 목록에서 찾는다. 필터로 가려져 있으면 전체를 다시 받아 본다. */
async function resolveSheet(st) {
  let s = sheets.find((x) => x.id === st.sheetId);
  if (!s) {
    try { s = (await api.get('/sheets')).find((x) => x.id === st.sheetId); } catch (e) { /* 무시 */ }
  }
  return s || { id: st.sheetId, title: st.title || '', pages: st.pages || null };
}

const pairBtn = $('pair-btn');
function paintPairBtn() {
  pairBtn.classList.toggle('is-on', Pair.active());
  pairBtn.textContent = Pair.active() ? '페어 중' : '페어';
}

function paintPeers() {
  $('pair-peers').textContent = peerCount >= 2
    ? '연결된 기기 ' + peerCount + '대' : '아직 연결된 기기가 없습니다';
}

function openPairModal() {
  const link = location.origin + '/sheets/?pair=' + Pair.code();
  const qr = qrcode(0, 'M');
  qr.addData(link);
  qr.make();
  $('pair-qr').innerHTML = qr.createSvgTag({ cellSize: 5, margin: 2, scalable: true });
  $('pair-code').textContent = Pair.code();
  paintPeers();
  $('pair-modal').hidden = false;
}

pairBtn.addEventListener('click', async () => {
  if (!Pair.active()) {
    await Pair.create();
    paintPairBtn();
    paintFs();          /* 페어를 걸면 목록에서도 미리 전체화면에 들어갈 수 있다 */
  }
  openPairModal();
});
$('pair-close').addEventListener('click', () => { $('pair-modal').hidden = true; });
/* 어느 쪽에서 끊든 상대도 함께 풀린다 — 서버가 방 전체에 알린다 */
$('pair-stop').addEventListener('click', () => afterUnpair(Pair.stop()));
$('standby-stop').addEventListener('click', () => afterUnpair(Pair.stop()));

/* 대기 화면 아무 데나 탭해도 들어간다 */
$('pair-standby').addEventListener('click', (e) => {
  if (e.target.closest('button')) return;
  enterFullscreen();
});

$('fs-cue').addEventListener('click', enterFullscreen);
$('viewer-fs').addEventListener('click', (e) => {
  e.stopPropagation();
  isFull() ? exitFullscreen() : enterFullscreen();
  scheduleBare();
});

/* 페어 연결이 끊긴 동안엔 어느 화면에서든 알 수 있게 뱃지를 띄운다 */
function paintLink() {
  $('pair-lost').hidden = pairLinked || !Pair.active();
}

/* 2번(보조) 기기는 악보가 닫혀 있는 동안 대기 화면을 띄운다. */
function updateStandby() {
  const show = Pair.isSub() && viewer.hidden;
  $('pair-standby').hidden = !show;
  if (show) {
    $('standby-state').textContent = pairLinked
      ? '연결됨 · 1번 아이패드에서 악보를 열면 표시됩니다' : '연결 중...';
    $('standby-last').textContent = lastTitle ? '마지막 악보: ' + lastTitle : '';
    keepAwake();                    /* 대기 중에도 화면이 꺼지지 않게 */
  }
}

/* 열고 잠시 뒤 독을 스스로 내린다. 연주 화면의 기본은 악보만이다. */
function scheduleBare() {
  clearTimeout(bareTimer);
  bareTimer = setTimeout(() => {
    if (!viewer.hidden) viewer.classList.add('is-bare');
  }, 3000);
}

/* 화면 가운데를 누르면 그 자리에서 독이 오르내린다 — 버튼을 조준할 필요가 없다. */
function toggleDock() {
  if (viewer.classList.toggle('is-bare')) clearTimeout(bareTimer);
  else scheduleBare();
}

/* 쪽수 — 악보가 화면을 꽉 채우므로 상시 표시는 무엇이든 음표를 가린다.
   그래서 뱃지는 넘긴 직후에만 잠깐 떠오르고, 평소 쪽수는 독에서 확인한다. */
let markTimer = null;

function setMark(cur, total, flash) {
  const mark = $('viewer-page');
  mark.querySelector('b').textContent = cur;
  mark.querySelector('span').textContent = total;
  $('dock-page').textContent = (cur === '-' && total === '-') ? '' : cur + ' / ' + total;
  clearTimeout(markTimer);
  if (!flash) { mark.classList.remove('is-on'); return; }
  mark.classList.add('is-on');
  markTimer = setTimeout(() => mark.classList.remove('is-on'), 1000);
}

/* 서버가 여백을 잘라 보내주므로 화면에 꽉 맞추기만 하면 된다.
   더 키우고 싶으면 손가락으로 벌리면 된다 (막아두지 않았다). */
function layout() {
  const cw = stage.clientWidth;
  const ch = stage.clientHeight;
  const iw = pageImg.naturalWidth;
  const ih = pageImg.naturalHeight;
  if (!iw || !ih || !cw || !ch) return;
  /* 세로가 더 긴 화면(손에 드는 기기)은 가로를 꽉 채운다 — 악보는 위아래가 조금
     잘리더라도 넓게 보는 편이 낫다. 다만 잘림은 한 변 CROP_LIMIT 까지만 허용하고,
     그보다 넘칠 것 같으면 딱 그만큼만 잘리는 크기로 멈춘다.
     가로가 더 긴 화면(PC·눕힌 태블릿)은 크게 잘려 못 쓰게 되므로 전체를 보여준다. */
  const s = ch > cw
    ? Math.min(cw / iw, ch / (ih * (1 - 2 * CROP_LIMIT)))
    : Math.min(cw / iw, ch / ih);
  pageImg.style.width = Math.round(iw * s) + 'px';
  pageImg.style.height = Math.round(ih * s) + 'px';
}

/* flash 를 주면 쪽수 뱃지가 잠깐 떠오른다 — 이 기기의 쪽이 실제로 바뀌었을 때만.
   페어에서 넘겨도 내 쪽이 그대로면(치는 중인 기기) 악보 위에 아무것도 띄우지 않는다 — 옆 기기가 넘어가는 게 곧 피드백이다. */
function showPage(n, flash) {
  if (!currentSheet) return;
  pageNo = Math.min(Math.max(1, n), maxStep());
  const p = stepPage(pageNo);
  if (flash && p === shownPage && !pageImg.hidden) flash = false;
  if (p > pageTotal) {
    /* 홀수 쪽수 악보의 마지막 펼침 — 보조 화면엔 짝수쪽이 없다 */
    pageImg.removeAttribute('src');
    pageImg.hidden = true;
    loadingEl.textContent = '(마지막 쪽)';
    loadingEl.hidden = false;
    setMark('-', pageTotal, flash);
    shownPage = pageTotal;
  } else {
    pageImg.src = pageBlobs[p] || pageUrl(currentSheet.id, p);
    setMark(p, pageTotal, flash);
    shownPage = p;
  }
}

function turn(dir) {
  if (locked) return;
  const next = pageNo + dir;
  if (next < 1 || next > maxStep()) return;
  locked = true;
  showPage(next, true);           /* 넘긴 직후에만 쪽수를 잠깐 보여준다 */
  broadcastState();               /* 페어 중이면 상대도 같이 넘어간다 */
  setTimeout(() => { locked = false; }, LOCK_MS);
}

/* 열자마자 전 페이지를 받아 blob 으로 들고 있는다. 4쪽짜리가 600KB 남짓이라
   부담이 없고, 곡 도중 와이파이가 끊겨도 이미 받은 쪽은 계속 넘어간다.
   몇 쪽까지 준비됐는지 보여줘서 "이제 와이파이 없어도 되는" 시점을 알린다. */
function prefetch(id, total) {
  const readyEl = $('viewer-ready');
  let ready = 0;
  clearTimeout(readyTimer);
  readyEl.hidden = false;
  readyEl.classList.remove('is-done');
  readyEl.textContent = '0/' + total;
  for (let n = 1; n <= total; n++) {
    fetch(pageUrl(id, n))
      .then((r) => { if (!r.ok) throw new Error(r.status); return r.blob(); })
      .then((b) => {
        if (!currentSheet || currentSheet.id !== id) return;   /* 그새 닫혔으면 버린다 */
        pageBlobs[n] = URL.createObjectURL(b);
        ready++;
        if (ready >= total) {
          readyEl.textContent = '준비 완료';
          readyEl.classList.add('is-done');
          readyTimer = setTimeout(() => { readyEl.hidden = true; }, 2500);
        } else {
          readyEl.textContent = ready + '/' + total;
        }
      })
      .catch(() => {});   /* 실패한 쪽은 넘길 때 네트워크 URL 로 물러선다 */
  }
}

function flashHint() {
  const hint = $('tap-hint');
  hint.classList.add('is-on');
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => hint.classList.remove('is-on'), 1400);
}

/* remote 가 있으면 상대 기기가 연 것 — 다시 send 하지 않고 그 펼침 위치로 맞춘다. */
async function openViewer(sheet, remote) {
  currentSheet = sheet;
  pageVer = sheetVer(sheet);
  lastTitle = sheet.title || '';
  viewer.hidden = false;
  viewer.classList.remove('is-bare');       /* 지난번 숨김 상태를 되돌린다 */
  $('viewer-ready').hidden = true;
  document.body.style.overflow = 'hidden';
  keepAwake();
  /* 사용자 탭으로 연 경우만 바로 시도한다. 원격으로 열린 쪽(2번)은 제스처가 없어
     거부되므로, 대신 띠를 걸어 한 번 누르면 들어가게 한다. */
  if (remote) paintFs();
  else enterFullscreen();
  $('viewer-title').textContent = [sheet.title, sheet.role].filter(Boolean).join(' · ');
  setMark('-', '-');
  pageImg.removeAttribute('src');
  pageImg.hidden = true;
  loadingEl.textContent = '악보를 불러오는 중...';   /* 지난번 에러 문구를 지운다 */
  loadingEl.hidden = false;
  pageBlobs.forEach((u) => u && URL.revokeObjectURL(u));
  pageBlobs = [];

  /* 쪽수를 알아내기 전에 먼저 알린다. 쪽수 조회는 처음 여는 악보라면 서버가 PDF 를
     여는 데 몇 초가 걸려서, 그 뒤에 보내면 상대 화면이 그동안 대기 상태로 남는다.
     지금 보내면 두 기기가 나란히 준비된다. */
  if (!remote) {
    pageNo = 1;
    Pair.send({ sheetId: sheet.id, spread: 1,
                title: sheet.title || '', pages: sheet.pages || null });
  }

  try {
    const info = sheet.pages
      ? { pages: sheet.pages }
      : await api.get('/sheets/' + sheet.id + '/pages');
    pageTotal = Math.max(1, info.pages || 1);
    showPage(remote ? remote.spread : 1);
    if (!remote) broadcastState();   /* 쪽수까지 확정됐으니 한 번 더 — 위치는 그대로다 */
    prefetch(sheet.id, pageTotal);
    flashHint();
    scheduleBare();
  } catch (err) {
    loadingEl.textContent = '악보를 열 수 없습니다. ' + (err.message || '');
  }
}

function closeViewer(fromRemote) {
  viewer.hidden = true;
  document.body.style.overflow = '';
  pageImg.removeAttribute('src');
  currentSheet = null;
  pageBlobs.forEach((u) => u && URL.revokeObjectURL(u));
  pageBlobs = [];
  clearTimeout(bareTimer);
  clearTimeout(readyTimer);
  releaseAwake();
  if (fromRemote !== true && Pair.active()) Pair.send({ sheetId: null, spread: 1 });
  /* 페어 중엔 전체화면을 유지한다 — 다음 악보를 열 때 다시 들어갈 필요가 없다 */
  if (Pair.active()) paintFs();
  else exitFullscreen();
  updateStandby();
}

pageImg.addEventListener('load', () => {
  pageImg.hidden = false;
  loadingEl.hidden = true;
  layout();
});
pageImg.addEventListener('error', () => {
  if (!currentSheet) return;
  loadingEl.textContent = stepPage(pageNo) + '쪽을 불러오지 못했습니다.';
  loadingEl.hidden = false;
});

$('viewer-close').addEventListener('click', closeViewer);
$('page-prev').addEventListener('click', () => turn(-1));
$('page-next').addEventListener('click', () => turn(1));
/* 독을 만지는 동안엔 자동으로 내려가지 않게 시계를 되감는다 */
$('viewer-dock').addEventListener('click', scheduleBare);

/* 입력 — 탭·스와이프·키보드를 전부 한 장 넘김으로 합류시킨다.
   나중에 키보드 방식 풋스위치를 붙여도 그대로 동작한다.

   화면은 위 35% = 이전, 아래 35% = 다음, 가운데 30% = 독 부르기로 나눈다.
   컨트롤을 부르려고 구석의 작은 버튼을 조준할 일이 없어진다. */
function tapAt(y) {
  const r = y / window.innerHeight;
  if (r < 0.35) turn(-1);
  else if (r > 0.65) turn(1);
  else toggleDock();
}
window.addEventListener('keydown', (e) => {
  if (viewer.hidden) return;
  if (e.code === 'Escape') { closeViewer(); return; }
  const next = ['ArrowDown', 'ArrowRight', 'PageDown', 'Space', 'Enter'].includes(e.code)
    || e.key === ' ';
  const prev = ['ArrowUp', 'ArrowLeft', 'PageUp'].includes(e.code);
  if (next || prev) { e.preventDefault(); turn(next ? 1 : -1); }
});

stage.addEventListener('touchstart', (e) => {
  const t = e.changedTouches[0];
  touchStart = { x: t.clientX, y: t.clientY };
}, { passive: true });

stage.addEventListener('touchend', (e) => {
  if (!touchStart) return;
  const t = e.changedTouches[0];
  const dx = t.clientX - touchStart.x;
  const dy = t.clientY - touchStart.y;
  touchStart = null;
  if (Math.hypot(dx, dy) <= TAP_MAX_MOVE) {
    tapAt(t.clientY);
  } else if (Math.abs(dy) > Math.abs(dx)) {
    /* 아래로 크게 쓸어내리면 닫기. 그보다 짧게 내리다 만 것은 무시해서
       닫으려다 실수로 한 장 넘어가는 일을 막는다. */
    if (dy > 0) { if (dy > CLOSE_SWIPE) closeViewer(); }
    else turn(1);                         /* 위로 쓸면 = 다음 */
  } else {
    turn(dx < 0 ? 1 : -1);                /* 왼쪽으로 쓸면 = 다음 */
  }
}, { passive: true });

stage.addEventListener('click', (e) => {
  if (e.pointerType === 'touch') return;
  tapAt(e.clientY);
});

let resizeTimer = null;
window.addEventListener('resize', () => {
  if (viewer.hidden) return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(layout, 150);
});

mountChrome('sheets');
refresh().catch(console.error);

Pair.init({
  onState: (st) => { applyPairState(st).catch(console.error); },
  onPeers: (n) => { peerCount = n; if (!$('pair-modal').hidden) paintPeers(); },
  onLink: (ok) => { pairLinked = ok; paintLink(); updateStandby(); },
  onGone: afterUnpair,                              /* 상대가 페어를 해제했다 */
});
paintPairBtn();
paintLink();
paintFs();
updateStandby();
