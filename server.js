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
let webpush = null;
try {
  webpush = require("web-push");
} catch (e) {
  console.warn("[push] web-push não instalado — rode: npm install web-push");
}

const PORT = process.env.PORT || 3847;
const ADMIN_KEY = process.env.ADMIN_KEY || "mude-esta-chave-agora";
// Tokens ficam em arquivo JSON.
// No Render: crie um Persistent Disk e defina DB_PATH=/var/data/licenses.json
// Assim os tokens NÃO somem a cada deploy.
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "licenses.json");

function loadDb() {
  try {
    if (fs.existsSync(DB_PATH)) {
      const data = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
      if (!Array.isArray(data.logs)) data.logs = [];
      if (!data.nextId) data.nextId = 1;
      if (!Array.isArray(data.tokens)) data.tokens = [];
      if (!Array.isArray(data.pushSubscriptions)) data.pushSubscriptions = [];
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
  return { nextId: 1, tokens: [], logs: [], pushSubscriptions: [] };
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

/** Máx. dispositivos padrão por token (PC + celular). Override global: MAX_DEVICES=2 */
const MAX_DEVICES = Math.max(1, Number(process.env.MAX_DEVICES) || 2);

/** Limite efetivo do token (por-token max_devices ou padrão global). */
function getMaxDevices(row) {
  const n = row && row.max_devices != null ? Number(row.max_devices) : MAX_DEVICES;
  if (isNaN(n) || n < 1) return MAX_DEVICES;
  return Math.min(20, Math.max(1, Math.floor(n))); // 1..20
}

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
    maxDevices: getMaxDevices(row),
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
    const maxDev = getMaxDevices(row);
    if (devices.length >= maxDev) {
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
            maxDev +
            " dispositivos atingido (" +
            slots +
            "). Desvincule um no painel admin ou aumente o limite do token.",
          deviceCount: devices.length,
          maxDevices: maxDev
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

  const maxDevOk = getMaxDevices(row);
  let message = "Token válido";
  if (isFirstActivation) message = "Token ativado neste dispositivo";
  else if (isNewSlot)
    message =
      "Dispositivo ativado (" +
      devices.length +
      "/" +
      maxDevOk +
      ") — slots: " +
      devices.length +
      "/" +
      maxDevOk;

  return {
    status: 200,
    body: {
      ok: true,
      valid: true,
      expiresAt: row.expires_at || null,
      firstActivation: isFirstActivation,
      deviceCount: devices.length,
      maxDevices: maxDevOk,
      deviceType: device.type,
      message
    }
  };
}


// ========== WEB PUSH ==========
const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY || "BJlg0lEx0x7bs2B61BN7mlooYPbHv_3svXtLMiT43wV_faEoRa-Bw51CfuYWaWMhr1vJgwCncjDLeY8jWjN91PE";
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || "l_OMaFOT3SO4pOkfxpQscoRFCIwiU4_ueT2BGOs56uU";
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:livemax@local";

if (webpush && VAPID_PUBLIC && VAPID_PRIVATE) {
  try {
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
    console.log("[push] VAPID configurado");
  } catch (e) {
    console.warn("[push] VAPID inválido:", e.message);
  }
}

function ensurePushList(dbObj) {
  if (!Array.isArray(dbObj.pushSubscriptions)) dbObj.pushSubscriptions = [];
  return dbObj.pushSubscriptions;
}

async function sendPushToToken(token, payload) {
  if (!webpush) return { sent: 0, error: "web-push não instalado" };
  const clean = String(token || "").trim().toUpperCase();
  if (!clean) return { sent: 0, error: "token obrigatório" };
  const list = ensurePushList(db);
  const subs = list.filter((s) => s.token === clean);
  if (!subs.length) return { sent: 0, error: "nenhuma inscrição para este token" };

  const body = typeof payload === "string" ? payload : JSON.stringify(payload || {});
  let sent = 0;
  const keep = [];
  const allOthers = list.filter((s) => s.token !== clean);

  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: sub.keys
        },
        body,
        { TTL: 60 * 60 }
      );
      sent++;
      sub.last_seen_at = nowISO();
      keep.push(sub);
    } catch (err) {
      const code = err && (err.statusCode || err.status);
      // 404/410 = inscrição expirada — remove
      if (code === 404 || code === 410) {
        console.log("[push] removendo inscrição expirada", sub.endpoint.slice(-20));
      } else {
        console.warn("[push] falha", code || err.message);
        keep.push(sub);
      }
    }
  }

  db.pushSubscriptions = allOthers.concat(keep);
  saveDb(db);
  return { sent, total: subs.length };
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

function parseDurationMs(body) {
  if (body.durationSeconds !== undefined && body.durationSeconds !== null) {
    const secs = Number(body.durationSeconds);
    if (secs > 0) return secs * 1000;
  }
  if (body.days !== undefined && body.days !== null) {
    const daysNum = Number(body.days);
    if (daysNum > 0) return daysNum * 86400000;
  }
  return null;
}

/** Normaliza código de token digitado (maiúsculas, trim). */
function normalizeTokenCode(raw) {
  return String(raw || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
}

/**
 * Cria tokens aleatórios OU recria/restaura um token fixo (editável).
 *
 * Body:
 * - note: nome do cliente (ex: "LUCAS")
 * - token / customToken: código fixo opcional (ex: "LM-AAAA-BBBB-CCCC")
 *   Se o código já existir → atualiza (reativa, nota, validade) — cliente continua com o mesmo token
 *   Se não existir → cria com esse código
 * - quantity: qtd (ignorado se customToken)
 * - durationSeconds / days: validade
 * - keepDevices: true para não limpar dispositivos ao restaurar (default false ao restaurar)
 */
app.post("/api/admin/tokens", requireAdmin, (req, res) => {
  const body = req.body || {};
  const note = String(body.note || "").slice(0, 200);
  const durationMs = parseDurationMs(body);
  const expiresAt = durationMs ? new Date(Date.now() + durationMs).toISOString() : null;
  const custom = normalizeTokenCode(body.token || body.customToken || "");

  // ----- Token fixo / restaurar (licença editável) -----
  if (custom) {
    if (custom.length < 6) {
      return res.status(400).json({ ok: false, error: "Código do token muito curto" });
    }
    let row = db.tokens.find((t) => t.token === custom);
    let restored = false;

    if (row) {
      restored = true;
      row.status = "active";
      if (note) row.note = note;
      if (expiresAt) row.expires_at = expiresAt;
      else if (body.permanent === true) row.expires_at = null;
      // Por padrão ao recriar/restaurar, libera dispositivos para o cliente reativar
      if (body.keepDevices !== true) {
        row.device_id = null;
        row.devices = [];
        row.activated_at = null;
      }
      addLog("restore", `Token ${custom} restaurado/atualizado · nota="${row.note || ""}"`);
    } else {
      row = {
        id: db.nextId++,
        token: custom,
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
      addLog("generate", `Token fixo ${custom} criado · nota="${note}"`);
    }

    saveDb(db);
    return res.json({
      ok: true,
      restored,
      tokens: [tokenPayload(row)],
      message: restored
        ? "Token já existia — atualizado e reativado. O cliente continua com o mesmo código."
        : "Token fixo criado. Guarde o código; se o banco apagar, é só recriar o mesmo."
    });
  }

  // ----- Geração aleatória em lote -----
  const qty = Math.min(50, Math.max(1, Number(body.quantity) || 1));
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

  addLog(
    "generate",
    `${qty} token(s) gerado(s)${note ? ` · ${note}` : ""}${expiresAt ? ` · expira ${expiresAt}` : " · permanente"}`
  );
  saveDb(db);
  res.json({ ok: true, tokens: created });
});

/** Importa vários tokens de uma vez (CSV/lista) — útil após wipe do disco */
app.post("/api/admin/tokens/import", requireAdmin, (req, res) => {
  const body = req.body || {};
  const items = Array.isArray(body.tokens) ? body.tokens : [];
  if (!items.length) {
    return res.status(400).json({ ok: false, error: "Envie tokens: [{ token, note, days }]" });
  }

  const out = [];
  for (const item of items.slice(0, 200)) {
    const code = normalizeTokenCode(item.token || item.code);
    if (!code || code.length < 6) continue;
    const note = String(item.note || item.name || "").slice(0, 200);

    // Prioridade da validade:
    // 1) expiresAt ISO explícito
    // 2) remainingSeconds (tempo restante no momento do export)
    // 3) durationSeconds / days (nova validade a partir de agora)
    // 4) permanente (null)
    let expiresAt = null;
    if (item.expiresAt && item.expiresAt !== "permanente" && item.expiresAt !== "permanent" && item.expiresAt !== "") {
      const parsed = new Date(item.expiresAt);
      if (!isNaN(parsed.getTime())) expiresAt = parsed.toISOString();
    }
    if (!expiresAt && item.remainingSeconds != null && item.remainingSeconds !== "") {
      const rem = Number(item.remainingSeconds);
      if (!isNaN(rem) && rem > 0) {
        expiresAt = new Date(Date.now() + rem * 1000).toISOString();
      } else if (rem === 0) {
        expiresAt = new Date().toISOString();
      }
    }
    if (!expiresAt) {
      let durationMs = null;
      if (item.durationSeconds) durationMs = Number(item.durationSeconds) * 1000;
      else if (item.days) durationMs = Number(item.days) * 86400000;
      if (durationMs && durationMs > 0) expiresAt = new Date(Date.now() + durationMs).toISOString();
    }
    // item.permanent === true → null (sem expiração)
    if (item.permanent === true) expiresAt = null;

    let row = db.tokens.find((t) => t.token === code);
    if (row) {
      row.status = "active";
      if (note) row.note = note;
      // Sempre aplica validade vinda do import quando informada
      if (item.expiresAt !== undefined || item.remainingSeconds !== undefined || item.durationSeconds || item.days || item.permanent === true) {
        row.expires_at = expiresAt;
        if (expiresAt && new Date(expiresAt).getTime() <= Date.now()) row.status = "expired";
        else if (row.status === "expired") row.status = "active";
      }
      if (body.keepDevices !== true) {
        row.device_id = null;
        row.devices = [];
        row.activated_at = null;
      }
    } else {
      row = {
        id: db.nextId++,
        token: code,
        status: expiresAt && new Date(expiresAt).getTime() <= Date.now() ? "expired" : "active",
        device_id: null,
        devices: [],
        expires_at: expiresAt,
        note,
        created_at: nowISO(),
        last_seen_at: null,
        activated_at: null
      };
      db.tokens.push(row);
    }
    out.push(tokenPayload(row));
  }

  addLog("import", `${out.length} token(s) importados/restaurados`);
  saveDb(db);
  res.json({ ok: true, tokens: out, count: out.length });
});

app.patch("/api/admin/tokens/:id", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const row = db.tokens.find((t) => t.id === id);
  if (!row) return res.status(404).json({ ok: false, error: "Token não encontrado" });

  const body = req.body || {};
  const { status, expiresAt, note, unbind } = body;

  // Ajuste de tempo: addSeconds / addDays (positivo = acrescenta, negativo = diminui)
  if (body.addSeconds !== undefined || body.addDays !== undefined) {
    let addMs = 0;
    if (body.addSeconds !== undefined) {
      addMs = Number(body.addSeconds) * 1000;
    } else if (body.addDays !== undefined) {
      addMs = Number(body.addDays) * 86400000;
    }

    if (addMs !== 0 && !isNaN(addMs)) {
      const base = row.expires_at && new Date(row.expires_at).getTime() > Date.now()
        ? new Date(row.expires_at).getTime()
        : Date.now();
      const next = base + addMs;
      // Não deixa expirar no passado se estiver só diminuindo um pouco — marca como agora se <= 0
      if (next <= Date.now()) {
        row.expires_at = new Date(Date.now()).toISOString();
        row.status = "expired";
      } else {
        row.expires_at = new Date(next).toISOString();
        if (row.status === "expired" && addMs > 0) row.status = "active";
      }
      const sign = addMs >= 0 ? "+" : "";
      addLog(addMs >= 0 ? "renew" : "reduce", `Token #${id} (${row.token}) ${sign}${Math.round(addMs / 1000)}s`);
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

  // Limite de dispositivos por token (1..20)
  if (body.maxDevices !== undefined || body.max_devices !== undefined) {
    const raw = body.maxDevices !== undefined ? body.maxDevices : body.max_devices;
    const n = Math.min(20, Math.max(1, Math.floor(Number(raw) || 1)));
    row.max_devices = n;
    addLog("max_devices", `Token #${id} (${row.token}) limite=${n}`);
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


// ----- Web Push API -----
app.get("/api/push/vapidPublicKey", (_req, res) => {
  res.json({ ok: true, publicKey: VAPID_PUBLIC });
});

app.post("/api/push/subscribe", (req, res) => {
  try {
    const body = req.body || {};
    const token = String(body.token || "").trim().toUpperCase();
    const deviceId = String(body.deviceId || "").trim().slice(0, 128);
    const sub = body.subscription;
    if (!token || !sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
      return res.status(400).json({ ok: false, error: "token e subscription completos são obrigatórios" });
    }
    // Token precisa existir e estar válido
    const row = db.tokens.find((t) => t.token === token);
    if (!row) return res.status(200).json({ ok: false, error: "Token inválido" });
    if (row.status === "revoked") return res.status(200).json({ ok: false, error: "Token revogado" });
    if (isExpired(row)) return res.status(200).json({ ok: false, error: "Token expirado" });

    const list = ensurePushList(db);
    const idx = list.findIndex((s) => s.endpoint === sub.endpoint);
    const entry = {
      token,
      deviceId: deviceId || null,
      endpoint: sub.endpoint,
      keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
      created_at: idx >= 0 ? list[idx].created_at : nowISO(),
      last_seen_at: nowISO()
    };
    if (idx >= 0) list[idx] = entry;
    else list.push(entry);
    // limite por token
    const forToken = list.filter((s) => s.token === token);
    if (forToken.length > 5) {
      const sorted = forToken.sort((a, b) => String(a.last_seen_at).localeCompare(String(b.last_seen_at)));
      const remove = new Set(sorted.slice(0, forToken.length - 5).map((s) => s.endpoint));
      db.pushSubscriptions = list.filter((s) => s.token !== token || !remove.has(s.endpoint));
    }
    saveDb(db);
    addLog("push_subscribe", `Token ${token} · device ${deviceId || "?"}`);
    res.json({ ok: true, message: "Inscrição salva — notificações ativas neste aparelho" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: "Erro interno" });
  }
});

app.post("/api/push/unsubscribe", (req, res) => {
  try {
    const endpoint = (req.body || {}).endpoint;
    if (!endpoint) return res.status(400).json({ ok: false, error: "endpoint obrigatório" });
    const list = ensurePushList(db);
    db.pushSubscriptions = list.filter((s) => s.endpoint !== endpoint);
    saveDb(db);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: "Erro interno" });
  }
});

/** Chamado pela extensão (ou app) quando há venda */
app.post("/api/push/notify", async (req, res) => {
  try {
    const body = req.body || {};
    const token = String(body.token || "").trim().toUpperCase();
    if (!token) return res.status(400).json({ ok: false, error: "token obrigatório" });

    const row = db.tokens.find((t) => t.token === token);
    if (!row || row.status === "revoked" || isExpired(row)) {
      return res.status(200).json({ ok: false, error: "Token inválido" });
    }

    const title = String(body.title || "Live Max — Nova venda").slice(0, 100);
    const msg = String(body.body || body.message || "Você teve uma venda").slice(0, 200);
    const result = await sendPushToToken(token, {
      title,
      body: msg,
      url: body.url || "/",
      tag: body.tag || "livemax-sale"
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error("[push/notify]", err);
    res.status(500).json({ ok: false, error: "Erro ao enviar push" });
  }
});


app.listen(PORT, () => {
  console.log(`\n✅ Live Max License Server v3 em http://localhost:${PORT}`);
  console.log(`   Painel: http://localhost:${PORT}/admin/`);
  console.log(`   ADMIN_KEY: ${ADMIN_KEY}`);
  console.log(`   MAX_DEVICES: ${MAX_DEVICES} (PC + celular no mesmo token)`);
  console.log(`   DB_PATH: ${DB_PATH}`);
  console.log(`   Web Push: ${webpush ? "ativo" : "OFF (npm i web-push)"}`);
  console.log(`   (No Render use disco persistente + DB_PATH=/var/data/licenses.json)\n`);
});
