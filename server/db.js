// server/db.js
import pkg from "pg";
const { Pool } = pkg;

/**
 * Pool with SSL enabled on Render and similar hosts.
 * For local dev you can set PGSSLMODE=disable
 */
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false },
});

export async function q(text, params) {
  return pool.query(text, params);
}

/**
 * Create tables (if missing) and harden defaults so
 * new & existing rows always have sane energy values.
 */
export async function initTables() {
  // Players
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

  // Game state
  await q(`
    CREATE TABLE IF NOT EXISTS game_state (
      id SERIAL PRIMARY KEY,
      player_id INTEGER UNIQUE REFERENCES players(id) ON DELETE CASCADE,
      tokens NUMERIC DEFAULT 0,
      level INTEGER DEFAULT 1,
      tap_power INTEGER DEFAULT 1,
      energy NUMERIC DEFAULT 100,
      cap INTEGER DEFAULT 100,
      regen_per_sec NUMERIC DEFAULT 2,
      last_update TIMESTAMP DEFAULT NOW()
    );
  `);

  // Index for leaderboard
  await q(`CREATE INDEX IF NOT EXISTS idx_game_state_tokens ON game_state (tokens DESC);`);

  // Ensure defaults (in case table created earlier without them)
  await q(`ALTER TABLE game_state ALTER COLUMN cap           SET DEFAULT 100;`);
  await q(`ALTER TABLE game_state ALTER COLUMN energy        SET DEFAULT 100;`);
  await q(`ALTER TABLE game_state ALTER COLUMN regen_per_sec SET DEFAULT 2;`);
  await q(`ALTER TABLE game_state ALTER COLUMN last_update   SET DEFAULT NOW();`);

  // Repair any existing bad rows (0 or NULL values)
  await q(`
    UPDATE game_state
    SET
      cap           = COALESCE(NULLIF(cap, 0), 100),
      regen_per_sec = COALESCE(NULLIF(regen_per_sec, 0), 2),
      energy        = CASE WHEN energy IS NULL OR energy::numeric < 1 THEN 100 ELSE energy END,
      last_update   = COALESCE(last_update, NOW())
    WHERE TRUE;
  `);
}
