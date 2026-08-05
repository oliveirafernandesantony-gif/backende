/* Live Max Companion App — v1.6
 * Correções:
 * - Login SEMPRE valida no servidor (não entra com token falso)
 * - Logout limpa sessão de verdade
 * - deviceType: mobile (2 dispositivos no mesmo token)
 * - Sync mais confiável + revalidação periódica da licença
 */
(function () {
  "use strict";

  const APP_VERSION = "1.6";
  const SB_URL = "https://rsvnowesedmngcjybuwj.supabase.co";
  const SB_KEY = "sb_publishable_oZ24cl9lFtDbHlPxhXisAg_MzScFLcb";
  const LICENSE_API = "https://backende-e33b.onrender.com/api/validate";
  const SB_HEADERS = {
    apikey: SB_KEY,
    Authorization: "Bearer " + SB_KEY,
    "Content-Type": "application/json",
  };

  async function sbGet(path) {
    try {
      const res = await fetch(SB_URL + "/rest/v1/" + path, { headers: SB_HEADERS });
      if (!res.ok) {
        console.warn("[SB]", res.status, await res.text());
        return null;
      }
      return await res.json();
    } catch (e) {
      console.warn("[SB] network:", e);
      return null;
    }
  }

  async function sbPatch(path, body) {
    try {
      const res = await fetch(SB_URL + "/rest/v1/" + path, {
        method: "PATCH",
        headers: { ...SB_HEADERS, Prefer: "return=minimal" },
        body: JSON.stringify(body),
      });
      if (!res.ok) console.warn("[SB PATCH]", res.status, await res.text());
      return res.ok;
    } catch (e) {
      console.warn("[SB PATCH]", e);
      return false;
    }
  }

  const state = {
    token: "",
    licenseOk: false,
    connected: false,
    liveActive: false,
    liveId: null,
    liveStart: null,
    timerInterval: null,
    totalLives: Number(localStorage.getItem("lm_totalLives") || 0),
    totalGmv: Number(localStorage.getItem("lm_totalGmv") || 0),
    totalSales: Number(localStorage.getItem("lm_totalSales") || 0),
    liveGmv: 0,
    liveSales: 0,
    liveViewers: null,
    salesFeed: [],
    history: (function () {
      try {
        return JSON.parse(localStorage.getItem("lm_history") || "[]");
      } catch (_) {
        return [];
      }
    })(),
    lastSaleId: null,
  };

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);

  function formatMoney(v) {
    return "R$ " + Number(v || 0).toLocaleString("pt-BR", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }

  function formatDuration(ms) {
    const s = Math.floor(Math.max(0, ms) / 1000);
    const h = String(Math.floor(s / 3600)).padStart(2, "0");
    const m = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
    const sec = String(s % 60).padStart(2, "0");
    return h + ":" + m + ":" + sec;
  }

  function toast(msg, type) {
    const el = $("#toast");
    if (!el) return;
    el.textContent = msg;
    el.className = "toast " + (type || "");
    clearTimeout(el._t);
    el._t = setTimeout(function () {
      el.classList.add("hidden");
    }, 3000);
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function setConnected(on) {
    state.connected = on;
    const dot = $("#status-dot");
    const banner = $("#connection-status");
    const text = $("#connection-text");
    const cfg = $("#config-status");
    if (dot) dot.classList.toggle("on", on);
    if (banner) {
      banner.classList.toggle("online", on);
      banner.classList.toggle("offline", !on);
    }
    if (text) text.textContent = on ? "Conectado ao servidor" : "Aguardando conexão…";
    if (cfg) cfg.textContent = on ? "Conectado" : "Desconectado";
  }

  function startLiveTimer(fromDate) {
    stopLiveTimer();
    state.liveStart = fromDate ? new Date(fromDate).getTime() : Date.now();
    state.timerInterval = setInterval(function () {
      const el = $("#live-timer");
      if (el) el.textContent = formatDuration(Date.now() - state.liveStart);
    }, 1000);
  }

  function stopLiveTimer() {
    if (state.timerInterval) clearInterval(state.timerInterval);
    state.timerInterval = null;
  }

  function switchToLiveTab() {
    $$(".tab-btn").forEach(function (b) {
      b.classList.remove("active");
    });
    $$(".tab-panel").forEach(function (p) {
      p.classList.remove("active");
    });
    var btn = document.querySelector('[data-tab="live"]');
    var panel = $("#tab-live");
    if (btn) btn.classList.add("active");
    if (panel) panel.classList.add("active");
  }

  function renderPlacar() {
    var a = $("#stat-lives");
    var b = $("#stat-gmv");
    var c = $("#stat-sales");
    var d = $("#stat-ticket");
    if (a) a.textContent = state.totalLives;
    if (b) b.textContent = formatMoney(state.totalGmv);
    if (c) c.textContent = state.totalSales;
    var ticket = state.totalSales > 0 ? state.totalGmv / state.totalSales : 0;
    if (d) d.textContent = formatMoney(ticket);
    if (state.history.length) {
      var last = state.history[0];
      var g = $("#last-live-gmv");
      var dt = $("#last-live-date");
      if (g) g.textContent = formatMoney(last.gmv);
      if (dt) dt.textContent = last.date;
    }
  }

  function renderLive() {
    var idle = $("#live-idle");
    var active = $("#live-active");
    if (!state.liveActive) {
      if (idle) idle.classList.remove("hidden");
      if (active) active.classList.add("hidden");
      return;
    }
    if (idle) idle.classList.add("hidden");
    if (active) active.classList.remove("hidden");

    var gmv = $("#live-gmv");
    var sales = $("#live-sales");
    var ticketEl = $("#live-ticket");
    var viewers = $("#live-viewers");
    if (gmv) gmv.textContent = formatMoney(state.liveGmv);
    if (sales) sales.textContent = state.liveSales;
    var ticket = state.liveSales > 0 ? state.liveGmv / state.liveSales : 0;
    if (ticketEl) ticketEl.textContent = formatMoney(ticket);
    if (viewers) viewers.textContent = state.liveViewers != null ? state.liveViewers : "—";

    var list = $("#sales-list");
    if (!list) return;
    if (!state.salesFeed.length) {
      list.innerHTML = '<div class="sale-empty">As vendas aparecem aqui durante a live.</div>';
    } else {
      list.innerHTML = state.salesFeed
        .map(function (s) {
          return (
            '<div class="sale-item"><span class="product">' +
            escapeHtml(s.product || "Produto") +
            '</span><span class="value">' +
            formatMoney(s.value) +
            "</span></div>"
          );
        })
        .join("");
    }
  }

  function renderHistory() {
    var list = $("#history-list");
    if (!list) return;
    if (!state.history.length) {
      list.innerHTML = '<div class="empty-state">Nenhuma live registrada ainda.</div>';
      return;
    }
    list.innerHTML = state.history
      .map(function (h) {
        return (
          '<div class="history-item"><div class="top"><span class="date">' +
          h.date +
          '</span><span class="gmv">' +
          formatMoney(h.gmv) +
          '</span></div><div class="meta">' +
          h.sales +
          " vendas · Ticket " +
          formatMoney(h.ticket) +
          " · " +
          h.duration +
          "</div></div>"
        );
      })
      .join("");
  }

  function finishLive() {
    var duration = state.liveStart
      ? formatDuration(Date.now() - state.liveStart)
      : "00:00:00";
    var ticket = state.liveSales > 0 ? state.liveGmv / state.liveSales : 0;
    state.history.unshift({
      date: new Date().toLocaleString("pt-BR", {
        day: "2-digit",
        month: "2-digit",
        year: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      }),
      gmv: state.liveGmv,
      sales: state.liveSales,
      ticket: ticket,
      duration: duration,
    });
    if (state.history.length > 50) state.history.pop();
    localStorage.setItem("lm_history", JSON.stringify(state.history));
    state.totalLives += 1;
    state.totalGmv += state.liveGmv;
    state.totalSales += state.liveSales;
    localStorage.setItem("lm_totalLives", state.totalLives);
    localStorage.setItem("lm_totalGmv", state.totalGmv);
    localStorage.setItem("lm_totalSales", state.totalSales);
    state.liveActive = false;
    state.liveId = null;
    state.salesFeed = [];
    state.lastSaleId = null;
    stopLiveTimer();
    renderPlacar();
    renderHistory();
    renderLive();
    toast("Live encerrada", "success");
  }

  var syncTimer = null;
  var licenseTimer = null;
  var syncing = false;

  async function syncOnce() {
    if (!state.token || !state.licenseOk || syncing) return;
    syncing = true;
    try {
      var lives = await sbGet(
        "lives?token=eq." +
          encodeURIComponent(state.token) +
          "&status=eq.live&order=created_at.desc&limit=1"
      );
      setConnected(true);

      if (!lives || !lives.length) {
        if (state.liveActive) finishLive();
        syncing = false;
        return;
      }

      var live = lives[0];
      var wasActive = state.liveActive;

      state.liveActive = true;
      state.liveId = live.id;
      state.liveGmv = Number(live.gmv) || 0;
      state.liveSales = Number(live.sales_count) || 0;
      state.liveViewers = live.viewers != null ? live.viewers : null;

      if (!wasActive) {
        startLiveTimer(live.started_at);
        switchToLiveTab();
        toast("Live conectada!", "success");
      }

      var sales = await sbGet(
        "sales?live_id=eq." + live.id + "&order=created_at.desc&limit=40"
      );
      if (sales && sales.length) {
        var newFeed = sales.map(function (s) {
          return {
            id: s.id,
            product: s.product || "Produto",
            value: Number(s.value) || 0,
            time: new Date(s.created_at).getTime(),
          };
        });
        if (state.lastSaleId && newFeed[0] && newFeed[0].id !== state.lastSaleId) {
          var newest = newFeed[0];
          var notifOn = $("#cfg-notif-sales");
          if (!notifOn || notifOn.checked) {
            toast("💰 " + newest.product + " — " + formatMoney(newest.value), "success");
          }
        }
        state.lastSaleId = newFeed[0] ? newFeed[0].id : null;
        state.salesFeed = newFeed;
        if (!state.liveSales) state.liveSales = sales.length;
        if (!state.liveGmv) {
          state.liveGmv = sales.reduce(function (a, s) {
            return a + (Number(s.value) || 0);
          }, 0);
        }
      }

      renderLive();
    } catch (e) {
      console.warn("sync error:", e);
      setConnected(false);
    }
    syncing = false;
  }

  function startSync() {
    stopSync();
    console.log("[Live Max] startSync v" + APP_VERSION + " token=", state.token);
    syncOnce();
    syncTimer = setInterval(syncOnce, 2500);
    // revalida licença a cada 5 min
    if (licenseTimer) clearInterval(licenseTimer);
    licenseTimer = setInterval(function () {
      if (!state.token) return;
      validateLicense(state.token).then(function (result) {
        if (!result || !result.valid) {
          toast((result && result.error) || "Licença inválida — desconectando", "danger");
          logout(true);
        }
      });
    }, 5 * 60 * 1000);
  }

  function stopSync() {
    if (syncTimer) clearInterval(syncTimer);
    syncTimer = null;
    if (licenseTimer) clearInterval(licenseTimer);
    licenseTimer = null;
  }

  async function requestEndLive() {
    if (!state.liveActive || !state.liveId) return;
    if (!confirm("Tem certeza que deseja encerrar a live?")) return;
    toast("Enviando comando…");
    var ok = await sbPatch("lives?id=eq." + state.liveId, {
      status: "ended",
      ended_at: new Date().toISOString(),
      gmv: state.liveGmv,
      sales_count: state.liveSales,
    });
    if (ok) finishLive();
    else toast("Erro ao enviar comando", "danger");
  }

  function getDeviceId() {
    var id = localStorage.getItem("lm_device_id");
    if (!id) {
      id = "app-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
      localStorage.setItem("lm_device_id", id);
    }
    return id;
  }

  /** Só aceita token com formato parecido com LM-XXXX-... */
  function looksLikeToken(token) {
    var t = String(token || "").trim().toUpperCase();
    if (t.length < 8) return false;
    // aceita LM-... ou tokens longos alfanuméricos (legado)
    if (/^LM-[A-Z0-9]{3,}-[A-Z0-9]{3,}/.test(t)) return true;
    if (/^[A-Z0-9\-]{10,}$/.test(t)) return true;
    return false;
  }

  async function validateLicense(token) {
    try {
      var res = await fetch(LICENSE_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: String(token || "").trim(),
          deviceId: getDeviceId(),
          deviceType: "mobile",
        }),
      });
      if (!res.ok) {
        return { ok: false, valid: false, error: "Servidor de licenças indisponível (" + res.status + ")" };
      }
      var data = await res.json();
      // proteção: só entra se valid === true (booleano)
      if (data && data.valid === true) return data;
      return {
        ok: true,
        valid: false,
        error: (data && data.error) || "Token inválido ou expirado",
      };
    } catch (e) {
      console.warn("validate error:", e);
      return { ok: false, valid: false, error: "Sem conexão com o servidor de licenças" };
    }
  }

  function showLogin(msg) {
    state.licenseOk = false;
    $("#screen-app").classList.add("hidden");
    $("#screen-login").classList.remove("hidden");
    var err = $("#login-error");
    if (err) {
      if (msg) {
        err.textContent = msg;
        err.classList.remove("hidden");
      } else {
        err.classList.add("hidden");
      }
    }
  }

  function showApp() {
    $("#screen-login").classList.add("hidden");
    $("#screen-app").classList.remove("hidden");
    var ct = $("#config-token");
    if (ct) ct.textContent = state.token.slice(0, 8) + "••••••••";
    renderPlacar();
    renderHistory();
    renderLive();
  }

  async function login(token) {
    token = (token || "").trim();
    var err = $("#login-error");

    if (!looksLikeToken(token)) {
      if (err) {
        err.textContent = "Token inválido. Use o token gerado no painel (ex.: LM-XXXX-XXXX-XXXX).";
        err.classList.remove("hidden");
      }
      return;
    }

    var btn = $("#btn-login");
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Validando…";
    }

    var result = await validateLicense(token);

    if (btn) {
      btn.disabled = false;
      btn.textContent = "Entrar";
    }

    // NUNCA entra sem valid === true do servidor
    if (!result || result.valid !== true) {
      var msg = (result && result.error) || "Token inválido ou expirado";
      if (err) {
        err.textContent = msg;
        err.classList.remove("hidden");
      }
      toast(msg, "danger");
      // garante que não fica sessão antiga
      localStorage.removeItem("lm_token");
      state.token = "";
      state.licenseOk = false;
      return;
    }

    state.token = token;
    state.licenseOk = true;
    localStorage.setItem("lm_token", token);
    if (err) err.classList.add("hidden");
    showApp();
    var slots =
      result.deviceCount && result.maxDevices
        ? " (" + result.deviceCount + "/" + result.maxDevices + " dispositivos)"
        : "";
    toast((result.message || "Licença válida") + slots, "success");
    startSync();
  }

  function logout(silent) {
    stopSync();
    localStorage.removeItem("lm_token");
    state.token = "";
    state.licenseOk = false;
    state.liveActive = false;
    state.liveId = null;
    state.salesFeed = [];
    state.lastSaleId = null;
    stopLiveTimer();
    setConnected(false);
    showLogin(silent ? undefined : undefined);
    var input = $("#input-token");
    if (input) input.value = "";
    if (!silent) toast("Desconectado", "success");
  }

  function setupTabs() {
    $$(".tab-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        $$(".tab-btn").forEach(function (b) {
          b.classList.remove("active");
        });
        $$(".tab-panel").forEach(function (p) {
          p.classList.remove("active");
        });
        btn.classList.add("active");
        var panel = $("#tab-" + btn.dataset.tab);
        if (panel) panel.classList.add("active");
      });
    });
  }

  // boot — sempre começa na tela de login até validar de verdade
  setupTabs();
  showLogin();

  $("#btn-login").addEventListener("click", function () {
    login($("#input-token").value);
  });
  $("#input-token").addEventListener("keydown", function (e) {
    if (e.key === "Enter") login($("#input-token").value);
  });
  $("#btn-logout").addEventListener("click", function () {
    logout(false);
  });
  $("#btn-end-live").addEventListener("click", requestEndLive);
  $("#btn-clear-data").addEventListener("click", function () {
    if (confirm("Limpar histórico local?")) {
      state.history = [];
      state.totalLives = 0;
      state.totalGmv = 0;
      state.totalSales = 0;
      localStorage.removeItem("lm_history");
      localStorage.removeItem("lm_totalLives");
      localStorage.removeItem("lm_totalGmv");
      localStorage.removeItem("lm_totalSales");
      renderHistory();
      renderPlacar();
      toast("Dados limpos");
    }
  });

  // tenta restaurar sessão só se o SERVIDOR confirmar o token salvo
  var saved = (localStorage.getItem("lm_token") || "").trim();
  if (saved) {
    var input = $("#input-token");
    if (input) input.value = saved;
    validateLicense(saved).then(function (result) {
      if (result && result.valid === true) {
        state.token = saved;
        state.licenseOk = true;
        showApp();
        startSync();
      } else {
        localStorage.removeItem("lm_token");
        state.token = "";
        state.licenseOk = false;
        showLogin((result && result.error) || "Sessão expirada. Entre novamente com um token válido.");
      }
    });
  }

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js?v=" + APP_VERSION).catch(function () {});
  }

  console.log("[Live Max Companion] v" + APP_VERSION);
})();
