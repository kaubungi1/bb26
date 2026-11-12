/* 불법위키 — 제목 목록과 자동 링크.

   본문에 다른 문서의 이름이 나오면 문법 없이 링크가 된다. 규칙은 넷이다.
     열쇠        제목·본문 모두 띄어쓰기·기호·대소문자를 무시하고 견준다. "로스트원의호곡" 도 "로스트 원의 호곡" 문서로 간다.
     낱말 경계   이름은 낱말의 맨 앞에서 시작하고, 뒤는 끝·기호·조사여야 한다. "하모니카" 는 "니카" 로 가지 않는다.
     긴 것 먼저  "쿠로민" 이 "쿠로" 보다 먼저 걸린다.
     한 번만     한 문서에서 같은 문서로는 처음 한 번만 건다(나무위키 관례). 자기 자신으로는 걸지 않는다.
   열쇠가 한 글자인 이름("월")은 자동으로 걸지 않는다 — 손으로 건다.

   같은 규칙이 서버(backend/wikitext.py 의 key·JOSA·mentions)에도 있다. 거기서는 '이 문서를 가리키는 문서'를 뽑는다.
   한쪽만 고치면 화면의 링크와 그 목록이 어긋난다. */
const WikiLinks = (() => {
  const JOSA = ['이라는', '이라고', '입니다', '이었다', '에서는', '에서도', '으로는', '으로도', '에게는', '에게도', '한테는', '한테도',
    '이라', '이란', '이다', '이며', '이고', '이나', '이랑', '이여', '이요', '에서', '에게', '한테', '으로', '부터', '까지',
    '처럼', '보다', '마다', '조차', '마저', '밖에', '라는', '라고', '였다', '에는', '에도', '로는', '로도', '과는', '와는',
    '같은', '같이', '하고', '은', '는', '이', '가', '을', '를', '의', '에', '께', '와', '과', '랑', '도', '만', '로',
    '나', '라', '란', '다', '며', '고', '인', '님', '씨', '야', '아', '여', '요', '뿐'];
  const WORD = /[\p{L}\p{N}_]/u;
  const TAIL = new RegExp(`^(?:들)?(?:${JOSA.join('|')})?(?:${JOSA.join('|')})?(?![\\p{L}\\p{N}_])`, 'u');
  const GAP = '[^\\p{L}\\p{N}_]{0,3}';      /* 제목 글자 사이에 끼어도 되는 것: 공백·기호 세 칸까지 */
  const AUTO_MIN = 2;
  const TAIL_LOOK = 16;                     /* 조사 둘 + 다음 글자를 보기에 넉넉한 길이 */

  let pages = [];
  let byKey = new Map();
  let names = [];                           /* 자동으로 거는 이름. 열쇠가 긴 것부터 */
  let regex = null;

  function key(text) {
    const s = String(text || '').normalize('NFKC').toLowerCase();
    return s.replace(/[^\p{L}\p{N}]+/gu, '') || s.replace(/\s+/g, '');
  }

  function set(list) {
    pages = list || [];
    byKey = new Map();
    for (const p of pages) {
      byKey.set(p.key, p);
      for (const a of p.aliases || []) byKey.set(a.key, p);
    }
    names = [...byKey.entries()]
      .map(([k, page]) => ({ chars: [...k], page }))
      /* 기호뿐인 제목의 열쇠에는 기호가 남는다. 그런 이름은 정규식에 넣지 않는다(손으로 건다). */
      .filter((n) => n.chars.length >= AUTO_MIN && n.chars.every((c) => WORD.test(c) && c !== '_'))
      .sort((a, b) => b.chars.length - a.chars.length);
    try {
      regex = names.length ? new RegExp(names.map((n) => `(${n.chars.join(GAP)})`).join('|'), 'giu') : null;
    } catch (err) {
      console.error(err);
      regex = null;                         /* 정규식을 못 만들면 자동 링크만 쉰다. 글은 그대로 보인다 */
    }
  }

  function find(title) {
    return byKey.get(key(title)) || null;
  }

  /* 글자를 [{t}] 와 [{t, page}] 토막으로 나눈다. used 는 이 문서에서 이미 건 문서 id 모음이다. */
  function split(text, used, selfId) {
    if (!regex || !text) return [{ t: text }];
    const out = [];
    let last = 0;
    let m;
    regex.lastIndex = 0;
    while ((m = regex.exec(text))) {
      const start = m.index;
      const end = start + m[0].length;
      if (!m[0]) { regex.lastIndex += 1; continue; }
      const before = start > 0 ? text[start - 1] : '';
      if ((before && WORD.test(before)) || !TAIL.test(text.slice(end, end + TAIL_LOOK))) {
        regex.lastIndex = start + 1;        /* 낱말 속이었다. 한 글자 뒤에서 다시 찾는다 */
        continue;
      }
      let page = null;
      for (let i = 0; i < names.length; i += 1) if (m[i + 1] !== undefined) { page = names[i].page; break; }
      if (!page || page.id === selfId || used.has(page.id)) continue;
      used.add(page.id);
      if (start > last) out.push({ t: text.slice(last, start) });
      out.push({ t: m[0], page });
      last = end;
    }
    if (last < text.length) out.push({ t: text.slice(last) });
    return out;
  }

  /* 찾기: 열쇠에 q 가 든 문서. 제목이 q 로 시작하는 것이 먼저 */
  function search(q, limit = 8) {
    const k = key(q);
    if (!k) return [];
    const hit = new Map();
    for (const [nameKey, page] of byKey) {
      if (!nameKey.includes(k)) continue;
      const score = nameKey === k ? 0 : nameKey.startsWith(k) ? 1 : 2;
      if (!hit.has(page.id) || hit.get(page.id).score > score) hit.set(page.id, { page, score });
    }
    return [...hit.values()].sort((a, b) => a.score - b.score || a.page.title.localeCompare(b.page.title, 'ko'))
      .slice(0, limit).map((h) => h.page);
  }

  function inCategory(name) {
    const k = key(name);
    return pages.filter((p) => (p.categories || []).some((c) => key(c) === k));
  }

  return { key, set, find, split, search, inCategory, all: () => pages };
})();
