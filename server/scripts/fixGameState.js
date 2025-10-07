// server/scripts/fixGameState.js (type: module)
import pkg from "pg";
const { Pool } = pkg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
const q = (t,p)=>pool.query(t,p);

(async () => {
  await q(`ALTER TABLE game_state ALTER COLUMN cap SET DEFAULT 100;`);
  await q(`ALTER TABLE game_state ALTER COLUMN energy SET DEFAULT 100;`);
  await q(`ALTER TABLE game_state ALTER COLUMN regen_per_sec SET DEFAULT 2;`);
  await q(`ALTER TABLE game_state ALTER COLUMN last_update SET DEFAULT NOW();`);
  await q(`
    UPDATE game_state SET
      cap = COALESCE(NULLIF(cap, 0), 100),
      regen_per_sec = COALESCE(NULLIF(regen_per_sec, 0), 2),
      energy = CASE WHEN energy IS NULL OR energy::numeric < 1 THEN 100 ELSE energy END,
      last_update = COALESCE(last_update, NOW());
  `);
  console.log("patched ✅"); process.exit(0);
})();
