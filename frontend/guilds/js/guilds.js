/* 길드 목록 — 길드 하나가 파티창 하나다.
   그리는 일은 common/party.js 가 맡는다. 길드 무대(/guild/<slug>/)도 같은 부품을 쓴다. */

let guilds = [];
const listEl = document.getElementById('guild-list');
const searchEl = document.getElementById('guild-search');
const errorEl = document.getElementById('guild-error');
const countEl = document.getElementById('guild-count');

function visibleGuilds() {
  const query = searchEl.value.trim().toLocaleLowerCase();
  if (!query) return guilds;
  return guilds.filter((g) => [g.name, g.slogan, g.recruitNote, ...g.members.map((m) => m.nickname)]
    .some((s) => (s || '').toLocaleLowerCase().includes(query)));
}

/* 첫 목록이 오기 전에는 그리지 않는다. profiles 이벤트가 먼저 도착하면
   빈 배열로 그려서 '아직 길드가 없습니다' 가 잠깐 스쳤다. */
let loaded = false;
function renderGuilds() {
  if (!loaded) return;
  const rows = visibleGuilds();
  countEl.textContent = guilds.length ? rows.length : '';
  listEl.innerHTML = rows.length
    ? rows.map((g) => partyWindow(g, { link: true })).join('')
    : `<p class="empty-msg muted">${searchEl.value.trim()
        ? '검색 결과가 없습니다.' : '아직 길드가 없습니다. 함께할 팀을 만들어 보세요.'}</p>`;
  fitParty(listEl);
}

async function refreshGuilds() {
  if (Writes.pending) return;        /* 보내는 중인 쓰기가 끝나면 writes-idle 로 다시 온다 */
  const seq = Writes.seq;
  try {
    const res = await api.poll('/guilds');
    if (Writes.stale(seq)) return;   /* 기다리는 동안 누른 것이 있으면 이 응답은 낡았다 */
    errorEl.hidden = true;
    if (!res.changed && loaded) return;   /* 바뀐 게 없으면 다시 그리지 않는다 */
    guilds = res.data;
    loaded = true;
    renderGuilds();
  } catch (err) {
    errorEl.textContent = `길드를 불러오지 못했습니다. ${err.message}`;
    errorEl.hidden = false;
    listEl.querySelector('.loading')?.remove();
  }
}

/* 칸을 누르면 그 파트로 합류하거나 내 자리에서 나온다. party.js 가 되묻고 API 를 친다.
   한 번에 하나만 처리한다 — 되묻는 창이 뜬 사이에 또 누르면 같은 요청이 두 번 간다. */
let busy = false;
listEl.addEventListener('click', async (e) => {
  if (busy) return;
  busy = true;
  try {
    if (await partyClick(e, guilds)) renderGuilds();   /* 명단은 이미 바뀌었다. 서버는 뒤에서 맞춘다 */
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.hidden = false;
  } finally {
    busy = false;
  }
});

document.getElementById('create-guild').onclick = async () => {
  const saved = await openGuildEditor();
  if (saved) location.assign(`/guild/${encodeURIComponent(saved.slug)}/`);
};
searchEl.oninput = renderGuilds;
document.addEventListener('profiles', renderGuilds);
document.addEventListener('nickchange', renderGuilds);
/* 창 폭이 바뀌면 칸 폭도 바뀐다. 잘렸는지 다시 잰다. */
let fitTimer = null;
addEventListener('resize', () => {
  clearTimeout(fitTimer);
  fitTimer = setTimeout(() => fitParty(listEl), 120);
});

showLoading(listEl);
mountChrome('guilds');
startPolling(refreshGuilds, 15000);
document.addEventListener('writes-idle', () => refreshGuilds());
