/* 불법위키 — 가사.

   가사는 소절의 줄이다. 한 소절은 세 줄 — 원문(o) · 발음(r) · 번역(t) — 이고, 줄마다 문단과 같은 조각(run)이다.
     { "verses": [ { "o": […], "r": […], "t": […], "gap": 1 }, … ] }      gap: 이 소절 앞에서 절이 바뀐다
   원문 줄은 옅은 색 면에 굵게(한자 위의 읽는 법 포함), 발음은 작은 회색, 번역은 보통 글씨로 가운데에 놓는다.
   선은 소절 사이에만 있고, 절이 바뀌는 곳에는 빈 띠를 둔다(wiki.css '가사').

   처음에는 나무위키의 가사 표를 표 그대로 옮겼는데, 원문 줄의 색(나무위키 쪽 스타일이라 가져올 수 없다)과
   가운데 정렬이 빠지고 세 줄이 똑같은 칸으로 이어져서 어디가 한 소절인지 보이지 않았다(2026-11-13 사용자 지적).
   그래서 표가 아니라 가사의 모양을 따로 둔다. 나무위키 가사 표를 붙여넣으면 이 블록이 된다(namu.js). */
const WikiLyric = (() => {
  const { el } = WikiRender;
  const LINES = [['o', 'wk-lo', '원문'], ['r', 'wk-lr', '발음'], ['t', 'wk-lt', '번역']];

  /* 소절 하나. fill(줄, 조각) 이 줄의 내용을 채운다. 읽을 때는 빈 줄을 그리지 않고, 고칠 때는 세 줄을 다 둔다. */
  function verse(v, fill, edit) {
    const row = el('div', v.gap ? 'wk-v is-gap' : 'wk-v');
    for (const [key, cls, hint] of LINES) {
      const runs = v[key] || [];
      if (!edit && !runs.length) continue;
      const line = el('div', cls);
      line.dataset.line = key;
      if (edit) line.dataset.hint = hint;
      fill(line, runs);
      row.append(line);
    }
    return row;
  }

  function paint(host, data, fill, edit) {
    host.replaceChildren(...data.verses.map((v) => verse(v, fill, edit)));
  }

  /* 고치던 가사를 다시 내용으로. 세 줄이 다 빈 소절은 버린다. 첫 소절 앞에는 절 나눔이 없다. */
  function collect(host) {
    const verses = [...host.querySelectorAll(':scope > .wk-v')].map((row) => {
      const v = {};
      for (const [key] of LINES) {
        const line = row.querySelector(`:scope > [data-line="${key}"]`);
        v[key] = line ? WikiEdit.runsOf(line) : [];
      }
      if (row.classList.contains('is-gap')) v.gap = 1;
      return v;
    }).filter((v) => v.o.length || v.r.length || v.t.length);
    if (verses[0]) delete verses[0].gap;
    return { verses };
  }

  const blank = () => ({ o: [], r: [], t: [] });

  return { paint, collect, verse, blank };
})();
