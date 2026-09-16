/* 길드 파티창.

   길드 하나를 여섯 칸으로 그린다. 칸 순서는 ROLE_ORDER 로 고정이라
   길드를 나란히 놓으면 "베이스 비어 있는 데" 를 훑지 않고 한눈에 찾는다.
   전에는 사람이 있는 파트만 순서대로 나열해서 길드마다 Ba 가 다른 자리에 왔다.

   목록(/guilds/)과 길드 무대(/guild/<slug>/)가 이 파일 하나를 같이 쓴다.
   전에는 guilds.js 와 home.js 가 각자 .guild-roster 를 그려서 두 화면이 달랐다.

   칸의 상태 표시는 곡 자켓(home.js)과 같은 규칙이다 — on 찬 자리, off 빈 자리, mine 내 자리. */

/* 한 파트에 여러 명이 들어간다. 그게 기본이다 — 실제 길드의 대부분이 그렇다.
   그래서 접지 않고 한 사람씩 줄로 세운다. 전에는 첫 사람만 쓰고 '+1' 로 접었는데,
   거의 모든 칸이 '+1' 이라 사실상 모든 칸에서 이름을 버리고 있었다.

   팀장 ★ 는 칸이 아니라 그 사람 이름 옆에 붙는다. 칸에 붙이면 한 사람이 두 파트를
   맡을 때 두 칸 모두에 ★ 가 서고, 접힌 이름 때문에 엉뚱한 사람이 팀장으로 읽힌다. */
function partySlot(guild, role, members, me) {
  const mine = members.find((m) => m.nickname === me);
  /* 내 이름을 맨 앞으로. 칸이 좁아 잘려도 내가 먼저 보인다 — 곡·홈과 같은 규칙. */
  const ordered = [...(mine ? [mine] : []), ...members.filter((m) => m !== mine)];
  const state = mine ? 'mine' : members.length ? 'on' : 'off';
  const people = ordered.length
    ? ordered.map((m) => {
        const lead = guild.leader && m.nickname === guild.leader;
        return `<span class="ps-person">${avatarChip(m.nickname)}` +
          `<span class="ps-who">${escapeHtml(m.nickname)}</span>` +
          (lead ? '<i class="ps-lead" title="팀장">★</i>' : '') + '</span>';
      }).join('')
    : '<span class="ps-person ps-none" aria-hidden="true"><span class="ps-plus">＋</span></span>';
  /* 쪽지는 이름 하나가 칸 폭을 넘칠 때만 켠다. 켜는 건 fitParty() 가 재서 정한다. */
  const full = ordered.length
    ? `${role} · ${ordered.map((m) => m.nickname).join(', ')}` : `${role} · 비어 있음`;
  return `<button type="button" class="pslot ${state}"` +
    ` data-party-slot="${escapeHtml(role)}" data-peek-full="${escapeHtml(full)}"` +
    ` aria-label="${escapeHtml(full)}${mine ? ' · 탈퇴' : ' · 합류'}">` +
    `<span class="ps-role">${escapeHtml(ROLE_SHORT[role] || role)}</span>` +
    `<span class="ps-people">${people}</span>` +
    '</button>';
}

/* opts.link 가 참이면 이름과 발치에 길드로 들어가는 길을 단다.
   길드 무대에서는 이미 그 길드 안이라 필요 없다. */
function partyWindow(guild, opts = {}) {
  const me = Nick.get();
  /* 여섯 파트를 늘 세우고, 그 밖의 파트를 쓰는 사람이 있으면 뒤에 붙인다. */
  const roles = [...new Set([...ROLE_ORDER, ...guild.members.map((m) => m.role)])];
  const filled = roles.filter((r) => guild.members.some((m) => m.role === r)).length;
  /* 자리가 다 찼는지와 사람이 몇인지는 다른 질문이다. 한 사람이 기타도 치고 건반도 치면
     6/6 이어도 네 명일 수 있고, 합주를 잡을 때 사정이 전혀 다르다. 그래서 둘 다 쓴다.
     닉네임으로 묶는다 — 한 사람이 세 파트를 맡아도 한 명이다. */
  const head = new Set(guild.members.map((m) => m.nickname)).size;
  const href = `/guild/${encodeURIComponent(guild.slug)}/`;
  const color = /^#[0-9a-f]{6}$/i.test(guild.color || '') ? guild.color : '#00838d';
  const name = opts.link
    ? `<a class="party-name" href="${href}">${escapeHtml(guild.name)}</a>`
    : `<span class="party-name">${escapeHtml(guild.name)}</span>`;
  /* 꼬리(슬로건·팀장)는 길드 목록에서 카드의 유일한 설명이라 거기서는 꼭 있어야 한다.
     길드 홈에서는 같은 내용이 위쪽 판에 올라가므로 opts.foot:false 로 끈다. */
  const foot = opts.foot === false ? '' : [
    guild.slogan ? `<span class="party-slogan">${escapeHtml(guild.slogan)}</span>` : '',
    guild.leader ? `<span class="party-leader">팀장 ${escapeHtml(guild.leader)}</span>` : '',
  ].filter(Boolean).join('<span class="meta-sep">·</span>');
  return `<article class="party" data-party="${escapeHtml(guild.slug)}" style="--g:${escapeHtml(color)}">
    <div class="party-band">
      <span class="party-emblem">${
        /* 문장 > 방패. crest.js 가 없는 페이지도 있으므로 있을 때만 쓴다. */
        (typeof crestFor === 'function' && crestFor(guild, 26))
        || icon('shield', 20)}</span>
      ${name}
      <span class="party-count">${filled}<i>/${roles.length}</i><em>${head}명</em></span>
    </div>
    <div class="party-slots">${roles.map((r) =>
      partySlot(guild, r, guild.members.filter((m) => m.role === r), me)).join('')}</div>
    <!-- '들어가기' 는 위 칸의 '합류' 와 헷갈린다. 여기는 그 길드 페이지로 가는 이동일 뿐이다. -->
    ${foot || opts.link ? `<div class="party-foot">${foot}${opts.link ? `<a class="party-go" href="${href}" data-enter="${escapeHtml(guild.slug)}">길드 입장하기 →</a>` : ''}</div>` : ''}
  </article>`;
}

/* 이름이 칸에 들어가는지 실제로 재서, 잘린 칸에만 쪽지를 켠다.
   이제 사람마다 제 줄이 있으므로 접혀서 숨는 이름은 없다. 남은 경우는 닉네임 하나가
   칸 폭보다 긴 것뿐이고, 그건 재 봐야 안다 — 글자 수로 어림하지 않는다.
   곡 목록의 fitNames() 와 같은 이유다. 읽기를 전부 한 번에 하고 쓰기를 전부 한 번에 한다. */
function fitParty(root = document) {
  const slots = [...root.querySelectorAll('.pslot[data-peek-full]')];
  if (!slots.length) return;
  const clipped = slots.map((b) =>
    [...b.querySelectorAll('.ps-who')].some((n) => n.scrollWidth > n.clientWidth + 1));
  slots.forEach((b, i) => {
    if (clipped[i]) b.setAttribute('data-peek', b.dataset.peekFull);
    else b.removeAttribute('data-peek');
  });
}

/* 칸을 눌렀을 때. 내 칸이면 탈퇴, 아니면 그 파트로 합류한다.
   전에는 prompt('합류할 파트') 로 파트를 글자로 받았다. 오타가 나면 그 사람만
   엉뚱한 칸에 서고 그 파트는 영영 '모집 중' 으로 남았다. 고를 것이 여섯뿐이라
   글자로 받을 이유가 없다 — 칸이 곧 선택이다.

   guilds 는 화면이 들고 있는 길드 배열이다. 바뀐 뒤 다시 그리는 건 부르는 쪽이 한다. */
async function partyClick(e, guilds) {
  const btn = e.target.closest('[data-party-slot]');
  if (!btn) return false;
  const slug = btn.closest('[data-party]').dataset.party;
  const guild = guilds.find((g) => g.slug === slug);
  if (!guild) return false;
  const role = btn.dataset.partySlot;

  const me = await Nick.ensure();
  if (!me) return false;
  const mine = guild.members.find((m) => m.nickname === me && m.role === role);

  if (mine) {
    const ok = await confirmModal({
      title: '길드 탈퇴',
      body: `<b>${escapeHtml(guild.name)}</b> 의 ${escapeHtml(role)} 자리에서 나옵니다.`,
      confirm: '탈퇴',
    });
    if (!ok) return false;
    await api.del(`/guilds/${encodeURIComponent(slug)}/members/${mine.id}`);
    return true;
  }

  const ok = await confirmModal({
    title: '길드 합류',
    body: `<b>${escapeHtml(guild.name)}</b> 에 ${escapeHtml(role)} 로 합류합니다.`,
    confirm: '합류',
  });
  if (!ok) return false;
  await api.post(`/guilds/${encodeURIComponent(slug)}/members`, { nickname: me, role });
  return true;
}


/* '길드 입장하기' 를 누른 것만 등장 연출의 방아쇠다. 새로고침이나 주소를 직접 친 것,
   이미 길드 안에서 헤더의 이름을 눌러 홈으로 돌아오는 것은 '들어서는' 동작이 아니다.

   쿠키가 아니라 sessionStorage 다 — 서버로 안 나가고 탭을 닫으면 사라진다.
   길드 홈이 읽는 즉시 지우므로 '한 번 봤으니 영영 안 나옴' 이 되지 않는다.
   목록으로 나갔다 다시 들어오면 또 재생된다. */
const GUILD_ENTER_KEY = 'guild-enter';
document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-enter]');
  if (!a) return;
  try { sessionStorage.setItem(GUILD_ENTER_KEY, a.dataset.enter); } catch { /* 사생활 보호 창 */ }
});
/* 길드 홈이 부른다. 내 것이면 true 를 주고 표시를 지운다. */
function guildEnterFlag(slug) {
  try {
    const v = sessionStorage.getItem(GUILD_ENTER_KEY);
    if (v === null) return false;
    sessionStorage.removeItem(GUILD_ENTER_KEY);
    return v === slug;
  } catch { return false; }
}
