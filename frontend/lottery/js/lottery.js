/* 후보곡 추첨 */
let songs = [];
let pool = new Set();
let count = 1;
let history = [];
let initialized = false;
let pending = null; // { drawn, poolIds }

const poolEl = document.getElementById('pool');
const resultEl = document.getElementById('result');
const historyEl = document.getElementById('history');
const countEl = document.getElementById('count');
const drawBtn = document.getElementById('draw-btn');

const candidates = () => songs.filter((s) => s.isCandidate || s.status === 'candidate');

async function refresh() {
  const [s, h] = await Promise.all([api.get('/songs'), api.get('/lotteries')]);
  songs = s;
  history = h;
  if (!initialized && songs.length > 0) {
    initialized = true;
    pool = new Set(candidates().map((x) => x.id));
  }
  renderPool();
  renderHistory();
  syncControls();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderPool() {
  const list = candidates();
  if (list.length === 0) {
    poolEl.innerHTML = `<p class="muted empty-msg">추첨 가능한 후보곡이 없습니다.</p>`;
    return;
  }
  poolEl.innerHTML = list.map((song) => `
    <label class="lottery-item">
      <input type="checkbox" data-id="${song.id}" ${pool.has(song.id) ? 'checked' : ''} />
      <span class="lottery-item-title">${escapeHtml(song.title)}</span>
      <span class="lottery-item-artist">${escapeHtml(song.artist)}</span>
    </label>`).join('');
}

poolEl.addEventListener('change', (e) => {
  const id = Number(e.target.dataset.id);
  if (e.target.checked) pool.add(id);
  else pool.delete(id);
  syncControls();
});

function syncControls() {
  drawBtn.disabled = pool.size === 0;
  document.getElementById('plus').disabled = count >= pool.size;
  document.getElementById('minus').disabled = count <= 1;
  countEl.textContent = count;
}

document.getElementById('minus').addEventListener('click', () => {
  count = Math.max(1, count - 1);
  syncControls();
});
document.getElementById('plus').addEventListener('click', () => {
  count = Math.min(pool.size, count + 1);
  syncControls();
});

drawBtn.addEventListener('click', () => {
  const poolSongs = songs.filter((s) => pool.has(s.id));
  if (!poolSongs.length) return;
  const drawn = [...poolSongs].sort(() => Math.random() - 0.5).slice(0, count);
  pending = { drawn, poolIds: [...pool] };
  renderResult();
});

function renderResult() {
  if (!pending) {
    resultEl.innerHTML = '';
    return;
  }
  resultEl.innerHTML = `
    <div class="draw-result">
      <div class="draw-result-title">오늘의 곡</div>
      ${pending.drawn.map((s) => `
        <div class="draw-result-song">
          <strong>${escapeHtml(s.title)}</strong>
          <span>${escapeHtml(s.artist)}</span>
        </div>`).join('')}
      <button type="button" class="secondary" id="record-btn">기록하기</button>
    </div>`;
}

resultEl.addEventListener('click', async (e) => {
  const btn = e.target.closest('#record-btn');
  if (!btn || !pending) return;
  const name = await Nick.ensure();
  if (!name) return;
  btn.disabled = true;
  try {
    await api.post('/lotteries', {
      songIds: pending.drawn.map((s) => s.id),
      poolIds: pending.poolIds,
      drawnBy: name,
    });
    pending = null;
    renderResult();
    await refresh();
  } finally {
    btn.disabled = false;
  }
});

function renderHistory() {
  if (history.length === 0) {
    historyEl.innerHTML = '';
    return;
  }
  historyEl.innerHTML = `
    <div class="lottery-history">
      <div class="lottery-history-title">추첨 기록</div>
      ${history.map((rec) => `
        <div class="lottery-history-row">
          <div class="lottery-history-item" data-toggle="${rec.id}">
            <span class="lottery-history-date">${fmtDate(rec.createdAt)}</span>
            <span class="lottery-history-head">
              ${rec.drawnBy ? `${escapeHtml(rec.drawnBy)}님 · ` : ''}${rec.items.length}곡 선정
            </span>
            <button type="button" class="ghost lh-del" data-del="${rec.id}">삭제</button>
            <span class="lottery-history-caret">▸</span>
          </div>
          <div class="lottery-history-detail" data-detail="${rec.id}" hidden>
            <div class="lh-line"><span class="lh-key">추첨자</span><span>${rec.drawnBy ? escapeHtml(rec.drawnBy) : '미지정'}</span></div>
            <div class="lh-line"><span class="lh-key">후보</span><span>${rec.pool.map((p) => escapeHtml(p.title)).join(', ') || '-'}</span></div>
            <div class="lh-line"><span class="lh-key">선정</span><span>${rec.items.map((it) => escapeHtml(it.song?.title ?? '삭제된 곡')).join(', ')}</span></div>
          </div>
        </div>`).join('')}
    </div>`;
}

historyEl.addEventListener('click', async (e) => {
  const del = e.target.closest('[data-del]');
  if (del) {
    if (!confirm('이 추첨 기록을 삭제할까요?')) return;
    await api.del(`/lotteries/${del.dataset.del}`);
    await refresh();
    return;
  }
  const item = e.target.closest('[data-toggle]');
  if (!item) return;
  const detail = historyEl.querySelector(`[data-detail="${item.dataset.toggle}"]`);
  if (detail) detail.hidden = !detail.hidden;
  const caret = item.querySelector('.lottery-history-caret');
  if (caret) caret.textContent = detail && !detail.hidden ? '▾' : '▸';
});

mountChrome('lottery');
startPolling(refresh);
