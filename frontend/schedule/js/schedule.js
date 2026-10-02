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
const kindPick = document.getElementById('kind-pick');
const guildPick = document.getElementById('guild-pick');
let pickedKind = null;        /* 만들 때 고른 종류 */
let pickedGuilds = new Set(); /* 정기합주·정기공연의 참가 길드 */
let guildList = [];           /* 참가 길드 고르기·고치기에 쓰는 길드 목록. 창을 열 때 받는다 */
const addForm = document.getElementById('add-form');
const inTitle = document.getElementById('in-title');
const inFrom = document.getElementById('in-from');
const inTo = document.getElementById('in-to');
const inNote = document.getElementById('in-note');

const pollPark = document.getElementById('poll-park');
const pollDetail = document.getElementById('poll-detail');
const pollMeta = document.getElementById('poll-meta');
const pollDetailHead = document.querySelector('#poll-detail .poll-detail-head');
const voteToggle = document.getElementById('vote-toggle');
const voteBox = document.getElementById('vote-box');
const confirmedPeople = document.getElementById('confirmed-people');
let voteOpen = false;         /* 확정 일정에서 날짜 투표 기록을 펼쳤는가 */
const matrixEl = document.getElementById('matrix');
const weekendOnlyEl = document.getElementById('weekend-only');
const confirmDateEl = document.getElementById('confirm-date');
const confirmStartEl = document.getElementById('confirm-start');
const confirmEndEl = document.getElementById('confirm-end');
const confirmPlaceEl = document.getElementById('confirm-place');
const confirmBtn = document.getElementById('confirm-btn');
const confirmBar = document.getElementById('confirm-bar');
const confirmedBar = document.getElementById('confirmed-bar');
const unconfirmBtn = document.getElementById('unconfirm-btn');
const playableSection = document.getElementById('playable-section');
const playableListEl = document.getElementById('playable-list');
const playableStageEl = document.getElementById('playable-stage');
const psTitleEl = document.getElementById('ps-title');
const psDatesEl = document.getElementById('ps-dates');
const psToggleBtn = document.getElementById('ps-toggle');
const psSearchEl = document.getElementById('ps-search');
let psQuery = '';             /* '되는 곡' 검색어. 일정을 바꾸면 비운다 */

/* 원제·번역·아티스트·그날 되는 사람 이름. 곡 목록 검색과 같은 규칙이다 */
function psMatch(s, q) {
  if ([s.title, s.titleKo, s.artist].some((v) => (v || '').toLowerCase().includes(q))) return true;
  return s.roles.some((r) => r.members.some((n) => n.toLowerCase().includes(q)));
}
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
const isUnion = (ev) => ['regular', 'concert'].includes(eventKind(ev));

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

/* ---------- 일정표 (2026-10-02) ----------
   한 열, 시간순, 날짜가 맨 앞에 크게. 2열 카드는 눈이 지그재그로 움직여 순서가 안 읽혔고,
   날짜가 셋째 줄 작은 글씨라 '언제 무엇이 있나' 를 보려는 화면의 위계가 거꾸로였다.
   날짜 투표 중인 일정은 맨 위 '날짜 정하는 중' 에 모은다(후보가 수십 일이라 날짜 자리에 못 선다).
   확정 일정은 달마다 묶는다. 길드는 왼쪽 문장 하나로만 — 알약 배지는 같은 것을 두 번 말했다. */
function monthLabel(iso) {
  const [y, m] = iso.split('-').map(Number);
  return y === new Date().getFullYear() ? `${m}월` : `${y}년 ${m}월`;
}

/* 종류 글자와 날짜 칸은 eventcard.js 에 있다 — 홈 '모임·일정' 과 같은 코드를 쓴다 */
const kindLine = (e) => eventKindText(e);
const dateCell = (e) => eventDateHtml(e);

function pollHead(e) {
  const open = e.id === openId;
  let when, count;
  if (e.status === 'confirmed') {
    const cnt = e.avails.filter((a) => a.date === e.date).length;
    when = [timeText(e), e.place, e.songs.length ? `${e.songs.length}곡` : ''].filter(Boolean).map(escapeHtml).join(' · ');
    count = `<span class="poll-item-count">${isPast(e) ? '' : '참석 '}${cnt}명</span>`;
  } else {
    const best = Math.max(0, ...e.dates.map((dr) => e.avails.filter((a) => a.date === dr.date).length));
    when = `후보 ${e.dates.length}일${e.createdBy ? ' · ' + escapeHtml(e.createdBy) : ''}`;
    count = `<span class="poll-item-count${best > 0 ? ' max' : ''}">최다 ${best}명</span>`;
  }
  /* 열: 날짜 | 문장 | 제목 | 종류·소속 | 시간·장소·곡 | 인원. 좁으면 종류·시간이 제목 아래 한 줄로 접힌다(CSS) */
  return `
      <div class="poll-item sched-row kind-${eventKind(e)}" data-open-poll="${e.id}" role="button" tabindex="0" aria-expanded="${open}">
        ${dateCell(e)}
        ${eventSymbol(e)}
        <div class="poll-item-title">${escapeHtml(e.title)}</div>
        <div class="sched-meta"><span class="sched-kind">${kindLine(e)}</span><span class="sched-when">${when}</span></div>
        ${count}
      </div>`;
}

/* 묶음 머리를 끼워 가며 그린다. key(e) 가 바뀌는 자리에 머리가 선다 */
function grouped(list, key, label) {
  let last = null;
  return list.map((e) => {
    const k = key(e);
    const head = k !== last ? `<div class="sched-group">${escapeHtml(label(e))}</div>` : '';
    last = k;
    return head + pollEntry(e, pollHead(e));
  }).join('');
}

function renderPolls() {
  const upcoming = events.filter((e) => !isPast(e));
  const polls = upcoming.filter((e) => e.status !== 'confirmed')
    .sort((a, b) => {
      const fa = firstDate(a) || '9999', fb = firstDate(b) || '9999';
      return fa < fb ? -1 : fa > fb ? 1 : b.id - a.id;
    });
  const fixed = upcoming.filter((e) => e.status === 'confirmed')
    .sort((a, b) => ((a.date || '9999') < (b.date || '9999') ? -1 : (a.date || '9999') > (b.date || '9999') ? 1 : a.id - b.id));
  /* 제목 옆 숫자. 곡 페이지의 #song-count 와 같은 자리다. */
  const countEl = document.getElementById('event-count');
  if (countEl) countEl.textContent = upcoming.length || '';
  if (!upcoming.length) {
    parkDetail();
    pollListEl.innerHTML = `<p class="muted empty-msg">등록된 일정이 없습니다.</p>`;
    lastPollsHtml = '';
    return;
  }
  const html = (polls.length ? `<div class="sched-group">날짜 정하는 중</div>` + polls.map((e) => pollEntry(e, pollHead(e))).join('') : '')
    + grouped(fixed, (e) => (e.date || '').slice(0, 7), (e) => (e.date ? monthLabel(e.date) : '날짜 미정'));
  /* 내용이 그대로면 손대지 않는다. 다시 그리면 펼쳐 둔 상세가 뜯긴다. */
  if (html !== lastPollsHtml) {
    parkDetail();
    pollListEl.innerHTML = html;
    lastPollsHtml = html;
  }
  placeDetail();
}

/* ---------- 지난 합주 — 확정일이 지난 일정. 최근 것이 위, 달마다 묶는다 ---------- */
function renderPast() {
  const list = events.filter(isPast).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id));
  pastCardEl.hidden = list.length === 0;
  if (!list.length) { lastPastHtml = ''; return; }
  const html = grouped(list, (e) => e.date.slice(0, 7), (e) => monthLabel(e.date));
  if (html !== lastPastHtml) {
    parkDetail();
    pastListEl.innerHTML = html;
    lastPastHtml = html;
  }
  placeDetail();
}

/* ---------- 일정 추가 ---------- */
/* 만들 수 있는 종류(2026-10-02). 서버(routers/events.py)가 다시 보지만, 안 되는 것은 처음부터 못 하게 한다 —
   다 입력한 뒤에 거절하지 않는다.
     메인 일정   관리자만: 정기합주·정기공연·밴드 행사. 그 밖의 사람은 만들 것이 없어 버튼이 안 보인다.
     길드 안     그 길드 멤버와 관리자: 길드 합주. 멤버 명단은 헤더가 받는 Site.info 에 있다. */
function allowedKinds() {
  const admin = AdminSeen.visible();
  if (Site.slug) {
    const me = Nick.get();
    const member = !!me && ((Site.info && Site.info.members) || []).some((m) => m.nickname === me);
    return admin || member ? ['guild'] : [];
  }
  return admin ? ['regular', 'concert', 'band'] : [];
}
const addPollBtn = document.getElementById('add-poll-btn');
function refreshAddBtn() {
  addPollBtn.hidden = !allowedKinds().length;
  if (addPollBtn.hidden && !addModal.hidden) closeAddModal();
}
['profiles', 'guildinfo', 'nickchange'].forEach((ev) => document.addEventListener(ev, refreshAddBtn));
refreshAddBtn();

function renderKindPick() {
  const allowed = allowedKinds();
  if (!allowed.includes(pickedKind)) pickedKind = allowed[0];
  /* 종류 줄은 늘 보인다. 고를 것이 하나뿐이면 칩 대신 그 종류를 글자로 적는다 — 무엇이 만들어지는지 보여야 한다 */
  const single = allowed.length === 1;
  const fixed = document.getElementById('kind-fixed');
  fixed.hidden = !single;
  if (single) fixed.innerHTML = `${EVENT_KIND[pickedKind]}${pickedKind === 'guild' && Site.info ? ' · ' + guildMark(Site.info, 16) + ' ' + escapeHtml(Site.info.name) : ''}`;
  document.getElementById('add-title').textContent = `＋ ${EVENT_KIND[pickedKind] || '일정'} 후보 만들기`;
  kindPick.querySelectorAll('[data-kind]').forEach((b) => {
    b.hidden = single || !allowed.includes(b.dataset.kind);
    b.setAttribute('aria-pressed', String(b.dataset.kind === pickedKind));
  });
  const union = ['regular', 'concert'].includes(pickedKind);
  guildPick.hidden = !union;
  if (union) {
    guildPick.innerHTML = '<span class="dow-pick-label">참가 길드</span>' + guildList.map((g) =>
      `<button type="button" data-guild="${g.id}" aria-pressed="${pickedGuilds.has(g.id)}" title="${escapeHtml(g.name)}">`
      + `${guildMark(g, 16)} ${escapeHtml(g.name)}</button>`).join('');
  }
}
kindPick.addEventListener('click', (e) => {
  const b = e.target.closest('[data-kind]');
  if (!b) return;
  pickedKind = b.dataset.kind;
  renderKindPick();
});
guildPick.addEventListener('click', (e) => {
  const b = e.target.closest('[data-guild]');
  if (!b) return;
  const id = Number(b.dataset.guild);
  if (pickedGuilds.has(id)) pickedGuilds.delete(id); else pickedGuilds.add(id);
  renderKindPick();
});
async function loadGuildList() {
  if (guildList.length) return;
  try { guildList = (await api.poll('/guilds')).data || []; } catch { guildList = []; }
  Rosters.put(guildList);       /* 용병을 가리는 명단(common.js). 곡 화면과 같은 판정을 쓴다 */
}

function openAddModal() {
  if (!allowedKinds().length) return;
  pickedKind = null;
  pickedGuilds = new Set();
  renderKindPick();
  loadGuildList().then(renderKindPick);
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
    kind: pickedKind,
    guildIds: ['regular', 'concert'].includes(pickedKind) ? [...pickedGuilds] : [],
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
  if (pollEvent.status === 'confirmed') return list;      /* 확정 뒤에는 기록만 본다(참가는 요약의 단추) */
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
    html += `<td class="date-cell"${locked ? '' : ` data-pick-date="${dr.date}"`}>${monthDay(dr.date)} <span class="dow${dow === '일' ? ' sunday' : ''}${dow === '토' ? ' saturday' : ''}">(${dow})</span><span class="date-cnt"><span>${cnt}명</span></span>${isFixed ? '<span class="date-fixed"><span>확정</span></span>' : ''}${locked || !canManage(ev) ? '' : `<button type="button" class="date-off" data-off-date="${dr.date}" title="이 날짜를 후보에서 빼기" aria-label="${monthDay(dr.date)} 후보에서 빼기">×</button>`}</td>`;
    /* 조율 중에는 내 열만 누른다. 확정 뒤에는 보기만 한다 — 참가·나가기는 확정 요약의 단추(2026-10-02).
       전에는 확정일 줄의 남의 칸까지 눌러 넣고 뺄 수 있었다 */
    const canToggle = !locked;
    members.forEach((m) => {
      const on = m.name && ev.avails.some((a) => a.date === dr.date && a.nickname === m.name);
      const editable = canToggle && m.mine;
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
    /* 되돌리기도 다룰 수 있는 사람만. 아니면 뺀 날짜를 글자로만 보여 준다 */
    const can = canManage(ev);
    html += `<p class="dates-off">후보에서 뺀 날짜 ${off.map((dr) => (can
      ? `<button type="button" data-on-date="${dr.date}" title="다시 후보로">${monthDay(dr.date)}
       <i>${countAvail(dr.date)}명</i> ↩</button>`
      : `<span class="date-off-text">${monthDay(dr.date)} <i>${countAvail(dr.date)}명</i></span>`)).join('')}</p>`;
  }
  matrixEl.innerHTML = html;

  if (locked) return;
  const prev = confirmDateEl.value;
  confirmDateEl.innerHTML = dates.map((dr) =>
    `<option value="${dr.date}"${dr.date === bestDay ? ' selected' : ''}>${monthDay(dr.date)} (${DOW[parseDate(dr.date).getDay()]}) · ${countAvail(dr.date)}명</option>`
  ).join('');
  if (prev) confirmDateEl.value = prev;
}

/* ---------- 일정 다루기 권한 ----------
   확정·해제·수정·삭제는 만들 수 있는 사람과 같다(서버 events.can_manage). 안 되는 버튼은 처음부터 안 보인다.
   길드 멤버 여부는 길드 목록(/guilds, 멤버 포함)으로 본다 — 들어올 때 한 번 받는다. */
function canManage(ev) {
  if (!ev) return false;
  if (AdminSeen.visible()) return true;
  if (eventKind(ev) !== 'guild' || !ev.guildId) return false;
  const me = Nick.get();
  const g = guildList.find((x) => x.id === ev.guildId) || (Site.info && Site.info.id === ev.guildId ? Site.info : null);
  return !!me && ((g && g.members) || []).some((m) => m.nickname === me);
}

/* ---------- 정기합주·정기공연 참가 길드 ---------- */
let editingGuilds = null;     /* 고치는 중이면 고른 길드 id 집합 */
function renderPollGuilds() {
  const box = document.getElementById('poll-guilds');
  const ev = pollEvent;
  if (!ev || !isUnion(ev)) { box.hidden = true; box.innerHTML = ''; return; }
  /* 확정 뒤에는 참가 길드가 확정 요약 둘째 줄에 있다. 이 칸은 ⋯ '참가 길드 수정' 으로 편집할 때만 뜬다 */
  if (ev.status === 'confirmed' && !editingGuilds) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  const admin = AdminSeen.visible();
  if (editingGuilds) {
    box.innerHTML = '<div class="dow-pick guild-pick"><span class="dow-pick-label">참가 길드</span>' + guildList.map((g) =>
      `<button type="button" data-edit-guild="${g.id}" aria-pressed="${editingGuilds.has(g.id)}">`
      + `${guildMark(g, 16)} ${escapeHtml(g.name)}</button>`).join('') + '</div>'
      + '<div class="poll-guilds-acts"><button type="button" class="pink" data-save-guilds>저장</button>'
      + '<button type="button" class="ghost" data-cancel-guilds>취소</button></div>';
    return;
  }
  const names = ev.guilds.length
    ? ev.guilds.map((g) => `${guildMark(g, 18)} ${escapeHtml(g.name)}`).join('<span class="meta-sep">·</span>')
    : '<span class="muted">아직 없음</span>';
  box.innerHTML = `<span class="poll-guilds-label">참가 길드</span> ${names}`
    + (admin ? ' <button type="button" class="ghost mini" data-edit-guilds>수정</button>' : '');
}
document.getElementById('poll-guilds').addEventListener('click', async (e) => {
  const ev = pollEvent;
  if (!ev) return;
  if (e.target.closest('[data-edit-guilds]')) {
    await loadGuildList();
    editingGuilds = new Set(ev.guilds.map((g) => g.id));
    renderPollGuilds();
    return;
  }
  const g = e.target.closest('[data-edit-guild]');
  if (g) {
    const id = Number(g.dataset.editGuild);
    if (editingGuilds.has(id)) editingGuilds.delete(id); else editingGuilds.add(id);
    renderPollGuilds();
    return;
  }
  if (e.target.closest('[data-cancel-guilds]')) { editingGuilds = null; renderPollGuilds(); return; }
  const save = e.target.closest('[data-save-guilds]');
  if (save) {
    const ids = [...editingGuilds];
    const saved = await Writes.commit(save, `event:${ev.id}`, async () => {
      const res = await fetch(`/api/admin/events/${ev.id}/guilds`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Nickname': encodeURIComponent(Nick.get()) },
        body: JSON.stringify({ guildIds: ids }),
      });
      if (!res.ok) throw await apiFailure(res);
      return res.json();
    });
    if (!saved) return;
    editingGuilds = null;
    putEvent(saved);
    playableKey = '';          /* 참가 길드가 바뀌면 '그날 프리길드로 보는 곡' 이 바뀐다 */
    renderPolls();
    renderPollView();
  }
});

/* ---------- 확정 요약 ----------
   첫 줄 날짜·시간(사람들이 제일 먼저 찾는 것) / 둘째 줄 장소·종류·참가 길드 / 메모 / 참석자.
   단추는 내 상태에 따라 하나: 참가하기(분홍) 또는 나가기(흐림). 지난 일정에는 없다.
   남을 넣고 빼는 길은 없다(2026-10-02 사용자 결정) — 확정 뒤에는 각자 참가하기·나가기만. */
function amIn(ev) { return !!currentUser && ev.avails.some((a) => a.date === ev.date && a.nickname === currentUser); }

function renderSummary(ev, when) {
  document.getElementById('cs-when').innerHTML = `<b>${escapeHtml(when)}</b>`
    + `<span class="cs-time">${escapeHtml(timeText(ev))}</span>`;
  const kind = eventKind(ev);
  const what = kind === 'guild'
    ? `${EVENT_KIND.guild}${ev.guild ? ' · ' + guildMark(ev.guild, 16, 'cs-gmark') + escapeHtml(ev.guild.name) : ''}`
    : EVENT_KIND[kind] + (ev.guilds || []).map((g) => ` <span class="cs-guild">${guildMark(g, 16, 'cs-gmark')}${escapeHtml(g.name)}</span>`).join('');
  document.getElementById('cs-sub').innerHTML = [ev.place ? escapeHtml(ev.place) : '', what].filter(Boolean)
    .join('<span class="cs-sep">·</span>');
  const note = document.getElementById('cs-note');
  note.hidden = !ev.note;
  note.textContent = ev.note || '';

  const mine = amIn(ev);
  const people = ev.avails.filter((a) => a.date === ev.date).map((a) => a.nickname)
    .sort((x, y) => (x === currentUser ? -1 : y === currentUser ? 1 : x.localeCompare(y, 'ko')));
  confirmedPeople.innerHTML = `<span class="cp-count">참석 <b>${people.length}</b></span>`
    + (people.length
      ? people.map((n) => `<span class="cp-name${n === currentUser ? ' me' : ''}">${escapeHtml(n)}</span>`).join('')
      : '<span class="cp-empty">아직 없음</span>');

  const join = document.getElementById('cs-join');
  join.hidden = isPast(ev);
  join.textContent = mine ? '나가기' : '참가하기';
  join.classList.toggle('pink', !mine);
  join.classList.toggle('ghost', mine);

  const can = canManage(ev);
  document.getElementById('cs-menu-wrap').hidden = !can;
  document.getElementById('cs-guilds-btn').hidden = !(isUnion(ev) && AdminSeen.visible());
  if (!can) closeCsMenu();
}

const csMenu = document.getElementById('cs-menu');
const csMore = document.getElementById('cs-more');
function closeCsMenu() { csMenu.hidden = true; csMore.setAttribute('aria-expanded', 'false'); }
csMore.addEventListener('click', (e) => {
  e.stopPropagation();
  const open = csMenu.hidden;
  csMenu.hidden = !open;
  csMore.setAttribute('aria-expanded', String(open));
});
/* 메뉴 밖을 누르거나 Esc 면 닫는다. 메뉴 안 항목은 각자 할 일을 하고 닫는다 */
document.addEventListener('click', (e) => { if (!csMenu.hidden && !e.target.closest('.cs-menu-wrap')) closeCsMenu(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !csMenu.hidden) { closeCsMenu(); csMore.focus(); } });
csMenu.addEventListener('click', () => closeCsMenu());

document.getElementById('cs-join').addEventListener('click', async () => {
  const ev = pollEvent;
  if (!ev || ev.status !== 'confirmed' || !ev.date) return;
  if (!currentUser) {
    const name = await Nick.ensure();
    if (!name) return;
    currentUser = name;
  }
  setAvail(ev, ev.date, currentUser, !amIn(ev));
});

document.getElementById('cs-guilds-btn').addEventListener('click', async () => {
  const ev = pollEvent;
  if (!ev) return;
  await loadGuildList();
  editingGuilds = new Set(ev.guilds.map((g) => g.id));
  renderPollGuilds();
  document.getElementById('poll-guilds').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
});

function renderPollView() {
  const ev = pollEvent;
  if (!ev) return;
  const locked = ev.status === 'confirmed';
  const f = firstDate(ev), l = lastDate(ev);
  if (locked) {
    const d = ev.date ? parseDate(ev.date) : null;
    const when = d ? `${d.getMonth() + 1}월 ${d.getDate()}일 (${DOW[d.getDay()]})` : '날짜 미정';
    pollMeta.textContent = [when, timeText(ev), ev.place, ev.createdBy].filter(Boolean).join(' · ');
    renderSummary(ev, when);
    pollHintEl.textContent = '확정된 일정의 날짜 투표 기록입니다';
    playableDate = ev.date;
  } else {
    pollMeta.textContent = `후보 ${ev.dates.length}일${f ? ' · ' + monthDay(f) : ''}${l && l !== f ? ' ~ ' + monthDay(l) : ''}${ev.createdBy ? ' · ' + ev.createdBy : ''}`;
    pollHintEl.textContent = '내 열(점선)을 탭해 가능 표시 · 날짜를 탭하면 그날 되는 곡';
    if (!playableDate || !ev.dates.some((dr) => dr.date === playableDate)) playableDate = bestDate(ev);
  }
  const can = canManage(ev);
  confirmBar.hidden = locked || !can;
  confirmedBar.hidden = !locked;
  document.getElementById('poll-delete').hidden = !can;
  /* 확정이면 맨 위는 확정 요약이 맡는다(머리 한 줄은 같은 말이라 숨긴다).
     날짜 투표 기록은 끝난 기록이라 접어서 맨 아래(곡 표 뒤)에 둔다. 조율 중에는 원래 자리(확정 칸 위) */
  pollDetailHead.hidden = locked;
  voteToggle.hidden = !locked;
  voteBox.hidden = locked && !voteOpen;
  voteToggle.setAttribute('aria-expanded', String(locked && voteOpen));
  voteToggle.textContent = voteOpen ? '날짜 투표 기록 접기' : '날짜 투표 기록 보기';
  if (locked) { if (playableSection.nextElementSibling !== voteToggle) playableSection.after(voteToggle, voteBox); }
  else if (confirmBar.previousElementSibling !== voteBox) confirmBar.before(voteToggle, voteBox);
  if (!can || !locked) document.getElementById('event-edit').hidden = true;
  /* 밴드 행사는 날짜 투표만 한다. 가능 곡·셋리스트가 없다 */
  const band = eventKind(ev) === 'band';
  playableSection.hidden = !playableDate || band;
  renderPollGuilds();
  renderMatrix();
  renderPsDates();
  syncPlayable();
}

/* ---------- 날짜별 가능 곡 ---------- */
function renderPsDates() {
  const ev = pollEvent;
  if (ev.status === 'confirmed') {
    psDatesEl.innerHTML = '';
    psTitleEl.textContent = '셋리스트';
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

/* 곡 옆 소속 표시(셋리스트·가능 곡 같이 씀). 알약 배지 대신, 정보가 있을 때만 작은 문장(2026-10-02).
   길드 합주는 곡이 거의 다 그 길드 것이라 줄마다 같은 배지가 붙어 아무 말도 안 했다.
     길드 합주          그 길드 곡은 없음. '전체' 범위에서 섞인 다른 길드 곡은 문장, 프리길드 곡은 '프리길드'
     정기합주·정기공연  참가 길드 곡은 문장. 그날 프리길드로 보는 곡(참가 안 한 길드)·프리길드 곡은 '프리길드'
   셋리스트 자료에는 asFree 가 없어서 참가 길드 목록으로 같은 규칙을 여기서 센다(서버 _playable 과 같음). */
/* 이 일정에서 이 곡의 용병인가 — 곡의 길드 명단에 없는 사람(common.js Rosters.isMerc, 곡 화면과 같은 판정).
   정기합주·정기공연 안에서도 용병으로 보인다(사용자 결정). 다만 그날 프리길드로 보는 곡과 프리길드 곡에는 용병이 없다. */
function isMercHere(s, nick) {
  if (!s || !s.guild || !pollEvent) return false;
  if (isUnion(pollEvent)) {
    const free = s.asFree ?? !(pollEvent.guilds || []).some((g) => g.id === s.guild.id);
    if (free) return false;
  }
  return Rosters.isMerc(s, nick);
}

function songTag(s) {
  const ev = pollEvent;
  if (!ev) return '';
  if (isUnion(ev)) {
    const free = s.asFree ?? (!!s.guild && !(ev.guilds || []).some((g) => g.id === s.guild.id));
    if (free || !s.guild) return ` <span class="ps-free">${FREE_GUILD}</span>`;
    return ' ' + guildMark(s.guild, 16, 'song-tag-mark');
  }
  if (!s.guild) return ` <span class="ps-free">${FREE_GUILD}</span>`;   /* 그 길드 곡과 구별되게 */
  if (s.guild.id !== ev.guildId) return ' ' + guildMark(s.guild, 16, 'song-tag-mark');
  return '';
}

function renderPlayable() {
  if (!playable) { showLoading(playableListEl); return; }
  const all = playable.songs;
  const ev = pollEvent;
  const locked = ev.status === 'confirmed';
  /* 길드 일정이면 범위 칩을 세운다. 길드 곡만 / 전체. 정기합주·정기공연은 길드연합이라 범위 칩이 없다 —
     참가 길드 곡 + 프리길드 곡이고, 참가하지 않은 길드의 곡은 그날 프리길드로 보인다(서버 asFree). */
  const union = isUnion(ev);
  const g = union ? null : ev.guild;
  psScopeEl.hidden = !g;
  psScopeEl.querySelectorAll('[data-scope]').forEach((b) => {
    const on = b.dataset.scope === playableScope;
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-pressed', on);
  });
  /* 확정 뒤에는 표 위쪽이 셋리스트다. 셋리스트 곡은 범위·검색·'3개 이상' 과 상관없이 늘 위에 선다 */
  const setIds = locked ? new Set(ev.songs.map((x) => x.songId)) : new Set();
  const rest = all.filter((s) => !setIds.has(s.songId));
  const scoped = g && playableScope === 'guild' ? rest.filter((s) => s.guildId === g.id) : rest;
  /* 검색 중에는 '3개 이상만' 을 무시한다 — 찾는 곡은 충족이 낮아도 보여야 셋리스트에 넣는다 */
  const pool = psQuery ? scoped.filter((s) => psMatch(s, psQuery)) : scoped;
  /* 참석자가 없으면 충족도가 전부 0 이다. 조율 중이면 볼 것이 없지만, 확정 뒤에는 셋리스트를
     먼저 짜야 할 수 있다 — 그래서 확정된 일정이면 곡 전체를 ＋ 와 함께 보여 준다(쿠로 제보, 2026-09-16). */
  const nobody = !playable.attendees.length;
  if (nobody && !locked) {
    playableListEl.innerHTML = `<p class="muted empty-msg">이 날짜에 가능한 사람이 아직 없습니다.</p>`;
    playableStageEl.innerHTML = '';
    psToggleBtn.hidden = true;
    return;
  }
  const shown = playableAll || nobody || psQuery ? pool : pool.filter((s) => s.filled >= MIN_FILLED);
  const hidden = pool.length - shown.length;
  psToggleBtn.hidden = nobody || !!psQuery || (playableAll ? pool.length === 0 : hidden <= 0);
  psToggleBtn.textContent = playableAll ? `${MIN_FILLED}개 이상만 보기` : `전체 보기 (+${hidden}곡)`;

  const what = g && playableScope === 'guild' ? '이 길드 곡 중 ' : '';
  const emptyMsg = psQuery ? `'${escapeHtml(psQuery)}' 에 맞는 곡이 없습니다.`
    : nobody ? `${what}곡이 없습니다.` : `${what}${MIN_FILLED}개 세션 이상 채워지는 곡이 없습니다.`;
  if (!locked && !shown.length) {
    playableListEl.innerHTML = `<p class="muted empty-msg">${emptyMsg}</p>`;
    playableStageEl.innerHTML = '';
    return;
  }

  /* 셋리스트 줄의 자료. 되는 곡 표에 없는 곡(켜 둔 파트가 없는 곡)도 제목만으로 선다 */
  const setRows = locked ? ev.songs.map((item) => {
    const p = all.find((x) => x.songId === item.songId);
    return p ? { ...p, skips: item.skips || [] }
      : { songId: item.songId, title: item.title, artist: item.artist, guild: item.guild, roles: [], skips: item.skips || [] };
  }) : [];

  /* 무대에 올릴 곡. 아무것도 안 고른 상태면 맨 위 곡(셋리스트 첫 곡, 없으면 되는 곡 첫 줄)이 서 있다 */
  const visible = [...setRows, ...shown];
  if (!visible.some((x) => x.songId === stageSongId)) stageSongId = visible.length ? visible[0].songId : null;

  const cols = roleColumns(all);
  const span = cols.length + 2 + (locked ? 2 : 0);
  let html = `<table class="ps-table${locked ? ' has-setlist' : ''}"><thead><tr>`;
  html += `<th class="ps-score-head">${locked ? '' : '충족'}</th><th class="ps-song-head">곡</th>`;
  cols.forEach((r) => {
    const short = ROLE_SHORT[r] || r;
    html += `<th class="ps-role-head" title="${escapeHtml(r)}">` +
      `<span class="ps-role-short">${escapeHtml(short)}</span>` +
      `<span class="ps-role-full">${escapeHtml(r)}</span></th>`;
  });
  /* 확정 후에만 서는 대기실 열과 ✓·＋ 열. 파트 칸과 폭이 달라서 클래스를 나눈다 —
     table-layout:fixed 가 첫 줄에 적힌 폭만 보기 때문이다. */
  if (locked) html += `<th class="ps-bench-head">대기실</th><th class="ps-act-head"></th>`;
  html += `</tr></thead><tbody>`;

  const songCell = (s) => `<td class="ps-song" title="${escapeHtml(s.title)}${s.artist ? ' · ' + escapeHtml(s.artist) : ''}">` +
    `<div class="ps-song-title">${escapeHtml(s.title)}</div>` +
    `<div class="ps-song-sub">${escapeHtml(s.artist || '')}${songTag(s)}</div></td>`;
  const stageRow = (s) => (s.songId === stageSongId && s.roles.length
    ? `<tr class="ps-stage-row"><td colspan="${span}">${stageBlock(stageSong(s.songId) || s)}</td></tr>` : '');

  if (locked) {
    /* 셋리스트 — 사람은 이름으로 쓴다(정해진 사람은 읽어야 한다). 좁은 화면에서는 칸이 좁아 얼굴 칩만.
       이름을 누르면 같은 줄 대기실로, 대기실 이름을 누르면 원래 파트로 */
    const me = Nick.get();
    const person = (s, role, n, bench) => {
      const merc = isMercHere(s, n);
      const tip = `${n} · ${bench ? `${role}로 돌리기` : '대기실로'}${merc ? ' · 용병' : ''}`;
      return `<button type="button" class="sl-name${n === me ? ' me' : ''}${merc ? ' merc' : ''}"`
        + ` data-skip-song="${s.songId}" data-skip-role="${escapeHtml(role)}" data-skip-nick="${escapeHtml(n)}"`
        + ` data-skip-on="${bench ? '0' : '1'}" title="${escapeHtml(tip)}">`
        + `${avatarChip(n)}<span class="sl-pname">${escapeHtml(n)}</span></button>`;
    };
    html += `<tr class="ps-group"><td colspan="${span}">셋리스트 <b>${setRows.length}</b>곡</td></tr>`;
    if (!setRows.length) {
      html += `<tr class="ps-empty"><td colspan="${span}">아직 곡이 없습니다. 아래 곡의 ＋ 를 누르면 여기로 올라옵니다.</td></tr>`;
    }
    setRows.forEach((s, i) => {
      const benched = (role, n) => s.skips.some((k) => k.role === role && k.nickname === n);
      const byRole = {};
      s.roles.forEach((r) => { byRole[r.role] = r; });
      const bench = [];
      s.roles.forEach((r) => r.members.forEach((n) => { if (benched(r.role, n)) bench.push([r.role, n]); }));
      html += `<tr class="ps-row sl-row${s.songId === stageSongId ? ' is-stage' : ''}" data-song="${s.songId}">`
        + `<td class="ps-score"><span class="sl-no"><span>${i + 1}</span></span></td>` + songCell(s);
      cols.forEach((role) => {
        const r = byRole[role];
        const playing = r ? r.members.filter((n) => !benched(role, n)) : [];
        html += `<td class="ps-cell sl-cell">${playing.map((n) => person(s, role, n, false)).join('')}</td>`;
      });
      html += `<td class="ps-cell sl-bench">${bench.map(([role, n]) => person(s, role, n, true)).join('')}</td>`
        + `<td class="ps-cell act"><button type="button" class="ps-add is-on" data-set-song="${s.songId}" title="셋리스트에서 빼기">✓</button></td></tr>`;
      html += stageRow(s);
    });
    html += `<tr class="ps-group"><td colspan="${span}">더 넣을 수 있는 곡 <span>이 인원으로 되는 곡</span></td></tr>`;
    if (!shown.length) html += `<tr class="ps-empty"><td colspan="${span}">${emptyMsg}</td></tr>`;
  }

  let lastFilled = null;
  shown.forEach((s) => {
    const byRole = {};
    s.roles.forEach((r) => { byRole[r.role] = r; });
    const ratio = s.needed ? s.filled / s.needed : 0;
    const tier = ratio >= 1 ? 'full' : ratio >= 0.66 ? 'good' : ratio >= 0.5 ? 'half' : 'low';
    const gap = lastFilled !== null && lastFilled !== s.filled ? ' ps-gap' : '';
    lastFilled = s.filled;
    html += `<tr class="ps-row ${tier}${gap}${s.songId === stageSongId ? ' is-stage' : ''}" data-song="${s.songId}">`;
    const pct = s.needed ? (s.filled / s.needed) * 100 : 0;
    html += `<td class="ps-score"><strong>${s.filled}</strong><span>/${s.needed}</span>` +
      `<span class="skew-gauge${s.filled === s.needed ? ' full' : ''}">` +
      `<i style="width:${pct}%"></i></span></td>` + songCell(s);
    cols.forEach((role) => {
      const r = byRole[role];
      if (!r) { html += `<td class="ps-cell none"></td>`; return; }
      if (!r.ok) { html += `<td class="ps-cell off"><span class="ps-hole"></span></td>`; return; }
      // 중복지원이면 칩이 그만큼 늘어난다. 열을 넓히면 그만큼 다른 파트가 화면 밖으로
      // 나가므로, 몇 명인지만 알려 주고 겹침은 CSS 가 깊게 준다(무대의 data-n 과 같은 방법).
      html += `<td class="ps-cell on"><span class="ps-chips" data-n="${r.members.length}">` +
        r.members.map((n) => (isMercHere(s, n)
          ? `<span class="ps-merc" title="${escapeHtml(n)} · 용병">${avatarChip(n)}</span>` : avatarChip(n))).join('') + `</span></td>`;
    });
    if (locked) {
      html += `<td class="ps-cell sl-bench is-blank"></td>`
        + `<td class="ps-cell act"><button type="button" class="ps-add" data-set-song="${s.songId}" title="셋리스트에 넣기">＋</button></td>`;
    }
    html += `</tr>`;
    /* 좁은 화면에서는 고른 줄 바로 아래에 무대가 펼쳐진다. 넓으면 CSS 가 이 줄을 숨기고
       표 옆의 고정 자리를 쓴다. 같은 내용이라 둘 중 하나만 보인다. */
    html += stageRow(s);
  });
  html += `</tbody></table>`;
  playableListEl.innerHTML = html;
  renderStage();
}

/* 무대 한 판. 머리글이 곧 접기 단추다 — 곡 이름과 충족 수가 이미 거기 있어서
   접기만 따로 둘 자리를 새로 만들 이유가 없다(§9.2). 접으면 이 한 줄만 남는다. */
/* 무대에 올릴 곡 자료. 셋리스트 곡이면 대기실 사람을 빼고 세우고(그날 실제로 치는 사람), 빠진 사람은 bench 로.
   충족 수도 그 기준으로 다시 센다 — 대기실로 보내 파트가 비면 무대에서도 빈 자리로 보인다(2026-10-03).
   아직 셋리스트에 없는 곡은 지원했고 오는 사람 그대로다. */
function stageSong(id) {
  const p = playable && playable.songs.find((x) => x.songId === id);
  if (!p) return null;
  const item = pollEvent && pollEvent.status === 'confirmed' ? pollEvent.songs.find((x) => x.songId === id) : null;
  const skips = item ? item.skips || [] : [];
  if (!skips.length) return p;
  const bench = [];
  const roles = p.roles.map((r) => {
    const members = r.members.filter((n) => {
      const out = skips.some((k) => k.role === r.role && k.nickname === n);
      if (out && !bench.includes(n)) bench.push(n);
      return !out;
    });
    return { ...r, members, ok: members.length > 0 };
  });
  return { ...p, roles, filled: roles.filter((r) => r.ok).length, bench };
}

function stageBlock(s) {
  return `<button type="button" class="ps-stage-head" data-stage-fold aria-expanded="${stageOpen}">`
    + `<b>${escapeHtml(s.title)}</b>`
    + `<span class="ps-stage-fill">${s.filled}<i>/${s.needed}</i></span>`
    + `<span class="ps-stage-caret">${stageOpen ? '접기 ▴' : '펼치기 ▾'}</span>`
    + `</button>`
    + (stageOpen ? stageHtml(s.roles, s.bench) : '');
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
  const s = stageSongId ? stageSong(stageSongId) : null;
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
  const sk = e.target.closest('[data-skip-song]');
  if (sk && pollEvent) {
    setSkip(pollEvent, Number(sk.dataset.skipSong), sk.dataset.skipRole, sk.dataset.skipNick, sk.dataset.skipOn === '1');
    return;
  }
  const btn = e.target.closest('[data-set-song]');
  if (!btn) {
    /* 줄을 누르면 그 곡이 무대에 오른다 */
    const row = e.target.closest('.ps-row[data-song]');
    if (row) { stageSongId = Number(row.dataset.song); renderPlayable(); }
    return;
  }
  if (!pollEvent) return;
  toggleSetSong(pollEvent, Number(btn.dataset.setSong));
});

/* 셋리스트에 곡 넣기·빼기. 켜고 끄는 동작이라 누르는 즉시 바꾼다(Writes.run).
   전에는 서버가 셋리스트를 저장하고 라인업을 채울 때까지 기다려 3초쯤 걸렸다.
   새로 넣은 곡의 라인업은 서버와 같은 규칙('그날 참석자 ∩ 지원자')으로 미리 채운다 —
   되는 곡 표(playable)가 그 값을 이미 갖고 있다. 저장이 다 끝나면 writes-idle 이 서버 상태로 맞추고,
   실패하면 폴링 버전을 잊어 그때 서버의 실제 상태로 돌아간다. */
async function toggleSetSong(ev, id) {
  const cur = ev.songs.find((x) => x.songId === id);
  if (cur) {
    /* 곡 빼기는 한 번 묻는다. 대기실과 달리 되돌리려면 표에서 곡을 다시 찾아 넣어야 한다.
       그 곡의 대기실 기록은 서버가 같이 지운다 */
    const ok = await confirmModal({
      title: `'${cur.title}' 빼기`,
      body: '셋리스트에서 뺍니다.',
      confirm: '빼기', danger: true,
    });
    if (!ok || !ev.songs.some((x) => x.songId === id)) return;
    ev.songs = ev.songs.filter((x) => x.songId !== id);
  } else {
    const p = playable && playable.songs.find((x) => x.songId === id);
    ev.songs = [...ev.songs, {
      songId: id, order: ev.songs.length, note: null,
      title: p ? p.title : '', artist: p ? p.artist : '', guild: p ? p.guild : null, skips: [],
    }];
  }
  renderPlayable();
  const songIds = ev.songs.map((x) => x.songId);
  Writes.run(`setlist:${ev.id}`, () => api.put(`/events/${ev.id}/songs`, { songIds }))
    .catch((err) => { api.forgetPolls(); alert(err.message); });
}

/* ---------- 셋리스트 ----------
   셋리스트는 되는 곡 표의 위쪽이다(2026-10-02). 곡마다 이름은 '그 곡 지원자 중 그날 참석자' 이고
   손으로 넣지 않는다 — 땜빵은 그 사람이 곡에 지원한다. 한 파트에 여럿이면 안 치는 사람을 대기실로 보낸다. */

/* 대기실로 보내기·되돌리기. 누르는 즉시 바꾸고 서버에 보낸다(common.js Writes) — 켜고 끄는 동작이라 묻지 않는다.
   셋리스트와 같은 줄에 세운다. 방금 넣은 곡이 저장되기 전에 가면 서버가 '셋리스트에 없는 곡' 으로 거절한다. */
function setSkip(ev, songId, role, nickname, on) {
  const item = ev.songs.find((x) => x.songId === songId);
  if (!item) return;
  item.skips = (item.skips || []).filter((k) => !(k.role === role && k.nickname === nickname));
  if (on) item.skips.push({ role, nickname });
  renderPlayable();
  Writes.run(`setlist:${ev.id}`,
    () => api.post(`/events/${ev.id}/songs/${songId}/skip`, { role, nickname, on }))
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
  editingGuilds = null;
  voteOpen = false;
  psQuery = '';
  psSearchEl.value = '';
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
voteToggle.addEventListener('click', () => { voteOpen = !voteOpen; renderPollView(); });
psSearchEl.addEventListener('input', () => {
  psQuery = psSearchEl.value.trim().toLowerCase();
  if (playable) renderPlayable();
});

/* 삭제는 머리(투표 중)와 확정 요약(확정) 두 자리에 있다. 하는 일은 같다 */
async function deleteEvent(btn) {
  if (!pollEvent) return;
  if (!confirm(`${pollEvent.title} 일정을 삭제할까요?`)) return;
  const id = pollEvent.id;
  const ok = await Writes.commit(btn, `event:${id}`,
    () => api.del(`/events/${id}?nickname=${encodeURIComponent(Nick.get())}`).then(() => true));
  if (!ok) return;
  closePoll();
  events = events.filter((x) => x.id !== id);   /* 목록 전체를 다시 받지 않고 바로 뺀다 */
  renderPolls();
  renderPast();
}
['poll-delete', 'confirmed-delete'].forEach((bid) => {
  const b = document.getElementById(bid);
  b.addEventListener('click', () => deleteEvent(b));
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
    /* 켜고 끄는 동작이라 누르는 즉시 바꾼다(Writes.run). 서버에는 '이 상태로' 를 보낸다 —
       뒤집기로 보내면 같은 요청이 두 번 갈 때 원래대로 돌아간다. 실패하면 writes-idle 이 서버 상태로 되돌린다. */
    const ev = pollEvent;
    const dr = ev.dates.find((x) => x.date === day);
    if (!dr) return;
    const active = !!onBtn;
    dr.active = active;
    playableKey = '';
    renderPollView();
    Writes.run(`date:${ev.id}:${day}`, () => api.post(`/events/${ev.id}/dates/${day}/toggle`, { active, nickname: Nick.get() }))
      .catch((err) => { api.forgetPolls(); alert(err.message); });
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
  /* 누를 수 있는 칸은 내 열뿐이다(renderMatrix). 닉네임이 없으면 먼저 묻는다 */
  if (!currentUser) {
    const name = await Nick.ensure();
    if (!name) return;
    currentUser = name;
  }
  setAvail(pollEvent, td.dataset.toggle, currentUser, !on);
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
    () => api.post(`/events/${pollEvent.id}/confirm`, { date: day, startTime: start, endTime: end, place, nickname: Nick.get() }));
  if (!ev) return;
  putEvent(ev);          /* 돌려받은 일정으로 바로 그린다 */
  renderPolls();
  renderPast();
  renderPollView();
});

unconfirmBtn.addEventListener('click', async () => {
  if (!pollEvent) return;
  if (!confirm(`${pollEvent.title} 확정을 해제하고 다시 조율할까요?`)) return;
  const ev = await Writes.commit(unconfirmBtn, `event:${pollEvent.id}`,
    () => api.post(`/events/${pollEvent.id}/unconfirm`, { nickname: Nick.get() }));
  if (!ev) return;
  putEvent(ev);          /* 돌려받은 일정으로 바로 그린다 */
  renderPolls();
  renderPast();
  renderPollView();
});

/* ---------- 확정 일정 정보 고치기 ---------- */
const editForm = document.getElementById('event-edit');
document.getElementById('edit-event-btn').addEventListener('click', () => {
  const ev = pollEvent;
  if (!ev) return;
  document.getElementById('ee-title').value = ev.title || '';
  document.getElementById('ee-start').value = ev.startTime || '';
  document.getElementById('ee-end').value = ev.endTime || '';
  document.getElementById('ee-place').value = ev.place || '';
  document.getElementById('ee-note').value = ev.note || '';
  editForm.hidden = false;
  document.getElementById('ee-title').focus();
});
document.getElementById('ee-cancel').addEventListener('click', () => { editForm.hidden = true; });
editForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const ev = pollEvent;
  if (!ev) return;
  const title = document.getElementById('ee-title').value.trim();
  if (!title) { document.getElementById('ee-title').focus(); return; }
  const saved = await Writes.commit(document.getElementById('ee-save'), `event:${ev.id}`,
    () => api.put(`/events/${ev.id}`, {
      nickname: Nick.get(),
      title,
      startTime: document.getElementById('ee-start').value || null,
      endTime: document.getElementById('ee-end').value || null,
      place: document.getElementById('ee-place').value.trim() || null,
      note: document.getElementById('ee-note').value.trim() || null,
    }));
  if (!saved) return;
  editForm.hidden = true;
  putEvent(saved);
  renderPolls();
  renderPast();
  renderPollView();
});
/* 길드 멤버 여부(수정·확정 버튼)를 가리려고 길드 목록을 받아 둔다. 늦게 오면 펼친 일정을 다시 그린다 */
loadGuildList().then(() => { if (pollEvent) renderPollView(); });
['profiles', 'guildinfo', 'nickchange'].forEach((n) => document.addEventListener(n, () => { if (pollEvent) renderPollView(); }));

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
