/* 합주실 — 곡 하나를 무대 배치로 보여준다.

   자리는 고정이다. 뒤 중앙에 드럼, 앞 중앙에 보컬, 가운데 두 줄이 좌우다.
   곡마다 자리가 어긋나면 "이 곡은 베이스가 없다" 를 한눈에 못 읽는다.

        드럼
   베이스     기타1
   기타2      건반
        보컬

   악기가 앞, 사람이 뒤에 선다. 사람이 없는 자리는 악기만 남는다 —
   그 자체가 "여기 비었다" 는 뜻이라 글자로 따로 쓰지 않는다.

   가운데 두 자리(드럼·보컬)만 사람이 악기 위에 선다. 양옆 네 자리는 사람이
   무대 바깥쪽 가장자리에 선다 — 악기는 제자리에 그대로 두고 사람만 옆으로 뺀다.
   그렇게 해서 무대 높이가 449px 에서 313px 로 줄었다(390px 화면, 다 찬 곡).

   받는 값은 /api/events/{id}/playable 의 songs[].roles 그대로다.
     [{ role, label, members: [닉네임], ok }]

   그림은 자리표시용이다. 멤버가 그린 것이 나오면 INSTRUMENTS 만 통째로 갈아 끼우면
   된다. 다른 곳은 건드릴 필요가 없다. common.js 의 BRAND_MARK 과 같은 방식이다. */

const STAGE_SLOT = { 보컬: 'vo', 일렉1: 'gt1', 일렉2: 'gt2', 베이스: 'ba', 키보드: 'key', 드럼: 'dr' };
const STAGE_LABEL = { dr: 'Dr', ba: 'Ba', gt1: 'Gt1', gt2: 'Gt2', key: 'Key', vo: 'Vo' };
const STAGE_ORDER = ['dr', 'ba', 'gt1', 'gt2', 'key', 'vo'];
/* 양옆 네 자리는 사람이 악기 위가 아니라 무대 바깥쪽 가장자리에 선다.
   그 줄이 103px 에서 52px 로 줄어든다 — 사람과 악기가 나란히 서면 줄 높이가
   둘의 합이 아니라 큰 쪽이 되기 때문이다. 가운데(드럼·보컬)는 바깥쪽이 없어 그대로 둔다.
   값은 무대의 어느 쪽 끝이냐다. CSS 가 이걸 보고 사람을 1열 또는 3열에 세운다. */
const STAGE_SIDE = { ba: 'left', gt2: 'left', gt1: 'right', key: 'right' };

/* 자리표시용 악기. viewBox 는 64 로 통일한다 — 크기는 CSS 가 정한다. */
const INSTRUMENTS = {
  dr: '<circle cx="32" cy="40" r="17"/><path d="M15 40v6a17 6 0 0 0 34 0v-6"/>'
    + '<path d="M46 20h14"/><path d="M53 20v14"/><path d="M8 26l10 10"/>',
  ba: '<path d="M26 44a11 11 0 1 0 8-18l14-16"/><path d="M48 10l6 6-6 4-4-6z"/>'
    + '<circle cx="28" cy="40" r="4"/>',
  gt1: '<path d="M24 46a10 10 0 1 0 7-17l15-17"/><path d="M46 12l6 5-5 5-5-4z"/>'
    + '<circle cx="26" cy="42" r="3.5"/>',
  gt2: '<path d="M24 46a10 10 0 1 0 7-17l15-17"/><path d="M46 12l6 5-5 5-5-4z"/>'
    + '<circle cx="26" cy="42" r="3.5"/>',
  key: '<rect x="7" y="24" width="50" height="20" rx="2"/>'
    + '<path d="M17 24v11M27 24v11M37 24v11M47 24v11"/><path d="M7 38h50"/>',
  vo: '<rect x="25" y="8" width="14" height="24" rx="7"/>'
    + '<path d="M18 28a14 14 0 0 0 28 0"/><path d="M32 42v12"/><path d="M24 54h16"/>',
};

/* 파트 이름 → 자리. 지금 DB 에는 여섯 종뿐이지만, 이름이 늘어도 앞머리로 붙인다.
   그래도 못 붙이면 null 을 돌려주고 부르는 쪽이 무대 아래 줄에 따로 세운다. */
function stageSlot(role) {
  if (STAGE_SLOT[role]) return STAGE_SLOT[role];
  const hit = Object.keys(STAGE_SLOT).find((k) => role.startsWith(k));
  if (hit) return STAGE_SLOT[hit];
  if (role.startsWith('기타') || role.startsWith('일렉')) return 'gt1';
  if (role.startsWith('보')) return 'vo';
  return null;
}

/* 한 자리. 악기는 늘 그리고, 사람은 있을 때만 그린다. */
function stageSpot(slot, role) {
  if (!role) return `<div class="stage-spot is-none" style="grid-area:${slot}"></div>`;
  const people = role.members || [];
  /* 표기(label)는 지원 기록에 붙는 것이라 이 응답에는 없다. 여기서는 닉네임을 쓴다. */
  const bodies = people.map((n) => avatarChip(n)).join('');
  const names = people.map((n) => escapeHtml(n)).join(' · ');
  const title = role.label || role.role;
  const side = STAGE_SIDE[slot];
  const cls = 'stage-spot'
    + (people.length ? '' : ' is-empty')
    + (side ? ` is-side is-${side}` : '');
  /* 악기와 파트 태그는 한 묶음이다. 가운데 자리에서는 이 묶음째 위로 끌어올려
     사람의 아랫부분을 가리고(악기가 앞), 양옆 자리에서는 사람 옆에 통째로 선다.
     묶지 않으면 두 배치에서 끌어올릴 대상이 달라진다. */
  return `<div class="${cls}" style="grid-area:${slot}"`
    + ` data-n="${people.length}" data-role="${escapeHtml(role.role)}"`
    + ` data-peek="${escapeHtml(title)}${people.length ? ' · ' + people.join(', ') : ' · 비어 있음'}">`
    + `<span class="stage-players">${bodies}</span>`
    + `<span class="stage-gear">`
    + `<span class="stage-inst"><svg viewBox="0 0 64 64" aria-hidden="true">${INSTRUMENTS[slot]}</svg></span>`
    + `<span class="stage-tag">${STAGE_LABEL[slot]}</span>`
    + `</span>`
    + `<span class="stage-names">${names}</span>`
    + `</div>`;
}

/* 무대 하나. roles 는 playable 응답의 songs[].roles 를 그대로 넘기면 된다. */
function stageHtml(roles) {
  const bySlot = {};
  const loose = [];
  (roles || []).forEach((r) => {
    const slot = stageSlot(r.role);
    if (slot && !bySlot[slot]) bySlot[slot] = r;
    else if (slot) loose.push(r);       /* 같은 자리가 둘이면 아래 줄로 */
    else loose.push(r);
  });
  const grid = STAGE_ORDER.map((slot) => stageSpot(slot, bySlot[slot])).join('');
  const extra = loose.length
    ? `<div class="stage-extra">${loose.map((r) =>
      `<span class="stage-extra-item"><b>${escapeHtml(r.label || r.role)}</b>`
      + `${(r.members || []).map((n) => avatarChip(n)).join('')}</span>`).join('')}</div>`
    : '';
  return `<div class="stage">${grid}</div>${extra}`;
}
