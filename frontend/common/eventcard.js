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
    return `<span class="event-symbol is-crest" aria-hidden="true">${crest}</span>`;
  }
  const body = g.hasImage
    ? `<img src="/api/guilds/${encodeURIComponent(g.slug)}/image" alt="" />`
    : escapeHtml([...(g.name || '')][0] || '♫');
  return `<span class="event-symbol" style="${style}" aria-hidden="true">${body}</span>`;
}
