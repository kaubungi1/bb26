"""같은 곡인가. 등록·수정할 때 '혹시 이 곡인가요?' 를 묻고 중복 규칙을 지키는 데 쓴다.

판정은 아래가 '정확히' 같을 때만 한다. 글자 유사도(비율)는 쓰지 않는다.
2026-10-02 실측(296곡): 비율로 하면 Symbol I/II(0.93), Rewrite/Re:Re:(0.73) 처럼 다른 곡이 걸리고,
같은 곡인데 일본어/한글 표기라 글자가 하나도 안 겹치는 쌍(ヴァンパイア/뱀파이어)은 못 잡는다.

  video  유튜브 영상이 같다. 가장 확실해서 '다른 곡이에요' 로 넘길 수 없다.
  title  원제가 같다(괄호 속·공백·기호·대소문자·전각 무시). Realize!/Realize 처럼 다른 곡일 수 있어 넘길 수 있다.
  name   원제·번역 중 하나가 서로 같다. 옛 곡은 '원제 (번역)' 한 칸이거나 원제 칸에 한글만 있어서,
         괄호 속 한글과 한글뿐인 원제도 번역으로 본다(少女レイ/소녀레이 가 이렇게 잡힌다).
아티스트는 보지 않는다 — 같은 곡이 結束バンド/결속밴드, 원곡/커버로 갈린다.

중복 규칙(사용자 결정, 2026-10-02). 같은 곡을 여러 길드가 하면 길드마다 따로 둔다(지원자 명단이 섞이지 않게).
  same       같은 소속(같은 길드, 또는 둘 다 프리길드)에 같은 곡 → 막는다
  inGuild    프리길드로 넣으려는데 어느 길드에 있다 → 막는다. 그 곡에 용병으로 간다
  unguilded  길드로 넣으려는데 프리길드에 있다 → 새로 만들지 않고 그 곡을 길드로 가져온다(이전)
프리길드 = 어느 길드에도 속하지 않은 곡(guildId 가 비어 있음). 2026-10-02 '무길드' 에서 이름을 바꿨다.
  다른 길드에 있으면 부딪히지 않는다.
"""
import re
import unicodedata

import thumbs

_BRACKETS = r'\(\[（【「『'
_CLOSERS = r'\)\]）】」』'
_BRACKET = re.compile(rf'[{_BRACKETS}][^{_CLOSERS}]*[{_CLOSERS}]')
_INNER = re.compile(r'[\(（]([^\)）]*)[\)）]')
_HANGUL = re.compile('[가-힣]')
_JAPANESE = re.compile('[぀-ヿ一-鿿]')


def norm(text):
    """비교용 열쇠. NFKC(전각→반각) → 소문자 → 괄호 속 제거 → 글자·숫자만."""
    s = unicodedata.normalize('NFKC', text or '').lower()
    s = _BRACKET.sub('', s)
    return re.sub(r'[\W_]+', '', s)


def names(title, title_ko=None):
    """(원제 열쇠, 이름 열쇠 모음). 이름 열쇠는 원제·번역·옛 곡의 괄호 속 한글."""
    t = norm(title)
    found = {t} if t else set()
    if title_ko:
        k = norm(title_ko)
        if k:
            found.add(k)
    for inner in _INNER.findall(unicodedata.normalize('NFKC', title or '')):
        # 괄호 속은 번역일 때만 이름으로 본다. "(GTO)" "(프로젝트 세카이)" 같은 메모가 다른 곡과 묶이지 않게,
        # 괄호 밖이 일본어이고 괄호 속이 한글인 '원제 (번역)' 꼴만 받는다.
        if _HANGUL.search(inner) and _JAPANESE.search(_BRACKET.sub('', title or '')):
            k = norm(inner)
            if k:
                found.add(k)
    return t, found


def reasons(a, b):
    """두 곡(dict: title, titleKo, youtubeUrl, thumbVideoId)이 같은 곡이라 볼 이유들. 없으면 []."""
    out = []
    va = a.get('thumbVideoId') or thumbs.video_id(a.get('youtubeUrl'))
    vb = b.get('thumbVideoId') or thumbs.video_id(b.get('youtubeUrl'))
    if va and va == vb:
        out.append('video')
    ta, na = names(a.get('title'), a.get('titleKo'))
    tb, nb = names(b.get('title'), b.get('titleKo'))
    if ta and ta == tb:
        out.append('title')
    elif na & nb:
        out.append('name')
    return out


def find(conn, title, title_ko=None, youtube_url=None, exclude=None):
    """같은 곡일 수 있는 곡들. 전체 곡의 제목·주소만 읽는다(사진 칸은 읽지 않는다)."""
    me = {'title': title, 'titleKo': title_ko, 'youtubeUrl': youtube_url}
    rows = conn.execute(
        'SELECT "id","title","titleKo","artist","youtubeUrl","thumbVideoId","guildId" FROM songs'
    ).fetchall()
    out = []
    for r in rows:
        if exclude is not None and r['id'] == exclude:
            continue
        why = reasons(me, r)
        if why:
            out.append({'id': r['id'], 'title': r['title'], 'titleKo': r['titleKo'], 'artist': r['artist'],
                        'guildId': r['guildId'], 'reasons': why})
    return out


def conflicts(candidates, guild_id, not_same=()):
    """guild_id(None = 프리길드)에 넣으려는 곡과 부딪히는 후보에 conflict 를 단다.
    not_same: 사용자가 '다른 곡이에요' 라고 한 후보 id. 영상이 같은 후보는 넘길 수 없다."""
    skip = {int(i) for i in not_same or () if str(i).isdigit()}
    out = []
    for c in candidates:
        if c['id'] in skip and 'video' not in c['reasons']:
            continue
        g = c['guildId']
        if g == guild_id:
            kind = 'same'
        elif guild_id is None:
            kind = 'inGuild'
        elif g is None:
            kind = 'unguilded'
        else:
            continue
        out.append({**c, 'conflict': kind})
    return out


MESSAGES = {
    'same': '같은 곳에 이미 있는 곡입니다.',
    'inGuild': '길드에 이미 있는 곡이라 프리길드로 넣을 수 없습니다. 그 곡에 용병으로 지원해 주세요.',
    'unguilded': '프리길드에 이미 있는 곡입니다. 새로 만들지 말고 길드장이 그 곡을 길드로 가져오면 됩니다.',
}


def duplicate_error(found):
    """409 본문. 화면은 candidates 로 '혹시 이 곡인가요?' 를 다시 그린다."""
    return {'message': MESSAGES[found[0]['conflict']], 'code': 'duplicate', 'candidates': found}
