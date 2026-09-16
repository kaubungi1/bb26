/* 둥글게 잘라 올리기.
   파일을 받아 256px 정사각에 원으로 오려 낸 PNG blob 을 돌려준다. 모서리는 투명하다.
   취소하면 null 을 돌려준다. 그때는 부르는 쪽에서 아무것도 바꾸지 않는다.
   서버는 정사각이 들어오면 손대지 않고, WEBP 가 알파를 그대로 저장한다. */

const CROP_OUT = 256;    /* 서버가 저장하는 크기(IMAGE_SIDE)와 같게 맞춘다 */
const CROP_STAGE = 260;  /* 화면에서 고르는 무대. 원 지름도 이만큼이다 */
const CROP_MAX_ZOOM = 4;

/* shape: 'circle'(기본) 또는 'hex'. 프로필 사진은 원, 길드 문장은 육각이다.
   자르는 방식은 같고 오려 내는 틀만 다르다. 무엇이 잘릴지 화면에서 그대로 보여 준다. */
function openCropper(file, shape = 'circle') {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onerror = () => {
      URL.revokeObjectURL(url);
      alert('이미지를 읽지 못했습니다.');
      resolve(null);
    };
    img.onload = () => cropStage(img, url, resolve, shape);
    img.src = url;
  });
}

/* 육각 틀. crest.js 의 CREST_HEX 와 같은 비율이다(100 기준 좌표를 비율로 옮긴 값). */
const CROP_HEX = [[0.5, 0.02], [0.94, 0.26], [0.94, 0.74], [0.5, 0.98], [0.06, 0.74], [0.06, 0.26]];

function cropStage(img, url, resolve, shape = 'circle') {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal crop-modal" role="dialog" aria-modal="true" aria-labelledby="crop-title">
      <h3 class="modal-title" id="crop-title">${shape === 'hex' ? '육각으로 자르기' : '둥글게 자르기'}</h3>
      <p class="crop-help">끌어서 옮기고, 아래 막대나 휠로 크기를 맞춥니다.</p>
      <div class="crop-stage${shape === 'hex' ? ' is-hex' : ''}">
        <canvas class="crop-canvas" width="${CROP_STAGE}" height="${CROP_STAGE}"></canvas>
        <div class="crop-hole" aria-hidden="true"></div>
      </div>
      <input class="crop-zoom" type="range" min="100" max="${CROP_MAX_ZOOM * 100}" value="100" step="1" aria-label="크기" />
      <div class="crop-actions">
        <button type="button" class="pink" data-ok>이 모양으로</button>
        <button type="button" class="ghost" data-cancel>취소</button>
      </div>
    </div>`;

  const canvas = backdrop.querySelector('.crop-canvas');
  const ctx = canvas.getContext('2d');
  const zoomBar = backdrop.querySelector('.crop-zoom');

  /* 원을 항상 사진이 덮도록, 짧은 변이 무대에 딱 맞는 배율을 1배로 삼는다. */
  const base = CROP_STAGE / Math.min(img.naturalWidth, img.naturalHeight);
  let zoom = 1;
  let tx = 0;
  let ty = 0;

  const drawn = () => ({ w: img.naturalWidth * base * zoom, h: img.naturalHeight * base * zoom });
  /* 사진 바깥이 원 안으로 들어오지 못하게 이동 범위를 막는다. 빈틈이 생기지 않는다. */
  const clamp = () => {
    const { w, h } = drawn();
    tx = Math.min(0, Math.max(CROP_STAGE - w, tx));
    ty = Math.min(0, Math.max(CROP_STAGE - h, ty));
  };
  const paint = () => {
    const { w, h } = drawn();
    ctx.clearRect(0, 0, CROP_STAGE, CROP_STAGE);
    ctx.drawImage(img, tx, ty, w, h);
  };

  tx = (CROP_STAGE - drawn().w) / 2;
  ty = (CROP_STAGE - drawn().h) / 2;
  clamp();
  paint();

  /* 확대해도 무대 한가운데가 그대로 가운데 남도록 한다. 화면이 튀지 않는다. */
  const setZoom = (next) => {
    const z = Math.min(CROP_MAX_ZOOM, Math.max(1, next));
    if (z === zoom) return;
    const mid = CROP_STAGE / 2;
    const px = (mid - tx) / zoom;
    const py = (mid - ty) / zoom;
    zoom = z;
    tx = mid - px * zoom;
    ty = mid - py * zoom;
    clamp();
    paint();
    zoomBar.value = Math.round(zoom * 100);
  };

  zoomBar.addEventListener('input', () => setZoom(Number(zoomBar.value) / 100));

  const stage = backdrop.querySelector('.crop-stage');
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  stage.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    dragging = true; lastX = e.clientX; lastY = e.clientY;
    stage.setPointerCapture(e.pointerId);
  });
  stage.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    tx += e.clientX - lastX;
    ty += e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    clamp(); paint();
  });
  const endDrag = () => { dragging = false; };
  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', endDrag);
  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    setZoom(zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12));
  }, { passive: false });

  let done = false;
  const finish = (value) => {
    if (done) return;
    done = true;
    URL.revokeObjectURL(url);
    backdrop.remove();
    resolve(value);
  };

  backdrop.addEventListener('keydown', (e) => { if (e.key === 'Escape') finish(null); });
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) finish(null); });
  backdrop.querySelector('[data-cancel]').addEventListener('click', () => finish(null));
  backdrop.querySelector('[data-ok]').addEventListener('click', () => {
    const out = document.createElement('canvas');
    out.width = CROP_OUT; out.height = CROP_OUT;
    const octx = out.getContext('2d');
    const r = CROP_OUT / CROP_STAGE;
    octx.beginPath();
    if (shape === 'hex') {
      CROP_HEX.forEach(([x, y], i) => {
        const px = x * CROP_OUT, py = y * CROP_OUT;
        if (i) octx.lineTo(px, py); else octx.moveTo(px, py);
      });
      octx.closePath();
    } else {
      octx.arc(CROP_OUT / 2, CROP_OUT / 2, CROP_OUT / 2, 0, Math.PI * 2);
    }
    octx.clip();
    const { w, h } = drawn();
    octx.drawImage(img, tx * r, ty * r, w * r, h * r);
    /* PNG 로 뽑는다. 모서리 투명을 살려야 둥근 모양이 서버까지 간다. */
    out.toBlob((blob) => {
      if (!blob) { alert('자르지 못했습니다.'); finish(null); return; }
      finish(blob);
    }, 'image/png');
  });

  document.body.appendChild(backdrop);
  backdrop.querySelector('[data-ok]').focus();
}
