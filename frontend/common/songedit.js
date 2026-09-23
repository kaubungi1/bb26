/* 곡 정보 편집 모달. 등록과 수정이 같은 폼을 쓴다.

   프로필 편집기(profile.js)와 같은 골격이다. 부품도 같다 —
   modal-title / field-row / chip-set / pink 저장 / ghost 취소.
   새로 배울 화면이 없도록 하기 위함이다.

   등록과 수정을 나누지 않는 이유는 고치는 항목이 같기 때문이다.
   나누면 같은 폼이 두 벌이 되고, 한쪽만 고쳐져 어긋난다.

   연 곳에서 열매를 받는다. 저장했으면 곡, 지웠으면 'deleted', 닫았으면 null. */

/* 유튜브 주소를 넣는 순간 자켓이 보인다. 맞는 영상을 넣었는지 글 없이 확인한다.
   저장된 자켓은 서버가 주지만, 아직 저장 전인 새 주소는 유튜브에서 바로 받아 본다. */
function thumbPreviewUrl(url) {
  const id = youtubeId(url);
  return id ? `https://img.youtube.com/vi/${id}/mqdefault.jpg` : '';
}

function openSongEditor(song, opts = {}) {
  const editing = !!(song && song.id);
  return new Promise((resolve) => {
    let tag = (song && song.tags) || '';
    let busy = false;

    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `
      <div class="modal song-modal" role="dialog" aria-modal="true" aria-labelledby="se-title">
        <h3 class="modal-title" id="se-title">${icon('edit')} ${editing ? '곡 정보' : '곡 등록'}</h3>
        <form class="modal-form song-form">
          <div class="se-top">
            <div class="se-preview" id="se-preview"></div>
            <div class="se-top-fields">
              <input id="se-title-in" placeholder="곡명" maxlength="120" required
                     value="${escapeHtml((song && song.title) || '')}" />
              <input id="se-artist" placeholder="아티스트" maxlength="120" required
                     value="${escapeHtml((song && song.artist) || '')}" />
            </div>
          </div>
          <input id="se-youtube" placeholder="유튜브 주소" inputmode="url" required
                 value="${escapeHtml((song && song.youtubeUrl) || '')}" />
          <p class="se-note">자켓 그림을 이 주소에서 가져옵니다.</p>
          <div class="field-row">
            <span class="field-label">태그</span>
            <div class="chip-set" id="se-tags"></div>
          </div>
          <p class="form-error" id="se-error" role="alert" hidden></p>
          <button type="submit" class="pink">${editing ? '저장' : '등록'}</button>
          <button type="button" class="ghost" data-cancel>취소</button>
          ${editing ? '<button type="button" class="ghost mini se-del" data-del>이 곡 삭제</button>' : ''}
        </form>
      </div>`;

    const $ = (s) => backdrop.querySelector(s);
    const titleEl = $('#se-title-in');
    const artistEl = $('#se-artist');
    const ytEl = $('#se-youtube');
    const errEl = $('#se-error');

    /* ---------- 자켓 미리보기 ---------- */
    const preview = $('#se-preview');
    const paintPreview = () => {
      const url = thumbPreviewUrl(ytEl.value.trim());
      const fake = { title: titleEl.value || (song && song.title) || '', artist: artistEl.value || '', tags: tag };
      preview.className = `se-preview genre-${songTone(fake)}`;
      if (url) {
        preview.innerHTML = `<img src="${escapeHtml(url)}" alt="" />`;
      } else {
        preview.classList.add('is-mark');
        preview.innerHTML = `<span class="se-mark">${escapeHtml(fake.title || fake.artist ? songLetter(fake) : '♪')}</span>`;
      }
    };
    ytEl.addEventListener('input', paintPreview);
    titleEl.addEventListener('input', paintPreview);

    /* ---------- 태그 ---------- */
    const tagBox = $('#se-tags');
    const paintTags = () => {
      tagBox.innerHTML = TAGS.map((t) =>
        `<button type="button" class="chip${tag === t ? ' is-on' : ''}" data-tag="${escapeHtml(t)}">${escapeHtml(t)}</button>`).join('');
    };
    paintTags();
    tagBox.addEventListener('click', (e) => {
      const b = e.target.closest('[data-tag]');
      if (!b) return;
      tag = tag === b.dataset.tag ? '' : b.dataset.tag;   /* 다시 누르면 태그 없음 */
      paintTags();
      paintPreview();
    });

    paintPreview();

    /* ---------- 닫기 ---------- */
    const close = (value) => {
      document.removeEventListener('keydown', onKey);
      backdrop.remove();
      resolve(value);
    };
    const onKey = (e) => { if (e.key === 'Escape' && !busy) close(null); };
    document.addEventListener('keydown', onKey);
    backdrop.addEventListener('click', (e) => {
      if (busy) return;
      if (e.target === backdrop || e.target.closest('[data-cancel]')) close(null);
    });

    /* ---------- 삭제 ---------- */
    backdrop.addEventListener('click', async (e) => {
      if (!e.target.closest('[data-del]') || busy) return;
      if (!confirm('이 곡과 연결된 파트·지원이 모두 삭제됩니다. 진행할까요?')) return;
      busy = true;
      try {
        await Writes.run(`song:${song.id}`, () => api.del(`/songs/${song.id}`));
        close('deleted');
      } catch (err) {
        busy = false;
        errEl.textContent = err.message;
        errEl.hidden = false;
      }
    });

    /* ---------- 저장 ---------- */
    $('.song-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      if (busy) return;
      const title = titleEl.value.trim();
      const artist = artistEl.value.trim();
      const youtube = ytEl.value.trim();
      const fail = (msg, el) => { errEl.textContent = msg; errEl.hidden = false; el.focus(); };
      if (!title || !artist) return fail('곡명과 아티스트를 입력하세요.', title ? artistEl : titleEl);
      if (!youtube) return fail('유튜브 주소를 입력하세요. 자켓 그림을 여기서 가져옵니다.', ytEl);
      if (!youtubeId(youtube)) return fail('유튜브 주소 형식이 아닙니다.', ytEl);

      const me = await Nick.ensure();
      if (!me) return;
      busy = true;
      errEl.hidden = true;
      const body = { title, artist, youtubeUrl: youtube, tags: tag };
      try {
        let saved;
        if (editing) {
          saved = await Writes.run(`song:${song.id}`, () => api.put(`/songs/${song.id}`, body));
        } else {
          body.createdBy = me;
          if (Array.isArray(opts.roles)) body.roles = opts.roles;
          /* 소속은 고르는 것이 아니라 어디서 등록했느냐로 정해진다.
             길드 페이지에서 넣으면 그 길드 곡, 메인에서 넣으면 불법이륙 전체 곡이다.
             Site.slug 가 이미 답을 알고 있으므로 묻지 않는다. */
          if (Site.slug) body.guildSlug = Site.slug;
          saved = await Writes.run('song:new', () => api.post('/songs', body));
        }
        close(saved);
      } catch (err) {
        busy = false;
        fail(err.message, titleEl);
      }
    });

    document.body.appendChild(backdrop);
    titleEl.focus();
  });
}
