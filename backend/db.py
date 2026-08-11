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

CREATE TABLE IF NOT EXISTS sheets (
  "id" SERIAL PRIMARY KEY,
  "songId" INTEGER NOT NULL REFERENCES songs("id") ON DELETE CASCADE,
  "title" TEXT NOT NULL,
  "fileName" TEXT,
  "content" BYTEA NOT NULL,
  "uploadedBy" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS lotteries (
  "id" SERIAL PRIMARY KEY,
  "drawnBy" TEXT,
  "poolJson" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS lotteryItems (
  "id" SERIAL PRIMARY KEY,
  "lotteryId" INTEGER NOT NULL REFERENCES lotteries("id") ON DELETE CASCADE,
  "songId" INTEGER NOT NULL REFERENCES songs("id") ON DELETE CASCADE,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
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
"""


def get_db():
    if not DATABASE_URL:
        raise RuntimeError('DATABASE_URL 환경변수를 설정하세요 (예: postgres://...)')
    return psycopg.connect(DATABASE_URL, row_factory=dict_row)


def init_db():
    conn = get_db()
    conn.execute(SCHEMA)
    conn.commit()
    conn.close()
