// Painel web do Swap Plus Servidor — JS puro, sem bibliotecas.
// CSP do servidor: só 'self' (nada de inline, eval ou innerHTML com dados). Todo texto entra por textContent.
// Desenho 2.3 (server/WEB-SPEC.md): menus Contas · Serviços · Usuários; "Minha conta" e "Histórico" no topo.
// Desde a 2.5.1 a aba de tudo o que está conectado se chama "Serviços" (só o nome na tela: o id da seção, "computadores",
// e o endereço "#computadores" continuam) e as contas são linhas que abrem e fecham no lugar (WEB-SPEC.md, "2.5.1").
// 2.5.2: contas fora da troca no fim da lista (sem grupo à parte), serviços em linhas que abrem e fecham, tabela
// de usuários com ordenação e confirmação na própria linha, e uma busca em cada aba (WEB-SPEC.md, "2.5.2").
// 2.5.3: a palavra da tela é "serviço" para tudo o que está conectado ao Swap (um VS Code, o cliente do Hermes, um
// robô); a palavra antiga, a dos ids, ficou só para a máquina em que a pessoa está sentada. E cada serviço mostra a
// presença: ativo agora, conectado (sem uso agora), aguardando contato ou sem contato.
(function () {
  "use strict";

  // ------------------------------------------------------------ constantes

  const SECTIONS = ["contas", "computadores", "usuarios"]; // "computadores" = a aba "Serviços"
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
    devicePlacement: "separate", // "separate" | "together" (serviços juntos na mesma conta)
  };
  // Regras que o painel edita (intervalSec é só do modo local da extensão).
  const RULE_KEYS = ["sessionPct", "weeklyPct", "modelPct", "preferModel", "strategy", "expiringHours", "cooldownMin", "marginPct", "onModelLimit", "devicePlacement"];
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
    device: "Serviço",
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

  let addLogin = null; // pedido de "Adicionar conta" / "Entrar de novo" em andamento { loginId, authUrl, expiresAt, loginHint, number }
  let addTimer = null;

  const acctDraft = new Map(); // número da conta → rascunho dos ajustes { alias, priority, devAll, devPicked }
  const acctOpen = new Set(); // contas com "Ajustes desta conta" aberto
  // Contas com o cartão aberto na lista. A página abre com todas recolhidas (nada é gravado: recarregar fecha
  // tudo); a escolha vale enquanto a página fica aberta, inclusive nas atualizações de 30 s e com a busca.
  const acctExpanded = new Set();
  const svcExpanded = new Set(); // o mesmo na aba "Serviços": ids dos serviços com o cartão aberto
  // Busca de cada aba: o texto digitado (só na memória; continua nas atualizações de 30 s e ao trocar de aba).
  const filters = { contas: "", computadores: "", usuarios: "" };
  // Usuários: ordem da tabela, a linha que está perguntando "Tirar?" (chave da linha) e as mensagens do último
  // pedido, mostradas no lugar e não no aviso flutuante: form = embaixo do campo de liberar; table = da tabela
  // (where: "table" → no alto dela; ou a chave de uma linha → na faixa embaixo dessa linha).
  let userSort = { key: "role", dir: 1 };
  let userConfirm = null;
  const userNote = { form: null, table: null }; // cada uma: { kind: "ok" | "error", text, where?, status? }
  // Linhas próprias por conta (sessão 5h, semanal, modelo): salvas na hora, sem o "Salvar ajustes".
  const OWN_KEYS = ["threshold", "weeklyThreshold", "modelThreshold"];
  const OWN_SAVE_MS = 500; // espera depois do último movimento do slider antes de salvar
  const ownUi = new Set(); // contas com "Usar regra padrão" desmarcado (sliders à mostra, mesmo sem linha própria gravada)
  const ownLive = new Map(); // número da conta → { campo: valor } mexido no slider e ainda não confirmado pelo servidor
  const ownTimers = new Map(); // "n:campo" → espera para salvar
  const devChoice = new Map(); // id do serviço → opção escolhida em "Trocar para"
  const devRename = new Map(); // id do serviço → nome sendo digitado (renomear aberto)
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
    acctDraft.clear();
    acctOpen.clear();
    acctExpanded.clear();
    svcExpanded.clear();
    for (const sec of SECTIONS) {
      filters[sec] = "";
      $(`q-${sec}`).value = "";
    }
    userSort = { key: "role", dir: 1 };
    userConfirm = null;
    userNote.form = null;
    userNote.table = null;
    paintUserNotes();
    $("allowEmail").removeAttribute("aria-invalid");
    ownUi.clear();
    ownLive.clear();
    for (const t of ownTimers.values()) clearTimeout(t);
    ownTimers.clear();
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
  const devName = (d) => (d && d.name) || "Serviço sem nome";
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
    if (r.devicePlacement !== "together") r.devicePlacement = "separate";
    return r;
  }

  function accountLabel(n) {
    const a = accById(n);
    if (!a) return `Conta ${n}`;
    return `Conta ${a.number}${a.alias ? ` “${a.alias}”` : ""}${a.email ? ` · ${a.email}` : ""}`;
  }

  /** Linha própria gravada na conta (k: threshold, weeklyThreshold, modelThreshold) ou null = vale a regra geral. */
  function ownVal(a, k) {
    const v = a[k];
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function hasOwnLine(a) {
    return ownVal(a, "threshold") !== null;
  }

  function linesFor(a) {
    const r = rules();
    const pick = (k, geral) => {
      const v = ownVal(a, k);
      return v !== null ? v : Number(geral);
    };
    return { session: pick("threshold", r.sessionPct), weekly: pick("weeklyThreshold", r.weeklyPct), model: pick("modelThreshold", r.modelPct) };
  }

  /** Uso que vale mostrar: o atual (ok) ou o último bom. */
  function usageOf(a) {
    if (a.usageStatus === "ok" && isObj(a.usage)) return { u: a.usage, age: a.usageAgeSeconds, old: false };
    if (isObj(a.lastGoodUsage)) return { u: a.lastGoodUsage, age: a.lastGoodAgeSeconds, old: true };
    return null;
  }

  const isDead = (a) => !!a.dead || a.usageStatus === "relogin_required";

  /**
   * Login que precisa ser refeito: morto ("dead"), já vencido ("expired") ou vencendo em menos de 3 dias ("soon",
   * LOGIN_WARN_MS). → { kind, date, left (ms) } ou null (em dia, ou sem data conhecida: sem aviso).
   */
  function loginAlert(a) {
    if (isDead(a)) return { kind: "dead", date: null, left: 0 };
    const d = toDate(a.loginExpiresAt);
    if (!d) return null;
    const left = d.getTime() - nowMs();
    if (left >= LOGIN_WARN_MS) return null;
    return { kind: left <= 0 ? "expired" : "soon", date: d, left };
  }

  /** Verde abaixo de 70% da linha, amarelo perto, vermelho na linha. */
  function sev(pct, line) {
    const p = Number(pct) || 0;
    const l = Number(line) || 100;
    if (p >= l) return "bad";
    if (p >= l * 0.7) return "warn";
    return "ok";
  }
  const sevText = (s) => (s === "bad" ? "na linha de troca" : s === "warn" ? "perto da linha de troca" : "longe da linha de troca");

  /**
   * Limites de uma leitura de uso (u), na ordem das barras: sessão 5h, semanal e os de modelo (ex.: Fable).
   * Cada um: rótulo (label; short = o das barras pequenas do cartão do serviço), nome por extenso, %, linha de troca, quando renova,
   * idle (sem uso nas últimas 5 horas) e own (a linha é própria da conta).
   */
  function limitsOf(a, u) {
    const lines = linesFor(a);
    const five = isObj(u.fiveHour) ? u.fiveHour : null;
    const list = [
      { label: "Sessão 5h", short: "5h", long: "Sessão de 5 horas", pct: five ? five.pct : 0, line: lines.session, resetsAt: five ? five.resetsAt : null, idle: !five, own: hasOwnLine(a) },
    ];
    if (isObj(u.sevenDay)) {
      list.push({ label: "Semanal", short: "Semanal", long: "Limite semanal", pct: u.sevenDay.pct, line: lines.weekly, resetsAt: u.sevenDay.resetsAt, idle: false, own: ownVal(a, "weeklyThreshold") !== null });
    }
    for (const s of Array.isArray(u.scoped) ? u.scoped : []) {
      if (!s || !s.name) continue;
      const name = String(s.name);
      list.push({ label: name, short: name, long: `Limite semanal do ${name}`, pct: s.pct, line: lines.model, resetsAt: s.resetsAt, idle: false, own: ownVal(a, "modelThreshold") !== null });
    }
    return list;
  }

  /**
   * O limite mais perto de parar a conta (o da linha recolhida): o de maior porcentagem entre sessão 5h, semanal
   * e os de modelo. Empate: sessão, depois semanal (a ordem de limitsOf).
   */
  function topLimit(a, u) {
    const list = limitsOf(a, u);
    let best = list[0];
    for (const l of list) if (clamp(l.pct) > clamp(best.pct)) best = l;
    return best;
  }

  function deviceNames(a) {
    return (Array.isArray(a.assignedDevices) ? a.assignedDevices : [])
      .map((d) => (typeof d === "string" ? d : d && (d.name || d.id)))
      .filter(Boolean);
  }
  /** Conta em uso: tem serviço nela agora. */
  const inUse = (a) => deviceNames(a).length > 0;

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

  /** "Serviços permitidos" da conta: null = todos, [ids] = só esses, undefined = o servidor ainda não manda. */
  function accDevices(a) {
    if (!hasOwn(a, "devices")) return undefined;
    return Array.isArray(a.devices) ? a.devices.map(String) : null;
  }
  const hasAccDevices = () => accounts().some((a) => hasOwn(a, "devices"));

  /** Contas que o serviço pode usar: Set de números, ou null (= todas). */
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

  // ------------------------------------------------------------ presença dos serviços
  // (funções sem tela: o teste "painel de verdade ... presença" roda este trecho inteiro)

  // As quatro situações de um serviço, na ordem em que aparecem na aba Serviços e no resumo. dot = a cor da bolinha;
  // one/many = o nome no resumo ("1 conectado", "2 conectados").
  //   active     ativo agora: mandou o batimento (uso) nos últimos 5 minutos — é o que as regras de troca olham
  //   connected  conectado: falou com o servidor nos últimos 5 minutos, mas sem uso (ex.: o Hermes entre duas tarefas)
  //   waiting    aguardando contato: o servidor reiniciou há menos de 5 minutos e o serviço ainda não falou com ele
  //   none       sem contato: nenhum pedido nos últimos 5 minutos
  const PRESENCE = {
    active: { order: 0, dot: "on", one: "ativo agora", many: "ativos agora" },
    connected: { order: 1, dot: "conn", one: "conectado", many: "conectados" },
    waiting: { order: 2, dot: "wait", one: "aguardando contato", many: "aguardando contato" },
    none: { order: 3, dot: "", one: "sem contato", many: "sem contato" },
  };

  /** A situação do serviço (o `presence` que o servidor manda). Servidor antigo, sem o campo: sai de `active`/`connected`. */
  function presenceOf(d) {
    if (hasOwn(PRESENCE, d.presence)) return d.presence;
    return d.active ? "active" : d.connected ? "connected" : "none";
  }

  /**
   * O texto da situação em duas partes (na tela: "situação · detalhe"):
   *   ativo agora
   *   conectado · sem uso agora
   *   aguardando contato · o servidor reiniciou há pouco
   *   sem contato · visto hoje 18:00        (ou "sem contato · ainda não apareceu")
   * → { p (a situação), main, detail (ou null) }
   */
  function presenceParts(d) {
    const p = presenceOf(d);
    if (p === "active") return { p, main: "ativo agora", detail: null };
    if (p === "connected") return { p, main: "conectado", detail: "sem uso agora" };
    if (p === "waiting") return { p, main: "aguardando contato", detail: "o servidor reiniciou há pouco" };
    const when = fmtWhen(d.lastContact ?? d.lastSeen);
    return { p, main: "sem contato", detail: when ? `visto ${when}` : "ainda não apareceu" };
  }

  /** "conectado · sem uso agora" (o texto inteiro: cartão aberto, busca e leitores de tela). */
  function presenceText(d) {
    const x = presenceParts(d);
    return x.detail ? `${x.main} · ${x.detail}` : x.main;
  }

  /** Ordem da aba Serviços: ativos, conectados, aguardando contato, sem contato; dentro de cada grupo, por nome. */
  const byPresence = (x, y) => PRESENCE[presenceOf(x)].order - PRESENCE[presenceOf(y)].order || devName(x).localeCompare(devName(y), "pt-BR");

  /**
   * O resumo dos serviços: "5 serviços (3 ativos agora, 1 conectado, 1 sem contato)". Grupo sem ninguém não aparece;
   * com um serviço só, sem o número dentro: "1 serviço (ativo agora)"; sem nenhum: "nenhum serviço".
   */
  function servicesSummary(devs) {
    const n = devs.length;
    if (!n) return "nenhum serviço";
    const count = {};
    for (const d of devs) {
      const p = presenceOf(d);
      count[p] = (count[p] || 0) + 1;
    }
    const groups = Object.keys(PRESENCE)
      .filter((k) => count[k])
      .map((k) => (n === 1 ? PRESENCE[k].one : `${count[k]} ${count[k] === 1 ? PRESENCE[k].one : PRESENCE[k].many}`));
    return `${n === 1 ? "1 serviço" : `${n} serviços`} (${groups.join(", ")})`;
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

  // ------------------------------------------------------------ busca (uma por aba)

  const SEARCH_VIEW = { contas: "accounts", computadores: "devices", usuarios: "users" }; // aba → lista que ela filtra

  /** Texto para comparar na busca: minúsculas e sem acentos ("Serviço" → "servico"). */
  const fold = (v) =>
    String(v ?? "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();
  /**
   * Filtra os itens de uma aba pela busca dela. textsOf(item) = os textos do item, inclusive os que só aparecem
   * com o cartão aberto. Sem diferença de maiúsculas e acentos. Com mais de uma palavra, todas precisam aparecer
   * (em qualquer ordem e em qualquer campo); mas, se algum item tem a frase inteira, junta, ficam só esses — assim
   * "em uso" não traz a conta "sem leitura de uso", nem "conta 7" a que está em 7º na fila.
   */
  function searchFilter(sec, list, textsOf) {
    const words = fold(filters[sec]).split(/\s+/).filter(Boolean);
    if (!words.length) return list;
    const hay = new Map(list.map((x) => [x, fold(textsOf(x).filter(Boolean).join("\n"))]));
    const all = list.filter((x) => words.every((w) => hay.get(x).includes(w)));
    if (words.length < 2) return all;
    const phrase = words.join(" ");
    const exact = all.filter((x) => hay.get(x).includes(phrase));
    return exact.length ? exact : all;
  }

  /** "N de M" ao lado do campo e o botão de limpar (só com texto na busca). */
  function paintSearch(sec, shown, total) {
    $(`qn-${sec}`).textContent = filters[sec].trim() ? `${shown} de ${total}` : "";
    $(`qx-${sec}`).classList.toggle("hidden", !filters[sec]);
  }

  /** Muda a busca da aba e redesenha a lista dela. O aberto/fechado de cada item não muda. */
  function setFilter(sec, text, focus) {
    filters[sec] = text;
    const input = $(`q-${sec}`);
    if (input.value !== text) input.value = text;
    if (S) paint(SEARCH_VIEW[sec]);
    else paintSearch(sec, 0, 0);
    if (focus) input.focus();
  }

  /** Lista vazia por causa da busca: "Nada encontrado para …" e o botão que limpa (peças para pôr numa caixa). */
  function noResults(sec, where) {
    return [
      h("p", { class: "emptytitle", text: `Nada encontrado para “${filters[sec].trim()}”` }),
      h("p", { class: "muted", text: `A busca olha todos os dados de ${where}. Tente outra palavra, ou menos palavras.` }),
      h("button", { type: "button", class: "secondary", "data-k": `q-${sec}-none`, text: "Limpar a busca", onclick: () => setFilter(sec, "", true) }),
    ];
  }

  function wireSearch() {
    for (const sec of SECTIONS) {
      const input = $(`q-${sec}`);
      input.value = ""; // o navegador não devolve texto antigo: a busca vive só na memória da página
      input.addEventListener("input", () => setFilter(sec, input.value, false));
      input.addEventListener("keydown", (e) => {
        if (e.key !== "Escape" || !input.value) return;
        e.preventDefault();
        setFilter(sec, "", false);
      });
      $(`qx-${sec}`).addEventListener("click", () => setFilter(sec, "", true));
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
    const r = rules();
    const parts = [
      accs.length === 1 ? "1 conta" : `${accs.length} contas`,
      accs.length ? (inQ === 1 ? "1 na troca" : `${inQ} na troca`) : null,
      servicesSummary(devices()),
      S.autoSwitch !== false ? "troca automática ligada" : "troca automática desligada",
      r.devicePlacement === "together" ? "serviços juntos na mesma conta" : null,
      `estratégia “${STRATEGY_LABELS[r.strategy] || r.strategy}”`,
    ].filter(Boolean);
    $("summary").textContent = parts.join(" · ");
  }

  /** Leva até a conta n e abre o cartão dela. Se a busca da aba a esconde, a busca é limpa. */
  function goToAccount(n) {
    selectSection("contas", false);
    if (accById(n)) {
      if (!$(`conta-${n}`) && filters.contas) setFilter("contas", "", false);
      setAccountOpen(n, true);
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

  /** Barra de uso. opt.mini: versão pequena (sem a linha de "renova"), para o cartão aberto do serviço. */
  function meter(label, longLabel, pct, line, resetsAt, opt = {}) {
    const p = clamp(pct);
    const s = sev(p, line);
    const fill = h("span", { class: "fill " + s });
    fill.style.width = `${p}%`;
    const mark = h("span", { class: "linemark" });
    mark.style.left = `${clamp(line)}%`;
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
      h("span", { class: "visually-hidden", text: `${longLabel}: ${fmtPct(p)} usado, ${sevText(s)} (${fmtPct(line)})${when ? `, renova ${when}` : ""}.` }),
      opt.mini ? null : h("span", { class: "reset", text: foot })
    );
  }

  /** Barras de uso de uma conta (cheias no cartão da conta, pequenas no cartão aberto do serviço). */
  function usageMeters(a, mini) {
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
    for (const l of limitsOf(a, f.u)) {
      box.append(meter(mini ? l.short : l.label, l.long, l.pct, l.line, l.resetsAt, { idle: l.idle, own: l.own, mini }));
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

  /** Texto de "Serviços permitidos" de uma conta. */
  function allowedDevicesText(a) {
    const l = accDevices(a);
    if (l === undefined) return SOON;
    if (l === null) return "todos";
    if (!l.length) return "nenhum";
    return l
      .map((id) => {
        const dv = devById(id);
        return dv ? devName(dv) : "serviço desconectado";
      })
      .join(", ");
  }

  /**
   * Botão "Entrar de novo" da conta: o fluxo de "Adicionar conta" (start → página da Claude → colar o código →
   * finish) com o e-mail dela no loginHint (vai como login_hint para a Claude). subtle = o discreto de "Ajustes".
   */
  function reloginButton(a, subtle) {
    const n = Number(a.number);
    return h("button", {
      type: "button",
      class: subtle ? "secondary small" : "small",
      "data-k": `acc-${n}-relogin${subtle ? "-adj" : ""}`,
      text: "Entrar de novo",
      "aria-label": `Entrar de novo na Conta ${n}${a.email ? ` com ${a.email}` : ""}`,
      onclick: (e) => startAddAccount(e.currentTarget, { loginHint: a.email || null, number: n }),
    });
  }

  /**
   * Abre ou fecha ali mesmo (sem redesenhar a lista) o cartão de uma linha — conta ou serviço — e guarda a
   * escolha em `set`. ids: { card, row, body } dos elementos da linha.
   */
  function setRowOpen(set, key, ids, open) {
    if (open) set.add(key);
    else set.delete(key);
    const card = $(ids.card);
    if (!card) return;
    card.classList.toggle("open", open);
    $(ids.row).setAttribute("aria-expanded", open ? "true" : "false");
    $(ids.body).hidden = !open;
  }
  const setAccountOpen = (n, open) => setRowOpen(acctExpanded, n, { card: `conta-${n}`, row: `acc-${n}-row`, body: `acc-${n}-body` }, open);

  /**
   * A barra única das linhas recolhidas (contas e serviços): o limite mais perto de parar a conta `a` (topLimit),
   * com a porcentagem, as cores de sempre e, embaixo, quando renova. Na linha da conta o rótulo é o do limite
   * ("Sessão 5h"); na do serviço (who = "Conta N") o rótulo é a conta e o limite vai para a linha de baixo.
   */
  function rowUsage(a, who) {
    const f = usageOf(a);
    if (!f) {
      const none = isDead(a) ? "Sem dados de uso." : "Ainda sem leitura de uso.";
      return h("span", { class: "ruse none" }, h("span", { class: "rreset", text: who ? `${who}: ${none.charAt(0).toLowerCase()}${none.slice(1)}` : none }));
    }
    const l = topLimit(a, f.u);
    const p = clamp(l.pct);
    const s = sev(p, l.line);
    const fill = h("span", { class: "fill " + s });
    fill.style.width = `${p}%`;
    const mark = h("span", { class: "linemark" });
    mark.style.left = `${clamp(l.line)}%`;
    const when = l.resetsAt ? fmtWhen(l.resetsAt) : null;
    const foot = l.idle ? "sem uso nas últimas 5 horas" : when ? `renova ${when}` : "";
    return h(
      "span",
      { class: "ruse" },
      h(
        "span",
        { class: "rbar" },
        h("span", { class: "lbl", "aria-hidden": "true", text: who || l.label }),
        h("span", { class: "bar", "aria-hidden": "true" }, fill, mark),
        h("span", { class: "pct " + s, "aria-hidden": "true", text: fmtPct(p) }),
        h("span", { class: "visually-hidden", text: `${who ? `${who}, ` : ""}${l.long}: ${fmtPct(p)} usado, ${sevText(s)} (${fmtPct(l.line)}).` })
      ),
      h("span", { class: "rreset", text: who ? [l.label, foot].filter(Boolean).join(" · ") : foot })
    );
  }

  /** "Fazer login até dom 22/11 14:00"; vencido: "Login venceu em qua 18/11 09:00" ("venceu ontem 22:10", sem o "em"). */
  function loginAlertText(al) {
    const when = fmtWhen(al.date);
    if (al.kind === "soon") return `Fazer login até ${when}`;
    return `Login venceu ${/^(hoje|ontem|amanhã) /.test(when) ? "" : "em "}${when}`;
  }

  /**
   * Linha da conta (o cartão recolhido), em cerca de duas linhas: nome, apelido e e-mail; UMA barra de uso, a do
   * limite mais perto de parar a conta (topLimit), com quando renova; e se participa da troca (só um indicador: o
   * liga/desliga fica no cartão aberto). "Em N serviços" e a posição na fila aparecem como etiquetas.
   * Login que vence em menos de 3 dias (ou já venceu): ícone de alerta e a linha "Fazer login até …" piscando (o
   * piscar é só CSS; para com prefers-reduced-motion). Login morto: etiqueta e linha vermelhas, sem piscar.
   * É um botão de verdade: clicar (ou Enter/Espaço) abre e fecha o cartão ali mesmo.
   * o: { pos (posição na fila ou null), open, titleId, alert (loginAlert da conta) }.
   */
  function accountRow(a, o) {
    const n = Number(a.number);
    const devs = deviceNames(a);
    const al = o.alert;
    const bad = !!al && al.kind !== "soon";

    const title = h(
      "span",
      { class: "rtitle" },
      al ? h("span", { class: "wico" + (bad ? " bad" : ""), "aria-hidden": "true" }) : null,
      h("span", { class: "aname", id: o.titleId }, h("span", { class: "n", text: `Conta ${n}` }), a.alias ? h("span", { class: "alias", text: `“${a.alias}”` }) : null),
      devs.length ? badge("on", devs.length === 1 ? "Em 1 serviço" : `Em ${devs.length} serviços`) : null,
      o.pos ? badge("plain", `${o.pos}º na fila`) : null,
      al && al.kind === "dead" ? badge("dead", "Login morto") : null,
      // rascunho de "Ajustes desta conta" ainda não salvo (o cartão pode estar fechado)
      h("span", { class: "dirty", id: `acc-${n}-rowdirty`, text: acctDraft.has(n) ? "Alterações não salvas" : "" })
    );
    const alertLine = al
      ? h(
          "span",
          { class: "ralert" + (bad ? " bad" : "") + (al.kind === "dead" ? " still" : "") },
          h("span", { class: "visually-hidden", text: bad ? "Problema: " : "Atenção: " }),
          al.kind === "dead" ? "Login morto: é preciso entrar de novo com esta conta" : loginAlertText(al)
        )
      : null;

    return h(
      "button",
      {
        type: "button",
        class: "arow",
        id: `acc-${n}-row`,
        "data-k": `acc-${n}-row`,
        "aria-expanded": o.open ? "true" : "false",
        "aria-controls": `acc-${n}-body`,
        onclick: () => setAccountOpen(n, !acctExpanded.has(n)),
      },
      h("span", { class: "chev", "aria-hidden": "true" }),
      h("span", { class: "rid" }, title, a.email ? h("span", { class: "email", text: a.email }) : null),
      rowUsage(a, null),
      h(
        "span",
        { class: "rtroca" + (a.disabled ? " off" : "") },
        h("span", { class: "dot" + (a.disabled ? "" : " on"), "aria-hidden": "true" }),
        a.disabled ? "Fora da troca" : "Participa da troca"
      ),
      alertLine
    );
  }

  /**
   * Conta na lista: a linha (accountRow) e, embaixo dela, o cartão completo (.abody), que só aparece com a conta
   * aberta. A página abre com todas fechadas; a escolha de cada conta fica em acctExpanded.
   */
  function accountCard(a, pos) {
    const n = Number(a.number);
    const dead = isDead(a);
    const devs = deviceNames(a);
    const open = acctExpanded.has(n);
    const al = loginAlert(a);
    const plan = a.plan && a.plan.label ? a.plan.label : null;
    const org = a.organizationName || a.orgName || null;
    const sub = [plan, org].filter(Boolean).join(" · ");
    const titleId = `acc-${n}-title`;

    // --- situação (ok: linha discreta; login morto: caixa vermelha; fora da troca: texto apagado)
    const sitParts = [];
    if (dead) sitParts.push(h("span", { class: "badtext", text: "login morto — clique em “Entrar de novo” (abaixo) e entre com esta conta" }));
    if (a.disabled) {
      sitParts.push(
        h("span", {
          class: "muted",
          text: `${dead ? " · " : ""}fora da troca (a troca automática não usa esta conta; dá para usá-la numa troca manual, em Serviços, ou ligar “Participa da troca” de novo, abaixo)`,
        })
      );
    }
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
      fact("Serviços nela", devs.length ? devs.join(", ") : "nenhum agora", devs.length ? null : "muted"),
      fact("Serviços permitidos", permitted, permitted === SOON ? "muted" : null),
      fact("Acesso atual", [accessMain, accessSub ? h("span", { class: "factsub", text: ` (${accessSub})` }) : null]),
      fact("Login vale até", loginDate ? fmtWhen(loginDate) : "sem data conhecida", loginDate ? null : "muted")
    );

    // Login morto, vencido ou vencendo em menos de 3 dias: aviso com o botão "Entrar de novo" (o mesmo fluxo de
    // "Adicionar conta", com o e-mail desta conta já pedido na página da Claude).
    const who = a.email || "esta conta";
    const reloginBox = (cls, text) =>
      h("div", { class: `warnbox relogin${cls ? ` ${cls}` : ""}` }, h("p", { text }), reloginButton(a, false));
    let loginWarn = null;
    if (al && al.kind === "dead") {
      loginWarn = reloginBox("bad", `O login parou de valer e o servidor não consegue mais renovar. Entre de novo com ${who}.`);
    } else if (al && al.kind === "expired") {
      loginWarn = reloginBox("bad", `O login venceu ${fmtWhen(al.date)}. Entre de novo com ${who}.`);
    } else if (al) {
      loginWarn = reloginBox("", `Login vence em ${fmtSpan(al.left)} (${fmtWhen(al.date)}). Entre de novo com ${who} para renovar.`);
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
        act(e.target, () => api("PATCH", `/web/api/accounts/${n}`, { disabled: !on }), {
          ok: () => {
            if (on) return `Conta ${n} de volta à troca.`;
            const cur = accById(n); // já com o estado novo: a conta em uso continua no alto da lista
            const where = cur && inUse(cur) ? "Enquanto houver serviço nela, continua no alto da lista; depois vai para o fim." : "Ela vai para o fim da lista.";
            return `Conta ${n} fora da troca: a troca automática não vai usá-la. ${where}`;
          },
        });
      },
    });
    const rotRow = h("label", { class: "switchrow", for: rotId }, rot, h("span", { text: "Participa da troca" }));

    // Rodapé do cartão: liga/desliga da troca; "Ajustes desta conta" com "Remover conta" na mesma linha, à direita.
    const bottom = h(
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
    );

    // A linha (botão) é o cabeçalho; o corpo é irmão dela, não filho: clicar no liga/desliga, em "Ajustes desta
    // conta" ou em "Remover conta" não abre nem fecha o cartão.
    const cls =
      "card rowcard acct" +
      (open ? " open" : "") +
      (a.disabled ? " off" : "") +
      (dead ? " deadacc" : "") +
      (al && al.kind === "soon" ? " loginsoon" : "") +
      (al && al.kind === "expired" ? " loginbad" : "");
    return h(
      "article",
      { class: cls, id: `conta-${n}`, tabindex: "-1", "aria-labelledby": titleId },
      h("h3", { class: "arowh" }, accountRow(a, { pos, open, titleId, alert: al })),
      h(
        "div",
        { class: "abody", id: `acc-${n}-body`, hidden: !open },
        sub ? h("p", { class: "sub", text: sub }) : null,
        sit,
        usageMeters(a, false),
        info,
        loginWarn,
        bottom
      )
    );
  }

  /** Tira o valor do slider ainda não confirmado (se ainda for o mesmo). */
  function dropOwnLive(n, k, v) {
    const l = ownLive.get(n);
    if (!l || !hasOwn(l, k) || (v !== undefined && l[k] !== v)) return;
    delete l[k];
    if (!Object.keys(l).length) ownLive.delete(n);
  }

  /** Salva a linha própria k da conta n ~500 ms depois do último movimento do slider (PATCH só desse campo). */
  function scheduleOwnSave(n, k, word) {
    const key = `${n}:${k}`;
    clearTimeout(ownTimers.get(key));
    ownTimers.set(
      key,
      setTimeout(async () => {
        ownTimers.delete(key);
        const l = ownLive.get(n);
        if (!l || !hasOwn(l, k)) return;
        const v = l[k];
        const ok = await act(null, () => api("PATCH", `/web/api/accounts/${n}`, { [k]: v }), {
          before: () => dropOwnLive(n, k, v),
          ok: `Conta ${n}: ${word} ${v}% salvo.`,
        });
        if (!ok) {
          dropOwnLive(n, k, v); // volta a mostrar o que está gravado no servidor
          paint("accounts");
        }
      }, OWN_SAVE_MS)
    );
  }

  /**
   * "Regras de troca desta conta" (dentro de "Ajustes desta conta"): "Usar regra padrão" ou linhas próprias de
   * sessão 5h, semanal e modelo. Vale na hora, sem o "Salvar ajustes": cada slider salva só o campo dele; marcar
   * "Usar regra padrão" de novo apaga as três (null = a regra geral).
   */
  function ownRulesBlock(a) {
    const n = Number(a.number);
    const r = rules();
    const id = (s) => `acc-${n}-${s}`;
    const live = ownLive.get(n) || {};
    const cur = (k) => (hasOwn(live, k) ? live[k] : ownVal(a, k));
    const useDefault = !ownUi.has(n) && OWN_KEYS.every((k) => cur(k) === null);
    const modelName = r.preferModel ? String(r.preferModel) : "Modelo";
    const specs = [
      { k: "threshold", label: "Sessão 5h", word: "sessão", geral: r.sessionPct },
      { k: "weeklyThreshold", label: "Semanal", word: "semanal", geral: r.weeklyPct },
      { k: "modelThreshold", label: modelName, word: modelName, geral: r.modelPct },
    ];
    const fDef = h("input", { type: "checkbox", id: id("ruledef"), "data-k": id("ruledef"), checked: useDefault, "aria-describedby": id("ruledefHint") });
    const sliders = specs.map((s) => {
      const v = cur(s.k);
      const val = Math.round(v !== null ? v : Number(s.geral));
      const input = h("input", { type: "range", id: id(`own-${s.k}`), "data-k": id(`own-${s.k}`), min: "50", max: "100", step: "1", value: String(val), "aria-valuetext": `${val}%` });
      const out = h("output", { for: input.id, text: `${val}%` });
      const tag = h("span", { class: "muted small", text: v === null ? " · regra geral" : "" });
      input.addEventListener("input", () => {
        out.textContent = `${input.value}%`;
        input.setAttribute("aria-valuetext", `${input.value}%`);
      });
      input.addEventListener("change", () => {
        ownLive.set(n, { ...(ownLive.get(n) || {}), [s.k]: Number(input.value) });
        tag.textContent = "";
        scheduleOwnSave(n, s.k, s.word);
      });
      return h("div", { class: "field range" }, h("label", { for: input.id }, s.label, tag), input, out);
    });
    const box = h(
      "div",
      { class: useDefault ? "hidden" : null },
      sliders,
      h("small", { class: "hint", text: "Cada mudança vale na hora. A linha que você não mexer continua igual à regra geral." })
    );
    fDef.addEventListener("change", () => {
      if (!fDef.checked) {
        ownUi.add(n);
        box.classList.remove("hidden");
        return;
      }
      ownUi.delete(n);
      box.classList.add("hidden");
      const hadLive = ownLive.has(n);
      for (const k of OWN_KEYS) {
        clearTimeout(ownTimers.get(`${n}:${k}`));
        ownTimers.delete(`${n}:${k}`);
      }
      ownLive.delete(n);
      if (!hadLive && OWN_KEYS.every((k) => ownVal(a, k) === null)) return; // nada gravado: só fecha
      act(fDef, () => api("PATCH", `/web/api/accounts/${n}`, { threshold: null, weeklyThreshold: null, modelThreshold: null }), {
        ok: `Conta ${n} voltou à regra padrão.`,
      });
    });
    return h(
      "fieldset",
      { class: "subfield" },
      h("legend", { text: "Quando trocar desta conta" }),
      h("label", { class: "check", for: id("ruledef") }, fDef, h("span", { text: "Usar regra padrão" })),
      h("small", {
        class: "hint",
        id: id("ruledefHint"),
        text: `Regra padrão (em “Regras de troca”): sessão ${fmtPct(r.sessionPct)} · semanal ${fmtPct(r.weeklyPct)} · ${modelName} ${fmtPct(r.modelPct)}.`,
      }),
      box
    );
  }

  /**
   * "Ajustes desta conta": apelido, regras de troca desta conta (salvas na hora, ver ownRulesBlock), prioridade e
   * serviços permitidos, com rascunho (sobrevive à atualização de 30 s) e Salvar/Desfazer.
   */
  function adjustForm(a) {
    const n = Number(a.number);
    const r = rules();
    const permitted = accDevices(a); // undefined = servidor antigo
    const devKnown = permitted !== undefined;
    const knownIds = new Set(devices().map((x) => String(x.id)));
    const orig = {
      alias: a.alias || "",
      priority: String(Number(a.priority) || 0),
      devAll: !permitted,
      devPicked: permitted ? permitted.filter((x) => knownIds.has(x)).sort() : [],
    };
    const d = acctDraft.get(n) || orig;
    const id = (s) => `acc-${n}-${s}`;

    const fAlias = h("input", { type: "text", id: id("alias"), "data-k": id("alias"), maxlength: "40", autocomplete: "off", value: d.alias });
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

    // --- serviços permitidos
    let devSet;
    let readDevs = () => ({ devAll: orig.devAll, devPicked: orig.devPicked });
    let syncDevs = () => {};
    if (!devKnown) {
      devSet = h("fieldset", { class: "subfield" }, h("legend", { text: "Serviços permitidos" }), h("p", { class: "hint", text: `Escolher os serviços de cada conta: ${SOON}.` }));
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
        h("legend", { text: "Serviços permitidos" }),
        h("p", { class: "hint", id: id("devHint"), text: "Quais serviços podem usar esta conta (na troca automática e na troca manual)." }),
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
          : h("p", { class: "hint", text: "Nenhum serviço conectado ainda." })
      );
    }

    const dirtyNote = h("span", { class: "dirty", role: "status", text: "" });
    const save = h("button", { type: "submit", "data-k": id("save"), text: "Salvar ajustes", "aria-label": `Salvar ajustes da Conta ${n}` });
    const undo = h("button", { type: "button", class: "secondary", "data-k": id("undo"), text: "Desfazer", "aria-label": `Desfazer ajustes da Conta ${n}` });

    const read = () => ({ alias: fAlias.value, priority: fPr.value, ...readDevs() });
    const sameDevs = (x) => x.devAll === orig.devAll && (x.devAll || sameList(x.devPicked, orig.devPicked));
    const same = (x) => x.alias.trim() === orig.alias && Number(x.priority) === Number(orig.priority) && sameDevs(x);
    const sync = () => {
      const x = read();
      syncDevs(x);
      if (same(x)) acctDraft.delete(n);
      else acctDraft.set(n, x);
      dirtyNote.textContent = acctDraft.has(n) ? "Alterações não salvas" : "";
      const rowNote = $(id("rowdirty")); // o mesmo aviso na linha da conta (continua à vista com o cartão fechado)
      if (rowNote) rowNote.textContent = dirtyNote.textContent;
    };

    const prioMatters = r.strategy === "priority";
    const form = h(
      "form",
      { class: "adjform", novalidate: true },
      h("div", { class: "field" }, h("label", { for: id("alias"), text: "Apelido" }), fAlias),
      ownRulesBlock(a),
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
        toast("Serviços permitidos: marque pelo menos um serviço ou escolha “Todos”.", "error");
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

    // Discreto, sempre à mão: renovar o login desta conta antes de vencer (o mesmo "Entrar de novo" do aviso).
    const relogin = h(
      "div",
      { class: "reloginsub" },
      h("p", { class: "hint", text: `Login desta conta: entre de novo${a.email ? ` com ${a.email}` : ""} para renovar (ex.: perto de vencer).` }),
      reloginButton(a, true)
    );
    const det = h(
      "details",
      { class: "adj", open: acctOpen.has(n) || acctDraft.has(n) },
      h("summary", { "data-k": id("adj"), text: "Ajustes desta conta" }),
      form,
      relogin
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
        (devs.length ? ` e ${devs.length === 1 ? "o serviço que está nela passa" : "os serviços que estão nela passam"} para outra conta` : "") +
        ". Para usar esta conta de novo, adicione-a outra vez (botão “Adicionar conta”).",
      ok: "Remover conta",
    });
    if (!ok) return;
    await act(btn, () => api("DELETE", `/web/api/accounts/${n}`), {
      before: () => {
        acctDraft.delete(n);
        acctOpen.delete(n);
        acctExpanded.delete(n);
      },
      ok: `Conta ${n} removida.`,
    });
  }

  /**
   * Textos de uma conta para a busca: tudo o que a linha e o cartão aberto dizem dela (as porcentagens não).
   * pos = posição na fila (ou null).
   */
  function accountWords(a, pos) {
    const al = loginAlert(a);
    const devs = deviceNames(a);
    return [
      `Conta ${a.number}`,
      a.alias,
      a.email,
      a.plan && a.plan.label,
      a.organizationName || a.orgName,
      a.disabled ? "fora da troca" : "participa da troca",
      devs.length ? `em uso em ${devs.length === 1 ? "1 serviço" : `${devs.length} serviços`}` : null,
      ...devs,
      pos ? `${pos}º na fila` : null,
      isDead(a) ? "login morto" : a.disabled ? null : "situação ok",
      al && al.kind === "soon" ? `login vencendo ${loginAlertText(al)}` : null,
      al && al.kind === "expired" ? loginAlertText(al) : null,
      usageOf(a) ? null : "sem leitura de uso",
      `permitidos: ${allowedDevicesText(a)}`,
    ];
  }

  /**
   * Lista de contas, numa coluna só de linhas que abrem e fecham (accountCard), sem grupo à parte. Ordem (pedido
   * do dono): primeiro as contas em uso (com serviço nelas agora), mesmo as que estão fora da troca; depois as
   * outras que participam, na ordem da fila; no fim, as que estão fora da troca (por número). A posição na fila
   * ("1º na fila") é a da fila, não a da lista: a conta em uso sobe sem mudar de posição.
   * A busca da aba (filters.contas) só esconde linhas: não mexe na ordem nem no que está aberto.
   */
  function renderAccounts(box) {
    for (const n of [...acctDraft.keys()]) if (!accById(n)) acctDraft.delete(n);
    for (const n of [...ownUi]) if (!accById(n)) ownUi.delete(n);
    for (const n of [...acctExpanded]) if (!accById(n)) acctExpanded.delete(n);
    const all = accounts();
    if (!all.length) {
      paintSearch("contas", 0, 0);
      box.replaceChildren(
        emptyState("Nenhuma conta no servidor ainda", "Clique em “Adicionar conta” (no alto, à direita) e entre com a conta Claude. Ou entre com a conta no Claude Code de um serviço conectado.")
      );
      return;
    }
    const inQ = queueOrder(all.filter((a) => !a.disabled));
    const posOf = new Map(); // número da conta → posição na fila (login morto não entra na fila)
    for (const a of inQ) if (!isDead(a)) posOf.set(Number(a.number), posOf.size + 1);
    const pos = (a) => posOf.get(Number(a.number)) || null;
    const off = all.filter((a) => a.disabled).sort(byNumber);
    const list = [...inQ.filter(inUse), ...off.filter(inUse), ...inQ.filter((a) => !inUse(a)), ...off.filter((a) => !inUse(a))];
    const shown = searchFilter("contas", list, (a) => accountWords(a, pos(a)));
    paintSearch("contas", shown.length, list.length);
    const kids = [];
    if (!inQ.length && !filters.contas.trim()) kids.push(emptyState("Nenhuma conta participa da troca agora", "Clique numa conta e ligue “Participa da troca”."));
    if (shown.length) kids.push(h("div", { class: "accounts" }, shown.map((a) => accountCard(a, pos(a)))));
    else kids.push(h("div", { class: "emptystate card" }, noResults("contas", "cada conta (número, apelido, e-mail, plano, situação, fila e os serviços nela)")));
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

  /** Nome do botão que gera outro link: "Entrar de novo" (login de uma conta que já existe) ou "Adicionar conta". */
  function againLabel(l = addLogin) {
    return l && l.loginHint ? "Entrar de novo" : "Adicionar conta";
  }

  /** Textos da caixa: "Adicionar conta Claude" ou "Entrar de novo na Conta N" (com o e-mail que a Claude vai pedir). */
  function paintAddMode() {
    const re = addLogin && addLogin.loginHint ? addLogin : null;
    $("addTitle").textContent = re ? `Entrar de novo na Conta ${re.number}` : "Adicionar conta Claude";
    $("addWho").textContent = re
      ? `Entre com ${re.loginHint} e autorize. Se a página abrir com outra conta Claude, saia dela primeiro (ou use uma janela anônima).`
      : "Entre com a conta Claude que quer adicionar e autorize.";
    $("addFinish").textContent = re ? "Concluir" : "Adicionar";
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
    paintAddMode();
  }

  function showAddUnavailable() {
    hideAddBox();
    $("addSteps").classList.add("hidden");
    $("addOff").classList.remove("hidden");
    $("addBox").classList.remove("hidden");
    $("addCancel").focus();
  }

  /**
   * "+ Adicionar conta" (sem opts) ou "Entrar de novo" de uma conta (opts = { loginHint: e-mail dela, number }):
   * o mesmo fluxo — start → abrir o authUrl → colar o código → finish. O loginHint vai para o servidor, que o põe
   * como login_hint na URL da Claude (e-mail inválido o servidor ignora).
   */
  async function startAddAccount(btn, opts = {}) {
    const hint = typeof opts.loginHint === "string" && opts.loginHint.trim() ? opts.loginHint.trim() : null;
    const number = opts.number !== undefined && opts.number !== null ? Number(opts.number) : null;
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
      const r = await api("POST", "/web/api/claude-login/start", hint ? { loginHint: hint } : undefined);
      const url = safeHttps(r && r.authUrl);
      if (!isObj(r) || !r.loginId || !url) throw apiError(0, "bad_response", "O servidor não devolveu o link de login da Claude.");
      hideAddBox();
      const exp = toDate(r.expiresAt);
      addLogin = {
        loginId: String(r.loginId),
        authUrl: url,
        expiresAt: exp ? exp.getTime() : nowMs() + ADD_LOGIN_MS,
        loginHint: hint, // "Entrar de novo": o e-mail pedido (null = Adicionar conta)
        number: hint ? number : null,
      };
      paintAddMode();
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
      $("addInfo").textContent = `Vale até ${fmtWhen(addLogin.expiresAt)} (10 minutos). Se der errado, clique em “${againLabel()}” de novo para gerar outro link.`;
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
    const label = againLabel();
    addLogin = null;
    $("addFinish").disabled = true;
    $("addInfo").textContent = `Este link venceu. Clique em “${label}” para gerar outro.`;
    toast(`O link de login da Claude venceu. Clique em “${label}” para gerar outro.`);
  }

  async function finishAddAccount(e) {
    e.preventDefault();
    const input = $("addCode");
    if (!addLogin) {
      toast("Clique em “Adicionar conta” (ou em “Entrar de novo”, no cartão da conta) para gerar um link novo.", "error");
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
        // "Entrar de novo" que entrou com OUTRO e-mail: a mensagem do servidor diz qual conta mudou (e que a pedida
        // não mudou). Fica em destaque (aviso de erro, mais tempo na tela).
        if (r && r.otherEmail && typeof r.message === "string" && r.message) toast(r.message, "error");
      },
      ok: (r) => {
        if (r && r.otherEmail) return null; // já avisado em destaque (after)
        if (!r || r.number === undefined || r.number === null) return "Conta adicionada.";
        if (r.loginHint && r.created === false) return `Conta ${r.number}: entrou de novo. O login novo já vale.`;
        return r.created === false ? `Conta ${r.number} atualizada com o login novo.` : `Conta ${r.number} adicionada.`;
      },
    });
  }

  // ------------------------------------------------------------ Serviços (tudo o que está conectado ao Swap)

  const devAssigned = (d) => (d.assigned !== null && d.assigned !== undefined ? Number(d.assigned) : null);
  /** Quem conectou o serviço: a conta Google, ou "conectado por código". */
  const devWho = (d) => d.googleEmail || "conectado por código";
  /** O nome está sendo trocado e o que foi digitado ainda não foi salvo. */
  const renameDirty = (d) => devRename.has(d.id) && String(devRename.get(d.id)).trim() !== (d.name || "");
  const setServiceOpen = (devId, open) => {
    const s = safeId(devId);
    setRowOpen(svcExpanded, devId, { card: `dev-${s}-card`, row: `dev-${s}-row`, body: `dev-${s}-body` }, open);
  };

  /** Textos de um serviço para a busca: o que a linha e o cartão aberto dizem dele (as porcentagens não). */
  function serviceWords(d) {
    const assigned = devAssigned(d);
    const acc = assigned !== null ? accById(assigned) : null;
    return [
      devName(d),
      platformLabel(d.platform),
      devWho(d),
      presenceText(d),
      assigned !== null ? `Conta ${assigned}` : "sem conta",
      acc && acc.alias,
      acc && acc.email,
      acc && isDead(acc) ? "login morto" : null,
    ];
  }

  /**
   * Lista de serviços, como a de contas: uma coluna de linhas que abrem e fecham (serviceCard), todas recolhidas
   * quando a página abre (svcExpanded guarda o que está aberto). Ordem (byPresence): ativos, conectados, aguardando
   * contato e sem contato; dentro de cada grupo, por nome. A busca da aba (filters.computadores) só esconde linhas.
   */
  function renderDevices(box) {
    const list = [...devices()].sort(byPresence);
    for (const id of [...devChoice.keys()]) if (!list.some((d) => d.id === id)) devChoice.delete(id);
    for (const id of [...devRename.keys()]) if (!list.some((d) => d.id === id)) devRename.delete(id);
    for (const id of [...svcExpanded]) if (!list.some((d) => d.id === id)) svcExpanded.delete(id);
    if (!list.length) {
      paintSearch("computadores", 0, 0);
      box.replaceChildren(
        emptyState(
          "Nenhum serviço conectado ainda",
          "Para conectar: no computador, abra o VS Code com o Swap Plus e clique em “Entrar com Google” no cartão “Conexão”. O passo a passo completo está logo abaixo, em “Conectar um serviço”."
        )
      );
      return;
    }
    const shown = searchFilter("computadores", list, serviceWords);
    paintSearch("computadores", shown.length, list.length);
    if (shown.length) box.replaceChildren(...shown.map(serviceCard));
    else box.replaceChildren(h("div", { class: "emptystate card" }, noResults("computadores", "cada serviço (nome, sistema, quem conectou, contato e a conta em que ele está)")));
  }

  /**
   * Linha do serviço (o cartão recolhido), em cerca de duas linhas: bolinha da situação (uma cor para cada uma:
   * PRESENCE) e nome; sistema e quem conectou; a conta Claude em que ele está agora ("Conta N" com UMA barra, a
   * mesma das linhas de conta — rowUsage — ou "Sem conta Claude agora"); e o contato: a situação ("ativo agora",
   * "conectado", "aguardando contato", "sem contato") e, embaixo, o detalhe dela (presenceParts).
   * É um botão de verdade, como a linha da conta: clicar (ou Enter/Espaço) abre e fecha o cartão ali mesmo.
   * o: { id (monta os ids), name, open, assigned, acc }.
   */
  function serviceRow(d, o) {
    const pr = presenceParts(d);
    const dot = PRESENCE[pr.p].dot;
    const title = h(
      "span",
      { class: "rtitle" },
      // a bolinha vai dentro do nome: num nome comprido, ela fica na primeira linha dele
      h("span", { class: "aname", id: o.id("title") }, h("span", { class: "n" }, h("span", { class: "dot" + (dot ? ` ${dot}` : ""), "aria-hidden": "true" }), o.name)),
      o.acc && isDead(o.acc) ? badge("dead", "Login morto") : null,
      // nome novo digitado e ainda não salvo (o cartão pode estar fechado)
      h("span", { class: "dirty", id: o.id("rowdirty"), text: renameDirty(d) ? "Nome não salvo" : "" })
    );
    let use;
    if (o.acc) use = rowUsage(o.acc, `Conta ${o.acc.number}`);
    else use = h("span", { class: "ruse none" }, h("span", { class: "rreset", text: o.assigned !== null ? `Conta ${o.assigned} (não existe mais no servidor)` : "Sem conta Claude agora" }));
    // a situação em cima e o detalhe embaixo; o " · " entre os dois é só para quem ouve a tela (o texto inteiro)
    const seen = [
      h("span", { class: pr.p === "active" ? "oktext" : null, text: pr.main }),
      pr.detail ? h("span", { class: "visually-hidden", text: " · " }) : null,
      pr.detail ? h("span", { class: "when", text: pr.detail }) : null,
    ];
    return h(
      "button",
      {
        type: "button",
        class: "arow",
        id: o.id("row"),
        "data-k": o.id("row"),
        "aria-expanded": o.open ? "true" : "false",
        "aria-controls": o.id("body"),
        onclick: () => setServiceOpen(d.id, !svcExpanded.has(d.id)),
      },
      h("span", { class: "chev", "aria-hidden": "true" }),
      h("span", { class: "rid" }, title, h("span", { class: "email", text: `${platformLabel(d.platform)} · ${devWho(d)}` })),
      use,
      h("span", { class: "rseen" }, seen)
    );
  }

  /**
   * Serviço na lista: a linha (serviceRow) e, embaixo dela, o cartão completo (.abody) — sistema, usuário e
   * contato; a conta Claude de agora com as barras todas; "Trocar para"; Renomear e Desconectar. O corpo é irmão
   * do botão da linha: os controles de dentro não abrem nem fecham o cartão.
   */
  function serviceCard(d) {
    const name = devName(d);
    const safe = safeId(d.id);
    const id = (s) => `dev-${safe}-${s}`;
    const assigned = devAssigned(d);
    const acc = assigned !== null ? accById(assigned) : null;
    const open = svcExpanded.has(d.id);
    const pr = presenceParts(d);

    // --- renomear: o botão fica no pé do cartão; clicando, o campo aparece no alto do cartão
    const renaming = devRename.has(d.id);
    const ren = h("button", { type: "button", class: "secondary small", "data-k": id("ren"), text: "Renomear", "aria-label": `Renomear ${name}` });
    ren.addEventListener("click", () => {
      devRename.set(d.id, d.name || "");
      paint("devices", true);
      const input = $(id("name"));
      if (input) {
        input.focus();
        input.select();
      }
    });

    // --- conta Claude logada agora
    const accBox = acc
      ? h(
          "div",
          { class: "tacc" },
          h("div", { class: "taccname" }, h("b", { text: `Conta ${acc.number}` }), acc.alias ? h("span", { text: ` “${acc.alias}”` }) : null, isDead(acc) ? badge("dead", "Login morto") : null),
          acc.email ? h("div", { class: "email small", text: acc.email }) : null,
          usageMeters(acc, true)
        )
      : h("div", { class: "tacc none" }, h("p", { class: "muted small", text: assigned !== null ? `Conta ${assigned} (não existe mais no servidor).` : "Nenhuma conta Claude neste serviço agora." }));

    // --- trocar (só entre as contas permitidas para este serviço)
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
            ? "Só aparecem as contas que permitem este serviço (em Contas › Ajustes desta conta)."
            : "Nenhuma conta permite este serviço. Libere em Contas › Ajustes desta conta › Serviços permitidos.",
        })
      : null;
    if (hint) sel.setAttribute("aria-describedby", id("selHint"));

    const off = h("button", { type: "button", class: "danger subtle small", "data-k": id("del"), text: "Desconectar", "aria-label": `Desconectar ${name}` });
    off.addEventListener("click", () => disconnectDevice(d, off));

    return h(
      "article",
      { class: "card rowcard svc" + (open ? " open" : ""), id: id("card"), "aria-labelledby": id("title") },
      h("h3", { class: "arowh" }, serviceRow(d, { id, name, open, assigned, acc })),
      h(
        "div",
        { class: "abody sbody", id: id("body"), hidden: !open },
        renaming ? renameForm(d, id, name) : null,
        h(
          "div",
          { class: "sleft" },
          h(
            "dl",
            { class: "tinfo" },
            h("dt", { text: "Sistema" }),
            h("dd", { text: platformLabel(d.platform) }),
            h("dt", { text: "Usuário" }),
            h("dd", { text: devWho(d) }),
            h("dt", { text: "Contato" }),
            h("dd", { class: pr.p === "active" ? "oktext" : null, text: presenceText(d) })
          ),
          h("div", { class: "dctl" }, h("label", { for: id("sel"), text: "Trocar para" }), h("div", { class: "row gap wrap" }, sel, go), hint)
        ),
        h("div", { class: "tsec" }, h("p", { class: "tlabel", text: "Conta Claude agora" }), accBox),
        h("div", { class: "afoot" }, renaming ? null : ren, off)
      )
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
    input.addEventListener("input", () => {
      devRename.set(d.id, input.value);
      const rowNote = $(id("rowdirty")); // o aviso na linha do serviço (continua à vista com o cartão fechado)
      if (rowNote) rowNote.textContent = renameDirty(d) ? "Nome não salvo" : "";
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        cancel();
      }
    });
    cancelBtn.addEventListener("click", cancel);
    const form = h("form", { class: "renform", novalidate: true }, h("label", { for: id("name"), text: "Novo nome" }), input, h("div", { class: "row gap" }, save, cancelBtn));
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const v = input.value.trim().replace(/\s+/g, " ");
      if (!v) {
        input.setAttribute("aria-invalid", "true");
        input.focus();
        toast("Digite um nome para o serviço.", "error");
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
        ok: `Serviço renomeado para “${v}”.`,
      });
    });
    return form;
  }

  function switchDevice(d, value, btn) {
    const number = value === "best" ? null : Number(value);
    const name = d.name || "o serviço";
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
    const name = d.name || "este serviço";
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
        svcExpanded.delete(d.id);
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
      devicePlacement: checkedValue("devicePlacement") === "together" ? "together" : "separate",
    };
  }

  const sameVal = (a, b) => (typeof b === "number" ? Number(a) === b : String(a) === String(b));

  function sameRules(x, y) {
    if (!x || !y) return false;
    return RULE_KEYS.every((k) => sameVal(x[k], y[k])); // a troca automática não entra: ela vale na hora
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
    for (const el of $("rulesForm").querySelectorAll('input[name="devicePlacement"]')) el.checked = el.value === (v.devicePlacement === "together" ? "together" : "separate");
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
    // A troca automática sempre mostra o que vale no servidor (ela não tem rascunho).
    if (document.activeElement !== $("rAuto") || !$("rAuto").disabled) {
      $("rAuto").checked = S.autoSwitch !== false;
      if (rulesBase) rulesBase.autoSwitch = $("rAuto").checked;
      paintChoices();
    }
    const cur = stateRuleValues();
    const sig = JSON.stringify({ ...cur, autoSwitch: undefined }); // a troca automática não conta como "regra mudada"
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

  // Troca automática: vale na hora do clique (pedido do dono — antes só valia depois de "Salvar regras",
  // e ela ficava desligada sem ninguém perceber). Não entra no rascunho das outras regras.
  async function applyAutoNow(on) {
    const el = $("rAuto");
    await act(el, () => api("PUT", "/web/api/rules", { autoSwitch: !!on }), {
      ok: on
        ? "Troca automática ligada. Vale agora, para todos os serviços."
        : "Troca automática desligada. Nenhum serviço troca de conta sozinho.",
    });
    // Mostra o que ficou valendo no servidor (se o pedido falhou, o botão volta ao estado real).
    el.checked = !!S && S.autoSwitch !== false;
    if (rulesBase) rulesBase.autoSwitch = el.checked;
    paintChoices();
  }

  function onRulesInput(e) {
    if (!rulesBase) return; // estado ainda não chegou
    if (e && e.target && e.target.id === "rAuto") {
      if (e.type === "change") applyAutoNow(e.target.checked);
      return;
    }
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
    if (!("rules" in body)) {
      setRulesDirty(false);
      toast("Nada para salvar.");
      return;
    }
    await act($("rulesSave"), () => api("PUT", "/web/api/rules", body), {
      before: () => {
        setRulesDirty(false);
        rulesBaseSig = null; // a próxima carga preenche o formulário com o que ficou salvo
      },
      ok: "Regras salvas. Valem para todos os serviços.",
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

  /** Linhas da tabela: administrador(es), usuários liberados e e-mails tirados que ainda têm serviço conectado. */
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

  const ROLE_ORDER = { admin: 0, user: 1, gone: 2 };
  const ROLE_LABEL = { admin: "Administrador", user: "Liberado", gone: "Não liberado" };

  /** Textos de um usuário para a busca: e-mail, situação e os nomes dos serviços que ele conectou. */
  function userWords(r, self) {
    return [r.email, ROLE_LABEL[r.role], r.role === "user" ? "usuário" : null, self ? "você" : null, ...r.devices.map(devName), r.devices.length ? null : "nenhum serviço"];
  }

  /** Ordena as linhas pela coluna escolhida no cabeçalho (userSort); o e-mail desempata. */
  function sortUsers(rows) {
    const mail = (x, y) => x.email.localeCompare(y.email, "pt-BR");
    const by = { role: (x, y) => ROLE_ORDER[x.role] - ROLE_ORDER[y.role], services: (x, y) => x.devices.length - y.devices.length };
    const f = by[userSort.key];
    return [...rows].sort((x, y) => (f ? userSort.dir * f(x, y) || mail(x, y) : userSort.dir * mail(x, y)));
  }

  /** Clique no cabeçalho: ordena por essa coluna; de novo, inverte. "Serviços" começa por quem tem mais. */
  function sortUsersBy(key) {
    userSort = userSort.key === key ? { key, dir: -userSort.dir } : { key, dir: key === "services" ? -1 : 1 };
    paint("users");
  }

  function paintUserSort() {
    for (const th of document.querySelectorAll(".utable th[data-sort]")) {
      const on = th.getAttribute("data-sort") === userSort.key;
      th.setAttribute("aria-sort", on ? (userSort.dir > 0 ? "ascending" : "descending") : "none");
    }
  }

  /**
   * Mensagens do último pedido da aba Usuários, mostradas no lugar e não no aviso flutuante: a do formulário
   * (userNote.form) embaixo do campo de liberar; a da tabela (userNote.table) no alto dela quando where = "table".
   * A de uma linha (where = chave da linha) sai com a tabela, na faixa embaixo da linha (userRow).
   */
  function paintUserNotes() {
    const t = userNote.table;
    for (const [id, n] of [["allowMsg", userNote.form], ["usersStatus", t && t.where === "table" ? t : null]]) {
      const el = $(id);
      el.textContent = n ? n.text : "";
      el.classList.toggle("hidden", !n);
      el.classList.toggle("ok", !!n && n.kind === "ok");
      el.classList.toggle("error", !!n && n.kind === "error");
      el.setAttribute("role", n && n.kind === "error" ? "alert" : "status");
    }
  }

  /** slot: "form" ou "table". note: { kind, text, where? (só na tabela), status? } ou null (apaga). */
  function setUserNote(slot, note) {
    userNote[slot] = note && note.text ? note : null;
    paintUserNotes();
    if (slot === "table" && S) paint("users");
  }

  /**
   * Pedido da aba Usuários: trava o botão, chama a API, recarrega o estado e mostra o resultado no lugar.
   * o.slot: "form" (liberar pelo formulário) ou "table"; na tabela, o.okAt e o.errAt dizem onde ("table" = no alto,
   * ou a chave da linha). → true se deu certo.
   */
  async function userAct(btn, fn, o) {
    const key = btn.getAttribute("data-k");
    btn.disabled = true;
    btn.setAttribute("aria-busy", "true");
    userNote[o.slot] = null;
    paintUserNotes();
    let ok = false;
    try {
      const r = await fn();
      ok = true;
      if (o.before) o.before(r);
      await loadState(false);
      if (o.after) o.after(r);
      setUserNote(o.slot, { where: o.okAt, kind: "ok", text: typeof o.ok === "function" ? o.ok(r) : o.ok });
    } catch (e) {
      if (e.status !== 401) {
        if (e.code !== "unavailable" && (e.status === 404 || e.status === 409)) await loadState(false);
        setUserNote(o.slot, { where: o.errAt, kind: "error", text: e.message || "Algo deu errado. Tente de novo.", status: e.status });
      }
    } finally {
      if (btn.isConnected) {
        btn.disabled = false;
        btn.removeAttribute("aria-busy");
      }
      refocus(key);
      // o botão sumiu com a linha (usuário tirado ou liberado): o foco vai para a mensagem, no alto da tabela
      const a = document.activeElement;
      if (ok && o.okAt === "table" && (!a || a === document.body)) $("usersStatus").focus({ preventScroll: true });
    }
    return ok;
  }

  const allowedText = (email) => (r) =>
    r && r.admin
      ? "Essa é a conta do administrador: ela já conecta serviços e entra no painel."
      : r && r.added === false
        ? "Esse usuário já está liberado."
        : `${email} liberado. Ele já pode conectar serviços pelo VS Code (Entrar com Google). O painel continua só do administrador.`;

  /** "Tirar": em vez de uma janela, a própria tabela pergunta, numa faixa embaixo da linha (Tirar usuário / Cancelar). */
  function askRemoveUser(r) {
    userConfirm = r.key;
    userNote.table = null;
    paintUserNotes();
    paint("users", true);
    refocus(`user-no-${r.key}`);
  }

  function cancelRemoveUser(r) {
    userConfirm = null;
    if (userNote.table && userNote.table.where === r.key) userNote.table = null;
    paint("users", true);
    refocus(`user-del-${r.key}`);
  }

  function removeAllowed(r, btn) {
    return userAct(btn, () => api("DELETE", `/web/api/allowed/${encodeURIComponent(r.email)}`), {
      before: () => {
        userConfirm = null;
      },
      after: () => {
        if (needSessions()) loadSessions(false);
      },
      ok: `${r.email} não está mais liberado.`,
      slot: "table",
      okAt: "table",
      errAt: r.key,
    });
  }

  function allowAgain(r, btn) {
    return userAct(btn, () => api("POST", "/web/api/allowed", { email: r.email }), { ok: allowedText(r.email), slot: "table", okAt: "table", errAt: r.key });
  }

  /** Uma linha da tabela (e, embaixo dela, a faixa de confirmação de "Tirar" ou o erro do último pedido da linha). */
  function userRow(r, mine) {
    const self = sameEmail(r.email, mine);
    const asking = userConfirm === r.key && r.role === "user";
    const err = userNote.table && userNote.table.where === r.key ? userNote.table.text : null;
    const role =
      r.role === "admin"
        ? h("span", { class: "badge on", text: ROLE_LABEL.admin })
        : r.role === "user"
          ? h("span", { class: "badge", text: ROLE_LABEL.user })
          : h("span", { class: "badge plain", text: ROLE_LABEL.gone, title: "Saiu da lista, mas os serviços que já conectou continuam" });
    const devs = r.devices.length
      ? h("span", null, h("b", { text: String(r.devices.length) }), h("span", { class: "muted", text: ` · ${r.devices.map(devName).join(", ")}` }))
      : h("span", { class: "muted", text: "nenhum" });
    let since;
    if (r.since) since = h("span", { text: fmtDay(r.since) });
    else if (r.role === "admin") since = h("span", { class: "muted", text: "definido no servidor" });
    else if (r.firstDevice) since = h("span", null, fmtDay(r.firstDevice), h("span", { class: "muted small", text: " (1º serviço)" }));
    else since = h("span", { class: "muted", text: "—" });
    let action;
    if (r.role === "admin") {
      action = h("span", { class: "muted small", text: "fixo" });
    } else if (r.role === "user") {
      action = asking
        ? h("span", { class: "muted small", text: "confirme abaixo" })
        : h("button", { type: "button", class: "danger subtle small", "data-k": `user-del-${r.key}`, text: "Tirar", "aria-label": `Tirar ${r.email}`, onclick: () => askRemoveUser(r) });
    } else {
      action = h("button", {
        type: "button",
        class: "secondary small",
        "data-k": `user-add-${r.key}`,
        text: "Liberar de novo",
        "aria-label": `Liberar ${r.email} de novo`,
        onclick: (e) => allowAgain(r, e.currentTarget),
      });
    }
    const sub = asking || err;
    const main = h(
      "tr",
      { class: [r.role === "gone" ? "gone" : null, sub ? "hassub" : null].filter(Boolean).join(" ") || null },
      h("th", { scope: "row", "data-label": "Usuário" }, h("span", { class: "email", text: r.email }), self ? h("span", { class: "tag on", text: "você" }) : null),
      h("td", { "data-label": "Situação" }, role),
      h("td", { "data-label": "Serviços" }, devs),
      h("td", { "data-label": "Desde" }, since),
      h("td", { class: "actions" }, action)
    );
    if (!sub) return [main];
    const box = h(
      "div",
      { class: "subin", role: asking ? "group" : null, "aria-label": asking ? `Tirar ${r.email}?` : null },
      h(
        "div",
        { class: "subtext" },
        asking
          ? h("p", null, h("b", { text: `Tirar ${r.email}?` }), " Ele não conecta mais serviços novos. Os que ele já conectou continuam funcionando; para cortar, desconecte-os em Serviços.")
          : null,
        err ? h("p", { class: "badtext", role: "alert", text: err }) : null
      ),
      asking
        ? h(
            "div",
            { class: "row gap wrap end" },
            h("button", { type: "button", class: "danger small", "data-k": `user-yes-${r.key}`, text: "Tirar usuário", onclick: (e) => removeAllowed(r, e.currentTarget) }),
            h("button", { type: "button", class: "secondary small", "data-k": `user-no-${r.key}`, text: "Cancelar", onclick: () => cancelRemoveUser(r) })
          )
        : null
    );
    const subRow = h("tr", { class: "subrow " + (asking ? "ask" : "error") }, h("td", { colspan: "5" }, box));
    if (asking) {
      subRow.addEventListener("keydown", (e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        cancelRemoveUser(r);
      });
    }
    return [main, subRow];
  }

  /**
   * Tabela de usuários: e-mail, situação (Administrador / Liberado / Não liberado), serviços conectados (quantos e
   * quais), desde quando e as ações que o servidor tem (Tirar, com confirmação na própria tabela; Liberar de
   * novo). A busca da aba filtra as linhas; os cabeçalhos Usuário, Situação e Serviços ordenam.
   */
  function renderUsers(box) {
    const mine = myEmail();
    const all = userRows();
    const note = $("usersNote");
    paintUserSort();
    if (userConfirm && !all.some((r) => r.key === userConfirm && r.role === "user")) userConfirm = null;
    const tn = userNote.table;
    if (tn && tn.where !== "table" && !all.some((r) => r.key === tn.where)) {
      tn.where = "table"; // a linha saiu da tabela: a mensagem sobe para o alto dela
      paintUserNotes();
    }
    if (!all.length) {
      paintSearch("usuarios", 0, 0);
      box.replaceChildren(h("tr", null, h("td", { colspan: "5", class: "empty", text: "Nenhum usuário ainda." })));
      note.classList.add("hidden");
      return;
    }
    const rows = sortUsers(searchFilter("usuarios", all, (r) => userWords(r, sameEmail(r.email, mine))));
    paintSearch("usuarios", rows.length, all.length);
    if (rows.length) box.replaceChildren(...rows.flatMap((r) => userRow(r, mine)));
    else box.replaceChildren(h("tr", { class: "nonerow" }, h("td", { colspan: "5" }, h("div", { class: "emptystate" }, noResults("usuarios", "cada usuário (e-mail, situação e os serviços que ele conectou)")))));
    const parts = [];
    if (!all.some((r) => r.since) && all.some((r) => r.role !== "admin")) parts.push(`A data em que cada usuário foi liberado fica ${SOON}; por enquanto aparece quando ele conectou o primeiro serviço.`);
    if (all.some((r) => r.role === "gone")) parts.push("“Não liberado”: saiu da lista, mas os serviços que já conectou continuam funcionando (desconecte-os em Serviços para cortar).");
    note.textContent = parts.join(" ");
    note.classList.toggle("hidden", !parts.length);
  }

  /** Formulário "Liberar um usuário": o erro (do campo ou do servidor) e o resultado aparecem embaixo do campo. */
  async function addAllowed(e) {
    e.preventDefault();
    const input = $("allowEmail");
    const email = input.value.trim().toLowerCase();
    const invalid = (text) => {
      input.setAttribute("aria-invalid", "true");
      input.focus();
      setUserNote("form", { kind: "error", text });
    };
    if (!email) return invalid("Digite o e-mail da conta Google que você quer liberar.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return invalid("Esse e-mail não parece válido. Use o formato pessoa@gmail.com.");
    input.removeAttribute("aria-invalid");
    if (isAdminEmail(email)) {
      return setUserNote("form", { kind: "ok", text: "Essa é a conta do administrador: ela já conecta serviços e entra no painel, sem precisar estar na lista." });
    }
    if (allowedList().some((x) => sameEmail(x, email))) return setUserNote("form", { kind: "ok", text: "Esse usuário já está liberado." });
    const ok = await userAct($("btnAllow"), () => api("POST", "/web/api/allowed", { email }), { ok: allowedText(email), slot: "form" });
    if (ok) input.value = "";
    else if (userNote.form && userNote.form.status === 400) input.setAttribute("aria-invalid", "true"); // o servidor recusou o e-mail
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
        ? "O login com Google está desligado no servidor: ninguém consegue entrar de novo no painel nem conectar serviços com Google. Ainda dá para conectar um serviço com o código de conexão (na aba Serviços)."
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

  // Histórico paginado: 10 por página (pedido do dono). A página atual é mantida quando chegam eventos novos.
  const HIST_PAGE_SIZE = 10;
  let histPage = 0;

  function renderHistory(box) {
    const all = Array.isArray(S.history) ? S.history : [];
    const pages = Math.max(1, Math.ceil(all.length / HIST_PAGE_SIZE));
    histPage = Math.min(Math.max(0, histPage), pages - 1);
    const items = all.slice(histPage * HIST_PAGE_SIZE, (histPage + 1) * HIST_PAGE_SIZE);
    const pager = $("histPager");
    if (pager) {
      pager.hidden = all.length <= HIST_PAGE_SIZE;
      $("histPage").textContent = `página ${histPage + 1} de ${pages} · ${all.length} eventos`;
      $("histPrev").disabled = histPage === 0;
      $("histNext").disabled = histPage >= pages - 1;
    }
    if (!items.length) {
      box.replaceChildren(h("li", { class: "empty", text: "Nada por aqui ainda. Trocas de conta, logins e avisos aparecem nesta lista." }));
      return;
    }
    const byId = new Map(devices().map((d) => [d.id, d.name]));
    box.replaceChildren(
      ...items.map((it) => {
        const kind = String(it.kind || "info");
        const dn = it.deviceName || (it.device ? byId.get(it.device) || "serviço removido" : null);
        const iso = isoOf(it.ts);
        return h(
          "li",
          null,
          h("time", { class: "when", datetime: iso, text: fmtWhen(it.ts) || "—" }),
          h("span", { class: "kind " + kind.replace(/[^a-z_-]/gi, ""), text: KIND_LABELS[kind] || kind }),
          dn
            ? h("span", { class: "who", text: dn })
            : h("span", { class: "who" }, h("span", { "aria-hidden": "true", text: "—" }), h("span", { class: "visually-hidden", text: "sem serviço" })),
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
    if (currentSec === "usuarios" && sec !== "usuarios" && (userConfirm || userNote.table)) {
      // saiu de Usuários: a pergunta "Tirar?" e a mensagem da tabela não ficam esperando
      userConfirm = null;
      setUserNote("table", null);
    }
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

  const hasUnsaved = () => rulesDirty || acctDraft.size > 0 || ownTimers.size > 0 || [...devRename.entries()].some(([id, v]) => v.trim() !== ((devById(id) || {}).name || ""));

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
    wireSearch();
    wireDrawer("accountDlg", "accountClose");
    wireDrawer("historyDlg", "historyClose");

    $("btnRetry").addEventListener("click", boot);
    $("btnRefresh").addEventListener("click", () => loadState("button"));
    $("btnAccount").addEventListener("click", (e) => openDrawer("accountDlg", e.currentTarget));
    $("btnHistory").addEventListener("click", (e) => openDrawer("historyDlg", e.currentTarget));
    $("histPrev").addEventListener("click", () => { histPage -= 1; renderHistory($("history")); });
    $("histNext").addEventListener("click", () => { histPage += 1; renderHistory($("history")); });
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
    $("allowEmail").addEventListener("input", () => {
      $("allowEmail").removeAttribute("aria-invalid");
      if (userNote.form) setUserNote("form", null); // a mensagem era sobre o que estava no campo
    });
    for (const b of document.querySelectorAll(".utable .thsort")) b.addEventListener("click", () => sortUsersBy(b.closest("th").getAttribute("data-sort")));
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
