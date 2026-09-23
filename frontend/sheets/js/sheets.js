/* 악보 — 곡 목록과 독립된 라이브러리 + 전체화면 PDF 뷰어.
   파트를 한 번 고르고 여러 파일을 한꺼번에 올린다. 제목·아티스트·BPM 은
   악보 본문에서 자동으로 뽑아 미리 채우고, 사용자가 확인만 하면 된다. */

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

/* 파트·태그 목록은 common.js 에서 한 번만 정의한다 */
const ROLES = SHEET_ROLES;

/* 264ppi급 아이패드(10.2·11인치)는 CSS 1mm ≈ 5.2px. 실물 크기 환산용 근사값. */
const PX_PER_MM = 5.2;
const PT_PER_MM = 72 / 25.4;
const LOCK_MS = 380;
const TAP_MAX_MOVE = 14;
const CLOSE_SWIPE = 90;   /* 이만큼 아래로 쓸어내리면 뷰어를 닫는다 */
const CROP_LIMIT = 0.015; /* 세로 화면에서 위·아래 각각 이만큼까지만 잘라낸다 */

let sheets = [];
let pending = [];                 /* 올리기 전 파일 + 추출 결과 */
let upRole = '보컬';
let upTag = '';                   /* 올릴 때 붙일 태그 (하나) */
let filterRole = '';
let filterTag = '';               /* 목록 필터 태그 (하나) */
let tagCounts = {};
let selectMode = false;
let selected = new Set();
let editingId = null;
let editRole = '';            /* 수정 중인 줄의 파트 */
let editTag = '';             /* 수정 중인 줄의 태그 */
let openDrop = null;          /* 열려 있는 도구줄 메뉴 — 'role' | 'tag' | null */

const $ = (id) => document.getElementById(id);
const listEl = $('list');
const searchEl = $('search');
const fileInput = $('file-input');
const fileFake = $('file-fake');
const statusEl = $('upload-status');
const previewEl = $('preview');
const previewList = $('preview-list');
const bulkBar = $('bulk-bar');

/* ---------- 칩 ---------- */
function chipHtml(value, label, on, count) {
  return '<button type="button" class="chip' + (on ? ' is-on' : '') +
    '" data-v="' + escapeHtml(value) + '">' + escapeHtml(label) +
    (count ? '<i>' + count + '</i>' : '') + '</button>';
}

function bindChips(el, html, onPick) {
  el.innerHTML = html;
  el.onclick = (e) => {
    const btn = e.target.closest('.chip');
    if (btn) onPick(btn.dataset.v);
  };
}

/* 목록 필터의 한 줄 — 곡 목록(songs.js)의 .menu-item 과 같은 부품이다.
   파트도 태그도 하나만 고르므로 체크가 아니라 점 표시가 붙는다. */
function menuHtml(value, label, on, count) {
  return '<button type="button" class="menu-item' + (on ? ' is-on' : '') +
    '" data-v="' + escapeHtml(value) + '">' + escapeHtml(label) +
    (count ? '<i>' + count + '</i>' : '') + '</button>';
}

function renderTools() {
  /* 올릴 때 고르는 파트·태그와 일괄 처리의 파트·태그는 칩 그대로 둔다.
     이미 펼쳐 놓은 판 안에 있어서 고르는 즉시 결과가 보인다. 메뉴로 한 번 더 감출 이유가 없다. */
  bindChips($('up-role'), ROLES.map((r) => chipHtml(r, r, r === upRole)).join(''),
    (v) => { upRole = v; renderTools(); });

  bindChips($('up-tags'), TAGS.map((t) => chipHtml(t, t, t === upTag)).join(''),
    (v) => {
      upTag = (v === upTag) ? '' : v;      /* 다시 누르면 해제 */
      /* 위에서 고른 태그는 이미 담아둔 파일 전부에 즉시 반영한다. */
      pending.forEach((p) => { p.tag = upTag; });
      renderTools();
      paintPreview();
    });

  bindChips($('bulk-tags'), TAGS.map((t) => chipHtml(t, t, false)).join(''),
    (v) => applyBulk({ tag: v }));

  bindChips($('bulk-role'), ROLES.map((r) => chipHtml(r, r, false)).join(''),
    (v) => applyBulk({ role: v }));

  /* 도구줄에는 현재 값만 글자로 남는다. 고르지 않았으면 항목 이름이 그대로 라벨이다. */
  $('role-label').textContent = filterRole || '파트';
  $('drop-role').classList.toggle('is-set', !!filterRole);
  $('menu-role').innerHTML = menuHtml('', '전체', !filterRole) +
    ROLES.map((r) => menuHtml(r, r, r === filterRole)).join('');

  $('tag-label').textContent = filterTag || '태그';
  $('drop-tag').classList.toggle('is-set', !!filterTag);
  $('menu-tag').innerHTML = menuHtml('', '전체', !filterTag) +
    TAGS.map((t) => menuHtml(t, t, t === filterTag, tagCounts[t])).join('');

  for (const k of ['role', 'tag']) {
    $('menu-' + k).hidden = openDrop !== k;
    $('drop-' + k).classList.toggle('is-open', openDrop === k);
  }
}

/* 도구줄: 메뉴 열고 닫기 + 항목 고르기. 곡 목록과 같은 규칙이다. */
document.querySelector('.tool-line').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-drop]');
  if (btn) {
    openDrop = openDrop === btn.dataset.drop ? null : btn.dataset.drop;
    renderTools();
    return;
  }
  const item = e.target.closest('.menu-item');
  if (!item) return;
  const which = item.closest('.drop').id === 'drop-role' ? 'role' : 'tag';
  if (which === 'role') filterRole = item.dataset.v;
  else filterTag = item.dataset.v;
  openDrop = null;
  renderTools();
  refresh().catch(console.error);
});

/* 바깥을 누르면 닫힌다 */
document.addEventListener('click', (e) => {
  if (openDrop && !e.target.closest('.drop')) { openDrop = null; renderTools(); }
});

/* ---------- 목록 ---------- */
function fmtSize(bytes) {
  if (!bytes) return '';
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? mb.toFixed(1) + 'MB' : Math.round(bytes / 1024) + 'KB';
}

function sheetRow(s) {
  if (s.id === editingId) {
    return [
      '<li class="sheet-item is-editing" data-row="', s.id, '">',
      '<div class="edit-grid">',
      '<input type="text" data-f="title" value="', escapeHtml(s.title || ''), '" placeholder="제목" />',
      '<input type="text" data-f="artist" value="', escapeHtml(s.artist || ''), '" placeholder="아티스트" />',
      '<input type="number" data-f="bpm" value="', s.bpm || '', '" placeholder="BPM" />',
      '<div class="edit-chips"><span class="edit-label">파트</span><span class="chip-set">',
      ROLES.map((r) => chipHtml(r, r, r === editRole).replace('data-v=', 'data-erole=')).join(''),
      '</span></div>',
      '<div class="edit-chips"><span class="edit-label">태그</span><span class="chip-set">',
      TAGS.map((t) => chipHtml(t, t, t === editTag).replace('data-v=', 'data-etag=')).join(''),
      '</span></div>',
      '<div class="edit-actions">',
      '<button type="button" class="pink" data-save="', s.id, '">저장</button>',
      '<button type="button" class="ghost" data-cancel>취소</button>',
      '<button type="button" class="ghost danger" data-del="', s.id, '">삭제</button>',
      '</div></div></li>',
    ].join('');
  }
  /* 제목 줄은 곡 목록과 같다 — 제목, 그 옆에 태그를 면 없이 글자로. 알약을 줄마다
     빛내면 제목이 안 읽힌다. 파트는 악보에서 제목 다음으로 중요하므로 앞에 세운다. */
  const bits = [s.artist, s.bpm ? '♩' + s.bpm : '', fmtSize(s.sizeBytes)]
    .filter(Boolean).map(escapeHtml).join('<span class="meta-sep">·</span>');
  /* 잘렸을 때만 켠다 — fitPeek() 가 실제로 재서 정한다. 여기서는 담아만 둔다. */
  const peek = [s.title || '제목 없음', s.artist, s.role, s.tags].filter(Boolean).join(' · ');
  return [
    '<li class="sheet-item', selected.has(s.id) ? ' is-picked' : '', '" data-id="', s.id, '"',
    ' data-peek-full="', escapeHtml(peek), '"',
    selectMode ? '' : ' data-open="' + s.id + '"', '>',
    selectMode ? '<span class="pick-box">' + (selected.has(s.id) ? '✓' : '') + '</span>' : '',
    /* 1쪽 썸네일 — 화면에 보일 때만 받는다(lazy). 선택 모드가 아니면 눌러서 바로 연다.
       못 그린 악보는 이미지만 숨고 장르색 바탕이 남는다. 홈·곡의 자켓과 같은 규칙이다. */
    '<span class="sheet-thumb genre-', songTone(s), '">',
    '<img class="th-img" loading="lazy" alt="" src="/api/sheets/', s.id, '/page/1?w=400" />',
    '</span>',
    '<span class="sheet-main">',
    '<span class="sheet-title-row">',
    '<span class="sheet-name">', escapeHtml(s.title || '제목 없음'), '</span>',
    '<span class="sheet-role">', escapeHtml(s.role || '분류 없음'), '</span>',
    s.tags ? '<span class="sheet-tag">' + escapeHtml(s.tags) + '</span>' : '',
    '</span>',
    '<span class="sheet-sub">', bits,
    s.uploadedBy ? '<span class="meta-sep">·</span>' + avatarChip(s.uploadedBy, 'tiny') : '', '</span>',
    '</span>',
    selectMode ? '' : '<button type="button" class="row-edit" data-edit="' + s.id + '">수정</button>',
    '</li>',
  ].join('');
}

/* 제목이 칸에 들어가는지 실제로 재서, 잘린 줄에만 쪽지를 켠다.
   글자 수로 어림하지 않는다 — 곡 목록의 fitNames() 와 같은 이유다.
   읽기를 전부 한 번에 하고 쓰기를 전부 한 번에 한다. */
function fitPeek() {
  const rows = [...listEl.querySelectorAll('.sheet-item[data-peek-full]')];
  if (!rows.length) return;
  const clipped = rows.map((li) => {
    const n = li.querySelector('.sheet-name');
    return n && n.scrollWidth > n.clientWidth + 1;
  });
  rows.forEach((li, i) => {
    if (clipped[i]) li.setAttribute('data-peek', li.dataset.peekFull);
    else li.removeAttribute('data-peek');
  });
}

/* 창 폭이 바뀌면 칸 폭도 바뀐다. 연달아 들어오는 동안은 마지막 것만 센다. */
let fitTimer = null;
addEventListener('resize', () => {
  clearTimeout(fitTimer);
  fitTimer = setTimeout(fitPeek, 120);
});

function paint() {
  listEl.innerHTML = sheets.length
    ? sheets.map(sheetRow).join('')
    : '<li class="sheet-empty muted">조건에 맞는 악보가 없습니다.</li>';
  /* 개수는 제목 옆 숫자로 간다 — 곡 목록과 같은 자리다. 필터를 걸면 몇 개가 남았는지 바로 보인다. */
  $('list-count').textContent = sheets.length || '';
  $('select-all').hidden = !selectMode;
  $('select-toggle').classList.toggle('is-on', selectMode);
  fitPeek();
  paintBulk();
}

function paintBulk() {
  bulkBar.hidden = !selectMode || selected.size === 0;
  $('bulk-count').textContent = selected.size + '개 선택됨';
}

let refreshSeq = 0;
async function refresh() {
  const seq = ++refreshSeq;
  const params = new URLSearchParams();
  if (searchEl.value.trim()) params.set('q', searchEl.value.trim());
  if (filterRole) params.set('role', filterRole);
  if (filterTag) params.set('tag', filterTag);
  const qs = params.toString();
  const [rows, counts] = await Promise.all([
    api.get('/sheets' + (qs ? '?' + qs : '')),
    api.get('/sheets/tag-counts'),
  ]);
  if (seq !== refreshSeq) return;   /* 뒤늦게 도착한 이전 검색 응답은 버린다 */
  sheets = rows;
  tagCounts = counts;
  selected = new Set([...selected].filter((id) => sheets.some((s) => s.id === id)));
  renderTools();
  paint();
}

let searchTimer = null;
searchEl.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => refresh().catch(console.error), 250);
});

/* 렌더에 실패한 썸네일은 자리만 남기고 숨긴다 (error는 버블링하지 않아 캡처로 받는다) */
listEl.addEventListener('error', (e) => {
  if (e.target.classList && e.target.classList.contains('th-img')) {
    e.target.classList.add('is-broken');
  }
}, true);

/* ---------- 업로드 접기 — 평소엔 목록이 주인공이다 ----------
   전에는 카드 머리 전체가 누르는 자리였고 ▾ 이 뒤집혔다. 지금은 제목 줄의
   '＋ 악보 올리기' 가 그 일을 한다 — 곡 목록의 '＋ 곡 등록' 과 같은 자리, 같은 무게다.
   진짜 <button> 이라 Enter·Space 는 브라우저가 알아서 받는다. */
$('upload-toggle').addEventListener('click', () => {
  const body = $('upload-body');
  const btn = $('upload-toggle');
  body.hidden = !body.hidden;
  btn.setAttribute('aria-expanded', String(!body.hidden));
  btn.textContent = body.hidden ? '＋ 악보 올리기' : '× 닫기';
});

/* ---------- 파일 담기 → 악보에서 정보 뽑기 ---------- */
const FILE_PICK_LABEL = '파일 선택 · 끌어다 놓기도 됩니다';

function fileKey(f) {
  return f.name + '|' + f.size;
}

/* 고를 때마다 덮어쓰지 않고 뒤에 붙인다. 나눠서 담을 수 있어야 한다. */
async function addFiles(files) {
  const incoming = [...files];
  if (!incoming.length) return;
  /* 뷰어가 PDF만 그릴 수 있으므로 다른 형식은 여기서 걸러낸다. */
  const pdfs = incoming.filter((f) => /\.pdf$/i.test(f.name || ''));
  const notPdf = incoming.length - pdfs.length;
  const known = new Set(pending.map((p) => fileKey(p.file)));
  const fresh = pdfs.filter((f) => !known.has(fileKey(f)));
  const dupes = pdfs.length - fresh.length;

  let done = 0;
  for (const file of fresh) {
    fileFake.textContent = ++done + ' / ' + fresh.length + ' 읽는 중...';
    const info = await extractSheetInfo(await getPdfjs(), file);
    pending.push({ file, ...info, tag: upTag });
    paintPreview();
  }
  const notes = [];
  if (dupes) notes.push('같은 파일 ' + dupes + '개 제외');
  if (notPdf) notes.push('PDF 아닌 파일 ' + notPdf + '개 제외');
  fileFake.textContent = FILE_PICK_LABEL + (notes.length ? '  (' + notes.join(' · ') + ')' : '');
  paintPreview();
}

fileInput.addEventListener('change', async () => {
  await addFiles(fileInput.files);
  /* 값을 비워야 같은 파일을 지웠다가 다시 고를 수 있다. */
  fileInput.value = '';
});

/* 탐색기에서 끌어다 놓기 */
const dropZone = document.querySelector('.file-pick');
['dragenter', 'dragover'].forEach((type) => {
  dropZone.addEventListener(type, (e) => {
    e.preventDefault();
    dropZone.classList.add('is-drag');
  });
});
['dragleave', 'drop'].forEach((type) => {
  dropZone.addEventListener(type, () => dropZone.classList.remove('is-drag'));
});
dropZone.addEventListener('drop', async (e) => {
  e.preventDefault();
  await addFiles(e.dataTransfer.files);
});

function paintPreview() {
  previewEl.hidden = !pending.length;
  if (!pending.length) return;
  const fromBody = pending.filter((p) => p.source === '악보 본문').length;
  const noTag = pending.filter((p) => !p.tag).length;
  const total = pending.reduce((sum, p) => sum + p.file.size, 0);
  $('preview-count').textContent = pending.length + '개 · ' + fmtSize(total) +
    ' · 본문에서 읽어낸 것 ' + fromBody + '개' +
    (noTag ? ' · 태그 없음 ' + noTag + '개' : '');
  previewList.innerHTML = pending.map((p, i) => [
    '<li data-i="', i, '">',
    '<input type="text" data-f="title" value="', escapeHtml(p.title || ''), '" placeholder="제목" />',
    '<input type="text" data-f="artist" value="', escapeHtml(p.artist || ''), '" placeholder="아티스트" />',
    '<input type="number" data-f="bpm" value="', p.bpm || '', '" placeholder="BPM" />',
    '<span class="chip-set row-tags">',
    TAGS.map((t) => chipHtml(t, t, t === p.tag)).join(''),
    '</span>',
    '<button type="button" class="row-del" data-drop="', i, '" title="이 줄 빼기">✕</button>',
    '<span class="preview-file">', escapeHtml(p.file.name),
    p.pages ? ' · ' + p.pages + '쪽' : '', '</span>',
    '</li>',
  ].join('')).join('');
}

previewList.addEventListener('click', (e) => {
  const del = e.target.closest('[data-drop]');
  if (del) {
    pending.splice(Number(del.dataset.drop), 1);
    paintPreview();
    return;
  }
  const chip = e.target.closest('.row-tags .chip');
  if (!chip) return;
  const item = pending[Number(chip.closest('[data-i]').dataset.i)];
  const v = chip.dataset.v;
  item.tag = (v === item.tag) ? '' : v;   /* 다시 누르면 해제 */
  paintPreview();
});

previewList.addEventListener('input', (e) => {
  const li = e.target.closest('[data-i]');
  if (!li) return;
  const item = pending[Number(li.dataset.i)];
  const f = e.target.dataset.f;
  item[f] = f === 'bpm' ? (Number(e.target.value) || null) : e.target.value;
});

$('preview-clear').addEventListener('click', () => {
  pending = [];
  fileInput.value = '';
  fileFake.textContent = FILE_PICK_LABEL;
  paintPreview();
});

$('upload-btn').addEventListener('click', async () => {
  if (!pending.length) return;
  const uploadedBy = await Nick.ensure();
  if (!uploadedBy) return;

  const form = new FormData();
  form.append('role', upRole);
  form.append('tags', upTag);
  form.append('uploadedBy', uploadedBy);
  form.append('meta', JSON.stringify(pending.map((p) =>
    ({ title: p.title, artist: p.artist, bpm: p.bpm, pages: p.pages || null,
       tags: p.tag || '' }))));
  pending.forEach((p) => form.append('files', p.file));

  $('upload-btn').disabled = true;
  statusEl.hidden = false;
  statusEl.textContent = pending.length + '개 올리는 중...';
  try {
    const res = await api.post('/sheets', form);
    const skipped = res.skipped || [];
    statusEl.textContent = res.created.length + '개 완료' + (skipped.length
      ? ' · 제외: ' + skipped.map((s) => s.fileName + ' (' + s.reason + ')').join(', ')
      : '');
    pending = [];
    fileInput.value = '';
    fileFake.textContent = FILE_PICK_LABEL;
    paintPreview();
    refresh().catch(console.error);   /* 목록은 기다리지 않는다 */
  } catch (err) {
    statusEl.textContent = '실패: ' + (err.message || '');
  } finally {
    $('upload-btn').disabled = false;
    setTimeout(() => { statusEl.hidden = true; }, 4000);
  }
});

/* ---------- 선택 모드 / 일괄 처리 ---------- */
$('select-toggle').addEventListener('click', () => {
  selectMode = !selectMode;
  if (!selectMode) selected.clear();
  paint();
});

$('select-all').addEventListener('click', () => {
  const all = sheets.length > 0 && sheets.every((s) => selected.has(s.id));
  selected = all ? new Set() : new Set(sheets.map((s) => s.id));
  paint();
});

$('bulk-close').addEventListener('click', () => { selected.clear(); paint(); });

/* 돌려받은 악보로 바로 고친다. 검색 조건과 태그 개수는 뒤에서 목록을 다시 받아 맞춘다
   (전에는 그 목록을 받을 때까지 기다렸다). */
function putSheets(rows) {
  rows.forEach((r) => {
    const at = sheets.findIndex((x) => x.id === r.id);
    if (at >= 0) sheets[at] = r;
  });
  paint();
  refresh().catch(console.error);
}
function dropSheets(ids) {
  sheets = sheets.filter((x) => !ids.includes(x.id));
  ids.forEach((id) => selected.delete(id));
  paint();
  refresh().catch(console.error);
}

async function applyBulk(patch) {
  if (!selected.size) return;
  const rows = await Writes.commit(null, 'sheets:bulk',
    () => api.post('/sheets/bulk', { ids: [...selected], ...patch }));
  if (rows) putSheets(rows);
}

$('bulk-delete').addEventListener('click', async () => {
  if (!selected.size) return;
  if (!confirm(selected.size + '개를 삭제할까요?')) return;
  const ids = [...selected];
  const ok = await Writes.commit($('bulk-delete'), 'sheets:bulk', () => api.post('/sheets/bulk-delete', { ids }));
  if (ok) dropSheets(ids);
});

listEl.addEventListener('click', async (e) => {
  const li = e.target.closest('[data-id]');
  if (selectMode && li) {
    const id = Number(li.dataset.id);
    selected.has(id) ? selected.delete(id) : selected.add(id);
    paint();
    return;
  }
  const edit = e.target.closest('[data-edit]');
  if (edit) {
    editingId = Number(edit.dataset.edit);
    const s = sheets.find((x) => x.id === editingId);
    editRole = s ? (s.role || '') : '';
    editTag = (s && s.tags) ? s.tags : '';
    paint();
    return;
  }
  if (e.target.closest('[data-cancel]')) { editingId = null; paint(); return; }

  /* 수정 줄의 파트 / 태그 칩 (둘 다 하나만 고른다) */
  const roleChip = e.target.closest('[data-erole]');
  if (roleChip) { editRole = roleChip.dataset.erole; paint(); return; }
  const tagChip = e.target.closest('[data-etag]');
  if (tagChip) {
    const v = tagChip.dataset.etag;
    editTag = (v === editTag) ? '' : v;   /* 다시 누르면 해제 */
    paint();
    return;
  }
  const save = e.target.closest('[data-save]');
  if (save) {
    const row = save.closest('[data-row]');
    const body = { role: editRole, tags: editTag };
    row.querySelectorAll('[data-f]').forEach((i) => {
      body[i.dataset.f] = i.dataset.f === 'bpm' ? (Number(i.value) || null) : i.value.trim();
    });
    const saved = await Writes.commit(save, `sheet:${save.dataset.save}`,
      () => api.put('/sheets/' + save.dataset.save, body));
    if (!saved) return;
    editingId = null;
    putSheets([saved]);
    return;
  }
  const del = e.target.closest('[data-del]');
  if (del) {
    if (!confirm('이 악보를 삭제할까요?')) return;
    const id = Number(del.dataset.del);
    const ok = await Writes.commit(del, `sheet:${id}`, () => api.del('/sheets/' + id).then(() => true));
    if (!ok) return;
    editingId = null;
    dropSheets([id]);
    return;
  }

  /* 위에서 아무것도 걸리지 않았다면 줄을 연 것이다 — 버튼 없이 줄 자체가 열기다 */
  const open = e.target.closest('[data-open]');
  if (open) {
    const sheet = sheets.find((x) => x.id === Number(open.dataset.open));
    if (sheet) openViewer(sheet);
  }
});

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

const pageUrl = (id, n) => '/api/sheets/' + id + '/page/' + n;

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
   페어 중에는 "펼침(spread)" 단위로 움직인다. 1번(main)은 홀수쪽, 2번(sub)은
   짝수쪽을 맡고, 어느 쪽에서 넘겨도 펼침 번호가 함께 넘어간다.
   pageNo 변수는 솔로일 땐 쪽 번호, 페어일 땐 펼침 번호를 뜻한다. */
let pairLinked = false;
let peerCount = 0;
let lastTitle = '';

let shownPage = 1;   /* 화면에 실제로 떠 있는 쪽 번호 — 페어가 풀릴 때 기준이 된다 */

function maxStep() { return Pair.active() ? Math.ceil(pageTotal / 2) : pageTotal; }
function stepPage(n) { return Pair.active() ? (Pair.isSub() ? n * 2 : n * 2 - 1) : n; }

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

/* flash 를 주면 쪽수 뱃지가 잠깐 떠오른다 — 넘겼을 때만 그렇게 한다. */
function showPage(n, flash) {
  if (!currentSheet) return;
  pageNo = Math.min(Math.max(1, n), maxStep());
  const p = stepPage(pageNo);
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
renderTools();
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
