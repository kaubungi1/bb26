/* 길드 홈 (/guild/<slug>/).

   파일이 frontend/guild/ 가 아니라 frontend/guild-home/ 에 있다. main.py 의
   /guild/{slug}/{path:path} 가 /guild/ 로 시작하는 주소를 전부 삼켜서,
   /guild/js/guild.js 를 걸면 slug="js" 로 읽혀 404 가 난다. 되돌리지 말 것.

   전에는 이 주소가 메인 파일(frontend/index.html)을 그대로 내려받아서, 길드 페이지라는
   것이 따로 없었다. 메인에 if(guild) 를 덧댄 화면이었다. 이제 자기 파일을 갖는다.

   화면 순서는 §9.2 의 U1 에서 나온다 — 여기 오는 사람은 "다음 언제 모여" 와
   "무슨 곡 하지" 를 하러 온다. 그래서 그 둘이 위에 오고, 둘 다 이 화면에서 끝난다.

   곡·일정을 더 보려면 /guild/<slug>/songs/ · /schedule/ 로 간다. 이미 있는 화면이라
   여기서 다시 만들지 않는다. 악보는 곡에 붙는 것이라 길드로 나누지 않는다 — 전체 공용이다.

   길드 안이므로 곡·일정에 길드 배지를 달지 않는다. 다 같은 길드다.
   밖(메인·곡 목록)에서는 배지와 함께 그대로 보인다 — 길드 사정이 밖에서 안 보이면
   위화감이 생긴다는 것이 이 사이트의 규칙이다. */
(() => {
const $ = (s) => document.querySelector(s);
const esc = escapeHtml;
const DOW = ['일', '월', '화', '수', '목', '금', '토'];

let guild = null, songs = [], events = [], busy = false;

const PARTY_OPEN = 'bb26-party-open:' + Site.base;
let partyOpen = (() => { try { return localStorage.getItem(PARTY_OPEN) !== '0'; } catch { return true; } })();

const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(new Date());
const dayLabel = (d) => {
  const t = new Date(d + 'T00:00:00+09:00');
  return `${+d.slice(5, 7)}/${+d.slice(8, 10)} (${DOW[t.getDay()]})`;
};

/* 앞으로 올 일정. 투표 중이면 후보 날짜 중 하나라도 오늘 이후면 남는다. */
function upcoming() {
  const t = today();
  return events
    .filter((e) => (e.status === 'poll' ? e.dates.some((d) => d.date >= t) : e.date >= t))
    .sort((a, b) => {
      const at = (e) => e.date || e.dates.map((d) => d.date).filter((d) => d >= t).sort()[0] || '9999';
      return at(a).localeCompare(at(b));
    });
}
function past() {
  const t = today();
  return events.filter((e) => e.status !== 'poll' && e.date && e.date < t)
    .sort((a, b) => b.date.localeCompare(a.date));
}

/* ---------- 길드 머리 ----------
   로고·이름·색이 사는 자리다. 꾸미기(테마·로고·배경)가 붙을 곳이 여기다. */
/* ---------- 길드 판 ----------
   곡 자켓(home.js jacket())과 같은 문법을 길드 크기로 키운 것이다.
   자켓은 [섬네일 → 잉크 띠 → 파트 여섯 칸] 이고, 여기는 [색 판 → 스탯 줄 → 파트 여섯 칸] 이다.

   테두리도 모서리 장식도 쓰지 않는다. 면과 면이 맞붙어 있는 것, 그리고 글자 크기 차이가
   덩어리를 만든다. 사이트에서 가장 게임 같은 화면인 자켓이 그 방법으로 됐다.

   장식(브래킷·리벳·액자)은 정보를 가리면서 아무것도 말하지 않는다. §9.3 이 지목한 것이다. */
/* 문장. 우선순위는 조합 문장 > 이모지 > 이름 첫 글자다.
   조합 문장은 common/crest.js 가 [육각 틀 + 문양 + 색 둘] 로 그린다.
   아직 저장할 칸(guilds.style)이 없어서 지금은 ?crest= 로만 건다 — 눈으로 고르는 용도다. */
/* 주소의 ?crest= 는 저장된 값보다 이긴다 — 저장하기 전에 눈으로 고르는 용도다.
   live 는 편집 모달이 고르는 중에 넘겨주는 값이고, 취소하면 원래대로 돌아온다. */
let liveStyle = null;
const styleNow = () => liveStyle || guild?.style || {};
function crest() {
  /* 사진 > 문양 > 이름 첫 글자. 주소의 ?crest= 는 눈으로 고르는 용도라 사진보다 앞이다. */
  const q = crestFromQuery();
  if (!q && guild.hasImage) return `<span class="g-crest-svg">${crestFor(guild, 76)}</span>`;
  const c = q || crestSafe(styleNow().crest);
  if (c) return `<span class="g-crest-svg">${crestSvg(c, 76)}</span>`;
  return `<span class="g-crest-mark is-letter">${esc([...guild.name][0] || '?')}</span>`;
}
function head() {
  const n = new Set(guild.members.map((m) => m.nickname)).size;
  const me = Nick.get();
  const mine = !!me && guild.members.some((m) => m.nickname === me);
  const have = new Set(guild.members.map((m) => m.role));
  const openRoles = ROLE_ORDER.filter((r) => !have.has(r));
  /* 길드의 지금 상태가 가장 길드다운 정보다. 빈 파트가 곧 모집 공고다. */
  const status = openRoles.length
    ? `<span class="g-open"><span>${openRoles.map((r) => ROLE_SHORT[r] || r).join(' · ')} 모집</span></span>`
    : '<span class="g-open is-full"><span>정원 마감</span></span>';
  return `<section class="g-plate">
    <div class="g-plate-top">
      <span class="g-crest">${crest()}</span>
      <div class="g-title">
        <span class="overline"><span>GUILD</span></span>
        <h1>${esc(guild.name)}</h1>
        ${(() => {
          /* 팀장·슬로건·모집 문구를 이름 아래 한 줄로 모은다. 전에는 파티창 밑에 꼬리처럼
             달려 있었는데, 그 자리는 좁고 판은 이름 오른쪽이 통째로 비어 있었다. */
          const line = [
            guild.leader ? `팀장 ${esc(guild.leader)}` : '',
            guild.slogan ? esc(guild.slogan) : '',
            guild.recruitNote ? esc(guild.recruitNote) : '',
          ].filter(Boolean).join('<i aria-hidden="true">·</i>');
          return line ? `<p class="g-slogan">${line}</p>` : '';
        })()}
      </div>
      <div class="g-plate-side">${status}${mine ? '<span class="g-mine-mark"><span>내 길드</span></span>' : ''}</div>
    </div>
    <div class="g-stats">
      <span class="g-stat"><b>${n}</b><small>단원</small></span>
      <span class="g-stat"><b>${ROLE_ORDER.length - openRoles.length}</b><small>/${ROLE_ORDER.length} 파트</small></span>
      <span class="g-stat"><b>${songs.length}</b><small>곡</small></span>
      <span class="g-stat"><b>${past().length}</b><small>합주</small></span>
      ${mine ? `<button type="button" class="g-edit" data-draw-guild>${icon('pencil', 14)}<span>그리기</span></button>` : ''}
      <button type="button" class="g-edit" data-edit-guild>${icon('sliders', 14)}<span>편집</span></button>
    </div>
  </section>`;
}

/* ---------- 다음 합주 ----------
   참석과 날짜 투표가 같은 API 하나다. 여기서 끝난다 — 일정 페이지로 나가지 않는다(§9.2).
   새 일정 만들기와 확정은 가끔 하는 일이라 일정 페이지에 그대로 둔다. */
function nextPractice() {
  const e = upcoming()[0];
  /* 지금 13개 길드가 전부 이 상태다. 빈 화면이 기본 화면이므로 한 줄로 흘리지 않는다 —
     무엇이 없는지, 그래서 뭘 하면 되는지를 말한다. */
  if (!e) {
    return `<section class="next-practice is-none">
      <span class="overline"><span>NEXT</span></span>
      <p class="g-empty-title">잡힌 합주가 없습니다</p>
      <p class="g-empty-sub">날짜 후보를 올리면 단원들이 되는 날을 고릅니다.</p>
      <a class="g-cta" href="${Site.base}/schedule/">합주 날짜 잡기 →</a></section>`;
  }
  const me = Nick.get();
  const head = `<span class="overline"><span>NEXT</span></span><h2>${esc(e.title)}</h2>`;
  const more = `<a href="${Site.base}/schedule/?event=${e.id}">일정 자세히 →</a>`;
  if (e.status !== 'poll') {
    const going = e.avails.some((a) => a.nickname === me && a.date === e.date);
    const who = e.avails.filter((a) => a.date === e.date);
    const when = dayLabel(e.date)
      + (e.startTime ? ' · ' + esc(e.startTime) + (e.endTime ? ' ~ ' + esc(e.endTime) : '') : '')
      + (e.place ? ' · ' + esc(e.place) : '');
    return `<section class="next-practice" data-event="${e.id}">
      <div class="np-head">${head}<p class="np-when">${when}</p></div>
      <div class="np-who">${who.length
        ? who.map((a) => `<span class="np-face">${avatarChip(a.nickname)}<span>${esc(a.nickname)}</span></span>`).join('')
        : '<span class="muted">아직 아무도 없습니다</span>'}</div>
      <div class="np-act">
        <button type="button" class="np-go${going ? ' is-on' : ''}" data-avail="${esc(e.date)}" aria-pressed="${going}">${going ? '참석 취소' : '참석'}</button>
        ${more}</div></section>`;
  }
  const days = e.dates.map((d) => d.date).filter((d) => d >= today()).sort();
  return `<section class="next-practice is-poll" data-event="${e.id}">
    <div class="np-head">${head}<p class="np-when">날짜 투표 중 · ${days.length}일 중 되는 날</p></div>
    <div class="np-days">${days.map((d) => {
      const n = e.avails.filter((a) => a.date === d).length;
      const on = e.avails.some((a) => a.nickname === me && a.date === d);
      return `<button type="button" class="np-day${on ? ' is-on' : ''}" data-avail="${esc(d)}" aria-pressed="${on}">${dayLabel(d)}<i>${n}</i></button>`;
    }).join('')}</div>
    <div class="np-act">${more}</div></section>`;
}

/* ---------- 파티창 ----------
   common/party.js 가 그린다. 길드 목록(/guilds/)과 같은 부품이다.
   사람이 많은 길드는 첫 판을 통째로 먹어서 접을 수 있게 둔다. 상태는 기억한다. */
/* 파티창은 길드 판에 이어 붙는다 — 자켓에서 여섯 칸이 잉크 띠 바로 아래 붙는 것과 같다.
   사이에 여백을 두면 두 덩어리로 갈라져서 하나로 안 읽힌다. */
function partySection() {
  return `<section class="g-party">
    <button type="button" class="g-fold" data-party-fold aria-expanded="${partyOpen}">
      <span class="overline"><span>PARTY</span></span>
      <small>${new Set(guild.members.map((m) => m.nickname)).size}명</small>
      <i aria-hidden="true">${partyOpen ? '접기 ▴' : '펼치기 ▾'}</i>
    </button>
    ${partyOpen ? partyWindow(guild, { foot: false }) : ''}
  </section>`;
}

/* ---------- 길드 곡 ----------
   빈 파트가 있는 곡을 먼저 보여준다. 여기 와서 할 일은 "내가 낄 자리 찾기" 다.
   칸을 누르면 그 자리에 바로 지원한다 — 메인 홈과 같은 규칙이다.
   고르는 화면 전체는 /guild/<slug>/songs/ 에 이미 있어서 여기서 다시 만들지 않는다. */
const ORDER = ROLE_ORDER;
const baseRole = (r) => ORDER.find((k) => r.startsWith(k))
  || (r.startsWith('기타') || r.startsWith('일렉') ? '일렉1' : r.startsWith('보') ? '보컬' : '');
const abbr = (r) => ROLE_SHORT[baseRole(r)] || r.replace(/[()]/g, '').slice(0, 2);
const ordered = (s) => [...s.sessions].sort((a, b) =>
  ((ORDER.indexOf(baseRole(a.role)) + 1) || 99) - ((ORDER.indexOf(baseRole(b.role)) + 1) || 99) || a.id - b.id);

function songsSection() {
  const me = Nick.get();
/* 한 칸에 누가 있는지. 숫자만 쓰면 '누가' 를 못 알려 주고, 터치에서는 쪽지도 안 뜬다.
   한 명이면 이름이 들어갈 폭이 나오므로 이름을 쓴다. 둘부터는 칩이 이름보다 좁다.
   칩은 사람마다 색이 고정이라 작아도 구분이 된다(avatarChip). */
function slotWho(names) {
  if (!names.length) return '<u></u>';
  if (names.length === 1) return `<u class="one">${esc(names[0])}</u>`;
  const shown = names.slice(0, 2).map((n) => avatarChip(n)).join('');   /* 크기는 CSS 가 정한다 */
  const rest = names.length - 2;
  return `<u class="chips">${shown}${rest ? `<b>+${rest}</b>` : ''}</u>`;
}

  /* 빈 자리가 많은 곡이 위로. 같으면 최근 등록 순. */
  const rows = [...songs].sort((a, b) => {
    const empty = (s) => s.sessions.filter((p) => !p.supports.length).length;
    return empty(b) - empty(a) || b.id - a.id;
  }).slice(0, 6);
  return `<section class="g-songs">
    <div class="g-sec-head">
      <div><span class="overline"><span>SONGS</span></span><h2>길드 곡<small>${songs.length}</small></h2></div>
      <a href="${Site.base}/songs/">곡 전체 →</a>
    </div>
    ${rows.length ? `<ul class="g-song-list">${rows.map((s) => {
      const parts = ordered(s);
      return `<li class="g-song genre-${songTone(s)}">
        <span class="g-song-thumb">${s.hasThumb
          ? `<img src="${s.thumbUrl || `/api/songs/${s.id}/thumb`}" alt="" loading="lazy" decoding="async" />`
          : `<span class="g-song-mark" aria-hidden="true">${esc(songLetter(s))}</span>`}</span>
        <span class="g-song-info">
          <a class="g-song-title" href="${Site.base}/songs/?song=${s.id}">${esc(s.title)}</a>
          <span class="g-song-artist">${esc(s.artist || '')}</span>
        </span>
        <span class="g-song-slots">${parts.map((p) => {
          const mine = !!me && p.supports.some((x) => x.nickname === me);
          const names = p.supports.map(supportName);
          return `<button type="button" class="g-slot ${mine ? 'mine' : names.length ? 'on' : 'off'}"
            data-support="${p.id}" aria-pressed="${mine}"
            data-peek="${esc((p.label || p.role) + ' · ' + (names.join(', ') || '비어 있음'))}"
            aria-label="${esc(p.label || p.role)} ${names.length}명${mine ? ' · 지원 취소' : ' · 지원'}"
            ><em>${esc(abbr(p.role))}</em>${slotWho(names)}</button>`;
        }).join('')}</span></li>`;
    }).join('')}</ul>` : `<div class="g-empty">
      <p class="g-empty-title">이 길드로 등록된 곡이 없습니다</p>
      <p class="g-empty-sub">여기서 등록한 곡이 이 길드 것이 됩니다.
        밖에서는 길드 꼬리표를 달고 그대로 보입니다.</p>
      <a class="g-cta" href="${Site.base}/songs/?add=1">곡 등록 →</a>
    </div>`}
  </section>`;
}

/* ---------- 지난 합주 ---------- */
function pastSection() {
  const rows = past().slice(0, 4);
  if (!rows.length) return '';
  return `<section class="g-past">
    <div class="g-sec-head">
      <div><span class="overline"><span>HISTORY</span></span><h2>지난 합주</h2></div>
      <a href="${Site.base}/schedule/">일정 전체 →</a>
    </div>
    <ul class="g-past-list">${rows.map((e) => `<li>
      <a href="${Site.base}/schedule/?event=${e.id}"><b>${esc(e.title)}</b>
      <span>${dayLabel(e.date)}${e.place ? '<span class="meta-sep">·</span>' + esc(e.place) : ''}</span>
      ${e.songs && e.songs.length ? `<i>${e.songs.length}곡</i>` : ''}</a></li>`).join('')}</ul>
  </section>`;
}

/* 넓은 화면은 두 열이다. 왼쪽이 '지금 뭐 하나'(다음 합주·파티창),
   오른쪽이 '뭘 했고 뭘 하나'(곡·지난 합주). 전에는 한 열이라 1262px 화면에서
   오른쪽 절반이 통째로 비었다. 좁아지면 CSS 가 한 열로 되돌린다. */
/* 판과 파티창이 한 덩어리로 맞붙고, 그 아래가 두 열이다.
   자켓에서 띠와 여섯 칸이 붙어 있는 것과 같은 이유다 — 사이를 벌리면 갈라져 보인다. */
function render() {
  $('#screen').innerHTML = `<div class="g-banner">${head()}${partySection()}</div>
  <div class="g-cols">
    <div class="g-col">${nextPractice()}</div>
    <div class="g-col">${songsSection()}${pastSection()}</div>
  </div>`;
  $('#screen').removeAttribute('aria-busy');
  fitParty($('#screen'));
  playEnter();
}

/* 들어설 때 한 번만. render() 는 지원을 누를 때마다 다시 그리는데 그때마다 화면이
   떠오르면 멀미가 난다. 그래서 처음 한 번만 걸고 끝나면 표시를 뗀다. */
let entered = false;
function playEnter() {
  if (entered) return;
  entered = true;
  /* '길드 입장하기' 를 눌러 들어온 것만 재생한다. 새로고침·직접 주소·헤더의 길드 이름은
     들어서는 동작이 아니다. 표시는 party.js 가 남기고 읽는 즉시 지워진다. */
  if (!guildEnterFlag(Site.slug)) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  $('#screen').classList.add('is-intro');
  setTimeout(() => $('#screen').classList.remove('is-intro'), 3200);
}

let drawMounted = false;

async function refresh() {
  if (Writes.pending) return;        /* 보내는 중인 쓰기가 끝나면 writes-idle 로 다시 온다 */
  const seq = Writes.seq;
  try {
    const [gs, sg, ev] = await Promise.all([
      api.get(`/guilds/${encodeURIComponent(Site.slug)}`),
      api.get(Site.q('/songs')),
      api.get(Site.q('/events')),
    ]);
    if (Writes.stale(seq)) return;   /* 기다리는 동안 누른 것이 있으면 이 응답은 낡았다 */
    guild = gs; songs = sg; events = ev;
    $('#guild-error').hidden = true;
    render();
    /* 배경 낙서는 한 번만 붙인다. 그릴 수 있는지는 길드원인지로 정한다. */
    if (!drawMounted) {
      drawMounted = true;
      const who = Nick.get();
      GuildDraw.mount(Site.slug, who,
        !!who && guild.members.some((m) => m.nickname === who));
    }
  } catch (err) {
    $('#guild-error').textContent = '불러오지 못했습니다. ' + err.message;
    $('#guild-error').hidden = false;
    $('#screen').removeAttribute('aria-busy');
  }
}

$('#screen').addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.hasAttribute('data-party-fold')) {
    partyOpen = !partyOpen;
    try { localStorage.setItem(PARTY_OPEN, partyOpen ? '1' : '0'); } catch {}
    render();
    $('[data-party-fold]')?.focus();
    return;
  }
  if (b.hasAttribute('data-draw-guild')) {
    GuildDraw.open();
    return;
  }
  if (b.hasAttribute('data-edit-guild')) {
    const saved = await openGuildEditor(guild);
    liveStyle = null;          /* 저장했든 취소했든 미리보기 값은 여기서 끝난다 */
    if (saved) { guild = saved; render(); refresh(); } else render();   /* 돌려받은 길드로 바로 그리고, 나머지는 뒤에서 */
    return;
  }
  /* 참석·지원은 누르는 즉시 칸을 바꾸고 서버에 보낸다(common.js Writes). 기다리지 않으므로
     busy 로 다른 버튼을 막지 않는다. 같은 칸을 연달아 누르면 Writes 가 순서대로 보낸다. */
  if (b.dataset.avail || b.dataset.support) {
    const me = await Nick.ensure();
    if (!me) return;
    const fail = (err) => {
      api.forgetPolls();
      $('#guild-error').textContent = err.message;
      $('#guild-error').hidden = false;
    };
    if (b.dataset.avail) {
      const ev = events.find((x) => x.id === Number(b.closest('[data-event]').dataset.event));
      const day = b.dataset.avail;
      const on = !ev.avails.some((a) => a.date === day && a.nickname === me);
      ev.avails = ev.avails.filter((a) => !(a.date === day && a.nickname === me));
      if (on) ev.avails.push({ eventId: ev.id, date: day, nickname: me });
      render();
      Writes.run(`avail:${ev.id}:${day}:${me}`,
        () => api.post(`/events/${ev.id}/avail/toggle`, { date: day, nickname: me, checked: on })).catch(fail);
    } else {
      /* 칸을 누르면 즉시 지원·취소. 메인 홈과 같은 규칙이다 — 여기도 고르는 화면이다.
         곡 페이지는 파트 상세를 먼저 연다. 어긋난 게 아니라 화면 성격이 달라서다. */
      const sid = Number(b.dataset.support);
      const session = songs.flatMap((s) => s.sessions).find((p) => p.id === sid);
      const on = !session.supports.some((a) => a.nickname === me);
      session.supports = session.supports.filter((a) => a.nickname !== me);
      if (on) session.supports.push({ id: null, sessionId: sid, nickname: me, label: null });
      render();
      $(`[data-support="${sid}"]`)?.focus();
      Writes.run(`sup:${sid}:${me}`, () => (on
        ? api.post(`/sessions/${sid}/support`, { nickname: me })
        : api.del(`/sessions/${sid}/support?nickname=${encodeURIComponent(me)}`))).catch(fail);
    }
    return;
  }
  if (busy) return;
  busy = true; b.disabled = true;
  try {
    if (b.hasAttribute('data-party-slot')) {
      if (await partyClick(e, [guild])) render();   /* 명단은 이미 바뀌었다. 서버는 뒤에서 맞춘다 */
    }
  } catch (err) {
    $('#guild-error').textContent = err.message;
    $('#guild-error').hidden = false;
  } finally {
    busy = false; b.disabled = false;
  }
});

/* 편집 모달이 고르는 동안 보내는 값. 저장 전에도 화면이 바로 바뀐다. */
document.addEventListener('guildstyle', (e) => {
  liveStyle = e.detail;
  if (guild) render();
});
document.addEventListener('nickchange', () => { if (guild) render(); });
document.addEventListener('profiles', () => { if (guild) render(); });
/* 길드 정보가 도착하면 헤더 이름이 바뀐다. 파티창의 팀장 표시도 같이 다시 그린다. */
document.addEventListener('guildinfo', () => { if (guild) render(); });
let fitTimer = null;
addEventListener('resize', () => { clearTimeout(fitTimer); fitTimer = setTimeout(() => fitParty($('#screen')), 120); });

mountChrome('home');
refresh();
document.addEventListener('writes-idle', () => refresh());   /* 누른 것이 다 저장되면 서버 상태로 맞춘다 */
})();
