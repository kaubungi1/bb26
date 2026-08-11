/* 악보 공유 */
const PRESET_ROLES = ['보컬', '일렉1', '일렉2', '베이스', '키보드', '드럼'];
let sheets = [];
let songs = [];

const listEl = document.getElementById('list');
const songSelect = document.getElementById('song-select');
const sessionSelect = document.getElementById('session-select');
const fileInput = document.getElementById('file-input');
const fileFake = document.getElementById('file-fake');
const uploadBtn = document.getElementById('upload-btn');

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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

function fillSessions() {
  const songId = Number(songSelect.value);
  const song = songs.find((s) => s.id === songId);
  const prev = sessionSelect.value;
  sessionSelect.innerHTML = `<option value="">세션 선택</option>` +
    (song ? sortSessions(song.sessions).map((se) => `<option value="${escapeHtml(se.role)}">${escapeHtml(se.role)}</option>`).join('') : '');
  sessionSelect.value = prev;
}

songSelect.addEventListener('change', fillSessions);

async function refresh() {
  const [sh, s] = await Promise.all([api.get('/sheets'), api.get('/songs')]);
  sheets = sh;
  songs = s;
  const selected = songSelect.value;
  songSelect.innerHTML = `<option value="">곡 선택</option>` +
    songs.map((song) => `<option value="${song.id}">${escapeHtml(song.title)}</option>`).join('');
  songSelect.value = selected;
  fillSessions();

  if (sheets.length === 0) {
    listEl.innerHTML = `<p class="muted empty-msg">업로드된 악보가 없습니다.</p>`;
    return;
  }
  listEl.innerHTML = sheets.map((sheet) => `
    <li>
      <span>
        <strong>${escapeHtml(sheet.title)}</strong>
        <span class="muted"> · ${sheet.song ? escapeHtml(sheet.song.title) : '삭제된 곡'} · 업로드: ${sheet.uploadedBy || '-'}</span>
      </span>
      <span>
        <a class="small" style="color:var(--teal);margin-right:10px" href="/api/sheets/${sheet.id}/file" target="_blank" rel="noreferrer">열기</a>
        <button type="button" class="ghost" data-del="${sheet.id}">삭제</button>
      </span>
    </li>`).join('');
}

fileInput.addEventListener('change', () => {
  fileFake.innerHTML = fileInput.files[0]
    ? `${icon('paperclip', 16)} ${fileInput.files[0].name}`
    : `${icon('upload', 16)} 파일 선택`;
});

document.getElementById('add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const songId = songSelect.value;
  const session = sessionSelect.value;
  const file = fileInput.files[0];
  if (!songId || !session || !file) return;
  const uploadedBy = await Nick.ensure();
  if (!uploadedBy) return;
  const form = new FormData();
  form.append('songId', songId);
  form.append('title', session);
  form.append('uploadedBy', uploadedBy);
  form.append('file', file);
  uploadBtn.disabled = true;
  try {
    await api.post('/sheets', form);
    sessionSelect.value = '';
    fileInput.value = '';
    fileFake.innerHTML = `${icon('upload', 16)} 파일 선택`;
    await refresh();
  } finally {
    uploadBtn.disabled = false;
  }
});

listEl.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-del]');
  if (!btn) return;
  if (!confirm('악보를 삭제할까요?')) return;
  await api.del(`/sheets/${btn.dataset.del}`);
  await refresh();
});

mountChrome('sheets');
startPolling(refresh);
