/* 쪽지 — 좁은 칸에 다 못 쓴 내용을 꺼내 보는 방법.

   브라우저 기본 title 은 두 가지가 안 된다. 뜨기까지 1~3초가 걸리고 그 시간을 못 바꾸며,
   손가락으로 쓰는 화면에서는 아예 안 뜬다. 그래서 직접 만든다.

   보는 법은 기기마다 다르다. 마우스는 올려놓으면, 손가락은 길게 누르면 뜬다.
   기기가 뭔지 묻지 않고 들어온 입력이 무엇인지로 가른다.

   쓰는 쪽은 data-peek="내용" 한 줄만 붙이면 된다.
   누르는 동작(지원·취소 같은 것)은 그대로 살아 있다. 길게 눌러 쪽지를 본 그 한 번만 삼킨다. */
(() => {
  const HOLD = 450;          /* 길게 누름으로 치는 시간. 이보다 짧으면 그냥 누른 것이다 */
  const MOVE = 10;           /* 이만큼 움직이면 누른 게 아니라 넘긴 것이다 */
  const GAP = 8;             /* 대상과 쪽지 사이 */

  let box = null;            /* 쪽지 하나를 돌려 쓴다 */
  let holdTimer = null;
  let startX = 0, startY = 0;
  let swallowClick = false;  /* 길게 눌러 쪽지를 연 직후의 click 한 번만 삼킨다 */
  let current = null;

  function ensureBox() {
    if (box) return box;
    box = document.createElement('div');
    box.className = 'peek';
    box.setAttribute('role', 'tooltip');
    box.hidden = true;
    document.body.appendChild(box);
    return box;
  }

  function show(el) {
    const text = el.getAttribute('data-peek');
    if (!text) return;
    current = el;
    const b = ensureBox();
    b.textContent = text;
    b.hidden = false;
    /* 화면 기준으로 띄운다. 칸이 overflow 안에 있어도 잘리지 않는다. */
    b.style.left = '0px';
    b.style.top = '0px';
    const r = el.getBoundingClientRect();
    const bw = b.offsetWidth, bh = b.offsetHeight;
    let left = r.left + r.width / 2 - bw / 2;
    left = Math.max(8, Math.min(left, innerWidth - bw - 8));
    /* 위가 좁으면 아래로 내린다 */
    let top = r.top - bh - GAP;
    b.classList.toggle('below', top < 8);
    if (top < 8) top = r.bottom + GAP;
    b.style.left = `${Math.round(left)}px`;
    b.style.top = `${Math.round(top)}px`;
  }

  function hide() {
    current = null;
    clearTimeout(holdTimer);
    holdTimer = null;
    if (box) box.hidden = true;
  }

  const target = (e) => e.target.closest?.('[data-peek]') || null;

  /* ---------- 마우스: 올려놓으면 바로 ---------- */
  document.addEventListener('pointerover', (e) => {
    if (e.pointerType !== 'mouse') return;
    const el = target(e);
    if (el === current) return;
    el ? show(el) : hide();
  });
  document.addEventListener('pointerout', (e) => {
    if (e.pointerType !== 'mouse') return;
    if (current && !e.relatedTarget?.closest?.('[data-peek]')) hide();
  });

  /* ---------- 키보드: 탭으로 닿아도 보인다 ---------- */
  document.addEventListener('focusin', (e) => {
    const el = target(e);
    el ? show(el) : hide();
  });
  document.addEventListener('focusout', hide);

  /* ---------- 손가락: 길게 누르면 ---------- */
  document.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return;
    /* 앞선 길게 누름이 click 없이 끝났을 수도 있다. 묵은 표시를 여기서 지운다.
       안 지우면 엉뚱한 다음 누름 하나를 대신 삼킨다. */
    swallowClick = false;
    const el = target(e);
    if (!el) { hide(); return; }
    startX = e.clientX; startY = e.clientY;
    clearTimeout(holdTimer);
    holdTimer = setTimeout(() => {
      holdTimer = null;
      swallowClick = true;    /* 손을 뗄 때 따라올 click 을 막는다 */
      show(el);
      /* 쪽지가 떴다는 걸 손끝으로도 알린다 */
      navigator.vibrate?.(12);
    }, HOLD);
  }, { passive: true });

  document.addEventListener('pointermove', (e) => {
    if (!holdTimer) return;
    if (Math.abs(e.clientX - startX) > MOVE || Math.abs(e.clientY - startY) > MOVE) {
      clearTimeout(holdTimer);   /* 넘기는 중이다. 쪽지를 띄우지 않는다 */
      holdTimer = null;
    }
  }, { passive: true });

  document.addEventListener('pointerup', (e) => {
    if (e.pointerType === 'mouse') return;
    clearTimeout(holdTimer);
    holdTimer = null;
  });
  document.addEventListener('pointercancel', () => { clearTimeout(holdTimer); holdTimer = null; });

  /* 길게 눌러 연 쪽지의 그 click 한 번만 삼킨다. 짧게 누른 것은 그대로 통과한다. */
  document.addEventListener('click', (e) => {
    if (!swallowClick) return;
    swallowClick = false;
    e.preventDefault();
    e.stopPropagation();
  }, true);

  /* 길게 누를 때 뜨는 브라우저 기본 메뉴와 글자 선택을 막는다 */
  document.addEventListener('contextmenu', (e) => { if (target(e)) e.preventDefault(); });

  /* 닫는 법: 아무 데나 누르기 · 넘기기 · Esc */
  document.addEventListener('pointerdown', (e) => { if (current && !target(e)) hide(); }, true);
  addEventListener('scroll', () => { if (current) hide(); }, { passive: true, capture: true });
  addEventListener('resize', hide);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });

  window.Peek = { show, hide };
})();
