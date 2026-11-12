/* 불법위키 — 역사(이력·되돌리기), 토론, 이 문서를 가리키는 문서.

   셋 다 문서를 열 때는 받지 않는다. 눌러서 펼칠 때 한 번 받는다 — 읽기만 하는 사람에게 요청이 늘지 않게.

   되돌리기는 막는 장치가 없는 위키의 유일한 안전장치라 가벼워야 한다.
   판을 누르면 그때의 문서가 그 자리에 보이고, 위의 띠에서 '이 판으로 되돌리기' 를 누르면 끝이다.
   되돌린 것도 새 판으로 남으므로 잘못 되돌려도 다시 되돌릴 수 있다. */
const WikiPanel = (() => {
  const { el } = WikiRender;
  let open = '';

  function panel() { return Wiki.$('wk-panel'); }

  function close() {
    open = '';
    const box = panel();
    if (box) { box.hidden = true; box.replaceChildren(); }
    document.querySelectorAll('#wk-tools [data-act]').forEach((b) => b.removeAttribute('aria-pressed'));
  }

  async function toggle(kind) {
    if (open === kind) { close(); return; }
    Wiki.settle();
    close();
    open = kind;
    const btn = document.querySelector(`#wk-tools [data-act="${kind}"]`);
    if (btn) btn.setAttribute('aria-pressed', 'true');
    const box = panel();
    box.hidden = false;
    showLoading(box);
    try {
      if (kind === 'history') await paintHistory(box);
      else await paintTalk(box);
    } catch (err) {
      if (open === kind) box.replaceChildren(el('p', 'form-error', err.message));
    }
  }

  /* ---------- 역사 ---------- */
  async function paintHistory(box) {
    const doc = Wiki.doc;
    const rows = await api.get(`/wiki/pages/${doc.id}/history`);
    if (open !== 'history' || doc !== Wiki.doc) return;
    const list = el('ol', 'wk-history');
    rows.forEach((rev, i) => {
      const li = el('li');
      const head = el('div', 'wk-history-head');
      head.append(el('b', '', rev.nickname), el('span', '', Wiki.when(rev.at)));
      if (i > 0) {                         /* 맨 위는 지금 문서다. 볼 것도 되돌릴 것도 없다 */
        const view = el('button', '', '이 판 보기');
        view.type = 'button';
        view.addEventListener('click', () => preview(rev));
        head.append(view);
      }
      li.append(head);
      rev.lines.forEach((l) => li.append(el('p', l.k === 'text' ? '' : 'is-note', Wiki.lineText(l))));
      list.append(li);
    });
    box.replaceChildren(list);
  }

  async function preview(rev) {
    const doc = Wiki.live ? Wiki.live.doc : Wiki.doc;
    Wiki.settle();
    let snap;
    try {
      snap = await api.get(`/wiki/pages/${doc.id}/history/${rev.id}`);
    } catch (err) {
      alert(err.message);
      return;
    }
    if ((Wiki.live ? Wiki.live.doc : Wiki.doc) !== doc) return;
    Wiki.live = { doc, rev };
    Wiki.doc = { ...doc, blocks: snap.blocks, images: { ...doc.images, ...snap.images } };
    Wiki.mount();
    close();
    Wiki.$('wk-banner').scrollIntoView({ block: 'nearest' });
  }

  function endPreview() {
    if (!Wiki.live) return;
    Wiki.doc = Wiki.live.doc;
    Wiki.live = null;
    Wiki.mount();
  }

  async function revert(rev) {
    const doc = Wiki.live ? Wiki.live.doc : Wiki.doc;
    if (!Nick.get() && !(await Nick.ensure())) return;
    const res = await Writes.commit(null, 'wiki', () => api.post(`/wiki/pages/${doc.id}/revert`,
      { nickname: Nick.get(), revisionId: rev.id }));
    if (!res) return;
    if ((Wiki.live ? Wiki.live.doc : Wiki.doc) !== doc) return;
    Wiki.pollRecent(true);
    Wiki.show(Wiki.shape(res, res.title));
  }

  /* ---------- 토론 ---------- */
  async function paintTalk(box) {
    const doc = Wiki.doc;
    const rows = await api.get(`/wiki/pages/${doc.id}/talks`);
    if (open !== 'talk' || doc !== Wiki.doc) return;
    const list = el('ul', 'wk-talk');
    const line = (t) => {
      const li = el('li');
      li.append(el('b', '', t.nickname), el('span', 'wk-talk-body', t.body), el('span', 'wk-talk-when', Wiki.when(t.createdAt)));
      if (t.nickname === Nick.get()) {
        const x = el('button', 'wk-chip-x', '×');
        x.type = 'button';
        x.setAttribute('aria-label', '내 글 지우기');
        x.addEventListener('click', async () => {
          const ok = await Writes.commit(x, 'wiki-talk', async () => {
            const res = await fetch(`/api/wiki/pages/${doc.id}/talks/${t.id}?nickname=${encodeURIComponent(Nick.get())}`, { method: 'DELETE' });
            if (!res.ok) throw await apiFailure(res);
            return true;
          });
          if (ok) li.remove();
        });
        li.append(x);
      }
      return li;
    };
    rows.forEach((t) => list.append(line(t)));
    const form = el('form', 'wk-talk-form');
    const input = el('input');
    input.maxLength = 300;
    input.placeholder = '한마디';
    input.autocomplete = 'off';
    input.setAttribute('aria-label', '토론에 한마디');
    form.append(input);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = input.value.trim();
      if (!body || (!Nick.get() && !(await Nick.ensure()))) return;
      input.value = '';
      const made = await Writes.commit(null, 'wiki-talk', () => api.post(`/wiki/pages/${doc.id}/talks`, { nickname: Nick.get(), body }));
      if (made) list.append(line(made)); else input.value = body;
    });
    box.replaceChildren(list, form);
    input.focus({ preventScroll: true });
  }

  /* ---------- 이 문서를 가리키는 문서 ---------- */
  function init() {
    open = '';
    const back = Wiki.$('wk-back');
    back.addEventListener('toggle', async () => {
      const doc = Wiki.doc;
      if (!back.open || !doc.exists) return;
      const box = back.lastElementChild;
      showLoading(box);
      try {
        const rows = await api.get(`/wiki/pages/${doc.id}/backlinks`);
        if (doc !== Wiki.doc) return;
        box.replaceChildren(...(rows.length ? rows.map((p) => {
          const a = el('a', 'wk-link', p.title);
          a.href = Wiki.href(p.title);
          return a;
        }) : [el('span', 'wk-none', '없음')]));
      } catch (err) {
        box.replaceChildren(el('p', 'form-error', err.message));
      }
    });
  }

  return { init, toggle, close, preview, endPreview, revert };
})();
