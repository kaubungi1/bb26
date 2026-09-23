import os
import time

import psycopg
from dotenv import load_dotenv
from psycopg.rows import dict_row

import metrics

load_dotenv()

DATABASE_URL = os.environ.get('DATABASE_URL', '')

SCHEMA = """
CREATE TABLE IF NOT EXISTS songs (
  "id" SERIAL PRIMARY KEY,
  "title" TEXT NOT NULL,
  "artist" TEXT NOT NULL,
  "category" TEXT,
  "youtubeUrl" TEXT,
  "status" TEXT NOT NULL DEFAULT 'candidate',
  "isCandidate" INTEGER NOT NULL DEFAULT 0,
  "note" TEXT,
  "createdBy" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  "id" SERIAL PRIMARY KEY,
  "songId" INTEGER NOT NULL REFERENCES songs("id") ON DELETE CASCADE,
  "role" TEXT NOT NULL,
  "isFilled" INTEGER NOT NULL DEFAULT 0,
  "note" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessionSupports (
  "id" SERIAL PRIMARY KEY,
  "sessionId" INTEGER NOT NULL REFERENCES sessions("id") ON DELETE CASCADE,
  "nickname" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE ("sessionId", "nickname")
);

CREATE TABLE IF NOT EXISTS sessionHistories (
  "id" SERIAL PRIMARY KEY,
  "songId" INTEGER NOT NULL REFERENCES songs("id") ON DELETE CASCADE,
  "date" TEXT NOT NULL,
  "note" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 악보는 곡 목록과 독립이다. 무엇이든 올리고 검색으로 찾는다.
CREATE TABLE IF NOT EXISTS sheets (
  "id" SERIAL PRIMARY KEY,
  "title" TEXT NOT NULL,
  "artist" TEXT,
  "role" TEXT,
  "tags" TEXT,
  "bpm" INTEGER,
  "pages" INTEGER,
  "note" TEXT,
  "fileName" TEXT,
  "content" BYTEA NOT NULL,
  "viewPrefs" TEXT,
  "uploadedBy" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 두 아이패드 페어링 — 코드 하나가 {보는 악보, 펼침 위치}를 공유한다.
CREATE TABLE IF NOT EXISTS pairs (
  "code" TEXT PRIMARY KEY,
  "sheetId" INTEGER,
  "spread" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS events (
  "id" SERIAL PRIMARY KEY,
  "title" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'poll',
  "date" TEXT,
  "startTime" TEXT,
  "endTime" TEXT,
  "place" TEXT,
  "note" TEXT,
  "createdBy" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS eventDates (
  "id" SERIAL PRIMARY KEY,
  "eventId" INTEGER NOT NULL REFERENCES events("id") ON DELETE CASCADE,
  "date" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE ("eventId", "date")
);

CREATE TABLE IF NOT EXISTS eventAvails (
  "id" SERIAL PRIMARY KEY,
  "eventId" INTEGER NOT NULL REFERENCES events("id") ON DELETE CASCADE,
  "date" TEXT NOT NULL,
  "nickname" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE ("eventId", "date", "nickname")
);
-- 길드. 곡·일정에 꼬리표로 붙는 소속이며, 데이터는 전체가 하나로 공유된다.
CREATE TABLE IF NOT EXISTS guilds (
  "id" SERIAL PRIMARY KEY,
  "slug" TEXT NOT NULL UNIQUE,
  "name" TEXT NOT NULL,
  "leader" TEXT,
  "slogan" TEXT,
  "recruitNote" TEXT,
  "color" TEXT,
  "emblem" TEXT,
  "createdBy" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 길드 명단. 한 사람이 한 길드에서 여러 파트를 맡을 수 있다.
CREATE TABLE IF NOT EXISTS guildMembers (
  "id" SERIAL PRIMARY KEY,
  "guildId" INTEGER NOT NULL REFERENCES guilds("id") ON DELETE CASCADE,
  "nickname" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE ("guildId", "nickname", "role")
);

-- 길드 배경 낙서. 한 사람이 한 길드에 한 장이고, 다 같이 한 벽에 그린다.
-- 지우는 것은 자기 줄뿐이다. strokes 는 [{"c":"#39c5bb","w":3,"p":[[x,y],...]}] 이고
-- 좌표는 1600x1000 고정 캔버스 기준이다 — 화면 크기마다 그림이 어긋나면 안 된다.
-- 들어오는 값은 routers/drawings.py 가 개수·크기·색까지 전부 잘라서 받는다.
CREATE TABLE IF NOT EXISTS guildDrawings (
  "id" SERIAL PRIMARY KEY,
  "guildId" INTEGER NOT NULL REFERENCES guilds("id") ON DELETE CASCADE,
  "nickname" TEXT NOT NULL,
  "strokes" JSONB NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE ("guildId", "nickname")
);

-- 멤버 프로필. 닉네임이 곧 열쇠다. 본인이 색·아바타·칭호를 정한다.
CREATE TABLE IF NOT EXISTS members (
  "nickname" TEXT PRIMARY KEY,
  "mainRoles" TEXT,
  "availability" TEXT,
  "intro" TEXT,
  "color" TEXT,
  "avatar" TEXT,
  "title" TEXT,
  "status" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 확정된 일정의 셋리스트.
CREATE TABLE IF NOT EXISTS eventSongs (
  "id" SERIAL PRIMARY KEY,
  "eventId" INTEGER NOT NULL REFERENCES events("id") ON DELETE CASCADE,
  "songId" INTEGER NOT NULL REFERENCES songs("id") ON DELETE CASCADE,
  "order" INTEGER NOT NULL DEFAULT 0,
  "note" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE ("eventId", "songId")
);

-- 그날 누가 어느 파트를 쳤는지. 확정 시점의 스냅샷이라 지원자가 뒤에 바뀌어도 남는다.
CREATE TABLE IF NOT EXISTS eventLineups (
  "id" SERIAL PRIMARY KEY,
  "eventId" INTEGER NOT NULL REFERENCES events("id") ON DELETE CASCADE,
  "songId" INTEGER NOT NULL REFERENCES songs("id") ON DELETE CASCADE,
  "role" TEXT NOT NULL,
  "nickname" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE ("eventId", "songId", "role", "nickname")
);

-- 곡에 남기는 한마디. 자켓 아래에서 한 줄씩 돌아가며 보인다.
CREATE TABLE IF NOT EXISTS songComments (
  "id" SERIAL PRIMARY KEY,
  "songId" INTEGER NOT NULL REFERENCES songs("id") ON DELETE CASCADE,
  "nickname" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
"""


# 이미 만들어진 DB를 새 구조로 맞춘다. 전부 멱등이라 매 기동마다 돌려도 무해하다.
# 변경 번호를 남기는 테이블. 폴링되는 목록이 읽는 테이블은 모두 여기 있어야 한다(listcache.py).
# pairs 는 뺀다 — 악보 넘길 때마다 써서 잦고, 어느 목록도 읽지 않는다.
CHANGE_TRACKED = ('songs', 'sessions', 'sessionSupports', 'songComments', 'sheets', 'events', 'eventDates',
                  'eventAvails', 'eventSongs', 'eventLineups', 'guilds', 'guildMembers', 'guildDrawings',
                  'members')

MIGRATIONS = [
    'CREATE INDEX IF NOT EXISTS idx_songcomments_song ON songComments ("songId", "id")',
    # 길드 꾸미기: 테마 이름과 문장(육각 틀 + 문양 + 색 둘)을 한 칸에 담는다.
    # {"theme":"miku","crest":{"shape":"wing","bg":"#00b8ad","fg":"#ffffff"}}
    # 값이 늘어도(글씨색·버튼·배경) 키만 붙으므로 마이그레이션이 다시 필요 없다.
    # 들어오는 값은 routers/guilds.py 가 화이트리스트로 거른다 — 자유 문자열은 안 받는다.
    'ALTER TABLE guilds ADD COLUMN IF NOT EXISTS "style" JSONB',
    # 길드 문장을 사진으로도 쓸 수 있게. 256px 정사각 WebP 한 장이고 육각으로 잘라 넣는다.
    # 사진이 있으면 문양보다 먼저다(프로필의 사진 > 이모지 > 첫 글자와 같은 규칙).
    'ALTER TABLE guilds ADD COLUMN IF NOT EXISTS "image" BYTEA',
    'ALTER TABLE guilds ADD COLUMN IF NOT EXISTS "imageUpdatedAt" TIMESTAMPTZ',
    # 프로필 대사 세 줄. 합주실 무대에서 말풍선으로 한 명씩 돌아가며 뜬다.
    # ["오늘은 손이 좀 굳었네", ...] 형태이고 routers/members.py 가 개수·길이를 자른다.
    'ALTER TABLE members ADD COLUMN IF NOT EXISTS "lines" JSONB',
    # 악보: 곡과의 결합 제거 + 분류/검색용 컬럼
    'ALTER TABLE sheets ADD COLUMN IF NOT EXISTS "artist" TEXT',
    'ALTER TABLE sheets ADD COLUMN IF NOT EXISTS "role" TEXT',
    'ALTER TABLE sheets ADD COLUMN IF NOT EXISTS "tags" TEXT',
    'ALTER TABLE sheets ADD COLUMN IF NOT EXISTS "bpm" INTEGER',
    'ALTER TABLE sheets ADD COLUMN IF NOT EXISTS "pages" INTEGER',
    'ALTER TABLE sheets DROP COLUMN IF EXISTS "kind"',
    'ALTER TABLE sheets ADD COLUMN IF NOT EXISTS "note" TEXT',
    'ALTER TABLE sheets ADD COLUMN IF NOT EXISTS "viewPrefs" TEXT',
    'ALTER TABLE sheets ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()',
    'ALTER TABLE sheets DROP COLUMN IF EXISTS "songId"',

    # 곡에도 태그를 붙인다(한 곡에 하나). 후보/예정/완료 상태를 대신한다.
    # status·isCandidate 컬럼은 합주 이력 개편 때 정리할 예정이라 그대로 둔다.
    'ALTER TABLE songs ADD COLUMN IF NOT EXISTS "tags" TEXT',
    'CREATE INDEX IF NOT EXISTS idx_songs_tags ON songs("tags")',

    # 외래키/조회 컬럼 인덱스. 유니크 제약이 이미 덮는 곳은 뺐다.
    'CREATE INDEX IF NOT EXISTS idx_sessions_song ON sessions("songId")',
    'CREATE INDEX IF NOT EXISTS idx_histories_song ON sessionHistories("songId")',
    'CREATE INDEX IF NOT EXISTS idx_sheets_role ON sheets("role")',
    'CREATE INDEX IF NOT EXISTS idx_sheets_created ON sheets("createdAt" DESC)',

    # 불법이륙 2.0: 길드 꼬리표, 끌올, 파트명 덮어쓰기, 지원 코멘트
    'ALTER TABLE songs ADD COLUMN IF NOT EXISTS "guildId" INTEGER REFERENCES guilds("id") ON DELETE SET NULL',
    'ALTER TABLE events ADD COLUMN IF NOT EXISTS "guildId" INTEGER REFERENCES guilds("id") ON DELETE SET NULL',
    'ALTER TABLE songs ADD COLUMN IF NOT EXISTS "bumpedBy" TEXT',
    'ALTER TABLE songs ADD COLUMN IF NOT EXISTS "bumpedAt" TIMESTAMPTZ',
    'ALTER TABLE songs ADD COLUMN IF NOT EXISTS "bumpNote" TEXT',
    'ALTER TABLE sessions ADD COLUMN IF NOT EXISTS "label" TEXT',
    # 파트는 여섯 개가 늘 있고, 쓰지 않는 파트는 지우는 게 아니라 끈다.
    # 지우면 같은 곡의 파트 구성이 곡마다 달라져 자리가 어긋나고, 되살릴 때
    # 새 id 가 생겨 지난 기록과 이어지지 않는다. 끄면 자리와 id 가 그대로 남는다.
    'ALTER TABLE sessions ADD COLUMN IF NOT EXISTS "active" BOOLEAN NOT NULL DEFAULT true',
    # 시트에 적힌 원문 표기. nickname 은 누구인지(신원), label 은 그날 뭐라고 적었는지(표기).
    # 둘을 나눠야 "3개월뒤쯤의식빵" 을 식빵으로 합치면서도 농담을 잃지 않는다.
    'ALTER TABLE sessionSupports ADD COLUMN IF NOT EXISTS "label" TEXT',
    # 길드 명단에도 같은 원칙. nickname 은 신원, label 은 시트에 적혀 있던 표기.
    'ALTER TABLE guildMembers ADD COLUMN IF NOT EXISTS "label" TEXT',
    # 자켓 그림. 유튜브 섬네일을 한 번 받아 두고 우리가 직접 준다.
    # 브라우저가 매번 구글에 요청하지 않도록 하기 위함이다. 장당 20KB 남짓.
    'ALTER TABLE songs ADD COLUMN IF NOT EXISTS "thumb" BYTEA',
    'ALTER TABLE songs ADD COLUMN IF NOT EXISTS "thumbVideoId" TEXT',
    'ALTER TABLE songs ADD COLUMN IF NOT EXISTS "thumbUpdatedAt" TIMESTAMPTZ',
    'CREATE INDEX IF NOT EXISTS idx_songs_guild ON songs("guildId")',
    'CREATE INDEX IF NOT EXISTS idx_events_guild ON events("guildId")',
    'CREATE INDEX IF NOT EXISTS idx_eventsongs_event ON eventSongs("eventId")',
    'CREATE INDEX IF NOT EXISTS idx_eventsongs_song ON eventSongs("songId")',
    'CREATE INDEX IF NOT EXISTS idx_eventlineups_event ON eventLineups("eventId")',
    'CREATE INDEX IF NOT EXISTS idx_guildmembers_guild ON guildMembers("guildId")',
    # 후보 날짜는 지우지 않고 끈다. 지우면 그 날 '된다'고 찍은 기록이 같이 사라진다.
    # (sessions.active 와 같은 이유·같은 방식)
    'ALTER TABLE eventDates ADD COLUMN IF NOT EXISTS "active" BOOLEAN NOT NULL DEFAULT true',

    # 2단계: 멤버 캐릭터 이미지 (256px 정사각형 WebP)
    'ALTER TABLE members ADD COLUMN IF NOT EXISTS "image" BYTEA',
    'ALTER TABLE members ADD COLUMN IF NOT EXISTS "imageUpdatedAt" TIMESTAMPTZ',
    # 파딱(방장) 'blue' · 핑딱(부방장) 'pink'. 관리 탭에서만 바꾼다(routers/admin.py).
    # 프로필 저장(PUT /api/members)의 EDITABLE 에 넣지 않는다 — 넣으면 누구나 자기에게 붙인다.
    'ALTER TABLE members ADD COLUMN IF NOT EXISTS "badge" TEXT',

    # 변경 번호. 폴링되는 목록을 "바뀌었을 때만" 다시 만들기 위해 쓴다(listcache.py).
    # 쓰기가 일어나면 테이블 이름을 한 줄 더한다. 앱의 쓰기든 손으로 친 SQL 이든 경로를 가리지 않는다.
    # 한 줄을 고치는 대신 더하는 이유: 동시에 쓸 때 같은 줄을 잠그다 교착되는 일이 없다.
    'CREATE TABLE IF NOT EXISTS "changeLog" ("id" BIGSERIAL PRIMARY KEY, "tableName" TEXT NOT NULL, '
    '"at" TIMESTAMPTZ NOT NULL DEFAULT now())',
    'CREATE INDEX IF NOT EXISTS idx_changelog_table ON "changeLog" ("tableName", "id")',
    """CREATE OR REPLACE FUNCTION note_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "changeLog" ("tableName") VALUES (TG_TABLE_NAME);
  RETURN NULL;
END $$""",
    *[f'CREATE OR REPLACE TRIGGER trg_note_change AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON {t} '
      f'FOR EACH STATEMENT EXECUTE FUNCTION note_change()' for t in CHANGE_TRACKED],
    # 기동할 때마다 테이블마다 마지막 줄만 남긴다. 번호가 바뀌어 목록이 한 번씩 다시 만들어질 뿐이다.
    'DELETE FROM "changeLog" c WHERE c."id" < '
    '(SELECT max(m."id") FROM "changeLog" m WHERE m."tableName" = c."tableName")',
]


def _counting_dict_row(cursor):
    """dict_row 그대로이되, 행을 만들 때마다 받은 크기를 metrics 에 더한다.
    모든 DB 접근이 get_db() 를 거치므로 여기 한 곳에서 전부 잡힌다."""
    make = dict_row(cursor)

    def row(values):
        metrics.add_db(metrics.row_size(values))
        return make(values)
    return row


class _TimedConnection(psycopg.Connection):
    """쿼리·커밋에 걸린 시간을 metrics 에 더한다. 느린 게 Neon 왕복인지 서버 CPU 인지 가르려고.
    execute 는 결과를 다 받은 뒤 돌아오므로(클라이언트 쪽 커서) fetch 는 따로 잴 것이 없다."""

    def execute(self, *args, **kwargs):
        t = time.perf_counter()
        try:
            return super().execute(*args, **kwargs)
        finally:
            metrics.add_db_time(time.perf_counter() - t)

    def commit(self):
        t = time.perf_counter()
        try:
            return super().commit()
        finally:
            metrics.add_db_time(time.perf_counter() - t)


def get_db():
    if not DATABASE_URL:
        raise RuntimeError('DATABASE_URL 환경변수를 설정하세요 (예: postgres://...)')
    t = time.perf_counter()
    try:
        # 요청마다 새로 연결한다. 연결(TLS·인증)도 기다리는 시간이라 같이 잰다.
        return _TimedConnection.connect(DATABASE_URL, row_factory=_counting_dict_row)
    finally:
        metrics.add_db_time(time.perf_counter() - t)


def init_db():
    with metrics.tagged('(boot)'):
        _init_db()


def _init_db():
    conn = get_db()
    conn.execute(SCHEMA)
    conn.commit()
    for statement in MIGRATIONS:
        try:
            conn.execute(statement)
            conn.commit()
        except Exception as exc:          # 이미 적용된 항목은 넘어간다
            conn.rollback()
            print(f'[migration] 건너뜀: {statement[:60]}... ({exc})')
    conn.close()
