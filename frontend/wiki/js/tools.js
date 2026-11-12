/* 불법위키 — 편집 도구 줄.

   편집 상태에서 문서 위에 붙어 따라 내려오는 한 줄이다. 여느 글쓰기 화면과 같은 모양으로 둔다.
     글자     굵게 · 취소선 · 링크 · 링크 끊기 · 각주
     꾸밈     글자색 · 배경색 · 크게 · 작게 · 윗글자(후리가나) · 꾸밈 지우기      (표의 칸에서도 된다)
     목록     목록 · 번호 목록 · 내어쓰기 · 들여쓰기       (Tab / Shift+Tab 도 같다)
     넣기     그림 · 표 · 정보 상자 · 영상 · 접기 · 알림 · 인용 · 틀
     끝       취소 · 저장

   분류(대·중·소)를 만드는 단추는 여기 없다. 분류는 본문의 상자 끝에 있는 '＋ 2.2. 중분류' 로 만든다(blocks.js addSection).
   처음에는 '큰 제목·작은 제목' 단추를 여기 두었는데, 글자 단추 22개가 늘어서서 무엇을 눌러야 하는지 알 수 없었고
   제목 단추가 목차를 만든다는 것도 드러나지 않았다(2026-11-13 사용자 지적).

   단추는 초점을 가져가지 않는다(pointerdown 을 막는다). 그래야 고른 글자와 커서가 그대로 남는다.
   대상은 '지금 고치는 문단', 없으면 마지막으로 누른 블록이다. 대상이 없는데 목록·알림·인용을 누르면 끝에 새 줄을 만든다. */
const WikiTools = (() => {
  const { el, TEXT_KINDS } = WikiRender;
  const svg = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
  /* [동작, 이름, 단추에 그릴 것(없으면 이름을 쓴다)] — 그림은 여기 적힌 고정 문자열뿐이다 */
  const GROUPS = [
    [['fmt:b', '굵게', '<b>가</b>'], ['fmt:s', '취소선', '<s>가</s>'],
      ['link', '링크', svg('<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>')],
      ['fmt:x', '링크 끊기'], ['fmt:f', '각주']],
    [['fmt:c', '글자색', '<span class="wk-ink">가</span>'], ['fmt:g', '배경색', '<span class="wk-ink is-bg">가</span>'],
      ['fmt:up', '글자 크게', '가<sup>+</sup>'], ['fmt:down', '글자 작게', '가<sub>-</sub>'], ['fmt:ruby', '윗글자'], ['fmt:clear', '꾸밈 지우기']],
    [['kind:ul', '목록', svg('<circle cx="5" cy="7" r="1.2"/><circle cx="5" cy="12" r="1.2"/><circle cx="5" cy="17" r="1.2"/><path d="M10 7h10M10 12h10M10 17h10"/>')],
      ['kind:ol', '번호 목록', svg('<path d="M4 5h1.5v4M4 15h2l-2 3h2M10 7h10M10 12h10M10 17h10"/>')],
      ['out', '내어쓰기', svg('<path d="M4 6h16M11 12h9M4 18h16M7 9l-3 3 3 3"/>')],
      ['in', '들여쓰기', svg('<path d="M4 6h16M11 12h9M4 18h16M4 9l3 3-3 3"/>')]],
    [['ins:img', '그림', svg('<rect x="3" y="5" width="18" height="14" rx="1.5"/><circle cx="8.5" cy="10" r="1.5"/><path d="m4 18 5-5 4 4 3-3 4 4"/>')],
      ['ins:table', '표', svg('<rect x="3" y="5" width="18" height="14" rx="1.5"/><path d="M3 10h18M3 14.5h18M10 5v14"/>')],
      ['ins:infobox', '정보 상자'], ['ins:yt', '영상'], ['ins:fold', '접기'], ['ins:lyric', '가사'], ['kind:notice', '알림'], ['kind:quote', '인용'], ['ins:embed', '틀']],
  ];
  let bar = null;

  /* 지금 고치는 문단의 블록, 없으면 마지막으로 누른 블록 */
  function target() {
    const cur = WikiEdit.active();
    if (cur) return cur.box;
    const struct = WikiBlocks.active();
    if (struct) return struct.box;
    const box = document.querySelector('#wk-body > .wk-block.is-active');
    return box && !Wiki.locked(box) ? box : null;
  }
  /* 넣을 자리: 대상 블록 아래. 대상이 없으면 (구역 편집이면 그 구역의) 맨 끝 */
  function anchorBox() {
    const box = target();
    if (box && box.isConnected) return box;
    const all = [...document.querySelectorAll(Wiki.scoped ? '#wk-body > .wk-block.in-scope' : '#wk-body > .wk-block')];
    return all[all.length - 1] || null;
  }

  function setKind(kind) {
    const box = target();
    if (!box || !box.isConnected) {
      /* 고르는 중인 줄이 없다: 끝에 그 종류의 새 줄을 만들고 커서를 둔다 */
      const last = anchorBox();
      const block = { cid: Wiki.newCid(), kind, data: { runs: [] }, rev: 0 };
      const made = Wiki.addBlock(block, last);
      WikiRender.paintAll();
      WikiEdit.enter(made, 'start');
      return;
    }
    if (!TEXT_KINDS.includes(box.dataset.kind)) return;
    const next = box.dataset.kind === kind ? 'p' : kind;        /* 한 번 더 누르면 본문으로 */
    const cur = WikiEdit.active();
    if (cur && cur.box === box) { WikiEdit.setKind(next); WikiRender.paintAll(); }   /* 고치는 중이면 커서를 둔 채 바꾼다 */
    else WikiBlocks.setKind(box, next);
  }

  function run(act, btn) {
    if (Wiki.readonly) return undefined;
    const rect = btn.getBoundingClientRect();
    if (act === 'save') return Wiki.commitAll();
    if (act === 'cancel') return Wiki.cancelEdit();
    if (act === 'link') return WikiEdit.link(rect);
    const [type, arg] = act.split(':');
    if (type === 'fmt') {
      if (!WikiEdit.hasSelection()) return undefined;
      /* 색은 판에서 고른다. 판을 눌러도 고른 글자는 그대로다 */
      if (arg === 'c' || arg === 'g') return Wiki.pickColor(rect, false, arg === 'g').then((color) => { if (color) WikiEdit.format(arg, color); });
      return WikiEdit.format(arg);
    }
    if (type === 'ins') return WikiBlocks.insert(anchorBox(), arg, rect);
    if (type === 'kind') setKind(arg);
    else {
      const box = target();
      if (box && box.isConnected && WikiEdit.indent(box, act === 'in' ? 1 : -1)) {
        const cur = WikiEdit.active();
        if (!cur || cur.box !== box) WikiRender.paintAll();
      }
    }
    return sync();
  }

  function init(node) {
    bar = node;
    bar.replaceChildren();
    const make = (act, name, face, cls) => {
      const b = el('button', `wk-tool ${cls || ''}`);
      b.type = 'button';
      b.dataset.act = act;
      b.title = name;
      b.setAttribute('aria-label', name);
      if (face) { b.innerHTML = face; b.classList.add('is-icon'); } else b.textContent = name;
      return b;
    };
    for (const group of GROUPS) {
      const set = el('div', 'wk-tool-group');
      group.forEach(([act, name, face]) => set.append(make(act, name, face)));
      bar.append(set);
    }
    const end = el('div', 'wk-tool-end');
    end.append(make('cancel', '취소', '', 'wk-tool-cancel'), make('save', '저장', '', 'wk-tool-save'));
    bar.append(end);
    bar.addEventListener('pointerdown', (e) => e.preventDefault());    /* 문단의 초점과 고른 글자를 지킨다 */
    bar.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (b && !b.disabled) run(b.dataset.act, b);
    });
  }

  /* 대상 블록의 종류에 맞춰 단추에 표시를 건다. */
  function sync() {
    if (!bar || bar.hidden) return;
    const box = target();
    const kind = box && box.isConnected ? box.dataset.kind : '';
    bar.querySelectorAll('[data-act^="kind:"]').forEach((b) => b.classList.toggle('is-on', b.dataset.act === `kind:${kind}`));
    const save = bar.querySelector('[data-act="save"]');
    save.disabled = !!Wiki.saving;
    save.classList.toggle('is-ready', !!Wiki.touched && !Wiki.saving);
    bar.querySelector('[data-act="cancel"]').disabled = !!Wiki.saving;
  }

  return { init, sync };
})();
