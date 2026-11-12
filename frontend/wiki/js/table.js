/* 불법위키 — 표.

   표의 내용(data.rows)은 줄마다 칸이 같은 수로 선 격자다. 칸은 셋 가운데 하나다(backend/wikitext.py _table_cell).
     "글자"                                   꾸밈 없는 칸
     { runs|t, cs, rs, bg, al }               꾸밈(굵게·색·윗글자…)·가로 합치기(cs)·세로 합치기(rs)·칸 색(bg)·정렬(al: l|c|r)이 있는 칸
     null                                     위나 왼쪽의 합쳐진 칸에 가려진 자리
   가려진 자리를 null 로 채워 두므로 줄·칸을 넣고 빼는 일이 전부 (줄, 칸) 번호로 된다.
   그릴 때는 null 을 건너뛰고 colspan·rowspan 을 준다. 칸에는 제 자리(data-r·data-c)를 적어 둔다 —
   합쳐진 표에서는 DOM 의 칸 순서가 격자의 칸 번호와 다르다.

   나무위키 표(|| <-2> 칸 || … ||)를 그대로 받을 수 있게 하려고 이 모양으로 넓혔다(2026-11-13). 처음에는 글자만 든
   네모 격자였고 40줄까지였다. */
const WikiTable = (() => {
  const { el } = WikiRender;
  const ALIGN = { l: 'left', c: 'center', r: 'right' };
  const EXTRA = ['cs', 'rs', 'bg', 'al'];

  const isObj = (cell) => !!cell && typeof cell === 'object';
  const span = (cell) => ({ cs: (isObj(cell) && cell.cs) || 1, rs: (isObj(cell) && cell.rs) || 1 });
  function runsOf(cell) {
    if (isObj(cell)) return cell.runs ? cell.runs.map((r) => ({ ...r })) : (cell.t ? [{ t: cell.t }] : []);
    return cell ? [{ t: cell }] : [];
  }
  const text = (cell) => runsOf(cell).map((r) => r.t || r.f || '').join('');

  /* 조각과 칸의 속성을 저장할 모양으로. 꾸밈도 속성도 없으면 문자열이 된다(서버가 돌려주는 모양과 같게). */
  function pack(runs, from) {
    const bare = runs.length <= 1 && (!runs[0] || Object.keys(runs[0]).length === 1);
    const out = bare ? { t: runs[0] ? runs[0].t.trim() : '' } : { runs };
    for (const k of EXTRA) if (isObj(from) && from[k]) out[k] = from[k];
    return Object.keys(out).length === 1 && bare ? out.t : out;
  }
  const copy = (rows) => rows.map((row) => row.map((c) => (isObj(c) ? { ...c } : c)));
  function replace(rows, next) { rows.length = 0; rows.push(...next); }

  /* 줄과 칸을 뒤바꾼 표. 칸에 하는 일을 줄에 하는 일로 돌려쓰려고 쓴다. */
  function flip(rows) {
    const out = Array.from({ length: rows[0].length }, () => []);
    rows.forEach((row, r) => row.forEach((cell, c) => {
      let next = cell;
      if (isObj(cell)) {
        next = { ...cell };
        delete next.cs; delete next.rs;
        if (cell.rs) next.cs = cell.rs;
        if (cell.cs) next.rs = cell.cs;
      }
      out[c][r] = next;
    }));
    return out;
  }

  /* (r, c) 를 덮고 있는 칸의 자리 */
  function owner(rows, r, c) {
    for (let r0 = r; r0 >= 0; r0 -= 1) {
      for (let c0 = c; c0 >= 0; c0 -= 1) {
        const cell = rows[r0][c0];
        if (cell === null || cell === undefined) continue;
        const s = span(cell);
        if (r0 + s.rs > r && c0 + s.cs > c) return { r: r0, c: c0 };
      }
    }
    return null;
  }
  function setSpan(rows, r, c, key, n) {
    const cell = isObj(rows[r][c]) ? { ...rows[r][c] } : { t: rows[r][c] || '' };
    if (n > 1) cell[key] = n; else delete cell[key];
    rows[r][c] = pack(runsOf(cell), cell);
  }

  /* at 번째 줄 앞에 빈 줄을 넣는다. 그 자리를 세로로 가로지르는 합쳐진 칸은 한 줄 늘어난다. */
  function insertRow(rows, at) {
    const row = [];
    const grown = new Set();
    for (let c = 0; c < rows[0].length; c += 1) {
      const o = at < rows.length && rows[at][c] === null ? owner(rows, at, c) : null;
      if (o && o.r < at) {
        const id = `${o.r},${o.c}`;
        if (!grown.has(id)) { grown.add(id); setSpan(rows, o.r, o.c, 'rs', span(rows[o.r][o.c]).rs + 1); }
        row.push(null);
      } else row.push('');
    }
    rows.splice(at, 0, row);
    return true;
  }

  /* r 번째 줄을 뺀다. 위에서 내려온 합쳐진 칸은 한 줄 줄고, 이 줄에서 시작한 합쳐진 칸은 아랫줄로 내려간다. */
  function deleteRow(rows, r) {
    if (rows.length <= 1) return false;
    const shrunk = new Set();
    for (let c = 0; c < rows[0].length; c += 1) {
      const cell = rows[r][c];
      if (cell === null) {
        const o = owner(rows, r, c);
        if (o && o.r < r && !shrunk.has(`${o.r},${o.c}`)) {
          shrunk.add(`${o.r},${o.c}`);
          setSpan(rows, o.r, o.c, 'rs', span(rows[o.r][o.c]).rs - 1);
        }
      } else if (span(cell).rs > 1) {
        rows[r + 1][c] = cell;
        setSpan(rows, r + 1, c, 'rs', span(cell).rs - 1);
      }
    }
    rows.splice(r, 1);
    return true;
  }
  function insertCol(rows, at) { const f = flip(rows); insertRow(f, at); replace(rows, flip(f)); return true; }
  function deleteCol(rows, c) {
    if (rows[0].length <= 1) return false;
    const f = flip(rows);
    deleteRow(f, c);
    replace(rows, flip(f));
    return true;
  }

  /* 오른쪽(또는 아래) 칸과 합친다. 높이(또는 폭)가 같은 이웃하고만 된다. 두 칸의 글은 이어 붙는다. */
  function merge(rows, r, c, dir) {
    if (dir === 'down') {
      const f = flip(rows);
      if (!merge(f, c, r, 'right')) return false;
      replace(rows, flip(f));
      return true;
    }
    const cell = rows[r][c];
    if (cell === null || cell === undefined) return false;
    const s = span(cell);
    const nc = c + s.cs;
    if (nc >= rows[0].length) return false;
    const next = rows[r][nc];
    if (next === null || span(next).rs !== s.rs) return false;
    const a = runsOf(cell);
    const b = runsOf(next);
    const joined = a.length && b.length ? [...a, { t: ' ' }, ...b] : [...a, ...b];
    rows[r][c] = pack(joined, { ...(isObj(cell) ? cell : {}), cs: s.cs + span(next).cs });
    rows[r][nc] = null;
    return true;
  }
  function unmerge(rows, r, c) {
    const cell = rows[r][c];
    const s = span(cell);
    if (!isObj(cell) || (s.cs === 1 && s.rs === 1)) return false;
    for (let i = 0; i < s.rs; i += 1) for (let j = 0; j < s.cs; j += 1) if (i || j) rows[r + i][c + j] = '';
    const next = { ...cell };
    delete next.cs; delete next.rs;
    rows[r][c] = pack(runsOf(next), next);
    return true;
  }
  /* 칸 색·정렬. value 가 비면 그 속성을 뗀다. */
  function setAttr(rows, r, c, key, value) {
    const cell = rows[r][c];
    if (cell === null || cell === undefined) return false;
    const next = isObj(cell) ? { ...cell } : {};
    if (value) next[key] = value; else delete next[key];
    rows[r][c] = pack(runsOf(cell), next);
    return true;
  }

  /* 표를 그린다. fill(td, 조각) 이 칸의 내용을 채운다 — 읽을 때와 고칠 때가 다르다. */
  function paint(table, data, fill) {
    table.replaceChildren();
    data.rows.forEach((row, r) => {
      const tr = el('tr');
      row.forEach((cell, c) => {
        if (cell === null) return;
        const td = el(data.head && r === 0 ? 'th' : 'td');
        td.dataset.r = r;
        td.dataset.c = c;
        if (isObj(cell)) {
          if (cell.cs) td.colSpan = cell.cs;
          if (cell.rs) td.rowSpan = cell.rs;
          if (cell.bg) td.style.backgroundColor = cell.bg;
          if (cell.al) td.style.textAlign = ALIGN[cell.al];
        }
        fill(td, runsOf(cell));
        tr.append(td);
      });
      table.append(tr);
    });
  }

  /* 고치던 표를 다시 내용으로. 칸의 글은 문단과 같은 방법(editor.js runsOf)으로 읽는다. */
  function collect(table, data) {
    const rows = copy(data.rows);
    table.querySelectorAll('td, th').forEach((td) => {
      const r = Number(td.dataset.r);
      const c = Number(td.dataset.c);
      if (rows[r] && rows[r][c] !== undefined) rows[r][c] = pack(WikiEdit.runsOf(td), data.rows[r][c]);
    });
    return { ...data, rows };
  }
  const blank = (rows) => rows.every((row) => row.every((c) => c === null || !text(c).trim()));

  return { paint, collect, blank, copy, text, owner, insertRow, deleteRow, insertCol, deleteCol, merge, unmerge, setAttr };
})();
