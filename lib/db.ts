import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { seedDemoUsers } from "./seed";

let _db: Database.Database | null = null;

export function db(): Database.Database {
  if (_db) return _db;
  const dir = path.join(process.cwd(), "data");
  fs.mkdirSync(dir, { recursive: true });
  _db = new Database(path.join(dir, "app.db"));
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");
  migrate(_db);
  const count = (_db.prepare("SELECT COUNT(*) AS c FROM users").get() as { c: number }).c;
  if (count === 0) seedDemoUsers(_db);
  return _db;
}

function migrate(d: Database.Database) {
  d.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    gender TEXT NOT NULL DEFAULT 'M',
    birth_year INTEGER NOT NULL DEFAULT 1998,
    region TEXT NOT NULL DEFAULT '서울',
    height_cm INTEGER NOT NULL DEFAULT 170,
    job TEXT NOT NULL DEFAULT '직장인',
    education TEXT NOT NULL DEFAULT '대졸',
    smoking TEXT NOT NULL DEFAULT '비흡연',
    drinking TEXT NOT NULL DEFAULT '가끔',
    religion TEXT NOT NULL DEFAULT '무교',
    mbti TEXT NOT NULL DEFAULT 'ENFP',
    lifestyle TEXT NOT NULL DEFAULT '{}',
    personality TEXT NOT NULL DEFAULT '{}',
    values_json TEXT NOT NULL DEFAULT '{}',
    rel_style TEXT NOT NULL DEFAULT '{}',
    weights TEXT NOT NULL DEFAULT '{}',
    dealbreakers TEXT NOT NULL DEFAULT '{}',
    face_vec TEXT NOT NULL DEFAULT '[]',
    face_pref_vec TEXT NOT NULL DEFAULT '[]',
    phone_verified INTEGER NOT NULL DEFAULT 0,
    face_verified INTEGER NOT NULL DEFAULT 0,
    plan TEXT NOT NULL DEFAULT 'free',
    is_demo INTEGER NOT NULL DEFAULT 0,
    onboarded INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- 하루 추천. bucket: confident(높은 확신) | other_strength(다른 궁합 강함) | explore(탐색)
  CREATE TABLE IF NOT EXISTS recommendations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    target_id INTEGER NOT NULL REFERENCES users(id),
    rec_date TEXT NOT NULL,
    bucket TEXT NOT NULL,
    score_ab REAL NOT NULL,
    score_ba REAL NOT NULL,
    components TEXT NOT NULL DEFAULT '{}',
    decision TEXT NOT NULL DEFAULT 'pending', -- pending | liked | passed
    decided_at TEXT,
    UNIQUE(user_id, target_id, rec_date)
  );

  CREATE TABLE IF NOT EXISTS likes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id INTEGER NOT NULL REFERENCES users(id),
    to_id INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(from_id, to_id)
  );

  CREATE TABLE IF NOT EXISTS matches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_a INTEGER NOT NULL REFERENCES users(id),
    user_b INTEGER NOT NULL REFERENCES users(id),
    meet_a TEXT, -- 'yes' | 'not_yet'
    meet_b TEXT,
    meet_confirmed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_a, user_b)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    match_id INTEGER NOT NULL REFERENCES matches(id),
    sender_id INTEGER NOT NULL, -- 0이면 AI Icebreaker 시스템 메시지
    body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS feedbacks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    match_id INTEGER NOT NULL REFERENCES matches(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    meet_again INTEGER NOT NULL,
    looks_fit INTEGER,
    talk_comfortable INTEGER,
    values_fit INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(match_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS blocks (
    blocker_id INTEGER NOT NULL REFERENCES users(id),
    blocked_id INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (blocker_id, blocked_id)
  );

  CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reporter_id INTEGER NOT NULL REFERENCES users(id),
    reported_id INTEGER NOT NULL REFERENCES users(id),
    reason TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- 개인 Dating Model 학습용 행동 이벤트 로그
  CREATE TABLE IF NOT EXISTS behavior_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    target_id INTEGER,
    event TEXT NOT NULL, -- like | pass | first_message | reply | meet_yes | meet_not_yet | feedback_again | feedback_no
    meta TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  `);
}
