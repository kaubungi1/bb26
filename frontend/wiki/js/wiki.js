/* 불법위키 — 화면의 뼈대. 주소 읽기, 문서 열기, 읽기/편집 전환, 저장, 첫 화면(최근 변경)·찾기·분류.

   주소
     /wiki/              최근 변경.  ?q= 가 붙으면 찾은 결과
     /wiki/<제목>        문서. 없는 제목이면 '아직 없는 문서' — 새 문서 만들기를 누르면 편집 상태로 들어간다
     /wiki/분류:<이름>   그 분류의 문서 목록.  /wiki/분류: 는 분류 전체
   위키 안의 이동은 주소만 바꾸고 화면을 갈아 끼운다(제목 목록을 다시 받지 않는다).

   읽기와 편집 (2026-11-13 사용자 결정: 위키는 읽는 문서가 먼저다. 처음 만든 '어디든 누르면 써지는' 화면은 메모장이었다)
     읽기   기본 상태. 글을 눌러도 아무 일이 없다. 나무위키의 문서 틀을 따른다(wiki.css 머리말).
     편집   문서 머리의 '편집' 또는 문단 제목의 [편집](그 구역만). 위에 도구 줄이 붙는다(tools.js).
            고친 것은 화면에만 쌓인다. '저장'을 눌러야 서버로 가고 '취소'하면 버린다.

   저장(commitAll)
     뺀 블록과 고친 블록(문서 순서대로)을 한 번의 요청으로 보내고(pushAll), 이어서 제목·분류·다른 이름을 보낸다.
     둘 다 한 줄('wiki')에 선다(common.js Writes). 서버는 블록 묶음을 한 트랜잭션으로 받는다 — 하나라도 겹쳐 썼으면
     아무것도 저장하지 않고 겹친 블록을 알려 준다. 그 블록에 표시가 붙고 편집 상태가 유지된다.
     블록마다 "이 상태로"(멱등)라 같은 저장을 다시 보내도 같다. 한 번의 저장은 이력 한 줄이다.

   전송량
     문서는 폴링하지 않는다. 열 때 한 번, 탭으로 돌아왔을 때 한 번(판이 같으면 304).
     30초마다 묻는 것은 제목 목록과 최근 변경이고, 바뀐 게 없으면 304 다(backend/listcache.py). */
const Wiki = {
  doc: null,            /* 지금 보는 문서. 없는 문서면 exists:false 인 빈 틀 */
  live: null,           /* 옛 판을 미리 보는 동안 지금 문서를 여기 둔다 */
  editing: false,       /* 편집 상태인가 */
  scoped: false,        /* 문단 제목의 [편집]으로 들어왔는가. 그러면 .in-scope 블록만 고친다 */
  touched: false,       /* 편집 상태에서 무엇이든 고쳤는가 */
  draft: null,          /* 편집 중인 제목·분류·다른 이름. 저장할 때 보낸다 */
  readonly: true,       /* 블록을 고칠 수 없는 상태(읽기·옛 판·지워진 문서). editor.js·blocks.js 가 본다 */
  view: '',
  seq: 0,               /* 화면을 바꿀 때마다 오른다. 늦게 온 응답을 버리는 데 쓴다 */
  embeds: new Map(),
  recent: [],

  /* ---------- 작은 도구 ---------- */
  $(id) { return document.getElementById(id); },
  newCid() {
    const abc = 'abcdefghijklmnopqrstuvwxyz0123456789';
    return Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => abc[b % 36]).join('');
  },
  href(title) { return WikiRender.href(title); },
  block(cid) { return (this.doc && this.doc.blocks.find((b) => b.cid === cid)) || null; },
  boxOf(cid) { return document.querySelector(`#wk-body > .wk-block[data-cid="${cid}"]`); },
  activate(box) {
    document.querySelectorAll('#wk-body > .wk-block.is-active').forEach((b) => { if (b !== box) b.classList.remove('is-active'); });
    if (box) box.classList.add('is-active');
    WikiTools.sync();
  },
  /* 구역 편집 중에 그 구역 밖의 블록인가 */
  locked(box) { return this.scoped && !box.classList.contains('in-scope'); },
  /* 편집 중인 칸을 닫고 그 내용을 문서(화면의 저장소)로 옮긴다. 무엇을 하든 그 전에 부른다. */
  settle() {
    WikiEdit.leave();
    WikiBlocks.deactivate();
  },
  status(text) {
    const node = this.$('wk-status');
    node.textContent = text || '';
    node.hidden = !text;
  },
  when(iso) {
    const diff = Date.now() - new Date(iso).getTime();      /* 날짜가 아니라 흐른 시간으로만 센다(자정·시간대 무관) */
    const min = Math.floor(diff / 60000);
    if (min < 1) return '방금';
    if (min < 60) return `${min}분 전`;
    if (min < 1440) return `${Math.floor(min / 60)}시간 전`;
    if (min < 10080) return `${Math.floor(min / 1440)}일 전`;
    return new Date(iso).toLocaleDateString('ko-KR');
  },
  /* 문서 머리의 '최근 수정 시각'. 보는 사람의 시각으로 적는다. */
  stamp(iso) {
    const d = new Date(iso);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  },

  /* 작은 입력창 하나. 링크 대상·각주·유튜브 주소·끼울 문서 제목에 쓴다. Enter·바깥 누름이면 값을, Esc 면 null 을 준다. */
  ask(rect, opt = {}) {
    return new Promise((resolve) => {
      const { el } = WikiRender;
      const pop = el('form', 'wk-pop');
      const input = el('input');
      input.value = opt.value || '';
      input.placeholder = opt.placeholder || '';
      input.maxLength = 500;
      input.autocomplete = 'off';
      input.setAttribute('aria-label', opt.placeholder || '입력');
      if (opt.titles) {
        const list = el('datalist');
        list.id = 'wk-ask-titles';
        WikiLinks.all().forEach((p) => { const o = el('option'); o.value = p.title; list.append(o); });
        input.setAttribute('list', list.id);
        pop.append(list);
      }
      pop.append(input);
      document.body.append(pop);
      const top = Math.min((rect ? rect.bottom : 80) + 6, innerHeight - pop.offsetHeight - 8);
      pop.style.top = `${Math.max(8, Math.round(top))}px`;
      pop.style.left = `${Math.max(8, Math.min(Math.round(rect ? rect.left : 16), innerWidth - pop.offsetWidth - 8))}px`;
      let done = false;
      const finish = (value) => { if (done) return; done = true; pop.remove(); resolve(value); };
      pop.addEventListener('submit', (e) => { e.preventDefault(); finish(input.value); });
      input.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(null); } });
      input.addEventListener('blur', () => setTimeout(() => finish(input.value), 0));
      input.focus();
      input.select();
    });
  },

  /* ---------- 화면의 저장소: 고친 것은 여기 쌓이고 '저장' 때 서버로 간다 ---------- */
  touch() {
    this.touched = true;
    WikiTools.sync();
  },
  /* 새 블록을 세운다. afterBox 뒤에, before 를 주면 그 줄 앞에, 둘 다 없으면 맨 끝에. */
  addBlock(block, afterBox, before) {
    const body = this.$('wk-body');
    const box = WikiRender.make(block);
    if (before && before.parentElement === body) before.before(box);
    else if (afterBox && afterBox.parentElement === body) afterBox.after(box); else body.append(box);
    if (this.scoped) box.classList.add('in-scope');
    this.doc.blocks.push(block);
    this.syncOrder();
    return box;
  },
  syncOrder() {
    const order = [...this.$('wk-body').querySelectorAll(':scope > .wk-block')].map((b) => b.dataset.cid);
    this.doc.blocks.sort((a, b) => order.indexOf(a.cid) - order.indexOf(b.cid));
  },
  /* 블록을 고쳤다고 적는다. 옮겼으면(moved) 저장할 때 자리도 같이 보낸다. */
  save(cid, opt = {}) {
    const block = this.block(cid);
    if (!block) return;
    block.dirty = true;
    if (opt.moved) block.moved = true;
    this.touch();
  },
  /* 블록을 뺀다. 문서의 마지막 한 블록은 빼는 대신 빈 문단으로 남긴다 — 다시 쓸 자리다. */
  dropBlock(cid) {
    const doc = this.doc;
    const block = this.block(cid);
    if (!block) return;
    const box = this.boxOf(cid);
    this.unflag(cid);
    if (block.rev > 0) { doc.removed.push(cid); this.touch(); }
    if (doc.blocks.length === 1) {
      Object.assign(block, { cid: this.newCid(), kind: 'p', data: { runs: [] }, rev: 0, dirty: false, moved: false });
      if (box) { WikiRender.retype(box, 'p'); box.dataset.cid = block.cid; delete box.dataset.lv; }
    } else {
      doc.blocks.splice(doc.blocks.indexOf(block), 1);
      if (box) box.remove();
    }
  },

  /* ---------- 서버로 보내기 ---------- */
  /* 저장된 블록 가운데 이 블록 바로 앞의 것. 새 블록·옮긴 블록이 놓일 자리다. */
  savedBefore(doc, block) {
    for (let i = doc.blocks.indexOf(block) - 1; i >= 0; i -= 1) if (doc.blocks[i].rev > 0) return doc.blocks[i].cid;
    return null;
  },
  /* 없는 문서에 처음 쓸 때 문서를 만든다. 저장 줄 안에서 불리므로 블록보다 먼저 끝난다. */
  async ensurePage(doc) {
    if (doc.exists) return;
    const res = await api.post('/wiki/pages', { title: doc.title, nickname: Nick.get() });
    Object.assign(doc, { exists: true, id: res.id, title: res.title, key: res.key, version: res.version, deleted: res.deleted });
  },
  /* 뺀 블록과 고친 블록을 한 번의 요청으로 보낸다(POST /pages/{id}/save). 서버는 한 트랜잭션으로 받고,
     하나라도 겹쳐 썼으면 아무것도 저장하지 않는다. 블록마다 따로 보내던 때에는 나무위키 문서 하나(블록 150개)를
     붙여넣고 저장하면 요청이 150번 갔다. 본문이 64KB 를 넘을 수 있어 keepalive 는 걸지 않는다. */
  pushAll(doc, blocks) {
    return Writes.run('wiki', async () => {
      if (!blocks.length && !doc.removed.length) return;
      await this.ensurePage(doc);
      const batch = new Set(blocks);
      const sent = new Map(blocks.map((b) => [b.cid, JSON.stringify(b.data)]));
      const body = {
        nickname: Nick.get(),
        removed: doc.removed,
        blocks: blocks.map((b) => {
          const item = { cid: b.cid, kind: b.kind, data: b.data, base: b.rev };
          if (b.rev === 0 || b.moved) item.after = this.placedAfter(doc, b, batch);
          return item;
        }),
      };
      const res = await fetch(`/api/wiki/pages/${doc.id}/save`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!res.ok) throw await apiFailure(res);
      const got = await res.json();
      const saved = new Map(got.blocks.map((b) => [b.cid, b]));
      for (const b of blocks) {
        const now = saved.get(b.cid);
        if (!now) continue;
        b.rev = now.rev;
        b.dirty = false;
        b.moved = false;
        if (JSON.stringify(b.data) === sent.get(b.cid)) b.data = now.data;      /* 서버가 다듬은 모양 */
        if (doc === this.doc) this.unflag(b.cid);
      }
      doc.removed = [];
      Object.assign(doc.images, got.images || {});
      doc.version = got.version;
    }).catch((err) => { this.saveFailed(doc, blocks, err); throw err; });
  },
  /* 새 블록·옮긴 블록이 놓일 자리: 바로 앞의 '저장돼 있거나 이번에 같이 보내는' 블록. 서버는 보낸 순서대로 넣는다. */
  placedAfter(doc, block, batch) {
    for (let i = doc.blocks.indexOf(block) - 1; i >= 0; i -= 1) {
      if (doc.blocks[i].rev > 0 || batch.has(doc.blocks[i])) return doc.blocks[i].cid;
    }
    return null;
  },
  saveFailed(doc, blocks, err) {
    if (doc !== this.doc) return;
    const d = err.detail;
    if (err.status === 409 && d && d.code === 'conflicts') {
      /* 내가 고치는 사이 다른 사람이 같은 문단을 저장했다. 내 글은 화면에 그대로 둔다. */
      for (const theirs of d.blocks) {
        const block = blocks.find((b) => b.cid === theirs.cid);
        if (!block) continue;
        const cid = block.cid;
        this.flag(cid, '다른 사람이 먼저 고쳤습니다', [
          ['내 글로 덮기', () => { block.rev = theirs.rev; this.unflag(cid); this.commitAll(); }],
          ['그 글 받기', () => {
            this.settle();
            const box = this.boxOf(cid);
            if (box && block.kind !== theirs.kind) WikiRender.retype(box, theirs.kind);
            Object.assign(block, { kind: theirs.kind, data: theirs.data, rev: theirs.rev, dirty: false, moved: false });
            this.unflag(cid);
            WikiRender.paintAll();
          }],
        ]);
      }
    } else if (d && d.code === 'invalid' && d.cid) {
      this.flag(d.cid, `저장하지 못했습니다 — ${d.message}`, []);
    }
  },
  flag(cid, text, actions) {
    const box = this.boxOf(cid);
    if (!box) return;
    this.unflag(cid);
    const { el } = WikiRender;
    const bar = el('div', 'wk-flag');
    bar.setAttribute('role', 'alert');
    bar.append(el('span', '', text));
    for (const [label, run] of actions) {
      const b = el('button', '', label);
      b.type = 'button';
      b.addEventListener('click', run);
      bar.append(b);
    }
    box.append(bar);
  },
  unflag(cid) {
    const box = this.boxOf(cid);
    const bar = box && box.querySelector(':scope > .wk-flag');
    if (bar) bar.remove();
  },

  /* 그림은 올리기 전에 브라우저에서 줄인다. 폰 사진(수 MB)을 그대로 보내면 0.1 CPU 서버가 줄이느라 멈춘다.
     그림은 고르는 즉시 올라간다(문서 저장과 별개). 문서를 저장하지 않으면 쓰이지 않는 그림으로 남는다. */
  async shrink(file) {
    try {
      const bmp = await createImageBitmap(file);
      const scale = Math.min(1, 1024 / Math.max(bmp.width, bmp.height));
      if (scale === 1 && file.size < 400 * 1024) return file;
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(bmp.width * scale);
      canvas.height = Math.round(bmp.height * scale);
      canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', 0.9));
      return blob || file;
    } catch {
      return file;                                 /* 못 줄이면 원본을 보낸다. 서버가 다시 줄인다 */
    }
  },
  async upload(file) {
    if (!Nick.get() && !(await Nick.ensure())) throw new Error('닉네임이 필요합니다.');
    const doc = this.doc;
    this.status('그림 올리는 중');
    try {
      const form = new FormData();
      form.append('file', await this.shrink(file), 'image');
      const res = await Writes.run('wiki-image', () => api.post(`/wiki/images?nickname=${encodeURIComponent(Nick.get())}`, form));
      doc.images[res.id] = { url: res.url, w: res.w, h: res.h };
      return res.id;
    } finally {
      this.status('');
    }
  },

  /* 색 고르기. 글자색·배경색·표의 칸 색이 같은 판을 쓴다. 고른 색을, withNone 이면 '없음'은 '' 을, 바깥을 누르면 null 을 준다.
     판을 눌러도 문단의 초점과 고른 글자는 그대로 남는다(pointerdown 을 막는다). */
  pickColor(rect, withNone, pale) {
    const VIVID = ['#dc2f4b', '#ff8c00', '#ffd700', '#32cd32', '#1e90ff', '#0000ff', '#9400d3', '#ee82ee', '#808080', '#212529'];
    const PALE = ['#ffe0e6', '#ffe8cc', '#fff3a3', '#d8f5d0', '#d9e5ff', '#e6dcff', '#fbe0f5', '#f5f8fa', '#e3e9ee', '#ffffff'];
    return new Promise((resolve) => {
      const { el } = WikiRender;
      const pop = el('div', 'wk-pop wk-palette');
      const finish = (value) => {
        document.removeEventListener('pointerdown', outside, true);
        document.removeEventListener('keydown', onKey, true);
        pop.remove();
        resolve(value);
      };
      const outside = (e) => { if (!pop.contains(e.target)) finish(null); };
      const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); finish(null); } };
      for (const c of (pale ? [...PALE, ...VIVID] : [...VIVID, ...PALE])) {
        const b = el('button', 'wk-swatch');
        b.type = 'button';
        b.style.backgroundColor = c;
        b.setAttribute('aria-label', c);
        b.addEventListener('click', () => finish(c));
        pop.append(b);
      }
      if (withNone) {
        const none = el('button', 'wk-swatch-none', '없음');
        none.type = 'button';
        none.addEventListener('click', () => finish(''));
        pop.append(none);
      }
      pop.addEventListener('pointerdown', (e) => e.preventDefault());
      document.body.append(pop);
      const top = Math.min((rect ? rect.bottom : 80) + 6, innerHeight - pop.offsetHeight - 8);
      pop.style.top = `${Math.max(8, Math.round(top))}px`;
      pop.style.left = `${Math.max(8, Math.min(Math.round(rect ? rect.left : 16), innerWidth - pop.offsetWidth - 8))}px`;
      setTimeout(() => {
        document.addEventListener('pointerdown', outside, true);
        document.addEventListener('keydown', onKey, true);
      }, 0);
    });
  },

  /* 붙여넣은 글에 든 분류를 문서의 분류에 더한다(문서 전체를 편집할 때만). */
  addCategories(names) {
    if (!this.draft || this.scoped || !names || !names.length) return;
    const have = new Set(this.draft.categories.map((c) => WikiLinks.key(c)));
    const fresh = names.map((n) => n.slice(0, 30)).filter((n) => WikiLinks.key(n) && !have.has(WikiLinks.key(n)) && have.add(WikiLinks.key(n)));
    if (!fresh.length) return;
    this.draft.categories = [...this.draft.categories, ...fresh].slice(0, 30);
    this.touch();
    this.paintHead();
  },

  /* ---------- 편집 상태 ---------- */
  /* 편집으로 들어간다. section 을 주면 그 문단 제목부터 다음 같은 단계 제목 앞까지만 고친다. */
  async edit(section) {
    const doc = this.doc;
    if (!doc || doc.deleted || this.live || this.editing) return;
    if (!Nick.get() && !(await Nick.ensure())) return;
    if (doc !== this.doc) return;
    WikiPanel.close();
    this.editing = true;
    this.scoped = !!section;
    this.touched = false;
    this.draft = { title: doc.title, categories: [...doc.categories], aliases: [...doc.aliases] };
    doc.removed = [];
    this.mount();
    if (section) {
      /* 그 분류의 제목부터, 같거나 더 큰 분류의 제목이 나오기 전까지 */
      const boxes = [...this.$('wk-body').querySelectorAll(':scope > .wk-block')];
      const start = boxes.findIndex((b) => b.dataset.cid === section);
      const depth = start >= 0 ? Number(boxes[start].dataset.head) : 0;
      for (let i = Math.max(start, 0); i < boxes.length; i += 1) {
        const head = Number(boxes[i].dataset.head || 0);
        if (i > start && head && head <= depth) break;
        boxes[i].classList.add('in-scope');
      }
      WikiRender.paintAll();                 /* 더하기 줄을 이 구역 것만 남긴다 */
      if (start >= 0) boxes[start].scrollIntoView({ block: 'nearest' });
    }
    /* 빈 문서는 바로 첫 줄에 커서를 둔다 */
    const only = doc.blocks.length === 1 && doc.blocks[0];
    if (only && only.kind === 'p' && !only.data.runs.length) WikiEdit.enter(this.boxOf(only.cid), 'start');
    WikiTools.sync();
  },

  /* 고친 것을 서버로 보낸다. 다 되면 읽는 화면으로 돌아간다. */
  async commitAll() {
    const doc = this.doc;
    if (!this.editing || this.saving) return;
    this.settle();
    if (!Nick.get() && !(await Nick.ensure())) return;
    const text = (b) => WikiRender.TEXT_KINDS.includes(b.kind);
    const blocks = doc.blocks.filter((b) => (b.dirty || b.moved || b.rev === 0) && !(text(b) && !b.data.runs.length));
    const patch = {};
    const draft = this.draft;
    if (!this.scoped) {
      const title = draft.title.replace(/\s+/g, ' ').trim();
      if (doc.exists && title && title !== doc.title) patch.title = title;
      if (JSON.stringify(draft.categories) !== JSON.stringify(doc.categories)) patch.categories = draft.categories;
      if (JSON.stringify(draft.aliases) !== JSON.stringify(doc.aliases)) patch.aliases = draft.aliases;
    }
    const hasPatch = Object.keys(patch).length > 0;
    if (!blocks.length && !doc.removed.length && !hasPatch) { this.leaveEdit(doc.title); return; }

    this.saving = true;
    WikiTools.sync();
    this.status('저장하는 중');
    const jobs = blocks.length || doc.removed.length ? [this.pushAll(doc, blocks)] : [];
    let title = doc.title;
    if (hasPatch) {
      jobs.push(Writes.run('wiki', async () => {
        await this.ensurePage(doc);
        const res = await api.put(`/wiki/pages/${doc.id}`, { nickname: Nick.get(), ...patch });
        title = res.title;
      }));
    }
    const failed = (await Promise.allSettled(jobs)).filter((r) => r.status === 'rejected');
    this.saving = false;
    if (doc !== this.doc) return;
    if (failed.length) {
      /* 블록의 실패는 그 블록에 표시가 붙었다. 제목·분류의 실패(이미 쓰는 이름 등)는 여기서 알린다. */
      const plain = failed.map((r) => r.reason).find((e) => !(e.status === 409 && e.detail && e.detail.code === 'conflicts'));
      this.status(plain ? `저장하지 못했습니다 — ${plain.message}` : '겹쳐 쓴 문단이 있습니다');
      WikiTools.sync();
      return;
    }
    this.status('');
    this.pollTitles(true);
    this.pollRecent(true);
    this.leaveEdit(title);
  },

  async cancelEdit() {
    if (!this.editing || this.saving) return;
    this.settle();
    if (this.touched && !(await confirmModal({ title: '편집 취소', body: '고친 내용을 버립니다.', confirm: '버리기', cancel: '계속 편집', danger: true }))) return;
    this.leaveEdit(this.doc.title);
  },

  /* 편집을 끝내고 서버의 문서를 다시 받아 읽는 화면으로 세운다. */
  leaveEdit(title) {
    this.editing = false;
    this.scoped = false;
    this.touched = false;
    this.draft = null;
    if (decodeURIComponent(location.pathname) !== decodeURIComponent(this.href(title))) history.replaceState(null, '', this.href(title));
    this.shown = location.pathname + location.search;
    const y = scrollY;
    this.open(title).then(() => scrollTo(0, y));
  },

  /* ---------- 문서 받기 ---------- */
  async fetchDoc(title, etag) {
    const res = await fetch(`/api/wiki/page?title=${encodeURIComponent(title)}`,
      { cache: 'no-store', headers: etag ? { 'If-None-Match': etag } : {} });
    if (res.status === 304) return null;
    if (!res.ok) throw await apiFailure(res);
    return res.json();
  },
  fetchEmbed(title) {
    const key = WikiLinks.key(title);
    if (!this.embeds.has(key)) this.embeds.set(key, this.fetchDoc(title));
    return this.embeds.get(key);
  },
  shape(doc, title) {
    if (doc.exists) return { ...doc, removed: [] };
    return { exists: false, id: 0, title: doc.title || title, key: '', deleted: false, categories: [], aliases: [],
      blocks: [], images: {}, version: '0', via: null, updatedAt: null, updatedBy: null, removed: [] };
  },

  /* 탭으로 돌아왔을 때 문서를 다시 맞춘다(판이 같으면 304). 편집 중이면 건드리지 않는다. */
  async refresh() {
    const doc = this.doc;
    if (this.view !== 'doc' || !doc || !doc.exists || this.live || this.editing || Writes.pending) return;
    const seq = this.seq;
    try {
      const next = await this.fetchDoc(doc.title, `W/"wikipage-${doc.id}-${doc.version}"`);
      if (!next || seq !== this.seq || this.editing || this.live) return;
      const y = scrollY;
      this.show(this.shape(next, doc.title));
      scrollTo(0, y);
    } catch (err) {
      console.error(err);
    }
  },

  /* ---------- 문서 화면 ---------- */
  async open(title) {
    const seq = ++this.seq;
    const first = this.view !== 'doc' || !this.doc;
    this.view = 'doc';
    this.live = null;
    this.embeds.clear();
    if (first) showLoading(this.$('wk-view'));
    let doc;
    try {
      doc = await this.fetchDoc(title, '');
    } catch (err) {
      if (seq === this.seq) this.$('wk-view').replaceChildren(WikiRender.el('p', 'form-error', err.message));
      return;
    }
    if (seq !== this.seq) return;
    this.show(this.shape(doc, title));
    /* '새 문서' 로 왔으면 없는 문서는 바로 편집 상태로 연다 */
    const make = this.makeNext;
    this.makeNext = false;
    if (make && !this.doc.exists) this.edit();
    if (location.hash) { const at = document.getElementById(decodeURIComponent(location.hash.slice(1))); if (at) at.scrollIntoView(); }
  },

  show(doc) {
    const { el } = WikiRender;
    this.doc = doc;
    this.live = null;
    document.title = `${doc.title} - 불법위키`;
    const art = el('article', 'wk-doc');
    art.innerHTML =
      '<div id="wk-banner" class="wk-banner" hidden></div>' +
      '<div id="wk-toolbar" class="wk-toolbar" role="toolbar" aria-label="편집 도구" hidden></div>' +
      '<header class="wk-head"><h1 id="wk-title"></h1>' +
      '<div class="wk-btns" id="wk-tools">' +
      '<button type="button" data-act="edit">편집</button><button type="button" data-act="talk">토론</button>' +
      '<button type="button" data-act="history">역사</button>' +
      '<button type="button" data-act="more" aria-label="더 보기"></button></div></header>' +
      '<p id="wk-stamp" class="wk-stamp" hidden></p>' +
      '<p id="wk-via" class="wk-via" hidden></p>' +
      '<div id="wk-meta" class="wk-meta" hidden></div>' +
      '<section id="wk-panel" class="wk-panel" hidden></section>' +
      '<div id="wk-missing" class="wk-missing" hidden></div>' +
      '<nav id="wk-toc" class="wk-toc" aria-label="목차" hidden></nav>' +
      '<div id="wk-body" class="wk-body"></div>' +
      '<div id="wk-tail" class="wk-tail"></div>' +
      '<div id="wk-notes" class="wk-notes" hidden></div>' +
      '<details id="wk-back" class="wk-back"><summary>이 문서를 가리키는 문서</summary><div></div></details>';
    this.$('wk-view').replaceChildren(art);
    const body = this.$('wk-body');
    WikiEdit.init(body);
    WikiBlocks.init(body);
    WikiPanel.init();
    WikiTools.init(this.$('wk-toolbar'));
    this.$('wk-tools').addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]');
      if (!act) return;
      if (act.dataset.act === 'edit') this.edit();
      else if (act.dataset.act === 'more') this.more(act);
      else WikiPanel.toggle(act.dataset.act);
    });
    const h1 = this.$('wk-title');
    h1.addEventListener('input', () => { if (this.draft) { this.draft.title = h1.textContent; this.touch(); } });
    h1.addEventListener('keydown', (e) => { if (e.key === 'Enter') e.preventDefault(); });
    h1.addEventListener('paste', (e) => {
      e.preventDefault();
      document.execCommand('insertText', false, (e.clipboardData.getData('text/plain') || '').replace(/\s+/g, ' '));
    });
    this.$('wk-tail').addEventListener('click', () => this.writeAtEnd());
    this.mount();
  },

  /* 본문과 머리를 지금 상태(읽기·편집·옛 판 미리 보기·지워진 문서)에 맞춰 다시 세운다. */
  mount() {
    const doc = this.doc;
    this.readonly = !this.editing || !!doc.deleted || !!this.live;
    if (!doc.blocks.length && !this.readonly) doc.blocks.push({ cid: this.newCid(), kind: 'p', data: { runs: [] }, rev: 0 });
    const art = document.querySelector('.wk-doc');
    art.classList.toggle('is-readonly', this.readonly);
    art.classList.toggle('is-editing-doc', !this.readonly);
    art.classList.toggle('is-scoped', this.scoped);
    art.classList.toggle('is-gone', !!doc.deleted);
    art.classList.toggle('is-preview', !!this.live);
    this.$('wk-toolbar').hidden = this.readonly;
    WikiRender.mount(doc);
    this.paintHead();
    WikiTools.sync();
  },

  paintHead() {
    const doc = this.doc;
    const { el } = WikiRender;
    const whole = this.editing && !this.scoped;            /* 문서 전체 편집: 제목·분류·다른 이름도 고친다 */
    const h1 = this.$('wk-title');
    if (whole && doc.exists) {
      if (!h1.isContentEditable) {
        h1.textContent = this.draft.title;
        h1.contentEditable = 'plaintext-only';
        if (h1.contentEditable !== 'plaintext-only') h1.contentEditable = 'true';
        h1.spellcheck = false;
      }
    } else {
      h1.removeAttribute('contenteditable');
      h1.textContent = doc.title;
    }
    const via = this.$('wk-via');
    via.hidden = !doc.via || this.editing;
    via.textContent = doc.via ? `'${doc.via}'에서 넘어옴` : '';
    const stamp = this.$('wk-stamp');
    stamp.hidden = !doc.exists || !doc.updatedAt || this.editing || !!this.live;
    stamp.textContent = doc.updatedAt ? `최근 수정 시각: ${this.stamp(doc.updatedAt)} · ${doc.updatedBy}` : '';
    const tools = this.$('wk-tools');
    tools.hidden = this.editing || !!this.live || !doc.exists || !!doc.deleted;
    this.$('wk-back').hidden = !doc.exists || !!doc.deleted || this.editing;

    const button = (label, run, cls) => { const b = el('button', cls || '', label); b.type = 'button'; b.addEventListener('click', run); return b; };
    const banner = this.$('wk-banner');
    banner.replaceChildren();
    if (this.live) {
      banner.append(el('span', '', `${this.live.rev.nickname} · ${this.stamp(this.live.rev.at)}의 판`),
        button('이 판으로 되돌리기', () => WikiPanel.revert(this.live.rev)), button('지금 문서로', () => WikiPanel.endPreview()));
    } else if (doc.deleted) {
      banner.append(el('span', '', '지워진 문서'), button('되살리기', () => this.setGone(false)));
    }
    banner.hidden = !banner.childNodes.length;

    /* 아직 없는 문서 */
    const missing = this.$('wk-missing');
    missing.replaceChildren();
    missing.hidden = doc.exists || this.editing;
    if (!missing.hidden) missing.append(el('p', '', '아직 없는 문서입니다.'), button('새 문서 만들기', () => this.edit(), 'wk-make'));

    /* 분류 상자. 읽을 때는 나무위키처럼 한 줄, 문서 전체를 편집할 때는 빼고 더하는 칸이 붙는다. */
    const meta = this.$('wk-meta');
    meta.replaceChildren();
    const cats = whole ? this.draft.categories : doc.categories;
    if (whole) {
      const row = (label, items, key, hint) => {
        const line = el('div', 'wk-meta-row');
        line.append(el('span', 'wk-meta-label', label));
        items.forEach((name) => {
          const chip = el('span', 'wk-chip', name);
          const x = button('×', () => { this.draft[key] = items.filter((n) => n !== name); this.touch(); this.paintHead(); }, 'wk-chip-x');
          x.setAttribute('aria-label', `${name} 빼기`);
          chip.append(x);
          line.append(chip);
        });
        const input = el('input', 'wk-meta-add');
        input.placeholder = hint;
        input.maxLength = key === 'aliases' ? 60 : 30;
        input.autocomplete = 'off';
        input.setAttribute('aria-label', `${label} 더하기`);
        const add = (again) => {
          const v = input.value.replace(/\s+/g, ' ').trim();
          input.value = '';
          if (!v || items.some((n) => WikiLinks.key(n) === WikiLinks.key(v))) return;
          this.draft[key] = [...items, v];
          this.touch();
          this.paintHead();
          if (again) { const next = meta.querySelector(`[data-key="${key}"]`); if (next) next.focus(); }
        };
        input.dataset.key = key;
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); add(true); } });
        input.addEventListener('blur', () => add(false));
        line.append(input);
        meta.append(line);
      };
      row('분류', cats, 'categories', '분류 더하기');
      row('다른 이름', this.draft.aliases, 'aliases', '다른 이름 더하기');
    } else if (cats.length && !this.editing) {
      const line = el('div', 'wk-cats');
      line.append(document.createTextNode('분류: '));
      cats.forEach((name, i) => {
        if (i) line.append(el('span', 'wk-cats-sep', ' | '));
        const a = el('a', 'wk-link', name);
        a.href = this.href(`분류:${name}`);
        line.append(a);
      });
      meta.append(line);
    }
    meta.hidden = !meta.childNodes.length;
  },

  /* 단추 묶음의 ▾: 자주 쓰지 않는 것 */
  more(btn) {
    WikiBlocks.closeMenu();
    const { el } = WikiRender;
    const menu = el('div', 'wk-menu');
    menu.setAttribute('role', 'menu');
    const group = el('div', 'wk-menu-group');
    const item = el('button', '', '문서 지우기');
    item.type = 'button';
    item.setAttribute('role', 'menuitem');
    group.append(item);
    menu.append(group);
    document.body.append(menu);
    const rect = btn.getBoundingClientRect();
    menu.style.top = `${Math.round(rect.bottom + 4)}px`;
    menu.style.left = `${Math.max(8, Math.round(rect.right - menu.offsetWidth))}px`;
    const close = () => { menu.remove(); document.removeEventListener('pointerdown', outside, true); };
    const outside = (e) => { if (!menu.contains(e.target)) close(); };
    document.addEventListener('pointerdown', outside, true);
    item.addEventListener('click', () => { close(); this.setGone(true); });
  },

  async setGone(gone) {
    const doc = this.doc;
    if (gone && !(await confirmModal({ title: '문서 지우기', danger: true, confirm: '지우기',
      body: `<b>${escapeHtml(doc.title)}</b> 문서를 지웁니다. 본문과 이력은 남아 있어 누구나 되살릴 수 있습니다.` }))) return;
    if (!Nick.get() && !(await Nick.ensure())) return;
    const res = await Writes.commit(null, 'wiki', () => api.put(`/wiki/pages/${doc.id}`, { nickname: Nick.get(), deleted: gone }));
    if (!res || doc !== this.doc) return;
    this.pollTitles(true);
    this.pollRecent(true);
    this.open(doc.title);
  },

  /* 편집 중 본문 아래 빈 곳을 누르면 맨 끝에 한 줄을 쓴다. */
  writeAtEnd() {
    if (this.readonly || this.scoped) return;
    const last = this.doc.blocks[this.doc.blocks.length - 1];
    const box = last && this.boxOf(last.cid);
    if (last && WikiRender.TEXT_KINDS.includes(last.kind) && !last.data.runs.length) WikiEdit.enter(box, 'end');
    else WikiBlocks.insert(box, 'p');
  },

  /* ---------- 첫 화면: 최근 변경 · 찾은 결과 ---------- */
  home(query) {
    const { el } = WikiRender;
    this.seq += 1;
    this.view = 'home';
    this.doc = null;
    this.live = null;
    document.title = '불법위키 - 불법이륙';
    const card = el('section', 'wk-doc wk-home');
    if (query) {
      const found = el('div', 'wk-found');
      found.id = 'wk-found';
      card.append(found);
    }
    const list = el('ol', 'wk-recent');
    list.id = 'wk-recent';
    card.append(el('h1', '', '최근 변경'), list);
    this.$('wk-view').replaceChildren(card);
    if (query) this.paintFound(query);
    this.paintRecent();
  },

  async paintFound(query) {
    const { el } = WikiRender;
    const seq = this.seq;
    const box = this.$('wk-found');
    box.replaceChildren(el('h1', '', `'${query}' 찾기`));
    const list = el('ul', 'wk-found-list');
    const add = (title, snippet, fresh) => {
      const li = el('li');
      const a = el('a', 'wk-link' + (fresh ? ' is-new' : ''), title);
      a.href = this.href(title);
      li.append(a);
      if (fresh) li.append(el('span', 'wk-found-note', ' 아직 없는 문서'));
      if (snippet) li.append(el('p', '', snippet));
      list.append(li);
    };
    const titles = WikiLinks.search(query, 20);
    if (!WikiLinks.find(query)) add(query.trim().slice(0, 60), '', true);      /* 없는 문서: 빨간 링크 */
    titles.forEach((p) => add(p.title));
    box.append(list);
    try {
      const hits = await api.get(`/wiki/search?q=${encodeURIComponent(query)}`);
      if (seq !== this.seq) return;
      const shown = new Set(titles.map((p) => p.id));
      hits.filter((x) => !shown.has(x.id)).forEach((x) => add(x.title, x.snippet));
      hits.filter((x) => shown.has(x.id)).forEach((x) => {
        const li = [...list.children].find((n) => n.firstChild.textContent === x.title && !n.querySelector('p'));
        if (li) li.append(el('p', '', x.snippet));
      });
    } catch (err) {
      console.error(err);
    }
  },

  lineText(l) {
    const t = l.t || '';
    switch (l.k) {
      case 'text': return t;
      case 'new': return '새 문서';
      case 'del': return t ? `지움: ${t}` : '문단을 지움';
      case 'img': return t ? `그림: ${t}` : '그림';
      case 'yt': return '영상';
      case 'table': return t ? `표: ${t}` : '표';
      case 'infobox': return t ? `정보 상자: ${t}` : '정보 상자';
      case 'lyric': return t ? `가사: ${t}` : '가사';
      case 'embed': return `틀: ${t}`;
      case 'title': return `제목을 '${t}'(으)로`;
      case 'alias': return t ? `다른 이름: ${t}` : '다른 이름을 비움';
      case 'cats': return t ? `분류: ${t}` : '분류를 비움';
      case 'delete': return '문서를 지움';
      case 'restore': return '문서를 되살림';
      case 'revert': return `${t}의 판으로 되돌림`;
      case 'move': return '순서를 바꿈';
      default: return t;
    }
  },

  /* 최근 변경: 옆 줄(문서 이름만)과 첫 화면(쓴 문장까지)이 같은 목록을 쓴다. */
  async pollRecent(force) {
    if (force) pollCache.delete('/wiki/recent');
    let got;
    try { got = await api.poll('/wiki/recent'); } catch (err) { console.error(err); return; }
    this.recent = got.data;
    if (got.changed || force) this.paintRecent();
  },
  paintRecent() {
    const { el } = WikiRender;
    const side = this.$('wk-side-list');
    const seen = new Set();
    side.replaceChildren(...this.recent.filter((r) => !seen.has(r.page.id) && seen.add(r.page.id)).slice(0, 12).map((r) => {
      const a = el('a', r.page.deleted ? 'is-gone' : '');
      a.href = this.href(r.page.title);
      a.append(el('span', 'wk-side-doc', r.page.title), el('span', 'wk-side-when', this.when(r.at)));
      return a;
    }));
    const list = this.$('wk-recent');
    if (!list || this.view !== 'home') return;
    list.replaceChildren(...this.recent.map((r) => {
      const li = el('li', r.page.deleted ? 'is-gone' : '');
      const a = el('a', 'wk-recent-doc wk-link', r.page.title);
      a.href = this.href(r.page.title);
      const lines = el('div', 'wk-recent-lines');
      r.lines.forEach((l) => lines.append(el('p', l.k === 'text' ? '' : 'is-note', this.lineText(l))));
      li.append(a, el('span', 'wk-recent-who', `${r.nickname} · ${this.when(r.at)}`), lines);
      return li;
    }));
  },

  /* 분류: 이름이 있으면 그 분류의 문서, 없으면 분류 전체 */
  category(name) {
    const { el } = WikiRender;
    this.seq += 1;
    this.view = 'category';
    this.doc = null;
    this.live = null;
    this.categoryName = name;
    document.title = `${name ? `분류: ${name}` : '분류'} - 불법위키`;
    const card = el('section', 'wk-doc wk-home');
    const list = el('ul', 'wk-found-list');
    const add = (title, linkTo, note) => {
      const li = el('li');
      const a = el('a', 'wk-link', title);
      a.href = this.href(linkTo);
      li.append(a);
      if (note) li.append(el('span', 'wk-found-note', ` ${note}`));
      list.append(li);
    };
    if (name) WikiLinks.inCategory(name).forEach((p) => add(p.title, p.title));
    else {
      const count = new Map();
      WikiLinks.all().forEach((p) => (p.categories || []).forEach((c) => count.set(c, (count.get(c) || 0) + 1)));
      [...count.entries()].sort((a, b) => a[0].localeCompare(b[0], 'ko')).forEach(([c, n]) => add(c, `분류:${c}`, `${n}`));
    }
    card.append(el('h1', '', name ? `분류: ${name}` : '분류'), list);
    this.$('wk-view').replaceChildren(card);
  },

  /* ---------- 제목 목록 ---------- */
  async pollTitles(force) {
    if (force) pollCache.delete('/wiki/titles');
    let got;
    try { got = await api.poll('/wiki/titles'); } catch (err) { console.error(err); return; }
    if (!got.changed) return;
    WikiLinks.set(got.data);
    if (this.view === 'doc' && this.doc && document.getElementById('wk-body')) WikiRender.paintAll();
    else if (this.view === 'category') this.category(this.categoryName);
  },

  /* ---------- 주소 ---------- */
  place() {
    let rest = location.pathname.replace(/^\/wiki\/?/, '');
    try { rest = decodeURIComponent(rest); } catch { /* 깨진 주소는 글자 그대로 제목으로 본다 */ }
    return rest.trim();
  },
  route() {
    const rest = this.place();
    this.shown = location.pathname + location.search;
    this.editing = false;
    this.scoped = false;
    this.touched = false;
    this.draft = null;
    this.doc = null;
    WikiBlocks.closeMenu();
    this.suggest('');
    this.status('');
    if (!rest || rest.startsWith('분류:')) this.makeNext = false;
    if (!rest) this.home(new URLSearchParams(location.search).get('q') || '');
    else if (rest.startsWith('분류:')) this.category(rest.slice(3).trim());
    else this.open(rest);
  },
  /* 다른 화면으로 간다. 편집 중에 고친 것이 있으면 먼저 묻는다. */
  async go(url) {
    this.settle();
    if (this.editing && this.touched &&
      !(await confirmModal({ title: '편집 중', body: '저장하지 않은 내용을 버리고 이동합니다.', confirm: '버리고 이동', cancel: '계속 편집', danger: true }))) return;
    history.pushState(null, '', url);
    this.route();
    scrollTo(0, 0);
  },

  /* ---------- 찾기 ---------- */
  suggest(q) {
    const { el } = WikiRender;
    const box = this.$('wk-suggest');
    q = (q || '').trim();
    box.replaceChildren();
    if (q) {
      for (const p of WikiLinks.search(q)) {
        const a = el('a', 'wk-link', p.title);
        a.href = this.href(p.title);
        box.append(a);
      }
      if (!WikiLinks.find(q) && WikiLinks.key(q) && !q.startsWith('분류:')) {
        const a = el('a', 'wk-link is-new', q.slice(0, 60));
        a.href = this.href(q.slice(0, 60));
        box.append(a);
      }
    }
    box.hidden = !box.childNodes.length;
  },

  async boot() {
    document.body.classList.add('wiki-page');
    mountChrome('wiki');
    const q = this.$('wk-q');
    q.addEventListener('input', () => this.suggest(q.value));
    q.addEventListener('focus', () => this.suggest(q.value));
    q.addEventListener('keydown', (e) => { if (e.key === 'Escape') { this.suggest(''); q.blur(); } });
    q.addEventListener('blur', () => setTimeout(() => { this.suggest(''); }, 150));
    this.$('wk-find').addEventListener('submit', (e) => {
      e.preventDefault();
      const text = q.value.trim();
      if (!text) return;
      const page = WikiLinks.find(text);
      q.value = '';
      q.blur();
      this.go(page ? this.href(page.title) : `/wiki/?q=${encodeURIComponent(text)}`);
    });
    /* 새 문서: 제목을 묻고 그 문서의 편집 화면으로 간다. 같은 제목(띄어쓰기만 다른 것 포함)이 있으면 그 문서로 간다. */
    this.$('wk-new').addEventListener('click', async (e) => {
      e.preventDefault();
      const asked = await this.ask(e.currentTarget.getBoundingClientRect(), { placeholder: '새 문서의 제목', titles: true });
      const title = (asked || '').replace(/\s+/g, ' ').trim().slice(0, 60);
      if (!title || !WikiLinks.key(title)) return;
      if (title.startsWith('분류:')) { alert('쓸 수 없는 제목입니다.'); return; }
      const page = WikiLinks.find(title);
      this.makeNext = !page;
      this.go(this.href(page ? page.title : title));
    });
    this.$('wk-random').addEventListener('click', (e) => {
      e.preventDefault();
      const pages = WikiLinks.all();
      if (pages.length) this.go(this.href(pages[Math.floor(Math.random() * pages.length)].title));
    });

    /* 위키 안의 링크는 화면만 갈아 끼운다 */
    document.addEventListener('click', (e) => {
      if (e.defaultPrevented || e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = e.target.closest('a[href]');
      if (!a || a.target === '_blank' || a.id === 'wk-random' || a.id === 'wk-new') return;
      const url = new URL(a.href, location.href);
      if (url.origin !== location.origin || !url.pathname.startsWith('/wiki/')) return;
      if (url.pathname === location.pathname && url.search === location.search && url.hash) return;   /* 목차·각주: 같은 문서 안 */
      e.preventDefault();
      q.value = '';                    /* 찾기 칸에 찾던 말이 남지 않게 */
      this.go(url.pathname + url.search + url.hash);
    });
    window.addEventListener('popstate', () => {
      if (location.pathname + location.search === this.shown) return;       /* 같은 문서 안에서 목차만 오간 것 */
      this.settle();
      this.route();
    });
    /* 저장하지 않은 편집이 있으면 창을 닫기 전에 묻는다 */
    window.addEventListener('beforeunload', (e) => {
      if (!this.editing || !this.touched) return;
      e.preventDefault();
      e.returnValue = '';
    });

    await this.pollTitles();          /* 제목 목록이 있어야 첫 그림부터 링크가 맞다 */
    this.route();
    this.pollRecent(true);

    const tick = () => { this.pollTitles(); this.pollRecent(); };
    setInterval(() => { if (!document.hidden && !Writes.pending) tick(); }, 30000);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return;
      tick();
      this.refresh();
    });
  },
};

Wiki.boot();
