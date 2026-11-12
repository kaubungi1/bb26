/* 불법위키 — 나무위키 문법으로 쓴 글을 우리 블록으로 바꾼다.

   편집 중에 나무위키의 '편집' 화면에서 복사한 글(원문)을 붙여넣으면 여기를 거친다(editor.js pasteNamu).
   우리 위키는 문법으로 쓰지 않으므로 이 변환은 들어올 때 한 번만 한다. 저장되는 것은 조각(run)과 블록이다.

   옮기는 것
     == 제목 ==  ===  ====            대분류 · 중분류 · 소분류(그보다 깊은 것은 소분류)
     '''굵게'''  ''기울임''  ~~취소~~ --취소--
     {{{#색 글}}}  {{{+2 글}}}        글자색 · 글자 크기
     [[문서]]  [[문서|글]]  [[http…|글]]   문서 링크 · 바깥 링크
     [* 각주]                         각주
     [ruby(글자, ruby=읽는 법)]       윗글자
     [br]                             줄바꿈
      * 목록   1. 번호 목록            앞 공백의 수가 들여쓰기 단계
     > 인용
     || 표 ||                         칸 합치기(<-2> <|2>) · 칸 색(<bgcolor=…>) · 정렬 · 칸 안의 꾸밈
     [youtube(…)]                     영상
     [[분류:…]]                       문서의 분류
   옮길 수 없어 버리는 것
     [[파일:…]]         그림은 나무위키 서버에 있다. 원문에는 파일 이름만 있어 가져올 수 없다
     [include(틀:…)]    그 틀 문서가 우리 위키에 없다
     [목차] [각주] [clearfix]   우리는 자동이다
     표·칸의 폭·테두리색·class 같은 모양 지정, 밑줄·위첨자, {{{#!html}}}

   글자는 전부 조각의 t 로만 들어간다. 여기서 HTML 을 만들지 않는다. */
const WikiNamu = (() => {
  const SKIP_NS = /^(?:파일|분류|스니펫|틀|file|category)\s*:/i;
  const DROP_MACRO = /^\[(?:include|youtube|nicovideo|kakaotv|navertv|vimeo|age|dday|anchor|math|pagecount|date|datetime)\([^\]]*\)\]/i;
  const DROP_WORD = /^\[(?:목차|tableofcontents|각주|footnote|clearfix|date|datetime)\]/i;
  const MARKS = ['b', 's', 'i', 'c', 'g', 'z', 'r'];

  function looksLike(text) {
    return /^={2,6}\s?.+?\s?={2,6}\s*$/m.test(text) || /^\s*\|\|/m.test(text) || /\[\[[^\]\n]+\]\]/.test(text)
      || /'''[^'\n]+'''/.test(text) || /\{\{\{[#+-]/.test(text) || /\[\*[^\]\n]*\]/.test(text)
      || /\[(?:ruby|include|youtube)\(/i.test(text) || /\[(?:br|목차)\]/i.test(text) || /^ +\* /m.test(text);
  }

  /* 나무위키의 색 표기(#red, #ff0000, #fff,#000 — 뒤는 어두운 화면용)를 우리 것으로 */
  function color(value) {
    const v = String(value || '').split(',')[0].trim().toLowerCase();
    if (/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/.test(v)) return v;
    const name = v.replace(/^#/, '');
    return /^[a-z]{3,20}$/.test(name) && name !== 'transparent' ? name : '';
  }

  /* open 으로 열린 자리(i)에서 짝이 맞는 close 의 자리. 없으면 -1 */
  function match(src, i, open, close) {
    let depth = 0;
    for (let k = i; k < src.length; k += 1) {
      if (src.startsWith(open, k)) { depth += 1; k += open.length - 1; }
      else if (src.startsWith(close, k)) {
        depth -= 1;
        if (depth === 0) return k;
        k += close.length - 1;
      }
    }
    return -1;
  }

  function host(url) {
    if (/youtu\.?be/i.test(url)) return '유튜브';
    if (/nicovideo/i.test(url)) return '니코니코 동화';
    if (/twitter\.com|\/\/x\.com/i.test(url)) return '트위터';
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return '링크'; }
  }
  const textOf = (runs) => runs.map((r) => r.t || '').join('');

  /* 한 줄(또는 칸 하나)의 글을 조각으로. marks 는 바깥에서 걸린 꾸밈이다. */
  function inline(src, cats, marks = {}) {
    const out = [];
    let on = { ...marks };
    let buf = '';
    const flush = () => {
      if (!buf) return;
      const run = { t: buf };
      for (const k of MARKS) if (on[k]) run[k] = on[k];
      if (on.a) run.a = on.a; else if (on.w) run.w = on.w;
      out.push(run);
      buf = '';
    };
    const nested = (text, extra) => { flush(); out.push(...inline(text, cats, { ...on, ...extra })); };
    const toggle = (k) => { flush(); if (on[k]) delete on[k]; else on[k] = 1; };

    for (let i = 0; i < src.length; i += 1) {
      const rest = src.slice(i);
      if (src[i] === '\\' && i + 1 < src.length) { buf += src[i + 1]; i += 1; continue; }

      if (rest.startsWith('{{{')) {
        const end = match(src, i, '{{{', '}}}');
        if (end < 0) { buf += '{{{'; i += 2; continue; }
        const inner = src.slice(i + 3, end);
        i = end + 2;
        let m;
        if (/^#!html/i.test(inner)) continue;
        if (/^#!(?:wiki|folding)/i.test(inner)) {
          const nl = inner.indexOf('\n');
          if (nl >= 0) nested(inner.slice(nl + 1), {});
          continue;
        }
        if ((m = /^(#[0-9a-zA-Z]+(?:,#[0-9a-zA-Z]+)?)\s([\s\S]*)$/.exec(inner)) && color(m[1])) { nested(m[2], { c: color(m[1]) }); continue; }
        if ((m = /^([+-])([1-5])\s([\s\S]*)$/.exec(inner))) {
          const z = Math.max(-2, Math.min(4, Number(m[1] + m[2])));
          nested(m[3], z ? { z } : {});
          continue;
        }
        buf += inner;                          /* 그 밖의 {{{ }}} 는 문법을 끄는 표시다. 글자 그대로 */
        continue;
      }

      if (rest.startsWith('[[')) {
        const end = match(src, i, '[[', ']]');
        if (end < 0) { buf += '[['; i += 1; continue; }
        const inner = src.slice(i + 2, end);
        i = end + 1;
        let bar = -1;
        for (let k = 0, depth = 0; k < inner.length; k += 1) {
          if (inner.startsWith('[[', k)) { depth += 1; k += 1; } else if (inner.startsWith(']]', k)) { depth -= 1; k += 1; }
          else if (inner[k] === '|' && depth === 0) { bar = k; break; }
        }
        const target = (bar < 0 ? inner : inner.slice(0, bar)).trim();
        const label = bar < 0 ? null : inner.slice(bar + 1);
        if (SKIP_NS.test(target)) {
          if (/^(?:분류|category)\s*:/i.test(target)) {
            const name = target.replace(/^[^:]+:/, '').replace(/#.*$/, '').trim();
            if (name) cats.push(name);
          }
          continue;
        }
        if (/^https?:\/\//i.test(target)) {
          flush();
          const made = label === null ? [] : inline(label, cats, { ...on, a: target });
          /* 글 대신 아이콘 그림만 든 링크([[주소|[[파일:…]]]])는 글이 비므로 사이트 이름을 쓴다 */
          out.push(...(textOf(made).trim() ? made : [{ t: label === null ? target : host(target), ...pick(on), a: target }]));
          continue;
        }
        const title = target.replace(/#.*$/, '').replace(/^[:/]+/, '').trim().slice(0, 60);
        const shown = target.replace(/^:/, '');
        if (!title) { if (label !== null) nested(label, {}); else buf += shown.replace(/^#/, ''); continue; }
        flush();
        const made = label === null ? [] : inline(label, cats, { ...on, w: title });
        out.push(...(textOf(made).trim() ? made : [{ t: shown, ...pick(on), w: title }]));
        continue;
      }

      if (rest.startsWith('[*')) {
        const end = match(src, i, '[', ']');
        if (end < 0) { buf += '['; continue; }
        const inner = src.slice(i + 2, end);
        i = end;
        const body = inner.startsWith(' ') ? inner : inner.replace(/^\S*\s?/, '');     /* [*이름 내용] 의 이름은 버린다 */
        const note = textOf(inline(body, cats)).replace(/\s+/g, ' ').trim();
        flush();
        if (note) out.push({ t: '', f: note });
        continue;
      }

      if (src[i] === '[') {
        let m;
        if (/^\[br\]/i.test(rest)) { buf += '\n'; i += 3; continue; }
        if ((m = /^\[ruby\(([^\]]*?)\)\]/i.exec(rest))) {
          const args = m[1].split(',');
          const base = (args.shift() || '').trim();
          const reading = (/ruby\s*=\s*([^,]*)/i.exec(args.join(',')) || [])[1];
          flush();
          if (base) out.push({ t: base, ...pick(on), ...(reading && reading.trim() ? { r: reading.trim().slice(0, 100) } : {}), ...link(on) });
          i += m[0].length - 1;
          continue;
        }
        if ((m = DROP_MACRO.exec(rest)) || (m = DROP_WORD.exec(rest))) { i += m[0].length - 1; continue; }
      }

      if (rest.startsWith("'''")) { toggle('b'); i += 2; continue; }
      if (rest.startsWith("''")) { toggle('i'); i += 1; continue; }
      if (rest.startsWith('~~')) { toggle('s'); i += 1; continue; }
      /* -- 는 글에서 그냥 줄표로도 쓴다. 닫는 짝이 뒤에 있을 때만 취소선으로 본다 */
      if (rest.startsWith('--') && (on.s || src.indexOf('--', i + 2) >= 0)) { toggle('s'); i += 1; continue; }
      if (rest.startsWith('__') || rest.startsWith('^^') || rest.startsWith(',,')) { i += 1; continue; }
      buf += src[i];
    }
    flush();
    return out;
  }
  function pick(on) { const o = {}; for (const k of MARKS) if (on[k]) o[k] = on[k]; return o; }
  function link(on) { return on.a ? { a: on.a } : on.w ? { w: on.w } : {}; }

  /* 조각 목록의 앞뒤 공백을 걷는다. 빈 조각은 버린다. */
  function trim(runs) {
    const out = runs.filter((r) => r.t || r.f !== undefined);
    while (out.length && out[0].f === undefined) {
      out[0] = { ...out[0], t: out[0].t.replace(/^\s+/, '') };
      if (out[0].t) break;
      out.shift();
    }
    while (out.length && out[out.length - 1].f === undefined) {
      const last = out.length - 1;
      out[last] = { ...out[last], t: out[last].t.replace(/\s+$/, '') };
      if (out[last].t) break;
      out.pop();
    }
    return out;
  }

  /* ---------- 표 ---------- */
  /* 한 줄(여러 줄에 걸친 칸 포함)을 || 로 가른다. [[ ]] 와 {{{ }}} 안의 || 는 가르지 않는다. */
  function splitCells(row) {
    const parts = [];
    let cur = '';
    let depth = 0;
    for (let i = 0; i < row.length; i += 1) {
      if (row.startsWith('{{{', i) || row.startsWith('[[', i)) depth += 1;
      else if (row.startsWith('}}}', i) || row.startsWith(']]', i)) depth = Math.max(0, depth - 1);
      if (depth === 0 && row.startsWith('||', i)) { parts.push(cur); cur = ''; i += 1; continue; }
      cur += row[i];
    }
    parts.push(cur);
    return parts;
  }

  function readCell(raw, cats, rowState, colBg, col, whole) {
    const cell = { cs: 1, rs: 1, bg: '', al: '', fg: '', ja: false };
    let text = raw;
    for (;;) {
      const m = /^\s*<([^<>\n]*)>/.exec(text);
      if (!m) break;
      const opt = m[1].trim();
      let known = true;
      let v;
      if ((v = /^-(\d+)$/.exec(opt))) cell.cs = Math.max(1, Number(v[1]));
      else if ((v = /^[\^v]?\|(\d+)$/.exec(opt))) cell.rs = Math.max(1, Number(v[1]));
      else if (opt === ':') cell.al = 'c';
      else if (opt === '(') cell.al = 'l';
      else if (opt === ')') cell.al = 'r';
      else if ((v = /^(?:bgcolor=)?(#[0-9a-zA-Z,#]+)$/.exec(opt)) || (v = /^bgcolor=([a-zA-Z#0-9,]+)$/.exec(opt))) cell.bg = color(v[1]);
      else if ((v = /^rowbgcolor=(.+)$/.exec(opt))) rowState.bg = color(v[1]);
      else if ((v = /^colbgcolor=(.+)$/.exec(opt))) colBg[col] = color(v[1]);
      else if ((v = /^(?:color|rowcolor|colcolor)=(.+)$/.exec(opt))) cell.fg = color(v[1]);
      /* 표를 놓는 자리 */
      else if ((v = /^table\s*align=(center|right|left)$/i.exec(opt))) whole.align = { center: 'c', right: 'r', left: '' }[v[1].toLowerCase()];
      /* 가사 표는 원문 줄에 class=… ja 를 단다. 줄의 색은 나무위키 쪽 스타일이라 못 가져오지만, 어느 줄이 원문인지는 이것으로 안다 */
      else if ((v = /^class=(.+)$/i.exec(opt))) cell.ja = /(?:^|\s)ja(?:\s|$)/.test(v[1]);
      else if (!/^(?:table\s|table[a-z]+=|class=|rowclass=|colclass=|nopad$|keepall$|width=|height=)/i.test(opt)) known = false;
      if (!known) break;
      text = text.slice(m[0].length);
    }
    /* 정렬을 따로 적지 않았으면 칸 양쪽의 공백으로 정한다(양쪽 다 띄우면 가운데 — 나무위키 규칙) */
    if (!cell.al) {
      const lead = /^[ \t]/.test(text);
      const tail = /[ \t]$/.test(text);
      cell.al = lead && tail ? 'c' : lead ? 'r' : '';
    }
    const body = text.replace(/^\n+|\n+$/g, '').replace(/^[ \t]+\*[ \t]?/gm, '• ').replace(/^[ \t]+/gm, '');
    cell.runs = trim(inline(body, cats, cell.fg ? { c: cell.fg } : {}));
    if (!cell.bg) cell.bg = rowState.bg || colBg[col] || '';
    return cell;
  }

  function table(rowsRaw, cats) {
    const grid = [];
    const colBg = [];
    const whole = { align: '' };
    rowsRaw.forEach((raw, r) => {
      const parts = splitCells(raw.replace(/^\s*\|\|/, '').replace(/\|\|\s*$/, ''));
      if (!grid[r]) grid[r] = [];
      const rowState = { bg: '' };
      let pending = 0;
      let c = 0;
      for (const part of parts) {
        if (part === '') { pending += 1; continue; }               /* |||| : 다음 칸을 한 칸 더 넓힌다 */
        while (grid[r][c] !== undefined) c += 1;
        const cell = readCell(part, cats, rowState, colBg, c, whole);
        cell.cs = Math.min(20 - c, cell.cs + pending);
        pending = 0;
        if (cell.cs < 1) break;
        for (let i = 0; i < cell.rs; i += 1) {
          if (!grid[r + i]) grid[r + i] = [];
          for (let j = 0; j < cell.cs; j += 1) grid[r + i][c + j] = i || j ? null : cell;
        }
        c += cell.cs;
      }
    });
    /* 버린 것(그림·틀·영상)만 들어 있던 줄은 뺀다. 합쳐진 칸이 걸친 줄은 그대로 둔다. */
    const bare = (cell) => cell !== null && cell !== undefined && cell.cs === 1 && cell.rs === 1 && !cell.runs.length;
    const rows = grid.filter((row) => !(row.length && row.every(bare))).slice(0, 300);
    const width = Math.min(20, Math.max(1, ...rows.map((row) => row.length)));

    /* 가사 표: 칸이 하나뿐인 줄이 이어지고 원문 줄(class=… ja)이 둘 이상이면 가사 블록으로 바꾼다(lyric.js).
       원문 줄에서 소절이 시작하고, 그 뒤 첫 줄이 발음, 둘째 줄이 번역이다. 줄이 더 있으면 번역에 이어 붙인다. */
    if (width === 1 && rows.filter((row) => row[0] && row[0].ja).length >= 2) {
      const verses = [];
      for (const row of rows) {
        const cell = row[0];
        if (!cell || !cell.runs.length) continue;
        const last = verses[verses.length - 1];
        if (cell.ja || !last) verses.push(cell.ja ? { o: cell.runs, r: [], t: [] } : { o: [], r: [], t: cell.runs });
        else if (!last.r.length && !last.t.length && last.o.length) last.r = cell.runs;
        else if (!last.t.length) last.t = cell.runs;
        else last.t = [...last.t, { t: '\n' }, ...cell.runs];
      }
      return verses.length ? { kind: 'lyric', data: { verses: verses.slice(0, 500) } } : null;
    }
    const out = rows.map((row, r) => Array.from({ length: width }, (_, c) => {
      const cell = row[c];
      if (cell === null) return null;
      if (cell === undefined) return '';
      const bare = cell.runs.length <= 1 && (!cell.runs[0] || Object.keys(cell.runs[0]).length === 1);
      const packed = bare ? { t: cell.runs[0] ? cell.runs[0].t : '' } : { runs: cell.runs };
      if (cell.cs > 1) packed.cs = cell.cs;
      if (cell.rs > 1) packed.rs = Math.min(cell.rs, rows.length - r);
      if (cell.bg) packed.bg = cell.bg;
      if (cell.al) packed.al = cell.al;
      return bare && Object.keys(packed).length === 1 ? packed.t : packed;
    }));
    const hasText = out.some((row) => row.some((c) => c !== null && (typeof c === 'string' ? c : (c.t || (c.runs && c.runs.length)))));
    if (!hasText) return null;
    return { kind: 'table', data: whole.align ? { rows: out, head: false, align: whole.align } : { rows: out, head: false } };
  }

  /* ---------- 글 전체 ---------- */
  function convert(text) {
    const cats = [];
    const blocks = [];
    const lines = String(text).replace(/\r/g, '').split('\n');
    const add = (kind, src, level) => {
      const runs = trim(inline(src, cats));
      if (!runs.length) return;
      const data = { runs };
      if (level) data.level = level;
      blocks.push({ kind, data });
    };
    for (let i = 0; i < lines.length;) {
      const line = lines[i];
      const t = line.trim();
      let m;
      if (/^\s*\|\|/.test(line)) {
        /* 표: 줄이 || 로 끝날 때까지가 한 줄이다(칸 안에서 줄을 바꾼 표가 있다). 빈 줄이나 표가 아닌 줄에서 끝난다. */
        const rowsRaw = [];
        let buf = '';
        while (i < lines.length && (buf || /^\s*\|\|/.test(lines[i]))) {
          buf += (buf ? '\n' : '') + lines[i];
          i += 1;
          if (/\|\|\s*$/.test(buf) && buf.trim().length > 2) { rowsRaw.push(buf); buf = ''; }
        }
        if (buf.trim()) rowsRaw.push(buf);
        const made = table(rowsRaw, cats);
        if (made) blocks.push(made);
        /* 칸 안에 넣은 영상은 표 아래에 영상 블록으로 꺼낸다(우리 표의 칸에는 글만 든다) */
        for (const v of rowsRaw.join('\n').matchAll(/\[youtube\(\s*([A-Za-z0-9_-]{11})/gi)) blocks.push({ kind: 'yt', data: { v: v[1] } });
        continue;
      }
      i += 1;
      if (!t || /^-{4,9}$/.test(t) || DROP_WORD.test(t) && t.replace(DROP_WORD, '').trim() === '') continue;
      if ((m = /^(={2,6})\s*#?\s*(.*?)\s*#?\s*\1\s*$/.exec(t))) { add(['h2', 'h3', 'h4'][Math.min(m[1].length - 2, 2)], m[2]); continue; }
      if ((m = /^\[youtube\(\s*([A-Za-z0-9_-]{11})[^\]]*\)\]$/i.exec(t))) { blocks.push({ kind: 'yt', data: { v: m[1] } }); continue; }
      if (/^>/.test(t)) {
        const quote = [t.replace(/^>\s?/, '')];
        while (i < lines.length && /^\s*>/.test(lines[i])) { quote.push(lines[i].trim().replace(/^>\s?/, '')); i += 1; }
        add('quote', quote.filter((q) => !/^-{4,9}$/.test(q.trim())).join('\n'));
        continue;
      }
      if ((m = /^( +)\*\s?(.*)$/.exec(line))) { add('ul', m[2], Math.min(3, m[1].length - 1)); continue; }
      if ((m = /^( +)(?:1|a|A|i|I)\.(?:#\d+)?\s?(.*)$/.exec(line))) { add('ol', m[2], Math.min(3, m[1].length - 1)); continue; }
      if ((m = /^( +)(\S.*)$/.exec(line))) { add('p', m[2], Math.min(3, m[1].length)); continue; }
      add('p', t);
    }
    const seen = new Set();
    return { blocks, categories: cats.filter((c) => !seen.has(c) && seen.add(c)).slice(0, 30) };
  }

  return { looksLike, convert };
})();
