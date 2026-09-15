/* 두 아이패드 페어링 클라이언트.
   WebSocket 으로 {sheetId, spread} 하나를 공유한다.
   역할: main(1번 · 홀수쪽) / sub(2번 · 짝수쪽).
   localStorage 에 남으므로 페이지를 나갔다 와도, 다른 악보를 열어도 유효하다. */

const KEY = 'sheetPair';

let pair = null;        /* {code, role} */
let ws = null;
let wantOpen = false;   /* 끊겼을 때 다시 붙을지 */
let retryTimer = null;
let pingTimer = null;
let handlers = {};      /* {onState, onPeers, onLink, onGone} */
let pendingState = null;   /* 끊긴 동안 못 보낸 마지막 조작 — 재접속하면 바로 보낸다 */
let skipNextState = false; /* 보류분을 보낸 직후 서버가 주는 낡은 저장 상태는 1회 무시 */

function loadSaved() {
  try { pair = JSON.parse(localStorage.getItem(KEY)); } catch (e) { pair = null; }
  if (pair && (!pair.code || !pair.role)) pair = null;
}
function save() {
  if (pair) localStorage.setItem(KEY, JSON.stringify(pair));
  else localStorage.removeItem(KEY);
}

export function active() { return !!pair; }
export function isSub() { return !!pair && pair.role === 'sub'; }
export function code() { return pair ? pair.code : null; }

export function init(h) {
  handlers = h || {};
  /* QR 로 들어온 2번 아이패드: ?pair=CODE. 주소는 바로 지워 새로고침에도 안전하게. */
  const url = new URL(location.href);
  const fromQr = url.searchParams.get('pair');
  if (fromQr) {
    pair = { code: fromQr.trim().toUpperCase(), role: 'sub' };
    save();
    url.searchParams.delete('pair');
    history.replaceState(null, '', url.pathname + (url.search || ''));
  } else {
    loadSaved();
  }
  if (pair) connect();
}

export async function create() {
  const res = await api.post('/pairs', {});
  pair = { code: res.code, role: 'main' };
  save();
  connect();
  return pair.code;
}

/* 해제는 양쪽 모두에 적용된다. 연결이 살아 있으면 그 길로 알려 상대도 즉시 풀리게 하고,
   끊긴 상태라면 페어 기록만 지워 상대가 다음 접속 때 알게 한다.
   @returns {string|null} 해제 직전의 역할 ('main' | 'sub') */
export function stop() {
  if (!pair) return null;
  const { code: c, role } = pair;
  const sock = ws;
  pair = null;
  save();
  wantOpen = false;
  pendingState = null;
  skipNextState = false;
  ws = null;
  clearTimeout(retryTimer);
  clearInterval(pingTimer);
  if (sock && sock.readyState === WebSocket.OPEN) {
    try { sock.send(JSON.stringify({ type: 'unpair' })); } catch (e) { /* 무시 */ }
    /* 서버가 알림을 돌리고 닫을 시간을 준다. 안 닫히면 이쪽에서 닫는다. */
    setTimeout(() => { try { sock.close(); } catch (e) { /* 무시 */ } }, 300);
  } else {
    if (sock) { try { sock.close(); } catch (e) { /* 무시 */ } }
    api.del('/pairs/' + c).catch(() => {});
  }
  if (handlers.onLink) handlers.onLink(false);
  return role;
}

/* state: {sheetId, spread, title, pages} — sheetId 가 null 이면 "악보 닫음".
   끊긴 상태라면 조용히 버리지 않고 기억해 뒀다가 재접속하자마자 보낸다.
   (버리면: 끊긴 사이 악보를 닫아도 서버엔 "열려 있음"이 남아, 재접속 때
    그 낡은 상태를 받아 닫았던 악보가 되살아난다) */
export function send(state) {
  pendingState = state;
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'state', ...state }));
    pendingState = null;
  }
}

/* 상대가 끊었을 때 — 내 쪽 흔적을 지우고 재접속을 멈춘다. 역할을 함께 넘겨
   보조 기기는 페어 전용 화면에서 빠져나올 수 있게 한다. */
function gone() {
  const role = pair ? pair.role : null;
  pair = null;
  save();
  wantOpen = false;
  pendingState = null;
  clearTimeout(retryTimer);
  clearInterval(pingTimer);
  if (ws) { try { ws.close(); } catch (e) { /* 무시 */ } ws = null; }
  if (handlers.onGone) handlers.onGone(role);
}

function connect() {
  if (!pair) return;
  wantOpen = true;
  clearTimeout(retryTimer);
  const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
  ws = new WebSocket(proto + location.host + '/ws/pair/' + pair.code);
  ws.onopen = () => {
    if (handlers.onLink) handlers.onLink(true);
    if (pendingState) {
      /* 끊긴 동안의 내 조작이 진실이다. 서버가 곧 보낼 낡은 저장 상태보다 우선한다. */
      ws.send(JSON.stringify({ type: 'state', ...pendingState }));
      pendingState = null;
      skipNextState = true;
    }
    /* 중간 장비가 놀고 있는 연결을 끊지 않게 주기적으로 인사한다 */
    clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
    }, 25000);
  };
  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch (err) { return; }
    if (msg.type === 'state') {
      /* 접속 직후 서버가 주는 저장 상태 — 방금 내 보류분을 보냈다면 그게 더 새것이다 */
      if (skipNextState) { skipNextState = false; return; }
      if (handlers.onState) handlers.onState(msg);
    } else if (msg.type === 'closed') {
      gone();                       /* 상대가 페어를 해제했다 */
    } else if (msg.type === 'peers' && handlers.onPeers) handlers.onPeers(msg.count);
  };
  ws.onclose = (e) => {
    clearInterval(pingTimer);
    if (handlers.onLink) handlers.onLink(false);
    if (e.code === 4404) { gone(); return; }   /* 서버에 없는 페어 — 이미 해제됐다 */
    if (wantOpen) retryTimer = setTimeout(connect, 2000);
  };
  ws.onerror = () => { try { ws.close(); } catch (err) { /* 무시 */ } };
}
