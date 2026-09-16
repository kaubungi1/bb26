/* 불법이륙 공통 모듈 */

/* 파트와 태그는 여기서만 정의한다. 페이지마다 따로 두면 순서가 어긋난다. */
const ROLE_ORDER = ['보컬', '일렉1', '일렉2', '베이스', '키보드', '드럼'];
/* 파트 약어. 밴드판에서 쓰는 공식 표기다(V · EG1 · EG2 · BG · KY · D).
   화면마다 복사해 두지 않는다 — 전에 home.js 와 stage.js 가 각자 갖고 있었고,
   한 곳만 고치면 화면마다 다른 약어가 떴다. 바꿀 일이 있으면 이 줄만 고친다. */
const ROLE_SHORT = { 보컬: 'V', 일렉1: 'EG1', 일렉2: 'EG2', 베이스: 'BG', 키보드: 'KY', 드럼: 'D' };
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
  /* slug 는 한글일 수 있다. 실제로 길드 13개가 전부 한글이다 — 이름을 그대로 쓰고
     공백만 하이픈으로 바꾼 형태다. 전에는 여기서 [a-z0-9-]+ 만 받아서 그 13개가
     모두 null 이 됐고, 목록에서 '길드 입장하기' 를 눌러도 찾을 수 없다고 떴다.
     슬래시가 아닌 것은 전부 받고 되돌린다. 주소창의 값은 퍼센트 인코딩돼 있다. */
  const m = location.pathname.match(/^\/guild\/([^/]+)(\/|$)/);
  let slug = null;
  if (m) { try { slug = decodeURIComponent(m[1]); } catch { slug = m[1]; } }
  return {
    slug,
    /* 링크를 만드는 값이라 인코딩한 것을 갖는다. 날것을 이어 붙이면 한글 주소가 깨진다. */
    base: slug ? `/guild/${encodeURIComponent(slug)}` : '',
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

/* ---------- 테마 ----------
   길드가 고르는 프리셋. 값은 common/themes.css 에 있고 여기서는 이름만 건다.
   지금은 주소로만 건다 — 길드가 고른 테마를 저장할 칸(guilds.theme)이 아직 없다.
   목록에 있는 이름만 받는다. 자유 문자열을 그대로 꽂으면 CSS 주입이 된다. */
const THEMES = ['takeoff', 'miku', 'melody', 'city', 'temple', 'wood', 'nature', 'medieval', 'sea', 'deepsea'];
function applyTheme(name) {
  if (THEMES.includes(name)) document.documentElement.dataset.theme = name;
  else delete document.documentElement.dataset.theme;
}
/* 주소에 ?theme= 이 있을 때만 건드린다.
   그냥 applyTheme(null) 을 부르면 속성을 지우는데, 서버가 첫 그림이 번쩍이지 않도록
   <html data-theme="…"> 을 박아 보내므로 그걸 곧바로 지워 버린다. */
{
  const q = new URLSearchParams(location.search).get('theme');
  if (q) applyTheme(q);
}

/* ---------- 길드 색 ----------
   길드가 색 하나를 고르면 화면 전체가 그 색을 입는다.

   전에는 --accent 하나만 덮었다. 그런데 사이트는 --teal-deep 을 95곳에서 쓰고
   --teal-soft 를 14곳에서 쓴다. 그 둘이 기본 청록으로 남아서, 길드가 빨강을 골라도
   제목·링크·강조 글자는 청록이었다. 이제 셋을 다 만든다.

   고정 비율로 어둡게 하는 방법은 못 쓴다. #8b2f2f 는 60% 로도 대비 13.5 지만
   #ffff00 은 3.04 라 미달이다. 그래서 색마다 4.5 를 넘을 때까지 실제로 계산한다.
   tokens.css 가 적어둔 기준(본문 글자는 바탕 대비 4.5 이상)을 길드 색에도 지킨다. */
const Tone = {
  rgb(h) {
    h = String(h).trim().replace('#', '');
    if (h.length === 3) h = [...h].map((c) => c + c).join('');
    if (!/^[0-9a-f]{6}$/i.test(h)) return null;
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  },
  hex(c) { return '#' + c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join(''); },
  lum(c) {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  },
  ratio(a, b) {
    const la = this.lum(a), lb = this.lum(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  },
  mix(c, other, pct) { return c.map((v, i) => v * pct + other[i] * (1 - pct)); },
  /* 이 바탕 위에서 목표 대비를 넘을 때까지 바탕 반대쪽으로 당긴다.
     밝은 바탕이면 검정 쪽, 어두운 바탕이면 흰 쪽이다. 5%씩 20번이면 끝에 닿는다.
     전에는 흰 바탕만 가정하고 늘 검정 쪽으로 당겼다 — 어두운 테마에서는
     글자를 바탕에 더 묻는 짓이라 정반대였다. */
  fit(c, bg, target = 4.5) {
    const end = this.lum(bg) > 0.4 ? [0, 0, 0] : [255, 255, 255];
    for (let p = 1; p >= 0; p -= 0.05) {
      const t = this.mix(c, end, p);
      if (this.ratio(t, bg) >= target) return t;
    }
    return end;
  },
  /* 이 색을 바탕으로 깔았을 때 그 위에 얹을 글자색.
     흰 글자가 되면 흰 글자를, 안 되면 같은 색을 어둡게 당겨 쓴다.
     고정 비율로 어둡게 하면 #ef2f88 같은 색에서 4.48 로 아슬하게 미달한다. */
  onTop(c, target = 4.5) {
    const W = [255, 255, 255];
    if (this.ratio(c, W) >= target) return W;
    for (let p = 0.6; p >= 0; p -= 0.05) {
      const t = this.mix(c, [0, 0, 0], p);
      if (this.ratio(c, t) >= target) return t;
    }
    return [0, 0, 0];
  },
};
/* 길드가 정한 색 하나에서 파생 토큰을 만든다.

   섞을 상대는 흰색이 아니라 '지금 테마의 종이색' 이다. 전에는 전부 흰색에 섞었는데,
   도시 같은 어두운 테마에서 --mine 이 거의 흰 민트가 되고 그 위에 밝은 --ink 글자가
   얹혀 아무것도 안 읽혔다. 파티창의 내 자리가 실제로 그렇게 됐다.
   밝은 테마는 종이색이 흰색이라 결과가 전과 같다 — 화면이 안 바뀐다. */
function applyGuildColor(color) {
  const c = Tone.rgb(color);
  if (!c) return;
  const root = document.documentElement.style;
  const paper = Tone.rgb(getComputedStyle(document.documentElement).getPropertyValue('--paper'))
    || [255, 255, 255];
  root.setProperty('--accent', Tone.hex(c));
  root.setProperty('--accent-deep', Tone.hex(Tone.fit(c, paper)));
  root.setProperty('--accent-soft', Tone.hex(Tone.mix(c, paper, 0.14)));
  root.setProperty('--on-accent', Tone.hex(Tone.onTop(c)));
  /* 내가 낀 자리. 글자가 얹히므로 종이색 쪽으로 충분히 옅게 둔다. */
  root.setProperty('--mine', Tone.hex(Tone.mix(c, paper, 0.34)));
  root.setProperty('--mine-hover', Tone.hex(Tone.mix(c, paper, 0.46)));
}

/* 판 위(길드 이름·모집 버튼·GUILD 라벨)에 앉는 글자색.
   기본은 applyGuildColor 가 4.5 를 넘도록 계산한 값이고, 길드가 직접 고르면 그 값이 이긴다.
   hex 가 없으면 지금 강조색에서 다시 계산한다 — '자동' 으로 되돌리는 길이다. */
function applyGuildInk(hex) {
  const root = document.documentElement.style;
  if (hex && /^#[0-9a-f]{6}$/i.test(hex)) { root.setProperty('--on-accent', hex); return; }
  const acc = Tone.rgb(getComputedStyle(document.documentElement).getPropertyValue('--accent'));
  if (acc) root.setProperty('--on-accent', Tone.hex(Tone.onTop(acc)));
  else root.removeProperty('--on-accent');
}

/* 걸어 둔 길드색을 떼고 테마가 정한 값으로 돌려놓는다.
   편집 창에서 색을 골라 보다가 취소했을 때 쓴다. */
function clearGuildColor() {
  const root = document.documentElement.style;
  ['--accent', '--accent-deep', '--accent-soft', '--on-accent', '--mine', '--mine-hover']
    .forEach((k) => root.removeProperty(k));
}

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

/* 되묻는 창. 브라우저 confirm() 은 사이트와 다른 얼굴로 뜨고, 문장 말고는 아무것도 못 담는다.
   body 는 HTML 이므로 부르는 쪽이 escapeHtml 을 거쳐 넘긴다.
   곡·악보는 아직 native confirm() 을 쓴다 — 그 페이지를 개선할 때 이리로 옮긴다. */
function confirmModal({ title, body, confirm = '확인', cancel = '취소', danger = false }) {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `
      <div class="modal confirm-modal" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
        <h3 class="modal-title" id="confirm-title">${escapeHtml(title)}</h3>
        <div class="modal-form">
          <p class="confirm-body">${body}</p>
          <button type="button" class="${danger ? 'danger' : 'pink'}" data-ok>${escapeHtml(confirm)}</button>
          <button type="button" class="ghost" data-no>${escapeHtml(cancel)}</button>
        </div>
      </div>`;
    const previousFocus = document.activeElement;
    const close = (v) => {
      document.removeEventListener('keydown', onKey);
      backdrop.remove();
      previousFocus?.focus();
      resolve(v);
    };
    const onKey = (e) => { if (e.key === 'Escape') close(false); };
    document.addEventListener('keydown', onKey);
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop || e.target.closest('[data-no]')) close(false);
      else if (e.target.closest('[data-ok]')) close(true);
    });
    document.body.appendChild(backdrop);
    backdrop.querySelector('[data-ok]').focus();
  });
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
  sliders: '<path d="M4 6h8M17 6h3M4 12h3M12 12h8M4 18h10M19 18h1"/><circle cx="14.5" cy="6" r="2"/><circle cx="9.5" cy="12" r="2"/><circle cx="16.5" cy="18" r="2"/>',
  pencil: '<path d="M4 20h4l10.5-10.5a2.83 2.83 0 1 0-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
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

/* 길드 배지 — 곡·일정 옆에 붙는 작은 소속 표시. 색은 길드가 정한 색.
   앞에 붙는 그림은 길드 문장이다. crest.js 를 안 싣는 페이지도 있으므로 있을 때만 그린다. */
function guildBadge(guild, extra = '') {
  if (!guild) return '';
  const color = guild.color || 'var(--teal-deep)';
  const mark = (typeof crestFor === 'function' && crestFor(guild, 13)) || '';
  return `<span class="guild-badge ${extra}" style="--g:${escapeHtml(color)}" title="${escapeHtml(guild.name)}">` +
    `${mark}<span>${escapeHtml(guild.name)}</span></span>`;
}

/* 임시 로고 마크. 이륙각으로 올라가는 기체.
   실제 로고가 나오면 이 상수의 SVG 만 통째로 교체하면 된다. 다른 곳은 건드릴 필요 없다. */
/* 공식 로고. 1782×780 투명 PNG 이고, 글자(不法離陸)가 그림에 들어 있어
   옆에 사이트 이름을 따로 쓰지 않는다. 이름은 alt 가 들고 간다.
   로고를 갈 때는 frontend/assets/logo.png 만 바꾸면 된다. */
const BRAND_MARK = `<img class="brand-mark" src="/assets/logo.png" alt="${SITE_NAME}" />`;

function mountChrome(activeKey) {
  Profiles.seed();                    /* 헤더를 그리기 전에 내 프로필을 채운다 */
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
      if (!Site.slug) return `<a class="brand" href="/">${BRAND_MARK}</a>`;
      const g = Site.info;
      const name = g ? g.name : Site.slug;
      /* 길드 이름 앞의 문장. 이모지 엠블럼을 대신한다. */
      const svg = (g && typeof crestFor === 'function' && crestFor(g, 26)) || '';
      const crestMark = svg ? `<span class="brand-emblem">${svg}</span>` : '';
      /* 길드 안이라는 걸 이름만으로는 알기 어렵다. GUILD 라벨을 붙이고
         헤더 아래 선을 길드 색으로 물들인다(common.css 의 .app-bar.is-guild). */
      return `<span class="brand-set">` +
        `<a class="brand-home" href="/">${BRAND_MARK}</a>` +
        `<a class="brand is-guild" href="${Site.base}/">${crestMark}` +
        `<span class="brand-guild"><span class="overline"><span>GUILD</span></span>` +
        `<b>${escapeHtml(name)}</b></span></a></span>`;
    };
    /* 내비는 두 덩이다. 앞 셋은 길드 안에 머물고 뒤 셋은 길드 밖으로 나간다.
       전에는 여섯이 똑같이 생겨서, 악보를 누르면 길드에서 나가는데 아무 표시가 없었다.
       나가는 쪽에 ↗ 를 달고 사이를 벌린다. 길드 밖에서는 둘이 같은 곳이라 표시가 없다.
       길드 안의 첫 항목은 '홈' 이 아니라 길드 이름이다 — 어디로 가는지가 글자에 나온다. */
    const paintHeader = () => {
      const inGuild = !!Site.slug;
      const homeLabel = inGuild ? ((Site.info && Site.info.name) || Site.slug) : '홈';
      const inside = [['home',homeLabel,Site.base+'/'],['songs','곡',Site.base+'/songs/'],['schedule','모임 · 일정',Site.base+'/schedule/']];
      const outside = [['sheets','악보','/sheets/'],['guilds','길드','/guilds/'],['members','멤버','/members/']];
      const link = ([key,label,href],out) => `<a href="${href}"${key===activeKey?' aria-current="page"':''}${out&&inGuild?' class="is-out"':''}><span>${escapeHtml(label)}</span></a>`;
      header.innerHTML = brand() +
        `<nav class="game-nav${inGuild?' in-guild':''}" aria-label="주요 메뉴">` +
        inside.map((it) => link(it, false)).join('') +
        (inGuild ? '<span class="nav-gap" aria-hidden="true"></span>' : '') +
        outside.map((it) => link(it, true)).join('') +
        '</nav>' + nameBtn();
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
      header.classList.add('is-guild');
      /* 이름·색·문장만 있으면 헤더는 완성된다. 그 셋을 먼저 그리고 응답을 기다린다. */
      const seen = Seen.get('guild:' + Site.slug);
      if (seen) {
        Site.info = seen;
        if (seen.color) applyGuildColor(seen.color);
        applyGuildInk(seen.style?.ink);
        paintHeader();
      }
      api.get(`/guilds/${encodeURIComponent(Site.slug)}`).then((g) => {
        Site.info = g;
        /* 길드가 고른 테마. 주소의 ?theme= 이 있으면 그쪽이 이긴다 — 미리보기용이다.
           색보다 먼저 걸어야 한다. applyGuildColor 가 지금 테마의 --paper 를 읽어서
           섞기 때문에, 순서가 뒤집히면 어두운 테마인데 흰 종이 기준으로 계산한다. */
        if (!new URLSearchParams(location.search).get('theme')) applyTheme(g.style?.theme || null);
        if (g.color) applyGuildColor(g.color);
        applyGuildInk(g.style?.ink);
        document.title = document.title.replace(SITE_NAME, g.name);
        paintHeader();
        Seen.set('guild:' + Site.slug, { name: g.name, color: g.color, style: g.style });
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

/* ---------- 진짜 보이는 높이 ----------
   모바일에서 키보드가 올라오면 화면의 아래 절반이 가려지는데, CSS 의 dvh 는 그걸
   계산에 넣지 않는다. 그래서 모달이 화면 전체 높이인 채로 가운데 서고 저장 버튼이
   키보드 밑에 깔린다 — 어디를 밀어도 닿을 수 없다.
   visualViewport 는 키보드를 뺀 높이를 알려 준다. 그 값을 --vvh 에 넣어 두면
   모달이 키보드 위로 줄어들고, 넘치는 만큼 안에서 스크롤된다.
   이 API 가 없는 브라우저에서는 아무것도 안 하고 dvh 로 떨어진다. */
(() => {
  const vv = window.visualViewport;
  if (!vv) return;
  const put = () => document.documentElement.style.setProperty('--vvh', vv.height + 'px');
  put();
  vv.addEventListener('resize', put);
})();

/* 커서가 옮겨간 칸이 화면 밖이면 끌어온다. 키보드가 막 올라온 직후에 자주 그렇다. */
document.addEventListener('focusin', (e) => {
  const el = e.target;
  if (!el.matches || !el.matches('input, textarea, select')) return;
  if (!el.closest('.modal-backdrop')) return;
  setTimeout(() => el.scrollIntoView({ block: 'nearest' }), 120);
});

/* ---------- 마지막으로 본 값 ----------
   헤더의 길드 문장과 내 프로필 사진은 API 응답이 와야 그려진다. 그래서 페이지를 옮길
   때마다 한 번 사라졌다가 나타났다. 마지막으로 본 값을 남겨 두고 그것으로 먼저 그린 뒤,
   응답이 오면 덮어쓴다. 요청 수는 그대로고, 문장 SVG 와 사진 파일은 이미 브라우저
   캐시에 있어서 곧바로 뜬다.

   localStorage 를 막아 둔 브라우저에서는 조용히 실패하고 전과 똑같이 동작한다 —
   한 박자 늦게 뜰 뿐이다. 그래서 읽기·쓰기를 전부 감싼다. */
const Seen = {
  get(key) {
    try { return JSON.parse(localStorage.getItem('seen:' + key) || 'null'); } catch { return null; }
  },
  set(key, value) {
    try { localStorage.setItem('seen:' + key, JSON.stringify(value)); } catch { /* 사생활 보호 창 */ }
  },
};

/* ---------- 멤버 프로필 캐시 ----------
   아바타 칩이 이미지·이모지·색을 따르려면 프로필을 알아야 한다. 페이지당 한 번 받고,
   받은 뒤 'profiles' 이벤트를 쏘면 각 화면이 다시 그린다. */
const Profiles = {
  map: Object.create(null),
  loaded: false,
  /* 내 것만 미리 채운다. 헤더의 아바타가 /members 왕복을 기다리지 않게 한다. */
  seed() {
    const n = Nick.get();
    const m = n && Seen.get('me:' + n);
    if (m) this.map[n] = m;
  },
  async load() {
    try {
      const rows = await api.get('/members');
      this.map = Object.create(null);
      rows.forEach((m) => { this.map[m.nickname] = m; });
      this.loaded = true;
      const me = Nick.get();
      if (me && this.map[me]) Seen.set('me:' + me, this.map[me]);
      document.dispatchEvent(new Event('profiles'));
    } catch (e) { /* 프로필이 없어도 첫 글자 칩으로 그려진다 */ }
  },
  get(name) { return this.map[name] || null; },
  /* 프로필을 고친 뒤 캐시에 바로 반영 */
  put(m) {
    this.map[m.nickname] = m;
    if (m.nickname === Nick.get()) Seen.set('me:' + m.nickname, m);
    document.dispatchEvent(new Event('profiles'));
  },
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
