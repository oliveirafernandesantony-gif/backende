/* Live Max Companion App — v1.19
 * Correções:
 * - Login SEMPRE valida no servidor (não entra com token falso)
 * - Logout limpa sessão de verdade
 * - deviceType: mobile (2 dispositivos no mesmo token)
 * - Sync mais confiável + revalidação periódica da licença
 */
(function () {
  "use strict";

  const APP_VERSION = "1.19";
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
    totalLives: 0, // só confia no servidor (loadPlacarFromServer)
    totalGmv: Number(localStorage.getItem("lm_totalGmv") || 0),
    totalSales: Number(localStorage.getItem("lm_totalSales") || 0),
    commissionPct: Number(localStorage.getItem("lm_commissionPct") || 10),
    liveGmv: 0,
    liveSales: 0,
    productClicks: null,
    liveHeartbeatAt: null,
    staleChecks: 0,
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

  function getCommissionPct() {
    var n = Number(state.commissionPct);
    if (isNaN(n) || n < 0) n = 0;
    if (n > 100) n = 100;
    return n;
  }

  function calcCommission(gmv) {
    return (Number(gmv) || 0) * (getCommissionPct() / 100);
  }

  function formatClicks(n) {
    if (n == null || n === "" || isNaN(Number(n))) return "—";
    return Number(n).toLocaleString("pt-BR");
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


  const LICENSE_API_ORIGIN = "https://backende-e33b.onrender.com";
  const VAPID_PUBLIC_KEY = "BJlg0lEx0x7bs2B61BN7mlooYPbHv_3svXtLMiT43wV_faEoRa-Bw51CfuYWaWMhr1vJgwCncjDLeY8jWjN91PE";

  function urlBase64ToUint8Array(base64String) {
    const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
    const rawData = atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
    return outputArray;
  }

  async function ensureServiceWorker() {
    if (!("serviceWorker" in navigator)) return null;
    try {
      var reg = await navigator.serviceWorker.register("sw.js?v=" + APP_VERSION);
      await navigator.serviceWorker.ready;
      return reg || (await navigator.serviceWorker.getRegistration()) || null;
    } catch (e) {
      console.warn("[SW]", e);
      return null;
    }
  }

  async function getVapidPublicKey() {
    try {
      var res = await fetch(LICENSE_API_ORIGIN + "/api/push/vapidPublicKey");
      var data = await res.json();
      if (data && data.publicKey) return data.publicKey;
    } catch (e) {
      console.warn("[VAPID]", e);
    }
    return VAPID_PUBLIC_KEY;
  }

  function setPushStatus(text, ok) {
    var el = $("#push-status");
    if (!el) return;
    el.textContent = text;
    el.style.color = ok ? "#34d399" : "#f87171";
  }

  /** Vibração + bipe curto (app aberto) */
  function signalSaleAlert() {
    try {
      if (navigator.vibrate) {
        navigator.vibrate([180, 80, 180, 80, 260]);
      }
    } catch (_) {}
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      var ctx = new Ctx();
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = 880;
      gain.gain.value = 0.12;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
      osc.stop(ctx.currentTime + 0.4);
      setTimeout(function () {
        try {
          ctx.close();
        } catch (_) {}
      }, 500);
    } catch (e) {
      console.warn("beep", e);
    }
  }

  async function subscribeWebPush() {
    if (!state.token) return { ok: false, error: "Sem token — faça login primeiro" };
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      return { ok: false, error: "Este navegador não suporta Web Push (use Chrome no Android)" };
    }
    if (!window.isSecureContext) {
      return { ok: false, error: "Web Push exige HTTPS (não funciona em http://)" };
    }
    try {
      var perm = await Notification.requestPermission();
      if (perm !== "granted") {
        setPushStatus("Permissão negada", false);
        return {
          ok: false,
          error: "Permissão de notificação negada. Ative nas configurações do navegador/site.",
        };
      }

      var reg = await ensureServiceWorker();
      if (!reg) {
        setPushStatus("Service Worker falhou", false);
        return { ok: false, error: "Falha ao registrar Service Worker" };
      }

      var vapid = await getVapidPublicKey();
      var sub = await reg.pushManager.getSubscription();
      // Se já existe, reutiliza; se falhar no servidor, recria abaixo
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(vapid),
        });
      }

      var deviceId = getDeviceId();
      var payload = {
        token: state.token,
        deviceId: deviceId,
        subscription: sub.toJSON(),
      };

      var res = await fetch(LICENSE_API_ORIGIN + "/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      var data = await res.json().catch(function () {
        return {};
      });

      // Se inscrição antiga inválida, cancela e cria de novo
      if (!data.ok) {
        try {
          if (sub) await sub.unsubscribe();
        } catch (_) {}
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(vapid),
        });
        payload.subscription = sub.toJSON();
        res = await fetch(LICENSE_API_ORIGIN + "/api/push/subscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        data = await res.json().catch(function () {
          return {};
        });
      }

      if (data && data.ok) {
        localStorage.setItem("lm_push_ok", "1");
        setPushStatus("Push ativo ✓", true);
        // Sem notificação de teste — evita poluir a bandeja do celular
        return { ok: true, message: data.message || "Push ativo" };
      }
      setPushStatus((data && data.error) || "Falha no servidor", false);
      return { ok: false, error: (data && data.error) || "Falha ao registrar push no servidor" };
    } catch (e) {
      console.warn("subscribeWebPush", e);
      setPushStatus(e.message || "Erro", false);
      return { ok: false, error: e.message || "Erro no push" };
    }
  }

  function ensureNotifPermission() {
    try {
      if (!("Notification" in window)) return;
      if (Notification.permission === "default") {
        Notification.requestPermission().catch(function () {});
      }
    } catch (_) {}
  }

  /** Só vibra/bipe no app. Notificação de sistema fica a cargo do Web Push (1x). */
  function systemNotify(title, body, withSignal) {
    try {
      var salesOn = $("#cfg-notif-sales");
      if (salesOn && !salesOn.checked) return;
      if (withSignal !== false) signalSaleAlert();
      // NÃO cria Notification aqui — evita duplicar com o push
    } catch (e) {
      console.warn("systemNotify", e);
    }
  }

  function fallbackNotify(title, body) {
    try {
      var n = new Notification(title || "Live Max", {
        body: body || "",
        icon: "icons/icon192.png",
        tag: "livemax-sale",
        renotify: true,
        silent: false,
      });
      n.onclick = function () {
        try {
          window.focus();
        } catch (_) {}
        n.close();
      };
      setTimeout(function () {
        try {
          n.close();
        } catch (_) {}
      }, 8000);
    } catch (_) {}
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
    var d = $("#stat-commission");
    if (a) a.textContent = state.totalLives;
    if (b) b.textContent = formatMoney(state.totalGmv);
    if (c) c.textContent = state.totalSales;
    if (d) d.textContent = formatMoney(calcCommission(state.totalGmv));
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
    var commissionEl = $("#live-commission");
    var clicksEl = $("#live-product-clicks");
    if (gmv) gmv.textContent = formatMoney(state.liveGmv);
    if (sales) sales.textContent = state.liveSales;
    if (commissionEl) commissionEl.textContent = formatMoney(calcCommission(state.liveGmv));
    if (clicksEl) clicksEl.textContent = formatClicks(state.productClicks);

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
          " vendas · Comissão " +
          formatMoney(h.commission != null ? h.commission : calcCommission(h.gmv)) +
          " · " +
          h.duration +
          "</div></div>"
        );
      })
      .join("");
  }

  var finishingLive = false;
  var lastFinishedLiveId = null;

  function finishLive() {
    if (!state.liveActive) return;
    if (finishingLive) return;
    // mesma live não conta 2x
    if (state.liveId && state.liveId === lastFinishedLiveId) {
      state.liveActive = false;
      stopLiveTimer();
      renderLive();
      return;
    }
    finishingLive = true;
    var closedId = state.liveId;
    var duration = state.liveStart
      ? formatDuration(Date.now() - state.liveStart)
      : "00:00:00";
    var gmv = state.liveGmv;
    var sales = state.liveSales;

    state.liveActive = false;
    state.liveId = null;
    state.salesFeed = [];
    state.lastSaleId = null;
    state.productClicks = null;
    stopLiveTimer();

    lastFinishedLiveId = closedId;
    toast("Live encerrada", "success");

    // Contagem oficial vem do servidor (evita +1 local + ended.length)
    loadPlacarFromServer().finally(function () {
      finishingLive = false;
      // se servidor ainda não listou, mostra entrada local sem inflar total
      if (!state.history.length || (closedId && !state.history.some(function () { return true; }))) {
        /* placar já atualizado pelo server */
      }
      renderPlacar();
      renderHistory();
      renderLive();
    });
  }


  async function endLiveOnServer(liveId, gmv, sales) {
    if (!liveId) return false;
    try {
      return await sbPatch("lives?id=eq." + liveId, {
        status: "ended",
        ended_at: new Date().toISOString(),
        gmv: Number(gmv) || 0,
        sales_count: Number(sales) || 0,
      });
    } catch (e) {
      console.warn("endLiveOnServer", e);
      return false;
    }
  }

  /** Última atividade real da live (venda mais recente ou timestamps) */
  async function getLiveLastActivityMs(live) {
    if (!live || !live.id) return 0;
    var times = [];
    if (live.heartbeat_at) times.push(new Date(live.heartbeat_at).getTime());
    if (live.last_seen_at) times.push(new Date(live.last_seen_at).getTime());
    if (live.updated_at) times.push(new Date(live.updated_at).getTime());
    if (live.started_at) times.push(new Date(live.started_at).getTime());
    try {
      var sales = await sbGet(
        "sales?live_id=eq." +
          live.id +
          "&order=created_at.desc&limit=1&select=created_at"
      );
      if (sales && sales[0] && sales[0].created_at) {
        times.push(new Date(sales[0].created_at).getTime());
      }
    } catch (_) {}
    var max = 0;
    times.forEach(function (t) {
      if (t && t > max) max = t;
    });
    return max;
  }

  /**
   * Encerra lives sem atividade recente.
   * Extensão offline = nada atualiza no banco → app tira do "Ao Vivo".
   */
  /** Não encerra live no servidor. Só remove duplicatas da UI se precisar. */
  async function cleanupPhantomLives() {
    // Intencional: NUNCA faz PATCH status=ended automaticamente.
    // Live só encerra pelo botão "Encerrar Live" ou pela extensão.
    return;
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

      var serverGmv = Number(live.gmv) || 0;
      var serverSales = Number(live.sales_count) || 0;

      // Mantém AO VIVO enquanto o servidor disser status=live.
      // Encerrar automático agressivo matava live real (heartbeat nem sempre grava).
      // Fecha só quando: botão Encerrar, extensão manda ended, ou cleanup 45min+.
      state.staleChecks = 0;
      state.liveActive = true;
      state.liveId = live.id;

      // Cliques no produto (product_clicks ou viewers legado)
      var clicksRaw =
        live.product_clicks != null && live.product_clicks !== ""
          ? live.product_clicks
          : live.viewers;
      if (clicksRaw != null && clicksRaw !== "" && !isNaN(Number(clicksRaw))) {
        state.productClicks = Number(clicksRaw);
      }

      if (!wasActive) {
        startLiveTimer(live.started_at);
        switchToLiveTab();
        toast("Live conectada!", "success");
        // Sem systemNotify — evita 2ª/3ª notificação na bandeja
      }

      var sales = await sbGet(
        "sales?live_id=eq." +
          live.id +
          "&order=created_at.desc&limit=200&select=id,product,value,created_at"
      );
      var sumFromSales = 0;
      if (sales && sales.length) {
        var newFeed = sales.map(function (s) {
          var val = Number(s.value) || 0;
          sumFromSales += val;
          return {
            id: s.id,
            product: s.product || "Produto",
            value: val,
            time: new Date(s.created_at).getTime(),
          };
        });
        if (state.lastSaleId && newFeed[0] && newFeed[0].id !== state.lastSaleId) {
          var newest = newFeed[0];
          var notifOn = $("#cfg-notif-sales");
          if (!notifOn || notifOn.checked) {
            var msg = "💰 " + newest.product + " — " + formatMoney(newest.value);
            // App em primeiro plano: só toast + vibração (1 aviso)
            // App em segundo plano: o Web Push cuida (1 aviso) — evita duplicar
            if (!document.hidden) {
              toast(msg, "success");
              signalSaleAlert();
            }
            // se a aba estiver oculta mas o processo vivo, deixa o push mostrar
          }
        }
        state.lastSaleId = newFeed[0] ? newFeed[0].id : null;
        state.salesFeed = newFeed;
      }

      state.liveGmv = Math.max(serverGmv, sumFromSales);
      state.liveSales = Math.max(serverSales, sales && sales.length ? sales.length : 0);

      renderLive();
    } catch (e) {
      console.warn("sync error:", e);
      setConnected(false);
      state.staleChecks = (state.staleChecks || 0) + 1;
      // várias falhas seguidas + live aberta = extensão/rede offline
      if (state.liveActive && state.staleChecks === 8) {
        toast("Conexão instável — tentando de novo…", "danger");
      }
    }
    syncing = false;
  }


  /**
   * Live real no placar = teve venda ou GMV.
   * (Não usa duração: live fantasma presa horas gerava contagem falsa)
   */
  function isRealLive(live) {
    if (!live) return false;
    var gmv = Number(live.gmv) || 0;
    var sales = Number(live.sales_count) || 0;
    return gmv > 0 || sales > 0;
  }

  async function loadPlacarFromServer() {
    if (!state.token) return;
    try {
      var ended = await sbGet(
        "lives?token=eq." +
          encodeURIComponent(state.token) +
          "&status=eq.ended&order=ended_at.desc&limit=100&select=id,gmv,sales_count,started_at,ended_at,created_at"
      );
      if (!ended) ended = [];

      var totalGmv = 0;
      var totalSales = 0;
      var history = [];
      var seenIds = {};

      ended.forEach(function (live) {
        if (!isRealLive(live)) return;
        // evita duplicar o mesmo id
        if (live.id && seenIds[live.id]) return;
        if (live.id) seenIds[live.id] = true;

        var gmv = Number(live.gmv) || 0;
        var sales = Number(live.sales_count) || 0;
        totalGmv += gmv;
        totalSales += sales;
        var when = live.ended_at || live.started_at || "";
        var dateStr = when
          ? new Date(when).toLocaleString("pt-BR", {
              day: "2-digit",
              month: "2-digit",
              year: "2-digit",
              hour: "2-digit",
              minute: "2-digit",
            })
          : "—";
        var duration = "—";
        if (live.started_at && live.ended_at) {
          duration = formatDuration(
            new Date(live.ended_at) - new Date(live.started_at)
          );
        }
        history.push({
          id: live.id,
          date: dateStr,
          gmv: gmv,
          sales: sales,
          commission: calcCommission(gmv),
          duration: duration,
        });
      });

      state.history = history;
      state.totalLives = history.length;
      state.totalGmv = totalGmv;
      state.totalSales = totalSales;
      try {
        localStorage.setItem("lm_history", JSON.stringify(state.history));
        localStorage.setItem("lm_totalLives", String(state.totalLives));
        localStorage.setItem("lm_totalGmv", String(state.totalGmv));
        localStorage.setItem("lm_totalSales", String(state.totalSales));
      } catch (_) {}
      renderPlacar();
      renderHistory();
    } catch (e) {
      console.warn("placar server:", e);
    }
  }

  function startSync() {
    stopSync();
    console.log("[Live Max] startSync v" + APP_VERSION + " token=", state.token);
    cleanupPhantomLives().then(function () {
      return loadPlacarFromServer();
    }).then(function () {
      syncOnce();
    });
    syncTimer = setInterval(syncOnce, 2000);
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

  function openEndLiveConfirm() {
    var overlay = $("#confirm-end-overlay");
    if (!overlay) return;
    overlay.classList.remove("hidden");
    overlay.setAttribute("aria-hidden", "false");
  }

  function closeEndLiveConfirm() {
    var overlay = $("#confirm-end-overlay");
    if (!overlay) return;
    overlay.classList.add("hidden");
    overlay.setAttribute("aria-hidden", "true");
  }

  async function doEndLive() {
    if (!state.liveActive || !state.liveId) {
      closeEndLiveConfirm();
      return;
    }
    var okBtn = $("#confirm-end-ok");
    var cancelBtn = $("#confirm-end-cancel");
    if (okBtn) {
      okBtn.disabled = true;
      okBtn.textContent = "Encerrando…";
    }
    if (cancelBtn) cancelBtn.disabled = true;
    toast("Enviando comando…");
    var ok = await sbPatch("lives?id=eq." + state.liveId, {
      status: "ended",
      ended_at: new Date().toISOString(),
      gmv: state.liveGmv,
      sales_count: state.liveSales,
    });
    if (okBtn) {
      okBtn.disabled = false;
      okBtn.textContent = "Sim, encerrar";
    }
    if (cancelBtn) cancelBtn.disabled = false;
    closeEndLiveConfirm();
    if (ok) finishLive();
    else toast("Erro ao enviar comando", "danger");
  }

  /** Abre modal de confirmação (evita clique acidental) */
  async function requestEndLive() {
    if (!state.liveActive || !state.liveId) return;
    openEndLiveConfirm();
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
    ensureNotifPermission();
    var slots =
      result.deviceCount && result.maxDevices
        ? " (" + result.deviceCount + "/" + result.maxDevices + " dispositivos)"
        : "";
    toast((result.message || "Licença válida") + slots, "success");
    startSync();
    loadPlacarFromServer();
    // tenta registrar push (pode pedir permissão)
    subscribeWebPush().then(function (r) {
      if (r && r.ok) {
        console.log("[Live Max] Web Push ativo");
        toast("Notificações push ativas ✓", "success");
      } else if (r && r.error) {
        console.warn("[Live Max] Push:", r.error);
        setPushStatus(r.error, false);
      }
    });
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
  var confirmCancel = $("#confirm-end-cancel");
  var confirmOk = $("#confirm-end-ok");
  var confirmOverlay = $("#confirm-end-overlay");
  if (confirmCancel) confirmCancel.addEventListener("click", closeEndLiveConfirm);
  if (confirmOk) confirmOk.addEventListener("click", doEndLive);
  if (confirmOverlay) {
    confirmOverlay.addEventListener("click", function (e) {
      if (e.target === confirmOverlay) closeEndLiveConfirm();
    });
  }
  // Comissão %
  var commInput = $("#cfg-commission");
  if (commInput) {
    commInput.value = String(getCommissionPct());
    commInput.addEventListener("change", function () {
      var n = Number(commInput.value);
      if (isNaN(n) || n < 0) n = 0;
      if (n > 100) n = 100;
      state.commissionPct = n;
      localStorage.setItem("lm_commissionPct", String(n));
      commInput.value = String(n);
      renderPlacar();
      renderLive();
      renderHistory();
      toast("Comissão: " + n + "%", "success");
    });
  }

  if ($("#btn-enable-notifs")) {
    $("#btn-enable-notifs").addEventListener("click", async function () {
      toast("Ativando notificações…");
      const result = await subscribeWebPush();
      if (result.ok) {
        toast(result.message || "Push ativado — mesmo com o app fechado ✓", "success");
      } else {
        toast(result.error || "Não foi possível ativar", "danger");
      }
    });
  }

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
        ensureNotifPermission();
        startSync();
        loadPlacarFromServer();
        subscribeWebPush().then(function (r) {
          if (r && r.ok) console.log("[Live Max] Web Push restaurado");
          else if (r && r.error) setPushStatus(r.error, false);
        });
      } else {
        localStorage.removeItem("lm_token");
        state.token = "";
        state.licenseOk = false;
        showLogin((result && result.error) || "Sessão expirada. Entre novamente com um token válido.");
      }
    });
  }

  ensureServiceWorker().then(function (reg) {
    console.log("[Live Max] SW", reg ? "ok" : "off");
  });

  console.log("[Live Max Companion] v" + APP_VERSION);
})();
