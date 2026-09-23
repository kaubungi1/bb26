/* 캐릭터(프로필) 편집 모달. 홈과 멤버 페이지가 같이 쓴다.
   닉네임이 열쇠라 권한 확인은 없다. 본인 것만 열게 하는 건 화면의 몫이다. */

const PROFILE_COLORS = ['#00b8ad', '#ec4899', '#6366f1', '#f59e0b', '#22b8e6', '#8b5cf6', '#2f9e54', '#ef4444'];

async function openProfileEditor(nickname, opts = {}) {
  /* 창은 캐시로 바로 연다. 전에는 서버의 최신 프로필을 받을 때까지 창이 열리지 않아서
     프로필 열기와 로그아웃(이 창 안에 있다)이 느렸다. 최신값은 뒤에서 받아, 창에서 아직 아무것도
     만지지 않았을 때만 채운다 — 입력하던 것을 덮지 않는다. 못 받으면 캐시 그대로 쓴다. */
  const fresh = fetch(`/api/members/${encodeURIComponent(nickname)}`)
    .then((res) => (res.ok ? res.json() : null))
    .catch(() => null);
  return new Promise((resolve) => {
    let cur = Profiles.get(nickname) || { nickname };
    let color = cur.color || '';
    let role = cur.mainRoles || '';
    let imageFile = null;          /* 새로 고른 파일 */
    let removeImage = false;
    let previewUrl = cur.hasImage ? imageUrl(cur) : '';
    let objectUrl = '';
    let busy = false;

    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `
      <div class="modal profile-modal" role="dialog" aria-modal="true" aria-labelledby="profile-title">
        <h3 class="modal-title" id="profile-title">${icon('edit')} 내 프로필</h3>
        <form class="modal-form profile-form">
          <div class="pf-top">
            <div class="pf-avatar">
              <label class="pf-file" title="이미지 변경">
                <div class="pf-preview" id="pf-preview"></div>
                <span class="pf-file-hint" aria-hidden="true">변경</span>
                <span class="pf-sr">프로필 이미지 올리기</span>
                <input class="pf-file-input" type="file" id="pf-file" accept="image/*" />
              </label>
            </div>
            <div class="pf-top-fields">
              <div class="pf-nick">${escapeHtml(nickname)}</div>
              <p class="pf-nick-note">닉네임은 여기서 바꿀 수 없습니다</p>
              <button type="button" class="pf-clear${cur.hasImage ? '' : ' is-off'}" id="pf-clear">이미지 지우기</button>
            </div>
          </div>
          <div class="field-row">
            <span class="field-label">색</span>
            <div class="pf-colors" id="pf-colors"></div>
          </div>
          <div class="field-row">
            <span class="field-label">연주 파트 (선택)</span>
            <div class="chip-set" id="pf-roles"></div>
          </div>
          <input id="pf-title" placeholder="칭호 (예: 천안아산최대JPOP어쩌구핑딱)" maxlength="30" value="${escapeHtml(cur.title || '')}" />
          <input id="pf-status" placeholder="상태 메시지 (예: 임종)" maxlength="60" value="${escapeHtml(cur.status || '')}" />
          <input id="pf-avail" placeholder="가능 시간 (예: 평일 저녁, 주말 오후)" maxlength="80" value="${escapeHtml(cur.availability || '')}" />
          <textarea id="pf-intro" placeholder="한 줄 소개" maxlength="200" rows="2">${escapeHtml(cur.intro || '')}</textarea>
          <!-- 대사 세 줄. 합주실 무대에서 말풍선으로 한 명씩 돌아가며 뜬다.
               안 써도 되는 값이라 라벨을 크게 두지 않고 입력칸의 안내문으로만 알린다. -->
          <div class="pf-lines">${[0, 1, 2].map((i) => `<input class="pf-line" maxlength="40"
            placeholder="${i === 0 ? '무대에서 할 말 (40자)' : ''}"
            value="${escapeHtml((cur.lines || [])[i] || '')}" />`).join('')}</div>
          <button type="submit" class="pink">저장</button>
          <button type="button" class="ghost" data-cancel>취소</button>
          ${opts.withLogout ? '<button type="button" class="pf-logout" data-logout>로그아웃</button>' : ''}
        </form>
      </div>`;

    const preview = backdrop.querySelector('#pf-preview');
    const paintPreview = () => {
      const fg = color || nickColor(nickname)[0];
      preview.style.setProperty('--chip-fg', fg);
      preview.style.setProperty('--chip-bg', `color-mix(in srgb, ${fg} 14%, #fff)`);
      if (previewUrl) preview.innerHTML = `<img src="${previewUrl}" alt="" />`;
      else preview.textContent = /^[a-zA-Z]/.test(nickname) ? nickname.slice(0, 2).toUpperCase() : nickname.slice(0, 1);
    };
    /* 팔레트는 한 번만 그린다. 고른 표시는 markColors() 가 클래스만 바꾼다.
       전에는 색을 고를 때마다 innerHTML 을 다시 써서 <input type=color> 가 새것으로
       갈렸고, 운영체제의 색 고르기 창이 그 입력칸에 매여 있어서 첫 클릭에 닫혀 버렸다.
       색을 계속 조절할 수가 없었다. 입력칸을 살려 두면 끄는 동안 미리보기가 따라온다. */
    const paintColors = () => {
      backdrop.querySelector('#pf-colors').innerHTML =
        '<button type="button" class="pf-color none" data-color="" title="기본">✕</button>' +
        PROFILE_COLORS.map((c) => `<button type="button" class="pf-color" data-color="${c}" style="--c:${c}"></button>`).join('') +
        `<label class="pf-color custom" title="직접 고르기"><input type="color" id="pf-color-custom" value="${color || '#00b8ad'}" /></label>`;
      markColors();
    };
    const markColors = () => {
      const box = backdrop.querySelector('#pf-colors');
      box.querySelectorAll('[data-color]').forEach((b) =>
        b.classList.toggle('is-on', (b.dataset.color || '') === (color || '')));
      box.querySelector('.pf-color.custom')
        .classList.toggle('is-on', !!color && !PROFILE_COLORS.includes(color));
    };
    const paintRoles = () => {
      const customRoles = role.split(',').map(v => v.trim()).filter(v => v && !ROLE_ORDER.includes(v));
      backdrop.querySelector('#pf-roles').innerHTML =
        ROLE_ORDER.map((r) => `<button type="button" class="chip${role.split(',').map(v=>v.trim()).includes(r) ? ' is-on' : ''}" data-role="${r}">${r}</button>`).join('') +
        `<button type="button" class="chip${customRoles.length ? ' is-on' : ''}" data-role="__custom">${customRoles.length ? escapeHtml(customRoles.join(', ')) : '직접 입력'}</button>`;
    };
    paintPreview(); paintColors(); paintRoles();

    /* 뒤에서 받은 최신값. 창에서 무언가 만졌으면 폼은 그대로 두고 캐시만 고친다. */
    let edited = false;
    backdrop.querySelector('.profile-form').addEventListener('input', () => { edited = true; });
    backdrop.querySelector('.profile-form').addEventListener('click', (e) => {
      if (e.target.closest('button, input, label')) edited = true;
    });
    fresh.then((m) => {
      if (!m) return;
      Profiles.put(m);
      if (edited || !backdrop.isConnected) return;
      cur = m;
      color = m.color || '';
      role = m.mainRoles || '';
      previewUrl = m.hasImage ? imageUrl(m) : '';
      const set = (sel, v) => { const el = backdrop.querySelector(sel); if (el) el.value = v || ''; };
      set('#pf-title', m.title);
      set('#pf-status', m.status);
      set('#pf-avail', m.availability);
      set('#pf-intro', m.intro);
      backdrop.querySelectorAll('.pf-line').forEach((el, i) => { el.value = (m.lines || [])[i] || ''; });
      backdrop.querySelector('#pf-clear').classList.toggle('is-off', !m.hasImage);
      paintPreview(); markColors(); paintRoles();
    });

    const close = (v) => {
      if (busy) return;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      backdrop.remove(); resolve(v);
    };
    backdrop.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(null); });
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(null); });
    backdrop.querySelector('[data-cancel]').addEventListener('click', () => close(null));
    /* 닉네임은 바꾸지 않는다. 다른 이름으로 쓰려면 로그아웃하고 다시 들어온다. */
    backdrop.querySelector('[data-logout]')?.addEventListener('click', () => {
      Nick.logout();
      document.dispatchEvent(new Event('nickchange'));
      close(true);
    });
    backdrop.querySelector('#pf-file').addEventListener('change', async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      /* 값을 먼저 비운다. 같은 파일을 다시 골라도 change 가 뜬다. */
      e.target.value = '';
      if (f.size > 8 * 1024 * 1024) { alert('8MB 아래로 올려주세요.'); return; }
      const cropped = await openCropper(f);
      if (!cropped) return;                 /* 자르기를 취소했다. 여기서 끝낸다. */
      imageFile = new File([cropped], 'avatar.png', { type: 'image/png' });
      removeImage = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = URL.createObjectURL(cropped);
      previewUrl = objectUrl;
      backdrop.querySelector('#pf-clear').classList.remove('is-off');
      paintPreview();
    });
    backdrop.querySelector('#pf-clear').addEventListener('click', () => {
      imageFile = null; removeImage = true; previewUrl = '';
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = '';
      backdrop.querySelector('#pf-file').value = '';
      backdrop.querySelector('#pf-clear').classList.add('is-off');
      paintPreview();
    });
    backdrop.querySelector('#pf-colors').addEventListener('click', (e) => {
      const b = e.target.closest('[data-color]');
      if (!b) return;
      color = b.dataset.color;
      markColors(); paintPreview();
    });
    backdrop.querySelector('#pf-colors').addEventListener('input', (e) => {
      if (e.target.id !== 'pf-color-custom') return;
      color = e.target.value;
      markColors(); paintPreview();   /* 다시 그리면 열려 있는 색 고르기 창이 닫힌다 */
    });
    backdrop.querySelector('#pf-roles').addEventListener('click', (e) => {
      const b = e.target.closest('[data-role]');
      if (!b) return;
      if (b.dataset.role === '__custom') {
        const v = prompt('추가 파트 이름 (쉼표로 구분)', role.split(',').filter(r => !ROLE_ORDER.includes(r.trim())).join(','));
        if (v === null) return;
        role = [...new Set([...role.split(',').filter(r => ROLE_ORDER.includes(r.trim())), ...v.split(',')].map(r=>r.trim()).filter(Boolean))].join(',');
      } else {
        const set = new Set(role.split(',').map(v=>v.trim()).filter(Boolean)); if(set.has(b.dataset.role))set.delete(b.dataset.role);else set.add(b.dataset.role); role=[...set].join(',');
      }
      paintRoles();
    });
    backdrop.querySelector('.profile-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      if (busy) return;
      const body = {
        color,
        mainRoles: role,
        title: backdrop.querySelector('#pf-title').value.trim(),
        status: backdrop.querySelector('#pf-status').value.trim(),
        availability: backdrop.querySelector('#pf-avail').value.trim(),
        intro: backdrop.querySelector('#pf-intro').value.trim(),
        /* 빈 줄은 서버가 버린다. 순서는 적은 대로 둔다. */
        lines: [...backdrop.querySelectorAll('.pf-line')].map((el) => el.value.trim()),
      };
      /* 누르는 즉시 닫고 저장은 뒤에서 한다(common.js Writes). 사진은 올라가는 동안
         방금 자른 그림을 먼저 보여 준다. 창이 닫히며 미리보기 주소는 해제되므로 따로 만든다.
         실패하면 알리고 원래 프로필로 되돌린다. */
      const file = imageFile;
      const remove = removeImage && cur.hasImage;
      const shown = { ...cur, ...body, nickname };
      if (file) Object.assign(shown, { hasImage: true, imageUrl: URL.createObjectURL(file) });
      else if (remove) Object.assign(shown, { hasImage: false, imageUrl: null });
      Profiles.put(shown);
      Writes.run('profile:' + nickname, async () => {
        let saved = await api.put(`/members/${encodeURIComponent(nickname)}`, body);
        if (file) {
          const fd = new FormData();
          fd.append('file', file);
          saved = await api.post(`/members/${encodeURIComponent(nickname)}/image`, fd);
        } else if (remove) {
          await api.del(`/members/${encodeURIComponent(nickname)}/image`);
          saved = { ...saved, hasImage: false, imageUrl: null };
        }
        Profiles.put(saved);
      }).catch((err) => {
        Profiles.put(cur);
        alert(`프로필을 저장하지 못했습니다. ${err.message}`);
      });
      close(shown);
    });
    document.body.appendChild(backdrop);
  });
}
