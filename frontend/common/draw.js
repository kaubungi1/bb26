/* 길드 배경 낙서.

   다 같이 한 벽에 그리고, 지우는 것은 자기 줄뿐이다. 한 사람이 한 길드에 한 장이다.

   좌표는 1600x1000 고정 캔버스다. 화면 폭에 맞춰 늘려 그리므로 어떤 기기에서 봐도
   같은 그림이 나온다. 뷰포트 좌표로 저장하면 사람마다 다른 그림이 된다.

   지우개는 획 단위다. 저장하는 것이 점이 아니라 획이라, 획 하나를 지우는 건 배열에서
   한 칸 빼는 일이다. 획의 일부를 지우려면 획을 둘로 쪼개고 주인 표시까지 따라 쪼개야
   한다 — 데이터가 불어나고 '내 것만 지운다' 가 성립하지 않는다. 대신 되돌리기를 둔다.

   그림 판은 z-index:-1 이다. body 의 배경(--page-art)은 캔버스로 올라가므로 그보다
   위에, 글과 버튼보다는 아래에 깔린다. 그릴 때만 위로 올라온다. */
const GuildDraw = (() => {
  const W = 1600, H = 1000;
  const COLORS = ['#1b2a45', '#ffffff', '#e0405f', '#f0a13a',
                  '#f5e04a', '#4fc16a', '#39c5bb', '#7a6ff0'];
  const WIDTHS = [2, 5, 11];
  const HIT = 16;                     /* 지울 때 집히는 폭. 가는 획도 눌리게 */

  let slug = null, me = null, canEdit = false;
  let layer = null, svg = null, bar = null;
  let all = [];                       /* [{nickname, strokes}] — 벽 전체 */
  let mine = [];                      /* 내 획만. all 안의 내 줄과 같은 배열을 가리킨다 */
  let saved = '[]';                   /* 편집을 열 때의 내 그림. 취소하면 이걸로 돌아간다 */
  let editing = false, tool = 'pen';
  let color = COLORS[6], width = WIDTHS[1];
  let undoStack = [];
  let live = null, livePts = null;

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function pathD(p) {
    if (!p.length) return '';
    if (p.length === 1) return `M${p[0][0]} ${p[0][1]} l0.01 0`;   /* 점 하나도 보이게 */
    return 'M' + p.map(([x, y]) => `${x} ${y}`).join(' L');
  }

  function paint() {
    const out = [];
    all.forEach((d) => (d.strokes || []).forEach((s, i) => {
      const isMine = d.nickname === me;
      /* 지울 때는 투명한 굵은 획을 하나 더 깔아 과녁을 넓힌다. 가는 획은 못 누른다. */
      if (editing && tool === 'erase' && isMine) {
        out.push(`<path class="gd-hit" d="${pathD(s.p)}" stroke-width="${Math.max(s.w, HIT)}"`
          + ` data-i="${i}"></path>`);
      }
      out.push(`<path class="gd-stroke${isMine ? ' is-mine' : ''}" d="${pathD(s.p)}"`
        + ` stroke="${s.c}" stroke-width="${s.w}" data-i="${i}">`
        + `<title>${esc(d.nickname)}</title></path>`);
    }));
    svg.innerHTML = out.join('') + '<path id="gd-live" fill="none" stroke-linecap="round"'
      + ' stroke-linejoin="round"></path>';
    live = svg.querySelector('#gd-live');
  }

  function toCanvas(e) {
    const pt = svg.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    const m = svg.getScreenCTM();
    if (!m) return [0, 0];
    const p = pt.matrixTransform(m.inverse());
    return [Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10];
  }

  const snapshot = () => { undoStack.push(JSON.stringify(mine)); if (undoStack.length > 60) undoStack.shift(); };

  function setMine(next) {
    mine = next;
    const row = all.find((d) => d.nickname === me);
    if (row) row.strokes = mine; else all.push({ nickname: me, strokes: mine });
    paint();
  }

  /* ---------- 그리기 ---------- */
  function onDown(e) {
    if (!editing) return;
    if (tool === 'erase') {
      const hit = e.target.closest('.gd-hit');
      if (!hit) return;
      snapshot();
      const next = mine.slice();
      next.splice(Number(hit.dataset.i), 1);
      setMine(next);
      return;
    }
    if (mine.length >= 200) { note('획을 200개까지만 그릴 수 있습니다.'); return; }
    svg.setPointerCapture(e.pointerId);
    livePts = [toCanvas(e)];
    live.setAttribute('stroke', color);
    live.setAttribute('stroke-width', width);
    live.setAttribute('d', pathD(livePts));
  }

  function onMove(e) {
    if (!livePts) return;
    const [x, y] = toCanvas(e);
    const [px, py] = livePts[livePts.length - 1];
    if (Math.abs(x - px) + Math.abs(y - py) < 3) return;   /* 너무 촘촘한 점은 버린다 */
    if (livePts.length >= 400) return;
    livePts.push([x, y]);
    live.setAttribute('d', pathD(livePts));
  }

  function onUp() {
    if (!livePts) return;
    const pts = livePts;
    livePts = null;
    live.setAttribute('d', '');
    if (!pts.length) return;
    snapshot();
    setMine(mine.concat([{ c: color, w: width, p: pts }]));
  }

  /* ---------- 팔레트 ---------- */
  function note(text) {
    const el = bar.querySelector('.gd-note');
    el.textContent = text || '';
  }

  function paintBar() {
    bar.querySelectorAll('[data-gd-color]').forEach((b) =>
      b.classList.toggle('is-on', b.dataset.gdColor === color));
    bar.querySelectorAll('[data-gd-width]').forEach((b) =>
      b.classList.toggle('is-on', Number(b.dataset.gdWidth) === width));
    bar.querySelectorAll('[data-gd-tool]').forEach((b) =>
      b.classList.toggle('is-on', b.dataset.gdTool === tool));
  }

  function buildBar() {
    bar = document.createElement('div');
    bar.className = 'gd-bar';
    bar.innerHTML = `
      <div class="gd-group">${COLORS.map((c) =>
        `<button type="button" class="gd-color" data-gd-color="${c}" style="--c:${c}"
          title="${c}"></button>`).join('')}
        <label class="gd-color gd-custom" title="직접 고르기">
          <input type="color" id="gd-custom" value="${color}" /></label>
      </div>
      <div class="gd-group">${WIDTHS.map((w) =>
        `<button type="button" class="gd-width" data-gd-width="${w}" title="${w}px">
          <i style="--w:${w}px"></i></button>`).join('')}
      </div>
      <div class="gd-group">
        <button type="button" class="gd-tool" data-gd-tool="pen">펜</button>
        <button type="button" class="gd-tool" data-gd-tool="erase">지우개</button>
        <button type="button" class="gd-tool" data-gd-undo>되돌리기</button>
        <button type="button" class="gd-tool" data-gd-clear>내 그림 전부</button>
      </div>
      <span class="gd-note"></span>
      <div class="gd-group gd-end">
        <button type="button" class="gd-tool gd-cancel" data-gd-cancel>취소</button>
        <button type="button" class="gd-tool gd-save" data-gd-save>저장</button>
      </div>`;
    document.body.appendChild(bar);

    bar.onclick = async (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.gdColor) { color = b.dataset.gdColor; tool = 'pen'; paintBar(); paint(); return; }
      if (b.dataset.gdWidth) { width = Number(b.dataset.gdWidth); paintBar(); return; }
      if (b.dataset.gdTool) { tool = b.dataset.gdTool; paintBar(); paint(); return; }
      if (b.hasAttribute('data-gd-undo')) {
        if (!undoStack.length) { note('되돌릴 것이 없습니다.'); return; }
        setMine(JSON.parse(undoStack.pop()));
        return;
      }
      if (b.hasAttribute('data-gd-clear')) {
        if (!mine.length) { note('지울 내 그림이 없습니다.'); return; }
        if (!await confirmModal({
          title: '내 그림 지우기',
          body: `내가 그린 획 <b>${mine.length}개</b>를 전부 지웁니다. 남의 그림은 그대로입니다.`,
          confirm: '지우기', danger: true,
        })) return;
        snapshot();
        setMine([]);
        return;
      }
      if (b.hasAttribute('data-gd-cancel')) { setMine(JSON.parse(saved)); close(); return; }
      if (b.hasAttribute('data-gd-save')) { await save(b); }
    };
    bar.querySelector('#gd-custom').oninput = (e) => {
      color = e.target.value; tool = 'pen'; paintBar(); paint();
    };
    paintBar();
  }

  /* 그림은 이미 벽에 있다. 누르는 즉시 닫고 저장은 뒤에서 한다(common.js Writes).
     전에는 서버 응답을 기다린 뒤에야 닫혔다. 실패하면 알린다 — 그린 것은 이 화면에 남아 있다. */
  async function save() {
    saved = JSON.stringify(mine);
    const strokes = JSON.parse(saved);   /* 닫은 뒤 다시 그려도 보낼 값은 누른 순간의 것 */
    close();
    Writes.run(`draw:${slug}:${me}`, () => api.put(`/guilds/${encodeURIComponent(slug)}/drawings`,
      { nickname: me, strokes }))
      .catch((err) => alert(`낙서를 저장하지 못했습니다. ${err.message}`));
  }

  function onKey(e) {
    if (!editing) return;
    if (e.key === 'Escape') { setMine(JSON.parse(saved)); close(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (undoStack.length) setMine(JSON.parse(undoStack.pop()));
    }
  }

  function close() {
    editing = false;
    undoStack = [];
    layer.classList.remove('is-editing');
    document.body.classList.remove('gd-on');
    if (bar) { bar.remove(); bar = null; }
    document.removeEventListener('keydown', onKey);
    paint();
  }

  function open() {
    if (!canEdit || editing) return;
    editing = true;
    tool = 'pen';
    saved = JSON.stringify(mine);
    undoStack = [];
    layer.classList.add('is-editing');
    document.body.classList.add('gd-on');
    buildBar();
    document.addEventListener('keydown', onKey);
    paint();
  }

  /* ---------- 붙이기 ---------- */
  async function mount(guildSlug, nickname, member) {
    slug = guildSlug;
    me = nickname || null;
    canEdit = !!member && !!me;
    if (!layer) {
      layer = document.createElement('div');
      layer.className = 'gd-layer';
      layer.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid slice"
        aria-hidden="true"></svg>`;
      document.body.appendChild(layer);
      document.body.classList.add('gd-page');   /* 이 화면에서만 본문을 낙서 위로 올린다 */
      svg = layer.querySelector('svg');
      svg.addEventListener('pointerdown', onDown);
      svg.addEventListener('pointermove', onMove);
      svg.addEventListener('pointerup', onUp);
      svg.addEventListener('pointercancel', onUp);
    }
    try {
      all = await api.get(`/guilds/${encodeURIComponent(slug)}/drawings`);
    } catch { all = []; }
    const row = all.find((d) => d.nickname === me);
    mine = row ? row.strokes : [];
    saved = JSON.stringify(mine);
    paint();
  }

  return { mount, open, get canEdit() { return canEdit; } };
})();
