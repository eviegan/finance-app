// server/index.js
import express from "express";
import cors from "cors";
import path from "path";
import crypto from "crypto"; 
import { fileURLToPath } from "url";
import { q, initTables } from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

const ORIGIN = process.env.CLIENT_ORIGIN || "*"; // tighten later
app.use(cors({ origin: ORIGIN }));
app.use(express.json());

// Serve the client (static)
app.use(express.static(path.join(__dirname, "..", "client")));

// --- Telegram WebApp auth verification (anti-cheat) ---
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-web-app
function parseInitData(initDataStr) {
  const params = new URLSearchParams(initDataStr);
  const data = {};
  for (const [k, v] of params.entries()) data[k] = v;
  return data;
}
function validateInitData(initDataStr, botToken) {
  if (!initDataStr) throw new Error("Missing initData");
  const data = parseInitData(initDataStr);
  const { hash, ...rest } = data;
  if (!hash) throw new Error("Missing hash");

  const sorted = Object.keys(rest).sort().map(k => `${k}=${rest[k]}`).join('\n');
  const secret = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const check = crypto.createHmac("sha256", secret).update(sorted).digest("hex");

  if (check !== hash) throw new Error("Bad hash");
  // Parse user JSON
  const user = rest.user ? JSON.parse(rest.user) : null;
  return { user, data: rest };
}

async function ensurePlayer(user){
  const res = await q(`
    INSERT INTO players (tg_user_id, username, first_name, last_name, photo_url)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (tg_user_id) DO UPDATE SET
      username = EXCLUDED.username,
      first_name = EXCLUDED.first_name,
      last_name = EXCLUDED.last_name,
      photo_url = EXCLUDED.photo_url
    RETURNING id, tg_user_id, username;
  `, [user.id, user.username || null, user.first_name || null, user.last_name || null, user.photo_url || null]);
  const player = res.rows[0];

  await q(`
    INSERT INTO game_state (player_id)
    VALUES ($1)
    ON CONFLICT (player_id) DO NOTHING;
  `, [player.id]);

  return player;
}

async function loadState(player_id){
  const { rows } = await q(`SELECT tokens, level, tap_power, energy, cap, regen_per_sec FROM game_state WHERE player_id=$1`, [player_id]);
  const st = rows[0];
  const upgrade_cost = Math.max(10, st.tap_power * 20); // simple curve
  return { ...st, upgrade_cost };
}

async function applyRegen(player_id){
  // Regen energy based on time since last_update
  const { rows } = await q(`SELECT energy, cap, regen_per_sec, last_update FROM game_state WHERE player_id=$1`, [player_id]);
  if(!rows[0]) return;
  const st = rows[0];
  const last = new Date(st.last_update).getTime();
  const now = Date.now();
  const dt = Math.max(0, (now - last)/1000);
  const newEnergy = Math.min(st.cap, Number(st.energy) + Number(st.regen_per_sec) * dt);
  await q(`UPDATE game_state SET energy=$1, last_update=NOW() WHERE player_id=$2`, [newEnergy, player_id]);
}

function requireEnv(name){
  if(!process.env[name]) throw new Error(`Missing env ${name}`);
  return process.env[name];
}

// --- Routes ---

app.post("/api/auth", async (req, res) => {
  try{
    const BOT_TOKEN = requireEnv("BOT_TOKEN");
    const { initData } = req.body;
    const { user } = validateInitData(initData, BOT_TOKEN);
    if(!user?.id) throw new Error("No user");

    const player = await ensurePlayer(user);
    await applyRegen(player.id);
    const state = await loadState(player.id);
    return res.json({ ok:true, username: user.username || null, state });
  }catch(err){
    return res.status(401).json({ ok:false, error: err.message });
  }
});

app.post("/api/tap", async (req, res) => {
  try{
    const BOT_TOKEN = requireEnv("BOT_TOKEN");
    const { initData } = req.body;
    const { user } = validateInitData(initData, BOT_TOKEN);
    const { rows } = await q(`SELECT id FROM players WHERE tg_user_id=$1`, [user.id]);
    if(!rows[0]) throw new Error("Player not found");
    const pid = rows[0].id;

    await applyRegen(pid);

    // Consume 1 energy and add tokens = tap_power
    const r = await q(`
      UPDATE game_state
      SET
        energy = GREATEST(0, energy - 1),
        tokens = tokens + tap_power,
        last_update = NOW()
      WHERE player_id=$1 AND energy >= 1
      RETURNING tokens, level, tap_power, energy, cap, regen_per_sec;
    `, [pid]);

    // If no energy, just return current state after regen
    if(r.rows.length === 0){
      const s = await loadState(pid);
      return res.json({ ok:true, state: s });
    }

    const s = r.rows[0];
    const state = { ...s, upgrade_cost: Math.max(10, s.tap_power * 20) };
    return res.json({ ok:true, state });
  }catch(err){
    return res.status(400).json({ ok:false, error: err.message });
  }
});

app.post("/api/upgrade", async (req, res) => {
  try{
    const BOT_TOKEN = requireEnv("BOT_TOKEN");
    const { initData } = req.body;
    const { user } = validateInitData(initData, BOT_TOKEN);
    const { rows } = await q(`SELECT id FROM players WHERE tg_user_id=$1`, [user.id]);
    if(!rows[0]) throw new Error("Player not found");
    const pid = rows[0].id;

    await applyRegen(pid);

    // calculate cost on DB side to prevent client tampering
    const r0 = await q(`SELECT tokens, tap_power FROM game_state WHERE player_id=$1`, [pid]);
    const cur = r0.rows[0];
    const cost = Math.max(10, Number(cur.tap_power) * 20);
    if(Number(cur.tokens) < cost) {
      const s = await loadState(pid);
      return res.json({ ok:false, error:'Not enough coins', state: s });
    }

    const r = await q(`
      UPDATE game_state
      SET tokens = tokens - $2, tap_power = tap_power + 1, last_update = NOW()
      WHERE player_id=$1
      RETURNING tokens, level, tap_power, energy, cap, regen_per_sec;
    `, [pid, cost]);
    const s = r.rows[0];
    const state = { ...s, upgrade_cost: Math.max(10, s.tap_power * 20) };
    return res.json({ ok:true, state });
  }catch(err){
    return res.status(400).json({ ok:false, error: err.message });
  }
});

app.get("/api/leaderboard", async (_req, res) => {
  const { rows } = await q(`
    SELECT p.username, gs.tokens
    FROM game_state gs
    JOIN players p ON p.id = gs.player_id
    ORDER BY gs.tokens DESC
    LIMIT 10;
  `);
  res.json({ ok:true, top: rows.map(r=>({ username:r.username, tokens: Number(r.tokens) })) });
});

// Fallback to client app for any non-API path
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "client", "index.html"));
});

const PORT = process.env.PORT || 3000;

(async () => {
  await initTables();
  app.listen(PORT, () => console.log(`Server on :${PORT}`));
})();
