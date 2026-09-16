/* 길드 만들기와 정보 편집은 같은 폼을 쓴다.

   꾸미기(테마·문장)는 길드를 만든 뒤에만, 그리고 길드원만 고칠 수 있다.
   서버도 같은 확인을 한다(routers/guilds.py). 로그인이 없어 닉네임은 자기 신고라
   이 확인은 보안이 아니라 실수 방지다 — 지나가다 남의 길드를 갈아엎는 것을 막는 정도다. */
async function openGuildEditor(guild = null) {
  const nickname = await Nick.ensure();
  if (!nickname) return null;
  return new Promise((resolve) => {
    const g = guild || { leader: nickname, color: '#00b8ad' };
    const canStyle = !!guild && (guild.members || []).some((m) => m.nickname === nickname);
    /* 저장된 값을 편집 시작점으로. 고르는 동안 화면에 바로 거는 것도 이 값을 쓴다. */
    const style = JSON.parse(JSON.stringify(guild?.style || {}));
    const before = { theme: style.theme || null, crest: style.crest || null, ink: style.ink || null };
    /* 색은 저장해야만 화면에 걸렸다. 그래서 바꿔도 아무 일이 안 일어나는 것처럼 보였고,
       저장한 뒤에도 페이지를 새로 열기 전까지는 옛 색 그대로였다(refresh 는 HTML 만 다시 그린다).
       테마·문장과 똑같이 고르는 즉시 걸고 취소하면 되돌린다.
       지금 보고 있는 화면이 그 길드일 때만이다 — 길드 목록에서 남의 색을 걸 이유가 없다. */
    const liveColor = !!guild && Site.slug === guild.slug;
    const beforeColor = guild?.color || null;
    /* 색 칸은 한 곳에만 뜬다. 꾸미기를 열 수 있으면 꾸미기 안에, 아니면 위쪽에.
       name 이 같은 칸이 둘이면 FormData 가 어느 쪽을 담을지 알 수 없다. */
    const colorField = `<label>색<input type="color" name="color"`
      + ` value="${/^#[0-9a-f]{6}$/i.test(g.color || '') ? g.color : '#00b8ad'}" /></label>`;
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `
      <section class="modal guild-modal" role="dialog" aria-modal="true" aria-labelledby="guild-editor-title">
        <h3 class="modal-title" id="guild-editor-title">${guild ? '길드 정보' : '길드 만들기'}</h3>
        <form class="modal-form">
          <label>이름<input name="name" maxlength="30" required value="${escapeHtml(g.name || '')}" /></label>
          ${guild ? '' : '<label>길드 주소<input name="slug" pattern="[a-z0-9][a-z0-9-]{1,30}" minlength="2" maxlength="31" required placeholder="예: daepa" /><small class="muted">영문 소문자·숫자·하이픈 2~31자</small></label>'}
          ${guild && canStyle ? '' : `<div class="guild-editor-row one">${colorField}</div>`}
          <label>팀장<input name="leader" maxlength="20" value="${escapeHtml(g.leader || '')}" /></label>
          <label>슬로건<input name="slogan" maxlength="60" value="${escapeHtml(g.slogan || '')}" /></label>
          <label>모집 문구<textarea name="recruitNote" maxlength="200" rows="2">${escapeHtml(g.recruitNote || '')}</textarea></label>
          ${guild && canStyle ? `
          <div class="gs-block">
            <span class="field-label">길드 색</span>
            <div class="gs-gcolor">${colorField}
              <small>길드 밖 목록에서 이 길드를 가리키는 색입니다.</small></div>
            <span class="field-label">테마</span>
            <div class="gs-themes" id="gs-themes"></div>
            <span class="field-label">길드명 글자</span>
            <div class="gs-ink" id="gs-ink">
              <button type="button" class="chip" data-gs-ink="">자동</button>
              <button type="button" class="chip" data-gs-ink="#ffffff">흰색</button>
              <button type="button" class="chip" data-gs-ink="#14252b">짙은색</button>
              <input type="color" id="gs-ink-c" />
              <small class="gs-ink-note"></small>
            </div>
            <span class="field-label">문장</span>
            <div class="gs-crest">
              <div class="gs-preview" id="gs-preview"></div>
              <div class="gs-colors">
                <label>바탕<input type="color" id="gs-bg" value="${style.crest?.bg || '#00b8ad'}" /></label>
                <label>문양<input type="color" id="gs-fg" value="${style.crest?.fg || '#ffffff'}" /></label>
                <button type="button" class="ghost mini" id="gs-flip">뒤집기</button>
                <button type="button" class="ghost mini" id="gs-none">문장 없음</button>
              </div>
            </div>
            <div class="gs-shapes" id="gs-shapes"></div>
          </div>` : ''}
          <p class="form-error" role="alert" hidden></p>
          <button type="submit">${guild ? '저장' : '만들기'}</button>
          <button type="button" class="ghost" data-cancel>취소</button>
        </form>
      </section>`;
    let busy = false;
    const previousFocus = document.activeElement;
    /* 고르는 동안 뒤 화면에 바로 건다. 취소하면 열기 전으로 되돌린다 —
       저장하지 않았는데 화면만 바뀐 채로 남으면 무엇이 저장된 건지 알 수 없다. */
    const live = (s) => {
      applyTheme(s.theme || null);
      paintColor();
      document.dispatchEvent(new CustomEvent('guildstyle', { detail: s }));
    };
    const close = (value) => {
      if (busy) return;
      if (!value) {
        live(before);
        if (liveColor) {
          if (beforeColor) applyGuildColor(beforeColor); else clearGuildColor();
          applyGuildInk(before.ink);      /* 색을 되돌리면 글자색도 같이 되돌려야 한다 */
        }
      }
      backdrop.remove();
      previousFocus?.focus();
      resolve(value);
    };
    /* 길드색과 판 위 글자색은 늘 같이 건다. 색만 다시 걸면 applyGuildColor 가
       --on-accent 를 자동값으로 되돌려서, 길드가 고른 글자색이 조용히 사라진다. */
    const colorIn = backdrop.querySelector('input[name=color]');
    const paintColor = () => {
      if (!liveColor) return;
      applyGuildColor(colorIn.value);
      applyGuildInk(style.ink);
    };
    if (liveColor) colorIn.addEventListener('input', paintColor);
    backdrop.querySelector('[data-cancel]').onclick = () => close(null);
    backdrop.onclick = (e) => { if (e.target === backdrop) close(null); };
    backdrop.onkeydown = (e) => { if (e.key === 'Escape') close(null); };
    backdrop.querySelector('form').onsubmit = async (e) => {
      e.preventDefault();
      if (busy) return;
      const form = e.currentTarget;
      const body = Object.fromEntries(new FormData(form));
      body.name = body.name.trim();
      if (!body.name) { form.elements.name.focus(); return; }
      body.createdBy = nickname;
      /* 꾸미기는 폼 입력이 아니라 고른 값이라 따로 싣는다.
         nickname 은 서버가 길드원인지 확인하는 데 쓴다. */
      if (canStyle) { body.style = style; body.nickname = nickname; }
      busy = true;
      form.querySelector('[type=submit]').disabled = true;
      const error = form.querySelector('.form-error');
      error.hidden = true;
      try {
        const saved = guild
          ? await api.put(`/guilds/${encodeURIComponent(g.slug)}`, body)
          : await api.post('/guilds', body);
        busy = false;
        close(saved);
      } catch (err) {
        error.textContent = err.message;
        error.hidden = false;
      } finally {
        busy = false;
        form.querySelector('[type=submit]').disabled = false;
      }
    };
    /* ---------- 꾸미기 고르기 ----------
       테마 이름과 문양 이름은 themes.css / crest.js 가 가진 목록을 그대로 쓴다.
       서버도 같은 목록으로 거른다(routers/guilds.py). 세 곳이 어긋나면
       화면에서는 고를 수 있는데 저장이 안 되는 상태가 된다. */
    if (canStyle) {
      const THEME_NAMES = { '': '기본', takeoff: '불법이륙', miku: '미쿠', melody: '마이멜로디',
        city: '도시', temple: '신전', wood: '원목', nature: '산', medieval: '중세',
        sea: '바다', deepsea: '심해' };
      const $$ = (s) => backdrop.querySelector(s);
      const bgIn = $$('#gs-bg'), fgIn = $$('#gs-fg');

      const paintThemes = () => {
        $$('#gs-themes').innerHTML = Object.entries(THEME_NAMES).map(([k, label]) =>
          `<button type="button" class="chip${(style.theme || '') === k ? ' is-on' : ''}"
            data-gs-theme="${k}">${escapeHtml(label)}</button>`).join('');
      };
      const paintCrest = () => {
        const c = style.crest;
        $$('#gs-preview').innerHTML = c ? crestSvg(c, 64)
          : '<span class="gs-none-mark">없음</span>';
        $$('#gs-shapes').innerHTML = Object.keys(CREST_SHAPES).map((k) =>
          `<button type="button" class="gs-shape${c && c.shape === k ? ' is-on' : ''}"
            data-gs-shape="${k}" title="${escapeHtml(CREST_NAMES[k] || k)}"
            >${crestSvg({ shape: k, bg: bgIn.value, fg: fgIn.value }, 40)}</button>`).join('');
      };
      const inkIn = $$('#gs-ink-c');
      const paintInk = () => {
        const cur = style.ink || '';
        $$('#gs-ink').querySelectorAll('[data-gs-ink]').forEach((b) => {
          b.classList.toggle('is-on', (b.dataset.gsInk || '') === cur);
        });
        /* 안 골랐으면 화면이 계산한 값을 그대로 보여 준다 — 빈 칸보다 알기 쉽다. */
        const shown = cur || Tone.hex(Tone.onTop(Tone.rgb(colorIn.value) || [0, 184, 173]));
        inkIn.value = shown;
        const on = Tone.rgb(shown), acc = Tone.rgb(colorIn.value);
        const note = $$('.gs-ink-note');
        if (!on || !acc) { note.textContent = ''; return; }
        const v = Tone.ratio(on, acc);
        note.textContent = `대비 ${v.toFixed(2)}` + (v >= 4.5 ? '' : ' — 작은 글자가 안 읽힙니다');
        note.classList.toggle('is-warn', v < 4.5);
      };
      $$('#gs-ink').onclick = (e) => {
        const b = e.target.closest('[data-gs-ink]');
        if (!b) return;
        if (b.dataset.gsInk) style.ink = b.dataset.gsInk; else delete style.ink;
        paintInk(); live(style);
      };
      inkIn.oninput = () => { style.ink = inkIn.value; paintInk(); live(style); };
      colorIn.addEventListener('input', paintInk);

      paintThemes(); paintCrest(); paintInk(); live(style);

      $$('#gs-themes').onclick = (e) => {
        const b = e.target.closest('[data-gs-theme]');
        if (!b) return;
        style.theme = b.dataset.gsTheme || undefined;
        if (!style.theme) delete style.theme;
        paintThemes(); live(style);
      };
      $$('#gs-shapes').onclick = (e) => {
        const b = e.target.closest('[data-gs-shape]');
        if (!b) return;
        style.crest = { shape: b.dataset.gsShape, bg: bgIn.value, fg: fgIn.value };
        paintCrest(); live(style);
      };
      const recolor = () => {
        if (style.crest) { style.crest.bg = bgIn.value; style.crest.fg = fgIn.value; }
        paintCrest(); live(style);
      };
      bgIn.oninput = recolor;
      fgIn.oninput = recolor;
      $$('#gs-flip').onclick = () => {
        const a = bgIn.value; bgIn.value = fgIn.value; fgIn.value = a; recolor();
      };
      $$('#gs-none').onclick = () => { delete style.crest; paintCrest(); live(style); };
    }

    document.body.appendChild(backdrop);
    backdrop.querySelector('[name=name]').focus();
  });
}
