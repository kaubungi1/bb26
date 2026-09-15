/* 일정 */
let events = [];
let currentUser = Nick.get();
let calDate = new Date();
calDate.setDate(1);
let selectedDate = null;
let pollEvent = null;
let weekendOnly = false;

const calEl = document.getElementById('calendar');
const calTitle = document.getElementById('cal-title');
const pollListEl = document.getElementById('poll-list');
const dayCardEl = document.getElementById('day-card');
const dayListEl = document.getElementById('day-list');
const dayTitleEl = document.getElementById('day-title');

const addModal = document.getElementById('add-modal');
const addForm = document.getElementById('add-form');
const inTitle = document.getElementById('in-title');
const inFrom = document.getElementById('in-from');
const inTo = document.getElementById('in-to');
const inNote = document.getElementById('in-note');

const pollView = document.getElementById('poll-view');
const pollTitle = document.getElementById('poll-title');
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
const psToggleBtn = document.getElementById('ps-toggle');
const NICK_MAX = 20;

/* 세션 지원이 채워지면 이 값을 올리면 된다 */
const MIN_FILLED = 3;
/* ROLE_ORDER · ROLE_SHORT 는 common.js 에서 정의한다. 여기서 다시 선언하면
   같은 전역 스코프라 SyntaxError 가 나고 이 파일 전체가 죽는다.
   곡마다 열 위치를 고정해야 세로로 훑어보기 좋다. */

let playable = null;
let playableKey = '';
let playableAll = false;
const pollHintEl = document.getElementById('poll-hint');

const DOW = ['일', '월', '화', '수', '목', '금', '토'];

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

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

async function refresh() {
  if (events.length === 0 && pollListEl.innerHTML.trim() === '') showLoading(pollListEl);
  try {
    events = await api.get('/events');
  } catch (err) {
    console.error('일정 로드 실패:', err);
  }
  renderCalendar();
  renderPolls();
  renderDayCard();
  if (pollView.hidden === false) {
    const found = events.find((e) => e.id === (pollEvent && pollEvent.id));
    if (found) {
      pollEvent = found;
      renderPollView();
    } else {
      closePoll();
    }
  }
}

/* ---------- 달력 ---------- */
function renderCalendar() {
  const year = calDate.getFullYear();
  const month = calDate.getMonth();
  calTitle.textContent = `${year}년 ${month + 1}월`;
  const startDow = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const t = todayStr();

  const polls = events.filter((e) => e.status === 'poll');
  const confirmed = events.filter((e) => e.status === 'confirmed');

  let html = DOW.map((d, i) =>
    `<div class="cal-week${i === 0 ? ' sunday' : ''}${i === 6 ? ' saturday' : ''}">${d}</div>`
  ).join('');
  for (let i = 0; i < startDow; i++) html += `<div class="cal-cell empty"></div>`;
  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = `${year}-${pad(month + 1)}-${pad(day)}`;
    const dow = new Date(year, month, day).getDay();
    const cls = ['cal-cell'];
    if (dateStr === t) cls.push('today');
    if (dateStr < t) cls.push('past');
    if (dateStr === selectedDate) cls.push('selected');
    if (dow === 0) cls.push('sunday');

    const confirmedHere = confirmed.filter((e) => e.date === dateStr);
    const pollsHere = polls.filter((e) => e.dates.some((dr) => dr.date === dateStr));
    if (pollsHere.length) cls.push('in-range');

    let bars = '';
    confirmedHere.slice(0, 2).forEach((e) => {
      bars += `<div class="cal-event confirmed" title="${escapeHtml(e.title)}"><span class="cal-event-icon">${icon('check', 10)}</span><span class="cal-event-text">${escapeHtml(e.title)}</span></div>`;
    });
    if (confirmedHere.length > 2) bars += `<div class="cal-event-more">+${confirmedHere.length - 2}</div>`;

    const pollStarts = polls.filter((e) => dateStr === firstDate(e));
    pollStarts.slice(0, 2).forEach((e) => {
      bars += `<div class="cal-event polling" title="${escapeHtml(e.title)}"><span class="cal-event-icon">${icon('clock', 10)}</span><span class="cal-event-text">${escapeHtml(e.title)}</span></div>`;
    });
    if (pollStarts.length > 2) bars += `<div class="cal-event-more">+${pollStarts.length - 2}</div>`;

    const cellEvents = [...confirmedHere, ...pollsHere];
    const openPoll = cellEvents.length === 1
      ? ` data-open-poll="${cellEvents[0].id}"`
      : '';

    html += `<div class="${cls.join(' ')}" data-date="${dateStr}"${openPoll}>` +
      `<span class="cal-day-num"><span>${day}</span></span>` +
      `<div class="cal-events">${bars}</div></div>`;
  }
  const leftover = (startDow + daysInMonth) % 7;
  const trailing = leftover === 0 ? 0 : 7 - leftover;
  for (let i = 0; i < trailing; i++) html += `<div class="cal-cell empty"></div>`;
  calEl.innerHTML = html;
}

calEl.addEventListener('click', (e) => {
  const cell = e.target.closest('.cal-cell[data-date]');
  if (!cell) return;
  if (cell.dataset.openPoll) {
    openPoll(Number(cell.dataset.openPoll));
    return;
  }
  selectedDate = cell.dataset.date;
  renderCalendar();
  renderDayCard();
});

document.getElementById('prev-month').addEventListener('click', () => {
  calDate.setMonth(calDate.getMonth() - 1);
  renderCalendar();
});
document.getElementById('next-month').addEventListener('click', () => {
  calDate.setMonth(calDate.getMonth() + 1);
  renderCalendar();
});
document.getElementById('today-btn').addEventListener('click', () => {
  calDate = new Date();
  calDate.setDate(1);
  selectedDate = todayStr();
  renderCalendar();
  renderDayCard();
});

/* ---------- 조율 중 목록 ---------- */
function firstDate(ev) { return ev.dates.length ? ev.dates[0].date : null; }
function lastDate(ev) { return ev.dates.length ? ev.dates[ev.dates.length - 1].date : null; }

function renderPolls() {
  const sortKey = (e) => (e.status === 'confirmed' ? e.date : firstDate(e)) || '9999';
  const list = [...events].sort((a, b) => {
    if (a.status !== b.status) return a.status === 'poll' ? -1 : 1;
    const ka = sortKey(a), kb = sortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : b.id - a.id;
  });
  if (!list.length) {
    pollListEl.innerHTML = `<p class="muted empty-msg">등록된 일정이 없습니다.</p>`;
    return;
  }
  pollListEl.innerHTML = list.map((e) => {
    if (e.status === 'confirmed') {
      const cnt = e.avails.filter((a) => a.date === e.date).length;
      const time = e.startTime ? `${e.startTime}${e.endTime ? ' ~ ' + e.endTime : ''}` : '시간 미정';
      const meta = [e.date ? monthDay(e.date) + ' (' + DOW[parseDate(e.date).getDay()] + ')' : '', time, e.place]
        .filter(Boolean).map(escapeHtml).join(' · ');
      return `
      <div class="poll-item" data-open-poll="${e.id}">
        <span class="poll-item-badge confirmed"><span>확정</span></span>
        <div class="poll-item-info">
          <div class="poll-item-title">${escapeHtml(e.title)}</div>
          <div class="poll-item-meta">${meta}</div>
        </div>
        <span class="poll-item-count">참석 ${cnt}명</span>
      </div>`;
    }
    const f = firstDate(e), l = lastDate(e);
    const best = Math.max(0, ...e.dates.map((dr) => e.avails.filter((a) => a.date === dr.date).length));
    return `
      <div class="poll-item" data-open-poll="${e.id}">
        <span class="poll-item-badge"><span>조율중</span></span>
        <div class="poll-item-info">
          <div class="poll-item-title">${escapeHtml(e.title)}</div>
          <div class="poll-item-meta">${f ? monthDay(f) : ''}${l && l !== f ? ' ~ ' + monthDay(l) : ''} · ${e.dates.length}일${e.createdBy ? ' · ' + escapeHtml(e.createdBy) : ''}</div>
        </div>
        <span class="poll-item-count${best > 0 ? ' max' : ''}">최다 ${best}명</span>
      </div>`;
  }).join('');
}

/* ---------- 선택 날짜 상세 ---------- */
function renderDayCard() {
  if (!selectedDate) { dayCardEl.hidden = true; return; }
  dayCardEl.hidden = false;
  const d = parseDate(selectedDate);
  dayTitleEl.textContent = `${d.getMonth() + 1}월 ${d.getDate()}일 (${DOW[d.getDay()]})`;

  const confirmed = events.filter((e) => e.status === 'confirmed' && e.date === selectedDate);
  const polling = events.filter((e) => e.status === 'poll' && e.dates.some((dr) => dr.date === selectedDate));
  if (!confirmed.length && !polling.length) {
    dayListEl.innerHTML = `<p class="muted day-empty">이 날짜의 일정이 없습니다.</p>`;
    return;
  }
  const parts = [];
  confirmed.forEach((e) => {
    const time = e.startTime ? `${e.startTime}${e.endTime ? ' ~ ' + e.endTime : ''}` : '시간 미정';
    const cnt = e.avails.filter((a) => a.date === e.date).length;
    const sub = [time, e.place, e.note, e.createdBy].filter(Boolean).map(escapeHtml).join(' · ');
    parts.push(`
      <div class="day-item" data-open-poll="${e.id}">
        <div class="day-item-head">
          <div>
            <div class="day-item-title">${icon('check', 14)} ${escapeHtml(e.title)}</div>
            <div class="day-item-sub">${sub}</div>
            <div class="day-item-sub">참석 ${cnt}명 · 탭해서 인원 수정</div>
          </div>
          <button type="button" class="ghost" data-del-event="${e.id}">삭제</button>
        </div>
      </div>`);
  });
  polling.forEach((e) => {
    const cnt = e.avails.filter((a) => a.date === selectedDate).length;
    parts.push(`
      <div class="day-item" data-open-poll="${e.id}">
        <div class="day-item-head">
          <div>
            <div class="day-item-title">${icon('clock', 14)} ${escapeHtml(e.title)}</div>
            <div class="day-item-sub">조율중 · 이 날짜 체크 ${cnt}명 · 탭해서 확인</div>
          </div>
        </div>
      </div>`);
  });
  dayListEl.innerHTML = parts.join('');
}

/* ---------- 일정 추가 ---------- */
function openAddModal() {
  const t = new Date();
  inFrom.value = selectedDate || toDateStr(t);
  const to = selectedDate ? parseDate(selectedDate) : t;
  to.setDate(to.getDate() + 6);
  inTo.value = toDateStr(to);
  addModal.hidden = false;
  setTimeout(() => inTitle.focus(), 0);
}

function closeAddModal() { addModal.hidden = true; }

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
  await api.post('/events', {
    title,
    note: inNote.value.trim() || null,
    createdBy: name,
    dateFrom: from,
    dateTo: to,
  });
  inTitle.value = '';
  inNote.value = '';
  closeAddModal();
  await refresh();
});

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

function renderMatrix() {
  const ev = pollEvent;
  const locked = ev.status === 'confirmed';
  const dates = ev.dates
    .filter((dr) => !weekendOnly || isWeekend(dr.date) || (locked && dr.date === ev.date))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  const members = matrixMembers();
  const t = todayStr();
  const counts = dates.map((dr) => countAvail(dr.date));
  const best = counts.length ? Math.max(...counts) : 0;
  const bestDate = dates.find((dr, i) => counts[i] === best)?.date;

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
    html += `<tr class="${cls.join(' ')}">`;
    html += `<td class="date-cell">${monthDay(dr.date)} <span class="dow${dow === '일' ? ' sunday' : ''}${dow === '토' ? ' saturday' : ''}">(${dow})</span><span class="date-cnt"><span>${cnt}명</span></span>${isFixed ? '<span class="date-fixed"><span>확정</span></span>' : ''}</td>`;
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
  matrixEl.innerHTML = html;

  if (locked) return;
  const prev = confirmDateEl.value;
  confirmDateEl.innerHTML = dates.map((dr) =>
    `<option value="${dr.date}"${dr.date === bestDate ? ' selected' : ''}>${monthDay(dr.date)} (${DOW[parseDate(dr.date).getDay()]}) · ${countAvail(dr.date)}명</option>`
  ).join('');
  if (prev) confirmDateEl.value = prev;
}

function renderPollView() {
  const ev = pollEvent;
  if (!ev) return;
  const locked = ev.status === 'confirmed';
  pollTitle.textContent = ev.title;
  const f = firstDate(ev), l = lastDate(ev);
  if (locked) {
    const d = ev.date ? parseDate(ev.date) : null;
    const when = d ? `${d.getMonth() + 1}월 ${d.getDate()}일 (${DOW[d.getDay()]})` : '날짜 미정';
    const time = ev.startTime ? `${ev.startTime}${ev.endTime ? ' ~ ' + ev.endTime : ''}` : '시간 미정';
    pollMeta.textContent = [when, time, ev.place, ev.createdBy].filter(Boolean).join(' · ');
    confirmedDetail.textContent = `${when} · ${time}${ev.place ? ' · ' + ev.place : ''}`;
    pollHintEl.textContent = '확정된 일정입니다 · 확정 날짜의 참석 인원만 수정할 수 있습니다';
  } else {
    pollMeta.textContent = `후보 ${ev.dates.length}일${f ? ' · ' + monthDay(f) : ''}${l && l !== f ? ' ~ ' + monthDay(l) : ''}${ev.createdBy ? ' · ' + ev.createdBy : ''}`;
    pollHintEl.textContent = '내 열(점선)을 탭해 가능 표시 · 다시 탭하면 해제';
  }
  confirmBar.hidden = locked;
  confirmedBar.hidden = !locked;
  playableSection.hidden = !locked;
  renderMatrix();
  if (locked) syncPlayable();
}

/* ---------- 참석 인원 기준 가능 곡 ---------- */
function attendeeKey(ev) {
  return [ev.id, ev.date, ...ev.avails.filter((a) => a.date === ev.date).map((a) => a.nickname).sort()].join('|');
}

async function syncPlayable() {
  const ev = pollEvent;
  if (!ev) return;
  const key = attendeeKey(ev);
  if (key === playableKey) { renderPlayable(); return; }
  try {
    const data = await api.get(`/events/${ev.id}/playable`);
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

function renderPlayable() {
  if (!playable) { showLoading(playableListEl); return; }
  const all = playable.songs;
  if (!playable.attendees.length) {
    playableListEl.innerHTML = `<p class="muted empty-msg">참석 인원을 먼저 등록해 주세요.</p>`;
    psToggleBtn.hidden = true;
    return;
  }
  const shown = playableAll ? all : all.filter((s) => s.filled >= MIN_FILLED);
  const hidden = all.length - shown.length;
  psToggleBtn.hidden = playableAll ? all.length === 0 : hidden <= 0;
  psToggleBtn.textContent = playableAll ? `${MIN_FILLED}개 이상만 보기` : `전체 보기 (+${hidden}곡)`;

  if (!shown.length) {
    playableListEl.innerHTML = `<p class="muted empty-msg">${MIN_FILLED}개 세션 이상 채워지는 곡이 없습니다.</p>`;
    return;
  }

  const cols = roleColumns(all);
  let html = `<table class="ps-table"><thead><tr>`;
  html += `<th class="ps-score-head">충족</th><th class="ps-song-head">곡</th>`;
  cols.forEach((r) => {
    const short = ROLE_SHORT[r] || r;
    html += `<th class="ps-role-head" title="${escapeHtml(r)}">` +
      `<span class="ps-role-short">${escapeHtml(short)}</span>` +
      `<span class="ps-role-full">${escapeHtml(r)}</span></th>`;
  });
  html += `</tr></thead><tbody>`;

  let lastFilled = null;
  shown.forEach((s) => {
    const byRole = {};
    s.roles.forEach((r) => { byRole[r.role] = r; });
    const ratio = s.needed ? s.filled / s.needed : 0;
    const tier = ratio >= 1 ? 'full' : ratio >= 0.66 ? 'good' : ratio >= 0.5 ? 'half' : 'low';
    const gap = lastFilled !== null && lastFilled !== s.filled ? ' ps-gap' : '';
    lastFilled = s.filled;
    html += `<tr class="ps-row ${tier}${gap}">`;
    const pct = s.needed ? (s.filled / s.needed) * 100 : 0;
    html += `<td class="ps-score"><strong>${s.filled}</strong><span>/${s.needed}</span>` +
      `<span class="skew-gauge${s.filled === s.needed ? ' full' : ''}">` +
      `<i style="width:${pct}%"></i></span></td>`;
    html += `<td class="ps-song" title="${escapeHtml(s.title)}${s.artist ? ' · ' + escapeHtml(s.artist) : ''}">` +
      `<div class="ps-song-title">${escapeHtml(s.title)}</div>` +
      `<div class="ps-song-sub">${escapeHtml(s.artist || '')}</div></td>`;
    cols.forEach((role) => {
      const r = byRole[role];
      if (!r) { html += `<td class="ps-cell none"></td>`; return; }
      if (!r.ok) { html += `<td class="ps-cell off"><span class="ps-hole"></span></td>`; return; }
      // 중복지원이면 칩이 그만큼 늘어난다 (열이 조금 넓어지는 건 감수)
      html += `<td class="ps-cell on"><span class="ps-chips">` +
        r.members.map((n) => avatarChip(n)).join('') + `</span></td>`;
    });
    html += `</tr>`;
  });
  html += `</tbody></table>`;
  playableListEl.innerHTML = html;
}

psToggleBtn.addEventListener('click', () => {
  playableAll = !playableAll;
  renderPlayable();
});

function openPoll(id) {
  const ev = events.find((e) => e.id === id);
  if (!ev) return;
  pollEvent = ev;
  currentUser = Nick.get();
  confirmDateEl.value = '';
  confirmStartEl.value = '';
  confirmEndEl.value = '';
  confirmPlaceEl.value = '';
  weekendOnlyEl.checked = false;
  weekendOnlyEl.closest('.chk').classList.remove('is-on');
  weekendOnly = false;
  renderPollView();
  pollView.hidden = false;
  document.body.style.overflow = 'hidden';
}

function closePoll() {
  pollEvent = null;
  playable = null;
  playableKey = '';
  playableAll = false;
  pollView.hidden = true;
  document.body.style.overflow = '';
}

pollListEl.addEventListener('click', (e) => {
  const item = e.target.closest('[data-open-poll]');
  if (item) openPoll(Number(item.dataset.openPoll));
});
dayListEl.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-del-event]');
  if (!btn) {
    const item = e.target.closest('[data-open-poll]');
    if (item) openPoll(Number(item.dataset.openPoll));
    return;
  }
  const id = Number(btn.dataset.delEvent);
  const ev = events.find((x) => x.id === id);
  if (!ev) return;
  if (!confirm(`${ev.title} 일정을 삭제할까요?`)) return;
  api.del(`/events/${id}`).then(refresh);
});

document.getElementById('poll-back').addEventListener('click', closePoll);
document.getElementById('poll-delete').addEventListener('click', async () => {
  if (!pollEvent) return;
  if (!confirm(`${pollEvent.title} 조율을 삭제할까요?`)) return;
  await api.del(`/events/${pollEvent.id}`);
  closePoll();
  await refresh();
});

weekendOnlyEl.addEventListener('change', () => {
  weekendOnly = weekendOnlyEl.checked;
  weekendOnlyEl.closest('.chk').classList.toggle('is-on', weekendOnly);
  renderMatrix();
});

matrixEl.addEventListener('click', async (e) => {
  const td = e.target.closest('[data-toggle]');
  if (!td) return;
  const target = td.dataset.member || '';
  if (target && target !== currentUser) {
    const on = td.classList.contains('on');
    const msg = on ? `${target}님을 참석자에서 뺄까요?` : `${target}님을 참석자에 넣을까요?`;
    if (!confirm(msg)) return;
    await api.post(`/events/${pollEvent.id}/avail/toggle`, { date: td.dataset.toggle, nickname: target });
    await refresh();
    return;
  }
  if (!currentUser) {
    const name = await Nick.ensure();
    if (!name) return;
    currentUser = name;
  }
  await api.post(`/events/${pollEvent.id}/avail/toggle`, { date: td.dataset.toggle, nickname: currentUser });
  await refresh();
});

confirmBtn.addEventListener('click', async () => {
  const day = confirmDateEl.value;
  if (!day || !pollEvent) return;
  const start = confirmStartEl.value || null;
  const end = confirmEndEl.value || null;
  const place = confirmPlaceEl.value.trim() || null;
  const d = parseDate(day);
  if (!confirm(`${d.getMonth() + 1}월 ${d.getDate()}일 (${DOW[d.getDay()]})로 확정할까요?`)) return;
  await api.post(`/events/${pollEvent.id}/confirm`, { date: day, startTime: start, endTime: end, place });
  selectedDate = day;
  await refresh();
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
  await api.post(`/events/${ev.id}/avail/toggle`, { date: ev.date, nickname: name });
  await refresh();
});

unconfirmBtn.addEventListener('click', async () => {
  if (!pollEvent) return;
  if (!confirm(`${pollEvent.title} 확정을 해제하고 다시 조율할까요?`)) return;
  await api.post(`/events/${pollEvent.id}/unconfirm`, {});
  await refresh();
});

renderCalendar();
mountChrome('schedule');
startPolling(refresh);

document.addEventListener('nickchange', () => {
  currentUser = Nick.get();
  if (pollView.hidden === false) renderPollView();
});
