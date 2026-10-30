/* 모임 한 칸의 타일.

   홈의 '모임 · 일정' 과 일정 페이지 목록은 같은 것을 가리킨다. 한쪽만 카드로 보이면
   같은 일정이 화면마다 다른 물건처럼 읽힌다. 그래서 부품을 한 곳에 둔다.

   색은 길드가 정한 것만 쓴다. 없으면 지어내지 않고 잉크로 둔다 —
   길드 페이지에서 대표색을 고르면 e.guild.color 로 들어와 그대로 걸린다.

     길드 없음        민트 · ♫            (전체 합주)
     길드 · 색 없음    잉크 · 엠블럼 또는 이름 첫 글자
     길드 · 색 있음    그 색
     길드 · 로고 있음  로고 그림          (guilds 에 이미지가 생기면 자동으로 걸린다) */

function eventSymbol(e) {
  const g = e && e.guild;
  /* 길드 없는 일정 = 불법이륙 자신의 일정이다. 길드 자리에 길드 로고가 오듯
     여기엔 사이트 로고가 온다. 로고가 2.28:1 가로형이라 58px 폭에서 25px 높이가 된다. */
  if (!g) {
    return '<span class="event-symbol is-site" aria-hidden="true">'
      + '<img src="/assets/logo.png" alt="" /></span>';
  }
  const style = g.color
    ? `--sym-fg:${escapeHtml(g.color)};--sym-bg:color-mix(in srgb, ${escapeHtml(g.color)} 14%, #fff)`
    : '--sym-fg:var(--ink);--sym-bg:var(--line-2)';
  /* 길드 문장(육각)이 먼저다. 그러라고 만든 표식이고, 이름 첫 글자보다 길드를 잘 가리킨다.
     crest.js 를 안 싣는 화면도 있으므로 있을 때만 쓴다. 이모지 엠블럼은 서버가 더 이상
     내려주지 않으므로 보지 않는다. 문장이 없으면 이름 첫 글자로 떨어진다. */
  const crest = typeof crestFor === 'function' && crestFor(g, 64);
  if (crest) {
    /* 줄 전체가 일정 펼치기 버튼이지만 문장만 누르면 크게 본다(common.js openZoom 이 먼저 받는다). */
    return `<span class="event-symbol is-crest" data-zoom="${escapeHtml(g.name || '')}" aria-hidden="true">${crest}</span>`;
  }
  const body = g.hasImage
    ? `<img src="${g.imageUrl || `/api/guilds/${encodeURIComponent(g.slug)}/image`}" alt="" />`
    : escapeHtml([...(g.name || '')][0] || '♫');
  return `<span class="event-symbol" style="${style}" aria-hidden="true">${body}</span>`;
}


/* 일정 종류(2026-10-02). 서버 routers/events.py 의 KINDS 와 같은 값.
   글자 표시는 아래 eventKindText 가 맡는다(알약 배지를 쓰던 eventTag 는 2026-10-02 뺐다). */
const EVENT_KIND = { regular: '정기합주', concert: '정기공연', guild: '길드 합주', band: '밴드 행사' };
function eventKind(e) { return (e && e.kind) || (e && e.guild ? 'guild' : 'regular'); }

/* 날짜 칸과 종류 글자 — 일정표(일정 화면)와 홈 '모임·일정' 이 같이 쓴다(2026-10-02).
   날짜 칸: 확정은 '12 월', 투표 중은 '10/1–31' 또는 '10/21–11/15'. 올해가 아니면 앞에 '27. 모두 같은 크기의 한 줄.
   종류 글자: 길드 합주는 '길드 합주 · 길드 이름', 정기합주·정기공연은 종류 + 참가 길드 문장, 밴드 행사는 종류만. */
const EV_DOW = ['일', '월', '화', '수', '목', '금', '토'];
function evMonthDay(iso) { const [, m, d] = iso.split('-').map(Number); return `${m}/${d}`; }
function evYearMark(iso) {
  const y = Number(iso.slice(0, 4));
  return y === new Date().getFullYear() ? '' : `<i>'${String(y).slice(2)}</i>`;
}
function eventDateHtml(e) {
  if (e.status === 'confirmed' && e.date) {
    const d = new Date(`${e.date}T00:00:00`);
    const wk = d.getDay();
    return `<span class="sched-date">${evYearMark(e.date)}${d.getDate()}`
      + `<small class="${wk === 0 || wk === 6 ? 'is-weekend' : ''}">${EV_DOW[wk]}</small></span>`;
  }
  const dates = (e.dates || []).map((d) => d.date).sort();
  const f = dates[0], l = dates[dates.length - 1];
  if (!f) return '<span class="sched-date"></span>';
  const [, fm] = f.split('-').map(Number);
  let range = evMonthDay(f);
  if (l && l !== f) {
    const [, lm, ld] = l.split('-').map(Number);
    range += '–' + (lm === fm ? `${ld}` : evMonthDay(l));
  }
  /* 아직 정해지지 않은 날짜다 — 기간은 흐리게(CSS), 아래 작게 '투표 중'(2026-10-19) */
  return `<span class="sched-date is-poll">${evYearMark(f)}${range}<em>투표 중</em></span>`;
}
function eventKindText(e) {
  const kind = eventKind(e);
  const label = EVENT_KIND[kind];
  if (kind === 'guild') return `${label}${e.guild && !Site.slug ? ' · ' + escapeHtml(e.guild.name) : ''}`;
  if (kind === 'band') return label;
  const crests = (e.guilds || []).map((g) => guildMark(g, 16, 'event-guild')).join('');
  return `${label}${crests ? ' ' + crests : ''}`;
}


/* ---------- 홈 배너 (2026-10-30) ----------
   홈 '모임 · 일정' 은 표가 아니라 배너다. 이 사이트의 문법은 리듬 게임(tokens.css --skew)이고, 곡 선택이
   자켓 캐러셀인데 그 아래 일정만 웹 표였다. 한 화면에 두 세계가 있어서 어느 쪽으로도 안 읽혔다.
   일정표(/schedule/)는 비교하고 훑는 화면이라 표를 그대로 둔다. 배너는 홈만 쓴다.

   배너 하나 = 날짜 블록(길드색) | 제목 · 한 줄 | 로고(오른쪽 가장자리에 크게 걸려 잘린다) | 도장.
     길드 합주       길드색이 바탕. 로고가 얼굴이라 다른 장식은 없다.
     정기합주·정기공연·밴드 행사   길드가 없어 그 자리가 비니 공연장(빛으로 그린 무대)이 바탕이다. CSS 가 그린다.
     다른 길드       같은 배너에 채도만 낮고 도장이 없다. 숨기지 않는다 — 다른 길드가 언제 뭘 하는지 보이는 것이 공동체다.
   도장:
     참석   확정 일정. 그 자리에서 토글한다(누르면 쾅 찍힌다). 날짜만 정해지고 시간·장소가 비어도 누를 수 있다.
     투표   날짜 투표. 토글이 아니다 — 날짜를 골라야 하므로 누르면 상세(/schedule/?event=)로 간다. 기표인(卜) 모양.
     상태 글자  '길드장 투표 중' 처럼 내가 할 수 있는 게 없을 때. 오른쪽 위 띠.
   아직 안 한 일만 점선으로 숨 쉰다(강조색). 한 일은 조용히 찍혀 있다. */

/* 전체 일정의 계절. 그 일정의 달로 정한다(투표 중이면 후보 첫날). 겨울 12–2, 봄 3–5, 여름 6–8, 가을 9–11.
   색·풍경은 eventcard.css 의 .bn.season-* 가 갖는다. 길드 합주는 길드색이라 계절을 타지 않는다. */
function bannerSeason(e) {
  const iso = e.date || ((e.dates || []).map((d) => d.date).sort()[0]) || '';
  const m = Number(iso.slice(5, 7)) || (new Date().getMonth() + 1);
  return m === 12 || m <= 2 ? 'winter' : m <= 5 ? 'spring' : m <= 8 ? 'summer' : 'autumn';
}
/* 색 블록 위 글자색. 밝은 길드색(분열밴드 #ffd6f0)에는 잉크, 어두운 색에는 흰색. */
function bannerInk(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return '#ffffff';
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.45 ? '#1b2a45' : '#ffffff';
}
function bannerToday() { return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(new Date()); }
/* 투표 중인 일정에서 표가 가장 많이 모인 날. schedule.js votesOn 과 같은 셈법 — 정기합주·정기공연은 길드 표, 그 밖은 사람 표. */
function bannerLeadingDate(e) {
  const union = ['regular', 'concert'].includes(eventKind(e));
  const list = union ? (e.guildAvails || []) : (e.avails || []);
  const n = {};
  list.forEach((a) => { n[a.date] = (n[a.date] || 0) + 1; });
  let best = null;
  Object.keys(n).sort().forEach((d) => { if (!best || n[d] > n[best]) best = d; });
  return best ? { date: best, count: n[best], unit: union ? '길드' : '명' } : null;
}
function bannerDateHtml(e) {
  if (e.status === 'confirmed' && e.date) {
    const d = new Date(`${e.date}T00:00:00`), wk = d.getDay(), today = e.date === bannerToday();
    const yr = Number(e.date.slice(0, 4)) === new Date().getFullYear() ? '' : `<i>'${e.date.slice(2, 4)}</i>`;
    return `<span class="bn-date${today ? ' is-today' : ''}"><b>${yr}${d.getDate()}</b><small>${today ? '오늘' : EV_DOW[wk]}</small></span>`;
  }
  const dates = (e.dates || []).map((d) => d.date).sort();
  const f = dates[0], l = dates[dates.length - 1];
  let range = f ? evMonthDay(f) : '';
  if (f && l && l !== f) { const [, fm] = f.split('-').map(Number), [, lm, ld] = l.split('-').map(Number); range += '–' + (lm === fm ? ld : evMonthDay(l)); }
  return `<span class="bn-date is-poll"><b>${range}</b><small>투표 중</small></span>`;
}
/* 한 줄 부제. 확정은 시간 · 장소(없으면 비운다 — '미정' 을 글자로 쓰지 않는다), 투표는 유력 날짜, 전체 일정은 길드 수. */
function bannerSub(e) {
  const kind = eventKind(e);
  const parts = [];
  if (e.status === 'confirmed') {
    if (e.startTime) parts.push(e.startTime + (e.endTime ? ' – ' + e.endTime : ''));
    if (e.place) parts.push(e.place);
    if (e.songs && e.songs.length) parts.push(`${e.songs.length}곡`);
  } else {
    const lead = bannerLeadingDate(e);
    if (lead) { const d = new Date(`${lead.date}T00:00:00`); parts.push(`유력 ${evMonthDay(lead.date)} ${EV_DOW[d.getDay()]} · ${lead.count}${lead.unit}`); }
  }
  if (kind !== 'guild' && (e.guilds || []).length) parts.unshift(`길드 ${e.guilds.length}곳`);
  return parts.map(escapeHtml).join(' · ');
}
function bannerArt(e) {
  const g = e.guild;
  if (!g) return `<span class="bn-artwrap"><span class="bn-art is-site"><img src="/assets/logo.png" alt="" /></span></span>`;
  if (g.hasImage) return `<span class="bn-artwrap"><span class="bn-art"><img src="${g.imageUrl || `/api/guilds/${encodeURIComponent(g.slug)}/image`}" alt="" /></span></span>`;
  const crest = typeof crestFor === 'function' && crestFor(g, 160);
  return crest ? `<span class="bn-artwrap"><span class="bn-art is-crest">${crest}</span></span>` : '';
}
const BN_CHECK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 12.5l4 4L18 8"/></svg>';
/* opts: { me, myGuildIds:Set, href }  — 길드 소속은 호출하는 화면이 안다(홈은 guilds 를 들고 있다). */
function eventBanner(e, opts = {}) {
  const kind = eventKind(e), me = opts.me || '', mine = opts.myGuildIds || new Set();
  const other = kind === 'guild' && !(e.guildId && mine.has(e.guildId));
  const g = kind === 'guild' ? e.guild : null;
  /* 길드 합주만 인라인 색. 전체 일정은 계절 클래스가 --g 를 정하므로 인라인으로 덮지 않는다 */
  const style = g ? `--g:${escapeHtml(g.color || '#1b2a45')};--on:${bannerInk(g.color || '#1b2a45')}` : '';
  const season = g ? '' : ' season-' + bannerSeason(e);
  const tags = [];
  if (e.status === 'confirmed' && e.date === bannerToday()) tags.push('<span class="bn-tag today"><span>오늘</span></span>');
  if (kind !== 'guild') tags.push(`<span class="bn-tag kind-${kind}"><span>${EVENT_KIND[kind]}</span></span>`);
  /* 오른쪽: 도장 또는 상태 글자 */
  let right = '';
  if (!other) {
    if (e.status === 'confirmed') {
      const on = !!me && e.avails.some((a) => a.date === e.date && a.nickname === me);
      right = `<button type="button" class="bn-stamp" aria-pressed="${on}" data-attend="${e.id}" aria-label="참석"><span>${BN_CHECK}참석</span></button>`;
    } else if (['regular', 'concert'].includes(kind)) {
      const leader = !!me && (e.guilds || []).some((x) => x.leader === me);
      if (leader) {
        const on = (e.guilds || []).some((x) => x.leader === me && (e.guildAvails || []).some((a) => a.guildId === x.id));
        right = `<a class="bn-stamp vote" aria-pressed="${on}" href="${opts.href || '#'}" aria-label="투표"><span><b>卜</b>투표</span></a>`;
      } else right = '<span class="bn-state">길드장 투표 중</span>';
    } else {
      const on = !!me && e.avails.some((a) => a.nickname === me);
      right = `<a class="bn-stamp vote" aria-pressed="${on}" href="${opts.href || '#'}" aria-label="투표"><span><b>卜</b>투표</span></a>`;
    }
  }
  const sub = bannerSub(e);
  return `<div class="bn kind-${kind}${season}${other ? ' is-other' : ''}${e.status !== 'confirmed' ? ' is-poll' : ''}" role="link" tabindex="0" data-event="${e.id}" data-href="${escapeHtml(opts.href || '')}"${style ? ` style="${style}"` : ''}>`
    + `${bannerDateHtml(e)}${bannerArt(e)}${g ? '' : '<span class="bn-fx"></span>'}<span class="bn-txt">${tags.join('')}<span class="bn-ttl">${escapeHtml(e.title)}</span>${sub ? `<span class="bn-sub">${sub}</span>` : ''}</span>${right}</div>`;
}
