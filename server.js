/**
 * Live Max — License Server (JSON store, zero native deps)
 */
const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const PORT = process.env.PORT || 3847;
const ADMIN_KEY = process.env.ADMIN_KEY || "mude-esta-chave-agora";
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "licenses.json");

function loadDb() {
  try {
    if (fs.existsSync(DB_PATH)) return JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
  } catch (e) {
    console.error("[db]", e.message);
  }
  return { nextId: 1, tokens: [] };
}

function saveDb(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), "utf8");
}

let db = loadDb();

function genToken() {
  const part = () => crypto.randomBytes(2).toString("hex").toUpperCase();
  return `LM-${part()}-${part()}-${part()}`;
}

function nowISO() {
  return new Date().toISOString();
}

function isExpired(row) {
  if (!row.expires_at) return false;
  return new Date(row.expires_at).getTime() < Date.now();
}

function tokenPayload(row) {
  const expired = isExpired(row);
  const status = row.status === "revoked" ? "revoked" : expired ? "expired" : row.status;
  return {
    id: row.id,
    token: row.token,
    status,
    deviceId: row.device_id || null,
    expiresAt: row.expires_at || null,
    note: row.note || "",
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at || null,
    activatedAt: row.activated_at || null
  };
}

function requireAdmin(req, res, next) {
  const key = req.headers["x-admin-key"] || req.query.adminKey;
  if (!key || key !== ADMIN_KEY) return res.status(401).json({ ok: false, error: "Não autorizado" });
  next();
}

function doValidate(token, deviceId) {
  const cleanToken = String(token || "").trim().toUpperCase();
  const cleanDevice = String(deviceId || "").trim().slice(0, 128);
  if (!cleanToken || !cleanDevice) {
    return { status: 400, body: { ok: false, valid: false, error: "token e deviceId são obrigatórios" } };
  }
  const row = db.tokens.find((t) => t.token === cleanToken);
  if (!row) return { status: 200, body: { ok: true, valid: false, error: "Token inválido" } };
  if (row.status === "revoked") return { status: 200, body: { ok: true, valid: false, error: "Token revogado" } };
  if (isExpired(row)) {
    row.status = "expired";
    saveDb(db);
    return { status: 200, body: { ok: true, valid: false, error: "Token expirado" } };
  }
  if (row.device_id && row.device_id !== cleanDevice) {
    return { status: 200, body: { ok: true, valid: false, error: "Token já está em uso em outro dispositivo" } };
  }
  const isFirstActivation = !row.device_id;
  if (isFirstActivation) {
    row.device_id = cleanDevice;
    row.activated_at = nowISO();
  }
  row.last_seen_at = nowISO();
  saveDb(db);
  return {
    status: 200,
    body: {
      ok: true,
      valid: true,
      expiresAt: row.expires_at || null,
      firstActivation: isFirstActivation,
      message: isFirstActivation ? "Token ativado neste dispositivo" : "Token válido"
    }
  };
}

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: "32kb" }));

const adminPath = path.join(__dirname, "..", "admin");
if (fs.existsSync(adminPath)) app.use("/admin", express.static(adminPath));

app.get("/", (_req, res) => {
  res.json({ name: "Live Max License Server", version: "1.0", admin: "/admin/", health: "ok" });
});

app.post("/api/validate", (req, res) => {
  try {
    const result = doValidate(req.body?.token, req.body?.deviceId);
    res.status(result.status).json(result.body);
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, valid: false, error: "Erro interno" });
  }
});

app.post("/api/heartbeat", (req, res) => {
  try {
    const result = doValidate(req.body?.token, req.body?.deviceId);
    res.status(result.status).json(result.body);
  } catch (err) {
    res.status(500).json({ ok: false, valid: false, error: "Erro interno" });
  }
});

app.get("/api/admin/tokens", requireAdmin, (_req, res) => {
  res.json({ ok: true, tokens: db.tokens.map(tokenPayload).reverse() });
});

app.post("/api/admin/tokens", requireAdmin, (req, res) => {
  const { days = 30, note = "", quantity = 1 } = req.body || {};
  const qty = Math.min(50, Math.max(1, Number(quantity) || 1));
  const daysNum = Number(days);
  const expiresAt = daysNum > 0 ? new Date(Date.now() + daysNum * 86400000).toISOString() : null;
  const created = [];
  for (let i = 0; i < qty; i++) {
    let token, tries = 0;
    do { token = genToken(); tries++; } while (db.tokens.some((t) => t.token === token) && tries < 20);
    const row = {
      id: db.nextId++,
      token,
      status: "active",
      device_id: null,
      expires_at: expiresAt,
      note: String(note || "").slice(0, 200),
      created_at: nowISO(),
      last_seen_at: null,
      activated_at: null
    };
    db.tokens.push(row);
    created.push(tokenPayload(row));
  }
  saveDb(db);
  res.json({ ok: true, tokens: created });
});

app.patch("/api/admin/tokens/:id", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const row = db.tokens.find((t) => t.id === id);
  if (!row) return res.status(404).json({ ok: false, error: "Token não encontrado" });
  const { status, expiresAt, note, unbind } = req.body || {};
  if (status && ["active", "revoked", "expired"].includes(status)) row.status = status;
  if (expiresAt !== undefined) row.expires_at = expiresAt === null || expiresAt === "" ? null : String(expiresAt);
  if (note !== undefined) row.note = String(note).slice(0, 200);
  if (unbind === true) { row.device_id = null; row.activated_at = null; }
  saveDb(db);
  res.json({ ok: true, token: tokenPayload(row) });
});

app.delete("/api/admin/tokens/:id", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const idx = db.tokens.findIndex((t) => t.id === id);
  if (idx === -1) return res.status(404).json({ ok: false, error: "Token não encontrado" });
  db.tokens.splice(idx, 1);
  saveDb(db);
  res.json({ ok: true });
});

app.get("/api/admin/stats", requireAdmin, (_req, res) => {
  const total = db.tokens.length;
  const active = db.tokens.filter((t) => t.status === "active" && !isExpired(t)).length;
  const revoked = db.tokens.filter((t) => t.status === "revoked").length;
  const bound = db.tokens.filter((t) => t.device_id).length;
  res.json({ ok: true, total, active, revoked, bound });
});

app.listen(PORT, () => {
  console.log(`\n✅ Live Max License Server em http://localhost:${PORT}`);
  console.log(`   Painel: http://localhost:${PORT}/admin/`);
  console.log(`   ADMIN_KEY: ${ADMIN_KEY}\n`);
});
