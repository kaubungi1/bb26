/* 불법위키 — 문서를 그린다.

   저장된 글은 HTML 이 아니라 조각(run)의 목록이다(backend/wikitext.py). 여기서는 createElement·textContent 로만
   그린다 — innerHTML 에 저장된 글을 넣지 않는다. 그래서 누가 무엇을 써도 글자로만 보인다.

   두 가지로 그린다.
     읽기   자동 링크, 각주 번호, 소제목 번호가 붙는다. 이 셋은 문서 전체를 훑어야 정해지므로 paintAll 이 한 번에 매긴다.
     편집   자동 링크를 빼고 조각 그대로 그린다(editor.js 가 이 DOM 을 다시 조각으로 읽는다). */
const WikiRender = (() => {
  const TEXT_KINDS = ['p', 'h2', 'h3', 'h4', 'ul', 'ol', 'quote', 'notice'];
  const HEAD = { h2: 1, h3: 2, h4: 3 };                /* 대분류 · 중분류 · 소분류 */
  const LEVEL_NAME = ['대분류', '중분류', '소분류'];

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  const href = (title) => '/wiki/' + encodeURIComponent(title);

  /* 줄바꿈(\n)은 <br> 로. */
  function textNodes(text) {
    const frag = document.createDocumentFragment();
    String(text).split('\n').forEach((part, i) => {
      if (i) frag.append(document.createElement('br'));
      if (part) frag.append(document.createTextNode(part));
    });
    return frag;
  }

  function pageLink(title, body, auto) {
    const a = el('a', 'wk-link' + (auto ? ' wk-auto' : ''));
    a.href = href(title);
    if (!auto) {
      a.dataset.w = title;
      if (!WikiLinks.find(title)) a.classList.add('is-new');
    }
    a.append(body);
    return a;
  }

  function autolinked(text, ctx) {
    const frag = document.createDocumentFragment();
    for (const seg of WikiLinks.split(text, ctx.used, ctx.selfId)) {
      frag.append(seg.page ? pageLink(seg.page.title, textNodes(seg.t), true) : textNodes(seg.t));
    }
    return frag;
  }

  /* 글자 크기 단계 → 크기. 0(보통)은 표에 없다. 단계는 브라우저의 글자 크기 일곱 단계에서 보통(3)을 0 으로 둔 값이다. */
  const SIZE = { '-2': '0.78em', '-1': '0.88em', 1: '1.2em', 2: '1.45em', 3: '1.75em', 4: '2.1em' };

  /* 글자색·배경색·크기·윗글자(후리가나)를 입힌다. 색은 서버가 #rgb·영문 이름만 통과시킨 값이고(wikitext.color),
     style 속성 문자열이 아니라 style.color 에 넣으므로 다른 선언이 끼어들 수 없다.
     편집할 때 윗글자는 그 자리에서 고친다(editor.js 가 <rt> 의 글자를 읽는다). 고칠 수 없는 칸으로 두면
     문단 끝에서 커서가 그 옆에 갇혀 키보드가 먹지 않는다(2026-11-13 검증에서 발견). */
  function styled(node, r) {
    if (r.r) {
      const ruby = el('ruby');
      ruby.dataset.r = r.r;
      const rt = el('rt', '', r.r);
      ruby.append(node, rt);
      node = ruby;
    }
    if (r.c || r.g || r.z) {
      const span = el('span', 'wk-st');
      if (r.c) { span.style.color = r.c; span.dataset.c = r.c; }
      if (r.g) { span.style.backgroundColor = r.g; span.dataset.g = r.g; }
      if (r.z && SIZE[r.z]) { span.style.fontSize = SIZE[r.z]; span.dataset.z = r.z; }
      span.append(node);
      node = span;
    }
    return node;
  }

  function wrap(tag, node) {
    const w = document.createElement(tag);
    w.append(node);
    return w;
  }

  /* ctx 가 없으면 편집용이다. */
  function inline(runs, ctx) {
    const frag = document.createDocumentFragment();
    for (const r of runs || []) {
      if (r.f !== undefined) {
        const sup = el('sup', 'wk-fn');
        sup.dataset.f = r.f;
        if (ctx) {
          ctx.notes.push(r.f);
          const a = el('a', '', `[${ctx.notes.length}]`);
          a.href = `#wk-note-${ctx.notes.length}`;
          a.title = r.f;
          sup.append(a);
        } else {
          sup.contentEditable = 'false';
          sup.textContent = '[주]';
        }
        frag.append(sup);
        continue;
      }
      let node;
      if (!ctx) {
        node = textNodes(r.t);
        const link = r.w ? 'wiki:' + encodeURIComponent(r.w) : r.n ? 'nolink:' : r.a || '';
        if (link) {
          const a = el('a', r.w ? 'wk-link' : r.n ? 'wk-nolink' : 'wk-ext');
          a.setAttribute('href', link);
          a.append(node);
          node = a;
        }
      } else if (r.w) {
        node = pageLink(r.w, textNodes(r.t), false);
      } else if (r.a) {
        node = el('a', 'wk-ext');
        node.href = r.a;
        node.target = '_blank';
        node.rel = 'noopener noreferrer nofollow';
        node.append(textNodes(r.t));
      } else if (r.n) {
        node = textNodes(r.t);
      } else {
        node = autolinked(r.t, ctx);
      }
      node = styled(node, r);
      if (r.i) node = wrap('i', node);
      if (r.s) node = wrap('s', node);
      if (r.b) node = wrap('b', node);
      frag.append(node);
    }
    return frag;
  }

  /* ---------- 블록의 뼈대 ---------- */
  function skeleton(kind) {
    if (TEXT_KINDS.includes(kind)) return el('div', 'wk-text');
    if (kind === 'fold') {
      const box = el('div', 'wk-fold');
      const tog = el('button', 'wk-fold-tog');
      tog.type = 'button';
      tog.setAttribute('aria-label', '펼치기');
      box.append(tog, el('div', 'wk-fold-title'), el('div', 'wk-text wk-fold-body'));
      return box;
    }
    if (kind === 'table') {
      const box = el('div', 'wk-table');
      const scroll = el('div', 'wk-table-scroll');
      scroll.append(document.createElement('table'));
      box.append(scroll);      /* 줄·칸을 더하고 빼는 단추는 마우스를 댄 줄 옆에 뜬다(blocks.js 줄 도구) */
      return box;
    }
    if (kind === 'infobox') {
      const box = el('aside', 'wk-info');
      box.append(el('div', 'wk-info-title'), el('div', 'wk-info-pic'), el('div', 'wk-info-rows'));
      return box;
    }
    if (kind === 'img') {
      const fig = el('figure', 'wk-fig');
      fig.append(document.createElement('img'), el('figcaption', 'wk-cap'));
      return fig;
    }
    if (kind === 'yt') return el('div', 'wk-yt');
    if (kind === 'lyric') return el('div', 'wk-lyr');
    const box = el('div', 'wk-embed');
    box.append(el('div', 'wk-embed-body'), el('a', 'wk-embed-src'));
    return box;
  }

  function make(block) {
    const box = el('div', `wk-block k-${block.kind}`);
    box.dataset.cid = block.cid;
    box.dataset.kind = block.kind;
    const grip = el('button', 'wk-grip');
    grip.type = 'button';
    grip.tabIndex = -1;
    grip.setAttribute('aria-label', '블록 메뉴');
    /* 문단 제목 오른쪽의 [편집]. 제목 블록에서만 보인다(wiki.css). 누르면 그 구역만 편집 상태가 된다. */
    const sec = el('button', 'wk-sec', '편집');
    sec.type = 'button';
    sec.tabIndex = -1;
    box.append(grip, sec, skeleton(block.kind));
    return box;
  }

  /* 블록의 내용 칸. 손잡이·[편집]·저장 실패 표시를 뺀 하나다. */
  function content(box) {
    return [...box.children].find((c) => !c.matches('.wk-grip, .wk-sec, .wk-flag'));
  }

  /* 종류가 바뀌면(문단 → 소제목, 문단 → 유튜브) 뼈대를 갈아 끼운다. */
  function retype(box, kind) {
    const was = box.dataset.kind;
    box.classList.remove(`k-${was}`);
    box.classList.add(`k-${kind}`);
    box.dataset.kind = kind;
    if (!(TEXT_KINDS.includes(was) && TEXT_KINDS.includes(kind))) {
      content(box).replaceWith(skeleton(kind));
      delete box.dataset.sig;
    }
  }

  function setImage(img, doc, id) {
    const info = doc.images && doc.images[id];
    if (!info) { img.removeAttribute('src'); img.hidden = true; return; }
    img.hidden = false;
    if (img.getAttribute('src') !== info.url) img.src = info.url;
    if (info.w && info.h) { img.width = info.w; img.height = info.h; }
    img.alt = '';
    img.loading = 'lazy';
  }

  /* ---------- 읽기용으로 채운다 ---------- */
  function paint(box, block, ctx) {
    const kind = block.kind;
    const data = block.data;
    if (TEXT_KINDS.includes(kind)) {
      const host = box.querySelector('.wk-text');
      host.replaceChildren(inline(data.runs, ctx));
      const level = data.level || 0;
      if (level) box.dataset.lv = level; else delete box.dataset.lv;
      /* 번호 목록의 번호. 단계마다 따로 세고, 목록이 끊기면 처음부터 다시 센다. */
      if (kind === 'ol') {
        ctx.ol.length = level + 1;
        ctx.ol[level] = (ctx.ol[level] || 0) + 1;
      } else ctx.ol.length = Math.min(ctx.ol.length, level);   /* 들여 쓴 글은 바깥 단계의 번호를 끊지 않는다 */
      if (HEAD[kind]) {
        /* 이 문서의 제목 번호는 layout 이 매긴다(고치는 중인 제목도 세어야 해서). 여기서는 틀로 끼운 문서의 제목만. */
        if (ctx.depth) { const got = numbered(ctx, kind); host.dataset.num = got.num; box.dataset.head = got.e; }
      } else {
        if (kind === 'ol') host.dataset.num = `${ctx.ol[level]}.`; else delete host.dataset.num;
        box.removeAttribute('id');
      }
      return;
    }
    ctx.ol.length = 0;
    if (kind === 'fold') {
      box.querySelector('.wk-fold-title').replaceChildren(autolinked(data.title || '', ctx));
      box.querySelector('.wk-fold-body').replaceChildren(inline(data.runs, ctx));
      return;
    }
    if (kind === 'table') {
      box.dataset.al = data.align || '';          /* 표를 놓는 자리: c 가운데 · r 오른쪽(wiki.css) */
      WikiTable.paint(box.querySelector('table'), data, (td, runs) => td.append(inline(runs, ctx)));
      return;
    }
    if (kind === 'lyric') {
      WikiLyric.paint(box.querySelector('.wk-lyr'), data, (line, runs) => line.append(inline(runs, ctx)));
      return;
    }
    if (kind === 'infobox') {
      box.querySelector('.wk-info-title').replaceChildren(document.createTextNode(data.title || ''));
      const pic = box.querySelector('.wk-info-pic');
      /* 그림을 안 올린 멤버 문서의 정보 상자는 사이트의 프로필 사진을 보여 준다 */
      const face = !data.image && !ctx.depth ? Wiki.memberOf(ctx.doc) : null;
      if (data.image || (face && face.hasImage)) {
        let img = pic.querySelector('img');
        if (!img) { pic.replaceChildren(); img = document.createElement('img'); pic.append(img); }
        if (data.image) setImage(img, ctx.doc, data.image);
        else {
          const url = imageUrl(face);
          if (img.getAttribute('src') !== url) img.src = url;
          img.removeAttribute('width'); img.removeAttribute('height');
          img.hidden = false; img.alt = '';
        }
      } else pic.replaceChildren();
      const rows = box.querySelector('.wk-info-rows');
      rows.replaceChildren();
      for (const [k, v] of data.rows) {
        if (!v && Wiki.readonly) continue;        /* 내용을 안 채운 줄은 읽는 화면에 보이지 않는다(프로필 표의 빈 항목) */
        const row = el('div', 'wk-info-row');
        const dd = el('div', 'wk-info-v');
        dd.append(autolinked(v, ctx));
        row.append(el('div', 'wk-info-k', k), dd);
        rows.append(row);
      }
      return;
    }
    /* 아래 셋은 글자가 아니라 바깥 자원이다. 내용이 그대로면 다시 그리지 않는다(그림이 깜빡이지 않게). */
    const sig = JSON.stringify(data);
    if (kind === 'img') {
      setImage(box.querySelector('img'), ctx.doc, data.image);
      box.querySelector('.wk-cap').replaceChildren(autolinked(data.caption || '', ctx));
      return;
    }
    if (box.dataset.sig === sig) return;
    box.dataset.sig = sig;
    if (kind === 'yt') {
      const host = box.querySelector('.wk-yt');
      const play = el('button', 'wk-yt-play');
      play.type = 'button';
      play.setAttribute('aria-label', '영상 재생');
      const img = document.createElement('img');
      img.src = `https://i.ytimg.com/vi/${encodeURIComponent(data.v)}/hqdefault.jpg`;
      img.alt = '';
      img.loading = 'lazy';
      play.append(img, el('span', 'wk-yt-mark'));
      play.addEventListener('click', () => {
        /* 누르기 전에는 영상 틀을 싣지 않는다. 문서를 여는 것만으로 유튜브 스크립트가 따라오지 않게. */
        const frame = document.createElement('iframe');
        frame.src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(data.v)}?autoplay=1`;
        frame.allow = 'autoplay; encrypted-media; picture-in-picture';
        frame.allowFullscreen = true;
        frame.title = '유튜브 영상';
        host.replaceChildren(frame);
      });
      host.replaceChildren(play);
      return;
    }
    /* 틀: 다른 문서의 본문을 끼워 넣는다. 그 문서를 고치면 끼운 곳이 모두 따라온다. */
    const body = box.querySelector('.wk-embed-body');
    const src = box.querySelector('.wk-embed-src');
    src.href = href(data.title);
    src.textContent = data.title;
    src.classList.toggle('is-new', !WikiLinks.find(data.title));
    body.replaceChildren();
    if (ctx.depth) return;                       /* 틀 안의 틀은 펼치지 않는다 */
    Wiki.fetchEmbed(data.title).then((doc) => {
      if (box.dataset.sig !== sig || !doc || !doc.exists || doc.deleted) return;
      const inner = { used: new Set(), notes: [], nums: [0, 0, 0], open: 0, ol: [], selfId: ctx.selfId, doc, depth: 1 };
      for (const b of doc.blocks) {
        if (b.kind === 'embed') continue;
        const child = make(b);
        child.querySelector('.wk-grip').remove();
        child.querySelector('.wk-sec').remove();
        paint(child, b, inner);
        body.append(child);
      }
    }).catch(() => {});
  }

  function context(doc) {
    return { used: new Set(), notes: [], nums: [0, 0, 0], open: 0, ol: [], selfId: doc.id || 0, doc, depth: 0 };
  }

  /* 문서 전체를 읽기용으로 다시 매긴다. 편집 중인 블록은 건드리지 않는다. */
  function paintAll() {
    const doc = Wiki.doc;
    const body = document.getElementById('wk-body');
    if (!doc || !body) return;
    const ctx = context(doc);
    /* 멤버 문서의 프로필 표. 아직 문서에 넣지 않은 것은 읽는 화면에서 그려만 준다(문서의 블록이 아니다).
       편집에 들어가면 진짜 정보 상자 블록이 되어 문서에 들어간다(wiki.js edit). */
    body.querySelectorAll(':scope > .wk-virtual').forEach((n) => n.remove());
    const profile = Wiki.readonly && !Wiki.live && doc.exists ? Wiki.profileFor(doc) : null;
    if (profile) {
      const made = el('div', 'wk-virtual k-infobox');
      made.append(skeleton('infobox'));
      paint(made, { kind: 'infobox', data: profile }, ctx);
      body.prepend(made);
    }
    for (const box of body.querySelectorAll(':scope > .wk-block')) {
      if (box.classList.contains('is-editing')) continue;
      const block = Wiki.block(box.dataset.cid);
      if (block) paint(box, block, ctx);
    }
    layout(body);
    paintNotes(ctx.notes);
  }

  /* ---------- 분류의 구조: 번호 · 목차 · 편집 상자 ----------
     문서는 블록의 한 줄이고, 분류(대·중·소)는 제목 블록(h2·h3·h4)이 가른다. 제목 다음부터 같거나 더 큰 제목 앞까지가 그 분류다.

     읽는 화면   제목에 번호(1. / 1.1. / 1.1.1.)를 붙이고 목차를 만든다.
     편집 화면   분류를 상자로 보여 준다(2026-11-13 사용자 결정: "박스와 들여쓰기 구조"). 상자 안의 상자가 아래 분류다.
                 상자의 끝에는 '＋ 2.2. 중분류' 처럼 그 자리에 생길 번호를 말하는 단추가 있다. 단계를 고르거나 세는 일이 없다.

     DOM 은 그대로 한 줄이다(#wk-body > .wk-block). 상자는 줄마다 단 깊이(data-depth)와 CSS 로 그린다(wiki.css '분류 상자').
     상자를 닫는 줄·더하기 단추·빈 분류의 안내는 .wk-deco 로 사이에 끼워 넣고, 그릴 때마다 걷었다가 다시 놓는다.
     블록을 감싸는 상자를 실제로 만들지 않는 이유: 편집기(나누기·합치기·옮기기)가 블록이 형제라는 것에 기대고 있다. */
  function numbered(state, kind) {
    /* 단계를 건너뛴 제목(대분류 바로 아래의 소분류)은 한 단계만 들어간 것으로 본다. */
    const e = Math.min(HEAD[kind], state.open + 1);
    state.nums[e - 1] += 1;
    for (let i = e; i < 3; i += 1) state.nums[i] = 0;
    state.open = e;
    return { e, num: state.nums.slice(0, e).join('.') + '.' };
  }

  function deco(cls, depth, parent) {
    const row = el('div', `wk-deco ${cls}`);
    row.dataset.depth = depth;
    row.dataset.parent = parent || '';
    return row;
  }
  function addButton(level, num, parent) {
    const b = el('button', 'wk-add-sec');
    b.type = 'button';
    b.dataset.level = level;
    b.dataset.num = num;
    b.dataset.parent = parent || '';
    b.append(el('span', 'wk-add-plus', '+'), el('b', '', num), document.createTextNode(` ${LEVEL_NAME[level - 1]}`));
    return b;
  }

  function layout(body) {
    const editing = !Wiki.readonly;
    body.querySelectorAll(':scope > .wk-deco').forEach((n) => n.remove());
    const state = { nums: [0, 0, 0], open: 0 };
    const stack = [];                  /* 열려 있는 분류: { e 단계, cid 제목 블록, kids 아래 분류 수, filled 본문이 있는가, num } */
    const toc = [];
    const hint = (parent, depth, before) => {
      const row = deco('wk-ph', depth, parent);
      row.textContent = '내용을 입력하세요';
      body.insertBefore(row, before);
    };
    /* level 이상의 분류를 닫는다. 닫는 줄은 before 앞에 놓인다. */
    const close = (level, before) => {
      while (stack.length && stack[stack.length - 1].e >= level) {
        const s = stack.pop();
        if (!editing) continue;
        if (!s.filled && !s.kids) hint(s.cid, s.e, before);
        const row = deco('wk-secend', s.e - 1, s.cid);
        const inner = el('div', 'wk-secend-in');
        inner.dataset.head = s.e;
        if (s.e < 3) inner.append(addButton(s.e + 1, `${s.num}${s.kids + 1}.`, s.cid));
        row.append(inner);
        body.insertBefore(row, before);
      }
    };
    const boxes = [...body.querySelectorAll(':scope > .wk-block')];
    /* 글이 아닌 블록(그림·영상·표…) 바로 뒤에 글이 오지 않으면 그 아래에 쓸 자리를 보여 준다. 없으면 그림을 넣은 뒤
       이어 쓸 길이 손잡이 메뉴뿐이다(2026-11-13 사용자 지적: 사진·영상을 넣고 다음 줄로 넘어가기 어렵다). */
    let lone = null;
    for (const box of boxes) {
      const block = Wiki.block(box.dataset.cid);
      if (!block) continue;
      const body_text = TEXT_KINDS.includes(block.kind) && !HEAD[block.kind];
      if (lone && !body_text && editing) hint(lone.cid, lone.depth, box);
      lone = null;
      if (HEAD[block.kind]) {
        const e = Math.min(HEAD[block.kind], state.open + 1);
        close(e, box);
        state.open = e - 1;
        const { num } = numbered(state, block.kind);
        const host = box.querySelector(':scope > .wk-text');
        host.dataset.num = num;
        box.id = `wk-h-${block.cid}`;
        box.dataset.head = e;
        box.dataset.depth = e - 1;                 /* 제목 줄은 바깥 상자 안에 있고, 제 상자의 윗변은 제목 칸이 그린다 */
        if (stack.length) stack[stack.length - 1].kids += 1;
        stack.push({ e, cid: block.cid, kids: 0, filled: false, num });
        toc.push({ id: box.id, num, text: host.textContent, level: e });
      } else {
        delete box.dataset.head;
        box.dataset.depth = state.open;
        if (stack.length) stack[stack.length - 1].filled = true;
        if (!body_text) lone = { cid: block.cid, depth: state.open };
      }
    }
    if (lone && editing) hint(lone.cid, lone.depth, null);
    close(1, null);
    if (editing) {
      /* 분류에 들지 않는 맨 앞 글의 자리 */
      if (boxes.length && boxes[0].dataset.head && !Wiki.scoped) hint('', 0, boxes[0]);
      const row = deco('wk-secend wk-add-top', 0, '');
      row.append(addButton(1, `${state.nums[0] + 1}.`, ''));
      body.append(row);
      if (Wiki.scoped) {
        body.querySelectorAll(':scope > .wk-deco').forEach((n) => {
          const owner = n.dataset.parent && Wiki.boxOf(n.dataset.parent);
          n.classList.toggle('in-scope', !!owner && owner.classList.contains('in-scope'));
        });
      }
    }
    const tail = document.getElementById('wk-tail');
    if (tail) tail.hidden = Wiki.readonly || Wiki.scoped || toc.length > 0;    /* 분류가 있으면 쓸 자리는 상자 안이다 */
    paintToc(toc);
  }


  function paintToc(toc) {
    const nav = document.getElementById('wk-toc');
    if (!nav) return;
    nav.hidden = !toc.length;
    const list = el('ol');
    for (const t of toc) {
      const li = el('li', t.level > 1 ? `is-sub${t.level}` : '');
      const a = el('a');
      a.href = `#${t.id}`;
      a.append(el('span', 'wk-toc-num', t.num), document.createTextNode(' ' + t.text));
      li.append(a);
      list.append(li);
    }
    nav.replaceChildren(el('b', 'wk-toc-head', '목차'), list);
  }

  function paintNotes(notes) {
    const box = document.getElementById('wk-notes');
    if (!box) return;
    box.hidden = !notes.length;
    const list = el('ol');
    notes.forEach((text, i) => {
      const li = el('li');
      li.id = `wk-note-${i + 1}`;
      li.append(el('span', 'wk-note-num', `[${i + 1}]`), document.createTextNode(' ' + text));
      list.append(li);
    });
    box.replaceChildren(list);
  }

  /* 문서의 블록을 통째로 세운다. */
  function mount(doc) {
    const body = document.getElementById('wk-body');
    body.replaceChildren(...doc.blocks.map(make));
    paintAll();
  }

  return { TEXT_KINDS, HEAD, SIZE, el, href, inline, make, retype, mount, paintAll, setImage };
})();
