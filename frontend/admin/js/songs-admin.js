/* 관리 — 곡 정리. 몰아서 하는 세 가지: 제목(원제/번역) 확인, 프리길드 곡 길드로 옮기기, 같은 곡 병합.
   관리자만 쓴다. 들어올 때 목록을 한 번 받고 폴링하지 않는다(정리하는 동안 다시 받을 이유가 없다).
   고치는 API 는 곡 정보 창과 같다 — 제목은 PUT /songs/{id}(중복 규칙), 이전은 /admin/songs/{id}/guild.
   새로 쓰는 것은 /admin/songs/cleanup·checked·duplicates·merge 뿐이다(backend/routers/songadmin.py). */

const HANGUL = /[가-힣]/;
const JAPANESE = /[぀-ヿ一-鿿]/;
const BRACKET = /[()（）[\]【】「」『』]/;
const REASON = { video: '같은 영상', title: '같은 원제', name: '같은 이름' };
const SNAPSHOT_URL = 'https://github.com/kaubungi1/bb26-backup/actions/workflows/daily-branch.yml';
const HIDE_KEY = 'songclean:notsame';   /* '다른 곡이에요' 로 숨긴 쌍. 이 브라우저에만 남는다 */

let tab = 'title';
let songs = [];
let guilds = [];
let pairs = null;                       /* 중복 탭을 처음 열 때 받는다 */
let guildView = 'none';                 /* 길드 탭 보기: 'none'(프리길드) | 'all' | 길드 id */
let titleView = 'title';                /* 제목 탭 보기: 'title'(제목 손볼 곡) | 'noyt'(유튜브 주소 없는 곡) */
const picked = new Set();               /* 길드 탭에서 고른 곡 */
const ytTitles = new Map();             /* 영상 id -> 유튜브 제목 */
const errorEl = document.getElementById('admin-error');
const bodyEl = document.getElementById('sc-body');

async function call(method, url, body) {
  const res = await fetch('/api/admin' + url, {
    method,
    headers: { 'X-Nickname': encodeURIComponent(Nick.get()), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw await apiFailure(res);
  return res.json();
}
const fail = (err) => { errorEl.textContent = err.message; errorEl.hidden = false; };
const hidden = () => { try { return new Set(JSON.parse(localStorage.getItem(HIDE_KEY) || '[]')); } catch { return new Set(); } };
const hide = (key) => { const s = hidden(); s.add(key); try { localStorage.setItem(HIDE_KEY, JSON.stringify([...s])); } catch {} };
const guildName = (s) => (s.guild ? s.guild.name : FREE_GUILD);
/* 소속: 문장 + 이름 글자. 알약 배지는 다른 화면처럼 쓰지 않는다 */
const where = (s) => `<span class="sc-where-in">${guildMark(s.guild || null, 16)}<span>${escapeHtml(s.guild ? s.guild.name : FREE_GUILD)}</span></span>`;
const jacket = (s) => (s.thumbUrl ? `<img class="sc-jk" src="${escapeHtml(s.thumbUrl)}" alt="" loading="lazy" />` : '<span class="sc-jk"></span>');

/* ---------- 제목 ---------- */
/* 손볼 곡: 한글이 들어 있거나 괄호가 있는 제목. 순수 원제(일본어·영문)는 그대로 둔다. 확인함 표시가 있으면 뺀다 */
const needsTitle = (s) => !s.titleCheckedAt && (HANGUL.test(s.title) || BRACKET.test(s.title));

/* 미리 나눈 안. 사람이 확인하고 고친다. hint 는 무엇을 보고 판단할지 */
function suggest(s) {
  const m = s.title.match(/^(.*?)\s*[(（](.*)[)）]\s*$/);
  if (m) {
    const [, outer, inner] = m;
    if (HANGUL.test(inner) && !HANGUL.test(outer)) return { title: outer.trim(), ko: s.titleKo || inner.trim(), hint: '' };
    return { title: outer.trim(), ko: s.titleKo || '', hint: `괄호 속: ${inner.trim()}` };
  }
  if (HANGUL.test(s.title) && JAPANESE.test(s.title)) {
    /* "목마름을 외치다 カワキヲアメク" 처럼 괄호 없이 섞인 것 — 낱말을 글자로 가른다 */
    const words = s.title.split(/\s+/);
    const ko = words.filter((w) => HANGUL.test(w)).join(' ');
    const rest = words.filter((w) => !HANGUL.test(w)).join(' ');
    if (ko && rest) return { title: rest, ko: s.titleKo || ko, hint: '' };
  }
  if (HANGUL.test(s.title)) return { title: s.title, ko: s.titleKo || s.title, hint: '원제를 찾아 바꿔 주세요. 한국 곡이면 그대로 확인' };
  return { title: s.title, ko: s.titleKo || '', hint: '' };
}

function titleRow(s) {
  const g = suggest(s);
  return `
    <div class="sc-row sc-title-row" data-id="${s.id}">
      ${jacket(s)}
      <div class="sc-main">
        <div class="sc-now"><span>지금</span> ${escapeHtml(s.title)} <small>· ${escapeHtml(s.artist)} · ${escapeHtml(guildName(s))}</small></div>
        <div class="sc-inputs">
          <label><span>원제</span><input data-f="title" value="${escapeHtml(g.title)}" maxlength="120" /></label>
          <label><span>번역</span><input data-f="ko" value="${escapeHtml(g.ko)}" maxlength="120" placeholder="선택" /></label>
        </div>
        <div class="sc-yt" data-yt="${escapeHtml(youtubeId(s.youtubeUrl) || '')}">${g.hint ? escapeHtml(g.hint) : ''}</div>
        <p class="sc-msg" hidden></p>
      </div>
      <button type="button" class="sc-ok" data-confirm="${s.id}">확정</button>
    </div>`;
}

const noYoutube = (s) => !(s.youtubeUrl || '').trim();

/* 유튜브 주소가 없는 곡. 곡 정보 창은 주소가 필수라, 이 곡들은 태그 하나 고치려 해도 막힌다 — 여기서 몰아 채운다 */
function ytRow(s) {
  return `
    <div class="sc-row sc-title-row" data-id="${s.id}" data-mode="yt">
      ${jacket(s)}
      <div class="sc-main">
        <div class="sc-now">${escapeHtml(s.title)} <small>· ${escapeHtml(s.artist)} · ${escapeHtml(guildName(s))}</small></div>
        <div class="sc-inputs is-one">
          <label><span>유튜브</span><input data-f="yt" inputmode="url" placeholder="https://youtu.be/…" /></label>
        </div>
        <p class="sc-msg" hidden></p>
      </div>
      <button type="button" class="sc-ok" data-confirm="${s.id}">저장</button>
    </div>`;
}

function paintTitle() {
  const titled = songs.filter(needsTitle), noyt = songs.filter(noYoutube);
  const chip = (v, label, n) => `<button type="button" class="sc-chip${titleView === v ? ' is-on' : ''}" data-title-view="${v}">${label}<i>${n}</i></button>`;
  const head = `<div class="sc-bar">${chip('title', '제목 손볼 곡', titled.length)}${chip('noyt', '유튜브 주소 없음', noyt.length)}</div>`;
  if (titleView === 'noyt') {
    bodyEl.innerHTML = head + (noyt.length
      ? `<p class="sc-lead">유튜브 주소를 넣고 Enter 로 저장합니다. 자켓 그림도 이 주소에서 가져옵니다.</p>` + noyt.map(ytRow).join('')
      : '<p class="sc-empty">주소가 빠진 곡이 없습니다.</p>');
    return;
  }
  bodyEl.innerHTML = head + (titled.length
    ? `<p class="sc-lead">한 줄씩 확인하고 확정합니다. Enter 로 확정하고 다음 줄로 갑니다. 유튜브 영상 제목을 근거로 보세요.</p>` +
      titled.map(titleRow).join('')
    : '<p class="sc-empty">손볼 제목이 없습니다.</p>');
  watchYoutube();
}

async function saveYoutube(row) {
  const id = Number(row.dataset.id);
  const s = songs.find((x) => x.id === id);
  const input = row.querySelector('[data-f="yt"]');
  const msg = row.querySelector('.sc-msg');
  const btn = row.querySelector('.sc-ok');
  const url = input.value.trim();
  if (!youtubeId(url)) { msg.textContent = url ? '유튜브 주소 형식이 아니에요' : '유튜브 주소를 입력해 주세요'; msg.hidden = false; input.focus(); return; }
  btn.disabled = true;
  msg.hidden = true;
  try {
    Object.assign(s, await api.put(`/songs/${id}`, { youtubeUrl: url }));
    const next = row.nextElementSibling;
    row.remove();
    paintCounts();
    if (next) next.querySelector('input')?.focus();
  } catch (err) {
    btn.disabled = false;
    const c = err.detail && Array.isArray(err.detail.candidates) ? err.detail.candidates : [];
    msg.textContent = c.length ? `${err.message} (${c.map((x) => x.title).join(', ')}) — 중복 탭에서 병합하세요` : err.message;
    msg.hidden = false;
  }
}

/* 유튜브 제목은 줄이 화면에 들어올 때 받는다. 브라우저가 유튜브에 바로 묻는다(서버 전송량 없음). */
let ytObserver = null;
function watchYoutube() {
  if (ytObserver) ytObserver.disconnect();
  ytObserver = new IntersectionObserver((entries) => entries.forEach((en) => {
    if (!en.isIntersecting) return;
    ytObserver.unobserve(en.target);
    loadYoutube(en.target);
  }), { rootMargin: '200px' });
  bodyEl.querySelectorAll('[data-yt]').forEach((el) => { if (el.dataset.yt) ytObserver.observe(el); });
}
async function loadYoutube(el) {
  const id = el.dataset.yt;
  const hint = el.textContent;
  const show = (t) => { el.innerHTML = `<span>유튜브</span> ${escapeHtml(t)}${hint ? ` <em>${escapeHtml(hint)}</em>` : ''}`; };
  if (ytTitles.has(id)) return show(ytTitles.get(id));
  try {
    const res = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent('https://youtu.be/' + id)}&format=json`);
    if (!res.ok) throw new Error();
    const t = (await res.json()).title || '';
    ytTitles.set(id, t);
    show(t);
  } catch { /* 영상이 비공개·삭제면 제목이 없다. 힌트만 남는다 */ }
}

async function confirmTitle(row) {
  const id = Number(row.dataset.id);
  const s = songs.find((x) => x.id === id);
  const title = row.querySelector('[data-f="title"]').value.trim();
  const ko = row.querySelector('[data-f="ko"]').value.trim();
  const msg = row.querySelector('.sc-msg');
  const btn = row.querySelector('.sc-ok');
  if (!title) { msg.textContent = '원제를 입력해 주세요'; msg.hidden = false; row.querySelector('[data-f="title"]').focus(); return; }
  const body = {};
  if (title !== s.title) body.title = title;
  if (ko !== (s.titleKo || '')) body.titleKo = ko;
  btn.disabled = true;
  msg.hidden = true;
  try {
    if (Object.keys(body).length) Object.assign(s, await api.put(`/songs/${id}`, body));
    await call('POST', `/songs/${id}/checked`, { checked: true });
    s.titleCheckedAt = new Date().toISOString();
    const next = row.nextElementSibling;
    row.remove();
    paintCounts();
    if (next) next.querySelector('[data-f="title"]')?.focus();
  } catch (err) {
    btn.disabled = false;
    const c = err.detail && Array.isArray(err.detail.candidates) ? err.detail.candidates : [];
    msg.textContent = c.length
      ? `${err.message} (${c.map((x) => x.title).join(', ')}) — 중복 탭에서 병합하세요`
      : err.message;
    msg.hidden = false;
  }
}

/* ---------- 길드 ---------- */
function paintGuild() {
  const list = songs.filter((s) => guildView === 'all' || (guildView === 'none' ? !s.guildId : s.guildId === guildView));
  for (const id of [...picked]) if (!list.some((s) => s.id === id)) picked.delete(id);
  const opt = (v, label, on) => `<option value="${v}"${on ? ' selected' : ''}>${escapeHtml(label)}</option>`;
  const targets = guilds.map((g) => opt(g.id, g.name, false)).join('') + opt('none', FREE_GUILD, false);
  /* 도구줄 한 줄: 보기 [선택] · □ 모두 고르기 · 고른 n곡을 [길드] [옮기기]. 묶음 안의 글자는 꺾이지 않는다 */
  bodyEl.innerHTML = `
    <div class="sc-bar">
      <label class="sc-field"><span>보기</span><select data-view>
        ${opt('none', FREE_GUILD, guildView === 'none')}${opt('all', '전체', guildView === 'all')}
        ${guilds.map((g) => opt(g.id, g.name, guildView === g.id)).join('')}
      </select></label>
      <label class="sc-field sc-check"><input type="checkbox" data-all ${list.length && list.every((s) => picked.has(s.id)) ? 'checked' : ''} /><span>모두 고르기</span></label>
      <span class="sc-field sc-move"><span>고른 <b id="n-picked">${picked.size}</b>곡을</span>
        <select data-target>${targets}</select>
        <button type="button" class="sc-ok" data-move>옮기기</button></span>
    </div>
    ${list.length ? list.map((s) => `
      <label class="sc-row sc-guild-row" data-id="${s.id}">
        <input type="checkbox" data-pick="${s.id}" ${picked.has(s.id) ? 'checked' : ''} />
        ${jacket(s)}
        <span class="sc-main">
          <b>${escapeHtml(s.title)}</b>
          <small>${escapeHtml([s.titleKo, s.artist].filter(Boolean).join(' · '))}</small>
          <span class="sc-msg" hidden></span>
        </span>
        <span class="sc-where">${where(s)}</span>
      </label>`).join('') : '<p class="sc-empty">이 보기에는 곡이 없습니다.</p>'}`;
}

/* 한 곡씩 순서대로 옮긴다. 옮길 곳에 같은 곡이 있으면 그 줄만 실패로 적고 나머지는 계속한다. */
async function moveSelected(btn) {
  const target = bodyEl.querySelector('[data-target]').value;
  const gid = target === 'none' ? null : Number(target);
  const ids = [...picked];
  if (!ids.length) return;
  btn.disabled = true;
  let failed = 0;
  for (const id of ids) {
    const row = bodyEl.querySelector(`.sc-guild-row[data-id="${id}"]`);
    const msg = row && row.querySelector('.sc-msg');
    try {
      const moved = await call('POST', `/songs/${id}/guild`, { guildId: gid });
      const s = songs.find((x) => x.id === id);
      Object.assign(s, { guildId: moved.guildId, guild: moved.guild });
      picked.delete(id);
    } catch (err) {
      failed += 1;
      if (msg) { msg.textContent = err.message; msg.hidden = false; }
    }
  }
  btn.disabled = false;
  if (!failed) paintGuild();
  else {
    /* 실패한 줄의 사유를 남기려고 다시 그리지 않는다. 성공한 줄만 지운다 */
    ids.filter((id) => !picked.has(id)).forEach((id) => bodyEl.querySelector(`.sc-guild-row[data-id="${id}"]`)?.remove());
    document.getElementById('n-picked').textContent = picked.size;
  }
  paintCounts();
}

/* ---------- 중복 ---------- */
const pairKey = (p) => `${p.a.id}-${p.b.id}`;
const livePairs = () => (pairs || []).filter((p) => !hidden().has(pairKey(p)));

function side(s, p, which) {
  const counts = [['지원', s.supports], ['한마디', s.comments], ['셋리스트', s.setlists], ['라인업', s.lineups], ['기록', s.histories]]
    .map(([k, n]) => `${k} ${n}`).join(' · ');
  return `
    <div class="sc-side">
      ${jacket(s)}
      <div class="sc-main">
        <b>${escapeHtml(s.title)}</b>
        <small>${escapeHtml([s.titleKo, s.artist].filter(Boolean).join(' · '))}</small>
        <span class="sc-where">${where(s)}</span>
        <small class="sc-counts">${counts}${s.createdBy ? ` · 등록 ${escapeHtml(s.createdBy)}` : ''}</small>
      </div>
      <button type="button" class="sc-keep" data-keep="${which}" data-pair="${pairKey(p)}">이쪽 남기기</button>
    </div>`;
}

function paintDup() {
  if (pairs === null) { bodyEl.innerHTML = '<p class="sc-empty">불러오는 중…</p>'; return; }
  const list = livePairs();
  bodyEl.innerHTML = `
    <p class="sc-lead">병합은 되돌리기 어렵습니다. 몰아서 하기 전에
      <a href="${SNAPSHOT_URL}" target="_blank" rel="noopener">Neon 사본(daily-branch)</a>을 한 번 찍어 두세요.
      남긴 곡으로 지원·한마디·셋리스트·기록이 모이고, 다른 쪽은 지워집니다.</p>
    ${list.length ? list.map((p) => {
      const rule = !!p.a.guildId !== !!p.b.guildId ? '<em>길드 곡을 남기는 것이 규칙에 맞습니다</em>' : '';
      return `
        <div class="sc-pair" data-pair="${pairKey(p)}">
          <div class="sc-why">${p.reasons.map((r) => `<span>${REASON[r]}</span>`).join('')} ${rule}
            ${p.reasons.includes('video') ? '' : `<button type="button" class="sc-link" data-notsame="${pairKey(p)}">다른 곡이에요</button>`}</div>
          <div class="sc-sides">${side(p.a, p, 'a')}${side(p.b, p, 'b')}</div>
          <div class="sc-confirm" hidden></div>
        </div>`;
    }).join('') : '<p class="sc-empty">같은 곡으로 보이는 쌍이 없습니다.</p>'}`;
}

async function askMerge(btn) {
  const p = pairs.find((x) => pairKey(x) === btn.dataset.pair);
  const keep = btn.dataset.keep === 'a' ? p.a : p.b;
  const drop = btn.dataset.keep === 'a' ? p.b : p.a;
  const box = bodyEl.querySelector(`.sc-pair[data-pair="${pairKey(p)}"] .sc-confirm`);
  box.hidden = false;
  box.innerHTML = '<span>옮겨질 것을 세는 중…</span>';
  try {
    const { counts } = await call('GET', `/songs/merge/impact?keep=${keep.id}&drop=${drop.id}`);
    const lines = counts.filter((c) => c.move || c.merged)
      .map((c) => `${c.label} ${c.move}${c.merged ? ` (겹쳐서 하나로 ${c.merged})` : ''}`).join(' · ') || '옮길 기록 없음';
    box.innerHTML = `
      <p><b>${escapeHtml(drop.title)}</b>(${escapeHtml(guildName(drop))})을 <b>${escapeHtml(keep.title)}</b>(${escapeHtml(guildName(keep))})에 합칩니다.
        옮겨짐: ${escapeHtml(lines)}. 합친 뒤 ${escapeHtml(drop.title)}은 지워집니다.</p>
      <button type="button" class="sc-ok is-danger" data-merge="${keep.id}-${drop.id}">병합</button>
      <button type="button" class="sc-link" data-cancel-merge>취소</button>`;
  } catch (err) {
    box.innerHTML = `<p class="sc-msg">${escapeHtml(err.message)}</p>`;
  }
}

async function doMerge(btn) {
  const [keep, drop] = btn.dataset.merge.split('-').map(Number);
  btn.disabled = true;
  try {
    await call('POST', '/songs/merge', { keep, drop });
    /* 지운 곡이 낀 쌍은 모두 사라진다. 남긴 곡의 기록 수는 다음에 들어올 때 다시 센다 */
    songs = songs.filter((s) => s.id !== drop);
    pairs = pairs.filter((p) => p.a.id !== drop && p.b.id !== drop);
    paintDup();
    paintCounts();
  } catch (err) {
    btn.disabled = false;
    btn.insertAdjacentHTML('afterend', `<p class="sc-msg">${escapeHtml(err.message)}</p>`);
  }
}

/* ---------- 탭 ---------- */
function paintCounts() {
  document.getElementById('n-title').textContent = songs.filter(needsTitle).length;
  document.getElementById('n-guild').textContent = songs.filter((s) => !s.guildId).length;
  document.getElementById('n-dup').textContent = pairs === null ? '' : livePairs().length;
}
function paint() {
  document.querySelectorAll('[data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  if (tab === 'title') paintTitle();
  else if (tab === 'guild') paintGuild();
  else paintDup();
  paintCounts();
}

document.querySelector('.sc-tabs').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-tab]');
  if (!b) return;
  tab = b.dataset.tab;
  try { localStorage.setItem('songclean:tab', tab); } catch {}
  paint();
  if (tab === 'dup' && pairs === null) {
    try { pairs = await call('GET', '/songs/duplicates'); } catch (err) { pairs = []; fail(err); }
    if (tab === 'dup') paint();
  }
});

bodyEl.addEventListener('click', (e) => {
  const t = e.target;
  const tv = t.closest('[data-title-view]');
  if (tv) { titleView = tv.dataset.titleView; paintTitle(); return; }
  const ok = t.closest('[data-confirm]');
  if (ok) {
    const row = ok.closest('.sc-title-row');
    return row.dataset.mode === 'yt' ? saveYoutube(row) : confirmTitle(row);
  }
  if (t.closest('[data-move]')) return moveSelected(t.closest('[data-move]'));
  const keep = t.closest('[data-keep]');
  if (keep) return askMerge(keep);
  const m = t.closest('[data-merge]');
  if (m) return doMerge(m);
  if (t.closest('[data-cancel-merge]')) { const box = t.closest('.sc-confirm'); box.hidden = true; box.innerHTML = ''; return; }
  const ns = t.closest('[data-notsame]');
  if (ns) { hide(ns.dataset.notsame); paintDup(); paintCounts(); }
});
bodyEl.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.isComposing) return;
  const row = e.target.closest('.sc-title-row');
  if (!row || !e.target.matches('input')) return;
  e.preventDefault();
  if (row.dataset.mode === 'yt') saveYoutube(row); else confirmTitle(row);
});
bodyEl.addEventListener('change', (e) => {
  const t = e.target;
  if (t.matches('[data-view]')) { guildView = t.value === 'none' || t.value === 'all' ? t.value : Number(t.value); picked.clear(); paintGuild(); return; }
  if (t.matches('[data-pick]')) {
    const id = Number(t.dataset.pick);
    t.checked ? picked.add(id) : picked.delete(id);
    document.getElementById('n-picked').textContent = picked.size;
    return;
  }
  if (t.matches('[data-all]')) {
    bodyEl.querySelectorAll('[data-pick]').forEach((c) => {
      c.checked = t.checked;
      t.checked ? picked.add(Number(c.dataset.pick)) : picked.delete(Number(c.dataset.pick));
    });
    document.getElementById('n-picked').textContent = picked.size;
  }
});

async function start() {
  errorEl.hidden = true;
  let role = null;
  try { role = (await call('GET', '/me')).role; } catch (err) { return fail(err); }
  if (!role && Nick.get() === ADMIN_NICK && await promptAdmin()) role = 'root';
  AdminSeen.setRoot(role === 'root');
  if (!role) { location.replace('/'); return; }
  document.getElementById('panel').hidden = false;
  try { tab = localStorage.getItem('songclean:tab') || 'title'; } catch {}
  if (!['title', 'guild', 'dup'].includes(tab)) tab = 'title';
  try {
    const [list, gs] = await Promise.all([call('GET', '/songs/cleanup'), api.get('/guilds')]);
    songs = list;
    guilds = gs;
  } catch (err) { return fail(err); }
  paint();
  if (tab === 'dup') {
    try { pairs = await call('GET', '/songs/duplicates'); } catch (err) { pairs = []; fail(err); }
    paint();
  }
}

mountChrome('admin');
start();
