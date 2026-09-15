/* 대파밀수단 공통 모듈 */

/* 파트와 태그는 여기서만 정의한다. 페이지마다 따로 두면 순서가 어긋난다. */
const ROLE_ORDER = ['보컬', '일렉1', '일렉2', '베이스', '키보드', '드럼'];
const ROLE_SHORT = { 보컬: 'Vo', 일렉1: 'Gt1', 일렉2: 'Gt2', 베이스: 'Ba', 키보드: 'Key', 드럼: 'Dr' };
/* 악보에만 있는 파트 — 파트를 가리지 않는 악보용 */
const SHEET_ROLES = [...ROLE_ORDER, '공용'];
/* 곡과 악보가 같은 목록을 쓴다. 한 곡에 하나만 붙는다. */
const TAGS = ['보컬로이드', '애니송(게임)', 'J-POP(남)', 'J-POP(여)', '불법'];

const api = {
  async get(url) {
    const res = await fetch('/api' + url);
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? '요청 실패');
    return res.json();
  },
  async post(url, body) {
    const isForm = body instanceof FormData;
    const res = await fetch('/api' + url, {
      method: 'POST',
      headers: isForm ? undefined : { 'Content-Type': 'application/json' },
      body: isForm ? body : JSON.stringify(body),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? '요청 실패');
    return res.status === 204 ? undefined : res.json();
  },
  async del(url) {
    const res = await fetch('/api' + url, { method: 'DELETE' });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? '요청 실패');
  },
  async put(url, body) {
    const res = await fetch('/api' + url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? '요청 실패');
    return res.json();
  },
};

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

function promptName() {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `
      <div class="modal">
        <h3 class="modal-title">${icon('user')} 닉네임 입력</h3>
        <p class="modal-desc">세션 지원 시 누가 지원했는지 표시됩니다.</p>
        <form class="modal-form">
          <input id="nick-input" placeholder="닉네임" autofocus />
          <button type="submit" class="pink">확인</button>
          <button type="button" class="ghost" data-cancel>취소</button>
        </form>
      </div>`;
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) { backdrop.remove(); resolve(''); }
    });
    backdrop.querySelector('[data-cancel]').addEventListener('click', () => {
      backdrop.remove(); resolve('');
    });
    backdrop.querySelector('.modal-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const name = backdrop.querySelector('#nick-input').value.trim();
      if (name) { Nick.set(name); backdrop.remove(); resolve(name); }
    });
    document.body.appendChild(backdrop);
    setTimeout(() => backdrop.querySelector('#nick-input')?.focus(), 0);
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const ICONS = {
  music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  dice: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M8 8h.01M16 8h.01M8 16h.01M16 16h.01M12 12h.01"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  fileText: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M16 13H8M16 17H8"/>',
  user: '<path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z"/><path d="M4 21c0-4 3.6-6 8-6s8 2 8 6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  upload: '<path d="M12 15V3M7 8l5-5 5 5"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>',
  paperclip: '<path d="M21.44 11.05 12.25 20.24a6 6 0 0 1-8.49-8.49l9.2-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/>',
};

function icon(name, size = 18) {
  return `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}

function nameModal() {
  return new Promise((resolve) => {
    const cur = Nick.get();
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `
      <div class="modal">
        <h3 class="modal-title">${icon('user')} 닉네임</h3>
        <p class="modal-desc">현재: <strong>${escapeHtml(cur)}</strong> · 변경하거나 로그아웃하세요</p>
        <form class="modal-form">
          <input id="nick-input" placeholder="새 닉네임" autofocus />
          <button type="submit" class="pink">변경</button>
          <button type="button" class="ghost" data-logout>로그아웃</button>
          <button type="button" class="ghost" data-cancel>취소</button>
        </form>
      </div>`;
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) { backdrop.remove(); resolve(false); }
    });
    backdrop.querySelector('[data-cancel]').addEventListener('click', () => {
      backdrop.remove(); resolve(false);
    });
    backdrop.querySelector('[data-logout]').addEventListener('click', () => {
      Nick.logout();
      backdrop.remove();
      document.dispatchEvent(new Event('nickchange'));
      resolve(true);
    });
    backdrop.querySelector('.modal-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const name = backdrop.querySelector('#nick-input').value.trim();
      if (name) {
        Nick.set(name);
        backdrop.remove();
        document.dispatchEvent(new Event('nickchange'));
        resolve(true);
      }
    });
    document.body.appendChild(backdrop);
    setTimeout(() => backdrop.querySelector('#nick-input')?.focus(), 0);
  });
}

function startPolling(fn, ms = 5000) {
  fn();
  setInterval(() => fn().catch(console.error), ms);
}

const TABS = [
  { key: 'songs', label: '곡', icon: 'music', href: '/songs/' },
  { key: 'lottery', label: '추첨', icon: 'dice', href: '/lottery/' },
  { key: 'schedule', label: '일정', icon: 'calendar', href: '/schedule/' },
  { key: 'sheets', label: '악보', icon: 'fileText', href: '/sheets/' },
];

function mountChrome(activeKey) {
  const header = document.getElementById('app-header');
  if (header) {
    /* 닉네임을 정했으면 아바타 칩으로 — 사이트 어디서나 사람은 같은 모양이다.
       아직 안 정했으면 뭘 눌러야 할지 알 수 있게 글자로 둔다. */
    const nameBtn = () => {
      const n = Nick.get();
      return n
        ? `<button type="button" class="name-text is-chip" id="name-btn" title="${n}">${avatarChip(n)}</button>`
        : '<button type="button" class="name-text" id="name-btn">닉네임 입력</button>';
    };
    const paintHeader = () => {
      header.innerHTML = '<span class="brand">대파밀수단</span>' + nameBtn();
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
  }

  const tabbar = document.getElementById('app-tabbar');
  if (tabbar) {
    tabbar.innerHTML = TABS.map((t) => `
      <a class="tab-item${t.key === activeKey ? ' active' : ''}" href="${t.href}">
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

/* 첫 글자 아바타 칩. 한글은 1글자, 영문은 2글자까지. */
function avatarChip(name, extraClass = '') {
  const [fg, bg] = nickColor(name);
  const initial = /^[a-zA-Z]/.test(name) ? name.slice(0, 2).toUpperCase() : name.slice(0, 1);
  return `<span class="avatar-chip ${extraClass}" style="--chip-fg:${fg};--chip-bg:${bg}" title="${name}">${initial}</span>`;
}

function showLoading(el) {
  el.innerHTML = '<div class="loading"><span class="spinner"></span><span>불러오는 중</span></div>';
}
