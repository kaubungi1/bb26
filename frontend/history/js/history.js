/* 합주 이력 */
let histories = [];
let songs = [];

const listEl = document.getElementById('list');
const songSelect = document.getElementById('song-select');
const dateInput = document.getElementById('date-input');

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function refresh() {
  const [h, s] = await Promise.all([api.get('/histories'), api.get('/songs')]);
  histories = h;
  songs = s;
  const selected = songSelect.value;
  songSelect.innerHTML = `<option value="">곡 선택</option>` +
    songs.map((song) => `<option value="${song.id}">${escapeHtml(song.title)}</option>`).join('');
  songSelect.value = selected;

  if (histories.length === 0) {
    listEl.innerHTML = `<p class="muted empty-msg">합주 이력이 없습니다.</p>`;
    return;
  }
  listEl.innerHTML = histories.map((h) => `
    <li>
      <span>
        <strong>${fmtDate(h.date)}</strong> · ${h.song ? escapeHtml(h.song.title) : '삭제된 곡'}
      </span>
      <button type="button" class="ghost" data-del="${h.id}">삭제</button>
    </li>`).join('');
}

document.getElementById('add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const songId = songSelect.value;
  const date = dateInput.value;
  if (!songId || !date) return;
  await api.post('/histories', { songId: Number(songId), date });
  dateInput.value = '';
  await refresh();
});

listEl.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-del]');
  if (!btn) return;
  if (!confirm('이 이력을 삭제할까요?')) return;
  await api.del(`/histories/${btn.dataset.del}`);
  await refresh();
});

mountChrome('history');
startPolling(refresh);
