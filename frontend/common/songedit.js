/* 곡 정보 편집 모달. 등록과 수정이 같은 폼을 쓴다.

   프로필 편집기(profile.js)와 같은 골격이다. 부품도 같다 —
   modal-title / field-row / chip-set / pink 저장 / ghost 취소.
   새로 배울 화면이 없도록 하기 위함이다.

   등록과 수정을 나누지 않는 이유는 고치는 항목이 같기 때문이다.
   나누면 같은 폼이 두 벌이 되고, 한쪽만 고쳐져 어긋난다.

   연 곳에서 열매를 받는다. 저장했으면 곡, 지웠으면 'deleted', 닫았으면 null.

   소속(2026-10-02): 모든 곡은 길드 하나 또는 무길드에 속한다. 등록할 때 고른다.
   같은 곡을 여러 길드가 하면 길드마다 따로 둔다. 같은 소속 안의 중복, 길드에 있는 곡의 무길드 등록은
   막고, 무길드에 있는 곡은 새로 만들지 말고 길드로 가져온다. 판정과 규칙은 서버(songmatch.py)가 정하고
   여기서는 같은 규칙으로 미리 보여 줄 뿐이다. 이미 있는 곡을 옮기는 것(이전)은 관리자·길드장만 된다. */

/* 유튜브 주소를 넣는 순간 자켓이 보인다. 맞는 영상을 넣었는지 글 없이 확인한다.
   저장된 자켓은 서버가 주지만, 아직 저장 전인 새 주소는 유튜브에서 바로 받아 본다. */
function thumbPreviewUrl(url) {
  const id = youtubeId(url);
  return id ? `https://img.youtube.com/vi/${id}/mqdefault.jpg` : '';
}

/* 이전은 /api/admin 아래에 있다. 관리자 쿠키가 그 경로에만 실리고, 길드장은 닉네임 머리로 가린다. */
async function adminPost(url, body) {
  const res = await fetch('/api/admin' + url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Nickname': encodeURIComponent(Nick.get()) },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await apiFailure(res);
  return res.json();
}

/* 후보가 고른 소속과 부딪히는 방식. 서버 songmatch.conflicts 와 같은 규칙이다.
   gid: 고른 길드 id, 무길드는 null. 부딪히지 않으면 'other'(다른 길드 — 길드마다 따로 해도 된다). */
function songConflict(cand, gid) {
  const g = cand.guildId ?? null;
  if (g === gid) return 'same';
  if (gid === null) return 'inGuild';
  if (g === null) return 'unguilded';
  return 'other';
}

const SIMILAR_WAIT = 450;   /* 입력이 멈추고 이만큼 지나면 후보를 묻는다. 글자마다 묻지 않는다 */

function openSongEditor(song, opts = {}) {
  const editing = !!(song && song.id);
  return new Promise((resolve) => {
    let tag = (song && song.tags) || '';
    let busy = false;
    let guilds = [];                    /* 길드 목록(길드장 이름 포함). 열 때 한 번 받는다 */
    let cands = [];                     /* 같은 곡일 수 있는 곡들 */
    const notSame = new Set();          /* '다른 곡이에요' 를 누른 후보 */
    const already = new Set();          /* 수정 창: 열기 전부터 겹쳐 있던 곡. 이것 때문에는 막지 않는다(서버와 같은 규칙) */
    let asked = 0;                      /* 늦게 온 후보 응답이 새 것을 덮지 않게 */
    const me = Nick.get();
    const isAdmin = AdminSeen.visible();

    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `
      <div class="modal song-modal" role="dialog" aria-modal="true" aria-labelledby="se-title">
        <h3 class="modal-title" id="se-title">${icon('edit')} ${editing ? '곡 정보' : '곡 등록'}</h3>
        <form class="modal-form song-form">
          <div class="se-top">
            <div class="se-preview" id="se-preview"></div>
            <div class="se-top-fields">
              <input id="se-title-in" placeholder="원제" maxlength="120" required
                     value="${escapeHtml((song && song.title) || '')}" />
              <input id="se-title-ko" placeholder="한국어 번역 (선택)" maxlength="120"
                     value="${escapeHtml((song && song.titleKo) || '')}" />
              <input id="se-artist" placeholder="아티스트" maxlength="120" required
                     value="${escapeHtml((song && song.artist) || '')}" />
            </div>
          </div>
          <input id="se-youtube" placeholder="유튜브 주소" inputmode="url" required
                 value="${escapeHtml((song && song.youtubeUrl) || '')}" />
          <p class="se-note">자켓 그림을 이 주소에서 가져옵니다.</p>
          <div class="field-row se-guild-row">
            <span class="field-label">길드</span>
            <div class="se-guild" id="se-guild"></div>
          </div>
          <div class="se-similar" id="se-similar" hidden></div>
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
    const titleKoEl = $('#se-title-ko');
    const artistEl = $('#se-artist');
    const ytEl = $('#se-youtube');
    const errEl = $('#se-error');
    const guildBox = $('#se-guild');
    const similarEl = $('#se-similar');
    const fail = (msg, el) => { errEl.textContent = msg; errEl.hidden = false; if (el) el.focus(); };

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

    /* ---------- 길드 ---------- */
    const startGid = editing ? (song.guildId ?? null) : undefined;
    const leaderOf = (gid) => (guilds.find((g) => g.id === gid) || {}).leader || '';
    const guildOf = (gid) => guilds.find((g) => g.id === gid) || null;
    /* 수정 창에서 소속을 바꿀 수 있는 사람과, 고를 수 있는 곳. 서버(admin.can_move)가 다시 본다. */
    const movable = () => {
      if (!editing) return guilds.map((g) => g.id).concat(null);
      if (isAdmin || (startGid !== null && me && leaderOf(startGid) === me)) return guilds.map((g) => g.id).concat(null);
      if (startGid === null && me) {
        const mine = guilds.filter((g) => (g.leader || '') === me).map((g) => g.id);
        return mine.length ? mine.concat(null) : [];
      }
      return [];
    };
    const paintGuild = () => {
      const can = movable();
      if (editing && !can.length) {
        /* 바꿀 수 없으면 지금 소속만 보인다 */
        const g = guildOf(startGid);
        guildBox.innerHTML = g ? guildBadge(g) : '<span class="se-none">무길드</span>';
        return;
      }
      const opt = (v, label, on) => `<option value="${v}"${on ? ' selected' : ''}>${escapeHtml(label)}</option>`;
      const cur = editing ? startGid : (Site.slug ? (guilds.find((g) => g.slug === Site.slug) || {}).id : undefined);
      guildBox.innerHTML = `<select id="se-guild-in">
          ${editing ? '' : opt('', '소속을 고르세요', cur === undefined)}
          ${guilds.filter((g) => can.includes(g.id)).map((g) => opt(g.id, g.name, cur === g.id)).join('')}
          ${can.includes(null) ? opt('none', '무길드 (어느 길드에도 넣기 애매한 곡)', cur === null) : ''}
        </select>`;
    };
    /* 고른 소속. 아직 안 골랐으면 undefined, 무길드는 null */
    const chosenGid = () => {
      const sel = $('#se-guild-in');
      if (!sel) return startGid;
      if (sel.value === '') return undefined;
      return sel.value === 'none' ? null : Number(sel.value);
    };
    guildBox.addEventListener('change', () => paintSimilar());
    paintGuild();
    api.poll('/guilds').then(({ data }) => { guilds = data || []; paintGuild(); paintSimilar(); }).catch(() => {});

    /* ---------- 혹시 이 곡인가요? ---------- */
    const NOTE = {
      same: '여기에 이미 있어요',
      inGuild: '길드에 있는 곡이에요. 그 곡에 용병으로 지원해 주세요',
      unguilded: '무길드에 있어요. 새로 만들지 말고 길드로 가져와 주세요',
      other: '다른 길드에서도 하고 있어요. 길드마다 따로 해도 돼요',
      already: '전부터 겹쳐 있던 곡이에요. 관리자가 두 곡을 병합해 정리합니다',
    };
    /* 화면에 쓸 종류. 수정 창에서 소속을 그대로 두면 전부터 겹쳐 있던 곡은 막지 않는다 */
    const kindOf = (c, gid) => {
      const k = songConflict(c, gid);
      return k !== 'other' && editing && gid === startGid && already.has(c.id) ? 'already' : k;
    };
    const blocking = () => {
      const gid = chosenGid();
      if (gid === undefined) return [];
      return cands.filter((c) => !(notSame.has(c.id) && !c.reasons.includes('video'))
        && !['other', 'already'].includes(kindOf(c, gid)));
    };
    function paintSimilar() {
      const gid = chosenGid();
      const shown = cands.filter((c) => !(notSame.has(c.id) && !c.reasons.includes('video')));
      if (!shown.length) { similarEl.hidden = true; similarEl.innerHTML = ''; return; }
      similarEl.hidden = false;
      similarEl.innerHTML = `<p class="se-similar-head">혹시 이 곡인가요?</p>` + shown.map((c) => {
        const kind = gid === undefined ? 'other' : kindOf(c, gid);
        const g = c.guild || guildOf(c.guildId);
        const canBring = kind === 'unguilded' && !editing && (isAdmin || (me && leaderOf(gid) === me));
        let note = NOTE[kind];
        if (kind === 'unguilded' && !canBring) {
          const who = leaderOf(gid);
          note = `무길드에 있어요. ${who ? `길드장 ${who}님이` : '길드장이'} 길드로 가져올 수 있어요`;
        }
        return `
          <div class="se-cand is-${kind}" data-cand="${c.id}">
            <div class="se-cand-name">
              <b>${escapeHtml(c.title)}</b>
              <small>${escapeHtml([c.titleKo, c.artist].filter(Boolean).join(' · '))}</small>
            </div>
            <div class="se-cand-where">${g ? guildBadge(g) : '<span class="se-none">무길드</span>'}</div>
            <p class="se-cand-note">${escapeHtml(note)}</p>
            <div class="se-cand-acts">
              <a class="se-act" href="/songs/?song=${c.id}">그 곡 보기</a>
              ${canBring ? `<button type="button" class="se-act is-main" data-bring="${c.id}">우리 길드로 가져오기</button>` : ''}
              ${c.reasons.includes('video') ? '' : `<button type="button" class="se-act" data-notsame="${c.id}">다른 곡이에요</button>`}
            </div>
          </div>`;
      }).join('');
    }
    let timer = 0;
    const askSimilar = () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const title = titleEl.value.trim();
        const titleKo = titleKoEl.value.trim();
        const yt = ytEl.value.trim();
        if (!title && !titleKo && !youtubeId(yt)) { cands = []; paintSimilar(); return; }
        const n = ++asked;
        const q = new URLSearchParams({ title, titleKo, youtubeUrl: youtubeId(yt) ? yt : '' });
        if (editing) q.set('exclude', song.id);
        try {
          const found = await api.get(`/songs/similar?${q}`);
          if (n === asked) { cands = found; paintSimilar(); }
        } catch { /* 후보를 못 받아도 등록은 된다. 서버가 저장할 때 다시 본다 */ }
      }, SIMILAR_WAIT);
    };
    /* 수정 창은 열 때 묻지 않는다. 이미 있는 중복(정리 전 곡)으로 태그 하나 못 바꾸게 되면 곤란하다.
       제목·주소를 고치기 시작하면 그때 묻는다. */
    [titleEl, titleKoEl, ytEl].forEach((el) => el.addEventListener('input', askSimilar));
    if (editing) {
      const q = new URLSearchParams({ title: song.title || '', titleKo: song.titleKo || '',
                                      youtubeUrl: song.youtubeUrl || '', exclude: song.id });
      api.get(`/songs/similar?${q}`).then((found) => {
        found.filter((c) => songConflict(c, startGid) !== 'other').forEach((c) => already.add(c.id));
      }).catch(() => {});
    }

    similarEl.addEventListener('click', async (e) => {
      const ns = e.target.closest('[data-notsame]');
      if (ns) { notSame.add(Number(ns.dataset.notsame)); errEl.hidden = true; paintSimilar(); return; }
      const br = e.target.closest('[data-bring]');
      if (!br || busy) return;
      const gid = chosenGid();
      const id = Number(br.dataset.bring);
      busy = true;
      try {
        const moved = await Writes.run(`song:${id}`, () => adminPost(`/songs/${id}/guild`, { guildId: gid }));
        close(moved);
      } catch (err) {
        busy = false;
        fail(err.message);
      }
    });

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
      clearTimeout(timer);
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
        fail(err.message);
      }
    });

    /* ---------- 저장 ---------- */
    $('.song-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      if (busy) return;
      const title = titleEl.value.trim();
      const titleKo = titleKoEl.value.trim();
      const artist = artistEl.value.trim();
      const youtube = ytEl.value.trim();
      if (!title || !artist) return fail('원제와 아티스트를 입력하세요.', title ? artistEl : titleEl);
      if (!youtube) return fail('유튜브 주소를 입력하세요. 자켓 그림을 여기서 가져옵니다.', ytEl);
      if (!youtubeId(youtube)) return fail('유튜브 주소 형식이 아닙니다.', ytEl);
      const gid = chosenGid();
      if (gid === undefined) return fail('소속을 고르세요. 어느 길드에도 넣기 애매하면 무길드를 고릅니다.', $('#se-guild-in'));
      if (blocking().length) { paintSimilar(); return fail('위의 같은 곡을 먼저 확인해 주세요.'); }

      const who = await Nick.ensure();
      if (!who) return;
      busy = true;
      errEl.hidden = true;
      try {
        let saved;
        if (editing) {
          /* 바뀐 칸만 보낸다. 제목·주소를 안 건드렸으면 서버도 중복을 다시 따지지 않는다. */
          const body = { artist, tags: tag, notSame: [...notSame] };
          if (title !== (song.title || '')) body.title = title;
          if (titleKo !== (song.titleKo || '')) body.titleKo = titleKo;
          if (youtube !== (song.youtubeUrl || '')) body.youtubeUrl = youtube;
          saved = await Writes.run(`song:${song.id}`, () => api.put(`/songs/${song.id}`, body));
          if (gid !== startGid) {
            saved = await Writes.run(`song:${song.id}`, () => adminPost(`/songs/${song.id}/guild`, { guildId: gid }));
          }
        } else {
          const body = { title, titleKo, artist, youtubeUrl: youtube, tags: tag, createdBy: who,
                         guildId: gid, notSame: [...notSame] };
          if (Array.isArray(opts.roles)) body.roles = opts.roles;
          saved = await Writes.run('song:new', () => api.post('/songs', body));
        }
        close(saved);
      } catch (err) {
        busy = false;
        /* 그사이 누가 같은 곡을 넣었으면 서버가 후보를 실어 409 로 돌려준다 */
        if (err.status === 409 && err.detail && Array.isArray(err.detail.candidates)) {
          cands = err.detail.candidates;
          paintSimilar();
        }
        fail(err.message);
      }
    });

    document.body.appendChild(backdrop);
    titleEl.focus();
  });
}
