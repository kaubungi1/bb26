/* 불법위키 — 글이 아닌 블록(표·정보 상자·그림·접기 제목)과 블록 메뉴.

   글 블록과 같은 원칙이다. 편집 상태에서 누르면 그 칸이 입력칸이 되고, 블록을 벗어나면 문서에 옮겨진다
   (서버로는 도구 줄의 '저장'을 눌러야 간다). 읽는 화면에서는 접기를 펼치는 것과 [편집] 말고는 아무것도 하지 않는다.
   정보 상자·그림 설명·접기 제목은 글자만 받는다. 표의 칸은 꾸밈(굵게·색·윗글자)도 받는다(table.js).
   본문의 문서 이름은 읽을 때 자동으로 링크가 된다.

   블록 메뉴는 블록 왼쪽 손잡이에서 열린다. 종류 바꾸기, 아래에 넣기, 위·아래로, 지우기.
   지운 블록은 이력에 남아 있어 되돌릴 수 있다 — 그래서 되묻지 않는다. */
const WikiBlocks = (() => {
  const { el, TEXT_KINDS } = WikiRender;
  const SOFT = '.wk-toolbar, .wk-pop, .wk-menu';
  const ONE_LINE = '.wk-info-title, .wk-info-k, .wk-cap, .wk-fold-title, .wk-lo, .wk-lr, .wk-lt';
  const CLICKABLE = 'td, th, .wk-info-title, .wk-info-k, .wk-info-v, .wk-fig, .wk-fold-title, .wk-lyr';
  const KIND_LABEL = { p: '본문', h2: '대분류', h3: '중분류', h4: '소분류', ul: '목록', ol: '번호 목록', quote: '인용', notice: '알림' };
  const INSERTS = [['p', '문단'], ['img', '그림'], ['yt', '영상'], ['table', '표'], ['infobox', '정보 상자'], ['fold', '접기'], ['lyric', '가사'], ['embed', '틀']];

  let act = null;       /* 편집 중인 블록 { box, cid } */
  let menu = null;
  let picker = null;

  /* ---------- 글자만 받는 칸 ---------- */
  function plain(node, text, hint) {
    node.textContent = text || '';
    node.contentEditable = 'plaintext-only';
    if (node.contentEditable !== 'plaintext-only') node.contentEditable = 'true';   /* 못 알아듣는 브라우저 */
    node.spellcheck = false;
    node.dataset.plain = '1';
    if (hint) node.dataset.hint = hint;
    return node;
  }
  function read(node, oneLine) {
    const text = (node.innerText || '').replace(/ /g, ' ').replace(/\r/g, '');
    return (oneLine ? text.replace(/\s+/g, ' ') : text.replace(/\n+$/, '')).trim();
  }

  /* ---------- 편집용으로 채운다 ---------- */
  function infoRow(k, v) {
    const row = el('div', 'wk-info-row');
    row.append(plain(el('div', 'wk-info-k'), k, '항목'), plain(el('div', 'wk-info-v'), v, '내용'));
    return row;
  }

  function paintEdit(box, block) {
    const data = block.data;
    if (block.kind === 'table') {
      /* 칸은 꾸밈을 받는다. 문단과 같은 조각으로 그리고 읽는다. */
      WikiTable.paint(box.querySelector('table'), data, (td, runs) => {
        td.append(WikiRender.inline(runs, null));
        td.contentEditable = 'true';
        td.spellcheck = false;
        td.dataset.plain = '1';
        td.dataset.rich = '1';
      });
    } else if (block.kind === 'lyric') {
      /* 소절이 없으면 빈 소절 하나를 세워 쓸 자리를 준다 */
      WikiLyric.paint(box.querySelector('.wk-lyr'), data.verses.length ? data : { verses: [WikiLyric.blank()] }, rich, true);
    } else if (block.kind === 'infobox') {
      plain(box.querySelector('.wk-info-title'), data.title, '제목');
      const rows = box.querySelector('.wk-info-rows');
      rows.replaceChildren(...data.rows.map(([k, v]) => infoRow(k, v)), infoRow('', ''));
      const pic = box.querySelector('.wk-info-pic');
      if (!data.image) {
        const pick = el('button', 'wk-info-pick', '그림');
        pick.type = 'button';
        pic.replaceChildren(pick);
      }
    } else if (block.kind === 'img') {
      plain(box.querySelector('.wk-cap'), data.caption, '설명');
    } else if (block.kind === 'fold') {
      plain(box.querySelector('.wk-fold-title'), data.title, '제목');
    }
  }

  function collect(box, block) {
    const data = block.data;
    if (block.kind === 'table') {
      return WikiTable.collect(box.querySelector('table'), data);
    }
    if (block.kind === 'infobox') {
      const rows = [...box.querySelectorAll('.wk-info-row')]
        .map((row) => [read(row.children[0], true), read(row.children[1])]).filter(([k, v]) => k || v);
      return { title: read(box.querySelector('.wk-info-title'), true), image: data.image, rows };
    }
    if (block.kind === 'img') return { image: data.image, caption: read(box.querySelector('.wk-cap'), true) };
    if (block.kind === 'lyric') return WikiLyric.collect(box.querySelector('.wk-lyr'));
    return { title: read(box.querySelector('.wk-fold-title'), true), runs: data.runs };
  }

  /* 쓸 것이 없는 블록인가. 넣기만 하고 아무것도 안 쓴 표·정보 상자·접기는 남기지 않는다. */
  function blank(block) {
    const d = block.data;
    if (block.kind === 'table') return WikiTable.blank(d.rows);
    if (block.kind === 'infobox') return !d.title && !d.image && !d.rows.length;
    if (block.kind === 'fold') return !d.title && !d.runs.length;
    if (block.kind === 'lyric') return !d.verses.length;
    return false;
  }

  async function activate(box, at, pick) {
    if (Wiki.readonly || Wiki.locked(box)) return;
    if (act && act.box === box) return;
    if (!Nick.get() && !(await Nick.ensure())) return;
    Wiki.settle();
    const block = Wiki.block(box.dataset.cid);
    if (!block || !box.isConnected) return;
    box.classList.add('is-editing');
    Wiki.activate(box);
    act = { box, cid: block.cid };
    paintEdit(box, block);
    const cells = [...box.querySelectorAll('[data-plain]')];
    let range = at && WikiEdit.rangeAt(at.x, at.y);
    let target = range && (range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement).closest('[data-plain]');
    if (!target || !box.contains(target)) { target = (pick && pick(cells)) || cells[0]; range = null; }
    if (!target) return;
    target.focus({ preventScroll: true });
    if (!range) { range = document.createRange(); range.selectNodeContents(target); range.collapse(false); }
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  }

  function deactivate() {
    if (!act) return;
    const a = act;
    act = null;
    a.box.classList.remove('is-editing');
    const block = Wiki.block(a.cid);
    if (block) {
      const data = collect(a.box, block);
      const changed = JSON.stringify(data) !== JSON.stringify(block.data);
      block.data = data;
      if (blank(block)) Wiki.dropBlock(a.cid);
      else if (changed || block.rev === 0) Wiki.save(a.cid);
    }
    WikiRender.paintAll();
  }

  /* ---------- 표 ----------
     줄·칸을 넣고 빼고 합치는 셈은 table.js 가 한다. 여기서는 그 결과로 표를 다시 세우고 커서를 둔다.
     칸의 자리는 DOM 순서가 아니라 칸에 적힌 번호(data-r·data-c)로 안다 — 합쳐진 표에서는 둘이 다르다. */
  function cellAt(box, r, c) {
    return box.querySelector(`td[data-r="${r}"][data-c="${c}"], th[data-r="${r}"][data-c="${c}"]`);
  }
  function focusCell(cell) {
    if (!cell) return;
    cell.focus({ preventScroll: true });
    const range = document.createRange();
    range.selectNodeContents(cell);
    range.collapse(false);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    cell.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  function where(cell) {
    return { r: Number(cell.dataset.r), c: Number(cell.dataset.c) };
  }

  /* 표를 고친 뒤 다시 편집 상태로 세우고 그 칸(없으면 그 칸을 덮은 칸)에 커서를 둔다. change 가 false 를 주면 그만둔다. */
  function reshape(box, change, r, c) {
    Wiki.settle();
    const block = Wiki.block(box.dataset.cid);
    if (!block || block.kind !== 'table') return;
    const rows = WikiTable.copy(block.data.rows);
    if (change(rows) === false) return;
    block.data = { ...block.data, rows };
    Wiki.save(block.cid);
    WikiRender.paintAll();
    const rr = Math.min(r, rows.length - 1);
    const cc = Math.min(c, rows[0].length - 1);
    const o = WikiTable.owner(rows, rr, cc) || { r: 0, c: 0 };
    activate(box, null, () => cellAt(box, o.r, o.c));
  }
  const addRow = (box, after) => reshape(box, (rows) => (rows.length < 300 ? WikiTable.insertRow(rows, after + 1) : false), after + 1, 0);
  const addCol = (box, after) => reshape(box, (rows) => (rows[0].length < 20 ? WikiTable.insertCol(rows, after + 1) : false), 0, after + 1);

  /* Tab: 다음 칸(끝이면 줄을 하나 만든다). Enter: 아래 칸(끝이면 줄을 하나 만든다). */
  function moveCell(cell, dr, dc) {
    const box = cell.closest('.wk-block');
    const last = Wiki.block(box.dataset.cid).data.rows.length - 1;
    if (dr) {
      const { r, c } = where(cell);
      const below = cellAt(box, r + (cell.rowSpan || 1), c);
      if (below) focusCell(below); else if (r + (cell.rowSpan || 1) > last) addRow(box, last);
      return;
    }
    const cells = [...box.querySelectorAll('td, th')];
    const next = cells[cells.indexOf(cell) + dc];
    if (next) focusCell(next); else if (dc > 0) addRow(box, last);
  }

  /* ---------- 가사 ----------
     소절의 세 줄(원문·발음·번역)은 꾸밈을 받는 한 줄짜리 칸이다. Enter 로 다음 줄, 번역 줄에서 Enter 로 다음 소절.
     소절을 넣고 빼는 것은 편집 중인 DOM 에 바로 한다 — 블록을 벗어날 때 통째로 읽어 문서에 옮긴다(lyric.js collect). */
  function rich(node, runs) {
    node.append(WikiRender.inline(runs, null));
    /* 줄이 윗글자·각주 같은 요소로 끝나면 그 뒤에 커서가 설 자리를 둔다(editor.js enter 와 같은 이유) */
    if (node.lastChild && node.lastChild.nodeType === 1) node.append(document.createTextNode('​'));
    node.contentEditable = 'true';
    node.spellcheck = false;
    node.dataset.plain = '1';
    node.dataset.rich = '1';
  }
  function caretIn(line) {
    line.focus({ preventScroll: true });
    const range = document.createRange();
    range.selectNodeContents(line);
    range.collapse(false);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    line.scrollIntoView({ block: 'nearest' });
  }
  function lyricEnter(line) {
    const next = line.nextElementSibling;
    if (next) { caretIn(next); return; }
    const row = WikiLyric.verse(WikiLyric.blank(), rich, true);
    line.parentElement.after(row);
    Wiki.touch();
    caretIn(row.firstElementChild);
  }
  /* 세 줄이 다 빈 소절의 맨 앞에서 Backspace: 그 소절을 빼고 앞 소절의 끝으로 간다 */
  function lyricBack(line) {
    const row = line.parentElement;
    const prev = row.previousElementSibling;
    if (line !== row.firstElementChild) {
      if ((line.textContent || '').replace(/​/g, '')) return false;
      caretIn(line.previousElementSibling);
      return true;
    }
    if (!prev || (row.textContent || '').replace(/​/g, '').trim()) return false;
    row.remove();
    Wiki.touch();
    caretIn(prev.lastElementChild);
    return true;
  }

  /* ---------- 그림 ---------- */
  function pickFiles(multiple) {
    return new Promise((resolve) => {
      if (!picker) {
        picker = document.createElement('input');
        picker.type = 'file';
        picker.accept = 'image/*';
        picker.hidden = true;
        document.body.append(picker);
      }
      picker.multiple = !!multiple;
      picker.value = '';
      picker.onchange = () => resolve([...picker.files]);
      picker.click();
    });
  }

  async function insertImages(afterBox, files) {
    Wiki.settle();
    let box = afterBox;
    for (const file of files) {
      try {
        const id = await Wiki.upload(file);
        const block = { cid: Wiki.newCid(), kind: 'img', data: { image: id, caption: '' }, rev: 0 };
        box = Wiki.addBlock(block, box && box.isConnected ? box : null);
        Wiki.save(block.cid);
        WikiRender.paintAll();
      } catch (err) {
        alert(err.message);
        return;
      }
    }
  }

  async function setInfoImage(box) {
    const cid = box.dataset.cid;
    const [file] = await pickFiles(false);
    if (!file) return;
    try {
      const id = await Wiki.upload(file);
      Wiki.settle();
      const block = Wiki.block(cid);
      if (!block) return;
      block.data = { ...block.data, image: id };
      Wiki.save(cid);
      WikiRender.paintAll();
    } catch (err) {
      alert(err.message);
    }
  }

  /* ---------- 넣기 · 옮기기 ---------- */
  async function insert(afterBox, kind, anchor) {
    Wiki.settle();
    if (!Nick.get() && !(await Nick.ensure())) return;
    const fresh = (data) => ({ cid: Wiki.newCid(), kind, data, rev: 0 });
    if (kind === 'p') return WikiEdit.enter(Wiki.addBlock(fresh({ runs: [] }), afterBox), 'start');
    if (kind === 'img') {
      const files = await pickFiles(true);
      return files.length && insertImages(afterBox, files);
    }
    if (kind === 'yt') {
      const url = await Wiki.ask(anchor, { placeholder: '유튜브 주소' });
      const v = url && youtubeId(url);
      if (!v) return url && alert('유튜브 주소가 아닙니다.');
      const block = fresh({ v });
      Wiki.addBlock(block, afterBox);
      Wiki.save(block.cid);
      return WikiRender.paintAll();
    }
    if (kind === 'embed') {
      const title = await Wiki.ask(anchor, { placeholder: '끼울 문서 제목', titles: true });
      if (!title || !title.trim()) return;
      const block = fresh({ title: title.trim().slice(0, 60) });
      Wiki.addBlock(block, afterBox);
      Wiki.save(block.cid);
      return WikiRender.paintAll();
    }
    const data = kind === 'lyric' ? { verses: [] }
      : kind === 'table' ? { rows: [['', ''], ['', '']], head: true }
      : kind === 'infobox' ? { title: Wiki.doc.title, image: null, rows: [] }
        : { title: '', runs: [] };
    const box = Wiki.addBlock(fresh(data), afterBox);
    WikiRender.paintAll();
    if (kind === 'fold') box.querySelector('.wk-fold').classList.add('is-open');
    return activate(box, null);
  }

  /* ---------- 분류(상자) ----------
     분류는 제목 블록부터, 같거나 더 큰 분류의 제목이 나오기 전까지다(render.js layout 이 data-head 에 단계를 적어 둔다). */
  function own() {
    return [...Wiki.$('wk-body').querySelectorAll(':scope > .wk-block')];
  }
  function sectionOf(box) {
    const boxes = own();
    const start = boxes.indexOf(box);
    const depth = Number(box.dataset.head);
    let end = start + 1;
    while (end < boxes.length && !(boxes[end].dataset.head && Number(boxes[end].dataset.head) <= depth)) end += 1;
    return boxes.slice(start, end);
  }

  /* 분류를 통째로 위·아래 분류와 자리를 바꾼다. 같은 분류 안에서만 움직인다(2.1 은 2 밖으로 나가지 않는다). */
  function moveSection(box, dir) {
    const boxes = own();
    const mine = sectionOf(box);
    const depth = Number(box.dataset.head);
    if (dir < 0) {
      let i = boxes.indexOf(box) - 1;
      while (i >= 0 && !(boxes[i].dataset.head && Number(boxes[i].dataset.head) <= depth)) i -= 1;
      if (i < 0 || Number(boxes[i].dataset.head) < depth) return;
      boxes[i].before(...mine);
    } else {
      const next = boxes[boxes.indexOf(box) + mine.length];
      if (!next || Number(next.dataset.head) !== depth) return;
      const theirs = sectionOf(next);
      theirs[theirs.length - 1].after(...mine);
    }
    Wiki.syncOrder();
    mine.forEach((b) => Wiki.save(b.dataset.cid, { moved: true }));
    WikiRender.paintAll();
    box.scrollIntoView({ block: 'nearest' });
  }

  /* '＋ 2.2. 중분류': 그 자리에 제목을 만들고 커서를 둔다. 제목을 쓰지 않고 나가면 사라진다. */
  function addSection(button) {
    Wiki.settle();
    const row = button.closest('.wk-deco');
    const kind = ['h2', 'h3', 'h4'][Number(button.dataset.level) - 1];
    const block = { cid: Wiki.newCid(), kind, data: { runs: [] }, rev: 0 };
    const box = Wiki.addBlock(block, null, row && row.isConnected ? row : null);
    WikiRender.paintAll();
    WikiEdit.enter(box, 'start');
  }

  /* 빈 분류의 '내용을 입력하세요': 그 분류의 첫 문단을 만든다. */
  function writeIn(hint) {
    Wiki.settle();
    const parent = hint.dataset.parent && Wiki.boxOf(hint.dataset.parent);
    const block = { cid: Wiki.newCid(), kind: 'p', data: { runs: [] }, rev: 0 };
    const box = parent ? Wiki.addBlock(block, parent) : Wiki.addBlock(block, null, own()[0] || null);
    WikiRender.paintAll();
    WikiEdit.enter(box, 'start');
  }

  function move(box, dir) {
    Wiki.settle();
    if (box.dataset.head) { moveSection(box, dir); return; }       /* 분류 제목: 그 분류를 통째로 옮긴다 */
    let other = box;
    do { other = dir < 0 ? other.previousElementSibling : other.nextElementSibling; } while (other && !other.classList.contains('wk-block'));
    if (!other) return;
    if (dir < 0) other.before(box); else other.after(box);
    Wiki.syncOrder();
    const block = Wiki.block(box.dataset.cid);
    if (block && block.rev > 0) Wiki.save(block.cid, { moved: true });
    WikiRender.paintAll();
    box.scrollIntoView({ block: 'nearest' });
  }

  function setKind(box, kind) {
    Wiki.settle();
    const block = Wiki.block(box.dataset.cid);
    if (!block || block.kind === kind || !TEXT_KINDS.includes(block.kind)) return;
    block.kind = kind;
    WikiRender.retype(box, kind);
    if (WikiRender.HEAD[kind] && block.data.level) block.data = { runs: block.data.runs };   /* 제목에는 글의 들여쓰기 단계를 두지 않는다 */
    if (block.data.runs.length) Wiki.save(block.cid);
    WikiRender.paintAll();
  }

  /* ---------- 블록 메뉴 ---------- */
  function closeMenu() {
    if (!menu) return;
    menu.remove();
    menu = null;
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('keydown', onMenuKey, true);
  }
  function onOutside(e) { if (menu && !menu.contains(e.target)) closeMenu(); }
  function onMenuKey(e) { if (e.key === 'Escape') { e.preventDefault(); closeMenu(); } }

  function openMenu(box, grip) {
    closeMenu();
    const block = Wiki.block(box.dataset.cid);
    if (!block) return;
    const cell = box._cell || { r: 0, c: 0 };
    menu = el('div', 'wk-menu');
    menu.setAttribute('role', 'menu');
    const group = (label, items) => {
      const sec = el('div', 'wk-menu-group');
      if (label) sec.append(el('span', 'wk-menu-label', label));
      for (const [text, run, on] of items) {
        const b = el('button', on ? 'is-on' : '', text);
        b.type = 'button';
        b.setAttribute('role', 'menuitem');
        b.addEventListener('click', () => { const anchor = grip.getBoundingClientRect(); closeMenu(); run(anchor); });
        sec.append(b);
      }
      menu.append(sec);
    };
    if (TEXT_KINDS.includes(block.kind)) {
      group('바꾸기', Object.entries(KIND_LABEL).map(([k, label]) => [label, () => setKind(box, k), k === block.kind]));
    }
    if (block.kind === 'table') {
      const at = (change) => () => reshape(box, change, cell.r, cell.c);
      group('표', [
        ['줄 지우기', at((rows) => WikiTable.deleteRow(rows, cell.r))],
        ['칸 지우기', at((rows) => WikiTable.deleteCol(rows, cell.c))],
        ['오른쪽 칸과 합치기', at((rows) => WikiTable.merge(rows, cell.r, cell.c, 'right'))],
        ['아래 칸과 합치기', at((rows) => WikiTable.merge(rows, cell.r, cell.c, 'down'))],
        ['합치기 풀기', at((rows) => WikiTable.unmerge(rows, cell.r, cell.c))],
        ['칸 색', async (anchor) => {
          const picked = await Wiki.pickColor(anchor, true);
          if (picked !== null) reshape(box, (rows) => WikiTable.setAttr(rows, cell.r, cell.c, 'bg', picked), cell.r, cell.c);
        }],
        ['칸 왼쪽', at((rows) => WikiTable.setAttr(rows, cell.r, cell.c, 'al', 'l'))],
        ['칸 가운데', at((rows) => WikiTable.setAttr(rows, cell.r, cell.c, 'al', 'c'))],
        ['칸 오른쪽', at((rows) => WikiTable.setAttr(rows, cell.r, cell.c, 'al', 'r'))],
        ...[['표를 왼쪽에', ''], ['표를 가운데에', 'c'], ['표를 오른쪽에', 'r']].map(([label, where_]) => [label, () => {
          Wiki.settle();
          const b = Wiki.block(block.cid);
          const next = { ...b.data };
          if (where_) next.align = where_; else delete next.align;
          b.data = next;
          Wiki.save(b.cid);
          WikiRender.paintAll();
        }, (block.data.align || '') === where_]),
        ['제목 줄', () => { Wiki.settle(); const b = Wiki.block(block.cid); b.data = { ...b.data, head: !b.data.head }; Wiki.save(b.cid); WikiRender.paintAll(); }, block.data.head],
      ]);
    }
    if (block.kind === 'lyric' && act && act.box === box && box._verse && box._verse.isConnected) {
      const row = box._verse;
      group('가사', [
        ['여기서 절 나누기', () => { row.classList.toggle('is-gap'); Wiki.touch(); }, row.classList.contains('is-gap')],
        ['소절 지우기', () => { if (row.parentElement.children.length > 1) { row.remove(); Wiki.touch(); } }],
      ]);
    }
    if (block.kind === 'infobox') {
      group('정보 상자', block.data.image
        ? [['그림 바꾸기', () => setInfoImage(box)],
          ['그림 빼기', () => { Wiki.settle(); const b = Wiki.block(block.cid); b.data = { ...b.data, image: null }; if (blank(b)) Wiki.dropBlock(b.cid); else Wiki.save(b.cid); WikiRender.paintAll(); }]]
        : [['그림 넣기', () => setInfoImage(box)]]);
    }
    group('아래에 넣기', INSERTS.map(([k, label]) => [label, (anchor) => insert(box, k, anchor)]));
    group('', [
      ['위로', () => move(box, -1)],
      ['아래로', () => move(box, 1)],
      [box.dataset.head ? '분류 지우기' : '지우기', () => {
        Wiki.settle();
        const all = box.dataset.head ? sectionOf(box) : [box];            /* 분류 제목: 그 안의 글까지 */
        all.forEach((b) => Wiki.dropBlock(b.dataset.cid));
        WikiRender.paintAll();
      }],
    ]);
    document.body.append(menu);
    const rect = grip.getBoundingClientRect();
    const top = Math.min(rect.bottom + 4, innerHeight - menu.offsetHeight - 8);
    menu.style.top = `${Math.max(8, Math.round(top))}px`;
    menu.style.left = `${Math.max(8, Math.min(Math.round(rect.left), innerWidth - menu.offsetWidth - 8))}px`;
    menu.addEventListener('pointerdown', (e) => e.preventDefault());    /* 편집 중인 칸의 초점을 뺏지 않는다 */
    document.addEventListener('pointerdown', onOutside, true);
    document.addEventListener('keydown', onMenuKey, true);
  }

  /* ---------- 본문에 거는 것 ---------- */
  function init(body) {
    act = null;
    closeMenu();
    const top = (e) => {
      const box = e.target.closest('.wk-block');
      return box && box.parentElement === body ? box : null;    /* 틀로 끼운 문서 속 블록은 건드리지 않는다 */
    };

    body.addEventListener('pointerdown', (e) => { if (e.target.closest('.wk-grip')) e.preventDefault(); });
    body.addEventListener('click', (e) => {
      const tog = e.target.closest('.wk-fold-tog');
      if (tog) {
        const open = tog.parentElement.classList.toggle('is-open');
        tog.setAttribute('aria-label', open ? '접기' : '펼치기');
        return;
      }
      /* 분류 더하기 · 빈 분류의 '내용을 입력하세요' (render.js layout 이 편집 상태에서 끼워 넣는 줄) */
      const add = e.target.closest('.wk-add-sec');
      if (add) { addSection(add); return; }
      const hint = e.target.closest('.wk-ph');
      if (hint) { writeIn(hint); return; }
      const box = top(e);
      if (!box) return;
      /* 문단 제목의 [편집]: 읽는 화면에서 그 구역만 편집 상태로 */
      if (e.target.closest('.wk-sec')) { Wiki.edit(box.dataset.cid); return; }
      if (Wiki.readonly || Wiki.locked(box)) return;
      const grip = e.target.closest('.wk-grip');
      if (grip) { openMenu(box, grip); return; }
      if (e.target.closest('.wk-add-row')) { addRow(box, Wiki.block(box.dataset.cid).data.rows.length - 1); return; }
      if (e.target.closest('.wk-add-col')) { addCol(box, Wiki.block(box.dataset.cid).data.rows[0].length - 1); return; }
      if (e.target.closest('.wk-info-pick') || (act && act.box === box && e.target.closest('.wk-info-pic'))) { setInfoImage(box); return; }
      if (e.target.closest('a') || !getSelection().isCollapsed) return;
      if (act && act.box === box) return;
      if (e.target.closest(CLICKABLE)) activate(box, { x: e.clientX, y: e.clientY });
    });

    body.addEventListener('focusin', (e) => {
      const cell = e.target.closest && e.target.closest('td, th');
      const box = cell && top(e);
      if (box) box._cell = where(cell);
      const verse = e.target.closest && e.target.closest('.wk-v');
      if (verse && top(e)) top(e)._verse = verse;
    });
    body.addEventListener('focusout', (e) => {
      if (!act || !act.box.contains(e.target)) return;
      if (e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest(SOFT)) return;
      const a = act;
      setTimeout(() => {
        if (act !== a || a.box.contains(document.activeElement)) return;
        if (document.activeElement && document.activeElement.closest(SOFT)) return;
        if (menu) return;                                        /* 메뉴가 열려 있는 동안은 닫지 않는다 */
        deactivate();
      }, 0);
    });

    body.addEventListener('keydown', (e) => {
      if (!act || !e.target.dataset || !e.target.dataset.plain || e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Escape') { e.preventDefault(); deactivate(); return; }
      if (e.key === 'Backspace' && e.target.closest('.wk-lyr') && getSelection().isCollapsed && lyricBack(e.target)) { e.preventDefault(); return; }
      if (e.key === 'Tab' && e.target.closest('td, th')) { e.preventDefault(); moveCell(e.target, 0, e.shiftKey ? -1 : 1); }
    });
    body.addEventListener('beforeinput', (e) => {
      if (!act || !e.target.dataset || !e.target.dataset.plain) return;
      if (e.inputType === 'insertParagraph') {
        e.preventDefault();
        if (e.target.closest('td, th')) moveCell(e.target, 1, 0);        /* 표에서 Enter: 아래 칸으로 */
        else if (e.target.closest('.wk-lyr')) lyricEnter(e.target);      /* 가사에서 Enter: 다음 줄, 번역 줄에서는 다음 소절 */
        else deactivate();
      } else if (e.inputType === 'insertLineBreak' && e.target.matches(ONE_LINE)) e.preventDefault();
    });
    body.addEventListener('input', (e) => {
      /* 정보 상자: 마지막 줄에 쓰기 시작하면 빈 줄이 하나 더 생긴다. '줄 더하기' 단추가 필요 없다. */
      const row = act && e.target.closest && e.target.closest('.wk-info-row');
      if (row && !row.nextElementSibling && (row.textContent || '').trim()) row.after(infoRow('', ''));
    });
    body.addEventListener('paste', (e) => {
      if (!e.target.closest || !e.target.closest('[data-plain]')) return;
      e.preventDefault();
      const one = e.target.closest(ONE_LINE);
      const text = (e.clipboardData.getData('text/plain') || '').replace(/\r/g, '');
      document.execCommand('insertText', false, one ? text.replace(/\s+/g, ' ') : text);
    });

    /* 그림 파일을 본문에 떨어뜨리면 그 자리 아래에 들어간다 */
    body.addEventListener('dragover', (e) => {
      if (!Wiki.readonly && [...(e.dataTransfer.types || [])].includes('Files')) e.preventDefault();
    });
    body.addEventListener('drop', (e) => {
      const files = [...(e.dataTransfer.files || [])].filter((f) => f.type.startsWith('image/'));
      if (!files.length || Wiki.readonly) return;
      e.preventDefault();
      const at = top(e);
      insertImages(at && !Wiki.locked(at) ? at : body.lastElementChild, files);
    });
  }

  return { init, deactivate, insert, insertImages, setKind, closeMenu, active: () => act };
})();
