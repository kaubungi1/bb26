let members = [];
let selectedRole = '';
const memberListEl = document.getElementById('member-list');
const memberSearchEl = document.getElementById('member-search');
const memberErrorEl = document.getElementById('member-error');
const roleFilterEl = document.getElementById('role-filter');

function memberRoles(m) {
  return [...new Set([...(m.mainRoles || '').split(','), ...(m.guilds || []).map((g) => g.role)].map((r) => r.trim()).filter(Boolean))];
}

function renderMembers() {
  const roles = [...new Set([...ROLE_ORDER, ...members.flatMap(memberRoles)])];
  roleFilterEl.innerHTML = ['', ...roles].map((r) => `<button type="button" class="chip${selectedRole === r ? ' is-on' : ''}" data-role="${escapeHtml(r)}" aria-pressed="${selectedRole === r}">${escapeHtml(r || '전체')}</button>`).join('');
  const query = memberSearchEl.value.trim().toLocaleLowerCase();
  const rows = members.filter((m) => (!selectedRole || memberRoles(m).includes(selectedRole)) &&
    [m.nickname, m.title, m.status, m.intro, m.availability, ...(m.guilds || []).map((g) => g.name)]
      .some((s) => (s || '').toLocaleLowerCase().includes(query)));
  memberListEl.innerHTML = rows.map((m) => {
    const guilds = [...new Map((m.guilds || []).map((g) => [g.slug, g])).values()];
    return `<article class="member-entry">
      <div class="member-entry-head">${avatarChip(m.nickname, 'xl')}
        <div class="member-name"><strong>${escapeHtml(m.nickname)}</strong>${m.title ? `<span>${escapeHtml(m.title)}</span>` : ''}</div>
        ${m.nickname === Nick.get() ? '<button type="button" class="ghost mini" data-edit-me>편집</button>' : ''}
      </div>
      <div class="member-role-line">${escapeHtml(memberRoles(m).join(' · ') || '파트 미등록')}</div>
      ${m.status ? `<p class="member-status">“${escapeHtml(m.status)}”</p>` : ''}
      ${m.intro ? `<p class="member-intro">${escapeHtml(m.intro)}</p>` : ''}
      ${m.availability ? `<p class="member-availability">${icon('clock', 13)} ${escapeHtml(m.availability)}</p>` : ''}
      ${guilds.length ? `<div class="member-guilds">${guilds.map((g) => `<a href="/guild/${encodeURIComponent(g.slug)}/">${guildBadge(g)}</a>`).join('')}</div>` : ''}
    </article>`;
  }).join('') || `<p class="empty-msg muted">${query || selectedRole ? '조건에 맞는 멤버가 없습니다.' : '아직 등록된 멤버가 없습니다. 내 캐릭터를 만들어 보세요.'}</p>`;
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
