/* Actual site home. API-backed songs, supports, events and guilds. */
(() => {
const $=s=>document.querySelector(s),esc=escapeHtml,reducedMotion=matchMedia('(prefers-reduced-motion: reduce)').matches;
let songs=[],events=[],guilds=[],guild=null,parts=[],selected=null,auto=false,timer,drag=false,cleanupCarousel=()=>{},busy=false,version=0;
let comments={},ticker=null,tickIdx=0,tickOpen=false;
let chipsOpen=false;
/* 필터 목록은 데이터에서 나오지만 거의 바뀌지 않는다. 기억해 두었다가
   로딩 중에도 채워 두면 데이터가 와도 필터 줄이 밀리지 않는다. */
const LISTS='bb26-lists';
let genreList=[],guildList=[];
try{const v=JSON.parse(localStorage.getItem(LISTS)||'{}');genreList=v.genres||[];guildList=v.guilds||[]}catch{}   /* 좁은 화면에서만 의미가 있다. 넓으면 CSS 가 토글을 숨긴다 */   /* 곡 한마디. 2초마다 한 줄씩 */
const key='bb26-home-v4:'+Site.base;
let saved={};try{saved=JSON.parse(sessionStorage.getItem(key)||'{}')}catch{}
let prefs={query:'',genres:[],guilds:[],part:'',period:'all',sort:'recommend',dir:1,...saved.prefs};
let scores={},randomScores={},reasons={};selected=saved.selected;
/* 마지막으로 본 끌올(bumpedAt). 새 끌올이면 한 번만 그 곡으로 데려간다 — 볼 때마다 끌려가면 목록을 둘러볼 수 없다. */
let seenBump=saved.seenBump||null,bumpShown=null;   /* bumpShown: 목록을 마지막으로 세울 때의 끌올 곡 */
function persist(){try{sessionStorage.setItem(key,JSON.stringify({prefs,selected,scores,randomScores,reasons,seenBump}))}catch{}}
const genre=songGenre;   /* common.js — 곡의 얼굴은 모든 화면이 같은 규칙을 쓴다 */
const ORDER=['보컬','일렉1','일렉2','베이스','키보드','드럼'],ABBR=ROLE_SHORT;/* 약어는 common.js 한 곳에서만 정한다 */
const baseRole=r=>ORDER.find(k=>r.startsWith(k))||(r.startsWith('기타')||r.startsWith('일렉')?'일렉1':r.startsWith('보')?'보컬':'');
const abbr=r=>ABBR[baseRole(r)]||r.replace(/[()]/g,'').slice(0,2);
parts=[...ORDER];   /* 로딩 중에도 빈 자리 칩이 보이도록 기본값을 채운다 */
const ordered=s=>[...s.sessions].sort((a,b)=>(ORDER.indexOf(baseRole(a.role))+1||99)-(ORDER.indexOf(baseRole(b.role))+1||99)||a.id-b.id);
const shortGenre=g=>g.replace(/^J[ -]?POP/i,'J-POP').replace('애니송(게임)','애니송 · 게임').replace('미분류','기타');
const dateSpan=ds=>{const a=ds.map(d=>d.date).sort();return a.length>3?`${a[0].slice(5)} ~ ${a[a.length-1].slice(5)} · ${a.length}일 중 선택`:a.map(d=>d.slice(5)).join(' · ')};
const tone=songTone;
function mix(){const weights=Array.from({length:5},()=>.2+Math.random()),genres={},groups={};songs.forEach(s=>{genres[s.genre]??=.2+Math.random();groups[s.guild?.slug||'none']??=.2+Math.random()});songs.forEach(s=>{const terms=[s.age===null?0:1/(1+s.age/14),genres[s.genre],groups[s.guild?.slug||'none'],s.empty.length/Math.max(1,s.sessions.length),.2+Math.random()].map((v,i)=>v*weights[i]);scores[s.id]=-Math.log(Math.max(Math.random(),.000001))/terms.reduce((a,b)=>a+b,0);randomScores[s.id]=Math.random();reasons[s.id]=['최근 등록 반영','장르 혼합','길드 혼합','미지원 파트 반영','무작위 발견'][terms.indexOf(Math.max(...terms))]});persist()}
/* 곡으로도 사람으로도 찾는다. 닉네임과 시트 표기를 둘 다 본다 — 곡 페이지와 같은 규칙. */
function hit(s,q){return [s.title,s.artist,s.createdBy].some(t=>(t||'').toLowerCase().includes(q))
  ||s.sessions.some(p=>p.supports.some(a=>(a.nickname||'').toLowerCase().includes(q)||(a.label||'').toLowerCase().includes(q)))}
const DIRECTED=['name','new'];   /* 방향을 뒤집을 수 있는 정렬 */
function list(){const a=songs.filter(s=>(!prefs.query||hit(s,prefs.query.toLowerCase()))&&(!prefs.genres.length||prefs.genres.includes(s.genre))&&(!prefs.guilds.length||prefs.guilds.includes(s.guild?.slug||'none'))&&(!prefs.part||s.empty.includes(prefs.part))&&(prefs.period==='all'||s.age!==null&&s.age<=Number(prefs.period)));/* 방향은 곡명순·최근 등록에만 있다. 추천·무작위는 뒤집을 순서 자체가 없다. */
 const dir=DIRECTED.includes(prefs.sort)?(prefs.dir<0?-1:1):1;
 a.sort(prefs.sort==='name'?(a,b)=>dir*a.title.localeCompare(b.title,'ko'):prefs.sort==='new'?(a,b)=>dir*((a.age??Infinity)-(b.age??Infinity))||a.id-b.id:(a,b)=>(prefs.sort==='random'?randomScores[a.id]-randomScores[b.id]:scores[a.id]-scores[b.id])||a.id-b.id);
 /* 끌올 곡은 어느 정렬에서든 맨 앞이다. 필터에 걸러진 곡은 끼우지 않는다 — 필터가 거짓말을 하게 된다. */
 const b=bumped(),i=b?a.indexOf(b):-1;if(i>0){a.splice(i,1);a.unshift(b)}
 return a}
/* ---------- 끌올 ----------
   곡 목록에 bumpedBy·bumpedAt·bumpNote 가 이미 실려 온다. 따로 묻지 않는다(요청이 늘지 않는다).
   살아 있는 시간은 서버와 같아야 한다 — backend/routers/songs.py BUMP_MINUTES. */
const BUMP_MINUTES=30;
const bumpLeft=s=>s&&s.bumpedAt?new Date(s.bumpedAt).getTime()+BUMP_MINUTES*60000-Date.now():0;
function bumped(){return songs.find(s=>bumpLeft(s)>0)||null}
const bumpMin=s=>Math.max(1,Math.ceil(bumpLeft(s)/60000));
/* 자켓 섬네일 아래쪽의 끌올 띠. 장르 꼬리표처럼 자기 바탕을 가져 그림이 밝든 어둡든 읽힌다. */
function jkBump(s){if(bumpLeft(s)<=0)return'';const pct=Math.round(bumpLeft(s)/(BUMP_MINUTES*600));
 return `<span class="jk-bump" title="${esc(s.bumpedBy+(s.bumpNote?': '+s.bumpNote:''))}"><span class="jk-bump-line"><b>↑ 끌올</b><span>${esc(s.bumpedBy||'')}</span>${s.bumpNote?`<q>${esc(s.bumpNote)}</q>`:''}<em>${bumpMin(s)}분</em></span><i style="width:${pct}%"></i></span>`}
/* transport 줄의 끌올 버튼. 지금 보는 곡과 끌올 상태에 따라 글자가 바뀐다 — 곡 페이지 bumpBtn 과 같은 규칙. */
function bumpCtl(id){const b=bumped(),me=Nick.get();
 if(b&&b.id===id)return b.bumpedBy===me?'<button type="button" id="bump-btn" data-unbump>끌올 내리기</button>':`<button type="button" id="bump-btn" disabled>↑ 끌올 중</button>`;
 if(b)return `<button type="button" id="bump-btn" disabled title="${esc(b.bumpedBy)}님이 끌올 중">↑ ${bumpMin(b)}분<span class="bump-wait"> 뒤</span></button>`;
 return '<button type="button" id="bump-btn">↑ 끌올</button>'}
/* 자켓. 위가 섬네일, 아래가 잉크 띠, 그 아래가 파트 여섯 칸이다.
   글자가 그림 위에 절대 올라가지 않으므로 섬네일이 밝든 어둡든 대비가 같다.
   섬네일이 없으면 그 자리에 제목 첫 글자를 깐다. 한글은 건너뛰고 아티스트에서 뽑는다. */
function jacket(s){const parts=ordered(s),me=Nick.get();
 const shot=s.hasThumb
  ? `<img class="jk-img" src="${s.thumbUrl||`/api/songs/${s.id}/thumb`}" alt="" loading="lazy" decoding="async">`
  : `<span class="jk-mark" aria-hidden="true">${esc(bigLetter(s))}</span>`;
 return `<div class="jacket genre-${tone(s)}"><div class="jk-shot"><span class="jk-genre"><span>${esc(shortGenre(s.genre))}</span></span>${!Site.slug&&s.guild?`<span class="jk-guild">${guildBadge(s.guild)}</span>`:''}${shot}${jkBump(s)}</div><div class="jk-band"><b>${esc(s.title)}</b><small>${esc(s.artist||'')}</small></div><div class="slots" aria-hidden="true">${parts.map(p=>`<i class="slot ${me&&p.supports.some(x=>x.nickname===me)?'mine':p.supports.length?'on':'off'}"><em>${esc(abbr(p.role))}</em><u>${p.supports.length}</u></i>`).join('')}</div></div>`}
/* 섬네일이 없을 때 깔 글자. 가나·한자·영숫자만 쓴다. 한글은 건너뛴다. */
const bigLetter=songLetter;
function detail(s){const me=Nick.get(),parts=ordered(s);return `<section class="now"><div class="now-slots">${parts.map(p=>slot(p,me,s)).join('')||'<span class="muted">등록된 파트 없음</span>'}</div>${murmur(s)}</section>`}
/* 한 자리. 본체는 지원·취소 버튼이고, 연필은 이름을 고치는 별도 버튼이다. 둘이 겹치지 않는다.

   여기서는 누르는 즉시 지원·취소된다. 곡 페이지(songs.js)는 같은 칸을 눌러도
   파트 상세 모달이 먼저 열리고 거기서 한 번 더 누른다. 어긋난 것이 아니라
   두 화면의 설계 철학이 다르기 때문이다. 맞추지 말 것.

   홈은 고르는 화면이다. 자켓을 넘기며 마음에 드는 곡의 빈 자리를 집는 곳이라
   동작이 하나로 끝나야 한다(§9.2). 한 단계를 끼우면 넘기는 리듬이 끊긴다.
   곡 페이지는 보는 화면이다. 한 칸에 지원자 전원과 '이 곡에서 보일 내 이름 ✎' 이
   들어가야 해서 모달이 정보를 담는 값을 한다.

   이 차이를 없애려면 양쪽 화면의 성격을 먼저 다시 정해야 한다. */
function slot(p,me,song){const mine=p.supports.find(x=>x.nickname===me);
 /* 내 이름을 맨 앞으로. 칸이 좁아 잘려도 내가 먼저 보인다. 나머지는 지원 순서 그대로.
    용병(길드 곡에 길드원 아닌 지원자)은 이름에 색·점선 밑줄이 붙고, 쪽지에는 (용병) 이 적힌다(common.js). */
 const people=[...(mine?[mine]:[]),...p.supports.filter(x=>x!==mine)];const names=people.map(supportName);const full=people.map(x=>supportText(x,song)).join(', ');
 /* 칸 폭이 좁아 잘리는 경우에만 쪽지를 단다. 짧은 이름 하나면 그대로 다 보인다. */
 const clip=names.length>1||full.length>6;
 return `<div class="slot-wrap" data-slot="${p.id}"${clip?` data-peek="${esc(full)}"`:''}><button type="button" class="slot-btn ${mine?'mine':names.length?'on':'off'}" data-support="${p.id}" aria-pressed="${!!mine}" aria-label="${esc(p.label||p.role)} ${names.length}명${mine?' · 지원 취소':' · 지원'}"><span class="sl-abbr">${esc(abbr(p.role))}</span><span class="sl-role">${esc(p.label||p.role)}</span><span class="sl-people">${names.length?people.slice(0,3).map(x=>supportHtml(x,song)).join(', ')+(names.length>3?` 외 ${names.length-3}`:''):'비어 있음'}</span><span class="sl-act">${mine?'취소':'지원'}</span></button><button type="button" class="slot-edit" data-edit="${p.id}" aria-label="${esc(p.label||p.role)} 이름 고치기" title="이름 고치기"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10.6 2.9 13.1 5.4M2.5 13.5l.6-2.6 8-8 2.5 2.5-8 8z"/></svg></button></div>`}

/* 곡 한마디. 인스타 스토리처럼 한 줄만 두고 2초마다 갈아 끼운다.
   공간을 거의 안 쓰면서 곡을 넘길 때마다 다른 목소리가 보이게 하는 게 목적이다. */
function murmur(song){
 if(tickOpen)return murmurOpen(song);
 const list=comments[song.id]||[],c=list[tickIdx%list.length];
 return `<div class="murmur" data-murmur="${song.id}">${c?`<button type="button" class="mm-line" data-mm-next title="${esc(c.nickname+': '+c.body)}" aria-label="${esc(c.nickname+': '+c.body)}${list.length>1?' · 다음 한마디':''}">${avatarChip(c.nickname)}<b>${esc(c.nickname)}</b><span>${esc(c.body)}</span></button>${c.nickname===Nick.get()?`<button type="button" class="mm-delete" data-mm-del="${c.id}" aria-label="내 한마디 삭제">×</button>`:''}`:''}<button type="button" class="mm-write" data-mm-write title="한마디 쓰기" aria-label="한마디 쓰기"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10.6 2.9 13.1 5.4M2.5 13.5l.6-2.6 8-8 2.5 2.5-8 8z"/></svg></button></div>`;
}
function murmurOpen(song){return `<div class="murmur is-open" data-murmur="${song.id}"><form class="mm-form" data-mm-form="${song.id}"><input name="body" maxlength="80" aria-label="한마디 (80자)" placeholder="한마디 (80자)" autocomplete="off" required><button type="submit">남기기</button><button type="button" data-mm-close aria-label="작성 취소">×</button></form></div>`}
function showMurmur(){const box=$('.murmur'),song=songs.find(s=>s.id===selected);if(box&&song)box.outerHTML=murmur(song)}
/* 옛 줄을 위로 빼고, 새 줄을 아래에서 밀어 올린다. 두 단계로 나눠야 인스타처럼 보인다. */
/* 지금 있는 줄을 아래에서 제자리로 밀어 올린다. 두 프레임을 기다려야 전환이 걸린다. */
function popMurmur(){const l=$('.mm-line');if(!l||reducedMotion)return;
 l.classList.add('mm-in');
 requestAnimationFrame(()=>requestAnimationFrame(()=>l.classList.remove('mm-in')));}
/* 옛 줄을 위로 빼고 새 줄을 아래에서 올린다. */
function nextMurmur(){const list=comments[selected]||[];if(list.length<2)return;
 const line=$('.mm-line');
 const swap=()=>{tickIdx=(tickIdx+1)%list.length;showMurmur();popMurmur()};
 if(!line||reducedMotion){swap();return}
 line.classList.add('mm-out');setTimeout(swap,180);}
function closeMurmur(){tickOpen=false;showMurmur();tick();$('.mm-write')?.focus()}
function tick(){clearInterval(ticker);ticker=null;if(tickOpen||reducedMotion)return;
 ticker=setInterval(()=>{const box=$('.murmur');if(!box||document.hidden||tickOpen||box.matches(':hover')||box.contains(document.activeElement))return;nextMurmur()},2000);
}
/* 앞뒤 카드를 미리 받아 둔다. 캐시가 7일이라 한 번 받으면 넘길 때 바로 뜬다.
   Image 로 받으면 화면에 붙이지 않아도 브라우저 캐시에 들어간다. */
const warmed=new Set();
function preloadThumbs(id,span=4){const a=list();const i=a.findIndex(s=>s.id===id);if(i<0)return;
 for(let d=-span;d<=span;d++){const s=a[(i+d+a.length)%a.length];
  if(!s||!s.hasThumb||warmed.has(s.id))continue;
  warmed.add(s.id);const im=new Image();im.decoding='async';im.src=s.thumbUrl||`/api/songs/${s.id}/thumb`}}
async function loadComments(id){if(comments[id]!==undefined){popMurmur();tick();return}
 try{comments[id]=await api.get(`/songs/${id}/comments`)}catch{comments[id]=[]}
 if(selected!==id||tickOpen)return;
 showMurmur();popMurmur();tick();
}
/* 이름 편집. 자리 이름은 곡의 것이고, 표시 이름은 본인 지원에만 붙는다. */
/* 열려 있는 편집 폼을 걷고 칸 표시를 끈다. */
function closeSlotForm(){$('.slot-form')?.remove();document.querySelectorAll('.slot-wrap[data-editing]').forEach(w=>w.removeAttribute('data-editing'))}
function slotForm(p,me){const mine=p.supports.find(x=>x.nickname===me);return `<form class="slot-form" data-form="${p.id}"><label>자리 이름<input name="label" maxlength="20" placeholder="${esc(p.role)}" value="${esc(p.label||'')}"></label>${mine?`<label>내 표시 이름<input name="who" maxlength="20" placeholder="${esc(me)}" value="${esc(mine.label||'')}"></label>`:''}<div class="slot-form-act"><button type="submit">저장</button><button type="button" data-cancel>취소</button></div></form>`}
function upcoming(){const today=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Seoul'}).format(new Date());return events.filter(e=>e.status==='poll'?e.dates.some(d=>d.date>=today):e.date>=today).sort((a,b)=>{const date=e=>e.date||e.dates.map(d=>d.date).filter(d=>d>=today).sort()[0]||'9999';return date(a).localeCompare(date(b))})}
function eventLink(e){return `${Site.base}/schedule/?event=${e.id}`}
function rail(){const me=Nick.get(),mine=songs.filter(s=>s.sessions.some(p=>p.supports.some(a=>a.nickname===me)));return `<aside class="my-rail"><span class="overline"><span>MY ACTIVITY</span></span><h2>내 일정 · 참여</h2>${!me?'<button type="button" data-login>닉네임 입력</button>':''}${upcoming().filter(e=>e.avails.some(a=>a.nickname===me)).slice(0,3).map(e=>`<a href="${eventLink(e)}">${esc(e.title)}<small>${esc(e.date||'날짜 투표 중')}</small><b>↗</b></a>`).join('')||'<p class="muted">참여 중인 일정 없음</p>'}<a href="${Site.base}/songs/?mine=1">지원한 곡<b>${mine.length}</b></a></aside>`}
function meetings(){return `<section class="meetings"><div class="section-heading"><h2>모임 · 일정</h2><a href="${Site.base}/schedule/">전체 보기 ↗</a></div><div class="event-grid">${upcoming().slice(0,4).map(e=>`<a class="meeting" href="${eventLink(e)}">${eventSymbol(e)}<div><small>${e.status==='poll'?'날짜 투표 중':'일정 확정'} ${guildBadge(e.guild)}</small><h3>${esc(e.title)}</h3><p>${esc(e.date||dateSpan(e.dates))}${e.place?' · '+esc(e.place):''}</p></div><b>${e.status==='poll'?'날짜 투표':'일정 보기'} ↗</b></a>`).join('')||'<p class="muted">예정된 모임 없음</p>'}</div></section>`}
/* 길드 화면은 이제 자기 파일을 갖는다 — frontend/guild-home/ 을 본다.
   전에는 여기에 다음 합주·파티창·접기 상태가 함께 있었고 render() 가 if(guild) 로 갈렸다.
   메인은 다시 메인만 한다. */
/* 로딩 뼈대. 화면을 비우지 않고 자켓 자리에 판을 놓는다.
   진짜 자켓과 자리가 같아서 데이터가 와도 화면이 튀지 않는다. */
function skeleton(){const bar=n=>`<span class="sk-bar" style="width:${n}%"></span>`;return `<div class="selection-layout"><section class="selector">${controls()}<div class="carousel is-skeleton">${[0,1,2].map(i=>`<div class="track${i===0?' chosen':''}"><div class="jacket sk genre-other"><div class="jk-shot"></div><div class="jk-band"><b>&nbsp;</b><small>&nbsp;</small></div><div class="slots">${[0,1,2,3,4,5].map(()=>`<i class="slot"><em>&nbsp;</em><u>&nbsp;</u></i>`).join('')}</div></div></div>`).join('')}</div><div class="transport"><button type="button" disabled>⏮</button><button type="button" disabled>◀</button><span id="position">···</span><button type="button" disabled>▶</button><button type="button" disabled>⏭</button><button type="button" disabled>▷ 자동</button></div></section><aside class="my-rail"><span class="overline"><span>MY ACTIVITY</span></span><h2>내 일정 · 참여</h2><p class="sk-line">${bar(70)}</p><a class="sk-row" aria-hidden="true">지원한 곡<b>${bar(30)}</b></a><button type="button" disabled>내 프로필 편집</button></aside></div><section class="meetings"><div class="section-heading"><h2>모임 · 일정</h2><a href="${Site.base}/schedule/">전체 보기 ↗</a></div><div class="event-grid">${[0,1].map(()=>`<div class="meeting sk-meeting"><div><small>${bar(28)}</small><h3>${bar(62)}</h3><p>${bar(44)}</p></div></div>`).join('')}</div></section>`}
/* 조건에 맞는 곡이 없을 때. 자켓 틀은 그대로 두고 색만 뺀다.
   곡이 있을 때와 뼈대가 같아야 0건이 됐다고 화면이 통째로 바뀌지 않는다.
   스켈레톤의 반짝임은 쓰지 않는다. 그건 불러오는 중이라는 뜻이고 여기는 다 불러온 뒤다. */
function ghost(){const on=prefs.genres.length+prefs.guilds.length+(prefs.part?1:0);
 const why=prefs.query?`'${prefs.query}' 에 맞는 곡이 없습니다`:on?'이 조건에 맞는 곡이 없습니다':'아직 등록된 곡이 없습니다';
 const slots=[0,1,2,3,4,5].map(()=>'<i class="slot"><em>&nbsp;</em><u>&nbsp;</u></i>').join('');
 const side=()=>`<div class="track-wrap" aria-hidden="true"><div class="track"><div class="jacket ghost"><div class="jk-shot"></div><div class="jk-band"><b>&nbsp;</b></div><div class="slots">${slots}</div></div></div></div>`;
 return `<div class="carousel is-ghost">${side()}<div class="track-wrap"><div class="track chosen"><div class="jacket ghost"><div class="jk-shot"><span class="gh-mark" aria-hidden="true">♪</span></div><div class="jk-band"><b role="status">${esc(why)}</b></div><div class="slots" aria-hidden="true">${slots}</div></div></div></div>${side()}</div>${on||prefs.query?'<p class="no-results"><button type="button" data-clear-filters>검색 · 필터 지우기</button></p>':''}`}

function render(){stop();cleanupCarousel();$('#screen').innerHTML=`<div class="selection-layout"><section class="selector">${controls()}<div id="results"></div></section>${rail()}</div>${meetings()}`;$('#screen').removeAttribute('aria-busy');results();bindControls()}
let guildOpen=false;
/* 길드별 곡 수. 길드만 뺀 나머지 필터를 적용한 뒤에 센다 —
   고르기 전에 몇 곡이 남는지 보여 주는 숫자라야 쓸모가 있다. */
function guildCounts(){
 const base=songs.filter(s=>(!prefs.query||hit(s,prefs.query.toLowerCase()))
  &&(!prefs.genres.length||prefs.genres.includes(s.genre))
  &&(!prefs.part||s.empty.includes(prefs.part)));
 const n={'':base.length};
 base.forEach(s=>{const k=s.guild?.slug||'none';n[k]=(n[k]||0)+1});
 return n;
}
/* 운영체제가 그리는 select 는 창 모양을 못 바꾼다. 악보 화면이 쓰는 .drop 을 그대로 쓴다.
   0곡인 길드는 흐리게 둔다 — 13개 중 12개가 0곡이라 안 그러면 빈 줄만 늘어선다. */
function guildDrop(){
 const n=guildCounts(),cur=prefs.guilds[0]||'';
 const mark=g=>(g&&typeof crestFor==='function'&&crestFor(g,14))||'';
 const row=(v,label,svg)=>`<button type="button" class="menu-item${cur===v?' is-on':''}${v&&!n[v]?' is-zero':''}" data-guild="${esc(v)}">${svg}<span>${esc(label)}</span><i>${n[v]||0}</i></button>`;
 const here=cur===''?'전체':cur==='none'?SITE_NAME:(guildList.find(g=>g.slug===cur)||{}).name||cur;
 return `<div class="drop guildbox${cur?' is-set':''}${guildOpen?' is-open':''}" id="drop-guild">`
  +`<button type="button" class="drop-btn" data-guild-drop aria-expanded="${guildOpen}" aria-label="길드로 거르기">`
  +`<span>${esc(here)}</span><i>▾</i></button>`
  +`<div class="drop-menu"${guildOpen?'':' hidden'}>`
  +row('','전체','')+row('none',SITE_NAME,'')
  +guildList.map(g=>row(g.slug,g.name,mark(g))).join('')
  +`</div></div>`;
}
function controls(){const active=prefs.genres.length+prefs.guilds.length+(!!prefs.part);const genres=genreList;return `<div class="selector-head"><div><span class="overline"><span>MUSIC SELECT</span></span><h1>곡 선택<small>${songs.length?list().length:''}</small></h1></div><a class="suggest-button" href="${Site.base}/songs/?add=1">＋ 곡 등록</a></div><div class="tools"><label class="search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><input id="search" type="search" placeholder="곡명 · 아티스트 · 사람" aria-label="곡명 · 아티스트 · 사람 검색" value="${esc(prefs.query)}"></label><label class="sortbox"><select id="sort" aria-label="정렬">${[['recommend','추천'],['random','무작위'],['new','최근 등록'],['name','곡명순']].map(([v,t])=>`<option value="${v}" ${prefs.sort===v?'selected':''}>${t}</option>`).join('')}</select></label>${DIRECTED.includes(prefs.sort)?`<button type="button" id="dir" class="icon-btn" title="${prefs.dir<0?'내림차순':'오름차순'}" aria-label="정렬 방향 ${prefs.dir<0?'내림차순':'오름차순'}">${prefs.dir<0?'↓':'↑'}</button>`:''}<button type="button" id="shuffle" class="icon-btn" title="다시 섞기" aria-label="다시 섞기">↻</button></div><div class="chips" role="group" aria-label="필터" ${chipsOpen?'':'data-collapsed'}><button type="button" class="chip-toggle" data-chips aria-expanded="${chipsOpen}">필터${active?` <b>${active}</b>`:''}</button>${genres.map(g=>`<button type="button" class="chip" data-filter="genres" value="${esc(g)}" aria-pressed="${prefs.genres.includes(g)}">${esc(shortGenre(g))}</button>`).join('')}<span class="chip-gap"></span><span class="chip-label">빈 자리</span>${ORDER.filter(r=>parts.includes(r)).map(r=>`<button type="button" class="chip part" data-part="${esc(r)}" aria-pressed="${prefs.part===r}">${esc(abbr(r))}</button>`).join('')}${guildList.length?guildDrop():''}${active?'<button type="button" id="reset" class="chip clear">필터 해제 ×</button>':''}</div>`;}
/* 한 칸.
   끝과 처음을 이어 보이게 양 끝에 복제본을 붙여 봤다가 걷어냈다. 한 칸이 260px 인데
   세 장(780px)으로는 복제본을 화면 한가운데로 보낼 수가 없어서(왼쪽으로 더 스크롤할
   자리가 없다) 옮겨 앉는 순간 그만큼 화면이 튀었다. 제대로 하려면 화면 폭에서 장수를
   계산하고 스크롤 도중에 옮겨야 하는데, 드래그 기준점까지 같이 밀어야 해서 무겁다.
   지금은 ◀▶ 의 번호만 순환한다(step). */
function trackWrap(s){return `<div class="track-wrap${bumpLeft(s)>0?' is-bumped':''}" data-track="${s.id}"><button class="track ${s.id===selected?'chosen':''}" data-track="${s.id}" aria-label="${esc(s.title)}" aria-pressed="${s.id===selected}">${jacket(s)}</button>${s.youtubeUrl?`<a class="yt" href="${esc(s.youtubeUrl)}" target="_blank" rel="noreferrer noopener" aria-label="${esc(s.title)} 유튜브에서 보기" title="유튜브에서 보기"><svg viewBox="0 0 24 24" aria-hidden="true"><path class="body" d="M21.6 7.2a2.6 2.6 0 0 0-1.8-1.8C18.2 5 12 5 12 5s-6.2 0-7.8.4A2.6 2.6 0 0 0 2.4 7.2 27 27 0 0 0 2 12a27 27 0 0 0 .4 4.8 2.6 2.6 0 0 0 1.8 1.8C5.8 19 12 19 12 19s6.2 0 7.8-.4a2.6 2.6 0 0 0 1.8-1.8A27 27 0 0 0 22 12a27 27 0 0 0-.4-4.8z"/><path class="play" d="M10 15.2V8.8L15.5 12z"/></svg></a>`:''}</div>`}
function loop(a){return a.map(trackWrap).join('')}
function results(){cleanupCarousel();bumpShown=bumped()?.id||null;const a=list();const count=$('.selector-head h1 small');if(count)count.textContent=a.length;if(!a.some(s=>s.id===selected))selected=a[0]?.id;$('#results').innerHTML=a.length?`<div class="carousel" tabindex="0" aria-label="곡 선택. 좌우 방향키로 이동">${loop(a)}</div><div class="transport"><button id="first" aria-label="맨 앞으로">⏮</button><button id="prev" aria-label="이전 곡">◀</button><button type="button" id="position" title="몇 번째 곡으로 갈지 입력"></button><button id="next" aria-label="다음 곡">▶</button><button id="last" aria-label="맨 뒤로">⏭</button><button id="auto" aria-pressed="${auto}">${auto?'Ⅱ 정지':'▷ 자동'}</button>${bumpCtl(selected)}<a id="song-link" href="${Site.base}/songs/">곡 정보 ↗</a><a href="${Site.base}/songs/">목록 ↗</a></div><div id="selected-detail"></div>`:ghost();if(a.length){choose(selected,false);bindCarousel();}persist();}
function choose(id,smooth=true){if(!$('#selected-detail')||!songs.some(s=>s.id===id)||!list().some(s=>s.id===id))return;selected=id;const s=songs.find(s=>s.id===id);document.querySelectorAll('.track').forEach(b=>{b.classList.toggle('chosen',+b.dataset.track===id);b.setAttribute('aria-pressed',+b.dataset.track===id)});center($(`[data-track="${id}"]`),smooth);tickOpen=false;tickIdx=0;clearInterval(ticker);ticker=null;$('#selected-detail').innerHTML=detail(s);$('#position').textContent=`${list().findIndex(s=>s.id===id)+1} / ${list().length}`;markEdges();const sl=$('#song-link');if(sl)sl.href=`${Site.base}/songs/?song=${id}`;const bb=$('#bump-btn');if(bb)bb.outerHTML=bumpCtl(id);preloadThumbs(id);loadComments(id);persist();}
/* 칸 하나를 캐러셀 한가운데로. choose 와 step 이 같이 쓴다. */
function center(el,smooth=true){const c=$('.carousel');if(!el||!c)return;const er=el.getBoundingClientRect(),cr=c.getBoundingClientRect();c.scrollTo({left:c.scrollLeft+(er.left+er.width/2)-(cr.left+cr.width/2),behavior:smooth&&!reducedMotion?'smooth':'instant'})}
function stop(){auto=false;clearInterval(timer);if($('#auto')){$('#auto').textContent='▷ 자동';$('#auto').setAttribute('aria-pressed','false')}}
function step(n){const a=list(),i=a.findIndex(s=>s.id===selected);choose(a[(i+n+a.length)%a.length].id)}
/* 맨 앞·맨 뒤. 207곳을 훑으면 오래 걸리므로 곧바로 앉힌다. */
function edge(end){const a=list();if(!a.length)return;choose(a[end?a.length-1:0].id,false)}
/* 이미 끝이면 그 버튼을 흐린다. 눌러도 아무 일이 없는 버튼은 눌러야 할 것처럼 보이면 안 된다. */
function markEdges(){const a=list(),i=a.findIndex(s=>s.id===selected),f=$('#first'),l=$('#last');
 if(f)f.disabled=i<=0;if(l)l.disabled=i<0||i>=a.length-1}
let wheelAt=0,wheelAcc=0;
function bindCarousel(){const c=$('.carousel');let x,start,last,t,velocity=0,moved=false,raf,settle;cleanupCarousel=()=>{cancelAnimationFrame(raf);clearTimeout(settle);drag=false;c.onpointerdown=null;c.onpointermove=null;c.onpointerup=null;c.onpointercancel=null;c.onwheel=null;};function nearest(){const cr=c.getBoundingClientRect(),center=cr.left+cr.width/2,dist=el=>{const r=el.getBoundingClientRect();return Math.abs(r.left+r.width/2-center)};return [...c.children].reduce((a,b)=>dist(b)<dist(a)?b:a)}/* 손가락·펜은 브라우저에게 맡긴다. 스크롤 스냅이 이미 걸려 있어서 기기 고유의 관성과
   스냅이 그대로 나온다 — JS 로 흉내 낸 관성보다 낫고, 둘이 겹쳐 턱턱 걸리던 것도 없어진다.
   마우스만 여기서 직접 끈다(가로 휠이 없는 마우스가 많다). */
c.onpointerdown=e=>{if(e.button!==0||e.pointerType!=='mouse')return;stop();cancelAnimationFrame(raf);drag=true;moved=false;x=e.clientX;start=c.scrollLeft;last=x;t=performance.now();velocity=0;c.style.scrollSnapType='none'};c.onpointermove=e=>{if(!drag)return;const now=performance.now();if(Math.abs(e.clientX-x)>5){moved=true;c.setPointerCapture(e.pointerId)}velocity=(last-e.clientX)/Math.max(1,now-t);last=e.clientX;t=now;c.scrollLeft=start+x-e.clientX};function finish(){if(!drag)return;drag=false;if(!moved){c.style.scrollSnapType='x mandatory';return}let v=Math.max(-45,Math.min(45,velocity*16));function glide(){c.scrollLeft+=v;v*=.93;if(!reducedMotion&&Math.abs(v)>.6)raf=requestAnimationFrame(glide);else{c.style.scrollSnapType='x mandatory';choose(+nearest().dataset.track)}}raf=requestAnimationFrame(glide)}c.onpointerup=finish;c.onpointercancel=()=>{drag=false;cancelAnimationFrame(raf);c.style.scrollSnapType='x mandatory';choose(+nearest().dataset.track)};c.addEventListener('click',e=>{if(moved){e.preventDefault();e.stopPropagation();moved=false}},true);
 c.addEventListener('dragstart',e=>e.preventDefault());c.addEventListener('scrollend',()=>{if(c.isConnected&&!drag){const id=+nearest().dataset.track;if(id!==selected)choose(id,false);}});/* 자켓 위에서는 휠이 페이지가 아니라 곡을 넘긴다. 홈은 곡을 넘기는 화면이고
   캐러셀 아래위로 스크롤할 자리가 충분하다. 가로 휠이 있는 마우스는 가로 값을 쓴다.

   살짝 굴리면 한 곡, 드르륵 굴리면 여러 곡이다. 시간이 아니라 '굴린 양' 으로 가른다 —
   오래 굴릴수록 빨라지게 해 봤더니 살짝 굴려도 붙잡고 있으면 주르륵 넘어갔다.
   굴린 양을 모아 두고 한 칸(120)을 채울 때마다 한 곡씩 넘긴다. 나머지는 다음 이벤트로
   넘겨서 잔돈이 사라지지 않게 한다. 0.4초 쉬면 모아 둔 것을 버린다.

   휠 단위는 기기마다 다르다(픽셀·줄·페이지). 줄·페이지면 픽셀로 환산해 같은 기준으로 센다.
   한 번에 여덟 곡까지만 넘긴다 — 세게 굴렸다고 백 곡을 건너뛰면 어디였는지 잃는다. */
 const WHEEL_NOTCH=120,WHEEL_CAP=8;
 c.onwheel=e=>{
  if(!list().length)return;
  const unit=e.deltaMode===1?33:e.deltaMode===2?300:1;
  const d=(Math.abs(e.deltaX)>Math.abs(e.deltaY)?e.deltaX:e.deltaY)*unit;
  if(!d)return;
  e.preventDefault();stop();
  const now=performance.now();
  if(now-wheelAt>400)wheelAcc=0;
  wheelAt=now;wheelAcc+=d;
  let n=Math.trunc(wheelAcc/WHEEL_NOTCH);
  if(!n)return;
  wheelAcc-=n*WHEEL_NOTCH;
  step(Math.max(-WHEEL_CAP,Math.min(WHEEL_CAP,n)));
 };$('#prev').onclick=()=>{stop();step(-1)};$('#next').onclick=()=>{stop();step(1)};$('#first').onclick=()=>{stop();edge(0)};$('#last').onclick=()=>{stop();edge(1)};$('#auto').onclick=()=>{if(auto)return stop();auto=true;$('#auto').textContent='Ⅱ 정지';$('#auto').setAttribute('aria-pressed','true');timer=setInterval(()=>{if(!document.hidden&&!c.matches(':hover')&&!c.contains(document.activeElement))step(1)},2000)};}

function bindControls(){
 /* 기준이 달라졌으면 처음부터 본다. 전에는 보던 곡에 그대로 머물러서,
    최신순으로 바꿔도 목록 한복판에 떨어졌다 — 순서가 뒤집힌 것처럼 보였다. */
 function toTop(){const a=list();if(a.length)selected=a[0].id}
 function update(){stop();toTop();persist();results()}function rerender(){stop();toTop();persist();render()}$('#search').oninput=e=>{prefs.query=e.target.value.trim();update()};/* 정렬을 바꾸면 도구 줄까지 다시 그린다 — 방향 버튼이 있고 없고가 정렬에 따라 갈린다. */
 $('#sort').onchange=e=>{prefs.sort=e.target.value;rerender()};$('#shuffle').onclick=()=>{mix();update()};$('#dir')&&($('#dir').onclick=()=>{prefs.dir=prefs.dir<0?1:-1;rerender()});$('#reset')&&($('#reset').onclick=()=>{prefs={...prefs,genres:[],guilds:[],part:''};rerender()});document.querySelectorAll('.chip[data-filter]').forEach(el=>el.onclick=()=>{const k=el.dataset.filter,v=el.value;prefs[k]=prefs[k].includes(v)?prefs[k].filter(x=>x!==v):[...prefs[k],v];rerender()});document.querySelectorAll('.chip[data-part]').forEach(el=>el.onclick=()=>{prefs.part=prefs.part===el.dataset.part?'':el.dataset.part;rerender()});const dg=$('#drop-guild');
 if(dg){
  dg.querySelector('[data-guild-drop]').onclick=()=>{guildOpen=!guildOpen;render()};
  dg.querySelectorAll('[data-guild]').forEach(el=>el.onclick=()=>{
   const v=el.dataset.guild;prefs.guilds=v?[v]:[];guildOpen=false;rerender();});
 }}
async function refresh(){const v=++version;try{const requests=await Promise.allSettled([api.get(Site.q('/songs')),api.get(Site.q('/events')),api.get('/guilds')]);if(v!==version)return;const failure=requests.find(r=>r.status==='rejected');if(failure)throw failure.reason;const [raw,ev,gs]=requests.map(r=>r.value);songs=raw.map(s=>({...s,genre:genre(s),age:s.createdBy==='시트 가져오기'?null:Math.max(0,(Date.now()-new Date(s.createdAt))/86400000),empty:s.sessions.filter(p=>!p.supports.length).map(p=>p.role)}));events=ev;guilds=gs;Rosters.put(gs);guild=Site.slug?guilds.find(g=>g.slug===Site.slug):null;if(Site.slug&&!guild)throw Error('길드를 찾을 수 없습니다.');parts=[...new Set(songs.flatMap(s=>s.sessions.map(p=>p.role)))];genreList=[...new Set(songs.map(s=>s.genre))].sort((a,b)=>songs.filter(s=>s.genre===b).length-songs.filter(s=>s.genre===a).length);guildList=guilds.map(g=>({slug:g.slug,name:g.name,style:g.style,color:g.color}));try{localStorage.setItem(LISTS,JSON.stringify({genres:genreList,guilds:guildList}))}catch{}if(!Object.keys(scores).length){const returning=performance.getEntriesByType('navigation')[0]?.type==='back_forward'||document.referrer.startsWith(location.origin+'/');if(returning&&saved.scores&&songs.every(s=>s.id in saved.scores)){scores=saved.scores;randomScores=saved.randomScores||{};reasons=saved.reasons||{}}else mix()}else if(songs.some(s=>!(s.id in scores)))mix();const nb=bumped();if(nb&&nb.bumpedAt!==seenBump){selected=nb.id;seenBump=nb.bumpedAt}$('#home-error').hidden=true;render()}catch(e){$('#home-error').textContent='불러오기 실패: '+e.message;$('#home-error').hidden=false;$('#screen').removeAttribute('aria-busy');if(!songs.length)$('#screen').innerHTML=skeleton().replace('불러오는 중','불러오지 못했습니다')+'<p class="retry-line"><button type="button" data-retry>다시 불러오기</button></p>'}}
/* 지원 칸을 바꾼 곡 하나를 다시 그린다. 저장이 다 끝나면(writes-idle) 건드린 곡만 서버에서 다시 받아 맞춘다 —
   실패했으면 그때 서버의 실제 상태로 돌아간다. 목록 전체를 다시 받지 않는다. */
const touched=new Set();
function paintSong(song){song.empty=song.sessions.filter(p=>!p.supports.length).map(p=>p.role);if(selected===song.id)$('#selected-detail').innerHTML=detail(song);const tr=$(`button[data-track="${song.id}"]`);if(tr)tr.innerHTML=jacket(song);$('.my-rail').outerHTML=rail()}
document.addEventListener('writes-idle',async()=>{const ids=[...touched];touched.clear();for(const id of ids){const song=songs.find(s=>s.id===id);if(!song)continue;const seq=Writes.seq;try{const fresh=await api.get(`/songs/${id}`);if(Writes.stale(seq)){touched.add(id);continue}song.sessions=fresh.sessions;paintSong(song)}catch{}}});
$('#screen').addEventListener('click',async e=>{const b=e.target.closest('button');if(!b)return;if(b.dataset.track){stop();choose(+b.dataset.track);return}if(b.id==='auto'||b.id==='prev'||b.id==='next'||b.id==='first'||b.id==='last'||b.id==='shuffle'||b.id==='dir'||b.id==='reset'||b.classList.contains('chip')||b.classList.contains('menu-item')||b.hasAttribute('data-guild-drop'))return;if(b.hasAttribute('data-mm-next')){nextMurmur();$('.mm-line')?.focus();tick();return}if(b.hasAttribute('data-mm-write')){stop();const id=selected;const me=await Nick.ensure();if(!me||selected!==id)return;tickOpen=true;clearInterval(ticker);ticker=null;showMurmur();$('.mm-form input')?.focus();return}if(b.hasAttribute('data-mm-close')){closeMurmur();return}if(b.dataset.mmDel){const id=selected,commentId=+b.dataset.mmDel;b.disabled=true;try{await api.del(`/songs/${id}/comments/${commentId}?nickname=${encodeURIComponent(Nick.get())}`);comments[id]=(comments[id]||[]).filter(c=>c.id!==commentId);if(selected===id&&!tickOpen){showMurmur();tick()}}catch(err){$('#home-error').textContent=err.message;$('#home-error').hidden=false;b.disabled=false}return}if(b.hasAttribute('data-chips')){chipsOpen=!chipsOpen;const c=$('.chips');c.toggleAttribute('data-collapsed',!chipsOpen);b.setAttribute('aria-expanded',chipsOpen);return}if(b.dataset.edit){const p=songs.flatMap(x=>x.sessions).find(x=>x.id===+b.dataset.edit);closeSlotForm();b.closest('.slot-wrap').dataset.editing='1';$('.now-slots').insertAdjacentHTML('afterend',slotForm(p,Nick.get()));$('.slot-form input')?.focus();return}if(b.hasAttribute('data-cancel')){closeSlotForm();$(`[data-edit="${b.closest('.slot-form').dataset.form}"]`)?.focus();return}if(b.hasAttribute('data-clear-filters')){stop();prefs={...prefs,query:'',genres:[],guilds:[],part:''};render();return}if(b.hasAttribute('data-retry')){refresh();return}if(b.hasAttribute('data-login')){await Nick.ensure();return}if(b.hasAttribute('data-profile')){const me=await Nick.ensure();if(me){await openProfileEditor(me);render()}return}/* 지원·취소는 누르는 즉시 칸을 바꾸고 서버에 보낸다(common.js Writes). 기다리지 않으므로 busy 로 막지 않는다. */
if(b.dataset.support){const me=await Nick.ensure();if(!me)return;stop();const session=songs.flatMap(s=>s.sessions).find(p=>p.id===+b.dataset.support);const song=songs.find(s=>s.sessions.some(p=>p.id===session.id));const on=!session.supports.some(a=>a.nickname===me);session.supports=session.supports.filter(a=>a.nickname!==me);if(on)session.supports.push({id:null,sessionId:session.id,nickname:me,label:null});paintSong(song);$(`[data-support="${session.id}"]`)?.focus();touched.add(song.id);Writes.run(`sup:${session.id}:${me}`,()=>on?api.post(`/sessions/${session.id}/support`,{nickname:me}):api.del(`/sessions/${session.id}/support?nickname=${encodeURIComponent(me)}`)).catch(err=>{$('#home-error').textContent=err.message;$('#home-error').hidden=false})}
});
$('#screen').addEventListener('submit',async e=>{const mf=e.target.closest('.mm-form');if(mf){e.preventDefault();if(mf.dataset.saving)return;const id=+mf.dataset.mmForm,text=mf.elements.namedItem('body').value.trim(),me=Nick.get();if(!text||!me)return;mf.dataset.saving='1';mf.querySelectorAll('input,button').forEach(el=>el.disabled=true);try{const c=await api.post(`/songs/${id}/comments`,{nickname:me,body:text});(comments[id]??=[]).push(c);if(selected===id&&mf.isConnected){tickIdx=comments[id].length-1;closeMurmur()}}catch(err){$('#home-error').textContent=err.message;$('#home-error').hidden=false;delete mf.dataset.saving;mf.querySelectorAll('input,button').forEach(el=>el.disabled=false)}return}const f=e.target.closest('.slot-form');if(!f)return;e.preventDefault();
const id=+f.dataset.form,song=songs.find(x=>x.sessions.some(y=>y.id===id)),p=song.sessions.find(y=>y.id===id),me=Nick.get();
const label=f.label.value.trim(),who=f.who?f.who.value.trim():null;const btn=f.querySelector('[type=submit]');btn.disabled=true;
try{if((p.label||'')!==label)await api.put(`/sessions/${id}`,{label});
const mine=p.supports.find(x=>x.nickname===me);if(mine&&mine.id&&who!==null&&(mine.label||'')!==who)await api.put(`/sessions/${id}/support/${mine.id}`,{label:who});
const fresh=await api.get(`/songs/${song.id}`);Object.assign(song,{sessions:fresh.sessions,empty:fresh.sessions.filter(x=>!x.supports.length).map(x=>x.role)});
$('#selected-detail').innerHTML=detail(song);const tr=$(`[data-track="${song.id}"]`);if(tr)tr.innerHTML=jacket(song);
$(`[data-edit="${id}"]`)?.focus()}catch(err){$('#home-error').textContent=err.message;$('#home-error').hidden=false;btn.disabled=false}});
$('#screen').addEventListener('keydown',e=>{if(e.key==='Escape'&&e.target.closest('.mm-form')&&!e.target.closest('.mm-form').dataset.saving){e.preventDefault();closeMurmur()}});
/* 방향키는 문서 전체에서 받는다. 캐러셀을 한 번 눌러야 먹던 것을 없앤다.
   글자를 치는 중이면 넘긴다. 커서를 좌우로 옮기는 동작을 뺏으면 안 된다. */
document.addEventListener('keydown',e=>{
 const keys=['ArrowLeft','ArrowRight','Home','End'];
 if(!keys.includes(e.key))return;
 if(e.metaKey||e.ctrlKey||e.altKey)return;
 const el=document.activeElement;
 if(el&&(el.matches('input,textarea,select')||el.isContentEditable))return;
 if(!$('.carousel')||!list().length)return;
 e.preventDefault();stop();
 if(e.key==='Home')edge(0);else if(e.key==='End')edge(1);else step(e.key==='ArrowLeft'?-1:1);
});
document.addEventListener('nickchange',()=>{if(songs.length)render()});
window.addEventListener('pageshow',e=>{if(e.persisted)refresh()});
window.addEventListener('pagehide',()=>{persist();stop();cleanupCarousel();clearInterval(ticker);ticker=null});
/* ---------- 끌올 누르기 ----------
   켜고 끄는 동작이라 누르는 즉시 1번으로 올린다(Writes.run). 서버가 거절하면(다른 곡이 먼저 잡았다 등) 되돌린다. */
function bumpFail(err){$('#home-error').textContent=err.message;$('#home-error').hidden=false}
/* 한마디. 브라우저 기본 입력창 대신 사이트 창으로 받는다. 취소면 null, 비우면 ''. */
function askBumpNote(){return new Promise(resolve=>{const bd=document.createElement('div');bd.className='modal-backdrop';
 bd.innerHTML=`<div class="modal" role="dialog" aria-modal="true" aria-labelledby="bump-title"><h3 class="modal-title" id="bump-title">${icon('up')} 끌올</h3><p class="modal-desc">30분 동안 모든 목록의 맨 앞에 섭니다.</p><form class="modal-form"><input name="note" maxlength="60" placeholder="한마디 (선택)" autocomplete="off"><button type="submit" class="pink">끌올</button><button type="button" class="ghost" data-cancel>취소</button></form></div>`;
 const close=v=>{bd.remove();resolve(v)};
 bd.addEventListener('click',e=>{if(e.target===bd||e.target.closest('[data-cancel]'))close(null)});
 bd.addEventListener('keydown',e=>{if(e.key==='Escape')close(null)});
 bd.querySelector('form').addEventListener('submit',e=>{e.preventDefault();close(e.target.elements.note.value.trim())});
 document.body.appendChild(bd);setTimeout(()=>bd.querySelector('input').focus(),0)})}
async function onBump(btn){const id=selected,s=songs.find(x=>x.id===id);if(!s||btn.disabled)return;
 const me=await Nick.ensure();if(!me||selected!==id)return;stop();
 const prev={bumpedBy:s.bumpedBy,bumpedAt:s.bumpedAt,bumpNote:s.bumpNote};
 const undo=err=>{Object.assign(s,prev);results();bumpFail(err)};
 if(btn.hasAttribute('data-unbump')){s.bumpedAt=null;s.bumpNote=null;results();
  Writes.run('bump',()=>api.del(`/songs/${id}/bump?nickname=${encodeURIComponent(me)}`)).catch(undo);return}
 if(bumped())return;
 const note=await askBumpNote();if(note===null)return;
 Object.assign(s,{bumpedBy:me,bumpedAt:new Date().toISOString(),bumpNote:note||null});seenBump=s.bumpedAt;selected=id;results();
 /* 시각은 서버 것으로 맞춘다. 기기 시계가 틀려도 남은 시간이 서버와 같게. */
 Writes.run('bump',()=>api.post(`/songs/${id}/bump`,{nickname:me,note})).then(r=>{if(r&&r.bumpedAt){s.bumpedAt=r.bumpedAt;seenBump=r.bumpedAt;persist()}}).catch(undo)}
$('#screen').addEventListener('click',e=>{const b=e.target.closest('#bump-btn');if(b)onBump(b)});
/* 위치 숫자(3 / 246)를 누르면 번호를 넣어 그 곡으로 곧바로 간다. 240곡을 ◀▶ 로 넘길 수는 없다.
   Enter·다른 곳 누르기면 가고, Esc 면 그대로. 멀리 뛰므로 스크롤 애니메이션 없이 앉힌다(edge 와 같은 이유). */
function askPosition(btn){const a=list();if(!a.length||$('#position-input'))return;stop();
 /* 글자 칸 + 숫자 자판. number 칸이면 브라우저가 위아래 화살표를 붙여 사이트 모양과 어긋난다. */
 const inp=document.createElement('input');inp.type='text';inp.id='position-input';inp.inputMode='numeric';inp.autocomplete='off';
 inp.value=a.findIndex(s=>s.id===selected)+1;inp.setAttribute('aria-label',`몇 번째 곡 (1~${a.length})`);
 btn.hidden=true;btn.after(inp);inp.select();
 const done=go=>{if(!inp.isConnected)return;const n=Number(inp.value.replace(/\D/g,''));inp.remove();btn.hidden=false;
  if(go&&n>=1&&n<=a.length&&list()[n-1])choose(list()[n-1].id,false);btn.focus()};
 inp.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();done(true)}else if(e.key==='Escape'){e.preventDefault();done(false)}});
 inp.addEventListener('blur',()=>done(true))}
$('#screen').addEventListener('click',e=>{const b=e.target.closest('#position');if(b)askPosition(b)});
/* 남은 시간은 분 단위라 30초마다 글자만 고친다. 끝나면 목록을 다시 세운다(끌올 곡이 제자리로 돌아간다). */
setInterval(()=>{if(document.hidden||!songs.length)return;const b=bumped();
 if((b?.id||null)!==bumpShown){if($('.carousel'))results();else bumpShown=b?.id||null;return}
 if(!b)return;document.querySelectorAll(`.track-wrap[data-track="${b.id}"] .jk-bump`).forEach(el=>el.outerHTML=jkBump(b));
 const bb=$('#bump-btn');if(bb)bb.outerHTML=bumpCtl(selected)},30000);
mountChrome('home');$('#screen').innerHTML=skeleton();$('#screen').querySelectorAll('.tools input,.tools select,.tools button,.chips button,.chips select,.suggest-button').forEach(el=>{el.disabled=true;el.setAttribute('aria-disabled','true')});refresh();
})();

/* 길드 고르기 창은 바깥을 누르거나 Esc 로 닫는다. */
document.addEventListener('click',e=>{if(guildOpen&&!e.target.closest('#drop-guild')){guildOpen=false;render()}});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&guildOpen){guildOpen=false;render()}});
