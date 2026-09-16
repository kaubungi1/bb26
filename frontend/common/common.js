/* 불법이륙 공통 모듈 */

/* 파트와 태그는 여기서만 정의한다. 페이지마다 따로 두면 순서가 어긋난다. */
const ROLE_ORDER = ['보컬', '일렉1', '일렉2', '베이스', '키보드', '드럼'];
const ROLE_SHORT = { 보컬: 'Vo', 일렉1: 'Gt1', 일렉2: 'Gt2', 베이스: 'Ba', 키보드: 'Key', 드럼: 'Dr' };
/* 악보에만 있는 파트 — 파트를 가리지 않는 악보용 */
const SHEET_ROLES = [...ROLE_ORDER, '공용'];
/* 곡과 악보가 같은 목록을 쓴다. 한 곡에 하나만 붙는다. */
const TAGS = ['보컬로이드', '애니송(게임)', 'J-POP(남)', 'J-POP(여)', '불법'];

const SITE_NAME = '불법이륙';

/* ---------- 곡의 얼굴 ----------
   곡을 그리는 화면이면 어디서나 같은 규칙을 쓴다. 홈에만 있던 것을 여기로 옮겼다. */

/* 그 곡의 장르. 태그가 먼저고, 없으면 옛 category, 그것도 없으면 미분류. */
function songGenre(song) {
  return song.tags || song.category || '미분류';
}

/* 장르색 클래스. tokens.css 의 .genre-* 가 --tone/--band 를 채운다. */
const GENRE_TONE = {
  '보컬로이드': 'vocaloid',
  'J-POP(여)': 'jpop-f', 'J POP(여)': 'jpop-f',
  'J-POP(남)': 'jpop-m', 'J POP(남)': 'jpop-m',
  '애니송(게임)': 'anime',
};
function songTone(song) {
  return GENRE_TONE[songGenre(song)] || 'other';
}

/* 섬네일이 없을 때 자리에 깔 글자.
   가나·한자·영숫자만 쓰고 한글은 건너뛴다. 한글 한 글자는 획이 많아
   크게 키우면 뭉개지고, 원제가 일본어인 곡이 대부분이라 원제 쪽이 더 곡을 가리킨다.
   제목에서 못 뽑으면 아티스트에서, 그것도 없으면 음표. */
function songLetter(song) {
  const ok = (c) => {
    const o = c.codePointAt(0);
    return (o >= 0x3040 && o <= 0x30FF) || (o >= 0x4E00 && o <= 0x9FFF) || /[0-9A-Za-z]/.test(c);
  };
  for (const src of [song.title, song.artist || '']) {
    const ch = [...src].filter(ok);
    if (ch.length) return ch[0];
  }
  return '♪';
}

/* 유튜브 주소에서 11자 영상 id. 못 뽑으면 null. backend/thumbs.py 와 같은 규칙이다. */
function youtubeId(url) {
  const m = /(?:v=|youtu\.be\/|\/embed\/|\/shorts\/)([A-Za-z0-9_-]{11})/.exec(url || '');
  return m ? m[1] : null;
}

/* ---------- 길드 문맥 ----------
   /guild/<slug>/… 아래에 있으면 그 길드의 얼굴로 같은 페이지를 보여준다.
   데이터는 하나이고, 목록 API 에 guild=<slug> 만 붙는다. */
const Site = (() => {
  const m = location.pathname.match(/^\/guild\/([a-z0-9-]+)(\/|$)/);
  const slug = m ? m[1] : null;
  return {
    slug,
    base: slug ? `/guild/${slug}` : '',
    info: null,                       /* 길드 정보. mountChrome 이 채운다 */
    /* 목록 API 에 길드 조건을 붙인다. 길드 밖에서는 그대로. */
    q(url) {
      if (!slug) return url;
      return url + (url.includes('?') ? '&' : '?') + 'guild=' + encodeURIComponent(slug);
    },
    /* 만들기 요청 본문에 소속을 붙인다 */
    body(obj) { return slug ? { ...obj, guildSlug: slug } : obj; },
  };
})();

const api = {
  async get(url) {
    const res = await fetch('/api' + url);
    if (!res.ok) throw new Error(await apiError(res));
    return res.json();
  },
  async post(url, body) {
    const isForm = body instanceof FormData;
    const res = await fetch('/api' + url, {
      method: 'POST',
      headers: isForm ? undefined : { 'Content-Type': 'application/json' },
      body: isForm ? body : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(await apiError(res));
    return res.status === 204 ? undefined : res.json();
  },
  async del(url) {
    const res = await fetch('/api' + url, { method: 'DELETE' });
    if (!res.ok) throw new Error(await apiError(res));
  },
  async put(url, body) {
    const res = await fetch('/api' + url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(await apiError(res));
    return res.json();
  },
};

/* FastAPI 는 {detail: 문자열 | 객체} 로 실패를 알린다. 사람이 읽을 문장만 꺼낸다. */
async function apiError(res) {
  const data = await res.json().catch(() => ({}));
  const d = data.detail ?? data.error;
  if (typeof d === 'string') return d;
  if (d && typeof d.message === 'string') return d.message;
  return '요청 실패';
}

const Nick = {
  get() { return localStorage.getItem('nickname') || ''; },
  set(n) { localStorage.setItem('nickname', n); },
  logout() { localStorage.removeItem('nickname'); },
  ensure() {
    const cur = this.get();
    if (cur) return Promise.resolve(cur);
    return promptName();
  },
};

/* 등록된 닉네임 명단. 한 번 받아 두고 재사용한다. */
let ROSTER = null;
async function roster() {
  if (ROSTER) return ROSTER;
  try { ROSTER = await api.get('/members/roster'); } catch { ROSTER = []; }
  return ROSTER;
}

/* 오타를 잡기 위한 비슷한 이름 찾기. 인증이 아니라 실수 방지다. */
function similarNames(input, names) {
  const norm = (x) => x.normalize('NFKC').toLowerCase().replace(/[\s\-_.~!?/()[\]<>]+/g, '');
  const a = norm(input);
  if (!a) return [];
  const score = (b) => {
    const t = norm(b);
    if (!t) return 0;
    if (t === a) return 1;
    if (t.includes(a) || a.includes(t)) return 0.9;
    /* 앞 글자가 겹치는 만큼 점수를 준다. 식빵ㅋ 과 식빵 같은 경우를 잡는다. */
    let i = 0;
    while (i < a.length && i < t.length && a[i] === t[i]) i += 1;
    return i / Math.max(a.length, t.length);
  };
  return names.map((n) => [score(n), n]).filter(([v]) => v >= 0.5)
    .sort((x, y) => y[0] - x[0]).slice(0, 3).map(([, n]) => n);
}

function promptName() {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `
      <div class="modal">
        <h3 class="modal-title">${icon('user')} 닉네임</h3>
        <p class="modal-desc">밴드에서 쓰는 이름을 넣어 주세요.</p>
        <form class="modal-form">
          <input id="nick-input" placeholder="닉네임" maxlength="20" autocomplete="off" autofocus />
          <div id="nick-hint" class="nick-hint" hidden></div>
          <button type="submit" class="pink">확인</button>
          <button type="button" class="ghost" data-cancel>취소</button>
        </form>
      </div>`;
    const close = (v) => { backdrop.remove(); resolve(v); };
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(''); });
    backdrop.querySelector('[data-cancel]').addEventListener('click', () => close(''));

    const hint = backdrop.querySelector('#nick-hint');
    const input = backdrop.querySelector('#nick-input');
    const accept = (name) => { Nick.set(name); document.dispatchEvent(new Event('nickchange')); close(name); };

    backdrop.querySelector('.modal-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = input.value.trim();
      if (!name || name.length > 20) return;
      const names = await roster();
      if (names.includes(name)) return accept(name);

      /* 명단에 없다. 오타인지 되묻는다. 막지는 않는다. */
      const near = similarNames(name, names);
      hint.hidden = false;
      hint.innerHTML =
        `<p class="nick-warn"><b>${escapeHtml(name)}</b> 은(는) 등록된 이름이 아닙니다.</p>` +
        (near.length
          ? `<p class="nick-ask">혹시 이 이름인가요?</p><div class="nick-near">` +
            near.map((n) => `<button type="button" data-pick="${escapeHtml(n)}">${escapeHtml(n)}</button>`).join('') +
            `</div>`
          : '') +
        `<p class="nick-note">한 사람이 이름 하나만 써 주세요. 이름이 갈리면 지원한 곡과 한마디가 따로 쌓입니다.</p>` +
        `<button type="button" class="nick-new" data-new>${escapeHtml(name)} 으로 새로 등록</button>`;
    });

    hint.addEventListener('click', async (e) => {
      const pick = e.target.closest('[data-pick]');
      if (pick) return accept(pick.dataset.pick);
      if (e.target.closest('[data-new]')) {
        const name = input.value.trim();
        if (!name) return;
        try { await api.post('/members/register', { nickname: name }); ROSTER = null; } catch {}
        accept(name);
      }
    });
    input.addEventListener('input', () => { hint.hidden = true; });

    document.body.appendChild(backdrop);
    setTimeout(() => input.focus(), 0);
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const ICONS = {
  music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  fileText: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M16 13H8M16 17H8"/>',
  user: '<path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z"/><path d="M4 21c0-4 3.6-6 8-6s8 2 8 6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  upload: '<path d="M12 15V3M7 8l5-5 5 5"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>',
  paperclip: '<path d="M21.44 11.05 12.25 20.24a6 6 0 0 1-8.49-8.49l9.2-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/>',
  flag: '<path d="M4 22V4"/><path d="M4 4h12l-2 4 2 4H4"/>',
  home: '<path d="M3 11 12 3l9 8"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  shield: '<path d="M12 22s8-3 8-10V5l-8-3-8 3v7c0 7 8 10 8 10z"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  up: '<path d="M12 19V5"/><path d="m5 12 7-7 7 7"/>',
};

function icon(name, size = 18) {
  return `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}

/* 헤더의 내 이름을 누르면 열린다. 프로필 편집과 로그아웃이 여기 모인다.
   닉네임은 바꾸지 않는다. 다른 이름으로 쓰려면 로그아웃하고 다시 들어온다.
   그래야 지원·한마디 기록이 갈라지지 않는다. */
async function nameModal() {
  const cur = Nick.get();
  const changed = await openProfileEditor(cur, { withLogout: true });
  return changed;
}

function startPolling(fn, ms = 5000) {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try { await fn(); } catch (err) { console.error(err); }
    finally { running = false; }
  };
  run();
  return setInterval(run, ms);
}

/* 탭. 악보는 길드 밖 공용이라 길드 안에서도 공용 주소로 간다. */
const TABS = [
  { key: 'home', label: '홈', icon: 'home', href: '/', scoped: true },
  { key: 'songs', label: '곡', icon: 'music', href: '/songs/', scoped: true },
  { key: 'schedule', label: '일정', icon: 'calendar', href: '/schedule/', scoped: true },
  { key: 'sheets', label: '악보', icon: 'fileText', href: '/sheets/', scoped: false },
];

/* 길드 배지 — 곡·일정 옆에 붙는 작은 소속 표시. 색은 길드가 정한 색. */
function guildBadge(guild, extra = '') {
  if (!guild) return '';
  const color = guild.color || 'var(--teal-deep)';
  return `<span class="guild-badge ${extra}" style="--g:${escapeHtml(color)}" title="${escapeHtml(guild.name)}">` +
    `<span>${guild.emblem ? escapeHtml(guild.emblem) + ' ' : ''}${escapeHtml(guild.name)}</span></span>`;
}

/* 임시 로고 마크. 이륙각으로 올라가는 기체.
   실제 로고가 나오면 이 상수의 SVG 만 통째로 교체하면 된다. 다른 곳은 건드릴 필요 없다. */
const BRAND_MARK = '<span class="brand-mark" aria-hidden="true">'
  + '<svg viewBox="0 0 24 24"><path d="M2.5 18.5h13"/><path d="M6 14.2 19.2 5.4a2 2 0 0 1 2.4 3.1L12.3 16"/><path d="m9.4 10.6-3.9-1.1 2-1.5 2.6.6"/></svg>'
  + '</span>';

function mountChrome(activeKey) {
  const header = document.getElementById('app-header');
  if (header) {
    /* 헤더에는 나 하나뿐이라 이름만 쓴다. 아바타 동그라미는 여러 사람이 나오는
       지원자 목록과 한마디 줄에서만 쓴다. */
    const nameBtn = () => {
      const n = Nick.get();
      return n
        ? `<button type="button" class="name-text is-chip" id="name-btn">${avatarChip(n)}<span>${escapeHtml(n)}</span></button>`
        : '<button type="button" class="name-text" id="name-btn">닉네임 입력</button>';
    };
    const brand = () => {
      if (!Site.slug) return `<a class="brand" href="/">${BRAND_MARK}${SITE_NAME}</a>`;
      const g = Site.info;
      const name = g ? g.name : Site.slug;
      const emblem = g && g.emblem ? `<span class="brand-emblem">${escapeHtml(g.emblem)}</span>` : '';
      return `<span class="brand-set">` +
        `<a class="brand-home" href="/">${SITE_NAME}</a>` +
        `<a class="brand is-guild" href="${Site.base}/">${emblem || BRAND_MARK}${escapeHtml(name)}</a></span>`;
    };
    const paintHeader = () => {
      const items = [['home','홈',Site.base+'/'],['songs','곡',Site.base+'/songs/'],['schedule','모임 · 일정',Site.base+'/schedule/'],['sheets','악보','/sheets/'],['guilds','길드','/guilds/'],['members','멤버','/members/']];
      header.innerHTML = brand() + '<nav class="game-nav" aria-label="주요 메뉴">' + items.map(([key,label,href]) => `<a href="${href}"${key===activeKey?' aria-current="page"':''}><span>${label}</span></a>`).join('') + '</nav>' + nameBtn();
    };
    paintHeader();
    header.addEventListener('click', async (e) => {
      if (!e.target.closest('#name-btn')) return;
      if (Nick.get()) await nameModal();
      else await Nick.ensure();
      paintHeader();
    });
    /* 악보 올리기 등 다른 곳에서 닉네임을 정해도 아바타가 따라온다 */
    document.addEventListener('nickchange', paintHeader);
    document.addEventListener('profiles', paintHeader);

    /* 길드 안이면 이름과 색을 받아 헤더를 그 길드로 물들인다 */
    if (Site.slug) {
      api.get(`/guilds/${encodeURIComponent(Site.slug)}`).then((g) => {
        Site.info = g;
        if (g.color) document.documentElement.style.setProperty('--accent', g.color);
        document.title = document.title.replace(SITE_NAME, g.name);
        paintHeader();
        document.dispatchEvent(new Event('guildinfo'));
      }).catch(() => {});
    }
  }

  Profiles.load();

  const tabbar = document.getElementById('app-tabbar');
  if (tabbar) {
    tabbar.innerHTML = TABS.map((t) => `
      <a class="tab-item${t.key === activeKey ? ' active' : ''}" href="${t.scoped ? (Site.base + t.href).replace(/^\/\//, '/') || '/' : t.href}">
        <span class="tab-icon">${icon(t.icon, 20)}</span>
        <span>${t.label}</span>
      </a>`).join('');
  }
}

function fmtDate(iso) {
  return new Date(iso).toLocaleDateString();
}

/* 닉네임 → 항상 같은 색. 사람마다 색이 고정돼야 색만으로 구분이 된다. */
const AVATAR_COLORS = [
  ['#00b8ad', '#e7faf8'],
  ['#ec4899', '#fdeef7'],
  ['#6366f1', '#eef0fe'],
  ['#f59e0b', '#fef5e6'],
  ['#22b8e6', '#e8f7fd'],
  ['#8b5cf6', '#f3eefe'],
  ['#2f9e54', '#e9f6ed'],
  ['#ef4444', '#fdecec'],
];

function nickColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

/* ---------- 멤버 프로필 캐시 ----------
   아바타 칩이 이미지·이모지·색을 따르려면 프로필을 알아야 한다. 페이지당 한 번 받고,
   받은 뒤 'profiles' 이벤트를 쏘면 각 화면이 다시 그린다. */
const Profiles = {
  map: Object.create(null),
  loaded: false,
  async load() {
    try {
      const rows = await api.get('/members');
      this.map = Object.create(null);
      rows.forEach((m) => { this.map[m.nickname] = m; });
      this.loaded = true;
      document.dispatchEvent(new Event('profiles'));
    } catch (e) { /* 프로필이 없어도 첫 글자 칩으로 그려진다 */ }
  },
  get(name) { return this.map[name] || null; },
  /* 프로필을 고친 뒤 캐시에 바로 반영 */
  put(m) { this.map[m.nickname] = m; document.dispatchEvent(new Event('profiles')); },
};

function imageUrl(m) {
  return `/api/members/${encodeURIComponent(m.nickname)}/image?v=${encodeURIComponent(m.updatedAt || '')}`;
}

/* 지원자를 화면에 뭐라고 쓸 것인가.
   nickname 은 누구인지(신원), label 은 그 곡에 본인이 적어둔 표기다.
   합주 시트에서 "3개월뒤쯤의식빵" 처럼 장난스럽게 적던 문화를 그대로 살린다.
   신원 비교는 언제나 nickname 으로 하고, 사람 눈에 보이는 건 이 함수로만 만든다. */
function supportName(sp) {
  return (sp && (sp.label || sp.nickname)) || '';
}

/* 아바타 칩. 이미지 > 이모지 > 첫 글자(한글 1, 영문 2) 순으로 그린다. 색은 본인이 정한 색, 없으면 닉네임 고정색. */
function avatarChip(name, extraClass = '') {
  const m = Profiles.get(name);
  let [fg, bg] = nickColor(name);
  if (m && m.color) { fg = m.color; bg = `color-mix(in srgb, ${m.color} 14%, #fff)`; }
  let body;
  let cls = `avatar-chip ${extraClass}`;
  if (m && m.hasImage) {
    body = `<img src="${imageUrl(m)}" alt="" />`;
    cls += ' has-img';
  } else if (m && m.avatar) {
    body = `<span class="emoji">${escapeHtml(m.avatar)}</span>`;
    cls += ' has-emoji';
  } else {
    body = escapeHtml(/^[a-zA-Z]/.test(name) ? name.slice(0, 2).toUpperCase() : name.slice(0, 1));
  }
  return `<span class="${cls}" style="--chip-fg:${escapeHtml(fg)};--chip-bg:${escapeHtml(bg)}" title="${escapeHtml(name)}">${body}</span>`;
}

function showLoading(el) {
  el.innerHTML = '<div class="loading"><span class="spinner"></span><span>불러오는 중</span></div>';
}
