/* 일정 — 날짜 투표, 날짜별 가능 곡, 확정 후 셋리스트와 라인업, 지난 합주 */
let events = [];
let currentUser = Nick.get();
let pollEvent = null;
let openId = null;            /* 펼쳐 둔 일정. 한 번에 하나만 */
let weekendOnly = false;
let pendingEventId = Number(new URLSearchParams(location.search).get('event'));

const pollListEl = document.getElementById('poll-list');
const pastCardEl = document.getElementById('past-card');
const pastListEl = document.getElementById('past-list');

const addModal = document.getElementById('add-modal');
const dowPick = document.getElementById('dow-pick');
const dowHint = document.getElementById('dow-hint');
let pickedDows = new Set();   /* 만들 때 고른 요일. 비어 있으면 전체 */
const addForm = document.getElementById('add-form');
const inTitle = document.getElementById('in-title');
const inFrom = document.getElementById('in-from');
const inTo = document.getElementById('in-to');
const inNote = document.getElementById('in-note');

const pollPark = document.getElementById('poll-park');
const pollDetail = document.getElementById('poll-detail');
const pollMeta = document.getElementById('poll-meta');
const matrixEl = document.getElementById('matrix');
const weekendOnlyEl = document.getElementById('weekend-only');
const confirmDateEl = document.getElementById('confirm-date');
const confirmStartEl = document.getElementById('confirm-start');
const confirmEndEl = document.getElementById('confirm-end');
const confirmPlaceEl = document.getElementById('confirm-place');
const confirmBtn = document.getElementById('confirm-btn');
const confirmBar = document.getElementById('confirm-bar');
const confirmedBar = document.getElementById('confirmed-bar');
const confirmedDetail = document.getElementById('confirmed-detail');
const unconfirmBtn = document.getElementById('unconfirm-btn');
const addMemberBtn = document.getElementById('add-member-btn');
const playableSection = document.getElementById('playable-section');
const playableListEl = document.getElementById('playable-list');
const playableStageEl = document.getElementById('playable-stage');
const psTitleEl = document.getElementById('ps-title');
const psDatesEl = document.getElementById('ps-dates');
const psToggleBtn = document.getElementById('ps-toggle');
const setlistSection = document.getElementById('setlist-section');
const setlistEl = document.getElementById('setlist');
const pollHintEl = document.getElementById('poll-hint');
const NICK_MAX = 20;

/* 세션 지원이 채워지면 이 값을 올리면 된다 */
const MIN_FILLED = 3;
/* 후보 날짜 상한. backend/routers/events.py 의 MAX_DATES 와 같아야 한다. */
const MAX_DATES = 40;
/* ROLE_ORDER · ROLE_SHORT 는 common.js 에서 정의한다. */

let playable = null;
let playableKey = '';
let playableAll = false;
let playableDate = null;      /* 조율 중에 고른 후보 날짜. 확정 후엔 확정일 */
let stageSongId = null;       /* 합주실에 올린 곡 */
/* 되는 곡의 범위. 길드 일정이면 'guild'(그 길드 곡만)가 기본이다.
   공용 곡을 섞지 않는 이유: 공용이 200곡이라 길드 곡이 묻힌다(사용자 결정, 2026-09-23). */
let playableScope = 'guild';
const psScopeEl = document.getElementById('ps-scope');
/* 상세 안의 입력 칸을 쓰는 동안 미뤄 둔 새로 그리기가 있는가 */
let refreshDeferred = false;
/* 무대 접기. 길드 홈의 파티창 접기와 같은 방식이다 — localStorage 한 칸.
   기본은 펼침이고, 접어도 머리글 한 줄은 남는다. 통째로 사라지면 다시 펼 자리가 없다.
   곡마다 따로 기억하지 않는다. "무대를 볼 것인가" 는 곡이 아니라 사람의 취향이다. */
const STAGE_OPEN = 'bb26-stage-open';
let stageOpen = (() => {
  try { return localStorage.getItem(STAGE_OPEN) !== '0'; } catch { return true; }
})();
let lastPollsHtml = '';       /* 5초 폴링이 목록을 다시 그려 펼친 상세를 뜯지 않도록 */
let lastPastHtml = '';

const DOW = ['일', '월', '화', '수', '목', '금', '토'];

function pad(n) { return String(n).padStart(2, '0'); }

function toDateStr(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parseDate(s) { return new Date(`${s}T00:00:00`); }

function monthDay(iso) {
  const d = parseDate(iso);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function isWeekend(iso) {
  const d = parseDate(iso).getDay();
  return d === 0 || d === 6;
}

function todayStr() { return toDateStr(new Date()); }

/* 길드 밖(메인)에서만 배지를 단다. 길드 안에서는 전부 그 길드 것이다. */
function badge(ev) { return Site.slug ? '' : guildBadge(ev.guild); }

/* 상세 안의 글자·시간·날짜 칸에 커서가 있는가. 체크박스(주말만)는 누르고 끝이라 뺀다. */
function editingDetail() {
  const el = document.activeElement;
  return !!el && pollDetail.contains(el) && el.matches('input:not([type=checkbox]), select, textarea');
}

async function refresh() {
  if (Writes.pending) return;        /* 보내는 중인 쓰기가 끝나면 writes-idle 로 다시 온다 */
  /* 입력하는 동안에는 다시 그리지 않는다. 다시 그리면 열어 둔 시간 고르기가 닫히고 칸에서 커서가 빠졌다
     (쿠로 제보, 2026-09-16). 칸에서 나가면 그때 한 번 받는다(아래 focusout). */
  if (editingDetail()) { refreshDeferred = true; return; }
  if (events.length === 0 && pollListEl.innerHTML.trim() === '') showLoading(pollListEl);
  const seq = Writes.seq;
  try {
    const res = await api.poll(Site.q('/events'));
    if (Writes.stale(seq)) return;   /* 기다리는 동안 누른 것이 있으면 이 응답은 낡았다 */
    /* 바뀐 게 없으면 다시 그리지 않는다. 처음 한 번은 늘 바뀐 것으로 온다. */
    if (!res.changed) return;
    events = res.data;
  } catch (err) {
    console.error('일정 로드 실패:', err);
    if (!events.length) pollListEl.textContent = '일정을 불러오지 못했습니다. 잠시 후 다시 시도합니다.';
    return;
  }
  renderPolls();
  renderPast();
  if (Number.isSafeInteger(pendingEventId) && pendingEventId > 0) {
    const id = pendingEventId;
    pendingEventId = null;
    if (events.some((e) => e.id === id)) openPoll(id);
    else alert('이 일정을 찾을 수 없습니다. 삭제되었거나 다른 길드의 일정입니다.');
  }
  if (openId) {
    const found = events.find((e) => e.id === openId);
    if (found) {
      pollEvent = found;
      renderPollView();
    } else {
      closePoll();
    }
  }
}

/* ---------- 상세 보관함 ----------
   상세는 한 벌뿐이다. 펼친 항목 안으로 옮겨 다니고, 닫히면 보관함으로 돌아온다.
   다시 만들지 않으므로 입력하던 값과 불러온 곡 목록이 그대로 남는다. */
function parkDetail() {
  if (pollDetail.parentElement !== pollPark) pollPark.appendChild(pollDetail);
}

function placeDetail() {
  if (!openId) { parkDetail(); return; }
  const slot = pollListEl.querySelector(`[data-slot="${openId}"]`)
    || pastListEl.querySelector(`[data-slot="${openId}"]`);
  if (!slot) { parkDetail(); return; }
  if (pollDetail.parentElement !== slot) slot.appendChild(pollDetail);
}

/* ---------- 조율 중 · 다가오는 목록 ---------- */
function firstDate(ev) { return ev.dates.length ? ev.dates[0].date : null; }
function lastDate(ev) { return ev.dates.length ? ev.dates[ev.dates.length - 1].date : null; }
function isPast(ev) { return ev.status === 'confirmed' && !!ev.date && ev.date < todayStr(); }

function timeText(e) {
  return e.startTime ? `${e.startTime}${e.endTime ? ' ~ ' + e.endTime : ''}` : '시간 미정';
}

/* 목록 한 줄. 누르면 아래 칸에 상세가 들어온다. */
function pollEntry(e, head) {
  return `<div class="poll-entry${e.id === openId ? ' is-open' : ''}">${head}`
    + `<div class="poll-slot" data-slot="${e.id}"></div></div>`;
}

function pollHead(e) {
  const open = e.id === openId;
  if (e.status === 'confirmed') {
    const cnt = e.avails.filter((a) => a.date === e.date).length;
    const meta = [e.date ? monthDay(e.date) + ' (' + DOW[parseDate(e.date).getDay()] + ')' : '', timeText(e), e.place]
      .filter(Boolean).map(escapeHtml).join(' · ');
    const songs = e.songs.length ? ` · ${e.songs.length}곡` : '';
    return `
      <div class="poll-item" data-open-poll="${e.id}" role="button" tabindex="0" aria-expanded="${open}">
        ${eventSymbol(e)}
        <div class="poll-item-info">
          <small class="poll-item-status is-confirmed">일정 확정 ${badge(e)}</small>
          <div class="poll-item-title">${escapeHtml(e.title)}</div>
          <div class="poll-item-meta">${meta}${songs}</div>
        </div>
        <span class="poll-item-count">참석 ${cnt}명</span>
      </div>`;
  }
  const f = firstDate(e), l = lastDate(e);
  const best = Math.max(0, ...e.dates.map((dr) => e.avails.filter((a) => a.date === dr.date).length));
  return `
      <div class="poll-item" data-open-poll="${e.id}" role="button" tabindex="0" aria-expanded="${open}">
        ${eventSymbol(e)}
        <div class="poll-item-info">
          <small class="poll-item-status">날짜 투표 중 ${badge(e)}</small>
          <div class="poll-item-title">${escapeHtml(e.title)}</div>
          <div class="poll-item-meta">${f ? monthDay(f) : ''}${l && l !== f ? ' ~ ' + monthDay(l) : ''} · ${e.dates.length}일${e.createdBy ? ' · ' + escapeHtml(e.createdBy) : ''}</div>
        </div>
        <span class="poll-item-count${best > 0 ? ' max' : ''}">최다 ${best}명</span>
      </div>`;
}

function renderPolls() {
  const sortKey = (e) => (e.status === 'confirmed' ? e.date : firstDate(e)) || '9999';
  const list = events.filter((e) => !isPast(e)).sort((a, b) => {
    if (a.status !== b.status) return a.status === 'poll' ? -1 : 1;
    const ka = sortKey(a), kb = sortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : b.id - a.id;
  });
  /* 제목 옆 숫자. 곡 페이지의 #song-count 와 같은 자리다. */
  const countEl = document.getElementById('event-count');
  if (countEl) countEl.textContent = list.length || '';
  if (!list.length) {
    parkDetail();
    pollListEl.innerHTML = `<p class="muted empty-msg">등록된 일정이 없습니다.</p>`;
    lastPollsHtml = '';
    return;
  }
  const html = list.map((e) => pollEntry(e, pollHead(e))).join('');
  /* 내용이 그대로면 손대지 않는다. 다시 그리면 펼쳐 둔 상세가 뜯긴다. */
  if (html !== lastPollsHtml) {
    parkDetail();
    pollListEl.innerHTML = html;
    lastPollsHtml = html;
  }
  placeDetail();
}

/* ---------- 지난 합주 — 확정일이 지난 일정과 그날의 셋리스트 ---------- */
function renderPast() {
  const list = events.filter(isPast).sort((a, b) => (a.date < b.date ? 1 : -1));
  pastCardEl.hidden = list.length === 0;
  if (!list.length) { lastPastHtml = ''; return; }
  const html = list.map((e) => {
    const cnt = e.avails.filter((a) => a.date === e.date).length;
    const titles = e.songs.map((s) => escapeHtml(s.title)).join(' · ');
    return pollEntry(e, `
      <div class="poll-item" data-open-poll="${e.id}" role="button" tabindex="0" aria-expanded="${e.id === openId}">
        ${eventSymbol(e)}
        <div class="poll-item-info">
          <small class="poll-item-status is-past">${monthDay(e.date)} 합주 ${badge(e)}</small>
          <div class="poll-item-title">${escapeHtml(e.title)}</div>
          <div class="poll-item-meta">${titles || '셋리스트 없음'}</div>
        </div>
        <span class="poll-item-count">${cnt}명</span>
      </div>`);
  }).join('');
  if (html !== lastPastHtml) {
    parkDetail();
    pastListEl.innerHTML = html;
    lastPastHtml = html;
  }
  placeDetail();
}

/* ---------- 일정 추가 ---------- */
function openAddModal() {
  const t = new Date();
  inFrom.value = toDateStr(t);
  const to = new Date(t);
  to.setDate(to.getDate() + 6);
  inTo.value = toDateStr(to);
  pickedDows = new Set();
  renderDowPick();
  addModal.hidden = false;
  setTimeout(() => inTitle.focus(), 0);
}

function closeAddModal() { addModal.hidden = true; }

/* 고른 요일로 후보가 몇 일이 되는지 미리 세어 보여 준다.
   40일을 넘으면 서버가 막으므로, 누르기 전에 알 수 있어야 한다. */
function renderDowPick() {
  dowPick.querySelectorAll('[data-dow]').forEach((b) => {
    b.setAttribute('aria-pressed', pickedDows.has(Number(b.dataset.dow)));
  });
  const from = inFrom.value, to = inTo.value;
  if (!from || !to || from > to) { dowHint.textContent = pickedDows.size ? '' : '전체'; return; }
  let n = 0;
  for (let d = parseDate(from); d <= parseDate(to); d.setDate(d.getDate() + 1)) {
    if (!pickedDows.size || pickedDows.has(d.getDay())) n += 1;
  }
  dowHint.textContent = n > MAX_DATES ? `${n}일 — ${MAX_DATES}일까지만 됩니다` : `후보 ${n}일`;
  dowHint.classList.toggle('over', n > MAX_DATES);
}

dowPick.addEventListener('click', (e) => {
  const b = e.target.closest('[data-dow]');
  if (!b) return;
  const v = Number(b.dataset.dow);
  if (pickedDows.has(v)) pickedDows.delete(v); else pickedDows.add(v);
  renderDowPick();
});
inFrom.addEventListener('change', renderDowPick);
inTo.addEventListener('change', renderDowPick);

document.getElementById('add-poll-btn').addEventListener('click', openAddModal);
document.getElementById('add-cancel').addEventListener('click', closeAddModal);
addModal.addEventListener('click', (e) => { if (e.target === addModal) closeAddModal(); });

addForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const title = inTitle.value.trim();
  const from = inFrom.value;
  const to = inTo.value;
  if (!title || !from || !to) return;
  const name = await Nick.ensure();
  if (!name) return;
  const made = await Writes.commit(addForm.querySelector('[type=submit]'), 'event:new', () => api.post('/events', Site.body({
    title,
    note: inNote.value.trim() || null,
    createdBy: name,
    dateFrom: from,
    dateTo: to,
    weekdays: [...pickedDows],
  })));
  if (!made) return;
  inTitle.value = '';
  inNote.value = '';
  closeAddModal();
  putEvent(made);        /* 돌려받은 일정으로 바로 그린다. 목록 전체는 뒤에서 맞춘다 */
  renderPolls();
  renderPast();
});

/* 서버가 돌려준 일정 하나를 목록에 반영한다(만들기·확정·해제·셋리스트). */
function putEvent(ev) {
  const at = events.findIndex((x) => x.id === ev.id);
  if (at >= 0) events[at] = ev; else events.unshift(ev);
  if (pollEvent && pollEvent.id === ev.id) pollEvent = ev;
}

/* ---------- 조율 매트릭스 ---------- */
function matrixMembers() {
  const names = [];
  pollEvent.avails.forEach((a) => { if (!names.includes(a.nickname)) names.push(a.nickname); });
  const list = names.map((n) => ({ name: n, mine: n === currentUser, placeholder: false }));
  if (currentUser && !names.includes(currentUser)) list.push({ name: currentUser, mine: true, placeholder: false });
  if (!currentUser) list.push({ name: '', mine: true, placeholder: true });
  return list;
}

function countAvail(day) { return pollEvent.avails.filter((a) => a.date === day).length; }

function bestDate(ev) {
  const counts = ev.dates.map((dr) => countAvail(dr.date));
  const best = counts.length ? Math.max(...counts) : 0;
  return ev.dates.find((dr, i) => counts[i] === best)?.date || null;
}

function renderMatrix() {
  const ev = pollEvent;
  const locked = ev.status === 'confirmed';
  const dates = ev.dates
    .filter((dr) => dr.active !== false)
    .filter((dr) => !weekendOnly || isWeekend(dr.date) || (locked && dr.date === ev.date))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  const members = matrixMembers();
  const t = todayStr();
  const counts = dates.map((dr) => countAvail(dr.date));
  const best = counts.length ? Math.max(...counts) : 0;
  const bestDay = dates.find((dr, i) => counts[i] === best)?.date;

  let html = `<table class="matrix"><thead><tr><th class="date-head">후보 날짜</th>`;
  members.forEach((m) => {
    const label = m.placeholder ? '＋ 참여' : m.name;
    html += `<th class="member-col${m.mine ? ' mine' : ''}">${escapeHtml(label)}</th>`;
  });
  html += `</tr></thead><tbody>`;

  dates.forEach((dr, i) => {
    const d = parseDate(dr.date);
    const dow = DOW[d.getDay()];
    const cnt = counts[i];
    const cls = [];
    const isFixed = locked && dr.date === ev.date;
    if (isFixed) cls.push('fixed');
    else if (!locked && cnt === best && best > 0) cls.push('hot');
    if (locked && !isFixed) cls.push('locked');
    if (dr.date < t) cls.push('past');
    if (!locked && dr.date === playableDate) cls.push('picked');
    html += `<tr class="${cls.join(' ')}">`;
    // 날짜 칸을 누르면 아래 '되는 곡' 표가 그 날짜 기준으로 바뀐다
    html += `<td class="date-cell"${locked ? '' : ` data-pick-date="${dr.date}"`}>${monthDay(dr.date)} <span class="dow${dow === '일' ? ' sunday' : ''}${dow === '토' ? ' saturday' : ''}">(${dow})</span><span class="date-cnt"><span>${cnt}명</span></span>${isFixed ? '<span class="date-fixed"><span>확정</span></span>' : ''}${locked ? '' : `<button type="button" class="date-off" data-off-date="${dr.date}" title="이 날짜를 후보에서 빼기" aria-label="${monthDay(dr.date)} 후보에서 빼기">×</button>`}</td>`;
    const canToggle = !locked || isFixed;
    members.forEach((m) => {
      const on = m.name && ev.avails.some((a) => a.date === dr.date && a.nickname === m.name);
      // 조율 중에는 내 열만, 확정 후에는 확정일 행의 모든 열을 조작할 수 있다
      const editable = canToggle && (m.mine || (isFixed && !!m.name));
      const cellCls = ['avail-cell'];
      if (m.mine && canToggle) cellCls.push('mine');
      if (on) cellCls.push('on');
      const toggle = editable ? ` data-toggle="${dr.date}" data-member="${escapeHtml(m.name)}"` : '';
      const content = on ? '✓' : (m.placeholder && canToggle) || (editable && !m.mine) ? '＋' : '';
      html += `<td class="${cellCls.join(' ')}"${toggle}><span class="avail-check">${content}</span></td>`;
    });
    html += `</tr>`;
  });
  html += '</tbody></table>';
  /* 뺀 날짜는 지운 게 아니라 꺼 둔 것이다. 찍어 둔 기록이 남아 있으므로 되돌릴 수 있다. */
  const off = ev.dates.filter((dr) => dr.active === false).sort((a, b) => (a.date < b.date ? -1 : 1));
  if (off.length) {
    html += `<p class="dates-off">후보에서 뺀 날짜 ${off.map((dr) =>
      `<button type="button" data-on-date="${dr.date}" title="다시 후보로">${monthDay(dr.date)}
       <i>${countAvail(dr.date)}명</i> ↩</button>`).join('')}</p>`;
  }
  matrixEl.innerHTML = html;

  if (locked) return;
  const prev = confirmDateEl.value;
  confirmDateEl.innerHTML = dates.map((dr) =>
    `<option value="${dr.date}"${dr.date === bestDay ? ' selected' : ''}>${monthDay(dr.date)} (${DOW[parseDate(dr.date).getDay()]}) · ${countAvail(dr.date)}명</option>`
  ).join('');
  if (prev) confirmDateEl.value = prev;
}

function renderPollView() {
  const ev = pollEvent;
  if (!ev) return;
  const locked = ev.status === 'confirmed';
  const f = firstDate(ev), l = lastDate(ev);
  if (locked) {
    const d = ev.date ? parseDate(ev.date) : null;
    const when = d ? `${d.getMonth() + 1}월 ${d.getDate()}일 (${DOW[d.getDay()]})` : '날짜 미정';
    pollMeta.textContent = [when, timeText(ev), ev.place, ev.createdBy].filter(Boolean).join(' · ');
    confirmedDetail.textContent = `${when} · ${timeText(ev)}${ev.place ? ' · ' + ev.place : ''}`;
    pollHintEl.textContent = '확정된 일정입니다 · 확정 날짜의 참석 인원만 수정할 수 있습니다';
    playableDate = ev.date;
  } else {
    pollMeta.textContent = `후보 ${ev.dates.length}일${f ? ' · ' + monthDay(f) : ''}${l && l !== f ? ' ~ ' + monthDay(l) : ''}${ev.createdBy ? ' · ' + ev.createdBy : ''}`;
    pollHintEl.textContent = '내 열(점선)을 탭해 가능 표시 · 날짜를 탭하면 그날 되는 곡';
    if (!playableDate || !ev.dates.some((dr) => dr.date === playableDate)) playableDate = bestDate(ev);
  }
  confirmBar.hidden = locked;
  confirmedBar.hidden = !locked;
  setlistSection.hidden = !locked;
  playableSection.hidden = !playableDate;
  renderMatrix();
  if (locked) renderSetlist();
  renderPsDates();
  syncPlayable();
}

/* ---------- 날짜별 가능 곡 ---------- */
function renderPsDates() {
  const ev = pollEvent;
  if (ev.status === 'confirmed') {
    psDatesEl.innerHTML = '';
    psTitleEl.textContent = '이 인원으로 되는 곡';
    return;
  }
  psTitleEl.textContent = playableDate ? `${monthDay(playableDate)} (${DOW[parseDate(playableDate).getDay()]})이면 되는 곡` : '되는 곡';
  const dates = ev.dates.filter((dr) => dr.active !== false)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  psDatesEl.innerHTML = dates.map((dr) =>
    `<button type="button" class="chip${dr.date === playableDate ? ' is-on' : ''}" data-ps-date="${dr.date}">${monthDay(dr.date)}<i>${countAvail(dr.date)}</i></button>`
  ).join('');
}

psDatesEl.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-ps-date]');
  if (!btn) return;
  playableDate = btn.dataset.psDate;
  renderMatrix();
  renderPsDates();
  syncPlayable();
});

function attendeeKey(ev, day) {
  return [ev.id, day, ...ev.avails.filter((a) => a.date === day).map((a) => a.nickname).sort()].join('|');
}

async function syncPlayable() {
  const ev = pollEvent;
  if (!ev || !playableDate) return;
  const key = attendeeKey(ev, playableDate);
  if (key === playableKey) { renderPlayable(); return; }
  try {
    const data = await api.get(`/events/${ev.id}/playable?date=${playableDate}`);
    if (!pollEvent || pollEvent.id !== ev.id) return;
    playable = data;
    playableKey = key;
  } catch (err) {
    console.error('가능 곡 로드 실패:', err);
    playableListEl.innerHTML = `<p class="muted empty-msg">가능한 곡을 불러오지 못했습니다.</p>`;
    return;
  }
  renderPlayable();
}

function roleColumns(songs) {
  const seen = [];
  songs.forEach((s) => s.roles.forEach((r) => { if (!seen.includes(r.role)) seen.push(r.role); }));
  const known = ROLE_ORDER.filter((r) => seen.includes(r));
  const extra = seen.filter((r) => !ROLE_ORDER.includes(r)).sort();
  return [...known, ...extra];
}

function inSetlist(songId) {
  return !!pollEvent && pollEvent.songs.some((s) => s.songId === songId);
}

function renderPlayable() {
  if (!playable) { showLoading(playableListEl); return; }
  const all = playable.songs;
  const locked = pollEvent.status === 'confirmed';
  /* 길드 일정이면 범위 칩을 세운다. 길드 곡만 / 전체. */
  const g = pollEvent.guild;
  psScopeEl.hidden = !g;
  psScopeEl.querySelectorAll('[data-scope]').forEach((b) => {
    const on = b.dataset.scope === playableScope;
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-pressed', on);
  });
  const pool = g && playableScope === 'guild' ? all.filter((s) => s.guildId === g.id) : all;
  /* 참석자가 없으면 충족도가 전부 0 이다. 조율 중이면 볼 것이 없지만, 확정 뒤에는 셋리스트를
     먼저 짜야 할 수 있다 — 전에는 표가 아예 안 떠서 ＋ 를 누를 곳이 없었다(쿠로 제보, 2026-09-16).
     그래서 확정된 일정이면 곡 전체를 ＋ 와 함께 보여 준다. */
  const nobody = !playable.attendees.length;
  if (nobody && !locked) {
    playableListEl.innerHTML = `<p class="muted empty-msg">이 날짜에 가능한 사람이 아직 없습니다.</p>`;
    playableStageEl.innerHTML = '';
    psToggleBtn.hidden = true;
    return;
  }
  const shown = playableAll || nobody ? pool : pool.filter((s) => s.filled >= MIN_FILLED);
  const hidden = pool.length - shown.length;
  psToggleBtn.hidden = nobody || (playableAll ? pool.length === 0 : hidden <= 0);
  psToggleBtn.textContent = playableAll ? `${MIN_FILLED}개 이상만 보기` : `전체 보기 (+${hidden}곡)`;

  if (!shown.length) {
    const what = g && playableScope === 'guild' ? '이 길드 곡 중 ' : '';
    playableListEl.innerHTML = `<p class="muted empty-msg">${nobody ? `${what}곡이 없습니다.` : `${what}${MIN_FILLED}개 세션 이상 채워지는 곡이 없습니다.`}</p>`;
    playableStageEl.innerHTML = '';
    return;
  }

  /* 무대에 올릴 곡. 아무것도 안 고른 상태면 맨 위 곡이 이미 서 있다.
     홈이 첫 자켓을 자동으로 고르는 것과 같은 규칙이다. */
  if (!shown.some((x) => x.songId === stageSongId)) stageSongId = shown[0].songId;

  const cols = roleColumns(all);
  let html = `<table class="ps-table"><thead><tr>`;
  html += `<th class="ps-score-head">충족</th><th class="ps-song-head">곡</th>`;
  cols.forEach((r) => {
    const short = ROLE_SHORT[r] || r;
    html += `<th class="ps-role-head" title="${escapeHtml(r)}">` +
      `<span class="ps-role-short">${escapeHtml(short)}</span>` +
      `<span class="ps-role-full">${escapeHtml(r)}</span></th>`;
  });
  /* 확정 후에만 서는 ＋ 열. 파트 칸과 폭이 달라서(30 vs 32) 클래스를 나눈다 —
     table-layout:fixed 가 첫 줄에 적힌 폭만 보기 때문이다. */
  if (locked) html += `<th class="ps-act-head"></th>`;
  html += `</tr></thead><tbody>`;

  let lastFilled = null;
  shown.forEach((s) => {
    const byRole = {};
    s.roles.forEach((r) => { byRole[r.role] = r; });
    const ratio = s.needed ? s.filled / s.needed : 0;
    const tier = ratio >= 1 ? 'full' : ratio >= 0.66 ? 'good' : ratio >= 0.5 ? 'half' : 'low';
    const gap = lastFilled !== null && lastFilled !== s.filled ? ' ps-gap' : '';
    lastFilled = s.filled;
    const picked = inSetlist(s.songId);
    html += `<tr class="ps-row ${tier}${gap}${picked ? ' picked' : ''}`
      + `${s.songId === stageSongId ? ' is-stage' : ''}" data-song="${s.songId}">`;
    const pct = s.needed ? (s.filled / s.needed) * 100 : 0;
    html += `<td class="ps-score"><strong>${s.filled}</strong><span>/${s.needed}</span>` +
      `<span class="skew-gauge${s.filled === s.needed ? ' full' : ''}">` +
      `<i style="width:${pct}%"></i></span></td>`;
    html += `<td class="ps-song" title="${escapeHtml(s.title)}${s.artist ? ' · ' + escapeHtml(s.artist) : ''}">` +
      `<div class="ps-song-title">${escapeHtml(s.title)}</div>` +
      `<div class="ps-song-sub">${escapeHtml(s.artist || '')}${!Site.slug && s.guild ? ' ' + guildBadge(s.guild) : ''}</div></td>`;
    cols.forEach((role) => {
      const r = byRole[role];
      if (!r) { html += `<td class="ps-cell none"></td>`; return; }
      if (!r.ok) { html += `<td class="ps-cell off"><span class="ps-hole"></span></td>`; return; }
      // 중복지원이면 칩이 그만큼 늘어난다. 열을 넓히면 그만큼 다른 파트가 화면 밖으로
      // 나가므로, 몇 명인지만 알려 주고 겹침은 CSS 가 깊게 준다(무대의 data-n 과 같은 방법).
      html += `<td class="ps-cell on"><span class="ps-chips" data-n="${r.members.length}">` +
        r.members.map((n) => avatarChip(n)).join('') + `</span></td>`;
    });
    if (locked) {
      html += `<td class="ps-cell act"><button type="button" class="ps-add${picked ? ' is-on' : ''}" data-set-song="${s.songId}" title="${picked ? '셋리스트에서 빼기' : '셋리스트에 넣기'}">${picked ? '✓' : '＋'}</button></td>`;
    }
    html += `</tr>`;
    /* 좁은 화면에서는 고른 줄 바로 아래에 무대가 펼쳐진다. 넓으면 CSS 가 이 줄을 숨기고
       표 옆의 고정 자리를 쓴다. 같은 내용이라 둘 중 하나만 보인다. */
    if (s.songId === stageSongId) {
      const span = cols.length + 2 + (locked ? 1 : 0);
      html += `<tr class="ps-stage-row"><td colspan="${span}">${stageBlock(s)}</td></tr>`;
    }
  });
  html += `</tbody></table>`;
  playableListEl.innerHTML = html;
  renderStage();
}

/* 무대 한 판. 머리글이 곧 접기 단추다 — 곡 이름과 충족 수가 이미 거기 있어서
   접기만 따로 둘 자리를 새로 만들 이유가 없다(§9.2). 접으면 이 한 줄만 남는다. */
function stageBlock(s) {
  return `<button type="button" class="ps-stage-head" data-stage-fold aria-expanded="${stageOpen}">`
    + `<b>${escapeHtml(s.title)}</b>`
    + `<span class="ps-stage-fill">${s.filled}<i>/${s.needed}</i></span>`
    + `<span class="ps-stage-caret">${stageOpen ? '접기 ▴' : '펼치기 ▾'}</span>`
    + `</button>`
    + (stageOpen ? stageHtml(s.roles) : '');
}

/* 표 안의 무대와 옆 칸의 무대는 같은 것을 가리키므로 같이 접힌다.
   renderPlayable 이 끝에서 renderStage 를 부르므로 한 번만 다시 그리면 둘 다 따라온다. */
function toggleStage(host) {
  stageOpen = !stageOpen;
  try { localStorage.setItem(STAGE_OPEN, stageOpen ? '1' : '0'); } catch {}
  renderPlayable();
  host?.querySelector('[data-stage-fold]')?.focus();
}

function renderStage() {
  const s = playable && stageSongId ? playable.songs.find((x) => x.songId === stageSongId) : null;
  playableStageEl.innerHTML = s ? stageBlock(s) : '';
  /* 무대는 옆 칸과 표 안 두 곳에 그려진다. stageTalk 이 보이는 쪽을 알아서 찾는다. */
  stageTalk(!!stageSongId);
}

/* 옆 칸(900px 이상)의 무대에는 여태 처리기가 없었다. 접기 단추가 생겼으니 붙인다. */
psScopeEl.addEventListener('click', (e) => {
  const b = e.target.closest('[data-scope]');
  if (!b || b.dataset.scope === playableScope) return;
  playableScope = b.dataset.scope;
  renderPlayable();
});
playableStageEl.addEventListener('click', (e) => {
  if (e.target.closest('[data-stage-fold]')) toggleStage(playableStageEl);
});

psToggleBtn.addEventListener('click', () => {
  playableAll = !playableAll;
  renderPlayable();
});

playableListEl.addEventListener('click', async (e) => {
  /* 접기 단추가 먼저다. 이 단추는 표 안의 무대 줄(.ps-stage-row)에 있고
     그 줄은 .ps-row 가 아니라서 아래 곡 고르기에는 안 걸리지만, 순서를 분명히 둔다. */
  if (e.target.closest('[data-stage-fold]')) { toggleStage(playableListEl); return; }
  const btn = e.target.closest('[data-set-song]');
  if (!btn) {
    /* 줄을 누르면 그 곡이 무대에 오른다 */
    const row = e.target.closest('.ps-row[data-song]');
    if (row) { stageSongId = Number(row.dataset.song); renderPlayable(); }
    return;
  }
  if (!pollEvent) return;
  const id = Number(btn.dataset.setSong);
  const ids = pollEvent.songs.map((s) => s.songId);
  const next = ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
  const saved = await Writes.commit(btn, `setlist:${pollEvent.id}`,
    () => api.put(`/events/${pollEvent.id}/songs`, { songIds: next }));
  if (!saved) return;
  putEvent(saved);
  renderSetlist();
  renderPlayable();
});

/* ---------- 셋리스트 · 라인업 ---------- */
function renderSetlist() {
  const ev = pollEvent;
  if (!ev.songs.length) {
    setlistEl.innerHTML = `<p class="muted empty-msg">아직 곡이 없습니다. 아래 표에서 ＋ 를 눌러 넣으세요.</p>`;
    return;
  }
  const me = Nick.get();
  setlistEl.innerHTML = ev.songs.map((s, i) => {
    /* 파트별로 묶되, 예전에 약어로 들어간 줄(V·EG1·D …)은 표준 파트로 읽어 같은 자리에 세운다.
       빼기는 저장된 값 그대로 보내야 하므로 이름마다 원래 파트를 단다. */
    const byRole = {};
    s.lineup.forEach((l) => { (byRole[stdRole(l.role)] = byRole[stdRole(l.role)] || []).push(l); });
    const roles = ROLE_ORDER.filter((r) => byRole[r]).concat(Object.keys(byRole).filter((r) => !ROLE_ORDER.includes(r)));
    const cells = roles.map((r) => `
      <span class="sl-role">
        <span class="sl-role-name">${escapeHtml(ROLE_SHORT[r] || r)}</span>
        ${byRole[r].map((l) => `<span class="sl-name${l.nickname === me ? ' me' : ''}" data-lineup-nick="${escapeHtml(l.nickname)}" data-lineup-role="${escapeHtml(l.role)}" data-lineup-song="${s.songId}">${escapeHtml(l.nickname)}</span>`).join('')}
      </span>`).join('');
    return `
      <div class="sl-item">
        <span class="sl-no"><span>${i + 1}</span></span>
        <div class="sl-info">
          <div class="sl-title">${escapeHtml(s.title)} ${!Site.slug ? guildBadge(s.guild) : ''}</div>
          <div class="sl-lineup">${cells}<button type="button" class="sl-add" data-lineup-add="${s.songId}" title="라인업에 사람 넣기">＋</button></div>
        </div>
        <button type="button" class="ghost" data-set-song="${s.songId}">빼기</button>
      </div>`;
  }).join('');
}

setlistEl.addEventListener('click', async (e) => {
  const ev = pollEvent;
  if (!ev) return;
  const rm = e.target.closest('[data-set-song]');
  if (rm) {
    const id = Number(rm.dataset.setSong);
    const saved = await Writes.commit(rm, `setlist:${ev.id}`,
      () => api.put(`/events/${ev.id}/songs`, { songIds: ev.songs.map((s) => s.songId).filter((x) => x !== id) }));
    if (!saved) return;
    putEvent(saved);
    renderSetlist();
    renderPlayable();
    return;
  }
  const nick = e.target.closest('[data-lineup-nick]');
  if (nick) {
    const name = nick.dataset.lineupNick, role = nick.dataset.lineupRole;
    if (!confirm(`${name}님을 ${stdRole(role)}에서 뺄까요?`)) return;
    setLineup(ev, Number(nick.dataset.lineupSong), role, name, false);
    return;
  }
  const add = e.target.closest('[data-lineup-add]');
  if (add) {
    const pick = await pickLineup(ev, Number(add.dataset.lineupAdd));
    if (pick) setLineup(ev, Number(add.dataset.lineupAdd), pick.role, pick.name, true);
  }
});

/* 저장된 파트 값을 표준 여섯 중 하나로 읽는다. 약어(V·EG1·BG·KY·D)는 common.js ROLE_SHORT 를 거꾸로 본다.
   어느 쪽인지 모르는 값(EG 등)은 그대로 둔다 — 표준 뒤에 따로 선다. */
function stdRole(r) {
  const t = String(r || '').trim();
  if (ROLE_ORDER.includes(t)) return t;
  return Object.keys(ROLE_SHORT).find((k) => ROLE_SHORT[k] === t.toUpperCase()) || t;
}

/* 라인업에 사람 넣기. 파트는 표준 여섯 칩 중에서만 고른다(타이핑하면 'D'·'드럼' 이 갈렸다).
   사람은 그 파트에 지원하고 그날 오는 사람을 먼저 보여 주고, 명단에 없는 표기도 쳐 넣을 수 있다. */
async function pickLineup(ev, songId) {
  const song = ev.songs.find((x) => x.songId === songId);
  const names = await roster();
  /* 그날 되는 곡 표가 이 곡을 알고 있으면(확정일 기준) 파트별 '지원 + 참석' 을 쓴다 */
  const known = playable && playable.date === ev.date ? playable.songs.find((x) => x.songId === songId) : null;
  const labelOf = (r) => known?.roles.find((x) => x.role === r)?.label || '';
  const wantOf = (r) => known?.roles.find((x) => x.role === r)?.members || [];
  return new Promise((resolve) => {
    let role = '';
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="lu-title">
        <h3 class="modal-title" id="lu-title">${escapeHtml(song ? song.title : '')}</h3>
        <form class="modal-form lu-form">
          <div class="chip-set lu-roles" role="group" aria-label="파트">
            ${ROLE_ORDER.map((r) => `<button type="button" class="chip" data-lu-role="${escapeHtml(r)}" aria-pressed="false">${escapeHtml(ROLE_SHORT[r] || r)}${labelOf(r) ? ` <i>${escapeHtml(labelOf(r))}</i>` : ''}</button>`).join('')}
          </div>
          <div class="chip-set lu-want" hidden></div>
          <input name="who" list="lu-names" placeholder="닉네임" maxlength="40" autocomplete="off" />
          <datalist id="lu-names">${names.map((n) => `<option value="${escapeHtml(n)}"></option>`).join('')}</datalist>
          <p class="form-error" role="alert" hidden></p>
          <button type="submit" class="pink">넣기</button>
          <button type="button" class="ghost" data-cancel>취소</button>
        </form>
      </div>`;
    const close = (v) => { document.removeEventListener('keydown', onKey); backdrop.remove(); resolve(v); };
    const onKey = (e) => { if (e.key === 'Escape') close(null); };
    document.addEventListener('keydown', onKey);
    const form = backdrop.querySelector('form');
    const want = backdrop.querySelector('.lu-want');
    const err = backdrop.querySelector('.form-error');
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop || e.target.closest('[data-cancel]')) return close(null);
      const r = e.target.closest('[data-lu-role]');
      if (r) {
        role = r.dataset.luRole;
        backdrop.querySelectorAll('[data-lu-role]').forEach((b) => {
          b.classList.toggle('is-on', b === r);
          b.setAttribute('aria-pressed', b === r);
        });
        /* 이 파트에 지원했고 그날 오는 사람. 누르면 이름 칸에 들어간다. */
        const list = wantOf(role);
        want.hidden = !list.length;
        want.innerHTML = list.map((n) => `<button type="button" class="chip" data-lu-name="${escapeHtml(n)}">${escapeHtml(n)}</button>`).join('');
        err.hidden = true;
        return;
      }
      const n = e.target.closest('[data-lu-name]');
      if (n) { form.elements.who.value = n.dataset.luName; form.elements.who.focus(); }
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const name = form.elements.who.value.trim();
      if (!role || !name) { err.textContent = !role ? '파트를 고르세요.' : '닉네임을 넣으세요.'; err.hidden = false; return; }
      close({ role, name });
    });
    document.body.appendChild(backdrop);
  });
}

/* 라인업 한 칸. 누르는 즉시 바꾸고 서버에 보낸다(common.js Writes).
   실패하면 알리고, 쓰기가 끝날 때 서버의 실제 상태로 되돌아간다. */
function setLineup(ev, songId, role, nickname, on) {
  const item = ev.songs.find((x) => x.songId === songId);
  if (!item) return;
  item.lineup = item.lineup.filter((l) => !(l.role === role && l.nickname === nickname));
  if (on) item.lineup.push({ role, nickname });
  renderSetlist();
  Writes.run(`lineup:${ev.id}:${songId}:${role}:${nickname}`,
    () => api.post(`/events/${ev.id}/songs/${songId}/lineup`, { role, nickname, on }))
    .catch((err) => { api.forgetPolls(); alert(err.message); });
}

function openPoll(id) {
  const ev = events.find((e) => e.id === id);
  if (!ev) return;
  if (openId === id) { closePoll(); return; }   /* 다시 누르면 접힌다 */
  pollEvent = ev;
  openId = id;
  currentUser = Nick.get();
  confirmDateEl.value = '';
  confirmStartEl.value = '';
  confirmEndEl.value = '';
  confirmPlaceEl.value = '';
  weekendOnlyEl.checked = false;
  weekendOnlyEl.closest('.chk').classList.remove('is-on');
  weekendOnly = false;
  playable = null;
  playableKey = '';
  playableDate = null;
  stageSongId = null;
  playableScope = 'guild';
  renderPolls();
  renderPast();
  renderPollView();
  const slot = document.querySelector(`[data-slot="${id}"]`);
  if (slot) slot.closest('.poll-entry').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function closePoll() {
  pollEvent = null;
  openId = null;
  playable = null;
  playableKey = '';
  playableAll = false;
  playableDate = null;
  stageSongId = null;
  parkDetail();
  renderPolls();
  renderPast();
}

function onOpenClick(e) {
  /* 상세는 이제 목록 안에 있다. 그 안을 누른 것은 접기가 아니다. */
  if (e.target.closest('#poll-detail')) return;
  const item = e.target.closest('[data-open-poll]');
  if (item) openPoll(Number(item.dataset.openPoll));
}
function onOpenKey(e) {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  if (e.target.closest('#poll-detail')) return;
  const item = e.target.closest('[data-open-poll]');
  if (!item) return;
  e.preventDefault();
  openPoll(Number(item.dataset.openPoll));
}
pollListEl.addEventListener('click', onOpenClick);
pastListEl.addEventListener('click', onOpenClick);
pollListEl.addEventListener('keydown', onOpenKey);
pastListEl.addEventListener('keydown', onOpenKey);
document.getElementById('poll-delete').addEventListener('click', async () => {
  if (!pollEvent) return;
  if (!confirm(`${pollEvent.title} 조율을 삭제할까요?`)) return;
  const id = pollEvent.id;
  const ok = await Writes.commit(document.getElementById('poll-delete'), `event:${id}`,
    () => api.del(`/events/${id}`).then(() => true));
  if (!ok) return;
  closePoll();
  events = events.filter((x) => x.id !== id);   /* 목록 전체를 다시 받지 않고 바로 뺀다 */
  renderPolls();
  renderPast();
});

weekendOnlyEl.addEventListener('change', () => {
  weekendOnly = weekendOnlyEl.checked;
  weekendOnlyEl.closest('.chk').classList.toggle('is-on', weekendOnly);
  renderMatrix();
});

matrixEl.addEventListener('click', async (e) => {
  /* 후보에서 빼고 넣기. 버튼이 날짜 칸 안에 있으므로 칸보다 먼저 본다. */
  const offBtn = e.target.closest('[data-off-date]');
  const onBtn = e.target.closest('[data-on-date]');
  if (offBtn || onBtn) {
    e.stopPropagation();
    const day = (offBtn || onBtn).dataset.offDate || onBtn.dataset.onDate;
    if (offBtn) {
      const n = countAvail(day);
      const msg = n
        ? `${monthDay(day)} 를 후보에서 뺄까요?
이미 ${n}명이 찍었지만 기록은 남고, 언제든 되돌릴 수 있습니다.`
        : `${monthDay(day)} 를 후보에서 뺄까요?`;
      if (!confirm(msg)) return;
    }
    const ev = pollEvent;
    const res = await Writes.commit(offBtn || onBtn, `date:${ev.id}:${day}`,
      () => api.post(`/events/${ev.id}/dates/${day}/toggle`, {}));
    if (!res) return;
    const dr = ev.dates.find((x) => x.date === res.date);   /* 돌려받은 상태로 바로 그린다 */
    if (dr) dr.active = res.active;
    playableKey = '';
    renderPollView();
    return;
  }
  const pick = e.target.closest('[data-pick-date]');
  if (pick) {
    playableDate = pick.dataset.pickDate;
    renderMatrix();
    renderPsDates();
    syncPlayable();
    return;
  }
  const td = e.target.closest('[data-toggle]');
  if (!td) return;
  const on = td.classList.contains('on');
  let who = td.dataset.member || '';
  if (who && who !== currentUser) {
    const msg = on ? `${who}님을 참석자에서 뺄까요?` : `${who}님을 참석자에 넣을까요?`;
    if (!confirm(msg)) return;
  } else {
    if (!currentUser) {
      const name = await Nick.ensure();
      if (!name) return;
      currentUser = name;
    }
    who = currentUser;
  }
  setAvail(pollEvent, td.dataset.toggle, who, !on);
});

/* 참석 칸. 누르는 즉시 칸을 바꾸고 서버에 보낸다(common.js Writes). 전에는 응답과 일정 전체를
   다시 받은 뒤에야 칸이 바뀌었다. 실패하면 알리고, 쓰기가 끝날 때 서버의 실제 상태로 되돌아간다. */
function setAvail(ev, day, who, on) {
  ev.avails = ev.avails.filter((a) => !(a.date === day && a.nickname === who));
  if (on) ev.avails.push({ eventId: ev.id, date: day, nickname: who });
  renderPollView();
  Writes.run(`avail:${ev.id}:${day}:${who}`,
    () => api.post(`/events/${ev.id}/avail/toggle`, { date: day, nickname: who, checked: on }))
    .catch((err) => { api.forgetPolls(); alert(err.message); });
}

confirmBtn.addEventListener('click', async () => {
  const day = confirmDateEl.value;
  if (!day || !pollEvent) return;
  const start = confirmStartEl.value || null;
  const end = confirmEndEl.value || null;
  const place = confirmPlaceEl.value.trim() || null;
  const d = parseDate(day);
  if (!confirm(`${d.getMonth() + 1}월 ${d.getDate()}일 (${DOW[d.getDay()]})로 확정할까요?`)) return;
  const ev = await Writes.commit(confirmBtn, `event:${pollEvent.id}`,
    () => api.post(`/events/${pollEvent.id}/confirm`, { date: day, startTime: start, endTime: end, place }));
  if (!ev) return;
  putEvent(ev);          /* 돌려받은 일정으로 바로 그린다 */
  renderPolls();
  renderPast();
  renderPollView();
});

addMemberBtn.addEventListener('click', async () => {
  const ev = pollEvent;
  if (!ev || ev.status !== 'confirmed' || !ev.date) return;
  const input = prompt('합주에 추가할 멤버 닉네임을 입력하세요.');
  if (input === null) return;
  const name = input.trim();
  if (!name) return;
  if (name.length > NICK_MAX) {
    alert(`닉네임은 ${NICK_MAX}자까지 입력할 수 있습니다.`);
    return;
  }
  if (ev.avails.some((a) => a.date === ev.date && a.nickname === name)) {
    alert(`${name}님은 이미 참석 중입니다.`);
    return;
  }
  setAvail(ev, ev.date, name, true);
});

unconfirmBtn.addEventListener('click', async () => {
  if (!pollEvent) return;
  if (!confirm(`${pollEvent.title} 확정을 해제하고 다시 조율할까요?`)) return;
  const ev = await Writes.commit(unconfirmBtn, `event:${pollEvent.id}`,
    () => api.post(`/events/${pollEvent.id}/unconfirm`, {}));
  if (!ev) return;
  putEvent(ev);          /* 돌려받은 일정으로 바로 그린다 */
  renderPolls();
  renderPast();
  renderPollView();
});

mountChrome('schedule');
pollDetail.addEventListener('focusout', (e) => {
  if (!refreshDeferred || (e.relatedTarget && pollDetail.contains(e.relatedTarget) && e.relatedTarget.matches('input, select, textarea'))) return;
  refreshDeferred = false;
  refresh();
});
startPolling(refresh);
document.addEventListener('writes-idle', () => refresh());   /* 누른 것이 다 저장되면 서버 상태로 맞춘다 */

document.addEventListener('nickchange', () => {
  currentUser = Nick.get();
  if (openId) renderPollView();
});
document.addEventListener('profiles', () => { renderPolls(); if (openId) renderPollView(); });
