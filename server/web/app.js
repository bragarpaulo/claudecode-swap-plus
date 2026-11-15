// Painel web do Swap Plus Servidor — JS puro, sem bibliotecas.
// CSP do servidor: só 'self' (nada de inline, eval ou innerHTML com dados). Todo texto entra por textContent.
// Desenho 2.3 (server/WEB-SPEC.md): menus Contas · Computadores · Usuários; "Minha conta" e "Histórico" no topo.
(function () {
  "use strict";

  // ------------------------------------------------------------ constantes

  const SECTIONS = ["contas", "computadores", "usuarios"];
  // Endereços antigos continuam valendo (o kit de recuperação volta do Google em /#acesso).
  const HASH_ALIASES = { geral: "contas", regras: "contas", acesso: "contas", "minha-conta": "contas", historico: "contas", acessos: "usuarios" };
  const REFRESH_MS = 30000;
  const STALE_USAGE_SEC = 20 * 60; // dado de uso mais velho que isso: mostrar a idade
  const LOGIN_WARN_MS = 3 * 86400000; // login que vence em menos de 3 dias: aviso amarelo
  const ADD_LOGIN_MS = 10 * 60000; // pedido de "Adicionar conta" vale 10 minutos
  const SOON = "disponível na próxima atualização do servidor";

  // Mesmos nomes e padrões de plus/rules.js (STRATEGY_LABELS, RULE_DEFAULTS).
  const STRATEGY_LABELS = { headroom: "Mais folga", max: "Aproveitar ao máximo", priority: "Por prioridade" };
  const RULE_DEFAULTS = {
    sessionPct: 90,
    weeklyPct: 80,
    modelPct: 95,
    preferModel: "Fable",
    strategy: "max",
    expiringHours: 24,
    cooldownMin: 5,
    marginPct: 5,
    intervalSec: 60,
    onModelLimit: "sameAccount",
  };
  // Regras que o painel edita (intervalSec é só do modo local da extensão).
  const RULE_KEYS = ["sessionPct", "weeklyPct", "modelPct", "preferModel", "strategy", "expiringHours", "cooldownMin", "marginPct", "onModelLimit"];
  const NUM_FIELDS = [
    { key: "expiringHours", id: "rExpiring", label: "Horas para “cota prestes a zerar”", min: 1, max: 168 },
    { key: "cooldownMin", id: "rCooldown", label: "Intervalo mínimo entre trocas", min: 0, max: 240 },
    { key: "marginPct", id: "rMargin", label: "Margem da conta de destino", min: 0, max: 30 },
  ];
  const RANGE_FIELDS = [
    { key: "sessionPct", id: "rSession" },
    { key: "weeklyPct", id: "rWeekly" },
    { key: "modelPct", id: "rModel" },
  ];

  const KIND_LABELS = {
    switch: "Troca",
    manual: "Troca manual",
    blocked: "Sem folga",
    error: "Erro",
    warn: "Aviso",
    alert: "Alerta",
    info: "Info",
    assign: "Atribuição",
    login: "Login",
    dead: "Login morto",
    refresh: "Renovação",
    device: "Computador",
  };
  const PLATFORMS = { darwin: "macOS", mac: "macOS", macos: "macOS", win32: "Windows", windows: "Windows", linux: "Linux" };
  const WANT_KIT_KEY = "sp_want_kit"; // voltou do Google para ver o kit de recuperação (sessionStorage)

  // ------------------------------------------------------------ estado

  let me = null; // { email, admin, csrf, expiresAt } de /web/api/me
  let kitTimer = null; // esconde o kit de recuperação sozinho
  let S = null; // PanelState de /web/api/state
  let skew = 0; // relógio do servidor - relógio do navegador (ms)
  let sessions = null; // resposta de /web/api/sessions
  let inflight = null; // carga do estado em andamento
  let lastLoadAt = 0;
  let loadFailed = false;
  let timer = null;
  let toastTimer = null;
  let pairTimer = null;
  let currentSec = "contas";

  let rulesDirty = false;
  let rulesBase = null; // valores que preencheram o formulário de regras
  let rulesBaseSig = null;

  let addLogin = null; // pedido de "Adicionar conta" em andamento { loginId, authUrl, expiresAt }
  let addTimer = null;
  let outOpen = false; // grupo "Fora da troca" aberto

  const acctDraft = new Map(); // número da conta → rascunho dos ajustes { alias, own, threshold, priority, devAll, devPicked }
  const acctOpen = new Set(); // contas com "Ajustes desta conta" aberto
  const devChoice = new Map(); // id do computador → opção escolhida em "Trocar para"
  const devRename = new Map(); // id do computador → nome sendo digitado (renomear aberto)
  const pending = new Set(); // vistas que esperam o foco sair para redesenhar
  const drawerOpener = new Map(); // id do painel lateral → elemento que o abriu (o foco volta para ele)

  // ------------------------------------------------------------ utilitários

  const $ = (id) => document.getElementById(id);
  const pad = (n) => String(n).padStart(2, "0");
  const clamp = (v) => Math.max(0, Math.min(100, Number(v) || 0));
  const fmtPct = (v) => `${Math.round(Number(v) || 0)}%`;
  const nowMs = () => Date.now() + skew;
  const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  const hasOwn = (o, k) => isObj(o) && Object.prototype.hasOwnProperty.call(o, k);
  const cmp = (x, y) => (x === y ? 0 : x < y ? -1 : 1);
  const safeId = (v) => String(v).replace(/[^A-Za-z0-9_-]/g, "_");
  const sameList = (x, y) => x.length === y.length && x.every((v, i) => v === y[i]);

  const BOOL_PROPS = new Set(["checked", "disabled", "open", "selected", "readOnly", "required", "hidden"]);

  /** Cria um elemento. props: class, text, value, on<evento>, booleanos e atributos comuns (nunca "style"). */
  function h(tag, props, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (BOOL_PROPS.has(k)) e[k] = !!v;
      else if (v === undefined || v === null || v === false) continue;
      else if (k === "class") e.className = v;
      else if (k === "text") e.textContent = v;
      else if (k === "value") e.value = v;
      else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v);
      else if (k !== "style") e.setAttribute(k, v === true ? "" : String(v));
    }
    for (const c of kids.flat()) {
      if (c === null || c === undefined || c === false || c === "") continue;
      e.append(c instanceof Node ? c : String(c));
    }
    return e;
  }

  /** Aceita epoch em ms (ou s), texto numérico ou ISO. */
  function toDate(v) {
    if (v === null || v === undefined || v === "" || v === 0) return null;
    let x = v;
    if (typeof x === "string" && /^\d+$/.test(x.trim())) x = Number(x);
    if (typeof x === "number" && x > 0 && x < 1e11) x *= 1000; // segundos
    const d = new Date(x);
    return isNaN(d.getTime()) ? null : d;
  }

  /** "hoje 18:00", "amanhã 09:30", "ontem 22:10", "sex 20/11 12:00" (fuso do navegador). */
  function fmtWhen(v) {
    const d0 = toDate(v);
    if (!d0) return null;
    const d = new Date(Math.round(d0.getTime() / 60000) * 60000);
    const now = new Date();
    const shift = (n) => {
      const x = new Date(now);
      x.setDate(now.getDate() + n);
      return x.toDateString();
    };
    const ds = d.toDateString();
    let day;
    if (ds === now.toDateString()) day = "hoje";
    else if (ds === shift(1)) day = "amanhã";
    else if (ds === shift(-1)) day = "ontem";
    else {
      const wd = d.toLocaleDateString("pt-BR", { weekday: "short" }).replace(".", "");
      day = `${wd} ${pad(d.getDate())}/${pad(d.getMonth() + 1)}${d.getFullYear() !== now.getFullYear() ? `/${d.getFullYear()}` : ""}`;
    }
    return `${day} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  /** Só o dia: "hoje", "ontem", "20/11/2026". */
  function fmtDay(v) {
    const d = toDate(v);
    if (!d) return null;
    const now = new Date();
    if (d.toDateString() === now.toDateString()) return "hoje";
    const y = new Date(now);
    y.setDate(now.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return "ontem";
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
  }

  /** Duração em palavras: "40 minutos", "5 horas", "2 dias". */
  function fmtSpan(ms) {
    const min = Math.max(1, Math.round(ms / 60000));
    if (min < 60) return min === 1 ? "1 minuto" : `${min} minutos`;
    const hours = Math.round(min / 60);
    if (hours < 24) return hours === 1 ? "1 hora" : `${hours} horas`;
    const days = Math.floor(min / 1440);
    return days === 1 ? "1 dia" : `${days} dias`;
  }

  function isoOf(v) {
    const d = toDate(v);
    return d ? d.toISOString() : null;
  }

  function apiError(status, code, message, retryAfter) {
    const e = new Error(message);
    e.status = status;
    e.code = code;
    e.retryAfter = retryAfter || null;
    return e;
  }

  function defaultMessage(status) {
    if (status === 403) return "O servidor recusou esta ação. Recarregue a página e tente de novo.";
    if (status === 404) return "Não encontrei isso no servidor (talvez já tenha sido removido). A tela foi atualizada.";
    if (status === 409) return "Não deu para fazer isso agora. A tela foi atualizada; confira e tente de novo.";
    if (status === 413) return "Dados grandes demais para o servidor.";
    if (status === 429) return "Muitas tentativas seguidas. Espere alguns minutos e tente de novo.";
    if (status >= 500) return "O servidor teve um problema. Tente de novo em instantes.";
    return `Algo deu errado (código ${status}). Tente de novo.`;
  }

  /** Rota que o servidor ainda não tem (versão antiga): 405, ou 404 "rota não encontrada". */
  function isMissingRoute(status, data) {
    if (status === 405) return true;
    return status === 404 && isObj(data) && data.error === "not_found" && /rota n[ãa]o encontrada/i.test(String(data.message || ""));
  }

  /** Chamada à API do painel. Mudanças levam X-CSRF-Token e Content-Type JSON. 401 volta para a tela de entrada. */
  async function api(method, path, body) {
    const opts = { method, credentials: "same-origin", cache: "no-store", headers: { Accept: "application/json" } };
    if (me && me.csrf) opts.headers["X-CSRF-Token"] = me.csrf; // também nas leituras (o kit de recuperação exige)
    if (method !== "GET") {
      opts.headers["Content-Type"] = "application/json";
      opts.headers["X-CSRF-Token"] = (me && me.csrf) || "";
      if (body !== undefined) opts.body = JSON.stringify(body);
      else if (method !== "DELETE") opts.body = "{}";
    }
    let res;
    try {
      res = await fetch(path, opts);
    } catch {
      throw apiError(0, "network", "Sem conexão com o servidor. Confira a internet e tente de novo.");
    }
    let data = null;
    let text = "";
    try {
      text = await res.text();
    } catch {}
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }
    if (res.ok) return data;
    if (res.status === 401) {
      onUnauthorized();
      throw apiError(401, "unauthorized", "Sua sessão terminou. Entre de novo com Google.");
    }
    if (isMissingRoute(res.status, data)) throw apiError(res.status, "unavailable", `Isso fica ${SOON}.`);
    const msg = data && typeof data.message === "string" && data.message.trim() ? data.message.trim() : defaultMessage(res.status);
    let full = msg;
    if (res.status === 403 && !/recus|permiss|negad|liberad/i.test(msg)) full = `Ação recusada: ${msg}`;
    const ra = Number(res.headers.get("Retry-After"));
    if (res.status === 429 && ra > 0) full = `${msg} (de novo em ${fmtSpan(ra * 1000)})`;
    throw apiError(res.status, (data && data.error) || `http_${res.status}`, full, ra > 0 ? ra : null);
  }

  // ------------------------------------------------------------ aviso (toast) e confirmação

  /** Janela modal aberta por cima (o aviso precisa ficar dentro dela para aparecer e ser lido). */
  function topDialog() {
    if ($("confirmDlg").open) return $("confirmDlg");
    for (const id of ["historyDlg", "accountDlg"]) if ($(id).open) return $(id);
    return null;
  }

  function toast(text, kind) {
    const t = $("toast");
    const host = topDialog() || document.body;
    if (t.parentNode !== host) host.append(t);
    t.setAttribute("role", kind === "error" ? "alert" : "status");
    t.textContent = text;
    t.className = "toast" + (kind === "error" ? " error" : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add("hidden"), kind === "error" ? 10000 : 5000);
  }

  function hideToast() {
    clearTimeout(toastTimer);
    $("toast").classList.add("hidden");
  }

  /** Devolve o aviso para a página quando a janela que o guardava fecha. */
  function rehomeToast(dlg) {
    const t = $("toast");
    if (t.parentNode === dlg) {
      const host = topDialog() || document.body;
      host.append(t);
    }
  }

  /** Caixa de confirmação (dialog nativo). → Promise<boolean> */
  function confirmBox({ title, text, ok = "Confirmar" }) {
    const dlg = $("confirmDlg");
    const opener = document.activeElement;
    const openerKey = opener && opener.getAttribute ? opener.getAttribute("data-k") : null;
    if (typeof dlg.showModal !== "function") return Promise.resolve(window.confirm(`${title}\n\n${text}`));
    $("confirmTitle").textContent = title;
    $("confirmText").textContent = text;
    $("confirmOk").textContent = ok;
    return new Promise((resolve) => {
      let settled = false;
      const done = (v) => {
        if (settled) return;
        settled = true;
        $("confirmOk").removeEventListener("click", onOk);
        $("confirmCancel").removeEventListener("click", onCancel);
        dlg.removeEventListener("cancel", onEsc);
        dlg.removeEventListener("close", onClose);
        if (dlg.open) dlg.close();
        rehomeToast(dlg);
        if (opener && opener.isConnected && typeof opener.focus === "function") opener.focus();
        else refocus(openerKey);
        resolve(v);
      };
      const onOk = () => done(true);
      const onCancel = () => done(false);
      const onEsc = (e) => {
        e.preventDefault();
        done(false);
      };
      const onClose = () => done(false);
      $("confirmOk").addEventListener("click", onOk);
      $("confirmCancel").addEventListener("click", onCancel);
      dlg.addEventListener("cancel", onEsc);
      dlg.addEventListener("close", onClose);
      dlg.showModal();
      $("confirmCancel").focus();
    });
  }

  function refocus(key) {
    if (!key) return;
    const a = document.activeElement;
    if (a && a !== document.body && a.isConnected && a.getAttribute("data-k") !== key) return;
    const el = document.querySelector(`[data-k="${CSS.escape(key)}"]`);
    if (el && !el.disabled) el.focus({ preventScroll: true });
  }

  /**
   * Executa uma ação que muda algo: trava o botão, chama a API, recarrega o estado e avisa.
   * o.before: roda logo depois do sucesso (antes de redesenhar). o.ok: texto ou função → texto.
   * → true se deu certo.
   */
  async function act(btn, fn, o = {}) {
    const key = btn && btn.getAttribute ? btn.getAttribute("data-k") : null;
    if (btn) {
      btn.disabled = true;
      btn.setAttribute("aria-busy", "true");
    }
    let ok = false;
    try {
      const r = await fn();
      ok = true;
      if (o.before) o.before(r);
      if (o.reload !== false) await loadState(false);
      if (o.after) o.after(r);
      const text = typeof o.ok === "function" ? o.ok(r) : o.ok;
      if (text) toast(text);
    } catch (e) {
      if (e.status !== 401) {
        toast(e.message || "Algo deu errado. Tente de novo.", "error");
        if (e.code !== "unavailable" && (e.status === 404 || e.status === 409)) loadState(false);
      }
    } finally {
      if (btn && btn.isConnected) {
        btn.disabled = false;
        btn.removeAttribute("aria-busy");
      }
      refocus(key);
    }
    return ok;
  }

  // ------------------------------------------------------------ telas

  function show(id) {
    for (const s of ["screenLoading", "screenLogin", "screenPanel"]) $(s).classList.toggle("hidden", s !== id);
  }

  function resetSession() {
    stopTimer();
    closeDrawers();
    me = null;
    S = null;
    sessions = null;
    rulesDirty = false;
    rulesBase = null;
    rulesBaseSig = null;
    outOpen = false;
    acctDraft.clear();
    acctOpen.clear();
    devChoice.clear();
    devRename.clear();
    pending.clear();
    $("pairBox").classList.add("hidden");
    $("pairCode").value = "";
    clearTimeout(pairTimer);
    hideAddBox();
    hideRecovery();
  }

  function showLogin(msg) {
    resetSession();
    const m = $("loginMsg");
    m.textContent = msg || "";
    m.classList.toggle("hidden", !msg);
    show("screenLogin");
  }

  function onUnauthorized() {
    const wasIn = !!me;
    showLogin(wasIn ? "Sua sessão terminou. Entre de novo com Google." : "");
  }

  // ------------------------------------------------------------ carga dos dados

  function needSessions() {
    return $("accountDlg").open;
  }

  function loadState(manual) {
    if (inflight) return inflight.then(() => loadState(manual)); // espera a atual e busca de novo (dados frescos depois de uma ação)
    inflight = doLoad(manual).finally(() => {
      inflight = null;
    });
    return inflight;
  }

  async function doLoad(manual) {
    if (!me) return;
    try {
      const st = await api("GET", "/web/api/state");
      if (!isObj(st) || !Array.isArray(st.accounts)) throw apiError(0, "bad_response", "O servidor mandou uma resposta inesperada.");
      S = st;
      const srv = toDate(st.serverTime);
      skew = srv ? srv.getTime() - Date.now() : 0;
      if (Math.abs(skew) < 5000) skew = 0;
      lastLoadAt = Date.now();
      loadFailed = false;
      if (needSessions()) await loadSessions(false);
      renderAll();
      if (manual === "button") toast("Atualizado.");
    } catch (e) {
      if (e.status === 401) return;
      loadFailed = true;
      renderSync();
      if (manual) toast(e.message, "error");
    }
  }

  async function loadSessions(manual) {
    try {
      sessions = await api("GET", "/web/api/sessions");
      if (S) paint("sessions");
    } catch (e) {
      if (e.status === 401) return;
      if (sessions === null) sessions = { error: e.message };
      if (S) paint("sessions");
      if (manual) toast(e.message, "error");
    }
  }

  function startTimer() {
    stopTimer();
    timer = setInterval(() => {
      if (!me || inflight || document.visibilityState !== "visible") return;
      if ($("confirmDlg").open) return; // não redesenhar por trás da confirmação
      loadState(false);
    }, REFRESH_MS);
  }

  function stopTimer() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  // ------------------------------------------------------------ peças de dados

  const accounts = () => (S && Array.isArray(S.accounts) ? S.accounts : []);
  const devices = () => (S && Array.isArray(S.devices) ? S.devices : []);
  const accById = (n) => accounts().find((a) => Number(a.number) === Number(n)) || null;
  const devById = (id) => devices().find((d) => String(d.id) === String(id)) || null;
  const myEmail = () => String((S && S.me && S.me.email) || (me && me.email) || "").toLowerCase();
  const byNumber = (x, y) => Number(x.number) - Number(y.number);
  const devName = (d) => (d && d.name) || "Computador sem nome";
  const sortedDevices = () => [...devices()].sort((x, y) => devName(x).localeCompare(devName(y), "pt-BR") || String(x.id).localeCompare(String(y.id)));

  /**
   * Mesma chave do servidor (google.js emailKey) para comparar contas Google: minúsculas; no Gmail
   * (gmail.com / googlemail.com) sem pontos e sem "+algo" na parte local.
   */
  function emailKey(v) {
    const e = String(v || "").trim().toLowerCase();
    const at = e.lastIndexOf("@");
    if (at <= 0 || at === e.length - 1) return "";
    let local = e.slice(0, at);
    let domain = e.slice(at + 1);
    if (domain === "gmail.com" || domain === "googlemail.com") {
      const plus = local.indexOf("+");
      if (plus >= 0) local = local.slice(0, plus);
      local = local.replace(/\./g, "");
      domain = "gmail.com";
      if (!local) return "";
    }
    return `${local}@${domain}`;
  }
  const sameEmail = (a, b) => {
    const k = emailKey(a);
    return !!k && k === emailKey(b);
  };
  const adminList = () => (S && Array.isArray(S.adminEmails) ? S.adminEmails.map(String) : []);
  const isAdminEmail = (email) => adminList().some((a) => sameEmail(a, email));
  /** Lista de usuários liberados (aceita texto ou { email, ... }). */
  const allowedList = () =>
    (S && Array.isArray(S.allowedEmails) ? S.allowedEmails : [])
      .map((x) => (typeof x === "string" ? x : isObj(x) && typeof x.email === "string" ? x.email : null))
      .filter(Boolean);

  function defaults() {
    return { ...RULE_DEFAULTS, ...(S && isObj(S.ruleDefaults) ? S.ruleDefaults : {}) };
  }

  function rules() {
    const r = { ...defaults(), ...(S && isObj(S.rules) ? S.rules : {}) };
    if (!STRATEGY_LABELS[r.strategy]) r.strategy = RULE_DEFAULTS.strategy;
    return r;
  }

  function accountLabel(n) {
    const a = accById(n);
    if (!a) return `Conta ${n}`;
    return `Conta ${a.number}${a.alias ? ` “${a.alias}”` : ""}${a.email ? ` · ${a.email}` : ""}`;
  }

  function hasOwnLine(a) {
    return a.threshold !== null && a.threshold !== undefined && a.threshold !== "" && Number.isFinite(Number(a.threshold));
  }

  function linesFor(a) {
    const r = rules();
    return { session: hasOwnLine(a) ? Number(a.threshold) : Number(r.sessionPct), weekly: Number(r.weeklyPct), model: Number(r.modelPct) };
  }

  /** Uso que vale mostrar: o atual (ok) ou o último bom. */
  function usageOf(a) {
    if (a.usageStatus === "ok" && isObj(a.usage)) return { u: a.usage, age: a.usageAgeSeconds, old: false };
    if (isObj(a.lastGoodUsage)) return { u: a.lastGoodUsage, age: a.lastGoodAgeSeconds, old: true };
    return null;
  }

  const isDead = (a) => !!a.dead || a.usageStatus === "relogin_required";

  /** Verde abaixo de 70% da linha, amarelo perto, vermelho na linha. */
  function sev(pct, line) {
    const p = Number(pct) || 0;
    const l = Number(line) || 100;
    if (p >= l) return "bad";
    if (p >= l * 0.7) return "warn";
    return "ok";
  }

  function deviceNames(a) {
    return (Array.isArray(a.assignedDevices) ? a.assignedDevices : [])
      .map((d) => (typeof d === "string" ? d : d && (d.name || d.id)))
      .filter(Boolean);
  }

  function platformLabel(p) {
    if (!p) return "—";
    return PLATFORMS[String(p).toLowerCase()] || String(p);
  }

  function modelNames() {
    const names = new Set();
    for (const a of accounts()) {
      for (const src of [a.usage, a.lastGoodUsage]) {
        if (isObj(src) && Array.isArray(src.scoped)) for (const s of src.scoped) if (s && s.name) names.add(String(s.name));
      }
    }
    return [...names].sort();
  }

  /** "Computadores permitidos" da conta: null = todos, [ids] = só esses, undefined = o servidor ainda não manda. */
  function accDevices(a) {
    if (!hasOwn(a, "devices")) return undefined;
    return Array.isArray(a.devices) ? a.devices.map(String) : null;
  }
  const hasAccDevices = () => accounts().some((a) => hasOwn(a, "devices"));

  /** Contas que o computador pode usar: Set de números, ou null (= todas). */
  function allowedFor(d) {
    if (hasOwn(d, "allowedAccounts")) return Array.isArray(d.allowedAccounts) ? new Set(d.allowedAccounts.map(Number)) : null;
    if (!hasAccDevices()) return null;
    const s = new Set();
    for (const a of accounts()) {
      const l = accDevices(a);
      if (l === null || l === undefined || l.includes(String(d.id))) s.add(Number(a.number));
    }
    return s;
  }

  /**
   * Ordem da fila (pedido do dono): primeiro a conta cujo limite semanal renova antes; em empate (mesmo minuto),
   * a menos usada. Sem leitura de uso vai depois; login morto por último.
   */
  function queueOrder(list) {
    const key = (a) => {
      const f = usageOf(a);
      const w = f && isObj(f.u.sevenDay) ? f.u.sevenDay : null;
      const r = w ? toDate(w.resetsAt) : null;
      return {
        dead: isDead(a) ? 1 : 0,
        reset: r ? Math.floor(r.getTime() / 60000) : Infinity,
        used: w ? Number(w.pct) || 0 : Infinity,
        n: Number(a.number),
      };
    };
    return list
      .map((a) => ({ a, k: key(a) }))
      .sort((x, y) => x.k.dead - y.k.dead || cmp(x.k.reset, y.k.reset) || cmp(x.k.used, y.k.used) || x.k.n - y.k.n)
      .map((o) => o.a);
  }

  // ------------------------------------------------------------ redesenho com foco preservado

  const VIEWS = {
    warnings: { el: () => $("warningsList"), render: renderWarnings },
    accounts: { el: () => $("accounts"), render: renderAccounts },
    devices: { el: () => $("devices"), render: renderDevices },
    users: { el: () => $("usersBody"), render: renderUsers },
    sessions: { el: () => $("sessionsList"), render: renderSessions },
    history: { el: () => $("history"), render: renderHistory },
  };

  /** Alguém digitando/escolhendo dentro da caixa: não redesenhar agora. */
  function isHeld(box) {
    const a = document.activeElement;
    if (!a || !box.contains(a)) return false;
    if (a.tagName === "SELECT" || a.tagName === "TEXTAREA") return true;
    return a.tagName === "INPUT" && !["checkbox", "radio", "button", "submit", "range"].includes(a.type);
  }

  function paint(name, force) {
    const v = VIEWS[name];
    const box = v.el();
    if (!S) return;
    if (!force && isHeld(box)) {
      pending.add(name);
      return;
    }
    pending.delete(name);
    const a = document.activeElement;
    const key = a && box.contains(a) ? a.getAttribute("data-k") : null;
    v.render(box);
    if (key) {
      const el = box.querySelector(`[data-k="${CSS.escape(key)}"]`);
      if (el && !el.disabled) el.focus({ preventScroll: true });
    }
  }

  function wireHolds() {
    for (const name of Object.keys(VIEWS)) {
      const box = VIEWS[name].el();
      box.addEventListener("focusout", () => {
        setTimeout(() => {
          if (pending.has(name) && !isHeld(box)) paint(name);
        }, 0);
      });
    }
  }

  function renderAll() {
    if (!S) return;
    renderMe();
    paint("warnings");
    renderSummary();
    paint("accounts");
    paint("devices");
    renderConnect();
    fillRules(false);
    paint("users");
    renderGoogleInfo();
    paint("sessions");
    paint("history");
    renderCounts();
    renderSync();
    $("footer").textContent = S.version ? `Swap Plus Servidor ${S.version}` : "Swap Plus Servidor";
  }

  function renderSync() {
    const el = $("syncStatus");
    const when = lastLoadAt ? fmtWhen(lastLoadAt) : null;
    el.classList.toggle("warntext", loadFailed);
    el.textContent = loadFailed
      ? `Sem conexão com o servidor${when ? ` — dados de ${when}` : ""}`
      : when
        ? `Atualizado ${when} · atualiza sozinho a cada 30 s`
        : "";
  }

  function renderCounts() {
    const set = (id, n) => {
      const el = $(id);
      el.textContent = n ? String(n) : "";
      el.classList.toggle("hidden", !n);
    };
    set("count-contas", accounts().length);
    set("count-computadores", devices().length);
    set("count-usuarios", userRows().length);
  }

  // ------------------------------------------------------------ topo: Minha conta

  function renderMe() {
    const email = (S && S.me && S.me.email) || (me && me.email) || "";
    $("meEmail").textContent = email;
    const initial = (email.trim()[0] || "?").toUpperCase();
    $("meAvatar").textContent = initial;
    $("meAvatarBig").textContent = initial;
    const list = adminList();
    const others = list.filter((a) => !sameEmail(a, email));
    $("adminInfo").textContent = !list.length
      ? "Nenhum administrador definido no servidor (ADMIN_EMAILS)."
      : `Administrador (definido no servidor, ADMIN_EMAILS). Só o administrador entra neste painel.${others.length ? ` Outros administradores: ${others.join(", ")}.` : ""}`;
  }

  // ------------------------------------------------------------ painéis laterais (Minha conta, Histórico)

  function openDrawer(id, opener) {
    const dlg = $(id);
    if (dlg.open) return;
    for (const other of ["accountDlg", "historyDlg"]) if (other !== id && $(other).open) $(other).close();
    drawerOpener.set(id, opener || document.activeElement);
    if (typeof dlg.showModal === "function") dlg.showModal();
    else dlg.setAttribute("open", "");
    if (id === "accountDlg" && me && S) loadSessions(false);
    if (id === "historyDlg" && S) paint("history", true);
  }

  function closeDrawers() {
    for (const id of ["accountDlg", "historyDlg"]) {
      const dlg = $(id);
      if (dlg && dlg.open) {
        if (typeof dlg.close === "function") dlg.close();
        else dlg.removeAttribute("open");
      }
    }
  }

  function wireDrawer(id, closeId) {
    const dlg = $(id);
    $(closeId).addEventListener("click", () => dlg.close());
    // Clique fora do painel (no fundo escurecido) fecha.
    dlg.addEventListener("click", (e) => {
      if (e.target === dlg) dlg.close();
    });
    dlg.addEventListener("close", () => {
      rehomeToast(dlg);
      const op = drawerOpener.get(id);
      drawerOpener.delete(id);
      if (me && op && op.isConnected && typeof op.focus === "function") op.focus({ preventScroll: true });
    });
  }

  // ------------------------------------------------------------ avisos e resumo

  function renderWarnings(box) {
    const list = Array.isArray(S.warnings) ? S.warnings.filter((w) => w && w.text) : [];
    $("warnings").classList.toggle("hidden", !list.length);
    box.replaceChildren(
      ...list.map((w, i) => {
        const bad = /dead|morto|error|erro|off|revok|down/i.test(String(w.kind || ""));
        const n = w.account !== undefined && w.account !== null && accById(w.account) ? Number(w.account) : null;
        return h(
          "li",
          { class: "warning " + (bad ? "bad" : "warn") },
          h("span", { class: "wico", "aria-hidden": "true" }),
          h("span", { class: "wtext" }, h("span", { class: "visually-hidden", text: bad ? "Problema: " : "Atenção: " }), String(w.text)),
          n !== null
            ? h("button", { type: "button", class: "linkbtn", "data-k": `warn-${i}`, text: `Ver conta ${n}`, onclick: () => goToAccount(n) })
            : null
        );
      })
    );
  }

  function renderSummary() {
    const accs = accounts();
    const inQ = accs.filter((a) => !a.disabled).length;
    const devs = devices();
    const activeDevs = devs.filter((d) => d.active).length;
    const r = rules();
    const parts = [
      accs.length === 1 ? "1 conta" : `${accs.length} contas`,
      accs.length ? (inQ === 1 ? "1 na troca" : `${inQ} na troca`) : null,
      devs.length === 1 ? `1 computador (${activeDevs ? "ativo agora" : "parado"})` : `${devs.length} computadores (${activeDevs} ativo${activeDevs === 1 ? "" : "s"} agora)`,
      S.autoSwitch !== false ? "troca automática ligada" : "troca automática desligada",
      `estratégia “${STRATEGY_LABELS[r.strategy] || r.strategy}”`,
    ].filter(Boolean);
    $("summary").textContent = parts.join(" · ");
  }

  function goToAccount(n) {
    selectSection("contas", false);
    const a = accById(n);
    if (a && a.disabled) {
      outOpen = true;
      const g = $("accounts").querySelector(".outgroup");
      if (g) g.open = true;
    }
    const card = $(`conta-${n}`);
    if (card) {
      card.scrollIntoView({ block: "start" });
      card.focus({ preventScroll: true });
    }
  }

  // ------------------------------------------------------------ Contas

  function badge(cls, text) {
    return h("span", { class: "badge " + cls, text });
  }

  /** Bloco de "lista vazia": título curto + o que fazer. */
  function emptyState(title, text) {
    return h("div", { class: "emptystate card" }, h("p", { class: "emptytitle", text: title }), h("p", { class: "muted", text }));
  }

  /** Barra de uso. opt.mini: versão pequena (sem a linha de "renova"), para os quadradinhos dos computadores. */
  function meter(label, longLabel, pct, line, resetsAt, opt = {}) {
    const p = clamp(pct);
    const s = sev(p, line);
    const fill = h("span", { class: "fill " + s });
    fill.style.width = `${p}%`;
    const mark = h("span", { class: "linemark" });
    mark.style.left = `${clamp(line)}%`;
    const sevText = s === "bad" ? "na linha de troca" : s === "warn" ? "perto da linha de troca" : "longe da linha de troca";
    const when = resetsAt ? fmtWhen(resetsAt) : null;
    const foot = opt.idle
      ? `sem uso nas últimas 5 horas · linha ${fmtPct(line)}${opt.own ? " (própria)" : ""}`
      : `${when ? `renova ${when} · ` : ""}linha ${fmtPct(line)}${opt.own ? " (própria)" : ""}`;
    return h(
      "div",
      { class: "meter" + (opt.mini ? " mini" : "") },
      h("span", { class: "lbl", "aria-hidden": "true", text: label }),
      h("span", { class: "bar", "aria-hidden": "true" }, fill, mark),
      h("span", { class: "pct " + s, "aria-hidden": "true", text: fmtPct(p) }),
      h("span", { class: "visually-hidden", text: `${longLabel}: ${fmtPct(p)} usado, ${sevText} (${fmtPct(line)})${when ? `, renova ${when}` : ""}.` }),
      opt.mini ? null : h("span", { class: "reset", text: foot })
    );
  }

  /** Barras de uso de uma conta (cheias no cartão da conta, pequenas no quadradinho do computador). */
  function usageMeters(a, mini) {
    const lines = linesFor(a);
    const own = hasOwnLine(a);
    const f = usageOf(a);
    const box = h("div", { class: "meters" + (mini ? " minis" : "") });
    if (!f) {
      box.append(
        h("p", {
          class: "muted small",
          text: isDead(a) ? "Sem dados de uso." : mini ? "Ainda sem leitura de uso." : "Ainda sem leitura de uso (o servidor lê o uso de cada conta de alguns em alguns minutos).",
        })
      );
      return box;
    }
    const u = f.u;
    const five = isObj(u.fiveHour) ? u.fiveHour : null;
    box.append(meter(mini ? "5h" : "Sessão 5h", "Sessão de 5 horas", five ? five.pct : 0, lines.session, five ? five.resetsAt : null, { idle: !five, own, mini }));
    if (isObj(u.sevenDay)) box.append(meter("Semanal", "Limite semanal", u.sevenDay.pct, lines.weekly, u.sevenDay.resetsAt, { mini }));
    for (const s of Array.isArray(u.scoped) ? u.scoped : []) {
      if (s && s.name) box.append(meter(String(s.name), `Limite semanal do ${s.name}`, s.pct, lines.model, s.resetsAt, { mini }));
    }
    const age = Number(f.age);
    if (!mini && (f.old || (Number.isFinite(age) && age > STALE_USAGE_SEC))) {
      box.append(
        h("p", {
          class: "muted small",
          text: `Dados de uso de ${Number.isFinite(age) ? `${fmtSpan(age * 1000)} atrás` : "antes"}${f.old ? " (a leitura mais recente falhou)" : ""}.`,
        })
      );
    }
    return box;
  }

  /** Texto de "Computadores permitidos" de uma conta. */
  function allowedDevicesText(a) {
    const l = accDevices(a);
    if (l === undefined) return SOON;
    if (l === null) return "todos";
    if (!l.length) return "nenhum";
    return l
      .map((id) => {
        const dv = devById(id);
        return dv ? devName(dv) : "computador desconectado";
      })
      .join(", ");
  }

  function accountCard(a, pos) {
    const n = Number(a.number);
    const dead = isDead(a);
    const devs = deviceNames(a);
    const plan = a.plan && a.plan.label ? a.plan.label : null;
    const org = a.organizationName || a.orgName || null;
    const sub = [plan, org].filter(Boolean).join(" · ");
    const titleId = `acc-${n}-title`;

    // --- cabeçalho
    const head = h(
      "div",
      { class: "ahead" },
      h(
        "div",
        { class: "aid" },
        h("h3", { class: "aname", id: titleId }, h("span", { class: "n", text: `Conta ${n}` }), a.alias ? h("span", { class: "alias", text: `“${a.alias}”` }) : null),
        a.email ? h("div", { class: "email", text: a.email }) : null,
        sub ? h("div", { class: "sub", text: sub }) : null
      ),
      h(
        "div",
        { class: "badges" },
        pos ? badge("plain", `${pos}º na fila`) : null,
        dead ? badge("dead", "Login morto") : null,
        a.disabled ? badge("plain", "Fora da troca") : null,
        devs.length ? badge("on", devs.length === 1 ? "Em 1 computador" : `Em ${devs.length} computadores`) : null
      )
    );

    // --- situação (ok: linha discreta; login morto: caixa vermelha; fora da troca: texto apagado)
    const sitParts = [];
    if (dead) sitParts.push(h("span", { class: "badtext", text: "login morto — entre de novo com esta conta (botão “Adicionar conta” ou no Claude Code de um computador conectado)" }));
    if (a.disabled) sitParts.push(h("span", { class: "muted", text: `${dead ? " · " : ""}fora da troca (a troca automática não usa esta conta)` }));
    if (!dead && !a.disabled) sitParts.push(h("span", { class: "oktext", text: "ok" }));
    const sit = h(
      "p",
      { class: "sit" + (dead ? " callout" : a.disabled ? " off" : "") },
      h("span", { class: "dot " + (dead ? "bad" : a.disabled ? "" : "on"), "aria-hidden": "true" }),
      h("span", { class: "sittext" }, h("span", { class: "k", text: "Situação: " }), sitParts)
    );

    // --- detalhes (grade de 2 colunas: rótulo pequeno em cima, valor embaixo)
    const accDate = toDate(a.accessExpiresAt);
    const refDate = toDate(a.lastRefreshAt);
    const loginDate = toDate(a.loginExpiresAt);
    const t = nowMs();
    let accessMain = "—";
    let accessSub = null;
    if (!dead && accDate) {
      accessMain = accDate.getTime() > t ? `vale até ${fmtWhen(accDate)}` : `venceu ${fmtWhen(accDate)}`;
      accessSub = `o servidor renova sozinho${refDate ? ` · renovado ${fmtWhen(refDate)}` : ""}`;
    } else if (!dead && refDate) {
      accessMain = `renovado ${fmtWhen(refDate)}`;
    }
    const permitted = allowedDevicesText(a);
    const fact = (k, v, cls) => h("div", { class: "fact" }, h("dt", { text: k }), h("dd", { class: cls || null }, v));
    const info = h(
      "dl",
      { class: "info" },
      fact("Computadores nela", devs.length ? devs.join(", ") : "nenhum agora", devs.length ? null : "muted"),
      fact("Computadores permitidos", permitted, permitted === SOON ? "muted" : null),
      fact("Acesso atual", [accessMain, accessSub ? h("span", { class: "factsub", text: ` (${accessSub})` }) : null]),
      fact("Login vale até", loginDate ? fmtWhen(loginDate) : "sem data conhecida", loginDate ? null : "muted")
    );

    let loginWarn = null;
    if (loginDate && !dead) {
      const left = loginDate.getTime() - t;
      if (left <= 0) {
        loginWarn = h("p", { class: "warnbox bad", text: "O login venceu — entre de novo com esta conta (botão “Adicionar conta” ou no Claude Code de um computador conectado)." });
      } else if (left < LOGIN_WARN_MS) {
        loginWarn = h("p", { class: "warnbox", text: `Login vence em ${fmtSpan(left)} — entre de novo com esta conta (botão “Adicionar conta” ou no Claude Code de um computador conectado).` });
      }
    }

    // --- participa da troca (vale na hora)
    const rotId = `acc-${n}-rot`;
    const rot = h("input", {
      type: "checkbox",
      class: "sw",
      role: "switch",
      id: rotId,
      "data-k": rotId,
      checked: !a.disabled,
      onchange: (e) => {
        const on = e.target.checked;
        if (!on) outOpen = true; // a conta desce para "Fora da troca": deixar o grupo aberto para ela não sumir
        act(e.target, () => api("PATCH", `/web/api/accounts/${n}`, { disabled: !on }), {
          ok: on ? `Conta ${n} de volta à troca.` : `Conta ${n} fora da troca: a troca automática não vai usá-la. Ela fica no grupo “Fora da troca”, embaixo.`,
        });
      },
    });
    const rotRow = h("label", { class: "switchrow", for: rotId }, rot, h("span", { text: "Participa da troca" }));

    // Rodapé do cartão (sempre no pé, para os cartões lado a lado ficarem alinhados):
    // liga/desliga da troca; "Ajustes desta conta" com "Remover conta" na mesma linha, à direita.
    return h(
      "article",
      { class: "card acct" + (a.disabled ? " off" : "") + (dead ? " deadacc" : ""), id: `conta-${n}`, tabindex: "-1", "aria-labelledby": titleId },
      head,
      sit,
      usageMeters(a, false),
      info,
      loginWarn,
      h(
        "div",
        { class: "abottom" },
        rotRow,
        h(
          "div",
          { class: "aactions" },
          adjustForm(a),
          h(
            "div",
            { class: "afoot" },
            h("button", {
              type: "button",
              class: "danger subtle small",
              "data-k": `acc-${n}-del`,
              text: "Remover conta",
              "aria-label": `Remover a Conta ${n}`,
              onclick: (e) => removeAccount(a, e.currentTarget),
            })
          )
        )
      )
    );
  }

  /**
   * "Ajustes desta conta": apelido, linha própria da sessão, prioridade e computadores permitidos,
   * com rascunho (sobrevive à atualização de 30 s) e Salvar/Desfazer.
   */
  function adjustForm(a) {
    const n = Number(a.number);
    const own = hasOwnLine(a);
    const r = rules();
    const permitted = accDevices(a); // undefined = servidor antigo
    const devKnown = permitted !== undefined;
    const knownIds = new Set(devices().map((x) => String(x.id)));
    const orig = {
      alias: a.alias || "",
      own,
      threshold: String(own ? Number(a.threshold) : Number(r.sessionPct)),
      priority: String(Number(a.priority) || 0),
      devAll: !permitted,
      devPicked: permitted ? permitted.filter((x) => knownIds.has(x)).sort() : [],
    };
    const d = acctDraft.get(n) || orig;
    const id = (s) => `acc-${n}-${s}`;

    const fAlias = h("input", { type: "text", id: id("alias"), "data-k": id("alias"), maxlength: "40", autocomplete: "off", value: d.alias });
    const fOwn = h("input", { type: "checkbox", id: id("own"), "data-k": id("own"), checked: d.own });
    const fTh = h("input", {
      type: "number",
      id: id("th"),
      "data-k": id("th"),
      min: "50",
      max: "100",
      step: "1",
      inputmode: "numeric",
      value: d.threshold,
      disabled: !d.own,
      "aria-describedby": id("thHint"),
    });
    const fPr = h("input", {
      type: "number",
      id: id("pr"),
      "data-k": id("pr"),
      min: "0",
      max: "1000",
      step: "1",
      inputmode: "numeric",
      value: d.priority,
      "aria-describedby": id("prHint"),
    });

    // --- computadores permitidos
    let devSet;
    let readDevs = () => ({ devAll: orig.devAll, devPicked: orig.devPicked });
    let syncDevs = () => {};
    if (!devKnown) {
      devSet = h("fieldset", { class: "subfield" }, h("legend", { text: "Computadores permitidos" }), h("p", { class: "hint", text: `Escolher os computadores de cada conta: ${SOON}.` }));
    } else {
      const all = sortedDevices();
      const picked = new Set(d.devPicked.filter((x) => knownIds.has(x)));
      const rAll = h("input", { type: "radio", name: id("devmode"), id: id("devall"), "data-k": id("devall"), value: "all", checked: d.devAll });
      const rSome = h("input", { type: "radio", name: id("devmode"), id: id("devsome"), "data-k": id("devsome"), value: "some", checked: !d.devAll, disabled: !all.length && d.devAll });
      const boxes = all.map((dv) =>
        h("input", {
          type: "checkbox",
          id: id(`dv-${safeId(dv.id)}`),
          "data-k": id(`dv-${safeId(dv.id)}`),
          value: String(dv.id),
          checked: picked.has(String(dv.id)),
          disabled: d.devAll,
        })
      );
      // Ao sair de "Todos" sem nada marcado, começa com todos marcados (para não trancar ninguém).
      rSome.addEventListener("change", () => {
        if (rSome.checked && !boxes.some((b) => b.checked)) for (const b of boxes) b.checked = true;
      });
      readDevs = () => ({ devAll: rAll.checked, devPicked: boxes.filter((b) => b.checked).map((b) => b.value).sort() });
      syncDevs = (x) => {
        for (const b of boxes) b.disabled = x.devAll;
      };
      devSet = h(
        "fieldset",
        { class: "subfield" },
        h("legend", { text: "Computadores permitidos" }),
        h("p", { class: "hint", id: id("devHint"), text: "Quais computadores podem usar esta conta (na troca automática e na troca manual)." }),
        h("label", { class: "check", for: id("devall") }, rAll, h("span", { text: "Todos (inclusive os que conectarem depois)" })),
        h("label", { class: "check", for: id("devsome") }, rSome, h("span", { text: "Só estes:" })),
        all.length
          ? h(
              "div",
              { class: "checklist" },
              all.map((dv, i) =>
                h(
                  "label",
                  { class: "check", for: boxes[i].id },
                  boxes[i],
                  h("span", null, devName(dv), h("span", { class: "muted small", text: ` · ${platformLabel(dv.platform)}${dv.googleEmail ? ` · ${dv.googleEmail}` : ""}` }))
                )
              )
            )
          : h("p", { class: "hint", text: "Nenhum computador conectado ainda." })
      );
    }

    const dirtyNote = h("span", { class: "dirty", role: "status", text: "" });
    const save = h("button", { type: "submit", "data-k": id("save"), text: "Salvar ajustes", "aria-label": `Salvar ajustes da Conta ${n}` });
    const undo = h("button", { type: "button", class: "secondary", "data-k": id("undo"), text: "Desfazer", "aria-label": `Desfazer ajustes da Conta ${n}` });

    const read = () => ({ alias: fAlias.value, own: fOwn.checked, threshold: fTh.value, priority: fPr.value, ...readDevs() });
    const sameDevs = (x) => x.devAll === orig.devAll && (x.devAll || sameList(x.devPicked, orig.devPicked));
    const same = (x) =>
      x.alias.trim() === orig.alias &&
      x.own === orig.own &&
      (!x.own || Number(x.threshold) === Number(orig.threshold)) &&
      Number(x.priority) === Number(orig.priority) &&
      sameDevs(x);
    const sync = () => {
      const x = read();
      fTh.disabled = !x.own;
      syncDevs(x);
      if (same(x)) acctDraft.delete(n);
      else acctDraft.set(n, x);
      dirtyNote.textContent = acctDraft.has(n) ? "Alterações não salvas" : "";
    };

    const prioMatters = r.strategy === "priority";
    const form = h(
      "form",
      { class: "adjform", novalidate: true },
      h("div", { class: "field" }, h("label", { for: id("alias"), text: "Apelido" }), fAlias),
      h("label", { class: "check", for: id("own") }, fOwn, h("span", { text: "Linha própria para a sessão de 5 horas" })),
      h(
        "div",
        { class: "field num" },
        h("label", { for: id("th"), text: "Linha da sessão desta conta" }),
        h("span", { class: "numwrap" }, fTh, h("span", { class: "unit", "aria-hidden": "true", text: "%" })),
        h("small", {
          class: "hint",
          id: id("thHint"),
          text: `De 50 a 100. Sem linha própria vale a das regras de troca (${fmtPct(r.sessionPct)}). Ex.: 70% para guardar folga nesta conta.`,
        })
      ),
      h(
        "div",
        { class: "field num" },
        h("label", { for: id("pr"), text: "Prioridade" }),
        h("span", { class: "numwrap" }, fPr),
        h("small", {
          class: "hint",
          id: id("prHint"),
          text: prioMatters ? "Número maior = usada primeiro." : "Só vale na estratégia “Por prioridade” (número maior = usada primeiro).",
        })
      ),
      devSet,
      h("div", { class: "row gap wrap end" }, dirtyNote, undo, save)
    );
    form.addEventListener("input", sync);
    form.addEventListener("change", sync);
    undo.addEventListener("click", () => {
      acctDraft.delete(n);
      paint("accounts", true);
      refocus(id("adj"));
    });
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const x = read();
      const patch = {};
      const alias = x.alias.trim();
      if (alias !== orig.alias) patch.alias = alias || null;
      if (x.own) {
        const th = Number(x.threshold);
        if (x.threshold.trim() === "" || !Number.isFinite(th) || th < 50 || th > 100) {
          fTh.setAttribute("aria-invalid", "true");
          fTh.focus();
          toast("Linha da sessão: use um número de 50 a 100.", "error");
          return;
        }
        if (!orig.own || th !== Number(orig.threshold)) patch.threshold = Math.round(th);
      } else if (orig.own) patch.threshold = null;
      fTh.removeAttribute("aria-invalid");
      const pr = Number(x.priority);
      if (x.priority.trim() === "" || !Number.isFinite(pr) || pr < 0 || pr > 1000) {
        fPr.setAttribute("aria-invalid", "true");
        fPr.focus();
        toast("Prioridade: use um número de 0 a 1000.", "error");
        return;
      }
      fPr.removeAttribute("aria-invalid");
      if (Math.round(pr) !== Number(orig.priority)) patch.priority = Math.round(pr);
      const devsChanged = devKnown && !sameDevs(x);
      if (devsChanged && !x.devAll && !x.devPicked.length) {
        toast("Computadores permitidos: marque pelo menos um computador ou escolha “Todos”.", "error");
        return;
      }
      if (!Object.keys(patch).length && !devsChanged) {
        acctDraft.delete(n);
        sync();
        toast("Nada mudou.");
        return;
      }
      act(
        save,
        async () => {
          if (Object.keys(patch).length) await api("PATCH", `/web/api/accounts/${n}`, patch);
          if (devsChanged) await api("PUT", `/web/api/accounts/${n}/devices`, { devices: x.devAll ? null : x.devPicked });
        },
        {
          before: () => acctDraft.delete(n),
          after: () => paint("accounts", true),
          ok: `Ajustes da Conta ${n} salvos.`,
        }
      );
    });

    const det = h(
      "details",
      { class: "adj", open: acctOpen.has(n) || acctDraft.has(n) },
      h("summary", { "data-k": id("adj"), text: "Ajustes desta conta" }),
      form
    );
    det.addEventListener("toggle", () => (det.open ? acctOpen.add(n) : acctOpen.delete(n)));
    dirtyNote.textContent = acctDraft.has(n) ? "Alterações não salvas" : "";
    return det;
  }

  async function removeAccount(a, btn) {
    const n = Number(a.number);
    const devs = deviceNames(a);
    const ok = await confirmBox({
      title: `Remover a Conta ${n}?`,
      text:
        `${a.email ? `${a.email}. ` : ""}O servidor apaga o login guardado desta conta` +
        (devs.length ? ` e ${devs.length === 1 ? "o computador que está nela passa" : "os computadores que estão nela passam"} para outra conta` : "") +
        ". Para usar esta conta de novo, adicione-a outra vez (botão “Adicionar conta”).",
      ok: "Remover conta",
    });
    if (!ok) return;
    await act(btn, () => api("DELETE", `/web/api/accounts/${n}`), {
      before: () => {
        acctDraft.delete(n);
        acctOpen.delete(n);
      },
      ok: `Conta ${n} removida.`,
    });
  }

  function renderAccounts(box) {
    for (const n of [...acctDraft.keys()]) if (!accById(n)) acctDraft.delete(n);
    const all = accounts();
    if (!all.length) {
      box.replaceChildren(
        emptyState("Nenhuma conta no servidor ainda", "Clique em “Adicionar conta” (no alto, à direita) e entre com a conta Claude. Ou entre com a conta no Claude Code de um computador conectado.")
      );
      return;
    }
    const inQ = queueOrder(all.filter((a) => !a.disabled));
    const out = all.filter((a) => a.disabled).sort(byNumber);
    const kids = [];
    if (inQ.length) {
      let pos = 0;
      kids.push(h("div", { class: "accounts" }, inQ.map((a) => accountCard(a, isDead(a) ? null : ++pos))));
    } else {
      kids.push(emptyState("Nenhuma conta participa da troca agora", "Abra “Fora da troca”, abaixo, e ligue “Participa da troca” numa conta."));
    }
    if (out.length) {
      const det = h(
        "details",
        { class: "outgroup", open: outOpen },
        h("summary", { "data-k": "out-group" }, h("span", { class: "outtitle", text: `Fora da troca (${out.length})` })),
        h("p", { class: "muted small", text: "Contas que não participam da troca automática. Dá para usá-las numa troca manual (em Computadores) ou ligar “Participa da troca” de novo." }),
        h("div", { class: "accounts" }, out.map((a) => accountCard(a, null)))
      );
      det.addEventListener("toggle", () => {
        outOpen = det.open;
      });
      kids.push(det);
    }
    box.replaceChildren(...kids);
  }

  // ------------------------------------------------------------ Contas: adicionar pela assinatura

  /** Só aceita https (o link vem do servidor, mas não custa conferir). */
  function safeHttps(v) {
    try {
      const u = new URL(String(v || ""));
      return u.protocol === "https:" ? u.href : null;
    } catch {
      return null;
    }
  }

  function hideAddBox() {
    clearTimeout(addTimer);
    addTimer = null;
    addLogin = null;
    const box = $("addBox");
    if (!box) return;
    box.classList.add("hidden");
    $("addCode").value = "";
    $("addCode").removeAttribute("aria-invalid");
    $("addInfo").textContent = "";
    $("addOpened").textContent = "";
    $("addLink").setAttribute("href", "/");
    $("addFinish").disabled = false;
  }

  function showAddUnavailable() {
    hideAddBox();
    $("addSteps").classList.add("hidden");
    $("addOff").classList.remove("hidden");
    $("addBox").classList.remove("hidden");
    $("addCancel").focus();
  }

  async function startAddAccount(btn) {
    // Abre a aba já no clique (depois de esperar o servidor o navegador bloquearia a janela nova).
    let w = null;
    try {
      w = window.open("", "_blank");
      if (w) w.opener = null;
    } catch {
      w = null;
    }
    btn.disabled = true;
    btn.setAttribute("aria-busy", "true");
    try {
      const r = await api("POST", "/web/api/claude-login/start");
      const url = safeHttps(r && r.authUrl);
      if (!isObj(r) || !r.loginId || !url) throw apiError(0, "bad_response", "O servidor não devolveu o link de login da Claude.");
      hideAddBox();
      const exp = toDate(r.expiresAt);
      addLogin = { loginId: String(r.loginId), authUrl: url, expiresAt: exp ? exp.getTime() : nowMs() + ADD_LOGIN_MS };
      $("addSteps").classList.remove("hidden");
      $("addOff").classList.add("hidden");
      $("addLink").setAttribute("href", url);
      let opened = false;
      if (w) {
        try {
          w.location.replace(url);
          opened = true;
        } catch {
          try {
            w.close();
          } catch {}
        }
      }
      $("addOpened").textContent = opened ? "Abriu numa aba nova. Se não apareceu, clique no botão." : "Clique no botão: abre numa aba nova.";
      $("addInfo").textContent = `Vale até ${fmtWhen(addLogin.expiresAt)} (10 minutos). Se der errado, clique em “Adicionar conta” de novo para gerar outro link.`;
      $("addBox").classList.remove("hidden");
      clearTimeout(addTimer);
      addTimer = setTimeout(expireAddLogin, Math.max(1000, Math.min(addLogin.expiresAt - nowMs(), 60 * 60000)));
      $("addCode").focus();
    } catch (e) {
      if (w) {
        try {
          w.close();
        } catch {}
      }
      if (e.status === 401) return;
      if (e.code === "unavailable") {
        showAddUnavailable();
        return;
      }
      toast(e.message, "error");
    } finally {
      if (btn.isConnected) {
        btn.disabled = false;
        btn.removeAttribute("aria-busy");
      }
    }
  }

  function expireAddLogin() {
    if (!addLogin) return;
    addLogin = null;
    $("addFinish").disabled = true;
    $("addInfo").textContent = "Este link venceu. Clique em “Adicionar conta” para gerar outro.";
    toast("O link para adicionar conta venceu. Clique em “Adicionar conta” para gerar outro.");
  }

  async function finishAddAccount(e) {
    e.preventDefault();
    const input = $("addCode");
    if (!addLogin) {
      toast("Clique em “Adicionar conta” para gerar um link novo.", "error");
      return;
    }
    const code = input.value.trim();
    if (!code) {
      input.setAttribute("aria-invalid", "true");
      input.focus();
      toast("Cole o código que a página da Claude mostrou.", "error");
      return;
    }
    input.removeAttribute("aria-invalid");
    if (addLogin.expiresAt <= nowMs()) {
      expireAddLogin();
      return;
    }
    const loginId = addLogin.loginId;
    await act($("addFinish"), () => api("POST", "/web/api/claude-login/finish", { loginId, code }), {
      before: () => hideAddBox(),
      after: (r) => {
        if (r && r.number !== undefined && r.number !== null) goToAccount(Number(r.number));
      },
      ok: (r) =>
        r && r.number !== undefined && r.number !== null
          ? r.created === false
            ? `Conta ${r.number} atualizada com o login novo.`
            : `Conta ${r.number} adicionada.`
          : "Conta adicionada.",
    });
  }

  // ------------------------------------------------------------ Computadores

  function renderDevices(box) {
    const list = [...devices()].sort((x, y) => Number(!!y.active) - Number(!!x.active) || devName(x).localeCompare(devName(y), "pt-BR"));
    for (const id of [...devChoice.keys()]) if (!list.some((d) => d.id === id)) devChoice.delete(id);
    for (const id of [...devRename.keys()]) if (!list.some((d) => d.id === id)) devRename.delete(id);
    if (!list.length) {
      box.replaceChildren(
        emptyState(
          "Nenhum computador conectado ainda",
          "Para conectar: no computador, abra o VS Code com o Swap Plus e clique em “Entrar com Google” no cartão “Servidor”. O passo a passo completo está logo abaixo, em “Conectar um computador”."
        )
      );
      return;
    }
    box.replaceChildren(...list.map(deviceTile));
  }

  function deviceTile(d) {
    const name = devName(d);
    const safe = safeId(d.id);
    const id = (s) => `dev-${safe}-${s}`;
    const assigned = d.assigned !== null && d.assigned !== undefined ? Number(d.assigned) : null;
    const acc = assigned !== null ? accById(assigned) : null;
    const seen = d.active ? "ativo agora" : d.lastSeen ? `parado · visto ${fmtWhen(d.lastSeen) || "—"}` : "ainda não apareceu";

    // --- nome (renomear)
    let head;
    if (devRename.has(d.id)) {
      head = renameForm(d, id, name);
    } else {
      const ren = h("button", { type: "button", class: "linkbtn small", "data-k": id("ren"), text: "Renomear", "aria-label": `Renomear ${name}` });
      ren.addEventListener("click", () => {
        devRename.set(d.id, d.name || "");
        paint("devices", true);
        const input = $(id("name"));
        if (input) {
          input.focus();
          input.select();
        }
      });
      head = h(
        "div",
        { class: "thead" },
        h("span", { class: "dot" + (d.active ? " on" : ""), "aria-hidden": "true" }),
        h("h3", { id: id("title"), text: name }),
        ren
      );
    }

    // --- conta Claude logada agora
    const accBox = acc
      ? h(
          "div",
          { class: "tacc" },
          h("div", { class: "taccname" }, h("b", { text: `Conta ${acc.number}` }), acc.alias ? h("span", { text: ` “${acc.alias}”` }) : null, isDead(acc) ? badge("dead", "Login morto") : null),
          acc.email ? h("div", { class: "email small", text: acc.email }) : null,
          usageMeters(acc, true)
        )
      : h("div", { class: "tacc none" }, h("p", { class: "muted small", text: assigned !== null ? `Conta ${assigned} (não existe mais no servidor).` : "Nenhuma conta Claude neste computador agora." }));

    // --- trocar (só entre as contas permitidas para este computador)
    const allowed = allowedFor(d);
    const pool = [...accounts()].sort(byNumber).filter((a) => !allowed || allowed.has(Number(a.number)));
    const sel = h("select", { id: id("sel"), "data-k": id("sel") });
    sel.append(h("option", { value: "best", text: "Melhor conta" }));
    for (const a of pool) {
      const dead = isDead(a);
      const extra = [Number(a.number) === assigned ? "em uso" : null, dead ? "login morto" : null, a.disabled ? "fora da troca" : null].filter(Boolean);
      sel.append(
        h("option", {
          value: String(a.number),
          disabled: dead,
          text: `${accountLabel(a.number)}${extra.length ? ` (${extra.join(", ")})` : ""}`,
        })
      );
    }
    const chosen = devChoice.get(d.id);
    sel.value = chosen && [...sel.options].some((o) => o.value === chosen && !o.disabled) ? chosen : "best";
    sel.addEventListener("change", () => {
      if (sel.value === "best") devChoice.delete(d.id);
      else devChoice.set(d.id, sel.value);
    });
    const go = h("button", { type: "button", "data-k": id("go"), text: "Trocar", "aria-label": `Trocar a conta de ${name}` });
    go.addEventListener("click", () => switchDevice(d, sel.value, go));
    const restricted = allowed && allowed.size < accounts().length;
    const hint = restricted
      ? h("small", {
          class: "hint",
          id: id("selHint"),
          text: pool.length
            ? "Só aparecem as contas que permitem este computador (em Contas › Ajustes desta conta)."
            : "Nenhuma conta permite este computador. Libere em Contas › Ajustes desta conta › Computadores permitidos.",
        })
      : null;
    if (hint) sel.setAttribute("aria-describedby", id("selHint"));

    const off = h("button", { type: "button", class: "danger subtle small", "data-k": id("del"), text: "Desconectar", "aria-label": `Desconectar ${name}` });
    off.addEventListener("click", () => disconnectDevice(d, off));

    return h(
      "article",
      { class: "card tile" + (d.active ? " live" : ""), "aria-label": name },
      head,
      h(
        "dl",
        { class: "tinfo" },
        h("dt", { text: "Sistema" }),
        h("dd", { text: platformLabel(d.platform) }),
        h("dt", { text: "Usuário" }),
        h("dd", { text: d.googleEmail || "conectado por código" }),
        h("dt", { text: "Contato" }),
        h("dd", { class: d.active ? "oktext" : null, text: seen })
      ),
      h("div", { class: "tsec" }, h("p", { class: "tlabel", text: "Conta Claude agora" }), accBox),
      h("div", { class: "dctl" }, h("label", { for: id("sel"), text: "Trocar para" }), h("div", { class: "row gap wrap" }, sel, go), hint),
      h("div", { class: "afoot" }, off)
    );
  }

  function renameForm(d, id, name) {
    const input = h("input", {
      type: "text",
      id: id("name"),
      "data-k": id("name"),
      maxlength: "60",
      autocomplete: "off",
      spellcheck: "false",
      value: devRename.get(d.id),
      "aria-label": `Novo nome para ${name}`,
    });
    const save = h("button", { type: "submit", "data-k": id("rsave"), text: "Salvar" });
    const cancelBtn = h("button", { type: "button", class: "secondary", "data-k": id("rcancel"), text: "Cancelar" });
    const cancel = () => {
      devRename.delete(d.id);
      paint("devices", true);
      refocus(id("ren"));
    };
    input.addEventListener("input", () => devRename.set(d.id, input.value));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        cancel();
      }
    });
    cancelBtn.addEventListener("click", cancel);
    const form = h("form", { class: "renform", novalidate: true }, input, h("div", { class: "row gap" }, save, cancelBtn));
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const v = input.value.trim().replace(/\s+/g, " ");
      if (!v) {
        input.setAttribute("aria-invalid", "true");
        input.focus();
        toast("Digite um nome para o computador.", "error");
        return;
      }
      if (v === (d.name || "")) {
        cancel();
        return;
      }
      act(save, () => api("PATCH", `/web/api/devices/${encodeURIComponent(d.id)}`, { name: v }), {
        before: () => devRename.delete(d.id),
        after: () => {
          paint("devices", true);
          refocus(id("ren"));
        },
        ok: `Computador renomeado para “${v}”.`,
      });
    });
    return form;
  }

  function switchDevice(d, value, btn) {
    const number = value === "best" ? null : Number(value);
    const name = d.name || "o computador";
    act(btn, () => api("POST", `/web/api/devices/${encodeURIComponent(d.id)}/switch`, { number }), {
      before: () => devChoice.delete(d.id),
      ok: () => {
        const nd = devices().find((x) => x.id === d.id);
        const now = nd && nd.assigned !== null && nd.assigned !== undefined ? accountLabel(nd.assigned) : null;
        return now ? `${name} agora usa a ${now}. Ele recebe a conta em até 30 segundos.` : `Pedido enviado para ${name}.`;
      },
    });
  }

  async function disconnectDevice(d, btn) {
    const name = d.name || "este computador";
    const ok = await confirmBox({
      title: `Desconectar ${name}?`,
      text: "Ele para de receber o acesso das contas na hora, e o Claude Code dele pode pedir login. Para voltar, conecte de novo pelo VS Code (Entrar com Google ou código de conexão).",
      ok: "Desconectar",
    });
    if (!ok) return;
    await act(btn, () => api("DELETE", `/web/api/devices/${encodeURIComponent(d.id)}`), {
      before: () => {
        devChoice.delete(d.id);
        devRename.delete(d.id);
      },
      ok: `${name} desconectado.`,
    });
  }

  function renderConnect() {
    const g = S && isObj(S.google) ? S.google : null;
    $("googleOffNote").classList.toggle("hidden", !g || g.enabled !== false);
  }

  async function makePairCode(btn) {
    btn.disabled = true;
    try {
      const r = await api("POST", "/web/api/pair-code");
      const text = (r && (r.connect || r.code)) || "";
      if (!text) throw apiError(0, "bad_response", "O servidor não devolveu o código.");
      $("pairCode").value = text;
      const exp = toDate(r.expiresAt);
      $("pairInfo").textContent = exp ? `Vale até ${fmtWhen(exp)} (10 minutos) e uma vez só.` : "Vale 10 minutos e uma vez só.";
      $("pairBox").classList.remove("hidden");
      $("pairCode").focus();
      $("pairCode").select();
      clearTimeout(pairTimer);
      const left = exp ? exp.getTime() - nowMs() : 10 * 60000;
      pairTimer = setTimeout(() => {
        $("pairCode").value = "";
        $("pairInfo").textContent = "";
        $("pairBox").classList.add("hidden");
        toast("O código de conexão venceu. Gere outro se precisar.");
      }, Math.max(1000, Math.min(left, 60 * 60000)));
      toast("Código gerado. Cole no VS Code em “Colar código”.");
    } catch (e) {
      if (e.status !== 401) toast(e.message, "error");
    } finally {
      if (btn.isConnected) btn.disabled = false;
    }
  }

  async function copyPair() {
    const ta = $("pairCode");
    const text = ta.value;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      toast("Código copiado.");
    } catch {
      ta.focus();
      ta.select();
      toast("Não consegui copiar sozinho: o código está selecionado, use Ctrl+C (ou Cmd+C no Mac).");
    }
  }

  // ------------------------------------------------------------ Regras de troca (dentro de Contas)

  function stateRuleValues() {
    const r = rules();
    const o = {};
    for (const k of RULE_KEYS) o[k] = r[k];
    o.autoSwitch = S.autoSwitch !== false;
    return o;
  }

  function numVal(el) {
    const s = String(el.value).trim();
    return s === "" ? NaN : Number(s);
  }

  function checkedValue(name) {
    const el = $("rulesForm").querySelector(`input[name="${name}"]:checked`);
    return el ? el.value : null;
  }

  function readRulesForm() {
    return {
      autoSwitch: $("rAuto").checked,
      sessionPct: Number($("rSession").value),
      weeklyPct: Number($("rWeekly").value),
      modelPct: Number($("rModel").value),
      preferModel: $("rPrefer").value,
      strategy: checkedValue("strategy"),
      expiringHours: numVal($("rExpiring")),
      cooldownMin: numVal($("rCooldown")),
      marginPct: numVal($("rMargin")),
      onModelLimit: checkedValue("onModelLimit") || "sameAccount",
    };
  }

  const sameVal = (a, b) => (typeof b === "number" ? Number(a) === b : String(a) === String(b));

  function sameRules(x, y) {
    if (!x || !y) return false;
    if (!!x.autoSwitch !== !!y.autoSwitch) return false;
    return RULE_KEYS.every((k) => sameVal(x[k], y[k]));
  }

  function paintRangeOut(id) {
    const el = $(id);
    const txt = `${el.value}%`;
    $(`${id}Out`).textContent = txt;
    el.setAttribute("aria-valuetext", txt);
  }

  function paintChoices() {
    for (const el of $("rulesForm").querySelectorAll(".choice")) {
      const input = el.querySelector("input");
      el.classList.toggle("selected", !!(input && input.checked));
    }
    $("rAutoText").textContent = $("rAuto").checked ? "Troca automática ligada" : "Troca automática desligada";
  }

  function fillPreferOptions(value) {
    const sel = $("rPrefer");
    const names = modelNames();
    const v = String(value || "");
    if (v && !names.includes(v)) names.push(v);
    sel.replaceChildren(h("option", { value: "", text: "Nenhum (sem preferência)" }), ...names.map((n) => h("option", { value: n, text: n })));
    sel.value = v;
  }

  function writeRulesForm(v) {
    $("rAuto").checked = v.autoSwitch !== false;
    for (const f of RANGE_FIELDS) {
      $(f.id).value = String(Math.round(Number(v[f.key])));
      paintRangeOut(f.id);
    }
    for (const f of NUM_FIELDS) {
      $(f.id).value = Number.isFinite(Number(v[f.key])) ? String(v[f.key]) : "";
      $(f.id).removeAttribute("aria-invalid");
    }
    for (const el of $("rulesForm").querySelectorAll('input[name="strategy"]')) el.checked = el.value === v.strategy;
    for (const el of $("rulesForm").querySelectorAll('input[name="onModelLimit"]')) el.checked = el.value === (v.onModelLimit === "switchAccount" ? "switchAccount" : "sameAccount");
    fillPreferOptions(v.preferModel);
    paintChoices();
  }

  function fillDefaultsHints() {
    const def = defaults();
    for (const el of document.querySelectorAll("[data-def]")) {
      const k = el.getAttribute("data-def");
      const unit = el.getAttribute("data-unit") || "";
      if (def[k] !== undefined) el.textContent = `${def[k]}${unit}`;
    }
  }

  function setRulesDirty(on) {
    rulesDirty = !!on;
    $("rulesDirty").classList.toggle("hidden", !rulesDirty);
  }

  /** Preenche o formulário com as regras do servidor — nunca por cima do que a pessoa está editando. */
  function fillRules(force) {
    if (!S) return;
    const cur = stateRuleValues();
    const sig = JSON.stringify(cur);
    fillDefaultsHints();
    if (rulesDirty && !force) {
      $("rulesChanged").classList.toggle("hidden", sig === rulesBaseSig);
      return;
    }
    $("rulesChanged").classList.add("hidden");
    if (!force && sig === rulesBaseSig) {
      // Mesmas regras: só atualiza a lista de modelos se mudou (sem mexer no foco).
      const sel = $("rPrefer");
      const want = JSON.stringify(["", ...modelNames(), ...(cur.preferModel && !modelNames().includes(cur.preferModel) ? [cur.preferModel] : [])]);
      const have = JSON.stringify([...sel.options].map((o) => o.value));
      if (want !== have && document.activeElement !== sel) fillPreferOptions(sel.value);
      return;
    }
    rulesBase = cur;
    rulesBaseSig = sig;
    writeRulesForm(cur);
    setRulesDirty(false);
  }

  function onRulesInput(e) {
    if (!rulesBase) return; // estado ainda não chegou
    if (e && e.target && e.target.type === "range") paintRangeOut(e.target.id);
    if (e && e.target && e.target.removeAttribute) e.target.removeAttribute("aria-invalid");
    paintChoices();
    setRulesDirty(!sameRules(readRulesForm(), rulesBase));
  }

  async function saveRules(e) {
    e.preventDefault();
    if (!S || !rulesBase) return;
    const v = readRulesForm();
    for (const f of NUM_FIELDS) {
      const n = v[f.key];
      if (!Number.isFinite(n) || n < f.min || n > f.max) {
        const el = $(f.id);
        el.setAttribute("aria-invalid", "true");
        el.focus();
        toast(`${f.label}: use um número de ${f.min} a ${f.max}.`, "error");
        return;
      }
    }
    if (!v.strategy || !STRATEGY_LABELS[v.strategy]) {
      toast("Escolha a estratégia (para qual conta ir).", "error");
      return;
    }
    const def = defaults();
    const changed = {};
    for (const k of RULE_KEYS) if (!sameVal(v[k], rulesBase[k])) changed[k] = v[k];
    const body = {};
    if (Object.keys(changed).length) body.rules = RULE_KEYS.every((k) => sameVal(v[k], def[k])) ? null : changed;
    if (v.autoSwitch !== rulesBase.autoSwitch) body.autoSwitch = v.autoSwitch;
    if (!("rules" in body) && !("autoSwitch" in body)) {
      setRulesDirty(false);
      toast("Nada para salvar.");
      return;
    }
    await act($("rulesSave"), () => api("PUT", "/web/api/rules", body), {
      before: () => {
        setRulesDirty(false);
        rulesBaseSig = null; // a próxima carga preenche o formulário com o que ficou salvo
      },
      ok: "Regras salvas. Valem para todos os computadores.",
    });
  }

  function undoRules() {
    if (!S) return;
    const had = rulesDirty;
    setRulesDirty(false);
    fillRules(true);
    toast(had ? "Alterações desfeitas." : "Nada para desfazer.");
  }

  function rulesToDefaults() {
    if (!S) return;
    writeRulesForm({ ...defaults(), autoSwitch: $("rAuto").checked });
    onRulesInput();
    toast("Valores padrão colocados no formulário. Clique em “Salvar regras” para valer.");
  }

  // ------------------------------------------------------------ Usuários

  /** Data de liberação, se o servidor mandar (users[].since/createdAt/addedAt ou allowedEmails[] com objeto). */
  function sinceMap() {
    const m = new Map();
    const take = (x) => {
      if (!isObj(x) || typeof x.email !== "string") return;
      const v = x.since ?? x.createdAt ?? x.addedAt ?? null;
      if (toDate(v)) m.set(emailKey(x.email) || x.email, v);
    };
    if (S && Array.isArray(S.users)) S.users.forEach(take);
    if (S && Array.isArray(S.allowedEmails)) S.allowedEmails.forEach(take);
    return m;
  }

  /** Linhas da tabela: administrador(es), usuários liberados e e-mails tirados que ainda têm computador conectado. */
  function userRows() {
    if (!S) return [];
    const rows = [];
    const seen = new Set();
    const add = (email, role) => {
      const k = emailKey(email) || String(email).toLowerCase();
      if (seen.has(k)) return;
      seen.add(k);
      rows.push({ email: String(email), key: k, role });
    };
    for (const e of adminList()) add(e, "admin");
    for (const e of [...allowedList()].sort((a, b) => a.localeCompare(b))) add(e, isAdminEmail(e) ? "admin" : "user");
    for (const d of sortedDevices()) if (d.googleEmail) add(d.googleEmail, isAdminEmail(d.googleEmail) ? "admin" : "gone");
    const since = sinceMap();
    for (const r of rows) {
      r.devices = devices().filter((d) => sameEmail(d.googleEmail, r.email));
      r.since = since.get(r.key) ?? null;
      const first = r.devices.map((d) => toDate(d.createdAt)).filter(Boolean).sort((a, b) => a - b)[0] || null;
      r.firstDevice = first;
    }
    return rows;
  }

  function renderUsers(box) {
    const mine = myEmail();
    const rows = userRows();
    const anySince = rows.some((r) => r.since);
    const note = $("usersNote");
    if (!rows.length) {
      box.replaceChildren(h("tr", null, h("td", { colspan: "5", class: "empty", text: "Nenhum usuário ainda." })));
      note.classList.add("hidden");
      return;
    }
    box.replaceChildren(
      ...rows.map((r, i) => {
        const self = sameEmail(r.email, mine);
        const role =
          r.role === "admin"
            ? h("span", { class: "badge on", text: "Administrador" })
            : r.role === "user"
              ? h("span", { class: "badge", text: "Usuário" })
              : h("span", { class: "badge plain", text: "Não liberado", title: "Saiu da lista, mas os computadores que já conectou continuam" });
        const devs = r.devices.length
          ? h("span", null, h("b", { text: String(r.devices.length) }), h("span", { class: "muted", text: ` · ${r.devices.map(devName).join(", ")}` }))
          : h("span", { class: "muted", text: "nenhum" });
        let since;
        if (r.since) since = h("span", { text: fmtDay(r.since) });
        else if (r.role === "admin") since = h("span", { class: "muted", text: "definido no servidor" });
        else if (r.firstDevice) since = h("span", null, fmtDay(r.firstDevice), h("span", { class: "muted small", text: " (1º computador)" }));
        else since = h("span", { class: "muted", text: "—" });
        let action;
        if (r.role === "admin") {
          action = h("span", { class: "muted small", text: "fixo" });
        } else if (r.role === "user") {
          action = h("button", { type: "button", class: "danger subtle small", "data-k": `user-del-${r.key}`, text: "Tirar", "aria-label": `Tirar ${r.email}` });
          action.addEventListener("click", () => removeAllowed(r.email, action));
        } else {
          action = h("button", { type: "button", class: "secondary small", "data-k": `user-add-${r.key}`, text: "Liberar de novo", "aria-label": `Liberar ${r.email} de novo` });
          action.addEventListener("click", () => allowEmail(r.email, action));
        }
        return h(
          "tr",
          { class: r.role === "gone" ? "gone" : null, "data-row": String(i) },
          h("th", { scope: "row", "data-label": "E-mail" }, h("span", { class: "email", text: r.email }), self ? h("span", { class: "tag on", text: "você" }) : null),
          h("td", { "data-label": "Papel" }, role),
          h("td", { "data-label": "Computadores" }, devs),
          h("td", { "data-label": "Desde" }, since),
          h("td", { class: "actions" }, action)
        );
      })
    );
    const parts = [];
    if (!anySince && rows.some((r) => r.role !== "admin")) parts.push(`A data em que cada usuário foi liberado fica ${SOON}; por enquanto aparece quando ele conectou o primeiro computador.`);
    if (rows.some((r) => r.role === "gone")) parts.push("“Não liberado”: saiu da lista, mas os computadores que já conectou continuam funcionando (desconecte-os em Computadores para cortar).");
    note.textContent = parts.join(" ");
    note.classList.toggle("hidden", !parts.length);
  }

  async function removeAllowed(email, btn) {
    const ok = await confirmBox({
      title: `Tirar ${email}?`,
      text: "Ele não conecta mais computadores novos. Os computadores que ele já conectou continuam funcionando; para cortar, desconecte-os em Computadores.",
      ok: "Tirar usuário",
    });
    if (!ok) return;
    await act(btn, () => api("DELETE", `/web/api/allowed/${encodeURIComponent(email)}`), {
      ok: `${email} não está mais liberado.`,
      after: () => {
        if (needSessions()) loadSessions(false);
      },
    });
  }

  function allowEmail(email, btn) {
    return act(btn, () => api("POST", "/web/api/allowed", { email }), {
      ok: (r) =>
        r && r.admin
          ? "Essa é a conta do administrador: ela já conecta computadores e entra no painel."
          : r && r.added === false
            ? "Esse usuário já está liberado."
            : `${email} liberado. Ele já pode conectar computadores pelo VS Code (Entrar com Google). O painel continua só do administrador.`,
    });
  }

  async function addAllowed(e) {
    e.preventDefault();
    const input = $("allowEmail");
    const email = input.value.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      input.setAttribute("aria-invalid", "true");
      input.focus();
      toast("Digite um e-mail válido, por exemplo pessoa@gmail.com.", "error");
      return;
    }
    input.removeAttribute("aria-invalid");
    if (isAdminEmail(email)) {
      toast("Essa é a conta do administrador: ela já conecta computadores e entra no painel, sem precisar estar na lista.");
      return;
    }
    if (allowedList().some((x) => sameEmail(x, email))) {
      toast("Esse usuário já está liberado.");
      return;
    }
    const ok = await allowEmail(email, $("btnAllow"));
    if (ok) input.value = "";
  }

  function renderGoogleInfo() {
    const g = isObj(S.google) ? S.google : null;
    const el = $("googleInfo");
    if (!g) {
      el.textContent = "";
      return;
    }
    el.textContent =
      g.enabled === false
        ? "O login com Google está desligado no servidor: ninguém consegue entrar de novo no painel nem conectar computadores com Google. Os computadores podem conectar com o código de conexão (em Computadores)."
        : g.callbackUrl
          ? `Login com Google ligado. Endereço de retorno cadastrado no Google: ${g.callbackUrl}`
          : "Login com Google ligado.";
  }

  // ------------------------------------------------------------ Minha conta: Recuperação (kit)

  function hideRecovery() {
    clearTimeout(kitTimer);
    kitTimer = null;
    const box = $("recoveryBox");
    if (!box) return;
    $("recoveryMaster").value = "";
    $("recoveryBackup").value = "";
    $("recoveryMasterInfo").textContent = "";
    $("recoveryBackupInfo").textContent = "";
    box.classList.add("hidden");
    $("recoveryReauth").classList.add("hidden");
  }

  function fillSecret(item, fieldId, infoId, copyId) {
    const ok = isObj(item) && item.available && typeof item.value === "string" && item.value;
    $(fieldId).value = ok ? item.value : "";
    $(copyId).disabled = !ok;
    $(infoId).textContent = ok
      ? item.file
        ? `Do arquivo ${item.file} do servidor.`
        : ""
      : `Não disponível${isObj(item) && item.why ? ` (${item.why}${item.file ? `: ${item.file}` : ""})` : ""}.`;
  }

  async function showRecovery(btn) {
    if (btn) btn.disabled = true;
    try {
      const r = await api("GET", "/web/api/recovery-kit");
      $("recoveryReauth").classList.add("hidden");
      fillSecret(r && r.masterKey, "recoveryMaster", "recoveryMasterInfo", "btnCopyMaster");
      fillSecret(r && r.backupPassword, "recoveryBackup", "recoveryBackupInfo", "btnCopyBackup");
      $("recoveryBox").classList.remove("hidden");
      clearTimeout(kitTimer);
      kitTimer = setTimeout(() => {
        hideRecovery();
        toast("O kit de recuperação foi escondido. Para ver de novo, clique em “Mostrar o kit de recuperação” (em Minha conta).");
      }, 5 * 60000);
      toast("Kit de recuperação aberto. Guarde as duas chaves fora deste servidor.");
    } catch (e) {
      if (e.status === 401) return;
      if (e.code === "reauth") {
        hideRecovery();
        $("recoveryReauth").classList.remove("hidden");
        $("recoveryLogin").focus();
        return;
      }
      toast(e.message, "error");
    } finally {
      if (btn && btn.isConnected) btn.disabled = false;
    }
  }

  async function copySecret(fieldId, what) {
    const ta = $(fieldId);
    const text = ta.value;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      toast(`${what} copiada.`);
    } catch {
      ta.focus();
      ta.select();
      toast(`Não consegui copiar sozinho: a ${what.toLowerCase()} está selecionada, use Ctrl+C (ou Cmd+C no Mac).`);
    }
  }

  function wantKitLater() {
    try {
      sessionStorage.setItem(WANT_KIT_KEY, "1");
    } catch {}
  }

  /** Voltou do Google pelo botão "Entrar de novo" do kit: abre o kit sozinho (uma vez). */
  function takeWantKit() {
    try {
      const v = sessionStorage.getItem(WANT_KIT_KEY);
      sessionStorage.removeItem(WANT_KIT_KEY);
      return v === "1";
    } catch {
      return false;
    }
  }

  // ------------------------------------------------------------ Minha conta: sessões abertas

  function sessionList() {
    if (Array.isArray(sessions)) return sessions;
    if (isObj(sessions) && Array.isArray(sessions.sessions)) return sessions.sessions;
    return null;
  }

  function renderSessions(box) {
    const list = sessionList();
    if (!list) {
      box.replaceChildren(
        h("li", { class: "empty", text: isObj(sessions) && sessions.error ? `Não consegui carregar as sessões: ${sessions.error}` : "Carregando…" })
      );
      return;
    }
    if (!list.length) {
      box.replaceChildren(h("li", { class: "empty", text: "Nenhuma sessão aberta." }));
      return;
    }
    const sorted = [...list].sort((a, b) => {
      const ta = toDate(a.lastSeen);
      const tb = toDate(b.lastSeen);
      return Number(!!b.current) - Number(!!a.current) || (tb ? tb.getTime() : 0) - (ta ? ta.getTime() : 0);
    });
    box.replaceChildren(
      ...sorted.map((s) => {
        const id = String(s.id || "");
        const bits = [
          s.email ? String(s.email) : null,
          s.createdAt ? `entrou ${fmtWhen(s.createdAt)}` : null,
          s.lastSeen ? `último uso ${fmtWhen(s.lastSeen)}` : null,
          s.expiresAt ? `vale até ${fmtWhen(s.expiresAt)}` : null,
          s.ip ? `IP ${s.ip}` : null,
        ].filter(Boolean);
        const btn = h("button", {
          type: "button",
          class: "secondary small",
          "data-k": `sess-${id}`,
          text: s.current ? "Sair" : "Encerrar",
          "aria-label": s.current ? "Sair (encerrar esta sessão)" : `Encerrar a sessão de ${s.ua || "navegador desconhecido"}`,
        });
        btn.addEventListener("click", () => endSession(s, btn));
        return h(
          "li",
          { class: "plainrow" },
          h(
            "div",
            { class: "sinfo" },
            h("div", null, h("b", { text: s.ua || "Navegador desconhecido" }), s.current ? h("span", { class: "tag on", text: "esta sessão" }) : null),
            h("div", { class: "muted small", text: bits.join(" · ") })
          ),
          id ? btn : null
        );
      })
    );
  }

  async function endSession(s, btn) {
    if (s.current) return logout(btn);
    btn.disabled = true;
    try {
      await api("DELETE", `/web/api/sessions/${encodeURIComponent(s.id)}`);
      toast("Sessão encerrada.");
      await loadSessions(false);
    } catch (e) {
      if (e.status !== 401) toast(e.message, "error");
    } finally {
      if (btn.isConnected) btn.disabled = false;
    }
  }

  // ------------------------------------------------------------ Histórico

  function renderHistory(box) {
    const items = Array.isArray(S.history) ? S.history : [];
    if (!items.length) {
      box.replaceChildren(h("li", { class: "empty", text: "Nada por aqui ainda. Trocas de conta, logins e avisos aparecem nesta lista." }));
      return;
    }
    const byId = new Map(devices().map((d) => [d.id, d.name]));
    box.replaceChildren(
      ...items.map((it) => {
        const kind = String(it.kind || "info");
        const dn = it.deviceName || (it.device ? byId.get(it.device) || "computador removido" : null);
        const iso = isoOf(it.ts);
        return h(
          "li",
          null,
          h("time", { class: "when", datetime: iso, text: fmtWhen(it.ts) || "—" }),
          h("span", { class: "kind " + kind.replace(/[^a-z_-]/gi, ""), text: KIND_LABELS[kind] || kind }),
          dn
            ? h("span", { class: "who", text: dn })
            : h("span", { class: "who" }, h("span", { "aria-hidden": "true", text: "—" }), h("span", { class: "visually-hidden", text: "sem computador" })),
          h("span", { class: "htext", text: String(it.text || "") })
        );
      })
    );
  }

  // ------------------------------------------------------------ menu (abas)

  const tabs = () => [...document.querySelectorAll("#tablist .tab")];
  const panels = () => [...document.querySelectorAll("main .sec")];

  function applyTabs() {
    const tl = $("tablist");
    tl.setAttribute("role", "tablist");
    tl.setAttribute("aria-label", "Menu do painel");
    for (const t of tabs()) {
      const on = t.dataset.sec === currentSec;
      t.setAttribute("role", "tab");
      t.setAttribute("aria-selected", on ? "true" : "false");
      t.tabIndex = on ? 0 : -1;
    }
    for (const p of panels()) {
      p.setAttribute("role", "tabpanel");
      p.setAttribute("aria-labelledby", `tab-${p.dataset.sec}`);
      p.tabIndex = -1;
      p.hidden = p.dataset.sec !== currentSec;
    }
  }

  function selectSection(sec, focusTab) {
    if (!SECTIONS.includes(sec)) sec = "contas";
    currentSec = sec;
    try {
      history.replaceState(null, "", `#${sec}`);
    } catch {}
    applyTabs();
    if (focusTab) $(`tab-${sec}`).focus();
  }

  function onTabKey(e) {
    const list = tabs();
    const i = list.indexOf(document.activeElement);
    if (i < 0) return;
    let j = null;
    if (e.key === "ArrowRight") j = (i + 1) % list.length;
    else if (e.key === "ArrowLeft") j = (i - 1 + list.length) % list.length;
    else if (e.key === "Home") j = 0;
    else if (e.key === "End") j = list.length - 1;
    if (j === null) return;
    e.preventDefault();
    selectSection(list[j].dataset.sec, true);
  }

  /** "#contas" → { sec: "contas" }; endereços antigos: "#acesso" abre Minha conta, "#historico" o Histórico. */
  function parseHash() {
    const raw = String(location.hash || "").replace(/^#/, "");
    const sec = SECTIONS.includes(raw) ? raw : HASH_ALIASES[raw] || null;
    const open = raw === "acesso" || raw === "minha-conta" ? "accountDlg" : raw === "historico" ? "historyDlg" : null;
    return { raw, sec, open };
  }

  /** Abre o que o endereço pede (painel lateral ou as regras), depois que o estado chegou. */
  function followHash(r) {
    if (r.open) openDrawer(r.open, r.open === "accountDlg" ? $("btnAccount") : $("btnHistory"));
    if (r.raw === "regras") {
      const el = $("rulesSection");
      if (el) el.scrollIntoView({ block: "start" });
    }
  }

  function setupTabs() {
    const r = parseHash();
    if (r.sec) currentSec = r.sec;
    for (const t of tabs()) t.addEventListener("click", () => selectSection(t.dataset.sec, false));
    $("tablist").addEventListener("keydown", onTabKey);
    window.addEventListener("hashchange", () => {
      const x = parseHash();
      if (x.sec && (x.sec !== currentSec || x.raw !== x.sec)) selectSection(x.sec, false); // também normaliza o endereço antigo
      if (me && S) followHash(x);
    });
    applyTabs();
  }

  // ------------------------------------------------------------ entrada / saída

  const hasUnsaved = () => rulesDirty || acctDraft.size > 0 || [...devRename.entries()].some(([id, v]) => v.trim() !== ((devById(id) || {}).name || ""));

  async function logout(btn) {
    if (hasUnsaved()) {
      const ok = await confirmBox({ title: "Sair sem salvar?", text: "Há alterações que ainda não foram salvas.", ok: "Sair" });
      if (!ok) return;
    }
    if (btn) btn.disabled = true;
    try {
      await api("POST", "/web/logout");
      showLogin("Você saiu do painel.");
    } catch (e) {
      if (e.status !== 401) toast(e.message, "error");
    } finally {
      if (btn && btn.isConnected) btn.disabled = false;
    }
  }

  async function boot() {
    show("screenLoading");
    $("loadingText").textContent = "Carregando…";
    $("btnRetry").classList.add("hidden");
    let m;
    try {
      m = await api("GET", "/web/api/me");
    } catch (e) {
      if (e.status === 401) return; // tela de entrada já mostrada
      $("loadingText").textContent = e.message;
      $("btnRetry").classList.remove("hidden");
      $("btnRetry").focus();
      return;
    }
    if (!isObj(m) || !m.csrf) {
      $("loadingText").textContent = "O servidor mandou uma resposta inesperada.";
      $("btnRetry").classList.remove("hidden");
      return;
    }
    me = m;
    $("meEmail").textContent = m.email || "";
    show("screenPanel");
    applyTabs();
    await loadState(true);
    startTimer();
    const r = parseHash();
    const wantKit = takeWantKit();
    if (r.sec && r.raw !== r.sec) selectSection(r.sec, false); // "#acesso" → "#contas" (e abre Minha conta)
    if (S) followHash(r);
    if (wantKit && r.raw === "acesso" && S) showRecovery($("btnRecovery"));
  }

  function init() {
    setupTabs();
    wireHolds();
    wireDrawer("accountDlg", "accountClose");
    wireDrawer("historyDlg", "historyClose");

    $("btnRetry").addEventListener("click", boot);
    $("btnRefresh").addEventListener("click", () => loadState("button"));
    $("btnAccount").addEventListener("click", (e) => openDrawer("accountDlg", e.currentTarget));
    $("btnHistory").addEventListener("click", (e) => openDrawer("historyDlg", e.currentTarget));
    $("btnLogout").addEventListener("click", (e) => logout(e.currentTarget));
    $("toast").addEventListener("click", hideToast);

    $("btnAddAccount").addEventListener("click", (e) => startAddAccount(e.currentTarget));
    $("addCancel").addEventListener("click", () => {
      hideAddBox();
      $("btnAddAccount").focus();
    });
    $("addForm").addEventListener("submit", finishAddAccount);
    $("addCode").addEventListener("input", () => $("addCode").removeAttribute("aria-invalid"));

    const rf = $("rulesForm");
    rf.addEventListener("input", onRulesInput);
    rf.addEventListener("change", onRulesInput);
    rf.addEventListener("submit", saveRules);
    $("rulesUndo").addEventListener("click", undoRules);
    $("rulesDefaults").addEventListener("click", rulesToDefaults);
    setRulesDirty(false);

    $("allowForm").addEventListener("submit", addAllowed);
    $("btnPair").addEventListener("click", (e) => makePairCode(e.currentTarget));
    $("btnCopyPair").addEventListener("click", copyPair);
    $("btnRecovery").addEventListener("click", (e) => showRecovery(e.currentTarget));
    $("btnHideRecovery").addEventListener("click", () => {
      hideRecovery();
      $("btnRecovery").focus();
    });
    $("btnCopyMaster").addEventListener("click", () => copySecret("recoveryMaster", "Chave mestra"));
    $("btnCopyBackup").addEventListener("click", () => copySecret("recoveryBackup", "Senha do backup"));
    $("recoveryLogin").addEventListener("click", wantKitLater);

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible" || !me || inflight) return;
      if (Date.now() - lastLoadAt >= REFRESH_MS) loadState(false);
    });
    window.addEventListener("beforeunload", (e) => {
      if (me && hasUnsaved()) {
        e.preventDefault();
        e.returnValue = "";
      }
    });

    boot();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
