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
      renderMatrix();
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

    const openPoll = pollsHere.length === 1 && confirmedHere.length === 0
      ? ` data-open-poll="${pollsHere[0].id}"`
      : '';

    html += `<div class="${cls.join(' ')}" data-date="${dateStr}"${openPoll}>` +
      `<span class="cal-day-num">${day}</span>` +
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
  const polls = events
    .filter((e) => e.status === 'poll')
    .sort((a, b) => {
      const fa = firstDate(a) || '9999', fb = firstDate(b) || '9999';
      return fa < fb ? -1 : fa > fb ? 1 : b.id - a.id;
    });
  if (!polls.length) {
    pollListEl.innerHTML = `<p class="muted empty-msg">진행 중인 조율이 없습니다.</p>`;
    return;
  }
  pollListEl.innerHTML = polls.map((e) => {
    const f = firstDate(e), l = lastDate(e);
    const best = Math.max(0, ...e.dates.map((dr) => e.avails.filter((a) => a.date === dr.date).length));
    return `
      <div class="poll-item" data-open-poll="${e.id}">
        <span class="poll-item-badge">조율중</span>
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
    const sub = [time, e.place, e.note, e.createdBy].filter(Boolean).map(escapeHtml).join(' · ');
    parts.push(`
      <div class="day-item">
        <div class="day-item-head">
          <div>
            <div class="day-item-title">${icon('check', 14)} ${escapeHtml(e.title)}</div>
            <div class="day-item-sub">${sub}</div>
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
  const dates = ev.dates
    .filter((dr) => !weekendOnly || isWeekend(dr.date))
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
    if (cnt === best && best > 0) cls.push('hot');
    if (dr.date < t) cls.push('past');
    html += `<tr class="${cls.join(' ')}">`;
    html += `<td class="date-cell">${monthDay(dr.date)} <span class="dow${dow === '일' ? ' sunday' : ''}${dow === '토' ? ' saturday' : ''}">(${dow})</span><span class="date-cnt">${cnt}명</span></td>`;
    members.forEach((m) => {
      const on = m.name && ev.avails.some((a) => a.date === dr.date && a.nickname === m.name);
      const cellCls = ['avail-cell'];
      if (m.mine) cellCls.push('mine');
      if (on) cellCls.push('on');
      const toggle = m.mine ? ` data-toggle="${dr.date}"` : '';
      const content = on ? '✓' : m.placeholder ? '＋' : '';
      html += `<td class="${cellCls.join(' ')}"${toggle}><span class="avail-check">${content}</span></td>`;
    });
    html += `</tr>`;
  });
  html += '</tbody></table>';
  matrixEl.innerHTML = html;

  const prev = confirmDateEl.value;
  confirmDateEl.innerHTML = dates.map((dr) =>
    `<option value="${dr.date}"${dr.date === bestDate ? ' selected' : ''}>${monthDay(dr.date)} (${DOW[parseDate(dr.date).getDay()]}) · ${countAvail(dr.date)}명</option>`
  ).join('');
  if (prev) confirmDateEl.value = prev;
}

function openPoll(id) {
  const ev = events.find((e) => e.id === id);
  if (!ev) return;
  pollEvent = ev;
  currentUser = Nick.get();
  pollTitle.textContent = ev.title;
  const f = firstDate(ev), l = lastDate(ev);
  pollMeta.textContent = `후보 ${ev.dates.length}일${f ? ' · ' + monthDay(f) : ''}${l && l !== f ? ' ~ ' + monthDay(l) : ''}${ev.createdBy ? ' · ' + ev.createdBy : ''}`;
  confirmDateEl.value = '';
  confirmStartEl.value = '';
  confirmEndEl.value = '';
  confirmPlaceEl.value = '';
  weekendOnlyEl.checked = false;
  weekendOnly = false;
  renderMatrix();
  pollView.hidden = false;
  document.body.style.overflow = 'hidden';
}

function closePoll() {
  pollEvent = null;
  pollView.hidden = true;
  document.body.style.overflow = '';
}

pollListEl.addEventListener('click', (e) => {
  const item = e.target.closest('[data-open-poll]');
  if (item) openPoll(Number(item.dataset.openPoll));
});
dayListEl.addEventListener('click', (e) => {
  const item = e.target.closest('[data-open-poll]');
  if (item) { openPoll(Number(item.dataset.openPoll)); return; }
  const btn = e.target.closest('[data-del-event]');
  if (!btn) return;
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
  renderMatrix();
});

matrixEl.addEventListener('click', async (e) => {
  const td = e.target.closest('[data-toggle]');
  if (!td) return;
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
  closePoll();
  selectedDate = day;
  await refresh();
});

renderCalendar();
mountChrome('schedule');
startPolling(refresh);

document.addEventListener('nickchange', () => {
  currentUser = Nick.get();
  if (pollView.hidden === false) renderMatrix();
});
