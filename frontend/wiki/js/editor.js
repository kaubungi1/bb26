/* 불법위키 — 글 블록 편집.

   편집은 문서 머리의 '편집'(또는 문단 제목의 [편집])을 누른 뒤에만 된다. 읽는 화면에서는 글을 눌러도 아무 일이 없다.
   편집 상태에서는 문법 없이 그 자리에서 쓴다. 꾸밈·링크·제목 단계·들여쓰기는 위의 도구 줄(tools.js)에서 한다.
   고친 것은 화면에만 쌓이고, 도구 줄의 '저장'을 눌러야 서버로 간다(wiki.js commitAll). '취소'하면 버린다.

   동작
     누름          그 문단이 입력칸이 된다. 자동 링크를 뺀 모양으로 다시 그리고 누른 자리에 커서를 둔다.
     Enter         문단을 둘로 나눈다(새 블록). Shift+Enter 는 문단 안의 줄바꿈.
     맨 앞 Backspace  들여 쓴 글은 한 단계 내어 쓰고, 소제목·목록은 문단으로 돌아가고, 문단은 윗문단과 합친다.
     Tab           들여쓰기. Shift+Tab 은 내어쓰기.
     벗어남        DOM 을 조각(run)으로 읽어 문서에 옮긴다. 비었으면 블록을 뺀다.

   한글 입력: 조합 중에는 DOM 을 건드리지 않는다(다시 그리면 조합이 깨진다).
   Enter 는 keydown 이 아니라 beforeinput(insertParagraph)에서 받는다 — 조합 중 Enter 의 keydown 은 믿을 수 없다.
   브라우저가 그래도 줄(<div>·<br>)을 끼워 넣으면 조각으로 읽을 때 문단 안의 줄바꿈이 된다. 글은 잃지 않는다.

   붙여넣기는 글자만 받는다. 남의 HTML 은 들어오지 않는다. */
const WikiEdit = (() => {
  const TEXT_KINDS = WikiRender.TEXT_KINDS;
  const HEADS = ['h2', 'h3', 'h4'];            /* 대분류 · 중분류 · 소분류 */
  const IDLE_MS = 2500;
  const SOFT = '.wk-toolbar, .wk-pop, .wk-menu';    /* 여기로 초점이 가는 것은 편집을 떠난 것이 아니다 */

  let cur = null;      /* { box, host, cid, composing, timer, range } */
  let wired = false;

  /* ---------- DOM → 조각 ---------- */
  function runsOf(root) {
    const out = [];
    const push = (text, marks) => {
      text = text.replace(/ /g, ' ').replace(/[​﻿]/g, '');
      if (!text) return;
      const run = { t: text };
      for (const k of ['b', 's', 'i']) if (marks[k]) run[k] = 1;
      for (const k of ['c', 'g', 'z', 'r']) if (marks[k]) run[k] = marks[k];
      if (marks.a) run.a = marks.a; else if (marks.w) run.w = marks.w; else if (marks.n) run.n = 1;
      const last = out[out.length - 1];
      /* 윗글자가 붙은 조각은 이웃과 합치지 않는다 — 윗글자는 그 글자에만 붙는다(서버도 같다) */
      if (last && last.f === undefined && !last.r && !run.r && sameMarks(last, run)) last.t += text;
      else out.push(run);
    };
    const walk = (node, marks) => {
      if (node.nodeType === 3) { push(node.nodeValue, marks); return; }
      if (node.nodeType !== 1 && node.nodeType !== 11) return;
      if (node.nodeType === 1) {
        const tag = node.tagName;
        if (tag === 'BR') { push('\n', marks); return; }
        if (node.dataset.f !== undefined) { if (node.dataset.f) out.push({ t: '', f: node.dataset.f }); return; }
        marks = { ...marks };
        const st = node.style;
        if (tag === 'B' || tag === 'STRONG' || st.fontWeight === 'bold' || Number(st.fontWeight) >= 600) marks.b = 1;
        if (tag === 'S' || tag === 'STRIKE' || tag === 'DEL' || /line-through/.test(st.textDecoration + st.textDecorationLine)) marks.s = 1;
        if (tag === 'I' || tag === 'EM' || st.fontStyle === 'italic') marks.i = 1;
        if (tag === 'RT' || tag === 'RP') return;                    /* 윗글자 자체는 글이 아니다 */
        if (tag === 'RUBY') {                                         /* 윗글자는 그 자리에서 고친 <rt> 의 글자를 읽는다 */
          const rt = node.querySelector('rt');
          const reading = (rt ? rt.textContent : node.dataset.r || '').replace(/\s+/g, ' ').trim();
          if (reading) marks.r = reading.slice(0, 100); else delete marks.r;
        }
        /* 색·크기. 우리가 그린 것(data-c·g·z)과 브라우저가 execCommand 로 만든 것(<font>, style)을 둘 다 읽는다. */
        const fg = node.dataset.c || hex(tag === 'FONT' ? node.getAttribute('color') : '') || hex(st.color);
        const bg = node.dataset.g || hex(st.backgroundColor);
        if (fg) marks.c = fg;
        if (bg) marks.g = bg;
        const size = sizeOf(node);                                    /* 0 은 '보통으로 되돌림' 이다 */
        if (size !== null) { if (size) marks.z = size; else delete marks.z; }
        if (tag === 'A' && !node.classList.contains('wk-auto')) {
          const link = node.getAttribute('href') || '';
          if (node.dataset.w) marks.w = node.dataset.w;
          else if (link.startsWith('wiki:')) { try { marks.w = decodeURIComponent(link.slice(5)); } catch { /* 깨진 주소는 글자로 둔다 */ } }
          else if (link.startsWith('nolink:')) marks.n = 1;
          else if (/^https?:\/\//i.test(link)) marks.a = link;
        }
        /* 브라우저가 줄을 <div>·<p> 로 끼워 넣었을 때 */
        if ((tag === 'DIV' || tag === 'P') && out.length && !out[out.length - 1].t.endsWith('\n')) push('\n', {});
      }
      node.childNodes.forEach((child) => walk(child, marks));
    };
    /* 담는 그릇(문단 칸·표의 칸) 자체의 모양은 글의 꾸밈이 아니다. 표의 칸에 건 칸 색이 글자의 배경색으로 읽히지 않게 그 안쪽만 훑는다. */
    root.childNodes.forEach((child) => walk(child, {}));
    while (out.length && out[out.length - 1].f === undefined) {       /* 끝의 빈 줄은 버린다 */
      const last = out[out.length - 1];
      last.t = last.t.replace(/\n+$/, '');
      if (last.t) break;
      out.pop();
    }
    return out;
  }
  function sameMarks(a, b) {
    return ['b', 's', 'i', 'c', 'g', 'z', 'r', 'a', 'w', 'n'].every((k) => a[k] === b[k]);
  }
  /* CSS 색 값을 저장하는 모양(#rrggbb 또는 영문 이름)으로. 브라우저는 style 에 넣은 색을 rgb(…) 로 돌려준다. */
  function hex(value) {
    const v = String(value || '').trim().toLowerCase();
    if (!v || ['inherit', 'initial', 'unset', 'transparent', 'currentcolor', 'windowtext', 'canvastext'].includes(v)) return '';
    if (/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/.test(v) || /^[a-z]{3,20}$/.test(v)) return v;
    const m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:[\s,/]+([\d.]+))?\s*\)$/.exec(v);
    if (!m || (m[4] !== undefined && Number(m[4]) === 0)) return '';
    return '#' + [m[1], m[2], m[3]].map((n) => Math.min(255, Number(n)).toString(16).padStart(2, '0')).join('');
  }
  /* 이 요소가 정하는 글자 크기 단계. 정하지 않으면 null. <font size> 는 execCommand('fontSize') 가 만든다. */
  function sizeOf(node) {
    if (node.dataset.z !== undefined) return Number(node.dataset.z) || 0;
    if (node.tagName === 'FONT' && node.getAttribute('size')) return Math.max(-2, Math.min(4, Number(node.getAttribute('size')) - 3));
    return null;
  }
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const textLen = (runs) => runs.reduce((n, r) => n + r.t.length, 0);
  function join(a, b) {
    const out = a.map((r) => ({ ...r }));
    for (const r of b) {
      const last = out[out.length - 1];
      if (last && last.f === undefined && r.f === undefined && sameMarks(last, r)) last.t += r.t;
      else out.push({ ...r });
    }
    return out;
  }

  /* ---------- 커서 ---------- */
  function rangeAt(x, y) {
    if (document.caretPositionFromPoint) {
      const p = document.caretPositionFromPoint(x, y);
      if (!p) return null;
      const r = document.createRange();
      r.setStart(p.offsetNode, p.offset);
      r.collapse(true);
      return r;
    }
    return document.caretRangeFromPoint ? document.caretRangeFromPoint(x, y) : null;
  }

  /* 글자 수로 센 자리에 커서를 둔다. 각주 표시는 0 글자, 줄바꿈은 1 글자다(runsOf 와 같은 셈법). */
  function rangeAtOffset(host, offset) {
    const r = document.createRange();
    let left = offset;
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
      acceptNode: (n) => (n.nodeType === 1 && n.dataset.f !== undefined ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    let node;
    while ((node = walker.nextNode())) {
      if (node.nodeType === 3) {
        if (left <= node.length) { r.setStart(node, left); r.collapse(true); return r; }
        left -= node.length;
      } else if (node.tagName === 'BR') {
        if (left === 0) { r.setStartBefore(node); r.collapse(true); return r; }
        left -= 1;
      }
    }
    r.selectNodeContents(host);
    r.collapse(false);
    return r;
  }

  function place(host, at) {
    let r = null;
    if (at && typeof at === 'object') {
      r = rangeAt(at.x, at.y);
      if (r && !host.contains(r.startContainer)) r = null;
      const fn = r && (r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentElement).closest('[data-f]');
      if (fn) { r.setStartAfter(fn); r.collapse(true); }
    } else if (typeof at === 'number') {
      r = rangeAtOffset(host, at);
    }
    if (!r) {
      r = document.createRange();
      r.selectNodeContents(host);
      r.collapse(at === 'start');
    }
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  }

  /* 커서 앞쪽·뒤쪽의 글. 선택한 글은 먼저 지운다. */
  function halves() {
    const sel = getSelection();
    if (!cur || !sel.rangeCount || !cur.host.contains(sel.anchorNode)) return null;
    const r = sel.getRangeAt(0);
    r.deleteContents();
    const a = document.createRange();
    a.selectNodeContents(cur.host);
    a.setEnd(r.startContainer, r.startOffset);
    const b = document.createRange();
    b.selectNodeContents(cur.host);
    b.setStart(r.startContainer, r.startOffset);
    return [runsOf(a.cloneContents()), runsOf(b.cloneContents())];
  }

  function atStart() {
    const sel = getSelection();
    if (!cur || !sel.rangeCount || !sel.isCollapsed || !cur.host.contains(sel.anchorNode)) return false;
    const r = sel.getRangeAt(0);
    const pre = document.createRange();
    pre.selectNodeContents(cur.host);
    pre.setEnd(r.startContainer, r.startOffset);
    return !runsOf(pre.cloneContents()).length && !pre.cloneContents().querySelector('br');
  }

  /* ---------- 들어가기 · 나오기 ---------- */
  async function enter(box, at) {
    if (Wiki.readonly || Wiki.locked(box)) return;
    const host = box.querySelector('.wk-text');
    if (!host || (cur && cur.host === host)) return;
    if (!Nick.get() && !(await Nick.ensure())) return;
    Wiki.settle();
    const block = Wiki.block(box.dataset.cid);
    if (!block || !box.isConnected) return;
    box.classList.add('is-editing');
    Wiki.activate(box);
    host.contentEditable = 'true';
    host.spellcheck = false;
    host.replaceChildren(WikiRender.inline(block.data.runs, null));
    /* 문단이 윗글자·각주 같은 요소로 끝나면 그 뒤에 커서가 설 자리(폭 없는 글자)를 둔다. 없으면 끝에 이어 쓴 글이 그 요소 안으로 들어간다. */
    if (host.lastChild && host.lastChild.nodeType === 1) host.append(document.createTextNode('​'));
    cur = { box, host, cid: block.cid, composing: false, timer: 0, range: null };
    host.focus({ preventScroll: true });
    place(host, at);
  }

  /* 편집 중인 글을 문서에 옮기고 '고쳤다'고 적는다. leaving 이면 빈 블록을 뺀다. */
  function apply(c, leaving) {
    const block = Wiki.block(c.cid);
    if (!block) return;
    const runs = runsOf(c.host);
    const empty = !runs.length && !(block.kind === 'fold' && block.data.title);
    if (leaving && empty) { block.data = { ...block.data, runs: [] }; Wiki.dropBlock(c.cid); return; }
    if (same(runs, block.data.runs)) return;
    block.data = { ...block.data, runs };
    if (!empty) Wiki.save(c.cid);
  }

  function stop(c) {
    clearTimeout(c.timer);
    c.host.removeAttribute('contenteditable');
    c.box.classList.remove('is-editing');
  }

  function leave() {
    if (!cur) return;
    const c = cur;
    cur = null;
    stop(c);
    apply(c, true);
    WikiRender.paintAll();
  }

  function dirty() {
    if (!cur) return;
    const c = cur;
    clearTimeout(c.timer);
    c.timer = setTimeout(function tick() {
      if (cur !== c) return;
      if (c.composing) { c.timer = setTimeout(tick, IDLE_MS); return; }
      apply(c, false);
    }, IDLE_MS);
  }

  /* ---------- 나누기 · 합치기 ---------- */
  function split() {
    const c = cur;
    const block = Wiki.block(c.cid);
    const parts = halves();
    if (!block || !parts) return;
    const [left, right] = parts;
    const list = block.kind === 'ul' || block.kind === 'ol';
    if (!left.length && !right.length) {
      if (list) retype(c, block, 'p');             /* 빈 목록 줄에서 Enter: 목록을 끝낸다 */
      return;
    }
    if (!left.length) return;                      /* 문단 맨 앞의 Enter: 빈 문단은 두지 않는다 */
    cur = null;
    stop(c);
    block.data = { ...block.data, runs: left };
    Wiki.save(c.cid);
    const keep = block.kind === 'p' || list ? level(block) : 0;      /* 문단·목록은 들여쓰기 단계를 이어받는다 */
    const fresh = { cid: Wiki.newCid(), kind: list ? block.kind : 'p', data: keep ? { runs: right, level: keep } : { runs: right }, rev: 0 };
    const box = Wiki.addBlock(fresh, c.box);
    if (right.length) Wiki.save(fresh.cid);
    WikiRender.paintAll();
    enter(box, 'start');
  }

  function retype(c, block, kind) {
    block.kind = kind;
    WikiRender.retype(c.box, kind);
    const keep = HEADS.includes(kind) ? 0 : level(block);   /* 제목에는 글의 들여쓰기 단계를 두지 않는다 */
    block.data = keep ? { runs: runsOf(c.host), level: keep } : { runs: runsOf(c.host) };
    if (keep) c.box.dataset.lv = keep; else delete c.box.dataset.lv;
    if (block.data.runs.length) Wiki.save(c.cid); else Wiki.touch();
  }

  const level = (block) => block.data.level || 0;

  /* 들여쓰기 단계를 바꾼다. 고치는 중인 문단은 다시 그리지 않으므로 표시(data-lv)를 직접 건다.
     분류 제목에서는 분류의 단계를 바꾼다: 2. → 1.1. → 1.1.1. (위에 들어갈 분류가 있을 때만 안으로 들어간다) */
  function indent(box, by) {
    const block = Wiki.block(box.dataset.cid);
    if (!block || !TEXT_KINDS.includes(block.kind)) return false;
    if (HEADS.includes(block.kind)) {
      const next = HEADS.indexOf(block.kind) + by;
      if (next < 0 || next > 2) return false;
      if (by > 0) {
        let above = box.previousElementSibling;
        while (above && !above.dataset.head) above = above.previousElementSibling;
        if (!above || Number(above.dataset.head) < next) return false;
      }
      if (cur && cur.box === box) retype(cur, block, HEADS[next]);
      else { block.kind = HEADS[next]; WikiRender.retype(box, HEADS[next]); Wiki.save(block.cid); }
      WikiRender.paintAll();
      return true;
    }
    const next = Math.max(0, Math.min(3, level(block) + by));
    if (next === level(block)) return false;
    const data = { ...block.data };
    if (next) data.level = next; else delete data.level;
    block.data = data;
    if (next) box.dataset.lv = next; else delete box.dataset.lv;
    Wiki.save(block.cid);
    return true;
  }

  function mergeUp() {
    const c = cur;
    const block = Wiki.block(c.cid);
    if (!block || !TEXT_KINDS.includes(block.kind)) return false;
    if (level(block)) { indent(c.box, -1); return true; }
    if (block.kind !== 'p') { retype(c, block, 'p'); return true; }
    const prevBox = c.box.previousElementSibling;
    const prev = prevBox && Wiki.block(prevBox.dataset.cid);
    if (!prev || !TEXT_KINDS.includes(prev.kind)) return false;
    const mine = runsOf(c.host);
    const offset = textLen(prev.data.runs);
    cur = null;
    stop(c);
    Wiki.dropBlock(c.cid);
    prev.data = { ...prev.data, runs: join(prev.data.runs, mine) };
    if (prev.data.runs.length) Wiki.save(prev.cid);
    WikiRender.paintAll();
    enter(prevBox, offset);
    return true;
  }

  /* 여러 줄을 붙여넣으면 줄마다 문단이 된다. */
  function pasteLines(lines) {
    const c = cur;
    const block = Wiki.block(c.cid);
    const parts = halves();
    if (!block || !parts) return;
    const [left, right] = parts;
    cur = null;
    stop(c);
    block.data = { ...block.data, runs: join(left, [{ t: lines[0] }]) };
    Wiki.save(c.cid);
    const kind = block.kind === 'ul' || block.kind === 'ol' ? block.kind : 'p';
    let box = c.box;
    lines.slice(1).forEach((line, i, rest) => {
      const tail = i === rest.length - 1;
      const fresh = { cid: Wiki.newCid(), kind, data: { runs: tail ? join([{ t: line }], right) : [{ t: line }] }, rev: 0 };
      box = Wiki.addBlock(fresh, box);
      Wiki.save(fresh.cid);
    });
    WikiRender.paintAll();
    enter(box, lines[lines.length - 1].length);
  }

  /* 나무위키 문법으로 쓴 글을 붙여넣었다: 우리 블록으로 바꿔(namu.js) 지금 문단 아래에 넣는다.
     지금 문단이 비어 있으면 그 문단은 빼고 그 자리를 채운다. 분류([[분류:…]])는 문서의 분류에 더한다. */
  function pasteNamu(text) {
    const c = cur;
    const block = Wiki.block(c.cid);
    const parts = halves();
    if (!block || !parts) return;
    const made = WikiNamu.convert(text);
    if (!made.blocks.length && !made.categories.length) return;
    const [left, right] = parts;
    cur = null;
    stop(c);
    block.data = { ...block.data, runs: left };
    let box = c.box;
    for (const b of made.blocks) {
      const fresh = { cid: Wiki.newCid(), kind: b.kind, data: b.data, rev: 0 };
      box = Wiki.addBlock(fresh, box);
      Wiki.save(fresh.cid);
    }
    if (right.length) {
      const rest = { cid: Wiki.newCid(), kind: 'p', data: { runs: right }, rev: 0 };
      Wiki.addBlock(rest, box);
      Wiki.save(rest.cid);
    }
    if (left.length) Wiki.save(c.cid); else Wiki.dropBlock(c.cid);
    Wiki.addCategories(made.categories);
    WikiRender.paintAll();
  }

  function onPaste(e) {
    if (!cur || e.target.closest('.wk-text') !== cur.host) return;
    e.preventDefault();
    const files = [...(e.clipboardData.files || [])].filter((f) => f.type.startsWith('image/'));
    if (files.length) { WikiBlocks.insertImages(cur.box, files); return; }
    const text = (e.clipboardData.getData('text/plain') || '').replace(/\r/g, '');
    if (!text.trim()) return;
    const block = Wiki.block(cur.cid);
    /* 나무위키 문법으로 쓴 글이면 우리 블록으로 바꿔 넣는다(namu.js) */
    if (block && TEXT_KINDS.includes(block.kind) && WikiNamu.looksLike(text)) { pasteNamu(text); return; }
    const one = text.trim();
    if (/^https?:\/\/\S+$/i.test(one)) {
      const video = /youtu\.?be/i.test(one) && youtubeId(one);
      if (video && block && TEXT_KINDS.includes(block.kind) && !runsOf(cur.host).length) {
        const c = cur;                             /* 빈 문단에 유튜브 주소: 그 문단이 영상이 된다 */
        cur = null;
        stop(c);
        block.kind = 'yt';
        block.data = { v: video };
        WikiRender.retype(c.box, 'yt');
        Wiki.save(c.cid);
        WikiRender.paintAll();
        return;
      }
      const sel = getSelection();
      if (!sel.isCollapsed) document.execCommand('createLink', false, one);   /* 고른 글자에 주소: 그 글자가 링크 */
      else {
        const a = document.createElement('a');
        a.className = 'wk-ext';
        a.setAttribute('href', one);
        a.textContent = one;
        const r = sel.getRangeAt(0);
        r.insertNode(a);
        r.setStartAfter(a);
        r.collapse(true);
        sel.removeAllRanges();
        sel.addRange(r);
      }
      dirty();
      return;
    }
    const lines = text.split('\n').map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim());
    if (lines.length > 1 && block && TEXT_KINDS.includes(block.kind)) pasteLines(lines);
    else document.execCommand('insertText', false, lines.join('\n'));
  }

  /* ---------- 꾸밈 · 링크 (도구 줄이 부른다) ----------
     도구 줄을 눌러도 초점은 문단에 남는다(tools.js 가 pointerdown 을 막는다). 그래도 고른 자리를 따로 기억해 두고
     쓰기 직전에 되살린다 — 폰에서는 바깥을 건드리는 순간 고른 것이 풀리는 브라우저가 있다. */
  function onSelection() {
    if (!cur) return;
    const sel = getSelection();
    if (sel.rangeCount && cur.host.contains(sel.anchorNode) && cur.host.contains(sel.focusNode)) cur.range = sel.getRangeAt(0).cloneRange();
  }

  function restore() {
    if (!cur) return null;
    const sel = getSelection();
    cur.host.focus({ preventScroll: true });
    if (!cur.range) { const r = document.createRange(); r.selectNodeContents(cur.host); r.collapse(false); cur.range = r; }
    sel.removeAllRanges();
    sel.addRange(cur.range);
    return sel;
  }

  function linkedAt(range) {
    const node = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
    return node.closest('a') || range.cloneContents().querySelector('a');
  }
  function selectNode(sel, node) {
    const r = document.createRange();
    r.selectNodeContents(node);
    sel.removeAllRanges();
    sel.addRange(r);
  }

  /* 표의 칸에서 고른 글자. 칸은 문단 편집(cur)이 아니라 블록 편집(blocks.js)에 속하므로 지금 고른 자리를 그대로 쓴다. */
  function inCell() {
    const sel = getSelection();
    if (!sel.rangeCount || !sel.anchorNode) return null;
    const node = sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement;
    return node && node.closest('[data-rich]') ? sel : null;          /* 표의 칸 · 가사의 줄 */
  }
  const hasSelection = () => !!cur || !!inCell();

  function formatInCell(act, value) {
    const sel = inCell();
    if (!sel) return;
    if (act === 's') document.execCommand('strikeThrough');
    else if (act === 'b') document.execCommand('bold');
    else if (act === 'c') document.execCommand('foreColor', false, value);
    else if (act === 'g') document.execCommand('hiliteColor', false, value);
    else if (act === 'up' || act === 'down') resize(sel, act === 'up' ? 1 : -1);
    else if (act === 'clear') document.execCommand('removeFormat');
    Wiki.touch();
  }

  /* 글자 크기를 한 단계 키우거나 줄인다. 지금 자리의 크기에서 센다. */
  function resize(sel, by) {
    const node = sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement;
    const at = node.closest('[data-z], font[size]');
    const now = at ? (sizeOf(at) || 0) : 0;
    document.execCommand('fontSize', false, String(Math.max(-2, Math.min(4, now + by)) + 3));
  }

  /* 윗글자(후리가나): 고른 글자 위에 작은 글씨를 올린다. 이미 있으면 고치고, 비우면 뗀다. */
  async function ruby() {
    const c = cur;
    if (!c || !c.range) return;
    const range = c.range.cloneRange();
    const node = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
    const old = node.closest('ruby');
    if (range.collapsed && !old) return;
    const rect = (old || range).getBoundingClientRect();
    const value = await Wiki.ask(rect, { value: old ? old.dataset.r : '', placeholder: '위에 올릴 글자' });
    if (cur !== c) return;
    c.range = range;
    restore();
    if (value === null) return;
    const text = value.replace(/\s+/g, ' ').trim().slice(0, 100);
    if (old) {
      if (text) { old.dataset.r = text; old.querySelector('rt').textContent = text; }
      else old.replaceWith(...[...old.childNodes].filter((n) => n.nodeName !== 'RT'));
    } else if (text) {
      const wrap = document.createElement('ruby');
      wrap.dataset.r = text;
      wrap.append(range.extractContents());
      const rt = document.createElement('rt');
      rt.textContent = text;
      wrap.append(rt);
      range.insertNode(wrap);
      /* 커서를 윗글자 밖(뒤)에 둔다. 그냥 '요소 뒤'에 두면 브라우저가 커서를 윗글자 칸(<rt>)의 끝으로 끌고 가서
         이어 쓰는 글이 윗글자가 된다. 폭 없는 글자를 하나 두고 그 뒤에 세운다(읽을 때 runsOf 가 걷어 낸다). */
      const anchor = document.createTextNode('​');
      wrap.after(anchor);
      const after = document.createRange();
      after.setStart(anchor, 1);
      after.collapse(true);
      getSelection().removeAllRanges();
      getSelection().addRange(after);
    }
    dirty();
  }

  function format(act, value) {
    if (!cur) { formatInCell(act, value); return; }
    const sel = restore();
    if (!sel) return;
    if (act === 's') document.execCommand('strikeThrough');
    else if (act === 'b') document.execCommand('bold');
    else if (act === 'c') document.execCommand('foreColor', false, value);
    else if (act === 'g') document.execCommand('hiliteColor', false, value);
    else if (act === 'up' || act === 'down') resize(sel, act === 'up' ? 1 : -1);
    else if (act === 'clear') document.execCommand('removeFormat');
    else if (act === 'ruby') { ruby(); return; }
    else if (act === 'x') {
      /* 걸린 링크면 푼다. 맨 글자를 골랐으면 '여기는 자동으로 걸지 말 것' 표시를 한다. */
      const linked = linkedAt(cur.range);
      if (sel.isCollapsed && !linked) return;
      if (linked && sel.isCollapsed) selectNode(sel, linked);
      if (linked) document.execCommand('unlink');
      else document.execCommand('createLink', false, 'nolink:');
    } else if (act === 'f') {
      const r = cur.range.cloneRange();
      r.collapse(false);
      const sup = WikiRender.inline([{ t: '', f: '' }], null).firstChild;
      r.insertNode(sup);
      footnote(sup);
    }
    dirty();
  }

  function decodeLink(url) {
    if (url.startsWith('wiki:')) { try { return decodeURIComponent(url.slice(5)); } catch { return ''; } }
    return url.startsWith('nolink:') ? '' : url;
  }

  /* 링크: 고른 글자를 문서(또는 주소)로 건다. 고른 글자가 없으면 그 자리에 링크를 써 넣는다.
     작은 입력창에 문서 제목이 자동 완성으로 뜬다. http 로 시작하면 바깥 링크다. */
  async function link(anchor) {
    const c = cur;
    if (!c || !restore()) return;
    const range = c.range.cloneRange();
    const old = linkedAt(range);
    const picked = range.toString().replace(/\s+/g, ' ').trim();
    const before = old ? (old.dataset.w || decodeLink(old.getAttribute('href') || '')) : picked;
    const rect = range.getBoundingClientRect();
    const value = await Wiki.ask(rect.width || rect.height ? rect : anchor,
      { value: before.slice(0, 200), placeholder: '문서 제목 또는 주소', titles: true });
    if (cur !== c) return;
    c.range = range;
    const sel = restore();
    const target = (value || '').trim();
    if (!target) return;
    const url = /^https?:\/\/\S+$/i.test(target) ? target : 'wiki:' + encodeURIComponent(target.slice(0, 60));
    if (sel.isCollapsed && old) selectNode(sel, old);
    if (sel.isCollapsed) {
      const a = document.createElement('a');
      a.className = url.startsWith('wiki:') ? 'wk-link' : 'wk-ext';
      a.setAttribute('href', url);
      a.textContent = target;
      const r = sel.getRangeAt(0);
      r.insertNode(a);
      r.setStartAfter(a);
      r.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r);
    } else document.execCommand('createLink', false, url);
    dirty();
  }

  /* 제목 단계·목록·인용: 고치는 중인 문단의 종류를 바꾼다. 커서는 그대로 남는다. */
  function setKind(kind) {
    const block = cur && Wiki.block(cur.cid);
    if (!block || !TEXT_KINDS.includes(block.kind) || block.kind === kind) return false;
    retype(cur, block, kind);
    return true;
  }

  async function footnote(sup) {
    const c = cur;
    const text = await Wiki.ask(sup.getBoundingClientRect(), { value: sup.dataset.f, placeholder: '각주' });
    if (!sup.isConnected) return;
    if (text === null ? !sup.dataset.f : !text.trim()) sup.remove();
    else if (text !== null) sup.dataset.f = text.trim().slice(0, 500);
    if (cur !== c) return;
    c.host.focus({ preventScroll: true });
    if (sup.isConnected) {
      const r = document.createRange();
      r.setStartAfter(sup);
      r.collapse(true);
      getSelection().removeAllRanges();
      getSelection().addRange(r);
    }
    dirty();
  }

  /* ---------- 위아래 문단으로 ---------- */
  function onEdge(dir) {
    const sel = getSelection();
    if (!sel.rangeCount || !sel.isCollapsed) return false;
    const host = cur.host.getBoundingClientRect();
    const rect = sel.getRangeAt(0).getClientRects()[0];
    if (!rect) return true;                        /* 빈 문단 */
    const line = parseFloat(getComputedStyle(cur.host).lineHeight) || 26;
    return dir < 0 ? rect.top - host.top < line * 0.8 : host.bottom - rect.bottom < line * 0.8;
  }

  function neighbor(box, dir) {
    let n = box;
    while ((n = dir < 0 ? n.previousElementSibling : n.nextElementSibling)) {
      if (!n.classList.contains('wk-block')) continue;
      if (TEXT_KINDS.includes(n.dataset.kind)) return n;
    }
    return null;
  }

  function onKey(e) {
    if (!cur || e.target !== cur.host || e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Escape') { e.preventDefault(); leave(); return; }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'x' || e.key === 'X')) {
      e.preventDefault();
      document.execCommand('strikeThrough');
      dirty();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); link(cur.host.getBoundingClientRect()); return; }
    if (e.key === 'Tab' && !e.altKey && !e.ctrlKey && !e.metaKey) { e.preventDefault(); indent(cur.box, e.shiftKey ? -1 : 1); return; }
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
      const dir = e.key === 'ArrowUp' ? -1 : 1;
      const next = onEdge(dir) && neighbor(cur.box, dir);
      if (next) { e.preventDefault(); enter(next, dir < 0 ? 'end' : 'start'); }
    }
  }

  function onBeforeInput(e) {
    if (!cur || e.target !== cur.host) return;
    if (e.inputType === 'insertParagraph') {
      e.preventDefault();
      const block = Wiki.block(cur.cid);
      if (block && TEXT_KINDS.includes(block.kind)) split();
      else document.execCommand('insertLineBreak');             /* 접기 본문: 블록을 나누지 않고 줄만 바꾼다 */
    } else if (e.inputType === 'deleteContentBackward' && atStart()) {
      if (mergeUp()) e.preventDefault();
    }
  }

  /* 문서 화면을 새로 세울 때마다 부른다. 본문에 거는 것은 매번, 문서 바깥에 거는 것은 한 번만. */
  function init(body) {
    if (!wired) {
      wired = true;
      document.addEventListener('selectionchange', onSelection);
    }
    cur = null;
    body.addEventListener('click', (e) => {
      const host = e.target.closest('.wk-text');
      const box = host && host.closest('.wk-block');
      if (!box || box.parentElement !== body) return;           /* 틀로 끼운 문서의 문단은 여기서 고치지 않는다 */
      const link = e.target.closest('a');
      if (cur && cur.host === host) {
        if (link) e.preventDefault();
        const fn = e.target.closest('[data-f]');
        if (fn) footnote(fn);
        return;
      }
      if (link || !getSelection().isCollapsed) return;          /* 링크는 따라가고, 글자를 끌어 고르는 중이면 그냥 둔다 */
      if (e.target.closest('[data-f]')) return;
      enter(box, { x: e.clientX, y: e.clientY });
    });
    body.addEventListener('focusout', (e) => {
      if (!cur || e.target !== cur.host) return;
      if (e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest(SOFT)) return;
      const c = cur;
      setTimeout(() => {
        if (cur !== c || document.activeElement === c.host) return;
        if (document.activeElement && document.activeElement.closest(SOFT)) return;
        leave();
      }, 0);
    });
    body.addEventListener('beforeinput', onBeforeInput);
    body.addEventListener('keydown', onKey);
    body.addEventListener('paste', onPaste);
    body.addEventListener('input', (e) => { if (cur && e.target === cur.host) dirty(); });
    body.addEventListener('compositionstart', (e) => { if (cur && e.target === cur.host) cur.composing = true; });
    body.addEventListener('compositionend', (e) => { if (cur && e.target === cur.host) { cur.composing = false; dirty(); } });
  }

  return { init, enter, leave, runsOf, rangeAt, format, link, setKind, indent, hasSelection, active: () => cur };
})();
