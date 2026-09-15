let guilds = [];
const listEl = document.getElementById('guild-list');
const searchEl = document.getElementById('guild-search');
const errorEl = document.getElementById('guild-error');

function renderGuilds() {
  const query = searchEl.value.trim().toLocaleLowerCase();
  const rows = guilds.filter((g) => [g.name, g.slogan, g.recruitNote, ...g.members.map((m) => m.nickname)]
    .some((s) => (s || '').toLocaleLowerCase().includes(query)));
  listEl.innerHTML = rows.map((g) => {
    const roles = [...new Set([...ROLE_ORDER, ...g.members.map((m) => m.role)])];
    const count = new Set(g.members.map((m) => m.nickname)).size;
    return `<article class="guild-entry">
      <a class="guild-entry-head" href="/guild/${encodeURIComponent(g.slug)}/">
        <span class="guild-emblem">${g.emblem ? escapeHtml(g.emblem) : icon('shield', 26)}</span>
        <span class="guild-entry-name"><strong>${escapeHtml(g.name)}</strong><span>${escapeHtml(g.slogan || '')}</span></span>
        <span class="muted">${count}명 ›</span>
      </a>
      <div class="guild-roster">${roles.map((r) => {
        const members = g.members.filter((m) => m.role === r);
        return `<div class="guild-role"><span class="guild-role-name">${escapeHtml(ROLE_SHORT[r] || r)}</span>
          <span class="guild-role-people">${members.length
            ? members.map((m) => `<span class="guild-person">${avatarChip(m.nickname)}<span>${escapeHtml(m.nickname)}</span></span>`).join('')
            : `<a class="guild-vacancy" href="/guild/${encodeURIComponent(g.slug)}/">모집 중</a>`}</span></div>`;
      }).join('')}</div>
      ${g.recruitNote ? `<p class="guild-recruit">${escapeHtml(g.recruitNote)}</p>` : ''}
      <div class="guild-entry-foot"><span class="muted">${g.leader ? `팀장 ${escapeHtml(g.leader)}` : ''}</span><a href="/guild/${encodeURIComponent(g.slug)}/">길드 들어가기 →</a></div>
    </article>`;
  }).join('') || `<p class="empty-msg muted">${query ? '검색 결과가 없습니다.' : '아직 길드가 없습니다. 함께할 팀을 만들어 보세요.'}</p>`;
}

async function refreshGuilds() {
  try {
    guilds = await api.get('/guilds');
    errorEl.hidden = true;
    renderGuilds();
  } catch (err) {
    errorEl.textContent = `길드를 불러오지 못했습니다. ${err.message}`;
    errorEl.hidden = false;
    listEl.querySelector('.loading')?.remove();
  }
}

document.getElementById('create-guild').onclick = async () => {
  const saved = await openGuildEditor();
  if (saved) location.assign(`/guild/${encodeURIComponent(saved.slug)}/`);
};
searchEl.oninput = renderGuilds;
document.addEventListener('profiles', renderGuilds);
showLoading(listEl);
mountChrome('guilds');
startPolling(refreshGuilds, 15000);
