/* 곡 리스트 */
const PRESET_ROLES = ['보컬', '일렉1', '일렉2', '베이스', '키보드', '드럼'];
const STATUS_LABEL = { candidate: '후보', practicing: '예정', ready: '예정', done: '완료' };
const STATUS_ORDER = ['candidate', 'practicing', 'done'];

let songs = [];
let filter = 'all';
let selectedRoles = new Set(PRESET_ROLES);

const listEl = document.getElementById('song-list');
const filterEl = document.getElementById('filter');
const addBtn = document.getElementById('add-btn');
const addForm = document.getElementById('add-form');
const roleTogglesEl = document.getElementById('role-toggles');

function statusGroup(st) {
  const i = STATUS_ORDER.indexOf(st);
  return i === -1 ? 99 : i;
}

function matches(song, f) {
  if (f === 'all') return true;
  if (f === 'candidate') return song.status === 'candidate';
  if (f === 'expected') return song.status === 'practicing' || song.status === 'ready';
  if (f === 'done') return song.status === 'done';
  return true;
}

function cycleStatus(st) {
  const i = STATUS_ORDER.indexOf(st);
  if (i !== -1) return STATUS_ORDER[(i + 1) % STATUS_ORDER.length];
  if (st === 'ready') return 'done';
  return 'candidate';
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
}

function renderFilter() {
  const counts = {
    all: songs.filter((s) => matches(s, 'all')).length,
    candidate: songs.filter((s) => matches(s, 'candidate')).length,
    expected: songs.filter((s) => matches(s, 'expected')).length,
    done: songs.filter((s) => matches(s, 'done')).length,
  };
  const labels = { all: '전체', candidate: '후보', expected: '예정', done: '완료' };
  filterEl.innerHTML = Object.entries(labels)
    .map(([k, label]) => `<option value="${k}">${label} ${counts[k]}</option>`)
    .join('');
  filterEl.value = filter;
}

function sessionCell(song, session) {
  const mine = session.supports.find((s) => s.nickname === Nick.get());
  const names = session.supports.map((s) => s.nickname).join(', ');
  return `
    <div class="session-cell${mine ? ' mine' : ''}" data-session="${session.id}" data-song="${song.title}" data-role="${session.role}" data-filled="${session.supports.length > 0}">
      <span class="role">${session.role}</span>
      ${session.supports.length
        ? `<span class="names" title="${names}">${names}</span>`
        : `<span class="empty">＋지원</span>`}
    </div>`;
}

function supportCount(song) {
  return song.sessions.reduce((n, s) => n + s.supports.length, 0);
}

function render() {
  const visible = songs
    .filter((s) => matches(s, filter))
    .sort((a, b) =>
      (statusGroup(a.status) - statusGroup(b.status)) ||
      (supportCount(b) - supportCount(a)) ||
      (new Date(b.createdAt) - new Date(a.createdAt)));

  renderFilter();

  if (songs.length === 0) {
    listEl.innerHTML = `<p class="muted song-empty">곡이 없습니다. 첫 곡을 추가해 보세요.</p>`;
    return;
  }
  if (visible.length === 0) {
    listEl.innerHTML = `<p class="muted song-empty">이 상태의 곡이 없습니다.</p>`;
    return;
  }

  listEl.innerHTML = visible.map((song) => `
    <div class="song-item">
      <div class="song-item-head">
        <div class="song-item-info">
          <div class="song-title-row">
            <span class="song-title">${escapeHtml(song.title)}</span>
            <button type="button" class="status ${song.status}" data-status="${song.id}" title="탭하여 상태 변경">
              <span class="status-dot"></span>${STATUS_LABEL[song.status] || song.status}
            </button>
          </div>
          <div class="song-artist">${escapeHtml(song.artist)}</div>
          ${song.youtubeUrl ? `<a class="small" style="color:var(--teal)" href="${song.youtubeUrl}" target="_blank" rel="noreferrer">▶ 유튜브</a>` : ''}
        </div>
        <div class="song-item-actions">
          ${song.createdBy ? `<span class="song-by">${icon('user', 13)} ${escapeHtml(song.createdBy)}</span>` : ''}
          <button type="button" class="ghost" data-del="${song.id}">삭제</button>
        </div>
      </div>
      <div class="sessions">
        ${sortSessions(song.sessions).map((s) => sessionCell(song, s)).join('')}
      </div>
    </div>`).join('');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* 이벤트 */
filterEl.addEventListener('change', () => { filter = filterEl.value; render(); });

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
  renderRoles();
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
  const song = await api.post('/songs', { title, artist, createdBy: name, youtubeUrl: document.getElementById('in-youtube').value.trim() || null, status: 'candidate' });
  await Promise.all(PRESET_ROLES.filter((r) => selectedRoles.has(r)).map((r) => api.post('/sessions', { songId: song.id, role: r })));
  document.getElementById('close-btn').click();
  await refresh();
});

/* 상태 순환 */
listEl.addEventListener('click', async (e) => {
  const st = e.target.closest('[data-status]');
  if (st) {
    const id = Number(st.dataset.status);
    const song = songs.find((s) => s.id === id);
    await api.put(`/songs/${id}`, { status: cycleStatus(song.status) });
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
  const cell = e.target.closest('.session-cell');
  if (cell) {
    const id = Number(cell.dataset.session);
    const filled = cell.dataset.filled === 'true';
    const mine = songs.flatMap((s) => s.sessions).find((ss) => ss.id === id)?.supports.find((sp) => sp.nickname === Nick.get());
    if (filled) {
      if (mine) {
        if (confirm(`${cell.dataset.role} 지원을 취소하겠습니까?`)) {
          await api.del(`/sessions/${id}/support/${mine.id}`);
          await refresh();
        }
      }
      return;
    }
    const name = await Nick.ensure();
    if (!name) return;
    if (confirm(`${cell.dataset.song} - ${cell.dataset.role} 포지션에 지원할까요?`)) {
      await api.post(`/sessions/${id}/support`, { nickname: name });
      await refresh();
    }
  }
});

mountChrome('songs');
renderRoles();
startPolling(refresh);

document.addEventListener('nickchange', refresh);
