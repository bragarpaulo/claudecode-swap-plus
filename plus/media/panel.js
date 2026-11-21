(function () {
  "use strict";
  // Tela "Swap Plus — Configurações": só o que é deste VS Code — ligar/desligar, conexão, conta em uso,
  // trocar de conta, avisos, exibição e atualizações. Regras de troca, ajustes das contas, usuários, os
  // outros serviços e o histórico ficam no painel do Swap (no navegador).
  //
  // A tela manda:  ready · setEnabled {enabled} · connectServer {method} · disconnectServer ·
  //                useServerAccount · switch {number} · saveAlerts {alerts} · ui {key, value} ·
  //                checkUpdates · openPanel
  // A tela recebe: state (o estado inteiro, a cada ciclo) · toast {text, kind} · busy {on, text}
  //
  // Qualquer campo do estado pode faltar (desligado, sem conexão, erro, servidor antigo): normalize()
  // confere tudo antes de desenhar, e um erro ao desenhar vira um aviso curto — nunca uma tela em branco.

  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);

  let S = null; // último estado vindo da extensão, já conferido por normalize()
  let toastTimer = null;
  let recheckTimer = null;
  let switching = null; // { number, until, fetchedAt }: troca pedida daqui, esperando o estado novo

  const MASTER_HOLD_MS = 20000; // desligar espera o ciclo em andamento terminar
  const SETTING_HOLD_MS = 4000;
  const DRAG_HOLD_MS = 60000;
  const ALERT_DEBOUNCE_MS = 350;
  const SWITCH_WAIT_MS = 6000;

  // ------------------------------------------------------------ utilitários

  /** Botão que não pode agir agora: desabilitado de vez, ou só parado por um instante (aria-disabled, que não tira o foco do teclado). */
  const inert = (el) => el.disabled || el.getAttribute("aria-disabled") === "true";

  /** Clique que só vale com o botão habilitado (um clique forçado num botão parado não manda nada). */
  function onClick(el, fn) {
    el.addEventListener("click", (ev) => {
      if (!inert(el)) fn(ev);
    });
  }

  function h(tag, props, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === "checked" || k === "disabled") e[k] = !!v;
      else if (v === undefined || v === null || v === false) continue;
      else if (k === "class") e.className = v;
      else if (k === "text") e.textContent = v;
      else if (k === "value") e.value = v;
      else if (k === "onclick") onClick(e, v);
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    }
    for (const c of kids.flat()) {
      if (c === null || c === undefined || c === false) continue;
      e.append(c instanceof Node ? c : String(c));
    }
    return e;
  }

  const send = (msg) => vscode.postMessage(msg);
  const clamp = (v) => Math.max(0, Math.min(100, Number(v) || 0));
  const fmt = (v) => String(Math.round(Number(v) * 10) / 10).replace(".", ",");
  const sevClass = (lv) => (lv === "bad" ? "bad" : lv === "warn" ? "warn" : "");

  const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
  const obj = (v) => (isObj(v) ? v : {});
  const arr = (v) => (Array.isArray(v) ? v : []);
  const str = (v) => (typeof v === "string" ? v : typeof v === "number" && isFinite(v) ? String(v) : "");
  const num = (v) => (typeof v === "number" && isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && isFinite(Number(v)) ? Number(v) : null);
  const bool = (v) => (typeof v === "boolean" ? v : null);

  /** Frase vinda da extensão: primeira letra maiúscula e ponto no fim. */
  function sentence(s) {
    const t = str(s).trim();
    if (!t) return "";
    const up = t.charAt(0).toUpperCase() + t.slice(1);
    return /[.!?…]$/.test(up) ? up : up + ".";
  }

  function toast(text, kind) {
    const t = $("toast");
    t.textContent = str(text);
    t.className = "toast" + (kind === "error" ? " error" : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add("hidden"), kind === "error" ? 9000 : 4500);
  }

  // O que a tela lembra entre uma abertura e outra da aba (API de estado do webview).
  function viewState() {
    try {
      return obj(vscode.getState());
    } catch {
      return {};
    }
  }

  function saveViewState(patch) {
    try {
      vscode.setState({ ...viewState(), ...patch });
    } catch {}
  }

  // ------------------------------------------------------------ estado conferido

  /** Janela de uso (sessão, semanal, modelo) ou null se não veio. */
  function win(w) {
    if (!isObj(w)) return null;
    const pct = num(w.pct);
    if (pct === null) return null;
    return { pct, in: str(w.in), when: str(w.when), resetTs: num(w.resetTs), level: str(w.level), idle: w.idle === true };
  }

  function account(a) {
    if (!isObj(a)) return null;
    const number = num(a.number);
    if (number === null) return null;
    return {
      number,
      email: str(a.email),
      alias: str(a.alias),
      org: str(a.org),
      plan: str(a.plan),
      active: a.active === true,
      status: str(a.status),
      statusLabel: str(a.statusLabel),
      loginDead: a.loginDead === true,
      stale: a.stale === true,
      ageMin: num(a.ageMin),
      session: win(a.session),
      weekly: win(a.weekly),
      models: arr(a.models)
        .map((m) => {
          const w = win(m);
          return w ? { ...w, name: str(m.name) || "Modelo" } : null;
        })
        .filter(Boolean),
      disabled: a.disabled === true, // fora da troca automática
      // O estado de hoje não diz quais contas estão liberadas para este serviço; se um dia disser, a conta
      // não liberada aparece desabilitada com o motivo (em vez de falhar no clique).
      allowed: a.allowed !== false,
      devices: arr(a.devices).map(str).filter(Boolean),
    };
  }

  function normalize(m) {
    const sv = obj(m.server);
    const al = obj(m.alerts);
    const ui = obj(m.ui);
    return {
      error: str(m.error),
      swapOn: m.swapOn !== false,
      privacy: bool(m.privacy),
      fetchedAt: num(m.fetchedAt),
      accounts: arr(m.accounts).map(account).filter(Boolean),
      modelNames: arr(m.modelNames).map(str).filter(Boolean),
      autoOn: obj(m.auto).enabled === true,
      together: obj(m.rules).devicePlacement === "together",
      alerts: {
        fiveHourEnabled: bool(al.fiveHourEnabled),
        fiveHourPct: num(al.fiveHourPct),
        weeklyEnabled: bool(al.weeklyEnabled),
        weeklyPct: num(al.weeklyPct),
        modelEnabled: bool(al.modelEnabled),
        modelPct: num(al.modelPct),
      },
      ui: { showAccountNumber: bool(ui.showAccountNumber), showModelWeekly: bool(ui.showModelWeekly) },
      updates: isObj(m.updates) ? m.updates : null,
      server: {
        status: str(sv.status),
        statusText: str(sv.statusText),
        connected: sv.connected === true,
        connecting: sv.connecting === true,
        host: str(sv.host),
        via: str(sv.via),
        deviceName: str(sv.deviceName),
        myGoogle: str(sv.myGoogle),
        lastOkWhen: str(sv.lastOkWhen),
        devices: arr(sv.devices)
          .filter(isObj)
          .map((d) => ({ current: d.current === true, name: str(d.name) })),
        rejected: isObj(sv.rejected) ? { reason: str(sv.rejected.reason) } : null,
        canUploadLogins: sv.canUploadLogins !== false,
        addressChanged: sv.addressChanged === true,
        storeWarnings: arr(sv.storeWarnings).map(str).filter(Boolean),
        storeBlocked: sv.storeBlocked === true,
        loginPromptOff: sv.loginPromptOff === true,
        loginPromptNote: str(sv.loginPromptNote),
        otherWindow: sv.otherWindow === true,
      },
    };
  }

  // ------------------------------------------------------------ mudança feita aqui, esperando a extensão
  //
  // A tela mostra o valor que a pessoa acabou de pôr até o estado trazer o mesmo valor; se o prazo
  // acabar sem confirmação (ou a extensão avisar um erro), volta ao que está gravado de verdade.

  const pend = new Map(); // chave → { value, until }

  function pendSet(key, value, ms) {
    pend.set(key, { value, until: Date.now() + ms });
  }

  function shown(key, real) {
    const p = pend.get(key);
    if (!p) return real;
    if (p.value === real || Date.now() >= p.until) {
      pend.delete(key);
      return real;
    }
    return p.value;
  }

  // Parte da tela que não mudou desde o último desenho não é refeita: o foco do teclado, o texto
  // selecionado e as dicas abertas ficam como estão quando chega um estado igual ao anterior.
  const lastSig = {};

  function same(part, data) {
    const sig = JSON.stringify(data);
    if (lastSig[part] === sig) return true;
    lastSig[part] = sig;
    return false;
  }

  /** Marca um redesenho para quando o primeiro prazo acabar. */
  function scheduleRecheck() {
    clearTimeout(recheckTimer);
    recheckTimer = null;
    const now = Date.now();
    let next = Infinity;
    for (const [k, p] of pend) {
      if (p.until <= now) pend.delete(k);
      else next = Math.min(next, p.until);
    }
    if (switching) next = Math.min(next, switching.until);
    if (next === Infinity) return;
    recheckTimer = setTimeout(() => {
      recheckTimer = null;
      if (S) renderAll();
    }, Math.max(0, next - now) + 60);
  }

  // ------------------------------------------------------------ liga/desliga

  function renderMaster() {
    const real = S.swapOn;
    const want = shown("master", real);
    const box = $("masterToggle");
    box.disabled = false;
    box.checked = want;
    const st = $("masterState");
    st.textContent = want !== real ? (want ? "Ligando…" : "Desligando…") : real ? "Ligado" : "Desligado";
    st.className = "masterstate" + (want === real && real ? " on" : "");
  }

  // ------------------------------------------------------------ conexão

  const KNOWN_STATUS = ["off", "disconnected", "connecting", "online", "offline", "revoked"];

  /** Situação da conexão: { tone, title, tail (na mesma linha), text (frase embaixo) }. */
  function connView(sv, on) {
    const host = sv.host;
    const at = host ? ` a ${host}` : "";
    if (!on || sv.status === "off") {
      return { tone: "", title: "Desligado", tail: "", text: "Sem contato com o servidor e sem trocar de conta: o Claude Code segue com o acesso que tem agora." };
    }
    switch (sv.status) {
      case "online":
        return { tone: "on", title: "Conectado", tail: at, text: "" };
      case "connecting":
        return { tone: "", title: "Conectando…", tail: "", text: host ? `Falando com ${host}.` : "" };
      case "offline":
        return {
          tone: "bad",
          title: "Servidor fora do ar",
          tail: "",
          text: `${sentence(sv.statusText) || "Sem resposta do servidor."} O Swap Plus tenta de novo sozinho a cada 30 segundos.`,
        };
      case "revoked":
        return {
          tone: "bad",
          title: "Acesso recusado",
          tail: "",
          text: "O servidor recusou este VS Code (o acesso foi revogado ou ele foi desconectado por lá). Entre de novo: com Google ou com um código novo.",
        };
      case "disconnected":
        if (sv.addressChanged) return { tone: "warn", title: "Não conectado", tail: "", text: sentence(sv.statusText) || "O endereço do servidor mudou. Entre de novo." };
        return { tone: "warn", title: "Não conectado", tail: "", text: `Este VS Code ainda não está conectado${at}. Entre com Google para usar as contas do servidor.` };
      default:
        return { tone: "", title: "Carregando…", tail: "", text: "" };
    }
  }

  function connectButtons(sv) {
    // Conexão em andamento (o navegador abriu): os botões ficam parados, sem perder o foco do teclado.
    const busy = sv.connecting ? "true" : null;
    return [
      h("button", {
        type: "button",
        "data-fk": "conn:google",
        text: busy ? "Conectando…" : "Entrar com Google",
        title: `Abre o navegador para você entrar com a sua conta Google${sv.host ? ` em ${sv.host}` : ""}. O dono do servidor precisa ter liberado essa conta.`,
        "aria-disabled": busy,
        onclick: () => send({ type: "connectServer", method: "google" }),
      }),
      h("button", {
        type: "button",
        class: "secondary",
        "data-fk": "conn:code",
        text: "Colar código",
        title: "Colar o código de conexão (swapplus1:…) gerado no painel do Swap",
        "aria-disabled": busy,
        onclick: () => send({ type: "connectServer", method: "code" }),
      }),
      h("button", {
        type: "button",
        class: "linkbtn",
        "data-fk": "conn:other",
        text: "Outro endereço…",
        title: "Entrar com Google em outro servidor Swap Plus",
        "aria-disabled": busy,
        onclick: () => send({ type: "connectServer", method: "googleOther" }),
      }),
    ];
  }

  function renderConn() {
    const sv = S.server;
    if (same("conn", [sv, S.swapOn, S.error])) return;
    const v = connView(sv, S.swapOn);
    // Com acesso guardado mas recusado, ou com o endereço mudado: entrar de novo (ou sair de vez).
    const reconnect = sv.status === "revoked" || (sv.status === "disconnected" && sv.addressChanged);
    const needLogin = !sv.connected || reconnect;

    $("connStatus").replaceChildren(
      h("span", { class: "dot" + (v.tone ? ` ${v.tone}` : ""), "aria-hidden": "true" }),
      h("b", { text: v.title }),
      v.tail
    );

    // Uma linha: nome deste serviço no servidor, com que conta entrou e o último contato.
    const facts = [];
    if (sv.connected) {
      if (sv.deviceName) facts.push(["Este serviço: ", h("b", { text: sv.deviceName })]);
      if (sv.myGoogle) facts.push(["entrou com ", h("span", { class: "mail", text: sv.myGoogle })]);
      else if (sv.via === "code") facts.push(["entrou com código de conexão"]);
      facts.push([`último contato: ${sv.lastOkWhen || "ainda não houve"}`]);
    }
    const fbox = $("connFacts");
    fbox.replaceChildren(...facts.map((f) => h("span", { class: "fact" }, f)));
    fbox.classList.toggle("hidden", !facts.length);

    $("connTop").replaceChildren(
      ...(sv.connected
        ? [h("button", { type: "button", class: "secondary", "data-fk": "conn:out", text: "Sair", title: "Desconectar este VS Code do servidor", onclick: () => send({ type: "disconnectServer" }) })]
        : [])
    );

    const kids = [];
    if (v.text) kids.push(h("p", { class: "conntext", text: v.text }));

    if (needLogin) {
      kids.push(h("div", { class: "btnrow connect" }, connectButtons(sv)));
      kids.push(
        h(
          "p",
          { class: "muted small" },
          h("b", { text: "Entrar com Google: " }),
          "o navegador abre e você entra com a sua conta Google (o dono do servidor precisa ter liberado essa conta). ",
          h("b", { text: "Colar código: " }),
          "o código de conexão que o administrador gera no painel do Swap, em “Conectar um serviço”; vale 10 minutos e uma vez só."
        )
      );
    }

    // Erro que a situação acima não explica (não deveria acontecer): aparece inteiro, não some.
    if (S.error && (!S.swapOn || sv.status === "online" || !KNOWN_STATUS.includes(sv.status))) {
      kids.push(h("div", { class: "srvwarn bad" }, S.error));
    }

    // Onde o Claude Code lê o login (ex.: Windows com o Gerenciador de Credenciais, variável de ambiente que passa na frente).
    for (const w of sv.storeWarnings) {
      kids.push(
        h(
          "div",
          { class: "srvwarn" },
          h("span", null, h("b", { text: sv.storeBlocked && /Gerenciador de Credenciais/.test(w) ? "O Swap Plus não está gravando o login neste computador: " : "Atenção: " }), w)
        )
      );
    }

    if (sv.rejected) {
      kids.push(
        h(
          "div",
          { class: "srvwarn" },
          h("span", null, h("b", { text: "Login do Claude Code recusado pelo servidor: " }), `${sv.rejected.reason || "sem detalhe"}. Esse login fica como está; o envio é tentado de novo em 10 min.`),
          h("button", { type: "button", "data-fk": "conn:useServer", text: "Usar a conta do servidor", onclick: () => send({ type: "useServerAccount" }) })
        )
      );
    }

    if (sv.loginPromptOff) {
      kids.push(
        h("p", {
          class: "muted small",
          text: `${sv.loginPromptNote || "Enquanto este computador estiver conectado ao servidor, o login do Claude Code é feito pelo Swap Plus"}: a tela de login do Claude Code fica desligada (claudeCode.disableLoginPrompt) e volta como estava ao sair ou desligar o Swap Plus.`,
        })
      );
    }

    if (sv.otherWindow) {
      kids.push(h("p", { class: "muted small", text: "Outra janela do VS Code está cuidando do login deste computador (batimento e gravação); esta janela só mostra o estado." }));
    }

    $("connBox").replaceChildren(...kids);
  }

  // ------------------------------------------------------------ conta em uso e troca de conta

  function meter(label, w) {
    if (!w) return h("div", { class: "meter" }, h("span", { class: "lbl", text: label }), h("div", { class: "bar" }), h("span", { class: "pct muted", text: "—" }));
    const fill = h("div", { class: "fill " + sevClass(w.level) });
    fill.style.width = clamp(w.pct) + "%";
    return h(
      "div",
      { class: "meter" },
      h("span", { class: "lbl", text: label }),
      h("div", { class: "bar", role: "meter", "aria-label": label, "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(clamp(w.pct)) }, fill),
      h("span", { class: "pct " + sevClass(w.level), text: fmt(w.pct) + "%" }),
      w.in ? h("span", { class: "reset", text: `renova em ${w.in}${w.when ? ` · ${w.when}` : ""}` }) : w.idle ? h("span", { class: "reset", text: "sem uso nas últimas 5h" }) : null
    );
  }

  /** Nome deste VS Code como o servidor o conhece (é o nome que aparece em a.devices). */
  function myServiceName() {
    const sv = S.server;
    const me = sv.devices.find((d) => d.current);
    return (me && me.name) || sv.deviceName || null;
  }

  /** Os outros serviços que estão usando a conta agora (na conta em uso aqui, sem este VS Code). */
  function othersUsing(a) {
    const others = [...a.devices];
    if (a.active) {
      // A lista do servidor traz este VS Code também: tira o nome dele uma vez
      // (outro serviço com o mesmo nome continua aparecendo).
      const i = others.indexOf(myServiceName());
      if (i >= 0) others.splice(i, 1);
    }
    return others;
  }

  /** Motivo para a conta não poder ser usada aqui ({ tag, text }), ou null. */
  function blockReason(a) {
    if (a.loginDead) {
      return {
        tag: "Login morto",
        text: S.server.canUploadLogins
          ? "Login morto: é preciso entrar de novo com esta conta (no painel do Swap, ou com /login no Claude Code daqui)."
          : "Login morto: o administrador precisa entrar de novo com esta conta, no painel do Swap.",
      };
    }
    if (!a.allowed) {
      return { tag: "Não liberada", text: "Não liberada para este serviço: o administrador libera no painel do Swap, em “Serviços permitidos”." };
    }
    // Com a troca automática ligada, o servidor tira na hora qualquer serviço de uma conta fora da troca.
    if (a.disabled && S.autoOn) {
      return {
        tag: "Fora da troca",
        text: "Fora da troca: com a troca automática ligada, o servidor não deixa nenhum serviço nela. Para usar, ligue “Participa da troca” nesta conta, no painel do Swap.",
      };
    }
    return null;
  }

  /** Motivo geral para não dar para trocar agora, ou null. */
  function switchBlock() {
    const st = S.server.status;
    if (st === "online") return null;
    if (st === "offline") return "Sem resposta do servidor agora: dá para trocar de conta de novo quando a conexão voltar. Os números abaixo são os últimos recebidos.";
    if (st === "connecting") return "Conectando ao servidor: a troca de conta volta em instantes.";
    return "Este VS Code não está conectado: entre de novo no cartão “Conexão” para trocar de conta.";
  }

  function askSwitch(a) {
    if (!S || switching || blockReason(a) || switchBlock()) return;
    switching = { number: a.number, until: Date.now() + SWITCH_WAIT_MS, fetchedAt: S.fetchedAt };
    send({ type: "switch", number: a.number });
    renderAll();
  }

  function usageTitle(a) {
    const line = (label, w) => `${label}: ${fmt(w.pct)}%${w.in ? ` — renova em ${w.in}${w.when ? ` (${w.when})` : ""}` : w.idle ? " — sem uso nas últimas 5h" : ""}`;
    const out = [];
    if (a.session) out.push(line("Sessão de 5h", a.session));
    if (a.weekly) out.push(line("Semanal", a.weekly));
    for (const m of a.models) out.push(line(m.name, m));
    return out.join("\n") || null;
  }

  /** Etiquetas da situação da conta (login morto, uso indisponível, dados antigos). */
  function statusBadges(a) {
    return [
      a.loginDead
        ? h("span", { class: "badge dead", text: "Login morto" })
        : a.status && a.status !== "ok" && a.statusLabel
          ? h("span", { class: "badge plain", text: a.statusLabel })
          : null,
      a.stale && a.ageMin !== null
        ? h("span", { class: "badge plain", title: "O servidor atualiza cada conta de alguns em alguns minutos (a Anthropic limita as consultas).", text: `dados de ${a.ageMin} min` })
        : null,
    ];
  }

  function accountName(a) {
    return [
      h("span", { class: "n", text: `Conta ${a.number}` }),
      a.alias ? h("span", { class: "alias", text: `“${a.alias}”` }) : null,
      a.email ? h("span", { class: "mail", text: a.email }) : null,
    ];
  }

  function activeCard(a) {
    const others = othersUsing(a);
    const why = a.loginDead ? blockReason(a) : null;
    return [
      h("div", { class: "nowhead" }, h("div", { class: "nowname" }, accountName(a)), h("div", { class: "badges" }, statusBadges(a))),
      a.plan || a.org ? h("div", { class: "sub", text: [a.plan, a.org].filter(Boolean).join(" · ") }) : null,
      h("div", { class: "meters" }, meter("Sessão 5h", a.session), meter("Semanal", a.weekly), a.models.map((m) => meter(m.name, m))),
      why ? h("p", { class: "why", text: why.text }) : null,
      others.length ? h("p", { class: "muted small", text: `Também em uso em: ${others.join(", ")}` }) : null,
    ].filter(Boolean);
  }

  function accountRow(a, blockAll) {
    const why = blockReason(a);
    const off = !!why || blockAll;
    const mine = !!switching && switching.number === a.number;
    const others = othersUsing(a);
    const bit = (label, w) => h("span", { class: "ubit" }, `${label} `, h("b", { class: "pct " + sevClass(w.level), text: fmt(w.pct) + "%" }));
    const bits = [a.session ? bit("5h", a.session) : null, a.weekly ? bit("semana", a.weekly) : null, ...a.models.map((m) => bit(m.name, m))].filter(Boolean);
    const whyId = `why-${a.number}`;
    return h(
      "li",
      { class: "arow" + (why ? " blocked" : ""), "data-n": String(a.number) },
      h("div", { class: "rname" }, accountName(a)),
      h(
        "div",
        { class: "rsum", title: usageTitle(a) },
        why && a.loginDead ? null : bits.length ? h("span", { class: "ubits" }, bits) : null,
        why ? null : statusBadges(a),
        !why && !bits.length && !(a.status && a.status !== "ok" && a.statusLabel) ? h("span", { class: "muted", text: "sem leitura de uso" }) : null,
        !why && a.disabled ? h("span", { class: "badge plain", title: "A troca automática não usa esta conta. Com ela desligada, dá para usar à mão.", text: "fora da troca" }) : null,
        others.length ? h("span", { class: "badge plain", title: "Serviços que estão usando esta conta agora", text: `em uso em: ${others.join(", ")}` }) : null,
        why ? h("span", { class: "why", id: whyId, text: why.text }) : null
      ),
      h("button", {
        type: "button",
        class: "secondary" + (mine ? " busybtn" : ""),
        "data-fk": `acct:${a.number}`,
        "aria-label": `${mine ? "Trocando" : "Usar esta conta"}: Conta ${a.number}${a.alias ? ` “${a.alias}”` : ""}`,
        "aria-describedby": why ? whyId : null,
        "aria-disabled": !off && switching ? "true" : null,
        disabled: off,
        text: mine ? "Trocando…" : "Usar esta conta",
        onclick: () => askSwitch(a),
      })
    );
  }

  /** Quem dá para usar primeiro (quem renova o semanal antes na frente); no fim, as que não dá para usar. */
  function orderForSwitch(list) {
    const reset = (a) => (a.weekly && a.weekly.resetTs ? a.weekly.resetTs : Infinity);
    const rank = (a) => (blockReason(a) ? 2 : a.disabled ? 1 : 0);
    return [...list].sort((a, b) => rank(a) - rank(b) || reset(a) - reset(b) || (a.weekly ? a.weekly.pct : 100) - (b.weekly ? b.weekly.pct : 100) || a.number - b.number);
  }

  function renderAccounts() {
    const sv = S.server;
    const act = S.accounts.find((a) => a.active) || null;
    // A troca pedida daqui terminou: a conta virou a em uso, chegou um estado novo do servidor, ou o prazo acabou.
    if (switching && ((act && act.number === switching.number) || S.fetchedAt !== switching.fetchedAt || Date.now() >= switching.until)) switching = null;
    if (same("acct", [S.accounts, sv.status, sv.connected, sv.canUploadLogins, sv.devices, sv.deviceName, S.swapOn, S.autoOn, S.together, switching && switching.number])) return;

    const now = $("acctNow");
    const wrap = $("switchWrap");
    const msg = (text) => h("p", { class: "muted", text });

    if (!S.swapOn) {
      now.replaceChildren(msg("O Swap Plus está desligado neste VS Code: nenhuma conta é trocada e o Claude Code segue com o acesso que tem agora. Ligue no interruptor lá em cima para ver a conta em uso e trocar de conta."));
      wrap.classList.add("hidden");
      return;
    }

    if (!S.accounts.length) {
      now.replaceChildren(
        msg(
          !sv.connected || sv.status === "disconnected" || sv.status === "revoked"
            ? "Entre no cartão “Conexão”, acima, para ver a conta em uso e trocar de conta."
            : sv.status === "online"
              ? `Nenhuma conta no servidor ainda. ${sv.canUploadLogins ? "As contas são adicionadas no painel do Swap." : "Quem adiciona as contas é o administrador, no painel do Swap."}`
              : sv.status === "offline"
                ? "Sem resposta do servidor: a conta em uso aparece aqui quando a conexão voltar."
                : "Esperando a lista de contas do servidor…"
        )
      );
      wrap.classList.add("hidden");
      return;
    }

    const others = orderForSwitch(S.accounts.filter((a) => a !== act));
    const autoLine = h(
      "p",
      { class: "autoline" },
      "Troca automática: ",
      h("b", { text: S.autoOn ? "ligada" : "desligada" }),
      h("span", { class: "muted", text: " — muda-se no painel do Swap" })
    );
    now.replaceChildren(
      ...(act ? activeCard(act) : [msg(`O servidor ainda não escolheu uma conta para este VS Code.${others.length ? " Escolha uma em “Trocar de conta”, abaixo." : ""}`)]),
      autoLine
    );

    const block = switchBlock();
    $("switchNotes").replaceChildren(
      ...[
        S.together ? h("p", { class: "note", text: "Neste Swap os serviços andam juntos: trocar aqui troca também nos outros que estão em uso." }) : null,
        block ? h("p", { class: "note warn", text: block }) : null,
      ].filter(Boolean)
    );
    const list = $("acctList");
    list.classList.toggle("waiting", !!switching);
    list.replaceChildren(...others.map((a) => accountRow(a, !!block)));
    wrap.classList.toggle("hidden", !others.length);
  }

  // ------------------------------------------------------------ mais opções deste VS Code

  const ALERT_ROWS = [
    { on: "fiveHourEnabled", pct: "fiveHourPct", box: $("alFiveOn"), range: $("alFivePct"), val: $("alFiveVal") },
    { on: "weeklyEnabled", pct: "weeklyPct", box: $("alWeekOn"), range: $("alWeekPct"), val: $("alWeekVal") },
    { on: "modelEnabled", pct: "modelPct", box: $("alModelOn"), range: $("alModelPct"), val: $("alModelVal") },
  ];
  const alertTimers = {};

  /** Caixa de marcar ligada a um valor do estado; valor que não veio = caixa desabilitada (não inventa). */
  function syncBox(box, key, real) {
    if (real === null) {
      box.disabled = true;
      return false;
    }
    box.disabled = false;
    box.checked = shown(key, real);
    return box.checked;
  }

  function renderAlerts() {
    const al = S.alerts;
    for (const r of ALERT_ROWS) {
      const on = syncBox(r.box, `al:${r.on}`, al[r.on]);
      const real = al[r.pct];
      if (real === null) {
        r.range.disabled = true;
        r.val.textContent = "—";
      } else {
        const v = shown(`al:${r.pct}`, real);
        // O slider vai de 30 a 99; um valor gravado fora disso (posto à mão nas configurações do VS Code)
        // alarga a faixa em vez de ser cortado.
        r.range.min = String(Math.min(30, Math.floor(v)));
        r.range.max = String(Math.max(99, Math.ceil(v)));
        r.range.value = String(v);
        r.range.disabled = !on;
        r.range.setAttribute("aria-valuetext", `${fmt(v)}%`);
        r.val.textContent = `${fmt(v)}%`;
      }
      r.range.parentElement.classList.toggle("off", !on);
    }
    if (S.modelNames.length) $("alModelLabel").textContent = `Limite semanal do ${S.modelNames.join(" / ")}`;
  }

  /** Só o que mudou vai para a extensão (ela grava nas configurações deste VS Code; nada vai ao servidor). */
  function saveAlert(key, value) {
    pendSet(`al:${key}`, value, SETTING_HOLD_MS);
    send({ type: "saveAlerts", alerts: { [key]: value } });
    scheduleRecheck();
  }

  function flushAlert(r) {
    if (!alertTimers[r.pct]) return;
    clearTimeout(alertTimers[r.pct]);
    alertTimers[r.pct] = null;
    const v = Number(r.range.value);
    if (S && S.alerts[r.pct] === v) {
      pend.delete(`al:${r.pct}`); // voltou ao valor gravado: nada a salvar
      return;
    }
    saveAlert(r.pct, v);
  }

  const UI_BOXES = [
    { key: "privacy.hideEmails", box: $("uiPrivacy"), real: () => S.privacy },
    { key: "statusBar.showAccountNumber", box: $("uiAcctNumber"), real: () => S.ui.showAccountNumber },
    { key: "statusBar.showModelWeekly", box: $("uiModelWeekly"), real: () => S.ui.showModelWeekly },
  ];

  function renderUi() {
    for (const o of UI_BOXES) syncBox(o.box, `ui:${o.key}`, o.real());
  }

  const REASONS = { open: "ao abrir o VS Code", close: "ao fechar o VS Code", periodic: "verificação periódica", manual: "manual" };

  function newer(a, b) {
    const p = (s) => str(s).split(/[^\d]+/).filter(Boolean).slice(0, 3).map(Number);
    const x = p(a);
    const y = p(b);
    if (x.length < 3 || y.length < 3) return false;
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
    return false;
  }

  function renderUpdates() {
    const u = S.updates;
    if (same("upd", u)) return;
    const box = $("updBox");
    if (!u) return box.replaceChildren(h("p", { class: "muted small", text: "Atualizador indisponível." }));
    const L = isObj(u.last) ? u.last : null;
    const latest = L ? str(obj(L.ext).latest) : "";
    const installed = str(u.extInstalled);
    const hasNew = newer(latest, installed);
    box.replaceChildren(
      h(
        "p",
        null,
        "Versão instalada: ",
        h("b", { text: installed || "?" }),
        latest ? [" · última publicada: ", h("b", { class: hasNew ? "warntext" : "", text: latest }), hasNew ? " (há versão nova)" : ""] : null
      ),
      h("p", {
        class: "muted small",
        text: L ? `Última verificação: ${str(L.when) || str(L.ts) || "?"} (${REASONS[L.reason] || str(L.reason) || "?"})${L.error ? ` — erro: ${str(L.error)}` : ""}.` : "Ainda não verificou.",
      }),
      h("p", {
        class: "muted small",
        text: `${u.enabled === false ? "A verificação automática está desligada (swapPlus.updates.enabled); “Verificar agora” continua valendo." : "Verifica sozinha ao abrir e ao fechar o VS Code e a cada 2 dias."} ${
          u.autoUpdate ? "Versão nova é instalada sozinha, como nas outras extensões" : "Com o Auto Update de extensões do VS Code desligado, só avisa; “Verificar agora” instala"
        } e passa a valer depois de recarregar a janela.${u.pendingOnOpen ? " Há versão nova esperando a próxima abertura do VS Code." : ""}`,
      })
    );
  }

  // ------------------------------------------------------------ rodapé

  function renderFoot() {
    const connected = S.server.connected;
    $("btnPanel").disabled = !connected;
    $("footNote").textContent = connected
      ? "Só o administrador entra no painel."
      : "Só o administrador entra no painel. Ele abre no endereço da conexão: conecte este VS Code primeiro (cartão “Conexão”).";
  }

  // ------------------------------------------------------------ desenhar tudo

  const PARTS = [
    ["o liga/desliga", renderMaster],
    ["a conexão", renderConn],
    ["a conta em uso", renderAccounts],
    ["os avisos", renderAlerts],
    ["a exibição", renderUi],
    ["as atualizações", renderUpdates],
    ["o rodapé", renderFoot],
  ];

  function showProblem(what, e) {
    for (const k of Object.keys(lastSig)) delete lastSig[k]; // o próximo estado redesenha tudo
    const box = $("renderError");
    if (!box) return;
    box.textContent = `Não consegui desenhar ${what} nesta tela (${str(e && e.message) || "erro desconhecido"}). O Swap Plus continua funcionando: feche esta aba e abra de novo pelo comando “Swap Plus: Configurações”.`;
    box.classList.remove("hidden");
  }

  /** Redesenha a tela. Cada parte é independente: um erro numa delas vira um aviso e as outras continuam. */
  function renderAll() {
    const active = document.activeElement;
    const fk = active && active.getAttribute ? active.getAttribute("data-fk") : null;
    let failed = false;
    for (const [what, fn] of PARTS) {
      try {
        fn();
      } catch (e) {
        failed = true;
        showProblem(what, e);
      }
    }
    if (!failed) {
      const box = $("renderError");
      if (box && !box.classList.contains("hidden")) {
        box.classList.add("hidden");
        box.textContent = "";
      }
    }
    // O foco do teclado volta para o mesmo botão (os botões são recriados a cada estado). Depois de uma
    // troca, o botão da conta some da lista: o foco vai para o cartão da conta em uso.
    if (fk && document.activeElement !== active) {
      const again = [...document.querySelectorAll("[data-fk]")].find((el) => el.getAttribute("data-fk") === fk);
      if (again && !again.disabled) again.focus({ preventScroll: true });
      else if (fk.startsWith("acct:")) $("acctNow").focus({ preventScroll: true });
    }
    scheduleRecheck();
  }

  // ------------------------------------------------------------ eventos

  window.addEventListener("message", (ev) => {
    const m = ev.data;
    if (!isObj(m)) return;
    try {
      if (m.type === "state") {
        S = normalize(m);
        renderAll();
      } else if (m.type === "busy") {
        const b = $("busy");
        b.textContent = str(m.text);
        b.classList.toggle("hidden", !m.on);
      } else if (m.type === "toast") {
        // Um erro da extensão desfaz o "esperando confirmação": a tela volta ao que está gravado de verdade.
        if (m.kind === "error" && (pend.size || switching)) {
          pend.clear();
          switching = null;
          if (S) renderAll();
        }
        toast(m.text, m.kind);
      }
    } catch (e) {
      showProblem("o estado recebido", e);
    }
  });

  /** Liga os controles fixos da tela (os que já vêm no panel.html). */
  function wire() {
    $("masterToggle").addEventListener("change", (e) => {
      if (!S || e.target.disabled) return; // antes do primeiro estado não se sabe se está ligado
      const want = e.target.checked;
      pendSet("master", want, MASTER_HOLD_MS);
      send({ type: "setEnabled", enabled: want });
      renderAll();
    });

    for (const r of ALERT_ROWS) {
      r.box.addEventListener("change", () => {
        if (!S || r.box.disabled) return;
        saveAlert(r.on, r.box.checked);
        renderAll();
      });
      // Arrastando: o número acompanha, e um estado que chegar no meio não mexe no slider.
      r.range.addEventListener("input", () => {
        if (r.range.disabled) return;
        const v = Number(r.range.value);
        pendSet(`al:${r.pct}`, v, DRAG_HOLD_MS);
        r.val.textContent = `${fmt(v)}%`;
        r.range.setAttribute("aria-valuetext", `${fmt(v)}%`);
      });
      // Soltou (ou mexeu pelo teclado): salva depois de uma pausa curta, para as setas não gravarem a cada passo.
      r.range.addEventListener("change", () => {
        if (r.range.disabled) return;
        pendSet(`al:${r.pct}`, Number(r.range.value), DRAG_HOLD_MS);
        clearTimeout(alertTimers[r.pct]);
        alertTimers[r.pct] = setTimeout(() => flushAlert(r), ALERT_DEBOUNCE_MS);
      });
      r.range.addEventListener("blur", () => flushAlert(r));
    }
    window.addEventListener("pagehide", () => ALERT_ROWS.forEach(flushAlert));

    for (const o of UI_BOXES) {
      o.box.addEventListener("change", () => {
        if (!S || o.box.disabled) return;
        pendSet(`ui:${o.key}`, o.box.checked, SETTING_HOLD_MS);
        send({ type: "ui", key: o.key, value: o.box.checked });
        scheduleRecheck();
      });
    }

    onClick($("btnUpdates"), () => send({ type: "checkUpdates" }));
    // O endereço do painel nunca sai daqui: a extensão abre o endereço da própria conexão.
    onClick($("btnPanel"), () => send({ type: "openPanel" }));

    // "Mais opções" abre fechado e lembra como a pessoa deixou.
    const more = $("more");
    more.open = viewState().moreOpen === true;
    more.addEventListener("toggle", () => saveViewState({ moreOpen: more.open }));
  }

  // Erro num clique ou num temporizador: aviso curto, e a tela segue de pé.
  window.addEventListener("error", (ev) => {
    if (ev.error) showProblem("uma parte", ev.error);
  });

  try {
    wire();
  } catch (e) {
    showProblem("os controles", e);
  }

  send({ type: "ready" });
})();
