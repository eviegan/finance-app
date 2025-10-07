// server/db.js
import pkg from "pg";
const { Pool } = pkg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false },
});

export async function q(text, params) {
  return pool.query(text, params);
}

export async function initTables() {
  // 1) Ensure base tables exist
  await q(`
    CREATE TABLE IF NOT EXISTS players (
      id SERIAL PRIMARY KEY,
      tg_user_id BIGINT UNIQUE NOT NULL,
      username TEXT,
      first_name TEXT,
      last_name TEXT,
      photo_url TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await q(`
    CREATE TABLE IF NOT EXISTS game_state (
      id SERIAL PRIMARY KEY,
      player_id INTEGER UNIQUE REFERENCES players(id) ON DELETE CASCADE,
      tokens NUMERIC,
      level INTEGER,
      tap_power INTEGER,
      energy NUMERIC,
      cap INTEGER,
      regen_per_sec NUMERIC
      -- last_update might be missing in older schemas
    );
  `);

  // 2) Add any missing columns (safe on existing DB)
  await q(`ALTER TABLE game_state ADD COLUMN IF NOT EXISTS tokens        NUMERIC;`);
  await q(`ALTER TABLE game_state ADD COLUMN IF NOT EXISTS level         INTEGER;`);
  await q(`ALTER TABLE game_state ADD COLUMN IF NOT EXISTS tap_power     INTEGER;`);
  await q(`ALTER TABLE game_state ADD COLUMN IF NOT EXISTS energy        NUMERIC;`);
  await q(`ALTER TABLE game_state ADD COLUMN IF NOT EXISTS cap           INTEGER;`);
  await q(`ALTER TABLE game_state ADD COLUMN IF NOT EXISTS regen_per_sec NUMERIC;`);
  await q(`ALTER TABLE game_state ADD COLUMN IF NOT EXISTS last_update   TIMESTAMP;`);

  // 3) Ensure defaults for NEW rows
  await q(`ALTER TABLE game_state ALTER COLUMN tokens        SET DEFAULT 0;`);
  await q(`ALTER TABLE game_state ALTER COLUMN level         SET DEFAULT 1;`);
  await q(`ALTER TABLE game_state ALTER COLUMN tap_power     SET DEFAULT 1;`);
  await q(`ALTER TABLE game_state ALTER COLUMN energy        SET DEFAULT 100;`);
  await q(`ALTER TABLE game_state ALTER COLUMN cap           SET DEFAULT 100;`);
  await q(`ALTER TABLE game_state ALTER COLUMN regen_per_sec SET DEFAULT 2;`);
  await q(`ALTER TABLE game_state ALTER COLUMN last_update   SET DEFAULT NOW();`);

  // 4) Patch EXISTING rows that are NULL or zero
  await q(`
    UPDATE game_state
    SET
      tokens        = COALESCE(tokens, 0),
      level         = COALESCE(level, 1),
      tap_power     = COALESCE(NULLIF(tap_power, 0), 1),
      cap           = COALESCE(NULLIF(cap, 0), 100),
      regen_per_sec = COALESCE(NULLIF(regen_per_sec, 0), 2),
      energy        = CASE WHEN energy IS NULL OR energy::numeric < 1 THEN 100 ELSE energy END,
      last_update   = COALESCE(last_update, NOW());
  `);

  // 5) Leaderboard index (safe if already present)
  await q(`CREATE INDEX IF NOT EXISTS idx_game_state_tokens ON game_state (tokens DESC);`);
}
