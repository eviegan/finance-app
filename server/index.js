// server/index.js
import express from "express";
import cors from "cors";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { q, initTables } from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// CORS: during production set CLIENT_ORIGIN to your Render URL
const ORIGIN = process.env.CLIENT_ORIGIN || "*";
app.use(cors({ origin: ORIGIN }));
app.use(express.json());

// Serve client (same repo)
app.use(express.static(path.join(__dirname, "..", "client")));

/* =========================
   Telegram WebApp validation
   https://core.telegram.org/bots/webapps#validating-data-received-via-the-web-app
   ========================= */
function parseInitData(initDataStr = "") {
  const params = new URLSearchParams(initDataStr);
  const data = {};
  for (const [k, v] of params.entries()) data[k] = v;
  return data;
}

function validateInitData(initDataStr, botToken) {
  if (!initDataStr) throw new Error("Missing initData");
  const data = parseInitData(initDataStr);

  const hash = data.hash;
  if (!hash) throw new Error("Missing hash");

  // Exclude hash and build data_check_string
  const entries = Object.entries(data)
    .filter(([k]) => k !== "hash")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  const secret = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const check = crypto.createHmac("sha256", secret).update(entries).digest("hex");
  if (check !== hash) throw new Error("Bad initData hash");

  const user = data.user ? JSON.parse(data.user) : null;
  return { user, data };
}

async function ensurePlayer(user) {
  const res = await q(
    `
    INSERT INTO players (tg_user_id, username, first_name, last_name, photo_url)
    VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (tg_user_id) DO UPDATE SET
      username   = EXCLUDED.username,
      first_name = EXCLUDED.first_name,
      last_name  = EXCLUDED.last_name,
      photo_url  = EXCLUDED.photo_url
    RETURNING id, tg_user_id, username;
  `,
    [user.id, user.username || null, user.first_name || null, user.last_name || null, user.photo_url || null]
  );
  const player = res.rows[0];

  await q(
    `
    INSERT INTO game_state (player_id)
    VALUES ($1)
    ON CONFLICT (player_id) DO NOTHING;
  `,
    [player.id]
  );

  return player;
}

function safeNum(v, d) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
}

async function loadState(player_id) {
  const { rows } = await q(
    `SELECT tokens, level, tap_power, energy, cap, regen_per_sec FROM game_state WHERE player_id=$1`,
    [player_id]
  );
  const s = rows[0] || {};
  const st = {
    tokens: Number(s.tokens) || 0,
    level: Number(s.level) || 1,
    tap_power: safeNum(s.tap_power, 1),
    cap: safeNum(s.cap, 100),
    energy: Math.min(safeNum(s.cap, 100), Number(s.energy) ?? 100),
    regen_per_sec: safeNum(s.regen_per_sec, 2),
  };
  const upgrade_cost = Math.max(10, st.tap_power * 20);
  return { ...st, upgrade_cost };
}

async function applyRegen(player_id) {
  const { rows } = await q(
    `SELECT energy, cap, regen_per_sec, last_update FROM game_state WHERE player_id=$1`,
    [player_id]
  );
  if (!rows[0]) return;
  const st = rows[0];
  const last = new Date(st.last_update || Date.now()).getTime();
  const dt = Math.max(0, (Date.now() - last) / 1000);
  const cap = safeNum(st.cap, 100);
  const regen = safeNum(st.regen_per_sec, 2);
  const energy = Math.min(cap, Number(st.energy || 0) + regen * dt);
  await q(`UPDATE game_state SET energy=$1, last_update=NOW() WHERE player_id=$2`, [energy, player_id]);
}

function requireEnv(name) {
  if (!process.env[name]) throw new Error(`Missing env ${name}`);
  return process.env[name];
}

/* =========================
   Routes
   ========================= */

app.post("/api/auth", async (req, res) => {
  try {
    const BOT_TOKEN = requireEnv("BOT_TOKEN");
    const { initData } = req.body;
    const { user } = validateInitData(initData, BOT_TOKEN);
    if (!user?.id) throw new Error("No user in initData");

    const player = await ensurePlayer(user);
    await applyRegen(player.id);
    const state = await loadState(player.id);

    res.json({ ok: true, username: user.username || null, state });
  } catch (err) {
    res.status(401).json({ ok: false, error: err.message });
  }
});

app.post("/api/tap", async (req, res) => {
  try {
    const BOT_TOKEN = requireEnv("BOT_TOKEN");
    const { user } = validateInitData(req.body.initData, BOT_TOKEN);
    const { rows } = await q(`SELECT id FROM players WHERE tg_user_id=$1`, [user.id]);
    if (!rows[0]) throw new Error("Player not found");
    const pid = rows[0].id;

    await applyRegen(pid);

    // Spend 1 energy and add tokens = tap_power
    const r = await q(
      `
      UPDATE game_state
      SET
        energy = GREATEST(0, energy - 1),
        tokens = tokens + tap_power,
        last_update = NOW()
      WHERE player_id=$1 AND energy >= 1
      RETURNING tokens, level, tap_power, energy, cap, regen_per_sec;
    `,
      [pid]
    );

    let state;
    if (r.rows.length === 0) {
      // No energy - just return current state
      state = await loadState(pid);
    } else {
      const s = r.rows[0];
      state = {
        ...s,
        tokens: Number(s.tokens) || 0,
        tap_power: safeNum(s.tap_power, 1),
        energy: Number(s.energy) || 0,
        cap: safeNum(s.cap, 100),
        regen_per_sec: safeNum(s.regen_per_sec, 2),
        upgrade_cost: Math.max(10, safeNum(s.tap_power, 1) * 20),
      };
    }
    res.json({ ok: true, state });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post("/api/upgrade", async (req, res) => {
  try {
    const BOT_TOKEN = requireEnv("BOT_TOKEN");
    const { user } = validateInitData(req.body.initData, BOT_TOKEN);

    const { rows } = await q(`SELECT id FROM players WHERE tg_user_id=$1`, [user.id]);
    if (!rows[0]) throw new Error("Player not found");
    const pid = rows[0].id;

    await applyRegen(pid);

    // Load current values to compute server-side cost
    const cur = (await q(`SELECT tokens, tap_power FROM game_state WHERE player_id=$1`, [pid])).rows[0];
    const cost = Math.max(10, safeNum(cur.tap_power, 1) * 20);
    if (Number(cur.tokens) < cost) {
      const s = await loadState(pid);
      return res.json({ ok: false, error: "Not enough coins", state: s });
    }

    const r = await q(
      `
      UPDATE game_state
      SET tokens = tokens - $2,
          tap_power = tap_power + 1,
          last_update = NOW()
      WHERE player_id=$1
      RETURNING tokens, level, tap_power, energy, cap, regen_per_sec;
    `,
      [pid, cost]
    );

    const s = r.rows[0];
    const state = {
      ...s,
      tokens: Number(s.tokens) || 0,
      tap_power: safeNum(s.tap_power, 1),
      energy: Number(s.energy) || 0,
      cap: safeNum(s.cap, 100),
      regen_per_sec: safeNum(s.regen_per_sec, 2),
      upgrade_cost: Math.max(10, safeNum(s.tap_power, 1) * 20),
    };

    res.json({ ok: true, state });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.get("/api/leaderboard", async (_req, res) => {
  const { rows } = await q(
    `
    SELECT p.username, gs.tokens
    FROM game_state gs
    JOIN players p ON p.id = gs.player_id
    ORDER BY gs.tokens DESC
    LIMIT 10;
  `
  );
  res.json({
    ok: true,
    top: rows.map((r) => ({ username: r.username || "player", tokens: Number(r.tokens) || 0 })),
  });
});

// Optional: one-time admin patch endpoint (disable/remove after use)
// app.post("/api/admin/fix", async (req, res) => {
//   if ((req.query.key || req.body.key) !== process.env.ADMIN_KEY) return res.status(403).json({ ok:false });
//   try {
//     await initTables(); // will also repair bad rows
//     res.json({ ok:true });
//   } catch (e) {
//     res.status(500).json({ ok:false, error: e.message });
//   }
// });

// Fallback to client app for any non-API route
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "client", "index.html"));
});

const PORT = process.env.PORT || 3000;

(async () => {
  await initTables();
  app.listen(PORT, () => console.log(`Server on :${PORT}`));
})();
