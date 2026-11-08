import Database from 'better-sqlite3';
import fs from 'node:fs'; import path from 'node:path';
const file = process.env.DB_PATH || './data/app.db';
fs.mkdirSync(path.dirname(file), { recursive: true });
export const db = new Database(file);
db.pragma('journal_mode = WAL');
db.exec(`CREATE TABLE IF NOT EXISTS matches(
 fixture_id INTEGER PRIMARY KEY, slug TEXT UNIQUE NOT NULL, match_date TEXT NOT NULL, kickoff_ts INTEGER NOT NULL,
 league_id INTEGER, league_name TEXT, league_country TEXT, league_logo TEXT, season INTEGER, round TEXT,
 home_id INTEGER, home_name TEXT, home_logo TEXT, away_id INTEGER, away_name TEXT, away_logo TEXT,
 venue TEXT, status TEXT, goals_home INTEGER, goals_away INTEGER,
 analysis TEXT, prediction TEXT, lineups TEXT, lineups_try INTEGER DEFAULT 0, enriched_at INTEGER, updated_at INTEGER);
CREATE INDEX IF NOT EXISTS idx_date ON matches(match_date, kickoff_ts);
CREATE TABLE IF NOT EXISTS sync_log(id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, job TEXT, ok INTEGER, msg TEXT);`);
// Migrations (ασφαλείς για υπάρχουσα βάση)
const cols = db.prepare('PRAGMA table_info(matches)').all().map(c => c.name);
for (const [c, t] of [['ht_home', 'INTEGER'], ['ht_away', 'INTEGER'], ['ft_home', 'INTEGER'], ['ft_away', 'INTEGER'], ['corners', 'INTEGER'], ['hidden', 'INTEGER DEFAULT 0']])
  if (!cols.includes(c)) db.exec(`ALTER TABLE matches ADD COLUMN ${c} ${t}`);
db.exec(`CREATE TABLE IF NOT EXISTS picks(fixture_id INTEGER PRIMARY KEY, pick_id TEXT, label TEXT, market TEXT, pct INTEGER, confidence TEXT, source TEXT, created_at INTEGER, result TEXT, settled_at INTEGER)`);
