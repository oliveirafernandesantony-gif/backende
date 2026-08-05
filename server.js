/**
 * Live Max — License Server (JSON store, zero native deps)
 * v3 — multi-dispositivo (PC + celular no mesmo token, máx. 2)
 *     + durationSeconds, addSeconds/addDays, activity log
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
    if (fs.existsSync(DB_PATH)) {
      const data = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
      if (!Array.isArray(data.logs)) data.logs = [];
      if (!data.nextId) data.nextId = 1;
      if (!Array.isArray(data.tokens)) data.tokens = [];
      data.tokens.forEach((row) => {
        if (!Array.isArray(row.devices)) row.devices = [];
        if (row.device_id && !row.devices.some((d) => d && d.id === row.device_id)) {
          row.devices.push({
            id: row.device_id,
            type: row.device_type || "unknown",
            activated_at: row.activated_at || row.created_at || null,
            last_seen_at: row.last_seen_at || null
          });
        }
      });
      return data;
    }
  } catch (e) {
    console.error("[db]", e.message);
  }
  return { nextId: 1, tokens: [], logs: [] };
}

function saveDb(db) {
  // Mantém no máximo 200 logs
  if (db.logs && db.logs.length > 200) {
    db.logs = db.logs.slice(-200);
  }
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

/** Máx. dispositivos por token (PC extensão + app/celular). Override: MAX_DEVICES=2 */
const MAX_DEVICES = Math.max(1, Number(process.env.MAX_DEVICES) || 2);

/** Garante row.devices[] (migra device_id legado). */
function ensureDevices(row) {
  if (!Array.isArray(row.devices)) row.devices = [];
  if (row.device_id) {
    const exists = row.devices.some((d) => d && d.id === row.device_id);
    if (!exists) {
      row.devices.push({
        id: row.device_id,
        type: row.device_type || "unknown",
        activated_at: row.activated_at || row.created_at || nowISO(),
        last_seen_at: row.last_seen_at || null
      });
    }
  }
  row.device_id = row.devices.length ? row.devices[0].id : null;
  return row.devices;
}

function findDevice(row, deviceId) {
  ensureDevices(row);
  return row.devices.find((d) => d && d.id === deviceId) || null;
}

function addLog(action, detail = "") {
  if (!db.logs) db.logs = [];
  db.logs.push({
    id: Date.now() + Math.random(),
    at: nowISO(),
    action,
    detail: String(detail).slice(0, 300)
  });
}

function tokenPayload(row) {
  const expired = isExpired(row);
  const status = row.status === "revoked" ? "revoked" : expired ? "expired" : row.status;
  const devices = ensureDevices(row).map((d) => ({
    id: d.id,
    type: d.type || "unknown",
    activatedAt: d.activated_at || null,
    lastSeenAt: d.last_seen_at || null
  }));
  return {
    id: row.id,
    token: row.token,
    status,
    deviceId: devices[0]?.id || null,
    devices,
    deviceCount: devices.length,
    maxDevices: MAX_DEVICES,
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

function doValidate(token, deviceId, deviceType) {
  const cleanToken = String(token || "").trim().toUpperCase();
  const cleanDevice = String(deviceId || "").trim().slice(0, 128);
  const cleanType = String(deviceType || "unknown").trim().slice(0, 32).toLowerCase() || "unknown";
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

  const devices = ensureDevices(row);
  let device = findDevice(row, cleanDevice);
  let isNewSlot = false;
  let isFirstActivation = false;

  if (device) {
    device.last_seen_at = nowISO();
    if (cleanType !== "unknown") device.type = cleanType;
  } else {
    if (devices.length >= MAX_DEVICES) {
      const slots = devices
        .map((d) => (d.type || "?") + "…" + String(d.id).slice(-6))
        .join(", ");
      return {
        status: 200,
        body: {
          ok: true,
          valid: false,
          error:
            "Limite de " +
            MAX_DEVICES +
            " dispositivos atingido (" +
            slots +
            "). Desvincule um no painel admin.",
          deviceCount: devices.length,
          maxDevices: MAX_DEVICES
        }
      };
    }
    isNewSlot = true;
    isFirstActivation = devices.length === 0;
    device = {
      id: cleanDevice,
      type: cleanType,
      activated_at: nowISO(),
      last_seen_at: nowISO()
    };
    devices.push(device);
    if (isFirstActivation) row.activated_at = device.activated_at;
  }

  row.device_id = devices[0].id;
  row.last_seen_at = nowISO();
  saveDb(db);

  let message = "Token válido";
  if (isFirstActivation) message = "Token ativado neste dispositivo";
  else if (isNewSlot)
    message =
      "Dispositivo ativado (" +
      devices.length +
      "/" +
      MAX_DEVICES +
      ") — PC e celular podem usar o mesmo token";

  return {
    status: 200,
    body: {
      ok: true,
      valid: true,
      expiresAt: row.expires_at || null,
      firstActivation: isFirstActivation,
      deviceCount: devices.length,
      maxDevices: MAX_DEVICES,
      deviceType: device.type,
      message
    }
  };
}

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: "32kb" }));

// Serve admin estático (pasta ../admin ou ./admin)
const adminCandidates = [
  path.join(__dirname, "..", "admin"),
  path.join(__dirname, "admin"),
  path.join(__dirname, "public")
];
for (const p of adminCandidates) {
  if (fs.existsSync(p)) {
    app.use("/admin", express.static(p));
    break;
  }
}

app.get("/", (_req, res) => {
  res.json({ name: "Live Max License Server", version: "2.0", admin: "/admin/", health: "ok" });
});

app.post("/api/validate", (req, res) => {
  try {
    const result = doValidate(req.body?.token, req.body?.deviceId, req.body?.deviceType);
    res.status(result.status).json(result.body);
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, valid: false, error: "Erro interno" });
  }
});

app.post("/api/heartbeat", (req, res) => {
  try {
    const result = doValidate(req.body?.token, req.body?.deviceId, req.body?.deviceType);
    res.status(result.status).json(result.body);
  } catch (err) {
    res.status(500).json({ ok: false, valid: false, error: "Erro interno" });
  }
});

// ========== ADMIN ==========

app.get("/api/admin/tokens", requireAdmin, (_req, res) => {
  res.json({ ok: true, tokens: db.tokens.map(tokenPayload).reverse() });
});

app.post("/api/admin/tokens", requireAdmin, (req, res) => {
  const body = req.body || {};
  const qty = Math.min(50, Math.max(1, Number(body.quantity) || 1));
  const note = String(body.note || "").slice(0, 200);

  // Prioridade: durationSeconds > days (aceita decimal)
  let durationMs = null;
  if (body.durationSeconds !== undefined && body.durationSeconds !== null) {
    const secs = Number(body.durationSeconds);
    if (secs > 0) durationMs = secs * 1000;
  } else if (body.days !== undefined && body.days !== null) {
    const daysNum = Number(body.days);
    if (daysNum > 0) durationMs = daysNum * 86400000;
  }

  const expiresAt = durationMs ? new Date(Date.now() + durationMs).toISOString() : null;
  const created = [];

  for (let i = 0; i < qty; i++) {
    let token, tries = 0;
    do {
      token = genToken();
      tries++;
    } while (db.tokens.some((t) => t.token === token) && tries < 20);

    const row = {
      id: db.nextId++,
      token,
      status: "active",
      device_id: null,
      devices: [],
      expires_at: expiresAt,
      note,
      created_at: nowISO(),
      last_seen_at: null,
      activated_at: null
    };
    db.tokens.push(row);
    created.push(tokenPayload(row));
  }

  addLog("generate", `${qty} token(s) gerado(s)${expiresAt ? ` · expira ${expiresAt}` : " · permanente"}`);
  saveDb(db);
  res.json({ ok: true, tokens: created });
});

app.patch("/api/admin/tokens/:id", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const row = db.tokens.find((t) => t.id === id);
  if (!row) return res.status(404).json({ ok: false, error: "Token não encontrado" });

  const body = req.body || {};
  const { status, expiresAt, note, unbind } = body;

  // Renovação: addSeconds ou addDays
  if (body.addSeconds !== undefined || body.addDays !== undefined) {
    let addMs = 0;
    if (body.addSeconds !== undefined) {
      addMs = Number(body.addSeconds) * 1000;
    } else if (body.addDays !== undefined) {
      addMs = Number(body.addDays) * 86400000;
    }

    if (addMs > 0) {
      const base = row.expires_at && new Date(row.expires_at).getTime() > Date.now()
        ? new Date(row.expires_at).getTime()
        : Date.now();
      row.expires_at = new Date(base + addMs).toISOString();
      // Se estava expired, reativa
      if (row.status === "expired") row.status = "active";
      addLog("renew", `Token #${id} (${row.token}) +${Math.round(addMs / 1000)}s`);
    }
  }

  if (status && ["active", "revoked", "expired"].includes(status)) {
    row.status = status;
    addLog(status === "revoked" ? "revoke" : "reactivate", `Token #${id} (${row.token})`);
  }

  if (expiresAt !== undefined) {
    row.expires_at = expiresAt === null || expiresAt === "" ? null : String(expiresAt);
  }

  if (note !== undefined) {
    row.note = String(note).slice(0, 200);
  }

  if (unbind === true) {
    if (body.unbindDeviceId) {
      ensureDevices(row);
      const before = row.devices.length;
      row.devices = row.devices.filter((d) => d.id !== String(body.unbindDeviceId));
      row.device_id = row.devices[0]?.id || null;
      if (!row.devices.length) row.activated_at = null;
      addLog("unbind", `Token #${id} device ${body.unbindDeviceId} (${before}→${row.devices.length})`);
    } else {
      row.device_id = null;
      row.devices = [];
      row.activated_at = null;
      addLog("unbind", `Token #${id} (${row.token}) — todos os dispositivos`);
    }
  }

  saveDb(db);
  res.json({ ok: true, token: tokenPayload(row) });
});

app.delete("/api/admin/tokens/:id", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const idx = db.tokens.findIndex((t) => t.id === id);
  if (idx === -1) return res.status(404).json({ ok: false, error: "Token não encontrado" });

  const removed = db.tokens[idx];
  db.tokens.splice(idx, 1);
  addLog("delete", `Token #${id} (${removed.token})`);
  saveDb(db);
  res.json({ ok: true });
});

app.get("/api/admin/stats", requireAdmin, (_req, res) => {
  const total = db.tokens.length;
  const active = db.tokens.filter((t) => t.status === "active" && !isExpired(t)).length;
  const revoked = db.tokens.filter((t) => t.status === "revoked").length;
  const bound = db.tokens.filter((t) => {
    ensureDevices(t);
    return (t.devices && t.devices.length > 0) || !!t.device_id;
  }).length;
  res.json({ ok: true, total, active, revoked, bound });
});

// Log de atividade persistente
app.get("/api/admin/logs", requireAdmin, (_req, res) => {
  const logs = (db.logs || []).slice().reverse().slice(0, 100);
  res.json({ ok: true, logs });
});

app.delete("/api/admin/logs", requireAdmin, (_req, res) => {
  db.logs = [];
  saveDb(db);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`\n✅ Live Max License Server v3 em http://localhost:${PORT}`);
  console.log(`   Painel: http://localhost:${PORT}/admin/`);
  console.log(`   ADMIN_KEY: ${ADMIN_KEY}`);
  console.log(`   MAX_DEVICES: ${MAX_DEVICES} (PC + celular no mesmo token)\n`);
});
