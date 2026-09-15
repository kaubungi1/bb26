/* 곡 리스트 */
const PRESET_ROLES = ROLE_ORDER;   /* 목록은 common.js 에서 한 번만 정의한다 */

/* 좁은 화면에서 역할 라벨이 폭을 다 먹지 않도록 */
const CHIP_MAX = 3;

let songs = [];
let filterTags = new Set();   /* 태그 필터. 여러 개 고를 수 있고, 비어 있으면 전체 */
let query = '';               /* 검색어. 제목·아티스트·업로더에 부분 일치 */
let mineFilter = '';          /* 지원 여부. '' 전체 | 'in' 지원함 | 'out' 미지원 */
let sortBy = 'recent';        /* 정렬 기준 — SORTS 의 키 */
let sortDesc = true;          /* true 면 내림차순. 기본은 최신이 위 */
let openDrop = null;          /* 열려 있는 메뉴 — 'tag' | 'sort' | null */
let newTag = '';              /* 곡 추가 폼에서 고른 태그 */
let selectedRoles = new Set(PRESET_ROLES);
let editingSongId = null;
let moreId = null;            /* 액션을 펼쳐 둔 곡. 평소엔 ⋯ 하나만 보인다 */

const listEl = document.getElementById('song-list');
const searchEl = document.getElementById('search');
const mineLabelEl = document.getElementById('mine-label');
const menuMineEl = document.getElementById('menu-mine');
const tagLabelEl = document.getElementById('tag-label');
const sortLabelEl = document.getElementById('sort-label');
const sortDirEl = document.getElementById('sort-dir');
const menuTagEl = document.getElementById('menu-tag');
const menuSortEl = document.getElementById('menu-sort');
const addBtn = document.getElementById('add-btn');
const addForm = document.getElementById('add-form');
const roleTogglesEl = document.getElementById('role-toggles');
const tagTogglesEl = document.getElementById('tag-toggles');
const sheetEl = document.getElementById('session-sheet');
const sheetTitleEl = document.getElementById('sheet-title');
const sheetSubEl = document.getElementById('sheet-sub');
const sheetMembersEl = document.getElementById('sheet-members');
const sheetActionsEl = document.getElementById('sheet-actions');
let sheetSessionId = null;

/* 태그는 한 곡에 하나. 고른 태그가 없으면 전체, 있으면 그중 하나에 걸리면 된다. */
function matchesTag(song) {
  return filterTags.size === 0 || filterTags.has(song.tags);
}

/* 검색은 제목·아티스트·업로더 중 하나라도 부분 일치하면 된다. 대소문자는 가리지 않는다. */
function matchesQuery(song) {
  if (!query) return true;
  return [song.title, song.artist, song.createdBy]
    .some((v) => (v || '').toLowerCase().includes(query));
}

/* 지원 여부 — 내 닉네임이 그 곡의 어느 세션에든 들어 있으면 지원한 곡이다 */
const MINE = { '': '지원', in: '지원함', out: '미지원' };
function isMine(song) {
  const me = Nick.get();
  return !!me && song.sessions.some((s) => s.supports.some((sp) => sp.nickname === me));
}
function matchesMine(song) {
  if (!mineFilter) return true;
  return isMine(song) === (mineFilter === 'in');
}

/* 곡의 지원자 합계 — 인원순 정렬에 쓴다 */
function supportCount(song) {
  return song.sessions.reduce((n, s) => n + s.supports.length, 0);
}

/* 정렬 기준. 값을 뽑는 함수와 라벨만 두고, 방향은 sortDesc 가 따로 맡는다.
   문자열은 한국어 로케일로 비교하고, 동률이면 최신순으로 2차 정렬한다. */
const SORTS = {
  recent:  { label: '최신',     value: (s) => new Date(s.createdAt).getTime() },
  title:   { label: '제목',     value: (s) => s.title || '' },
  artist:  { label: '아티스트', value: (s) => s.artist || '' },
  creator: { label: '업로더',   value: (s) => s.createdBy || '' },
  members: { label: '인원',     value: supportCount },
};

function compareSongs(a, b) {
  const va = SORTS[sortBy].value(a);
  const vb = SORTS[sortBy].value(b);
  let c = typeof va === 'string' ? va.localeCompare(vb, 'ko') : va - vb;
  if (sortDesc) c = -c;
  if (c === 0) c = new Date(b.createdAt) - new Date(a.createdAt);
  return c;
}

function sortSessions(sessions) {
  return [...sessions].sort((a, b) => {
    const ia = PRESET_ROLES.indexOf(a.role);
    const ib = PRESET_ROLES.indexOf(b.role);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return a.id - b.id;
  });
}

async function refresh() {
  if (songs.length === 0) showLoading(listEl);
  songs = await api.get('/songs');
  render();
  if (!sheetEl.hidden) renderSheet();
}

/* ---------- 도구줄: 태그 · 정렬 메뉴 ----------
   줄에는 현재 값만 글자로 보이고, 누르면 아래로 메뉴가 열린다.
   태그는 여러 개를 체크하고 메뉴가 열린 채로 즉시 걸러진다.
   정렬은 하나를 고르면 닫히고, 현재 항목을 다시 누르면 방향이 뒤집힌다. */
function renderTools() {
  const counts = {};
  songs.forEach((s) => { if (s.tags) counts[s.tags] = (counts[s.tags] || 0) + 1; });

  mineLabelEl.textContent = MINE[mineFilter];
  document.getElementById('drop-mine').classList.toggle('is-set', !!mineFilter);
  menuMineEl.innerHTML = Object.keys(MINE).map((k) =>
    `<button type="button" class="menu-item${k === mineFilter ? ' is-on' : ''}" data-pick-mine="${k}">${k ? MINE[k] : '전체'}</button>`).join('');

  const picked = TAGS.filter((t) => filterTags.has(t));
  tagLabelEl.textContent = picked.length === 0 ? '태그'
    : picked.length === 1 ? picked[0]
    : `${picked[0]} +${picked.length - 1}`;
  document.getElementById('drop-tag').classList.toggle('is-set', picked.length > 0);

  menuTagEl.innerHTML =
    `<button type="button" class="menu-item${picked.length ? '' : ' is-on'}" data-pick-tag="">전체<i>${songs.length}</i></button>` +
    TAGS.map((t) =>
      `<button type="button" class="menu-item check${filterTags.has(t) ? ' is-on' : ''}" data-pick-tag="${escapeHtml(t)}">` +
      `${escapeHtml(t)}${counts[t] ? `<i>${counts[t]}</i>` : ''}</button>`).join('');

  sortLabelEl.textContent = SORTS[sortBy].label;
  sortDirEl.textContent = sortDesc ? '▼' : '▲';
  menuSortEl.innerHTML = Object.keys(SORTS).map((k) =>
    `<button type="button" class="menu-item${k === sortBy ? ' is-on' : ''}" data-pick-sort="${k}">` +
    `${SORTS[k].label}${k === sortBy ? `<i>${sortDesc ? '▼' : '▲'}</i>` : ''}</button>`).join('');

  menuMineEl.hidden = openDrop !== 'mine';
  menuTagEl.hidden = openDrop !== 'tag';
  menuSortEl.hidden = openDrop !== 'sort';
  document.getElementById('drop-mine').classList.toggle('is-open', openDrop === 'mine');
  document.getElementById('drop-tag').classList.toggle('is-open', openDrop === 'tag');
  document.getElementById('drop-sort').classList.toggle('is-open', openDrop === 'sort');
}

function sessionCell(song, session) {
  const supports = session.supports;
  const mine = supports.some((s) => s.nickname === Nick.get());
  const names = supports.map((s) => s.nickname);
  const editing = editingSongId === song.id;
  const short = ROLE_SHORT[session.role] || session.role;

  let body;
  if (!names.length) {
    body = `<span class="empty">＋</span>`;
  } else if (names.length === 1) {
    body = `<span class="names" title="${escapeHtml(names[0])}">${escapeHtml(names[0])}</span>`;
  } else {
    // 등록순 고정. 넘치는 인원은 마지막 칩에 숫자로 모은다.
    const shown = names.slice(0, CHIP_MAX);
    const rest = names.length - shown.length;
    body = `<span class="chips" title="${escapeHtml(names.join(', '))}">` +
      shown.map((n) => avatarChip(n)).join('') +
      (rest ? `<span class="avatar-chip more">+${rest}</span>` : '') +
      `</span>`;
  }

  const cls = ['session-cell'];
  if (names.length) cls.push('filled');
  if (mine) cls.push('mine');
  if (editing) cls.push('editing');
  return `
    <div class="${cls.join(' ')}" data-session="${session.id}" data-song="${escapeHtml(song.title)}" data-role="${escapeHtml(session.role)}">
      <span class="role short">${escapeHtml(short)}</span><span class="role full">${escapeHtml(session.role)}</span>
      ${body}
      ${editing ? `<button type="button" class="session-del" data-del-session="${session.id}" data-role="${escapeHtml(session.role)}" data-supports="${names.length}" title="세션 삭제">✕</button>` : ''}
    </div>`;
}

/* 지원자가 1명 이상인 세션 수 */
function filledCount(song) {
  return song.sessions.filter((s) => s.supports.length > 0).length;
}

function fillBadge(song) {
  const total = song.sessions.length;
  if (!total) return '';
  const filled = filledCount(song);
  const done = filled === total;
  /* 숫자 옆에 얇은 사선 게이지 — 몇 자리 남았는지 읽지 않고 본다 */
  return `<span class="fill-badge${done ? ' full' : ''}">${filled}/${total}` +
    `<span class="skew-gauge${done ? ' full' : ''}"><i style="width:${(filled / total) * 100}%"></i></span></span>`;
}

/* 아직 만들지 않은 프리셋 역할 */
function missingRoles(song) {
  const have = new Set(song.sessions.map((s) => s.role));
  return PRESET_ROLES.filter((r) => !have.has(r));
}

/* 제목 아래 한 줄: 아티스트 · 충원현황 · 유튜브 */
function metaLine(song) {
  const parts = [`<span class="song-artist">${escapeHtml(song.artist)}</span>`];
  const badge = fillBadge(song);
  if (badge) parts.push(badge);
  if (song.youtubeUrl) {
    parts.push(`<a class="song-yt" href="${song.youtubeUrl}" target="_blank" rel="noreferrer">▶ 유튜브</a>`);
  }
  return parts.join('<span class="meta-sep">·</span>');
}

function sessionEditBtn(song) {
  const open = editingSongId === song.id;
  return `
    <button type="button" class="session-edit${open ? ' open' : ''}" data-add-session="${song.id}" title="세션 추가/삭제">${open ? '닫기' : '＋세션'}</button>`;
}

function rolePicker(song) {
  if (editingSongId !== song.id) return '';
  const missing = missingRoles(song);
  return `
    <div class="session-picker">
      ${missing.map((r) => `<button type="button" class="role-chip" data-new-role="${r}" data-song-id="${song.id}">${r}</button>`).join('')}
      <button type="button" class="role-chip custom" data-new-role="" data-song-id="${song.id}">직접 입력</button>
      <span class="session-picker-hint">세션 칸의 ✕ 를 눌러 삭제할 수 있어요.</span>
    </div>`;
}

function render() {
  const visible = songs.filter((s) => matchesMine(s) && matchesTag(s) && matchesQuery(s)).sort(compareSongs);

  renderTools();

  if (songs.length === 0) {
    listEl.innerHTML = `<p class="muted song-empty">곡이 없습니다. 첫 곡을 추가해 보세요.</p>`;
    return;
  }
  if (visible.length === 0) {
    const why = query ? '검색 결과가 없습니다.'
      : mineFilter === 'in' ? '지원한 곡이 없습니다.'
      : mineFilter === 'out' ? '모든 곡에 지원했습니다.'
      : '이 태그의 곡이 없습니다.';
    listEl.innerHTML = `<p class="muted song-empty">${why}</p>`;
    return;
  }

  listEl.innerHTML = visible.map((song) => `
    <div class="song-item">
      <div class="song-item-head">
        <div class="song-item-info">
          <div class="song-title-row">
            <span class="song-title">${escapeHtml(song.title)}</span>
            <button type="button" class="song-tag${song.tags ? '' : ' none'}" data-tag-of="${song.id}" title="탭하여 태그 변경">
              <span>${escapeHtml(song.tags || '태그 없음')}</span>
            </button>
          </div>
          <div class="song-meta">${metaLine(song)}</div>
        </div>
        <div class="song-item-actions${moreId === song.id ? ' is-open' : ''}">
          ${song.createdBy ? `<span class="song-by">${icon('user', 13)} ${escapeHtml(song.createdBy)}</span>` : ''}
          <span class="row-more-set">
            ${sessionEditBtn(song)}
            <button type="button" class="ghost" data-del="${song.id}">삭제</button>
          </span>
          <button type="button" class="row-more" data-more="${song.id}" aria-label="더보기">⋯</button>
        </div>
      </div>
      <div class="sessions">
        ${sortSessions(song.sessions).map((s) => sessionCell(song, s)).join('')}
      </div>
      ${rolePicker(song)}
    </div>`).join('');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* 이벤트 */
/* 검색 — 입력마다 바로 거른다. 서버를 타지 않으니 한 글자, 자모 하나에도 반응한다. */
searchEl.addEventListener('input', () => {
  query = searchEl.value.trim().toLowerCase();
  render();
});

/* 도구줄 메뉴 열고 닫기 + 항목 고르기 */
document.querySelector('.tool-line').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-drop]');
  if (btn) {
    openDrop = openDrop === btn.dataset.drop ? null : btn.dataset.drop;
    renderTools();
    return;
  }
  const mine = e.target.closest('[data-pick-mine]');
  if (mine) {
    const k = mine.dataset.pickMine;
    if (k && !(await Nick.ensure())) return;   /* 누구인지 알아야 지원 여부를 가른다 */
    mineFilter = k;
    openDrop = null;
    render();
    return;
  }
  const tag = e.target.closest('[data-pick-tag]');
  if (tag) {
    const v = tag.dataset.pickTag;
    if (!v) filterTags.clear();                           /* 전체 — 모두 해제 */
    else if (filterTags.has(v)) filterTags.delete(v);
    else filterTags.add(v);
    render();                                             /* 메뉴는 열린 채로 즉시 걸러진다 */
    return;
  }
  const sort = e.target.closest('[data-pick-sort]');
  if (sort) {
    const k = sort.dataset.pickSort;
    if (k === sortBy) sortDesc = !sortDesc;               /* 같은 항목 다시 누르면 방향 반전 */
    else { sortBy = k; sortDesc = true; }
    openDrop = null;
    render();
  }
});

/* 바깥을 누르거나 Esc 를 치면 닫힌다 */
document.addEventListener('click', (e) => {
  if (openDrop && !e.target.closest('.drop')) { openDrop = null; renderTools(); }
});

addBtn.addEventListener('click', () => {
  addForm.hidden = false;
  addBtn.hidden = true;
});

document.getElementById('close-btn').addEventListener('click', () => {
  addForm.hidden = true;
  addBtn.hidden = false;
  document.getElementById('in-title').value = '';
  document.getElementById('in-artist').value = '';
  document.getElementById('in-youtube').value = '';
  selectedRoles = new Set(PRESET_ROLES);
  newTag = '';
  renderRoles();
  renderNewTag();
});

function renderNewTag() {
  tagTogglesEl.innerHTML = TAGS.map((t) =>
    `<button type="button" class="chip${t === newTag ? ' is-on' : ''}" data-newtag="${escapeHtml(t)}">${escapeHtml(t)}</button>`).join('');
}
tagTogglesEl.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-newtag]');
  if (!btn) return;
  newTag = (btn.dataset.newtag === newTag) ? '' : btn.dataset.newtag;   /* 다시 누르면 해제 */
  renderNewTag();
});

function renderRoles() {
  roleTogglesEl.innerHTML = PRESET_ROLES.map((r) =>
    `<button type="button" class="role-toggle${selectedRoles.has(r) ? ' active' : ''}" data-role="${r}">${r}</button>`).join('');
}
roleTogglesEl.addEventListener('click', (e) => {
  const btn = e.target.closest('.role-toggle');
  if (!btn) return;
  const r = btn.dataset.role;
  if (selectedRoles.has(r)) selectedRoles.delete(r);
  else selectedRoles.add(r);
  btn.classList.toggle('active');
});

document.getElementById('save-btn').addEventListener('click', async () => {
  const title = document.getElementById('in-title').value.trim();
  const artist = document.getElementById('in-artist').value.trim();
  if (!title || !artist) return alert('곡명과 아티스트를 입력하세요.');
  const name = await Nick.ensure();
  if (!name) return;
  const song = await api.post('/songs', { title, artist, createdBy: name, youtubeUrl: document.getElementById('in-youtube').value.trim() || null, tags: newTag });
  await Promise.all(PRESET_ROLES.filter((r) => selectedRoles.has(r)).map((r) => api.post('/sessions', { songId: song.id, role: r })));
  document.getElementById('close-btn').click();
  await refresh();
});

/* 태그 바꾸기 — 곡 줄의 태그를 누르면 그 자리에서 칩 줄이 펼쳐진다 */
let tagEditId = null;

function paintTagPicker() {
  document.querySelectorAll('.song-tag-picker').forEach((el) => el.remove());
  if (tagEditId === null) return;
  const btn = listEl.querySelector(`[data-tag-of="${tagEditId}"]`);
  if (!btn) return;
  const song = songs.find((s) => s.id === tagEditId);
  const box = document.createElement('div');
  box.className = 'song-tag-picker chip-set';
  box.innerHTML = TAGS.map((t) =>
    `<button type="button" class="chip${song && song.tags === t ? ' is-on' : ''}" data-set-tag="${escapeHtml(t)}">${escapeHtml(t)}</button>`).join('');
  btn.closest('.song-item-info').appendChild(box);
}

listEl.addEventListener('click', async (e) => {
  const more = e.target.closest('[data-more]');
  if (more) {
    const id = Number(more.dataset.more);
    moreId = (moreId === id) ? null : id;   /* 다시 누르면 접힌다 */
    render();
    return;
  }
  const tagBtn = e.target.closest('[data-tag-of]');
  if (tagBtn) {
    const id = Number(tagBtn.dataset.tagOf);
    tagEditId = (tagEditId === id) ? null : id;   /* 다시 누르면 닫힌다 */
    paintTagPicker();
    return;
  }
  const setTag = e.target.closest('[data-set-tag]');
  if (setTag && tagEditId !== null) {
    const song = songs.find((s) => s.id === tagEditId);
    const next = (song && song.tags === setTag.dataset.setTag) ? '' : setTag.dataset.setTag;
    await api.put(`/songs/${tagEditId}`, { tags: next });
    tagEditId = null;
    await refresh();
    return;
  }
  const del = e.target.closest('[data-del]');
  if (del) {
    if (!confirm('이 곡과 연결된 세션/악보가 모두 삭제됩니다. 진행할까요?')) return;
    await api.del(`/songs/${del.dataset.del}`);
    await refresh();
    return;
  }
  const addSess = e.target.closest('[data-add-session]');
  if (addSess) {
    const id = Number(addSess.dataset.addSession);
    editingSongId = editingSongId === id ? null : id;
    render();
    return;
  }
  const delSess = e.target.closest('[data-del-session]');
  if (delSess) {
    const supports = Number(delSess.dataset.supports);
    const msg = supports
      ? `${delSess.dataset.role} 세션에 지원자 ${supports}명이 있습니다. 함께 삭제할까요?`
      : `${delSess.dataset.role} 세션을 삭제할까요?`;
    if (!confirm(msg)) return;
    await api.del(`/sessions/${delSess.dataset.delSession}`);
    await refresh();
    return;
  }
  const newRole = e.target.closest('[data-new-role]');
  if (newRole) {
    const songId = Number(newRole.dataset.songId);
    const song = songs.find((s) => s.id === songId);
    let role = newRole.dataset.newRole;
    if (!role) {
      role = (prompt('추가할 세션 이름을 입력하세요.') || '').trim();
      if (!role) return;
    }
    if (song.sessions.some((s) => s.role === role)) return alert('이미 있는 세션입니다.');
    await api.post('/sessions', { songId, role });
    editingSongId = null;
    await refresh();
    return;
  }
  const cell = e.target.closest('.session-cell');
  if (cell) openSheet(Number(cell.dataset.session));
});

/* ---------- 세션 상세 시트 ---------- */
function findSession(id) {
  for (const song of songs) {
    const sess = song.sessions.find((s) => s.id === id);
    if (sess) return { song, sess };
  }
  return null;
}

function openSheet(id) {
  sheetSessionId = id;
  renderSheet();
  sheetEl.hidden = false;
  document.body.style.overflow = 'hidden';
}

function closeSheet() {
  sheetSessionId = null;
  sheetEl.hidden = true;
  document.body.style.overflow = '';
}

function renderSheet() {
  const found = sheetSessionId === null ? null : findSession(sheetSessionId);
  if (!found) { closeSheet(); return; }
  const { song, sess } = found;
  const me = Nick.get();
  const mine = sess.supports.find((sp) => sp.nickname === me);

  sheetTitleEl.textContent = sess.role;
  sheetSubEl.textContent = `${song.title} · ${song.artist}`;

  sheetMembersEl.innerHTML = sess.supports.length
    ? sess.supports.map((sp) => `
        <div class="sheet-member${sp.nickname === me ? ' me' : ''}">
          ${avatarChip(sp.nickname, 'lg')}
          <span class="sheet-member-name">${escapeHtml(sp.nickname)}</span>
          ${sp.nickname === me ? '<span class="sheet-member-tag">나</span>' : ''}
        </div>`).join('')
    : `<p class="sheet-empty">아직 지원한 멤버가 없습니다.</p>`;

  sheetActionsEl.innerHTML = mine
    ? `<button type="button" class="secondary" data-sheet-cancel="${mine.id}">지원 취소</button>
       <button type="button" class="ghost" data-sheet-close>닫기</button>`
    : `<button type="button" class="pink" data-sheet-support>지원하기</button>
       <button type="button" class="ghost" data-sheet-close>닫기</button>`;
}

sheetEl.addEventListener('click', async (e) => {
  if (e.target === sheetEl || e.target.closest('[data-sheet-close]')) { closeSheet(); return; }
  const id = sheetSessionId;
  if (id === null) return;

  const cancel = e.target.closest('[data-sheet-cancel]');
  if (cancel) {
    await api.del(`/sessions/${id}/support/${cancel.dataset.sheetCancel}`);
    await refresh();
    return;
  }
  if (e.target.closest('[data-sheet-support]')) {
    const name = await Nick.ensure();
    if (!name) return;
    await api.post(`/sessions/${id}/support`, { nickname: name });
    await refresh();
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!sheetEl.hidden) closeSheet();
  else if (openDrop) { openDrop = null; renderTools(); }
});

mountChrome('songs');
renderRoles();
renderNewTag();
startPolling(refresh);

document.addEventListener('nickchange', refresh);
