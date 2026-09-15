/* 길드 만들기와 정보 편집은 같은 폼을 쓴다. */
async function openGuildEditor(guild = null) {
  const nickname = await Nick.ensure();
  if (!nickname) return null;
  return new Promise((resolve) => {
    const g = guild || { leader: nickname, color: '#00b8ad' };
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `
      <section class="modal guild-modal" role="dialog" aria-modal="true" aria-labelledby="guild-editor-title">
        <h3 class="modal-title" id="guild-editor-title">${guild ? '길드 정보' : '길드 만들기'}</h3>
        <form class="modal-form">
          <label>이름<input name="name" maxlength="30" required value="${escapeHtml(g.name || '')}" /></label>
          ${guild ? '' : '<label>길드 주소<input name="slug" pattern="[a-z0-9][a-z0-9-]{1,30}" minlength="2" maxlength="31" required placeholder="예: daepa" /><small class="muted">영문 소문자·숫자·하이픈 2~31자</small></label>'}
          <div class="guild-editor-row">
            <label>엠블럼<input name="emblem" maxlength="8" value="${escapeHtml(g.emblem || '')}" placeholder="이모지 하나" /></label>
            <label>색<input type="color" name="color" value="${/^#[0-9a-f]{6}$/i.test(g.color || '') ? g.color : '#00b8ad'}" /></label>
          </div>
          <label>팀장<input name="leader" maxlength="20" value="${escapeHtml(g.leader || '')}" /></label>
          <label>슬로건<input name="slogan" maxlength="60" value="${escapeHtml(g.slogan || '')}" /></label>
          <label>모집 문구<textarea name="recruitNote" maxlength="200" rows="2">${escapeHtml(g.recruitNote || '')}</textarea></label>
          <p class="form-error" role="alert" hidden></p>
          <button type="submit">${guild ? '저장' : '만들기'}</button>
          <button type="button" class="ghost" data-cancel>취소</button>
        </form>
      </section>`;
    let busy = false;
    const previousFocus = document.activeElement;
    const close = (value) => {
      if (busy) return;
      backdrop.remove();
      previousFocus?.focus();
      resolve(value);
    };
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
    document.body.appendChild(backdrop);
    backdrop.querySelector('[name=name]').focus();
  });
}
