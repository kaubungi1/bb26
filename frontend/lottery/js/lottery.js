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

const candidates = () => songs;

async function refresh() {
  const [s, h] = await Promise.all([api.get('/songs'), api.get('/lotteries')]);
  songs = s;
  history = h;
  /* 전체 선택이 아니라 빈 상태로 시작한다 — 고른 곡만 추첨에 들어간다 */
  initialized = true;
  pool = new Set([...pool].filter((id) => songs.some((s) => s.id === id)));
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
    <label class="lottery-item${pool.has(song.id) ? ' is-on' : ''}">
      <input type="checkbox" data-id="${song.id}" ${pool.has(song.id) ? 'checked' : ''} />
      <span class="lottery-item-title">${escapeHtml(song.title)}</span>
      <span class="lottery-item-artist">${escapeHtml(song.artist)}</span>
    </label>`).join('');
}

poolEl.addEventListener('change', (e) => {
  const id = Number(e.target.dataset.id);
  if (e.target.checked) pool.add(id);
  else pool.delete(id);
  /* 타일 전체가 켜지고 꺼지므로 클래스도 같이 옮긴다 */
  e.target.closest('.lottery-item').classList.toggle('is-on', e.target.checked);
  syncControls();
});

function syncControls() {
  const list = candidates();
  document.getElementById('pool-count').textContent =
    pool.size ? pool.size + '곡 선택됨' : '고른 곡 없음';
  document.getElementById('pool-all').textContent =
    (list.length > 0 && list.every((s) => pool.has(s.id))) ? '전체 해제' : '전체 선택';
  drawBtn.disabled = pool.size === 0;
  document.getElementById('plus').disabled = count >= pool.size;
  document.getElementById('minus').disabled = count <= 1;
  countEl.textContent = count;
}

document.getElementById('pool-all').addEventListener('click', () => {
  const list = candidates();
  const all = list.length > 0 && list.every((s) => pool.has(s.id));
  pool = all ? new Set() : new Set(list.map((s) => s.id));
  count = Math.min(Math.max(1, count), Math.max(1, pool.size));
  renderPool();
  syncControls();
});

document.getElementById('minus').addEventListener('click', () => {
  count = Math.max(1, count - 1);
  syncControls();
});
document.getElementById('plus').addEventListener('click', () => {
  count = Math.min(pool.size, count + 1);
  syncControls();
});

/* 뽑은 곡을 바로 보여주지 않고 후보 사이를 훑다가 멈춘다.
   결과는 이미 정해져 있고, 연출만 얹는 것이다. */
const ROLL_MS = 900;
const ROLL_TICK = 70;
let rolling = false;

function roll(poolSongs, done) {
  const stage = document.createElement('div');
  stage.className = 'draw-roll';
  stage.innerHTML = '<div class="draw-roll-label">추첨 중</div><strong></strong>';
  resultEl.innerHTML = '';
  resultEl.appendChild(stage);
  const nameEl = stage.querySelector('strong');

  let i = 0;
  const timer = setInterval(() => {
    nameEl.textContent = poolSongs[i++ % poolSongs.length].title;
  }, ROLL_TICK);

  setTimeout(() => {
    clearInterval(timer);
    stage.classList.add('is-landing');
    setTimeout(done, 180);
  }, ROLL_MS);
}

drawBtn.addEventListener('click', () => {
  if (rolling) return;
  const poolSongs = songs.filter((s) => pool.has(s.id));
  if (!poolSongs.length) return;
  const drawn = [...poolSongs].sort(() => Math.random() - 0.5).slice(0, count);

  rolling = true;
  drawBtn.disabled = true;
  roll(poolSongs, () => {
    pending = { drawn, poolIds: [...pool] };
    renderResult();
    rolling = false;
    syncControls();
  });
});

function renderResult() {
  if (!pending) {
    resultEl.innerHTML = '';
    return;
  }
  resultEl.innerHTML = `
    <div class="draw-result">
      <div class="draw-result-title"><span class="skew-badge grad"><span>오늘의 곡</span></span></div>
      ${pending.drawn.map((s, i) => `
        <div class="draw-result-song" style="animation-delay:${i * 90}ms">
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
