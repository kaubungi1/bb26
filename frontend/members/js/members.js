let members = [];
let selectedRole = '';
const memberListEl = document.getElementById('member-list');
const memberSearchEl = document.getElementById('member-search');
const memberErrorEl = document.getElementById('member-error');
const roleFilterEl = document.getElementById('role-filter');
const memberCountEl = document.getElementById('member-count');

/* 파트는 세 군데에서 온다. 본인이 적은 것, 길드에서 맡은 것, 실제로 지원한 것.
   찾을 때는 셋 중 어디에 걸려도 잡아야 한다 — "베이스 칠 사람" 을 찾는 쪽에서는
   본인이 안 적었어도 실제로 친 적이 있으면 후보다. */
function memberRoles(m) {
  return [...new Set([...(m.mainRoles || '').split(','), ...(m.guilds || []).map((g) => g.role),
    ...(m.playedRoles || [])].map((r) => r.trim()).filter(Boolean))];
}

/* 카드에 그리는 파트는 본인이 적은 것만이다.
   지원 기록까지 섞으면 한 번 해 본 파트가 주 파트와 똑같이 생겨서, 적을 이유가 없어진다. */
function ownRoles(m) {
  return (m.mainRoles || '').split(',').map((r) => r.trim()).filter(Boolean);
}

function bcRow(label, body) {
  if (!body) return '';
  return `<div class="bc-row"><span class="bc-key">${label}</span><span class="bc-val">${body}</span></div>`;
}

/* 명함 한 장. 위는 짙은 면(로고·칭호·이름·상태), 아래는 흰 면(소개·정보). */
function memberCard(m) {
  const mine = ownRoles(m);
  const parts = ROLE_ORDER.map((r) =>
    `<b class="${mine.includes(r) ? 'on' : 'off'}">${escapeHtml(ROLE_SHORT[r] || r)}</b>`).join('');
  const guilds = [...new Map((m.guilds || []).map((g) => [g.slug, g])).values()];
  const gs = guilds.slice(0, 3).map((g) =>
    `<a href="/guild/${encodeURIComponent(g.slug)}/">${escapeHtml(g.name)}</a>`).join(' · ')
    + (guilds.length > 3 ? `  외 ${guilds.length - 3}` : '');
  /* 곡 수는 쓰지 않는다. 숫자가 줄마다 서면 활동량 순위표가 된다.
     최근에 무슨 곡을 했는지만 남긴다 — 그건 서열이 아니라 근황이다. */
  const recent = (m.recentSongs || [])
    .map((s) => `<a href="/songs/?song=${s.id}">${escapeHtml(s.title)}</a>`).join(', ');
  return `<article class="bcard">
    <div class="bc-head">
      <div class="bc-top">
        <img class="bc-logo" src="/assets/logo.png" alt="불법이륙" />
        ${avatarChip(m.nickname)}
      </div>
      ${m.title ? `<span class="bc-over">${escapeHtml(m.title)}</span>` : ''}
      <span class="bc-name">${escapeHtml(m.nickname)}${m.status ? ` <i>(${escapeHtml(m.status)})</i>` : ''}</span>
      ${m.nickname === Nick.get() ? '<button type="button" class="bc-edit" data-edit-me>편집</button>' : ''}
    </div>
    <div class="bc-body">
      <p class="bc-intro">${escapeHtml(m.intro || '')}</p>
      <div class="bc-rows">
        ${bcRow('PARTS', `<span class="bc-parts">${parts}</span>`)}
        ${bcRow('TIME', escapeHtml(m.availability || ''))}
        ${bcRow('GUILD', gs)}
        ${bcRow('RECENT', recent)}
      </div>
    </div>
  </article>`;
}

function renderMembers() {
  const roles = [...new Set([...ROLE_ORDER, ...members.flatMap(memberRoles)])];
  roleFilterEl.innerHTML = ['', ...roles].map((r) => `<button type="button" class="chip${selectedRole === r ? ' is-on' : ''}" data-role="${escapeHtml(r)}" aria-pressed="${selectedRole === r}">${escapeHtml(r || '전체')}</button>`).join('');
  const query = memberSearchEl.value.trim().toLocaleLowerCase();
  const rows = members.filter((m) => (!selectedRole || memberRoles(m).includes(selectedRole)) &&
    [m.nickname, m.title, m.status, m.intro, m.availability, ...(m.guilds || []).map((g) => g.name)]
      .some((s) => (s || '').toLocaleLowerCase().includes(query)))
    /* 가나다순. 곡 수로 세우면 목록 자체가 활동량 순위표가 된다. */
    .sort((a, b) => a.nickname.localeCompare(b.nickname, 'ko'));
  if (memberCountEl) memberCountEl.textContent = members.length ? rows.length : '';
  memberListEl.innerHTML = rows.map(memberCard).join('')
    || `<p class="empty-msg muted">${query || selectedRole ? '조건에 맞는 멤버가 없습니다.' : '아직 등록된 멤버가 없습니다. 내 캐릭터를 만들어 보세요.'}</p>`;
}

async function refreshMembers() {
  try {
    members = await api.get('/members');
    members.forEach((m) => { Profiles.map[m.nickname] = m; });
    memberErrorEl.hidden = true;
    renderMembers();
    document.dispatchEvent(new Event('profiles'));
  } catch (err) {
    memberErrorEl.textContent = `멤버를 불러오지 못했습니다. ${err.message}`;
    memberErrorEl.hidden = false;
    memberListEl.querySelector('.loading')?.remove();
  }
}

async function editMe() {
  const nickname = await Nick.ensure();
  if (!nickname) return;
  await openProfileEditor(nickname);
  await refreshMembers();
}
document.getElementById('edit-me').onclick = editMe;
memberListEl.onclick = (e) => { if (e.target.closest('[data-edit-me]')) editMe(); };
memberSearchEl.oninput = renderMembers;
roleFilterEl.onclick = (e) => {
  const button = e.target.closest('[data-role]');
  if (!button) return;
  selectedRole = button.dataset.role;
  renderMembers();
};
document.addEventListener('nickchange', renderMembers);
document.addEventListener('profiles', renderMembers);
showLoading(memberListEl);
mountChrome('members');
startPolling(refreshMembers, 15000);
