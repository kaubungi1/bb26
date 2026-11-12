"""불법위키의 글 규칙. 제목 열쇠, 블록 검증, 본문에서 문서 이름 찾기.

문서는 블록의 줄이다. 블록은 종류(kind)와 내용(data)을 갖고, 글자는 HTML 이 아니라 조각(run)의 목록으로 둔다.
  [{"t":"글자","b":1,"s":1,"i":1,"c":"#dc2f4b","g":"#fff3a3","z":2}, {"t":"号哭","r":"ごうこく"},
   {"t":"링크","w":"문서 제목"}, {"t":"밖","a":"https://…"}, {"t":"안 걸 글자","n":1}, {"t":"","f":"각주 내용"}]
  b 굵게 · s 취소선 · i 기울임 · c 글자색 · g 배경색 · z 글자 크기(-2~4, 0 이 보통) · r 윗글자(후리가나)
  w 문서 링크 · a 바깥 링크 · n 자동 링크 안 걸기 · f 각주
화면은 조각을 textContent 로만 그리므로 저장된 글이 스크립트가 될 길이 없다. 여기서는 모양과 길이만 자른다.
색은 #rgb·#rrggbb 또는 영문 색 이름만 받는다 — 화면이 style.color 에 그대로 넣으므로 다른 글자가 끼면 안 된다.

제목 열쇠(key)는 '같은 문서인가'를 가르는 값이다. 띄어쓰기·기호·대소문자·전각을 지운다 —
"로스트원의호곡" 과 "로스트 원의 호곡" 이 한 문서다. 곡 중복 판정(songmatch.norm)과 같은 생각이지만
괄호 속은 지우지 않는다. 위키에는 "밴드(동음이의)" 같은 제목이 있다.

본문에서 문서 이름을 찾는 규칙(mentions)은 화면의 자동 링크(frontend/wiki/js/autolink.js)와 같아야 한다.
여기 것은 '이 문서를 가리키는 문서'를 뽑는 데만 쓴다. 한쪽만 고치면 화면의 링크와 역링크 목록이 어긋난다.

크기 상한(2026-11-13 다시 정함).
  로그인이 없어 누구든 아무 크기의 글을 보낼 수 있으므로 천장은 둔다. 다만 쓰는 사람이 부딪히면 안 된다.
  처음에는 표 40줄·문단 5,000자처럼 감으로 낮게 잡았고 사용자에게 알리지도 않았다 — 나무위키의 가사 표(180줄)가
  들어가지 않았다. 지금 값은 나무위키의 긴 문서가 그대로 들어오는 것을 기준으로 잡았다. 값을 바꾸면 사용자에게 알린다.
"""
import re
import unicodedata

TITLE_MAX = 60
ALIAS_MAX = 30
CATEGORY_MAX = 30
CATEGORY_LEN = 30
NICK_MAX = 20
RUN_MAX = 2000             # 한 블록의 조각 수(색을 글자마다 바꾼 가사가 문단 하나에 수백 조각이다)
RUN_CHARS = 20000          # 한 블록의 글자 수
FOOT_MAX = 2000
RUBY_MAX = 100
URL_MAX = 1000
CAPTION_MAX = 300
TABLE_ROWS = 300
TABLE_COLS = 20
CELL_MAX = 5000            # 표 한 칸의 글자 수(칸 하나에 가사 전체를 넣은 표가 있다)
CELL_RUNS = 2000
TABLE_CHARS = 200000       # 표 하나의 글자 수
INFO_ROWS = 100
INFO_KEY = 40
INFO_VALUE = 1000
FOLD_TITLE = 100
LYRIC_VERSES = 500         # 가사 한 블록의 소절 수
LYRIC_LINE = 1000          # 가사 한 줄의 글자 수
BLOCK_MAX = 3000           # 한 문서의 블록 수
LEVEL_MAX = 3              # 들여쓰기 단계(0 이 맨 앞)
SIZE_MIN, SIZE_MAX = -2, 4  # 글자 크기 단계. 브라우저의 글자 크기 일곱 단계(1~7)에서 보통(3)을 0 으로 둔 값이다
CATEGORY_PREFIX = '분류:'   # /wiki/분류:이름 은 분류 목록 화면이다. 문서 제목으로는 못 쓴다

HEAD_KINDS = ('h2', 'h3', 'h4')          # 대분류 · 중분류 · 소분류
TEXT_KINDS = ('p', 'h2', 'h3', 'h4', 'ul', 'ol', 'quote', 'notice')
KINDS = TEXT_KINDS + ('img', 'yt', 'table', 'fold', 'infobox', 'embed', 'lyric')

_CTRL = re.compile('[\\x00-\\x09\\x0b-\\x1f\\x7f\\u200b\\u2028\\u2029\\ufeff]')   # 줄바꿈(\n)만 남긴다
_SPACE = re.compile(r'\s+')
_URL = re.compile(r'^https?://[^\s<>"\']+$', re.I)
_YT = re.compile(r'^[A-Za-z0-9_-]{11}$')
_CID = re.compile(r'^[a-z0-9]{6,24}$')
_COLOR = re.compile(r'^(?:#(?:[0-9a-f]{3}|[0-9a-f]{6})|[a-z]{3,20})$')
ALIGN = ('l', 'c', 'r')


class Bad(ValueError):
    """받을 수 없는 내용. 라우터가 400 으로 바꾼다."""


def key(text):
    """제목 열쇠. NFKC(전각→반각) → 소문자 → 글자·숫자만. 기호뿐인 제목("!!!")은 공백만 지운다."""
    s = unicodedata.normalize('NFKC', text or '').lower()
    return re.sub(r'[\W_]+', '', s) or _SPACE.sub('', s)


def line(text, limit):
    """한 줄짜리 글. 제어문자를 지우고 공백을 한 칸으로 모은다."""
    if not isinstance(text, str):
        return ''
    return _SPACE.sub(' ', _CTRL.sub('', text)).strip()[:limit]


def title(text):
    t = line(text, TITLE_MAX + 1)
    if not t or not key(t):
        raise Bad('제목을 입력하세요.')
    if len(t) > TITLE_MAX:
        raise Bad(f'제목은 {TITLE_MAX}자까지입니다.')
    if t.startswith(CATEGORY_PREFIX) or t in ('.', '..'):
        raise Bad('쓸 수 없는 제목입니다.')
    return t


def cid(value):
    if not isinstance(value, str) or not _CID.match(value):
        raise Bad('블록 번호가 올바르지 않습니다.')
    return value


def names(values, limit, length):
    """다른 이름·분류처럼 짧은 이름의 목록. 열쇠가 같은 것은 하나만 남긴다."""
    if not isinstance(values, list):
        raise Bad('목록이 올바르지 않습니다.')
    out, seen = [], set()
    for v in values:
        t = line(v, length)
        k = key(t)
        if not t or not k or k in seen:
            continue
        seen.add(k)
        out.append(t)
    if len(out) > limit:
        raise Bad(f'{limit}개까지 붙일 수 있습니다.')
    return out


def color(value):
    """색. #rgb·#rrggbb·영문 이름만. 아니면 None(그 꾸밈을 버린다)."""
    if not isinstance(value, str):
        return None
    v = value.strip().lower()
    return v if _COLOR.match(v) else None


# ---------- 조각 ----------
def runs(value, limit=RUN_CHARS, count=RUN_MAX):
    if not isinstance(value, list):
        raise Bad('글이 올바르지 않습니다.')
    if len(value) > count:
        raise Bad('꾸밈이 너무 많습니다.')
    out, total = [], 0
    for r in value:
        if not isinstance(r, dict):
            continue
        foot = r.get('f')
        if isinstance(foot, str):
            foot = _SPACE.sub(' ', _CTRL.sub('', foot)).strip()[:FOOT_MAX]
            if foot:
                out.append({'t': '', 'f': foot})
            continue
        t = r.get('t')
        t = _CTRL.sub('', t.replace('\r', '')) if isinstance(t, str) else ''
        if not t:
            continue
        total += len(t)
        if total > limit:
            raise Bad(f'한 문단은 {limit}자까지입니다.')
        run = {'t': t}
        for mark in ('b', 's', 'i'):
            if r.get(mark):
                run[mark] = 1
        for mark in ('c', 'g'):
            v = color(r.get(mark))
            if v:
                run[mark] = v
        z = r.get('z')
        if isinstance(z, int) and not isinstance(z, bool) and z and SIZE_MIN <= z <= SIZE_MAX:
            run['z'] = z
        ruby = line(r.get('r'), RUBY_MAX)
        if ruby:
            run['r'] = ruby
        a, w = r.get('a'), r.get('w')
        if isinstance(a, str) and len(a) <= URL_MAX and _URL.match(a):
            run['a'] = a
        elif isinstance(w, str) and line(w, TITLE_MAX) and key(line(w, TITLE_MAX)):
            run['w'] = line(w, TITLE_MAX)
        elif r.get('n'):
            run['n'] = 1
        last = out[-1] if out else None
        # 꾸밈이 같은 이웃 조각은 합친다. 윗글자가 붙은 조각은 합치지 않는다 — 윗글자는 그 글자에만 붙는다.
        if last is not None and 'f' not in last and 'r' not in last and 'r' not in run and \
                {k: v for k, v in last.items() if k != 't'} == {k: v for k, v in run.items() if k != 't'}:
            last['t'] += t
        else:
            out.append(run)
    return out


def _image(value):
    if value in (None, '', 0):
        return None
    try:
        n = int(value)
    except (TypeError, ValueError):
        raise Bad('그림 번호가 올바르지 않습니다.')
    if n <= 0:
        raise Bad('그림 번호가 올바르지 않습니다.')
    return n


def _cell(value, limit):
    if not isinstance(value, str):
        return ''
    return _CTRL.sub('', value.replace('\r', '')).strip()[:limit]


def _span(value, limit):
    return value if isinstance(value, int) and not isinstance(value, bool) and 1 < value <= limit else None


def _table_cell(value):
    """표의 칸. 글자뿐이면 문자열, 꾸밈·합치기·색·정렬이 있으면 dict, 합쳐져 가려진 자리는 None.
      {"runs":[…] 또는 "t":"글자", "cs":가로로 합친 칸 수, "rs":세로로 합친 줄 수, "bg":칸 색, "al":"l"|"c"|"r"}"""
    if value is None:
        return None
    if isinstance(value, str):
        return _cell(value, CELL_MAX)
    if not isinstance(value, dict):
        return ''
    out = {}
    rich = runs(value['runs'], CELL_MAX, CELL_RUNS) if isinstance(value.get('runs'), list) else None
    if rich is not None and not (len(rich) <= 1 and all(set(r) == {'t'} for r in rich)):
        out['runs'] = rich
    else:
        out['t'] = rich[0]['t'].strip() if rich else _cell(value.get('t'), CELL_MAX)
    for name, limit in (('cs', TABLE_COLS), ('rs', TABLE_ROWS)):
        n = _span(value.get(name), limit)
        if n:
            out[name] = n
    bg = color(value.get('bg'))
    if bg:
        out['bg'] = bg
    if value.get('al') in ALIGN:
        out['al'] = value['al']
    return out['t'] if set(out) == {'t'} else out


def _cell_runs(cell):
    if isinstance(cell, dict):
        return cell.get('runs') or [{'t': cell.get('t') or ''}]
    return [{'t': cell or ''}]


def block(kind, data):
    """블록 내용을 받아 저장할 모양으로 돌려준다. 모르는 칸은 버린다."""
    if kind not in KINDS:
        raise Bad('모르는 블록 종류입니다.')
    if not isinstance(data, dict):
        raise Bad('블록 내용이 올바르지 않습니다.')
    if kind in TEXT_KINDS:
        out = {'runs': runs(data.get('runs') or [])}
        # 들여쓰기 단계. 제목은 들여 쓰지 않는다. 0 이면 칸 자체를 두지 않는다(옛 블록과 모양이 같게).
        level = data.get('level')
        if kind not in HEAD_KINDS and isinstance(level, int) and not isinstance(level, bool) and 0 < level <= LEVEL_MAX:
            out['level'] = level
        return out
    if kind == 'img':
        image = _image(data.get('image'))
        if not image:
            raise Bad('그림이 없습니다.')
        return {'image': image, 'caption': line(data.get('caption'), CAPTION_MAX)}
    if kind == 'yt':
        v = data.get('v')
        if not isinstance(v, str) or not _YT.match(v):
            raise Bad('유튜브 주소가 올바르지 않습니다.')
        return {'v': v}
    if kind == 'table':
        rows = data.get('rows')
        if not isinstance(rows, list) or not rows:
            raise Bad('표가 비었습니다.')
        if len(rows) > TABLE_ROWS:
            raise Bad(f'표는 {TABLE_ROWS}줄까지입니다.')
        width = max((len(r) for r in rows if isinstance(r, list)), default=0)
        if not 1 <= width <= TABLE_COLS:
            raise Bad(f'표는 {TABLE_COLS}칸까지입니다.')
        clean = []
        for r in rows:
            cells = [_table_cell(c) for c in (r if isinstance(r, list) else [])]
            clean.append(cells + [''] * (width - len(cells)))
        if sum(len(r.get('t') or '') for row in clean for c in row for r in _cell_runs(c)) > TABLE_CHARS:
            raise Bad('표가 너무 큽니다.')
        out = {'rows': clean, 'head': bool(data.get('head', True))}
        if data.get('align') in ('c', 'r'):          # 표를 놓는 자리: 가운데 · 오른쪽(본문이 왼쪽으로 흐른다)
            out['align'] = data['align']
        return out
    if kind == 'lyric':
        # 가사. 소절마다 원문(o)·발음(r)·번역(t) 세 줄이고 줄은 조각이다. gap 은 그 소절 앞에서 절이 바뀐다는 표시.
        verses = data.get('verses')
        if not isinstance(verses, list):
            raise Bad('가사가 올바르지 않습니다.')
        if len(verses) > LYRIC_VERSES:
            raise Bad(f'가사는 {LYRIC_VERSES}소절까지입니다.')
        clean = []
        for v in verses:
            if not isinstance(v, dict):
                continue
            verse = {k: runs(v.get(k) if isinstance(v.get(k), list) else [], LYRIC_LINE, 400) for k in ('o', 'r', 't')}
            if not (verse['o'] or verse['r'] or verse['t']):
                continue
            if v.get('gap') and clean:
                verse['gap'] = 1
            clean.append(verse)
        return {'verses': clean}
    if kind == 'fold':
        return {'title': line(data.get('title'), FOLD_TITLE), 'runs': runs(data.get('runs') or [])}
    if kind == 'infobox':
        rows = data.get('rows') if isinstance(data.get('rows'), list) else []
        clean = []
        for r in rows:
            if not isinstance(r, list) or len(r) < 2:
                continue
            k, v = line(r[0], INFO_KEY), _cell(r[1], INFO_VALUE)
            if k or v:
                clean.append([k, v])
        if len(clean) > INFO_ROWS:
            raise Bad(f'정보 상자는 {INFO_ROWS}줄까지입니다.')
        return {'title': line(data.get('title'), TITLE_MAX), 'image': _image(data.get('image')), 'rows': clean}
    # embed
    return {'title': title(data.get('title'))}


def empty(kind, data):
    """내용이 없는 블록인가. 빈 글 블록은 저장하지 않고 지운다."""
    if kind in TEXT_KINDS:
        return not data['runs']
    if kind == 'fold':
        return not data['title'] and not data['runs']
    if kind == 'infobox':
        return not data['title'] and not data['image'] and not data['rows']
    if kind == 'lyric':
        return not data['verses']
    return False


def _run_text(rs):
    parts = []
    for r in rs:
        parts.append(r.get('f') or r.get('t') or '')
        if r.get('w'):
            parts.append(' ' + r['w'] + ' ')        # 보이는 글자와 가리키는 문서가 다를 수 있다
    return ''.join(parts)


def _shown_runs(rs):
    return ''.join((r.get('t') or '') for r in rs)


def shown(kind, data):
    """사람 눈에 보이는 글자. 최근 바뀜의 '쓴 문장'과 이력 요약에 쓴다."""
    if kind in TEXT_KINDS:
        return _shown_runs(data['runs'])
    if kind == 'fold':
        return (data['title'] + ' ' + _shown_runs(data['runs'])).strip()
    if kind == 'img':
        return data['caption']
    if kind == 'table':
        return ' '.join(t for t in (_shown_runs(_cell_runs(c)) for r in data['rows'] for c in r if c is not None) if t)
    if kind == 'infobox':
        return ' '.join([data['title']] + [f'{k} {v}'.strip() for k, v in data['rows']]).strip()
    if kind == 'embed':
        return data['title']
    if kind == 'lyric':
        return ' '.join(t for t in (_shown_runs(v[k]) for v in data['verses'] for k in ('o', 'r', 't')) if t)
    return ''


def plain(kind, data):
    """찾기와 역링크가 읽는 글자. 각주와 손으로 건 링크의 대상까지 넣는다."""
    if kind in TEXT_KINDS:
        return _run_text(data['runs'])
    if kind == 'fold':
        return data['title'] + '\n' + _run_text(data['runs'])
    if kind == 'table':
        return ' '.join(t for t in (_run_text(_cell_runs(c)) for r in data['rows'] for c in r if c is not None) if t)
    if kind == 'lyric':
        return ' '.join(t for t in (_run_text(v[k]) for v in data['verses'] for k in ('o', 'r', 't')) if t)
    return shown(kind, data)


# ---------- 본문에서 문서 이름 찾기 ----------
# 조사 목록. 화면(autolink.js)의 JOSA 와 같은 값이어야 한다.
JOSA = ('이라는', '이라고', '입니다', '이었다', '에서는', '에서도', '으로는', '으로도', '에게는', '에게도', '한테는', '한테도',
        '이라', '이란', '이다', '이며', '이고', '이나', '이랑', '이여', '이요', '에서', '에게', '한테', '으로', '부터', '까지',
        '처럼', '보다', '마다', '조차', '마저', '밖에', '라는', '라고', '였다', '에는', '에도', '로는', '로도', '과는', '와는',
        '같은', '같이', '하고', '은', '는', '이', '가', '을', '를', '의', '에', '께', '와', '과', '랑', '도', '만', '로',
        '나', '라', '란', '다', '며', '고', '인', '님', '씨', '야', '아', '여', '요', '뿐')
_TAIL = re.compile(r'(?:들)?(?:%s)?(?:%s)?(?!\w)' % ('|'.join(JOSA), '|'.join(JOSA)))
_GAP = r'[^\w]{0,3}'       # 제목 글자 사이에 끼어도 되는 것: 공백·기호 세 칸까지
AUTO_MIN = 2               # 열쇠가 한 글자인 이름은 자동으로 걸지 않는다("월" → 11월, 월요일)


def mentions(text, name_key):
    """text 가 이 이름을 '한 낱말로' 부르는가. 낱말의 맨 앞에서 시작하고, 뒤는 끝·기호·조사여야 한다.
    "하모니카" 는 "니카" 를 부르지 않고, "니카가 불었다" 는 부른다."""
    if len(name_key) < AUTO_MIN:
        return False
    low = unicodedata.normalize('NFKC', text or '').lower()
    pattern = re.compile(_GAP.join(re.escape(ch) for ch in name_key))
    for m in pattern.finditer(low):
        if m.start() > 0 and re.match(r'\w', low[m.start() - 1]):
            continue
        if _TAIL.match(low, m.end()):
            return True
    return False
