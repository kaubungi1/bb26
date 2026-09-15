import os

import psycopg
from dotenv import load_dotenv
from psycopg.rows import dict_row

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
"""


# 이미 만들어진 DB를 새 구조로 맞춘다. 전부 멱등이라 매 기동마다 돌려도 무해하다.
MIGRATIONS = [
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
    'ALTER TABLE sessionSupports ADD COLUMN IF NOT EXISTS "comment" TEXT',
    'CREATE INDEX IF NOT EXISTS idx_songs_guild ON songs("guildId")',
    'CREATE INDEX IF NOT EXISTS idx_events_guild ON events("guildId")',
    'CREATE INDEX IF NOT EXISTS idx_eventsongs_event ON eventSongs("eventId")',
    'CREATE INDEX IF NOT EXISTS idx_eventsongs_song ON eventSongs("songId")',
    'CREATE INDEX IF NOT EXISTS idx_eventlineups_event ON eventLineups("eventId")',
    'CREATE INDEX IF NOT EXISTS idx_guildmembers_guild ON guildMembers("guildId")',
]


def get_db():
    if not DATABASE_URL:
        raise RuntimeError('DATABASE_URL 환경변수를 설정하세요 (예: postgres://...)')
    return psycopg.connect(DATABASE_URL, row_factory=dict_row)


def init_db():
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
