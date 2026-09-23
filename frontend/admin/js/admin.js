/* 관리 탭. 멤버·길드 삭제와 파딱·핑딱 딱지.
   무엇을 켤지는 화면이 정하지만, 허락은 서버가 쓰기마다 다시 본다(backend/admin.py).
   목록은 공개 목록(/members, /guilds)을 그대로 쓴다. 들어올 때 한 번 읽고 폴링하지 않는다. */

const BADGE_NAME = { blue: '파딱', pink: '핑딱' };
const RANK = { root: 3, blue: 2, pink: 1 };
const rankOf = (r) => RANK[r] || 0;

let role = null;
let members = [];
let guilds = [];
const errorEl = document.getElementById('admin-error');

/* 관리 API 는 닉네임을 머리에 싣는다. 파딱·핑딱은 이것으로 권한이 선다. 한글이라 인코딩한다. */
async function call(method, url, body) {
  const res = await fetch('/api/admin' + url, {
    method,
    headers: { 'X-Nickname': encodeURIComponent(Nick.get()), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(await apiError(res));
  return res.json();
}

function fail(err) {
  errorEl.textContent = err.message;
  errorEl.hidden = false;
}

/* 자기보다 낮은 딱지에게만 손댄다. 서버의 require_above 와 같은 규칙이다. */
const canTouch = (m) => role === 'root' || rankOf(m.badge) < rankOf(role);
const canBadge = (m) => rankOf(role) >= RANK.blue && canTouch(m);

/* 딱지 고르기. 핑딱·파딱 둘뿐이다. 누르면 켜지고, 켜진 것을 다시 누르면 꺼진다.
   '없음' 칩을 따로 두었더니 딱지 없는 모든 줄에 검은 칩이 떠서 삭제 버튼처럼 보였다.
   켜진 칩만 딱지 색으로 찬다(admin.css). 바꿀 수 없는 사람에게는 딱지 이름만 보인다. */
function badgeCell(m) {
  if (!canBadge(m)) return m.badge ? `<span class="badge-name is-${m.badge}">${BADGE_NAME[m.badge]}</span>` : '';
  const chip = (v, label) => {
    const on = (m.badge || '') === v;
    return `<button type="button" class="chip${on ? ' is-on' : ''}" aria-pressed="${on}"` +
      ` data-set-badge="${v}" data-who="${escapeHtml(m.nickname)}">${label}</button>`;
  };
  return `<span class="badge-set" role="group" aria-label="${escapeHtml(m.nickname)} 딱지">` +
    chip('pink', '핑딱') + chip('blue', role === 'blue' ? '위임' : '파딱') + '</span>';
}

/* 이름 아래 작은 한 줄. 0 은 적지 않는다. */
function stats(pairs) {
  return pairs.filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(' · ');
}

function paintMembers() {
  /* 딱지가 있는 사람이 위로. 그다음은 이름순(목록이 이미 이름순이다). */
  const rows = [...members].sort((a, b) => rankOf(b.badge) - rankOf(a.badge));
  document.getElementById('member-count').textContent = members.length;
  document.getElementById('member-rows').innerHTML = rows.map((m) => `
    <div class="admin-cell">
      ${avatarChip(m.nickname, 'lg')}
      <span class="cell-main">
        <b>${escapeHtml(m.nickname)}</b>
        <small>${stats([['길드', (m.guilds || []).length], ['지원', m.supportCount]])}</small>
      </span>
      ${badgeCell(m)}
      ${canTouch(m) ? `<button type="button" class="del" data-del-member="${escapeHtml(m.nickname)}">삭제</button>` : ''}
    </div>`).join('');
}

function paintGuilds() {
  document.getElementById('guild-count').textContent = guilds.length;
  document.getElementById('guild-rows').innerHTML = guilds.map((g) => `
    <div class="admin-cell">
      <span class="cell-main">
        ${guildBadge(g)}
        <small>${stats([['인원', new Set((g.members || []).map((x) => x.nickname)).size]])}</small>
      </span>
      <button type="button" class="del" data-del-guild="${escapeHtml(g.slug)}">삭제</button>
    </div>`).join('');
}

async function load() {
  [members, guilds] = await Promise.all([api.get('/members'), api.get('/guilds')]);
  paintMembers();
  paintGuilds();
}

/* 확인 창 본문. 사라지는 것과 남는 것을 건수로 보여준다. */
function countLines(list) {
  return list.map((c) => `<span class="impact-row${c.count ? '' : ' is-zero'}"><span>${escapeHtml(c.label)}</span><b>${c.count}</b></span>`).join('');
}

async function deleteMember(btn, nickname) {
  let impact;
  try { impact = await call('GET', `/members/${encodeURIComponent(nickname)}/impact`); } catch (err) { return fail(err); }
  const ok = await confirmModal({
    title: `'${nickname}' 삭제`,
    body: `<span class="impact">${countLines(impact.counts)}</span>` +
      '<span class="impact-note">올린 곡·일정·악보는 남습니다.</span>',
    confirm: '삭제', danger: true,
  });
  if (!ok) return;
  const done = await Writes.commit(btn, `admin:member:${nickname}`,
    () => call('DELETE', `/members/${encodeURIComponent(nickname)}`), fail);
  if (!done) return;
  members = members.filter((m) => m.nickname !== nickname);
  paintMembers();
}

async function deleteGuild(btn, slug) {
  let impact;
  try { impact = await call('GET', `/guilds/${encodeURIComponent(slug)}/impact`); } catch (err) { return fail(err); }
  const g = guilds.find((x) => x.slug === slug);
  const ok = await confirmModal({
    title: `'${g ? g.name : slug}' 삭제`,
    body: `<span class="impact">${countLines(impact.counts)}</span>` +
      `<span class="impact-note">소속이 풀리고 남는 것</span><span class="impact">${countLines(impact.released)}</span>`,
    confirm: '삭제', danger: true,
  });
  if (!ok) return;
  const done = await Writes.commit(btn, `admin:guild:${slug}`,
    () => call('DELETE', `/guilds/${encodeURIComponent(slug)}`), fail);
  if (!done) return;
  guilds = guilds.filter((x) => x.slug !== slug);
  paintGuilds();
}

async function setBadge(nickname, picked) {
  const m = members.find((x) => x.nickname === nickname);
  const badge = m.badge === picked ? null : picked;     /* 켜진 것을 누르면 뗀다 */
  /* 파딱은 늘 한 명이다. 새로 붙이면 지금의 파딱이 내려온다 — 그걸 먼저 알린다. */
  if (badge === 'blue') {
    const cur = members.find((x) => x.badge === 'blue');
    const body = role === 'blue'
      ? `<b>${escapeHtml(nickname)}</b> 에게 방장을 넘기면 나는 딱지가 없어집니다.`
      : cur ? `지금 파딱인 <b>${escapeHtml(cur.nickname)}</b> 은(는) 내려옵니다.` : `<b>${escapeHtml(nickname)}</b> 을(를) 파딱으로 정합니다.`;
    if (!await confirmModal({ title: '파딱', body, confirm: role === 'blue' ? '넘기기' : '정하기' })) return;
  }
  /* 누르는 즉시 바꾼다(켜고 끄는 동작 — 지원 버튼과 같은 Writes.run). 서버 규칙을 그대로 따라
     파딱을 새로 붙이면 지금의 파딱을 뗀다. 실패하면 누르기 전으로 되돌린다. */
  const before = members.map((x) => [x, x.badge]);
  if (badge === 'blue') members.forEach((x) => { if (x.badge === 'blue') applyBadge(x, null); });
  applyBadge(m, badge);
  paintMembers();
  const handedOver = role === 'blue' && badge === 'blue';
  try {
    await Writes.run(`admin:badge:${nickname}`,
      () => call('PUT', `/members/${encodeURIComponent(nickname)}/badge`, { badge }));
  } catch (err) {
    before.forEach(([x, b]) => applyBadge(x, b));
    paintMembers();
    api.forgetPolls();
    return fail(err);
  }
  /* 위임했으면 내 권한이 없어졌다. 이때만 서버에 다시 묻는다(권한이 없으면 홈으로 간다). */
  if (handedOver) start();
}

/* 목록의 값과 칩이 읽는 프로필을 같이 고친다. 멤버 칩의 왕관과 헤더의 관리 칸이 바로 따라온다. */
function applyBadge(x, badge) {
  x.badge = badge;
  const p = Profiles.get(x.nickname);
  if (p) Profiles.put({ ...p, badge });
}

document.getElementById('panel').addEventListener('click', (e) => {
  const m = e.target.closest('[data-del-member]');
  if (m) return deleteMember(m, m.dataset.delMember);
  const g = e.target.closest('[data-del-guild]');
  if (g) return deleteGuild(g, g.dataset.delGuild);
  const b = e.target.closest('[data-set-badge]');
  if (b) return setBadge(b.dataset.who, b.dataset.setBadge);
});

async function start() {
  errorEl.hidden = true;
  try {
    role = (await call('GET', '/me')).role;
  } catch (err) {
    return fail(err);
  }
  /* 관리자 이름인데 쿠키가 없다(30일이 지났거나 다른 기기). 비밀번호를 다시 묻는다. */
  if (!role && Nick.get() === ADMIN_NICK && await promptAdmin()) role = 'root';
  AdminSeen.setRoot(role === 'root');
  if (!role) { location.replace('/'); return; }
  document.getElementById('panel').hidden = false;
  try { await load(); } catch (err) { fail(err); }
  /* 딱지가 바뀌었으면 헤더의 관리 칸도 따라가야 한다 */
  Profiles.load();
}

/* 칸의 얼굴(사진·왕관)은 Profiles 에서 온다. 프로필이 늦게 도착하면 그때 다시 그린다. */
document.addEventListener('profiles', () => { if (members.length) paintMembers(); });

mountChrome('admin');
start();
