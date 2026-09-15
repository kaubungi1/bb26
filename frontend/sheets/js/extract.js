/* 악보 PDF 1페이지에서 제목·아티스트·BPM 뽑아내기.

   실제 악보 42개(MuseScore 41 + Guitar Pro 1)를 뜯어보고 만든 규칙이다.
     - 헤더의 글자 크기가 일정하다: 제목 22pt · 아티스트 10pt · 템포 12pt · 리허설 마크 8pt
       (Guitar Pro 는 29/11pt 로 값만 다르고 대소 관계는 같다)
     - 제목과 아티스트가 같은 줄에 나란한 악보가 흔하다 (シネマ·メルト·ODDS&ENDS)
     - 문서 순서는 못 믿는다. 아티스트가 먼저 그려지는 악보가 있다 (からくりピエロ)
     - 제목이 여러 조각으로 쪼개져 온다. 공백 없이 이어붙여야 한다

   그래서 (1) y로 줄을 묶고 (2) 가로 간격·크기 차이로 줄을 토막내고
   (3) 글자 크기로 제목과 아티스트를 정한다. */

const PUA = new RegExp('[\uE000-\uF8FF]', 'g');   /* SMuFL 음악 기호 (사설영역) */
const JUNK = /^[\d\s.,=oO°→\-–—~/|[\]()]+$/;             /* 리허설 마크·템포·박자표 */
const HEADER_RATIO = 0.78;   /* 페이지 위쪽 이만큼만 헤더로 본다 */
const Y_TOL = 3;             /* 같은 줄로 볼 y 차이 */
const SIZE_RATIO = 1.4;      /* 이보다 크기가 벌어지면 다른 요소로 본다 */
const ARTIST_MAX_DY = 55;    /* 아티스트는 제목에서 이만큼 안쪽에 있다 (실측 최대 37) */

const tidy = (s) => s.replace(/\s+/g, ' ').trim();

/* 연주 지시문("hi hat half open →")은 아티스트와 글자 크기가 같아 따로 걸러낸다. */
const isDirection = (t) => t.includes('→');

/* 헤더 조각을 줄 단위로 묶고, 줄 안에서 다시 의미 단위로 토막낸다. */
function buildSegments(items, pageHeight) {
  const minY = pageHeight * HEADER_RATIO;
  const kept = [];
  for (const it of items) {
    const raw = (it.str || '').replace(PUA, '');
    if (!raw.trim()) continue;
    const tr = it.transform;
    if (tr[5] < minY) continue;
    kept.push({
      text: raw,
      x: tr[4],
      y: tr[5],
      w: it.width || 0,
      size: Math.hypot(tr[2], tr[3]),
    });
  }

  const lines = [];
  for (const it of kept) {
    const line = lines.find((l) => Math.abs(l.y - it.y) <= Y_TOL);
    if (line) {
      line.items.push(it);
      line.y = (line.y + it.y) / 2;
    } else {
      lines.push({ y: it.y, items: [it] });
    }
  }

  const segments = [];
  for (const line of lines) {
    line.items.sort((a, b) => a.x - b.x);
    let seg = null;
    for (const it of line.items) {
      const near = seg && (it.x - (seg.x + seg.w)) <= Math.max(6, seg.size * 0.6);
      const alike = seg
        && Math.max(it.size, seg.size) / Math.min(it.size, seg.size) < SIZE_RATIO;
      if (near && alike) {
        seg.text += it.text;
        seg.w = it.x + it.w - seg.x;
        seg.size = Math.max(seg.size, it.size);
      } else {
        seg = { text: it.text, x: it.x, y: line.y, w: it.w, size: it.size };
        segments.push(seg);
      }
    }
  }

  /* 여기서 JUNK 를 거르지 않는다. "2521" 처럼 숫자뿐인 제목이 있어서,
     글자 크기를 보고 제목을 정한 뒤에 걸러야 한다. */
  return segments
    .map((s) => ({ ...s, text: tidy(s.text) }))
    .filter((s) => s.text && !isDirection(s.text));
}

function pickTitleArtist(segments) {
  if (!segments.length) return { title: null, artist: null };

  /* 제목 = 헤더에서 글자가 제일 큰 것. 숫자뿐이어도 제목일 수 있다. */
  const maxSize = Math.max(...segments.map((s) => s.size));
  const title = segments
    .filter((s) => s.size >= maxSize - 0.5)
    .sort((a, b) => (b.y - a.y) || (a.x - b.x))[0];

  /* 아티스트 = 제목보다 작고 제목 가까이 있는 것.
     세로 거리를 보지 않으면 아래쪽의 박자표 같은 큰 기호가 끼어든다. */
  const artist = segments
    .filter((s) => s.size < title.size - 0.5
      && Math.abs(s.y - title.y) <= ARTIST_MAX_DY
      && !JUNK.test(s.text))
    .sort((a, b) => (b.size - a.size) || (b.y - a.y))[0];

  return { title: title.text, artist: artist ? artist.text : null };
}

function findBpm(raw) {
  const m = raw.match(/=\s*(\d{2,3})\b/);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 20 && n <= 300 ? n : null;
}

/* 추출 실패 시 파일명으로 물러선다. 파일마다 규칙이 달라 제목으로만 쓴다. */
function fromFileName(name) {
  return (name || '').replace(/\.[^.]+$/, '').trim() || '제목 없음';
}

/**
 * @param {object} pdfjsLib  PDF.js 모듈
 * @param {File} file        사용자가 고른 PDF
 * @returns {{title:string, artist:string|null, bpm:number|null, pages:number, source:string}}
 */
export async function extractSheetInfo(pdfjsLib, file) {
  const fallback = {
    title: fromFileName(file.name), artist: null, bpm: null, pages: 0, source: '파일명',
  };
  if (!/\.pdf$/i.test(file.name || '')) return fallback;

  let doc = null;
  try {
    const buf = await file.arrayBuffer();
    doc = await pdfjsLib.getDocument({ data: buf }).promise;
    const page = await doc.getPage(1);
    const height = page.getViewport({ scale: 1 }).height;
    const content = await page.getTextContent();

    const segments = buildSegments(content.items, height);
    if (!segments.length) return { ...fallback, pages: doc.numPages, source: '텍스트 없음' };

    const { title, artist } = pickTitleArtist(segments);
    const raw = content.items.map((i) => (i.str || '').replace(PUA, '')).join(' ');
    return {
      title: title || fallback.title,
      artist,
      bpm: findBpm(raw),
      pages: doc.numPages,
      source: '악보 본문',
    };
  } catch (err) {
    console.warn('악보 정보 추출 실패:', file.name, err);
    return fallback;
  } finally {
    if (doc) doc.destroy();
  }
}
