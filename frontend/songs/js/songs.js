/* 곡 리스트 — 풀은 하나, 길드는 꼬리표. 끌올은 전체에서 한 곡만 30분. */
const PRESET_ROLES = ROLE_ORDER;   /* 목록은 common.js 에서 한 번만 정의한다 */

/* 좁은 화면에서 역할 라벨이 폭을 다 먹지 않도록 */
const CHIP_MAX = 3;
const BUMP_MINUTES = 30;

let songs = [];
let guilds = [];              /* 길드 목록 — 필터 메뉴와 소속 선택에 쓴다 */
let bump = null;              /* 지금 끌올된 곡 {songId, bumpedBy, bumpNote, expiresAt} */
let filterTags = new Set();   /* 태그 필터. 여러 개 고를 수 있고, 비어 있으면 전체 */
/* 길드 필터. '' 전체 | 'none' 길드에 붙지 않은 곡 = 불법이륙 공통 | slug
   곡의 소속은 등록한 자리가 정한다. 길드 페이지에서 넣으면 그 길드, 메인에서 넣으면 공통이다. */
let guildFilter = '';
let query = '';               /* 검색어. 제목·아티스트·업로더에 부분 일치 */
let mineFilter = new URLSearchParams(location.search).has('mine') ? 'in' : ''; /* 지원 여부 */
let sortBy = 'recent';        /* 정렬 기준 — SORTS 의 키 */
let sortDesc = true;          /* true 면 내림차순. 기본은 최신이 위 */
let openDrop = null;          /* 열려 있는 메뉴 — 'mine' | 'guild' | 'tag' | 'sort' | null */
let editingSongId = null;
let moreId = null;            /* 액션을 펼쳐 둔 곡. 평소엔 ⋯ 하나만 보인다 */
let songRouteHandled = false;

const listEl = document.getElementById('song-list');
const bumpSlotEl = document.getElementById('bump-slot');
const searchEl = document.getElementById('search');
const mineLabelEl = document.getElementById('mine-label');
const menuMineEl = document.getElementById('menu-mine');
const guildLabelEl = document.getElementById('guild-label');
const menuGuildEl = document.getElementById('menu-guild');
const tagLabelEl = document.getElementById('tag-label');
const sortLabelEl = document.getElementById('sort-label');
const sortDirEl = document.getElementById('sort-dir');
const menuTagEl = document.getElementById('menu-tag');
const menuSortEl = document.getElementById('menu-sort');
const addBtn = document.getElementById('add-btn');
const sheetEl = document.getElementById('session-sheet');
const sheetTitleEl = document.getElementById('sheet-title');
const sheetSubEl = document.getElementById('sheet-sub');
const sheetMembersEl = document.getElementById('sheet-members');
const sheetActionsEl = document.getElementById('sheet-actions');
let sheetSessionId = null;

/* 길드 안에서는 길드 필터와 소속 선택이 필요 없다 — 이미 그 길드다 */
if (Site.slug) {
  document.getElementById('drop-guild').hidden = true;
  /* 곡 등록 폼의 소속 줄은 모달이 스스로 숨긴다 (Site.slug 가 있으면 고를 것이 없다) */
}

/* 태그는 한 곡에 하나. 고른 태그가 없으면 전체, 있으면 그중 하나에 걸리면 된다. */
function matchesTag(song) {
  return filterTags.size === 0 || filterTags.has(song.tags);
}

function matchesGuild(song) {
  if (!guildFilter) return true;
  if (guildFilter === 'none') return !song.guild;
  return !!song.guild && song.guild.slug === guildFilter;
}

/* 검색은 제목·아티스트·업로더 중 하나라도 부분 일치하면 된다. 대소문자는 가리지 않는다. */
/* 곡으로도 사람으로도 찾는다. "눈보라" 를 치면 눈보라가 들어간 곡이 나온다.
   닉네임과 시트 표기를 둘 다 본다. 화면에 "3개월뒤쯤의식빵" 이라 적혀 있어도
   "식빵" 으로 걸리고, 표기가 "sikbbang" 이어도 닉네임 "식빵" 으로 걸린다. */
function matchesQuery(song) {
  if (!query) return true;
  if ([song.title, song.artist, song.createdBy].some((v) => (v || '').toLowerCase().includes(query))) return true;
  return song.sessions.some((s) => s.supports.some(
    (sp) => (sp.nickname || '').toLowerCase().includes(query) || (sp.label || '').toLowerCase().includes(query)));
}

/* 지원 여부 — 내 닉네임이 그 곡의 어느 세션에든 들어 있으면 지원한 곡이다 */
const MINE = { '': '지원', in: '지원함', out: '미지원' };
function isMine(song) {
  const me = Nick.get();
  return !!me && song.sessions.some((s) => s.supports.some((sp) => sp.nickname === me));
}
function matchesMine(song) {
  if (!mineFilter) return true;
  return isMine(song) === (mineFilter === 'in');
}

/* 곡의 지원자 합계 — 인원순 정렬에 쓴다 */
function supportCount(song) {
  return song.sessions.reduce((n, s) => n + s.supports.length, 0);
}

/* 정렬 기준. 값을 뽑는 함수와 라벨만 두고, 방향은 sortDesc 가 따로 맡는다.
   문자열은 한국어 로케일로 비교하고, 동률이면 최신순으로 2차 정렬한다. */
const SORTS = {
  recent:  { label: '최신',     value: (s) => new Date(s.createdAt).getTime() },
  title:   { label: '제목',     value: (s) => s.title || '' },
  artist:  { label: '아티스트', value: (s) => s.artist || '' },
  creator: { label: '업로더',   value: (s) => s.createdBy || '' },
  members: { label: '인원',     value: supportCount },
  filled:  { label: '충족',     value: (s) => (s.sessions.length ? filledCount(s) / s.sessions.length : 0) },
  played:  { label: '합주일',   value: (s) => s.lastPlayed || '' },
};

function compareSongs(a, b) {
  const va = SORTS[sortBy].value(a);
  const vb = SORTS[sortBy].value(b);
  let c = typeof va === 'string' ? va.localeCompare(vb, 'ko') : va - vb;
  if (sortDesc) c = -c;
  if (c === 0) c = new Date(b.createdAt) - new Date(a.createdAt);
  return c;
}

function sortSessions(sessions) {
  return [...sessions].sort((a, b) => {
    const ia = PRESET_ROLES.indexOf(a.role);
    const ib = PRESET_ROLES.indexOf(b.role);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return a.id - b.id;
  });
}

async function refresh() {
  if (Writes.pending) return;        /* 보내는 중인 쓰기가 끝나면 writes-idle 로 다시 온다 */
  if (songs.length === 0) showLoading(listEl);
  const seq = Writes.seq;
  const same = { changed: false, data: guilds };
  const [s, b, g] = await Promise.all([
    api.poll(Site.q('/songs')),
    api.get('/songs/bump').catch(() => null),
    Site.slug ? Promise.resolve(same) : api.poll('/guilds').catch(() => same),
  ]);
  if (Writes.stale(seq)) return;     /* 기다리는 동안 누른 것이 있으면 이 응답은 낡았다 */
  /* 바뀐 게 없으면 다시 그리지 않는다. 곡 목록을 전부 다시 그리는 데 휴대폰에서 1초가 넘게 걸린다. */
  if (!s.changed && !g.changed && JSON.stringify(b) === JSON.stringify(bump)) return;
  songs = s.data;
  bump = b;
  guilds = g.data;
  render();
  if (!sheetEl.hidden) renderSheet();
}

/* ---------- 도구줄: 지원 · 길드 · 태그 · 정렬 메뉴 ----------
   줄에는 현재 값만 글자로 보이고, 누르면 아래로 메뉴가 열린다.
   태그는 여러 개를 체크하고 메뉴가 열린 채로 즉시 걸러진다.
   정렬은 하나를 고르면 닫히고, 현재 항목을 다시 누르면 방향이 뒤집힌다. */
function renderTools() {
  const counts = {};
  songs.forEach((s) => { if (s.tags) counts[s.tags] = (counts[s.tags] || 0) + 1; });

  mineLabelEl.textContent = MINE[mineFilter];
  document.getElementById('drop-mine').classList.toggle('is-set', !!mineFilter);
  menuMineEl.innerHTML = Object.keys(MINE).map((k) =>
    `<button type="button" class="menu-item${k === mineFilter ? ' is-on' : ''}" data-pick-mine="${k}">${k ? MINE[k] : '전체'}</button>`).join('');

  if (!Site.slug) {
    const gcount = { none: 0 };
    songs.forEach((s) => {
      const k = s.guild ? s.guild.slug : 'none';
      gcount[k] = (gcount[k] || 0) + 1;
    });
    const cur = guilds.find((g) => g.slug === guildFilter);
    guildLabelEl.textContent = !guildFilter ? '길드' : guildFilter === 'none' ? SITE_NAME : (cur ? cur.name : guildFilter);
    document.getElementById('drop-guild').classList.toggle('is-set', !!guildFilter);
    menuGuildEl.innerHTML =
      `<button type="button" class="menu-item${guildFilter ? '' : ' is-on'}" data-pick-guild="">전체<i>${songs.length}</i></button>` +
      `<button type="button" class="menu-item${guildFilter === 'none' ? ' is-on' : ''}" data-pick-guild="none">${SITE_NAME}<i>${gcount.none || ''}</i></button>` +
      guilds.map((g) =>
        `<button type="button" class="menu-item${guildFilter === g.slug ? ' is-on' : ''}" data-pick-guild="${escapeHtml(g.slug)}">` +
        `${escapeHtml(g.name)}${gcount[g.slug] ? `<i>${gcount[g.slug]}</i>` : ''}</button>`).join('');
  }

  const picked = TAGS.filter((t) => filterTags.has(t));
  tagLabelEl.textContent = picked.length === 0 ? '태그'
    : picked.length === 1 ? picked[0]
    : `${picked[0]} +${picked.length - 1}`;
  document.getElementById('drop-tag').classList.toggle('is-set', picked.length > 0);

  menuTagEl.innerHTML =
    `<button type="button" class="menu-item${picked.length ? '' : ' is-on'}" data-pick-tag="">전체<i>${songs.length}</i></button>` +
    TAGS.map((t) =>
      `<button type="button" class="menu-item check${filterTags.has(t) ? ' is-on' : ''}" data-pick-tag="${escapeHtml(t)}">` +
      `${escapeHtml(t)}${counts[t] ? `<i>${counts[t]}</i>` : ''}</button>`).join('');

  sortLabelEl.textContent = SORTS[sortBy].label;
  sortDirEl.textContent = sortDesc ? '▼' : '▲';
  menuSortEl.innerHTML = Object.keys(SORTS).map((k) =>
    `<button type="button" class="menu-item${k === sortBy ? ' is-on' : ''}" data-pick-sort="${k}">` +
    `${SORTS[k].label}${k === sortBy ? `<i>${sortDesc ? '▼' : '▲'}</i>` : ''}</button>`).join('');

  for (const k of ['mine', 'guild', 'tag', 'sort']) {
    document.getElementById(`menu-${k}`).hidden = openDrop !== k;
    document.getElementById(`drop-${k}`).classList.toggle('is-open', openDrop === k);
  }
}

/* 세션 칸. 라벨이 있으면 파트명 대신 라벨을 보여준다 (정렬은 여전히 파트 순). */
function sessionCell(song, session) {
  const supports = session.supports;
  const me = Nick.get();
  const mine = supports.some((s) => s.nickname === me);
  /* 내 것을 맨 앞으로. 칸이 좁아 잘려도 내가 먼저 보인다. */
  const people = [...supports.filter((s) => s.nickname === me),
                  ...supports.filter((s) => s.nickname !== me)];
  /* 표기와 신원을 둘 다 들고 간다. 시트 표기(label)는 그 자체가 기록이자 농담이라
     넉넉하면 그대로 쓰고, 칸이 모자라면 닉네임으로 내려간다. fitNames() 가 정한다. */
  const names = people.map(supportName);
  const nicks = people.map((s) => s.nickname);
  const editing = editingSongId === song.id;
  /* 칸 머리 두 벌. full 은 바꾼 이름(없으면 약칭), short 는 늘 약칭이다.
     넓은 화면은 full, 좁은 화면은 short 를 쓴다 — 어느 쪽을 보일지는 CSS 가 정한다.
     좁은 칸에서 '키보드(브…' 는 읽히지도 않으면서 여섯 칸을 화면 밖으로 밀어낸다. */
  const abbr = ROLE_SHORT[session.role] || session.role;
  const full = session.label || abbr;
  const short = abbr;
  /* 글로 읽히는 자리(쪽지·경고문)에는 약칭을 쓰지 않는다. '보컬' 이라고 적는다. */
  const title = session.label || session.role;

  /* 일단 표기 전원을 쓴다. 넘치면 fitNames() 가 단계를 내린다. */
  const joined = names.join(', ');
  const body = names.length
    ? `<span class="names" data-all="${escapeHtml(joined)}" data-nick="${escapeHtml(nicks.join(', '))}"` +
      ` data-first="${escapeHtml(nicks[0])}" data-n="${names.length}">${escapeHtml(joined)}</span>`
    : `<span class="empty">＋</span>`;

  /* 쪽지에 담을 내용. 여기서는 만들어만 두고 켜지는 않는다.
     켤지 말지는 사람 수가 아니라 실제로 잘렸는지가 정한다 — fitNames() 가 재서 켠다.
     혼자여도 '쿠로(Echoess baa일 때만)' 처럼 길면 잘리고, 그때 볼 방법이 있어야 한다.
     파트 이름을 바꾼 칸은 원래 파트명도 같이 담는다. */
  const peek = names.length
    ? `${title}${session.label ? ` (${session.role})` : ''} · ${names.join(', ')}`
    : (session.label ? `${title} (${session.role})` : '');

  /* 쓰지 않는 자리. 칸은 그대로 두고 꺼진 것만 보인다.
     지우지 않으므로 여섯 칸의 자리가 곡마다 어긋나지 않는다. */
  const off = session.active === false;

  const cls = ['session-cell'];
  if (off) cls.push('off');
  else if (names.length) cls.push('filled');
  if (mine) cls.push('mine');
  if (editing) cls.push('editing');
  if (session.label) cls.push('labeled');
  return `
    <div class="${cls.join(' ')}" data-session="${session.id}" data-song="${escapeHtml(song.title)}" data-role="${escapeHtml(session.role)}"${peek && !off ? ` data-peek-full="${escapeHtml(peek)}"${names.length ? '' : ` data-peek="${escapeHtml(peek)}"`}` : ''}>
      <span class="role short">${escapeHtml(short)}</span><span class="role full">${escapeHtml(full)}</span>
      ${off ? '<span class="names off-mark">안 씀</span>' : body}
      ${editing ? `<button type="button" class="session-label" data-label-session="${session.id}" data-role="${escapeHtml(session.role)}" data-label="${escapeHtml(session.label || '')}" title="파트 이름 바꾸기">✎</button>` : ''}
      ${editing ? `<button type="button" class="session-toggle" data-toggle-session="${session.id}" data-active="${off ? '0' : '1'}" data-role="${escapeHtml(title)}" data-supports="${names.length}" title="${off ? '이 자리 쓰기' : '이 자리 안 쓰기'}">${off ? '켜기' : '끄기'}</button>` : ''}
    </div>`;
}

/* 자켓. 유튜브 섬네일을 우리 서버가 준다. 171장이 한꺼번에 뜨지 않도록 늦게 받는다.
   자켓 자체가 유튜브로 가는 문이다. 줄마다 '▶ 유튜브' 글자를 반복하지 않는다. */
function thumb(song) {
  /* 섬네일이 없으면 홈과 같은 규칙으로 그린다 — 장르색 바탕에 글자 하나.
     빈 회색 칸을 두면 그 줄만 곡이 아닌 것처럼 보인다. 20곡이 여기 해당한다. */
  const inner = song.hasThumb
    ? `<img src="${song.thumbUrl || `/api/songs/${song.id}/thumb`}" alt="" loading="lazy" decoding="async" width="56" height="32">`
    : `<span class="th-mark" aria-hidden="true">${escapeHtml(songLetter(song))}</span>`;
  const cls = `song-thumb genre-${songTone(song)}${song.hasThumb ? '' : ' is-mark'}`;
  if (!song.youtubeUrl) return `<span class="${cls}">${inner}</span>`;
  return `<a class="${cls}" href="${escapeHtml(song.youtubeUrl)}" target="_blank" rel="noreferrer noopener"` +
    ` aria-label="${escapeHtml(song.title)} 유튜브에서 보기" data-peek="유튜브에서 보기">${inner}</a>`;
}

/* 지원자가 1명 이상인 세션 수 */
function filledCount(song) {
  return song.sessions.filter((s) => s.supports.length > 0).length;
}

/* 몇 자리가 찼는가. 다 찬 곡과 빈 자리가 남은 곡을 숫자 하나로 가른다. */
function fillBadge(song) {
  const total = song.sessions.length;
  if (!total) return '';
  const filled = filledCount(song);
  const done = filled === total;
  return `<span class="fill-badge${done ? ' full' : ''}" data-peek="${total}자리 중 ${filled}자리 참">${filled}<i>/${total}</i></span>`;
}

function monthDay(iso) {
  const [, m, d] = iso.split('-');
  return `${Number(m)}/${Number(d)}`;
}

/* 제목 아래 한 줄: 아티스트 · 마지막 합주.
   유튜브는 자켓이 맡고, 충원 현황은 줄 오른쪽 끝으로 뺐다. */
function metaLine(song) {
  const parts = [`<span class="song-artist">${escapeHtml(song.artist)}</span>`];
  if (song.lastPlayed) parts.push(`<span class="song-played" data-peek="마지막 합주">${icon('history', 12)} ${monthDay(song.lastPlayed)}</span>`);
  return parts.join('<span class="meta-sep">·</span>');
}

function sessionEditBtn(song) {
  const open = editingSongId === song.id;
  return `
    <button type="button" class="session-edit${open ? ' open' : ''}" data-add-session="${song.id}" title="세션 추가/삭제">${open ? '닫기' : '＋세션'}</button>`;
}

/* 끌올 버튼. 누가 잡고 있으면 남은 시간을 보여주고, 내가 잡은 곡이면 내릴 수 있다. */
function bumpBtn(song) {
  const me = Nick.get();
  if (bump && bump.songId === song.id) {
    return bump.bumpedBy === me
      ? `<button type="button" class="session-edit" data-unbump="${song.id}">끌올 내리기</button>`
      : `<span class="song-by">${icon('up', 13)} 끌올 중</span>`;
  }
  if (bump) return `<span class="song-by" title="${escapeHtml(bump.bumpedBy)}님이 끌올 중">${icon('up', 13)} ${bumpRemain()}분 뒤</span>`;
  return `<button type="button" class="session-edit" data-bump="${song.id}">${icon('up', 13)} 끌올</button>`;
}

function bumpRemain() {
  if (!bump) return 0;
  return Math.max(0, Math.ceil((new Date(bump.expiresAt) - Date.now()) / 60000));
}

/* 파트는 여섯이 늘 있으므로 만들 것도, 고를 것도 없다. 하는 법만 알린다. */
function rolePicker(song) {
  if (editingSongId !== song.id) return '';
  return `
    <div class="session-picker">
      <span class="session-picker-hint">✎ 자리 이름 바꾸기 · 끄기 / 켜기 로 안 쓰는 자리를 접습니다</span>
    </div>`;
}

function songItem(song) {
  return `
    <div id="song-${song.id}" class="song-item${bump && bump.songId === song.id ? ' is-bumped' : ''}" data-song-id="${song.id}">
      <div class="song-item-head">
        ${thumb(song)}
        <div class="song-item-info">
          <div class="song-title-row">
            <span class="song-title"><span>${escapeHtml(song.title)}</span></span>
            ${!Site.slug ? guildBadge(song.guild) : ''}
            <span class="song-tag${song.tags ? '' : ' none'}"><span>${escapeHtml(song.tags || '태그 없음')}</span></span>
          </div>
          <div class="song-meta">${metaLine(song)}</div>
        </div>
        ${fillBadge(song)}
        <div class="song-item-actions${moreId === song.id ? ' is-open' : ''}">
          ${song.createdBy ? `<span class="song-by">${icon('user', 13)} ${escapeHtml(song.createdBy)}</span>` : ''}
          <span class="row-more-set">
            ${bumpBtn(song)}
            ${sessionEditBtn(song)}
            <button type="button" class="session-edit" data-edit-song="${song.id}">수정</button>
          </span>
          <button type="button" class="row-more" data-more="${song.id}" aria-label="더보기">⋯</button>
        </div>
      </div>
      <div class="sessions">
        ${sortSessions(song.sessions).map((s) => sessionCell(song, s)).join('')}
      </div>
      ${rolePicker(song)}
    </div>`;
}

/* 끌올된 곡은 필터와 정렬을 무시하고 맨 위에 고정된다. 남은 시간이 게이지로 줄어든다. */
function renderBump() {
  const song = bump && songs.find((s) => s.id === bump.songId);
  if (!song) { bumpSlotEl.innerHTML = ''; return; }
  const remain = bumpRemain();
  const pct = Math.min(100, (remain / BUMP_MINUTES) * 100);
  bumpSlotEl.innerHTML = `
    <div class="bump-wrap">
      <div class="bump-strip">
        <span class="bump-label"><span>${icon('up', 12)} 끌올</span></span>
        <span class="bump-by">${avatarChip(bump.bumpedBy)} ${escapeHtml(bump.bumpedBy)}</span>
        ${bump.bumpNote ? `<span class="bump-note">“${escapeHtml(bump.bumpNote)}”</span>` : ''}
        <span class="bump-timer">${remain}분<span class="skew-gauge"><i style="width:${pct}%"></i></span></span>
      </div>
      ${songItem(song)}
    </div>`;
}

/* 이름이 칸에 들어가는지 실제로 재서, 넘치면 한 단계씩 줄인다.

   A  아카, 시엘   전원
   B  아카 +1      첫 이름과 남은 수
   C  2명          수만

   글자 수로 어림하지 않는다. 브라우저가 그린 폭을 본다. 그래야 폰트가 바뀌든
   닉네임에 ㅋㅋㅋ 이 붙든 창을 좁히든 규칙이 그대로 맞는다.

   읽기를 전부 한 번에 하고 쓰기를 전부 한 번에 한다. 화면 계산이 칸마다
   일어나지 않도록 하기 위함이다. 1,026칸이라 섞으면 그만큼 다시 그린다. */
function fitNames() {
  const all = [...listEl.querySelectorAll('.names[data-n]'),
               ...bumpSlotEl.querySelectorAll('.names[data-n]')];
  if (!all.length) return;
  /* 혼자인 칸은 줄이지 않는다. 원문 그대로 두고 길면 CSS 가 … 로 자른다.
     한 사람뿐이면 누구인지 헷갈릴 일이 없어서 표기를 바꿀 이유가 없다.
     다만 재기는 같이 잰다 — 잘렸으면 쪽지가 있어야 하고, 그건 사람 수와 무관하다. */
  const many = all.filter((el) => Number(el.dataset.n) > 1);

  /* 쓰기 — A. 시트 표기 전원으로 되돌린다. 창을 넓히면 다시 원문이 나와야 한다. */
  many.forEach((el) => { el.textContent = el.dataset.all; });

  /* 읽기 — A 가 넘치는 칸 */
  const overA = many.filter((el) => el.scrollWidth > el.clientWidth + 1);

  /* 쓰기 — A′. 표기를 버리고 닉네임으로. 괄호 주석과 농담만 떨어지고 사람은 남는다. */
  overA.forEach((el) => { el.textContent = el.dataset.nick; });

  /* 읽기 — 닉네임으로도 넘치는 칸 */
  const overB = overA.filter((el) => el.scrollWidth > el.clientWidth + 1);

  /* 쓰기 — B. 첫 사람과 남은 수.
     개수를 이름과 한 덩어리로 두면 넘칠 때 개수가 먼저 잘린다. 조각을 나눠
     이름만 … 로 잘리게 하고 개수는 끝에 붙여 둔다. */
  overB.forEach((el) => {
    el.innerHTML = `<span class="nm">${escapeHtml(el.dataset.first)}</span>` +
      `<span class="more">+${Number(el.dataset.n) - 1}</span>`;
  });

  /* 쪽지는 '잘렸으면 켜고 다 보이면 끈다'. 사람 수도 라벨 유무도 보지 않는다.
     한 단계라도 내려간 칸은 이미 원문을 잃었으므로 잘리지 않았어도 켠다 —
     농담 표기는 거기서 산다. 나머지는 지금 눈에 보이는 모양으로 다시 잰다. */
  const lost = new Set(overA);
  all.forEach((el) => {
    const cell = el.closest('.session-cell');
    if (!cell || !cell.dataset.peekFull) return;
    const clipped = lost.has(el) || el.scrollWidth > el.clientWidth + 1;
    if (clipped) cell.setAttribute('data-peek', cell.dataset.peekFull);
    else cell.removeAttribute('data-peek');
  });
}

/* 창 폭이 바뀌면 칸 폭도 바뀐다. 다시 잰다. 연달아 들어오는 동안은 마지막 것만 센다. */
let fitTimer = null;
addEventListener('resize', () => {
  clearTimeout(fitTimer);
  fitTimer = setTimeout(fitNames, 120);
});

/* ---------- 잘린 제목 흘리기 ----------
   목록의 제목은 `text-overflow: ellipsis` 로 잘린다. 잘린 칸만 골라, 잘린 만큼만
   왼쪽으로 밀었다가 되돌린다. 한 바퀴는 멈춤 3초 → 흐름 → 멈춤 1.5초 → 되돌림 0.4초다.

   잘리지 않은 제목은 건드리지 않는다. 움직일 이유가 없는 것이 움직이면 산만하기만 하다.
   주기는 6초로 고정이고 리듬은 CSS 의 @keyframes song-roll 에 있다. 여기서는 잘린 폭만 잰다.
   화면에 보이는 줄만 움직인다. 207곡이 한꺼번에 흐르면 스크롤할 때마다 어지럽다.
   움직임을 줄여 달라고 한 사람에게는 아예 안 건다. */
let rollWatcher = null;

function rollTitles() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  rollWatcher?.disconnect();
  rollWatcher = new IntersectionObserver((entries) => {
    entries.forEach((en) => {
      const el = en.target;
      if (!en.isIntersecting) { el.classList.remove('is-roll'); return; }
      const inner = el.firstElementChild;
      if (!inner) return;
      /* 바깥은 창이고 안의 글자가 지나간다. 바깥을 움직이면 글자는 잘린 채 상자만
         옆줄로 삐져나가고 … 도 그대로 남는다 — 한 번 그렇게 만들었다. */
      const over = inner.scrollWidth - el.clientWidth;
      if (over < 6) return;                     /* 한두 픽셀 차이는 잘린 게 아니다 */
      el.style.setProperty('--roll', `-${over}px`);
      /* 출발을 조금씩 어긋나게. 열 줄이 동시에 움직이면 화면이 물결친다.
         0.4초까지만 어긋낸다 — 더 주면 눈에 띄게 늦게 출발한다. */
      el.style.setProperty('--roll-delay', `${Math.round(Math.random() * 400)}ms`);
      el.classList.add('is-roll');
    });
  }, { rootMargin: '40px' });
  listEl.querySelectorAll('.song-title').forEach((el) => rollWatcher.observe(el));
}

function render() {
  renderTools();
  renderBump();

  const visible = songs
    .filter((s) => !(bump && bump.songId === s.id))
    .filter((s) => matchesMine(s) && matchesGuild(s) && matchesTag(s) && matchesQuery(s))
    .sort(compareSongs);

  /* 제목 옆 숫자. 필터를 걸면 몇 곡이 남았는지 바로 보인다. */
  const countEl = document.getElementById('song-count');
  if (countEl) countEl.textContent = songs.length ? visible.length + (bump ? 1 : 0) : '';

  if (songs.length === 0) {
    listEl.innerHTML = `<p class="muted song-empty">곡이 없습니다. 첫 곡을 추가해 보세요.</p>`;
    return;
  }
  if (visible.length === 0) {
    const why = query ? '검색 결과가 없습니다.'
      : mineFilter === 'in' ? '지원한 곡이 없습니다.'
      : mineFilter === 'out' ? '모든 곡에 지원했습니다.'
      : guildFilter ? '이 소속의 곡이 없습니다.'
      : '이 태그의 곡이 없습니다.';
    listEl.innerHTML = bump ? '' : `<p class="muted song-empty">${why}</p>`;
    return;
  }

  listEl.innerHTML = visible.map(songItem).join('');
  fitNames();
  rollTitles();
  if (!songRouteHandled) {
    const id = Number(new URLSearchParams(location.search).get('song'));
    const target = document.getElementById(`song-${id}`);
    if (target) {
      songRouteHandled = true;
      target.setAttribute('tabindex', '-1');
      requestAnimationFrame(() => { target.scrollIntoView({ block: 'center' }); target.focus({ preventScroll: true }); });
    }
  }
}

/* 이벤트 */
/* 검색 — 입력마다 바로 거른다. 서버를 타지 않으니 한 글자, 자모 하나에도 반응한다. */
searchEl.addEventListener('input', () => {
  query = searchEl.value.trim().toLowerCase();
  render();
});

/* 도구줄 메뉴 열고 닫기 + 항목 고르기 */
document.querySelector('.tool-line').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-drop]');
  if (btn) {
    openDrop = openDrop === btn.dataset.drop ? null : btn.dataset.drop;
    renderTools();
    return;
  }
  const mine = e.target.closest('[data-pick-mine]');
  if (mine) {
    const k = mine.dataset.pickMine;
    if (k && !(await Nick.ensure())) return;   /* 누구인지 알아야 지원 여부를 가른다 */
    mineFilter = k;
    openDrop = null;
    render();
    return;
  }
  const guild = e.target.closest('[data-pick-guild]');
  if (guild) {
    guildFilter = guild.dataset.pickGuild;
    openDrop = null;
    render();
    return;
  }
  const tag = e.target.closest('[data-pick-tag]');
  if (tag) {
    const v = tag.dataset.pickTag;
    if (!v) filterTags.clear();                           /* 전체 — 모두 해제 */
    else if (filterTags.has(v)) filterTags.delete(v);
    else filterTags.add(v);
    render();                                             /* 메뉴는 열린 채로 즉시 걸러진다 */
    return;
  }
  const sort = e.target.closest('[data-pick-sort]');
  if (sort) {
    const k = sort.dataset.pickSort;
    if (k === sortBy) sortDesc = !sortDesc;               /* 같은 항목 다시 누르면 방향 반전 */
    else { sortBy = k; sortDesc = true; }
    openDrop = null;
    render();
  }
});

/* 바깥을 누르거나 Esc 를 치면 닫힌다 */
document.addEventListener('click', (e) => {
  if (openDrop && !e.target.closest('.drop')) { openDrop = null; renderTools(); }
});

/* 곡 등록·수정은 common/songedit.js 의 모달 하나가 맡는다.
   등록과 수정이 고치는 항목이 같아서, 폼을 두 벌 두면 한쪽만 고쳐져 어긋난다. */
async function openEditor(song) {
  const result = await openSongEditor(song);
  /* 서버가 돌려준 곡 하나만 목록에 넣는다. 목록 전체(수백 KB)를 다시 받을 때까지 기다리지 않는다.
     나머지는 뒤에서 폴링이 맞춘다. */
  if (result && typeof result === 'object') {
    const at = songs.findIndex((s) => s.id === result.id);
    if (at >= 0) songs[at] = result; else songs.unshift(result);
    render();
    refresh();
  } else if (result === 'deleted' && song) {
    songs = songs.filter((s) => s.id !== song.id);   /* 목록 전체를 다시 받지 않고 바로 뺀다 */
    render();
    refresh();
  }
  return result;
}
addBtn.addEventListener('click', () => openEditor(null));

async function onListClick(e) {
  const more = e.target.closest('[data-more]');
  if (more) {
    const id = Number(more.dataset.more);
    moreId = (moreId === id) ? null : id;   /* 다시 누르면 접힌다 */
    render();
    return;
  }
  const editBtn = e.target.closest('[data-edit-song]');
  if (editBtn) {
    moreId = null;
    await openEditor(songs.find((s) => s.id === Number(editBtn.dataset.editSong)));
    return;
  }
  const bumpBtnEl = e.target.closest('[data-bump]');
  if (bumpBtnEl) {
    const name = await Nick.ensure();
    if (!name) return;
    const note = prompt('한마디 (선택, 60자)') ;
    if (note === null) return;
    /* 누르는 즉시 끌올로 보이게 하고 서버에 보낸다. 다른 곡이 먼저 잡았으면(409) 되돌리고 알린다. */
    const song = songs.find((s) => s.id === Number(bumpBtnEl.dataset.bump));
    const before = bump;
    bump = { songId: song.id, title: song.title, artist: song.artist, bumpedBy: name,
             bumpNote: note.trim() || null, bumpedAt: new Date().toISOString(),
             expiresAt: new Date(Date.now() + 30 * 60000).toISOString() };
    moreId = null;
    render();
    Writes.run('bump', () => api.post(`/songs/${song.id}/bump`, { nickname: name, note: note.trim() }))
      .then((cur) => { bump = cur; render(); },
            (err) => { bump = before; render(); api.forgetPolls(); alert(err.message); });
    return;
  }
  const unbump = e.target.closest('[data-unbump]');
  if (unbump) {
    const name = Nick.get();
    if (!name) return;
    const before = bump;
    bump = null;
    moreId = null;
    render();
    Writes.run('bump', () => api.del(`/songs/${unbump.dataset.unbump}/bump?nickname=${encodeURIComponent(name)}`))
      .catch((err) => { bump = before; render(); api.forgetPolls(); alert(err.message); });
    return;
  }
  const addSess = e.target.closest('[data-add-session]');
  if (addSess) {
    const id = Number(addSess.dataset.addSession);
    editingSongId = editingSongId === id ? null : id;
    render();
    return;
  }
  const labelBtn = e.target.closest('[data-label-session]');
  if (labelBtn) {
    const cur = labelBtn.dataset.label;
    const input = prompt(`${labelBtn.dataset.role} 자리에 보일 이름 (비우면 원래대로)`, cur);
    if (input === null) return;
    const sid = Number(labelBtn.dataset.labelSession);
    const saved = await Writes.commit(labelBtn, `label:${sid}`,
      () => api.put(`/sessions/${sid}`, { label: input.trim() }));
    if (!saved) return;
    const sess = findSession(sid)?.sess;      /* 돌려받은 이름으로 바로 그린다 */
    if (sess) sess.label = saved.label;
    render();
    return;
  }
  /* 자리를 끄고 켠다. 지우지 않으므로 지원 기록과 자리 번호가 그대로 남는다. */
  const toggleSess = e.target.closest('[data-toggle-session]');
  if (toggleSess) {
    const on = toggleSess.dataset.active === '1';
    const supports = Number(toggleSess.dataset.supports);
    if (on && supports) {
      alert(`${toggleSess.dataset.role} 자리에 지원자 ${supports}명이 있습니다.\n먼저 정리한 뒤에 끌 수 있습니다.`);
      return;
    }
    /* 누르는 즉시 켜고 끈다(common.js Writes). 실패하면 알리고 서버 상태로 되돌아간다. */
    const sid = Number(toggleSess.dataset.toggleSession);
    const sess = findSession(sid)?.sess;
    if (sess) sess.active = !on;
    render();
    Writes.run(`active:${sid}`, () => api.put(`/sessions/${sid}`, { active: !on }))
      .catch((err) => { api.forgetPolls(); alert(err.message); });
    return;
  }
  /* 칸을 누르면 지원되는 게 아니라 파트 상세가 열린다. 홈(home.js)은 같은 칸을 누르면
     즉시 지원·취소된다. 어긋난 것이 아니라 두 화면의 설계 철학이 다르기 때문이다. 맞추지 말 것.

     여기는 보는 화면이다. 한 칸에 지원자 전원과 '이 곡에서 보일 내 이름 ✎' 이 들어가야 하고,
     칸 자체는 fitNames() 가 이름을 '아카 +2' 까지 줄여 놓은 상태라 누가 있는지 다 보이지 않는다.
     모달이 그 한 단계로 정보를 편다. 홈은 고르는 화면이라 동작이 하나로 끝난다(§9.2).

     이 차이를 없애려면 양쪽 화면의 성격을 먼저 다시 정해야 한다. */
  const cell = e.target.closest('.session-cell');
  if (cell && !cell.classList.contains('off')) openSheet(Number(cell.dataset.session));
}
listEl.addEventListener('click', onListClick);
bumpSlotEl.addEventListener('click', onListClick);

/* ---------- 세션 상세 시트 ---------- */
function findSession(id) {
  for (const song of songs) {
    const sess = song.sessions.find((s) => s.id === id);
    if (sess) return { song, sess };
  }
  return null;
}

function openSheet(id) {
  sheetSessionId = id;
  renderSheet();
  sheetEl.hidden = false;
  document.body.style.overflow = 'hidden';
}

function closeSheet() {
  sheetSessionId = null;
  sheetEl.hidden = true;
  document.body.style.overflow = '';
}

function renderSheet() {
  const found = sheetSessionId === null ? null : findSession(sheetSessionId);
  if (!found) { closeSheet(); return; }
  const { song, sess } = found;
  const me = Nick.get();
  const mine = sess.supports.find((sp) => sp.nickname === me);

  /* 잉크 바 제목. 곡 정보·프로필 모달과 같은 부품이라 아이콘을 함께 넣는다. */
  sheetTitleEl.innerHTML = `${icon('user')} ` +
    escapeHtml(sess.label ? `${sess.label} (${sess.role})` : sess.role);
  sheetSubEl.textContent = `${song.title} · ${song.artist}`;

  sheetMembersEl.innerHTML = sess.supports.length
    ? sess.supports.map((sp) => `
        <div class="sheet-member${sp.nickname === me ? ' me' : ''}">
          ${avatarChip(sp.nickname, 'lg')}
          <span class="sheet-member-name">${escapeHtml(supportName(sp))}</span>
          ${sp.nickname === me ? `<button type="button" class="sheet-member-tag" data-sheet-label="${sp.id}" data-label="${escapeHtml(sp.label || '')}" title="이 곡에서 보일 내 이름">나 ✎</button>` : ''}
        </div>`).join('')
    : `<p class="sheet-empty">아직 지원한 멤버가 없습니다.</p>`;

  sheetActionsEl.innerHTML = mine
    ? `<button type="button" class="secondary" data-sheet-cancel="${mine.id}">지원 취소</button>
       <button type="button" class="ghost" data-sheet-close>닫기</button>`
    : `<button type="button" class="pink" data-sheet-support>지원하기</button>
       <button type="button" class="ghost" data-sheet-close>닫기</button>`;
}

sheetEl.addEventListener('click', async (e) => {
  if (e.target === sheetEl || e.target.closest('[data-sheet-close]')) { closeSheet(); return; }
  const id = sheetSessionId;
  if (id === null) return;

  if (e.target.closest('[data-sheet-cancel]')) {
    setSupport(id, Nick.get(), false);
    return;
  }
  const editLabel = e.target.closest('[data-sheet-label]');
  if (editLabel) {
    /* 방금 지원해서 아직 서버 id 를 모르면 저장이 끝날 때까지 기다린다(한순간이다). */
    if (!Number(editLabel.dataset.sheetLabel)) return;
    const input = prompt('이 곡에서 보일 내 이름 (비우면 닉네임 그대로, 20자)', editLabel.dataset.label);
    if (input === null) return;
    const spId = Number(editLabel.dataset.sheetLabel);
    const saved = await Writes.commit(editLabel, `suplabel:${spId}`,
      () => api.put(`/sessions/${id}/support/${spId}`, { label: input.trim() }));
    if (!saved) return;
    const sp = findSession(id)?.sess.supports.find((x) => x.id === spId);   /* 돌려받은 이름으로 바로 그린다 */
    if (sp) sp.label = saved.label;
    render();
    renderSheet();
    return;
  }
  if (e.target.closest('[data-sheet-support]')) {
    const name = await Nick.ensure();
    if (!name) return;
    setSupport(id, name, true);
  }
});

/* 지원·취소. 누르는 즉시 칸을 바꾸고 서버에 보낸다(common.js Writes).
   실패하면 알리고, 쓰기가 끝날 때 서버의 실제 상태로 되돌아간다. */
function setSupport(sid, me, on) {
  const session = songs.flatMap((s) => s.sessions).find((p) => p.id === sid);
  if (!session || !me) return;
  session.supports = session.supports.filter((a) => a.nickname !== me);
  if (on) session.supports.push({ id: null, sessionId: sid, nickname: me, label: null });
  render();
  if (!sheetEl.hidden) renderSheet();
  Writes.run(`sup:${sid}:${me}`, () => (on
    ? api.post(`/sessions/${sid}/support`, { nickname: me })
    : api.del(`/sessions/${sid}/support?nickname=${encodeURIComponent(me)}`)))
    .catch((err) => { api.forgetPolls(); alert(err.message); });
}

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!sheetEl.hidden) closeSheet();
  else if (openDrop) { openDrop = null; renderTools(); }
});

mountChrome('songs');
startPolling(refresh);
document.addEventListener('writes-idle', () => refresh());   /* 누른 것이 다 저장되면 서버 상태로 맞춘다 */

/* 닉네임이 바뀌어도 목록은 그대로다. "내 것" 표시만 다시 그린다(전에는 목록 전체를 다시 받았다). */
document.addEventListener('nickchange', () => { render(); if (!sheetEl.hidden) renderSheet(); });
/* 끌올 남은 시간은 1분마다 다시 그린다 (5초 폴링과 별개로 시계만 맞춘다) */
setInterval(() => { if (bump) render(); }, 60000);
document.addEventListener('profiles', () => render());
if (new URLSearchParams(location.search).has('add')) addBtn.click();
