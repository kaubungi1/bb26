/* 곡 정보 편집 모달. 등록과 수정이 같은 폼을 쓴다.

   프로필 편집기(profile.js)와 같은 골격이다. 부품도 같다 —
   modal-title / chip-set / pink 저장 / ghost 취소.
   새로 배울 화면이 없도록 하기 위함이다.

   등록과 수정을 나누지 않는 이유는 고치는 항목이 같기 때문이다.
   나누면 같은 폼이 두 벌이 되고, 한쪽만 고쳐져 어긋난다.

   연 곳에서 열매를 받는다. 저장했으면 곡, 지웠으면 'deleted', 닫았으면 null.

   배치(2026-10-02): 모든 줄이 '왼쪽 이름표 + 오른쪽 칸' 하나의 규칙이다. 자켓은 맨 위.
   칸마다 줄바꿈·정렬이 달라 어수선하다는 지적으로 바꿨다. 값이 차면 안내 글자(placeholder)가
   사라져서, 이름표가 없으면 수정 창에서 어느 칸이 원제이고 번역인지 알 수 없었다.

   소속(2026-10-02): 모든 곡은 길드 하나 또는 프리길드(길드 없음)에 속한다. 등록할 때 고른다.
   길드 곡은 내가 속한 길드로만 등록한다(관리자는 어느 길드든). 프리길드는 누구나.
   같은 곡을 여러 길드가 하면 길드마다 따로 둔다. 같은 소속 안의 중복, 길드에 있는 곡의 프리길드 등록은
   막고, 프리길드에 있는 곡은 새로 만들지 말고 길드장이 길드로 가져온다. 판정과 규칙은 서버(songmatch.py)가
   정하고 여기서는 같은 규칙으로 미리 보여 줄 뿐이다. 이미 있는 곡을 옮기는 것(이전)은 관리자·길드장만 된다.

   필수 칸(원제·아티스트·유튜브·소속·태그)이 비면 저장 버튼이 회색이 된다. 눌러도 저장하지 않고
   빈 칸마다 바로 아래에 무엇이 빠졌는지 적는다. 브라우저 말풍선(required)은 쓰지 않는다(novalidate). */

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

async function adminDelete(url) {
  const res = await fetch('/api/admin' + url, {
    method: 'DELETE',
    headers: { 'X-Nickname': encodeURIComponent(Nick.get()) },
  });
  if (!res.ok) throw await apiFailure(res);
  return res.json();
}

/* 후보가 고른 소속과 부딪히는 방식. 서버 songmatch.conflicts 와 같은 규칙이다.
   gid: 고른 길드 id, 프리길드는 null. 부딪히지 않으면 'other'(다른 길드 — 길드마다 따로 해도 된다). */
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
    let guilds = [];                    /* 길드 목록(길드장·멤버 포함). 열 때 한 번 받는다 */
    let cands = [];                     /* 같은 곡일 수 있는 곡들 */
    const notSame = new Set();          /* '다른 곡이에요' 를 누른 후보 */
    const already = new Set();          /* 수정 창: 열기 전부터 겹쳐 있던 곡. 이것 때문에는 막지 않는다(서버와 같은 규칙) */
    let asked = 0;                      /* 늦게 온 후보 응답이 새 것을 덮지 않게 */
    const me = Nick.get();
    const isAdmin = AdminSeen.visible();
    /* 삭제는 관리자와 등록한 사람만. 아니면 버튼 자체를 그리지 않는다. 서버(admin.can_delete)가 다시 본다 */
    const canDelete = editing && (isAdmin || (!!me && (song.createdBy || '') === me));

    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `
      <div class="modal song-modal" role="dialog" aria-modal="true" aria-labelledby="se-title">
        <h3 class="modal-title" id="se-title">${icon('edit')} ${editing ? '곡 정보' : '곡 등록'}</h3>
        <form class="modal-form song-form se-form" novalidate>
          <div class="se-preview" id="se-preview"></div>
          <div class="se-row">
            <label class="se-label" for="se-title-in">원제</label>
            <div class="se-field">
              <input id="se-title-in" maxlength="120" value="${escapeHtml((song && song.title) || '')}" />
              <p class="se-msg" data-msg="title" hidden></p>
            </div>
          </div>
          <div class="se-row">
            <label class="se-label" for="se-title-ko">번역</label>
            <div class="se-field">
              <input id="se-title-ko" maxlength="120" placeholder="한국어 번역 (선택)"
                     value="${escapeHtml((song && song.titleKo) || '')}" />
            </div>
          </div>
          <div class="se-row">
            <label class="se-label" for="se-artist">아티스트</label>
            <div class="se-field">
              <input id="se-artist" maxlength="120" value="${escapeHtml((song && song.artist) || '')}" />
              <p class="se-msg" data-msg="artist" hidden></p>
            </div>
          </div>
          <div class="se-row">
            <label class="se-label" for="se-youtube">유튜브</label>
            <div class="se-field">
              <input id="se-youtube" inputmode="url" placeholder="자켓 그림을 이 주소에서 가져옵니다"
                     value="${escapeHtml((song && song.youtubeUrl) || '')}" />
              <p class="se-msg" data-msg="youtube" hidden></p>
            </div>
          </div>
          <div class="se-row">
            <span class="se-label">길드</span>
            <div class="se-field">
              <div class="se-guild" id="se-guild"></div>
              <p class="se-msg" data-msg="guild" hidden></p>
            </div>
          </div>
          <div class="se-row" id="se-similar-row" hidden>
            <span class="se-label"></span>
            <div class="se-field">
              <div class="se-similar" id="se-similar"></div>
              <p class="se-msg" data-msg="similar" hidden></p>
            </div>
          </div>
          <div class="se-row">
            <span class="se-label">태그</span>
            <div class="se-field">
              <div class="chip-set" id="se-tags" role="radiogroup" aria-label="태그"></div>
              <p class="se-msg" data-msg="tag" hidden></p>
            </div>
          </div>
          <div class="se-row">
            <span class="se-label"></span>
            <div class="se-field">
              <p class="form-error" id="se-error" role="alert" hidden></p>
              <div class="se-buttons">
                <button type="submit" class="pink" id="se-save">${editing ? '저장' : '등록'}</button>
                <button type="button" class="ghost" data-cancel>취소</button>
              </div>
              ${canDelete ? '<button type="button" class="ghost mini se-del" data-del>이 곡 삭제</button>' : ''}
            </div>
          </div>
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
    const similarRow = $('#se-similar-row');
    const saveBtn = $('#se-save');
    /* 창 맨 아래의 한 줄은 서버가 거절한 이유(권한·중복 등)만. 칸이 빈 것은 그 칸 아래에 적는다. */
    const fail = (msg, el) => { errEl.textContent = msg; errEl.hidden = false; if (el) el.focus(); };
    const say = (key, text) => {
      const el = $(`[data-msg="${key}"]`);
      el.textContent = text || '';
      el.hidden = !text;
    };

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
    /* 등록할 수 있는 길드: 내가 멤버인 길드. 관리자는 전부(사용자 결정 (a)). 서버(_require_member)가 다시 본다 */
    const isMemberOf = (g) => !!me && (g.members || []).some((m) => m.nickname === me);
    const canRegister = (g) => isAdmin || isMemberOf(g);
    /* 수정 창에서 소속을 바꿀 수 있는 사람과, 고를 수 있는 곳. 서버(admin.can_move)가 다시 본다. */
    const movable = () => {
      if (!editing) return guilds.filter(canRegister).map((g) => g.id).concat(null);
      if (isAdmin || (startGid !== null && me && leaderOf(startGid) === me)) return guilds.map((g) => g.id).concat(null);
      if (startGid === null && me) {
        const mine = guilds.filter((g) => (g.leader || '') === me).map((g) => g.id);
        return mine.length ? mine.concat(null) : [];
      }
      return [];
    };
    /* 고른 소속. 아직 안 골랐으면 undefined, 프리길드는 null */
    const chosenGid = () => {
      const sel = $('#se-guild-in');
      if (!sel) return startGid;
      if (sel.value === '') return undefined;
      return sel.value === 'none' ? null : Number(sel.value);
    };
    const paintGuild = () => {
      const can = movable();
      if (editing && !can.length) {
        /* 바꿀 수 없으면 지금 소속만 보인다 */
        const g = guildOf(startGid);
        guildBox.innerHTML = g ? guildBadge(g) : `<span class="se-none">${FREE_GUILD}</span>`;
        return;
      }
      const opt = (v, label, on) => `<option value="${v}"${on ? ' selected' : ''}>${escapeHtml(label)}</option>`;
      /* 길드 페이지에서 열면 그 길드. 내가 그 길드에 등록할 수 없으면 프리길드. 메인에서는 직접 고른다.
         길드 목록이 늦게 와서 다시 그릴 때는 그사이 고른 것을 지킨다. */
      const prev = $('#se-guild-in') ? chosenGid() : undefined;
      let cur = editing ? startGid : prev;
      if (!editing && prev === undefined && Site.slug && guilds.length) {
        const here = guilds.find((g) => g.slug === Site.slug);
        cur = here && can.includes(here.id) ? here.id : null;
      }
      guildBox.innerHTML = `<select id="se-guild-in" aria-label="길드">
          ${editing ? '' : opt('', '소속을 고르세요', cur === undefined)}
          ${guilds.filter((g) => can.includes(g.id)).map((g) => opt(g.id, g.name, cur === g.id)).join('')}
          ${can.includes(null) ? opt('none', FREE_GUILD, cur === null) : ''}
        </select>`;
    };
    guildBox.addEventListener('change', () => { say('guild', ''); paintSimilar(); });
    paintGuild();
    api.poll('/guilds').then(({ data }) => { guilds = data || []; paintGuild(); paintSimilar(); }).catch(() => {});

    /* ---------- 혹시 이 곡인가요? ---------- */
    const NOTE = {
      same: '여기에 이미 있어요',
      inGuild: '길드에 있는 곡이에요. 그 곡에 용병으로 지원해 주세요',
      unguilded: `${FREE_GUILD}에 있어요. 새로 만들지 말고 길드로 가져와 주세요`,
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
      if (!blocking().length) say('similar', '');
      if (!shown.length) {
        similarRow.hidden = true;
        similarEl.innerHTML = '';
        refreshSave();
        return;
      }
      similarRow.hidden = false;
      similarEl.innerHTML = `<p class="se-similar-head">혹시 이 곡인가요?</p>` + shown.map((c) => {
        const kind = gid === undefined ? 'other' : kindOf(c, gid);
        const g = c.guild || guildOf(c.guildId);
        const canBring = kind === 'unguilded' && !editing && (isAdmin || (me && leaderOf(gid) === me));
        let note = NOTE[kind];
        if (kind === 'unguilded' && !canBring) {
          const who = leaderOf(gid);
          note = `${FREE_GUILD}에 있어요. ${who ? `길드장 ${who}님이` : '길드장이'} 길드로 가져올 수 있어요`;
        }
        return `
          <div class="se-cand is-${kind}" data-cand="${c.id}">
            <div class="se-cand-name">
              <b>${escapeHtml(c.title)}</b>
              <small>${escapeHtml([c.titleKo, c.artist].filter(Boolean).join(' · '))}</small>
            </div>
            <div class="se-cand-where">${g ? guildBadge(g) : `<span class="se-none">${FREE_GUILD}</span>`}</div>
            <p class="se-cand-note">${escapeHtml(note)}</p>
            <div class="se-cand-acts">
              <a class="se-act" href="/songs/?song=${c.id}">그 곡 보기</a>
              ${canBring ? `<button type="button" class="se-act is-main" data-bring="${c.id}">우리 길드로 가져오기</button>` : ''}
              ${c.reasons.includes('video') ? '' : `<button type="button" class="se-act" data-notsame="${c.id}">다른 곡이에요</button>`}
            </div>
          </div>`;
      }).join('');
      refreshSave();
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
        `<button type="button" class="chip${tag === t ? ' is-on' : ''}" role="radio" aria-checked="${tag === t}"` +
        ` data-tag="${escapeHtml(t)}">${escapeHtml(t)}</button>`).join('');
    };
    paintTags();
    tagBox.addEventListener('click', (e) => {
      const b = e.target.closest('[data-tag]');
      if (!b) return;
      tag = b.dataset.tag;          /* 태그는 꼭 하나. 다시 눌러도 꺼지지 않는다(2026-10-02) */
      say('tag', '');
      paintTags();
      paintPreview();
      refreshSave();
    });

    paintPreview();

    /* ---------- 필수 칸 ---------- */
    /* 빠진 칸 목록. [칸 이름, 안내, 옮겨 갈 곳] */
    const missing = () => {
      const out = [];
      if (!titleEl.value.trim()) out.push(['title', '원제를 입력해 주세요', titleEl]);
      if (!artistEl.value.trim()) out.push(['artist', '아티스트를 입력해 주세요', artistEl]);
      const yt = ytEl.value.trim();
      if (!yt) out.push(['youtube', '유튜브 주소를 입력해 주세요', ytEl]);
      else if (!youtubeId(yt)) out.push(['youtube', '유튜브 주소 형식이 아니에요', ytEl]);
      if (chosenGid() === undefined) {
        out.push(['guild', `소속을 골라 주세요. 어느 길드에도 넣기 애매하면 ${FREE_GUILD}를 고릅니다`, $('#se-guild-in')]);
      }
      if (!tag) out.push(['tag', '태그를 골라 주세요', tagBox.querySelector('.chip')]);
      if (blocking().length) out.push(['similar', '위의 같은 곡을 먼저 확인해 주세요', similarEl.querySelector('.se-act')]);
      return out;
    };
    /* 다 채워지기 전에는 회색. 그래도 누를 수 있다 — 누르면 무엇이 빠졌는지 칸마다 알려 준다 */
    function refreshSave() { saveBtn.classList.toggle('is-incomplete', missing().length > 0); }
    [['title', titleEl], ['artist', artistEl], ['youtube', ytEl]].forEach(([key, el]) => el.addEventListener('input', () => {
      if (el.value.trim()) say(key, '');
      refreshSave();
    }));
    guildBox.addEventListener('change', refreshSave);
    refreshSave();

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
        await Writes.run(`song:${song.id}`, () => adminDelete(`/songs/${song.id}`));
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
      errEl.hidden = true;
      const gaps = missing();
      ['title', 'artist', 'youtube', 'guild', 'tag', 'similar'].forEach((k) => say(k, ''));
      if (gaps.length) {
        gaps.forEach(([key, text]) => say(key, text));
        const first = gaps[0][2];
        if (first) { first.scrollIntoView({ block: 'nearest' }); first.focus(); }
        return;
      }
      const title = titleEl.value.trim();
      const titleKo = titleKoEl.value.trim();
      const artist = artistEl.value.trim();
      const youtube = ytEl.value.trim();
      const gid = chosenGid();

      const who = await Nick.ensure();
      if (!who) return;
      busy = true;
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
