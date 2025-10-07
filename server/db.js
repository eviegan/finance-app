// server/db.js
import pkg from "pg";
const { Pool } = pkg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
});

export async function q(text, params) {
  return pool.query(text, params);
}

// Auto-create tables on boot
export async function initTables(){
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
      tokens NUMERIC DEFAULT 0,
      level INTEGER DEFAULT 1,
      tap_power INTEGER DEFAULT 1,
      energy NUMERIC DEFAULT 100,
      cap INTEGER DEFAULT 100,
      regen_per_sec NUMERIC DEFAULT 2,
      last_update TIMESTAMP DEFAULT NOW()
    );
  `);

  // Leaderboard helper index
  await q(`CREATE INDEX IF NOT EXISTS idx_game_state_tokens ON game_state(tokens DESC);`);
}
