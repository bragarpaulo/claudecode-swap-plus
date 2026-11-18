(function () {
  "use strict";
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);

  let S = null; // último estado vindo da extensão
  let draft = null; // regras em edição (só valem depois de salvar)
  let rulesDirty = false;
  let acctHold = false; // usuário mexendo num card de conta: não redesenhar
  let acctPending = false;
  let toastTimer = null;

  const STRATS = [
    {
      id: "headroom",
      name: "Mais folga",
      desc: "Troca só quando a conta ativa chega numa linha de troca e vai para a conta com mais folga.",
    },
    {
      id: "max",
      name: "Aproveitar ao máximo",
      tag: "padrão · menos desperdício",
      desc: "Usa primeiro a conta cuja cota semanal zera antes. Também troca antes da linha quando outra conta está prestes a zerar com cota sobrando.",
    },
    {
      id: "priority",
      name: "Por prioridade",
      desc: "Segue a prioridade que você der a cada conta (número maior primeiro). Em empate, a que renova antes.",
    },
  ];

  const KIND_LABELS = {
    switch: "Troca automática",
    manual: "Troca manual",
    blocked: "Bloqueado",
    error: "Erro",
    warn: "Aviso",
    alert: "Alerta de uso",
    model: "Modelo padrão",
    info: "Info",
    // eventos do servidor
    assign: "Atribuição",
    login: "Login",
    dead: "Login morto",
    refresh: "Renovação",
    device: "Computador",
  };

  // ------------------------------------------------------------ utilitários

  function h(tag, props, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === "checked" || k === "disabled") e[k] = !!v;
      else if (v === undefined || v === null || v === false) continue;
      else if (k === "class") e.className = v;
      else if (k === "text") e.textContent = v;
      else if (k === "value") e.value = v;
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
  const sevOf = (pct, line) => (pct >= line ? "bad" : pct >= Math.min(70, line) ? "warn" : "");

  function toast(text, kind) {
    const t = $("toast");
    t.textContent = text;
    t.className = "toast" + (kind === "error" ? " error" : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add("hidden"), kind === "error" ? 9000 : 4500);
  }

  function activeAccount() {
    return S ? S.accounts.find((a) => a.active) : null;
  }

  function draftFromState() {
    return { ...S.rules, alerts: { ...S.alerts } };
  }

  function markDirty() {
    rulesDirty = true;
    $("rulesDirty").classList.remove("hidden");
  }

  // ------------------------------------------------------------ peças

  /** Linha "rótulo — slider — valor". `toggle` adiciona o liga/desliga. */
  function sliderRow(o) {
    const off = o.toggle && !o.enabled;
    const val = h("span", { class: "val", text: fmt(o.value) + o.suffix });
    const range = h("input", { type: "range", min: o.min, max: o.max, step: o.step, value: o.value, disabled: off });
    range.addEventListener("input", () => {
      val.textContent = fmt(range.value) + o.suffix;
      o.onInput(Number(range.value));
    });
    if (o.onCommit) range.addEventListener("change", () => o.onCommit(Number(range.value)));
    const left = o.toggle
      ? h("label", { class: "tg" }, h("input", { type: "checkbox", checked: o.enabled, onchange: (e) => o.onToggle(e.target.checked) }), h("span", { text: o.label }))
      : h("span", { class: "tg plain", text: o.label });
    return h("div", { class: "rule" + (off ? " off" : "") }, left, range, val, o.hint ? h("small", { class: "hint", text: o.hint }) : null);
  }

  function track(current, marks) {
    const t = h("div", { class: "track" });
    if (current !== null && current !== undefined) {
      const f = h("div", { class: "tfill" });
      f.style.width = clamp(current) + "%";
      t.append(f);
      t._fill = f;
      t._current = current;
    }
    for (const m of marks) {
      if (!m.show) continue;
      const mk = h("div", { class: "mark " + m.cls, title: `${m.cls === "alert" ? "Avisa" : "Troca"} em ${fmt(m.pct)}%` });
      mk.style.left = clamp(m.pct) + "%";
      m.el = mk;
      t.append(mk);
    }
    return t;
  }

  function paintTrack(t, line) {
    if (t._fill) t._fill.className = "tfill " + sevOf(t._current, line);
  }

  function moveMark(m, pct) {
    m.pct = pct;
    if (m.el) {
      m.el.style.left = clamp(pct) + "%";
      m.el.title = `${m.cls === "alert" ? "Avisa" : "Troca"} em ${fmt(pct)}%`;
    }
  }

  function nowText(w, what) {
    if (!w) return "conta ativa: sem dados";
    if (w.idle) return "conta ativa: sem uso nas últimas 5h";
    return `conta ativa: ${fmt(w.pct)}% ${what}${w.in ? ` · renova em ${w.in}` : ""}`;
  }

  // ------------------------------------------------------------ regras

  function renderRules() {
    const box = $("rules");
    box.replaceChildren();
    const act = activeAccount();
    const autoOn = S.auto.enabled;
    const switchHint = autoOn ? null : "Só troca com a “Troca automática” ligada lá em cima.";

    // --- modelo em uso
    const inUse = S.modelsInUse || [];
    box.append(
      h(
        "div",
        { class: "modelnow" },
        h("b", { text: "Modelo em uso agora: " }),
        inUse.length ? inUse.map((m, i) => `${i ? ", " : ""}${m.label}${m.minutesAgo ? ` (há ${m.minutesAgo} min)` : ""}`).join("") : "nenhum nos últimos 30 min",
        h("div", {
          class: "muted small",
          text: "A escolha do modelo fica no Claude Code, não na conta: depois de uma troca ele continua no mesmo modelo. O limite de um modelo só dispara troca enquanto ele está em uso.",
        })
      )
    );

    const group = (title, cur, what, alertKey, alertEnabledKey, switchKey, line, extra) => {
      const mA = { cls: "alert", pct: draft.alerts[alertKey], show: draft.alerts[alertEnabledKey] };
      const noSwitch = !!(extra && extra.noSwitch);
      const mS = { cls: "switch", pct: draft[switchKey], show: !noSwitch };
      const tr = track(cur && !cur.idle ? cur.pct : cur && cur.idle ? 0 : null, [mA, mS]);
      paintTrack(tr, draft[switchKey]);
      return h(
        "div",
        { class: "rulegroup" },
        h("div", { class: "rulehead" }, h("h4", null, title, extra && extra.badge ? extra.badge : null), h("span", { class: "now", text: nowText(cur, what) })),
        tr,
        sliderRow({
          label: "Avisar quando chegar em",
          toggle: true,
          enabled: draft.alerts[alertEnabledKey],
          value: draft.alerts[alertKey],
          min: 30, max: 99, step: 1, suffix: "%",
          onToggle: (v) => { draft.alerts[alertEnabledKey] = v; markDirty(); renderRules(); },
          onInput: (v) => { draft.alerts[alertKey] = v; moveMark(mA, v); markDirty(); },
        }),
        extra && extra.before ? extra.before : null,
        noSwitch
          ? null
          : sliderRow({
              label: (extra && extra.switchLabel) || "Trocar de conta quando chegar em",
              value: draft[switchKey],
              min: 50, max: 100, step: 1, suffix: "%",
              hint: (extra && extra.hint) || switchHint,
              onInput: (v) => { draft[switchKey] = v; moveMark(mS, v); paintTrack(tr, v); markDirty(); },
            }),
        extra && extra.after ? extra.after : null
      );
    };

    box.append(group("Sessão de 5 horas", act && act.session, "usado", "fiveHourPct", "fiveHourEnabled", "sessionPct"));
    box.append(group("Limite semanal (todos os modelos)", act && act.weekly, "usado", "weeklyPct", "weeklyEnabled", "weeklyPct"));

    for (const name of S.modelNames) {
      const sc = act ? act.models.find((m) => m.name === name) : null;
      const prefer = h(
        "label",
        { class: "check prefer" },
        h("input", {
          type: "checkbox",
          checked: draft.preferModel === name,
          onchange: (e) => { draft.preferModel = e.target.checked ? name : ""; markDirty(); },
        }),
        `Ao trocar, dar preferência a contas com ${name} disponível`
      );
      const same = draft.onModelLimit !== "switchAccount";
      const choice = (value, label, desc) =>
        h(
          "label",
          { class: "strategy mini" + (draft.onModelLimit === value || (value === "sameAccount" && same) ? " selected" : "") },
          h("input", {
            type: "radio",
            name: `onModelLimit-${name}`,
            checked: value === "sameAccount" ? same : !same,
            onchange: () => { draft.onModelLimit = value; markDirty(); renderRules(); },
          }),
          h("div", null, h("div", { class: "name", text: label }), h("div", { class: "desc", text: desc }))
        );
      // Opus 5.5 quando não há Fable: faz parte das duas opções (não é uma escolha à parte). Aqui só o estado.
      const am = S.autoModel || {};
      const fb = am.fallbackLabel || "Opus 5.5";
      const isFable = /fable/i.test(name);
      const lbl = !am.label || am.label === "o do plano" ? "modelo do plano" : am.label;
      const amNow = !isFable
        ? null
        : am.error
          ? `Não consegui ler as configurações do Claude Code: ${am.error}`
          : !am.enabled
            ? `A troca para o ${fb} está desligada neste computador (configuração swapPlus.autoModel.enabled do VS Code).`
            : am.switched
              ? `Agora, neste computador: as conversas novas abrem no ${fb} (desde ${am.since || "há pouco"}) e voltam para o ${am.backLabel || name} quando ele voltar.`
              : am.byHand
                ? `Agora, neste computador: as conversas novas abrem no ${lbl}, que você escolheu depois da troca. O Swap Plus só mexe de novo quando o ${name} renovar.`
                : !am.isFable && !am.isOpus
                  ? `Agora, neste computador: as conversas novas abrem no ${lbl}. Não é o ${name}, então o Swap Plus não mexe.`
                  : `Agora, neste computador: as conversas novas abrem no ${lbl}.`;
      const ccBox = isFable
        ? h(
            "div",
            { class: "muted small onlimit-note" },
            h("div", { text: amNow }),
            h("div", {
              text: `Conversa já aberta que parar com “You've hit your ${name} limit”: escolha ${fb} no seletor de modelo e mande “continue”. O Claude Code não deixa trocar o modelo dela por fora.`,
            })
          )
        : null;
      box.append(
        group(`Limite semanal do ${name}`, sc, "usado", "modelPct", "modelEnabled", "modelPct", null, {
          noSwitch: same && !(isFable && am.enabled),
          switchLabel: same ? `Passar as conversas novas para o ${fb} quando chegar em` : null,
          before: h(
            "div",
            { class: "onlimit" },
            h("div", { class: "cap", text: `Quando o ${name} acabar na conta em uso:` }),
            h(
              "div",
              { class: "strategies two" },
              choice("sameAccount", `Seguir na mesma conta com o ${fb}`, `A conta não muda. Na linha abaixo, as conversas novas passam a abrir no ${fb}; quando o ${name} renova, voltam para ele sozinhas.`),
              choice("switchAccount", `Trocar de conta para continuar no ${name}`, `Na linha abaixo, troca para outra conta que ainda tem ${name}, e a conversa aberta nem para. Se nenhuma tiver, as conversas novas passam a abrir no ${fb} até o ${name} voltar.`)
            ),
            ccBox
          ),
          hint: same
            ? `Vale em cada computador, mesmo com a “Troca automática” de conta desligada.`
            : `Vale mesmo com a conversa já no ${fb}: a ideia é voltar para o ${name}.` + (autoOn ? "" : " (Só troca com a “Troca automática” ligada.)"),
          after: prefer,
        })
      );
    }

    // --- estratégias
    const sbox = $("strategies");
    sbox.replaceChildren(
      ...STRATS.map((s) =>
        h(
          "label",
          { class: "strategy" + (draft.strategy === s.id ? " selected" : "") },
          h("input", {
            type: "radio",
            name: "strategy",
            checked: draft.strategy === s.id,
            onchange: () => { draft.strategy = s.id; markDirty(); renderRules(); renderAccounts(true); },
          }),
          h("div", null, h("div", { class: "name" }, s.name, s.tag ? h("span", { class: "tag", text: s.tag }) : null), h("div", { class: "desc", text: s.desc }))
        )
      )
    );
    const maxBox = $("maxOptions");
    maxBox.replaceChildren();
    if (draft.strategy === "max") {
      maxBox.append(
        sliderRow({
          label: "Trocar antes para uma conta que zera em até",
          value: draft.expiringHours, min: 1, max: 72, step: 1, suffix: " h",
          hint: "Só se a outra conta tiver pelo menos 20% do semanal sobrando e renovar antes da conta atual.",
          onInput: (v) => { draft.expiringHours = v; markDirty(); },
        })
      );
    }

    // --- computadores (regra devicePlacement, vai ao servidor no "Salvar regras")
    let pbox = $("placement");
    if (!pbox) {
      pbox = h("div", { id: "placement" });
      maxBox.after(pbox);
    }
    {
      const together = draft.devicePlacement === "together";
      const place = (value, name, tag, desc) => {
        const on = value === "together" ? together : !together;
        return h(
          "label",
          { class: "strategy" + (on ? " selected" : "") },
          h("input", {
            type: "radio",
            name: "devicePlacement",
            checked: on,
            onchange: () => { draft.devicePlacement = value; markDirty(); renderRules(); },
          }),
          h("div", null, h("div", { class: "name" }, name, tag ? h("span", { class: "tag", text: tag }) : null), h("div", { class: "desc", text: desc }))
        );
      };
      pbox.replaceChildren(
        h("h3", { text: "Computadores" }),
        h(
          "div",
          { class: "strategies two" },
          place("separate", "Separados", "padrão", "Cada computador numa conta (cada um com a sua sessão de 5 h)."),
          place("together", "Juntos", null, "Todos na mesma conta, a do topo da fila, e trocam juntos (gastam a mesma sessão de 5 h).")
        )
      );
    }

    // --- avançado
    $("advanced").replaceChildren(
      sliderRow({
        label: "Tempo mínimo entre trocas antecipadas",
        value: draft.cooldownMin, min: 0, max: 60, step: 1, suffix: " min",
        hint: "Não vale quando a conta chega numa linha de troca: aí troca na hora.",
        onInput: (v) => { draft.cooldownMin = v; markDirty(); },
      }),
      sliderRow({
        label: "Folga mínima da conta de destino",
        value: draft.marginPct, min: 0, max: 30, step: 1, suffix: " pts",
        hint: "A conta de destino precisa estar pelo menos isso abaixo de cada linha. Evita trocar para uma conta que logo precisaria trocar de novo.",
        onInput: (v) => { draft.marginPct = v; markDirty(); },
      })
    );
  }

  function saveRules() {
    const { alerts, ...rules } = draft;
    rulesDirty = false;
    $("rulesDirty").classList.add("hidden");
    send({ type: "saveRules", rules, alerts });
  }

  // ------------------------------------------------------------ contas

  function meter(label, w) {
    if (!w) return h("div", { class: "meter" }, h("span", { class: "lbl", text: label }), h("div", { class: "bar" }), h("span", { class: "pct muted", text: "—" }));
    const fill = h("div", { class: "fill " + sevClass(w.level) });
    fill.style.width = clamp(w.pct) + "%";
    return h(
      "div",
      { class: "meter" },
      h("span", { class: "lbl", text: label }),
      h("div", { class: "bar" }, fill),
      h("span", { class: "pct " + sevClass(w.level), text: fmt(w.pct) + "%" }),
      w.in ? h("span", { class: "reset", text: `renova em ${w.in}${w.when ? ` · ${w.when}` : ""}` }) : w.idle ? h("span", { class: "reset", text: "sem uso nas últimas 5h" }) : null
    );
  }

  /** Cota semanal que vai zerar em menos de 24 h sem ter sido usada. */
  function wasteNote(a) {
    const w = a.weekly;
    if (!w || !w.resetTs || a.disabled) return null;
    const hours = (w.resetTs - Date.now()) / 3600000;
    const left = 100 - w.pct;
    if (hours <= 0 || hours > 24 || left < 25) return null;
    return h("div", { class: "waste", text: `Zera em ${w.in} com ${fmt(left)}% do semanal sem usar` });
  }

  /** Nome deste computador como o servidor o conhece (é o nome que aparece em a.devices). */
  function myDeviceName() {
    const sv = S.server || {};
    const me = (sv.devices || []).find((d) => d.current);
    return (me && me.name) || sv.deviceName || null;
  }

  /**
   * Um selo só dizendo onde a conta está em uso: "Em uso neste computador"
   * (+ " e em: <outros>") ou "Em uso em: <computadores>".
   */
  function inUseBadge(a) {
    const others = Array.isArray(a.devices) ? [...a.devices] : [];
    if (a.active) {
      // A lista do servidor traz este computador também: tira o nome dele uma vez
      // (outro computador com o mesmo nome continua aparecendo).
      const i = others.indexOf(myDeviceName());
      if (i >= 0) others.splice(i, 1);
      return h("span", {
        class: "badge on wrap",
        title: others.length ? "Este computador e os outros listados estão usando esta conta agora" : "Este computador está usando esta conta agora",
        text: others.length ? `Em uso neste computador e em: ${others.join(", ")}` : "Em uso neste computador",
      });
    }
    return others.length ? h("span", { class: "badge plain wrap", title: "Computadores que estão usando esta conta agora", text: `Em uso em: ${others.join(", ")}` }) : null;
  }

  // ------------------------------------------------------------ regra própria de cada conta
  //
  // "Usar regra padrão" marcado = a conta segue as regras gerais (os três valores null).
  // Desmarcado: 3 sliders (sessão 5h, semanal, modelo) e cada mudança vai ao servidor na
  // hora (pausa de 500 ms, PATCH só do campo que mudou).
  //
  // Rascunho por conta: o que a pessoa mudou e ainda não voltou da extensão. A atualização
  // automática (a cada 30 s) desenha o rascunho por cima do estado até o estado confirmar o
  // valor, a gravação falhar ou passar 1 min sem confirmação.
  // n -> { open, fields: { [campo]: { value, seq, ts, timer } }, reset: { seq, ts } | null }

  const RULE_KEYS = ["threshold", "weeklyThreshold", "modelThreshold"];
  const RULE_DEBOUNCE_MS = 500;
  const RULE_DRAFT_MAX_MS = 60000;
  const acctRule = {};
  let ruleSeq = 0;

  const ownOf = (v) => (v === null || v === undefined || v === "" || !isFinite(Number(v)) ? null : Number(v));
  const sameOwn = (x, y) => (x === null || y === null ? x === y : Math.abs(x - y) < 0.01);

  function ruleDraft(n) {
    return acctRule[n] || (acctRule[n] = { open: false, fields: {}, reset: null });
  }

  function dropRuleDraft(n) {
    const d = acctRule[n];
    if (!d) return;
    for (const f of Object.values(d.fields)) clearTimeout(f.timer);
    delete acctRule[n];
  }

  /** O que o cartão mostra: valores próprios (rascunho por cima do estado) e se "Usar regra padrão" fica marcado. */
  function ruleView(a) {
    const d = acctRule[a.number];
    const keys = RULE_KEYS;
    const own = {};
    for (const k of keys) {
      if (d && d.fields[k]) own[k] = d.fields[k].value;
      else if (d && d.reset) own[k] = null; // voltando à regra padrão: não mostra o valor antigo
      else own[k] = ownOf(a[k]);
    }
    const anyOwn = keys.some((k) => own[k] !== null);
    return { keys, own, useDefault: !anyOwn && !(d && d.open) };
  }

  /** A cada estado novo: tira do rascunho o que o estado já confirmou (ou que passou do prazo). */
  function reconcileRuleDrafts() {
    const now = Date.now();
    for (const n of Object.keys(acctRule)) {
      const d = acctRule[n];
      const a = S.accounts.find((x) => String(x.number) === n);
      if (!a) {
        dropRuleDraft(n);
        continue;
      }
      for (const [k, f] of Object.entries(d.fields)) {
        if (f.timer) continue; // ainda esperando a pausa do slider
        if (sameOwn(ownOf(a[k]), f.value) || now - f.ts > RULE_DRAFT_MAX_MS) delete d.fields[k];
      }
      if (d.reset && (RULE_KEYS.every((k) => ownOf(a[k]) === null) || now - d.reset.ts > RULE_DRAFT_MAX_MS)) d.reset = null;
      // A conta já tem regra própria no estado: o "desmarcado sem mexer" não precisa mais ficar guardado.
      if (!d.reset && RULE_KEYS.some((k) => ownOf(a[k]) !== null)) d.open = false;
      if (!d.open && !d.reset && !Object.keys(d.fields).length) delete acctRule[n];
    }
  }

  /** A gravação de uma regra falhou: o rascunho daquela mudança sai e o cartão volta ao que está gravado. */
  function ruleFailed(m) {
    const d = acctRule[m.number];
    if (!d) return;
    for (const [k, f] of Object.entries(d.fields)) if (f.seq === m.seq && !f.timer) delete d.fields[k];
    if (d.reset && d.reset.seq === m.seq) d.reset = null;
    if (S) renderAccounts();
  }

  /** Guarda o valor no rascunho e manda ao servidor depois de 500 ms sem mexer. */
  function ruleInput(n, key, value) {
    const d = ruleDraft(n);
    const f = d.fields[key] || (d.fields[key] = { timer: null });
    clearTimeout(f.timer);
    f.value = value;
    f.ts = Date.now();
    f.seq = ++ruleSeq;
    const seq = f.seq;
    f.timer = setTimeout(() => {
      f.timer = null;
      f.ts = Date.now();
      send({ type: "account", number: n, op: key, value, seq });
    }, RULE_DEBOUNCE_MS);
  }

  /** Desmarcou "Usar regra padrão": abre os sliders (nada vai ao servidor até mexer em um). */
  function ruleCustomize(n) {
    const d = ruleDraft(n);
    d.open = true;
    rerenderCard(n, "ruledef");
  }

  /** Marcou "Usar regra padrão" de novo: os três voltam a null. */
  function ruleBackToDefault(n) {
    const d = ruleDraft(n);
    for (const f of Object.values(d.fields)) clearTimeout(f.timer); // pausa ainda pendente não vai mais
    d.fields = {};
    d.open = false;
    d.reset = { seq: ++ruleSeq, ts: Date.now() };
    send({ type: "account", number: n, op: "useDefault", seq: d.reset.seq });
    rerenderCard(n, "ruledef");
  }

  /** Redesenha só um cartão (sem mexer nos outros) e devolve o foco ao controle indicado. */
  function rerenderCard(n, focusKey) {
    const old = document.querySelector(`#accounts .acct[data-n="${n}"]`);
    const a = S && S.accounts.find((x) => x.number === n);
    if (!old || !a) return renderAccounts(true);
    const card = accountCard(a);
    old.replaceWith(card);
    const el = focusKey ? card.querySelector(`[data-fk="${focusKey}"]`) : null;
    if (el) el.focus();
  }

  /** "☑ Usar regra padrão" e, desmarcado, os sliders da regra própria da conta. */
  function ruleBlock(a) {
    const r = S.rules || {};
    const v = ruleView(a);
    const modelName = (typeof r.preferModel === "string" && r.preferModel.trim()) || "Modelo";
    const defs = [
      { key: "threshold", label: "Sessão 5h", general: r.sessionPct },
      { key: "weeklyThreshold", label: "Semanal", general: r.weeklyPct },
      { key: "modelThreshold", label: modelName, general: r.modelPct },
    ].filter((x) => v.keys.includes(x.key));

    const head = h(
      "div",
      { class: "ctl" },
      h(
        "label",
        null,
        h("input", {
          type: "checkbox",
          "data-fk": "ruledef",
          checked: v.useDefault,
          onchange: (e) => (e.target.checked ? ruleBackToDefault(a.number) : ruleCustomize(a.number)),
        }),
        "Usar regra padrão"
      ),
      v.useDefault
        ? h("span", { class: "cap", text: `Segue as regras gerais: sessão ${fmt(r.sessionPct)}% · semanal ${fmt(r.weeklyPct)}% · ${modelName} ${fmt(r.modelPct)}%` })
        : null
    );
    if (v.useDefault) return head;

    const rows = defs.map((def) => {
      const own = v.own[def.key];
      const start = own !== null ? own : Math.max(50, Math.min(100, Number(def.general) || 90));
      const inherited = own === null;
      const val = h("span", {
        class: "val" + (inherited ? " dim" : ""),
        title: inherited ? "Ainda segue a regra geral: mexa no slider para fixar um valor só desta conta" : null,
        text: fmt(start) + "%",
      });
      const range = h("input", { type: "range", min: 50, max: 100, step: 1, value: start, "aria-label": `${def.label}: linha de troca só desta conta` });
      range.addEventListener("input", () => {
        val.textContent = fmt(range.value) + "%";
        val.classList.remove("dim");
        val.removeAttribute("title");
        ruleInput(a.number, def.key, Number(range.value));
      });
      return [h("span", { class: "lbl", text: def.label }), range, val];
    });
    return [
      head,
      h(
        "div",
        { class: "ownrules" },
        rows.flat(),
        h("small", { class: "hint", text: "Linha de troca só desta conta. Cada mudança vai na hora para o servidor e vale para todos os computadores." })
      ),
    ];
  }

  function accountCard(a) {
    const strategy = draft ? draft.strategy : S.rules.strategy;
    const prioMatters = strategy === "priority";
    const acct = (op, value) => send({ type: "account", number: a.number, op, value });

    const prMax = Math.max(10, a.priority || 0);
    const prVal = h("span", { class: "val", text: String(a.priority || 0) });
    const prRange = h("input", { type: "range", min: 0, max: prMax, step: 1, value: a.priority || 0 });
    prRange.addEventListener("input", () => (prVal.textContent = prRange.value));
    prRange.addEventListener("change", () => acct("priority", Number(prRange.value)));

    const card = h(
      "div",
      { class: "acct" + (a.active ? " active" : "") + (a.disabled ? " off" : " rot"), "data-n": String(a.number) },
      h(
        "div",
        { class: "ahead" },
        h(
          "div",
          null,
          h("div", { class: "aname" }, h("span", { class: "n", text: `Conta ${a.number}` }), S.privacy ? "" : a.alias ? `“${a.alias}” — ` : "", S.privacy ? "" : a.email),
          h("div", { class: "sub", text: [a.plan, a.org].filter(Boolean).join(" · ") })
        ),
        h(
          "div",
          { class: "badges" },
          inUseBadge(a),
          a.disabled ? h("span", { class: "badge plain", text: "Fora da rotação" }) : null,
          a.loginDead
            ? h("span", {
                class: "badge dead",
                title:
                  S.server && S.server.canUploadLogins === false
                    ? "O login desta conta não vale mais no servidor. A troca automática pula esta conta. Para usar de novo, o administrador entra outra vez com ela (pelo painel do servidor ou num computador dele): este computador não envia logins."
                    : "O login desta conta não vale mais no servidor. A troca automática pula esta conta. Para usar de novo: entre com ela no Claude Code num computador do administrador e o Swap Plus envia o login novo ao servidor.",
                text: "Login morto — entrar de novo",
              })
            : a.status && a.status !== "ok"
              ? h("span", { class: "badge plain", text: a.statusLabel })
              : null,
          a.stale && a.ageMin !== null ? h("span", { class: "badge plain", title: "O servidor atualiza cada conta de alguns em alguns minutos (a Anthropic limita as consultas).", text: `dados de ${a.ageMin} min` }) : null
        )
      ),
      h("div", { class: "meters" }, meter("Sessão 5h", a.session), meter("Semanal", a.weekly), a.models.map((m) => meter(m.name, m))),
      wasteNote(a),
      h(
        "div",
        { class: "ctl" },
        h("label", null, h("input", { type: "checkbox", class: "rotbox", checked: !a.disabled, onchange: (e) => acct("disabled", !e.target.checked) }), "Participa da troca automática")
      ),
      ruleBlock(a),
      h("div", { class: "ctl" + (prioMatters ? "" : " dim") }, h("span", { class: "cap", text: prioMatters ? "Prioridade (maior = usada primeiro)" : "Prioridade (só na estratégia “Por prioridade”)" }), prRange, prVal),
      h(
        "div",
        { class: "afoot" },
        S.privacy ? h("span") : h("input", {
          type: "text",
          placeholder: "apelido",
          value: a.alias || "",
          maxlength: "24",
          onchange: (e) => acct("alias", e.target.value.trim()),
        }),
        h("button", { class: "secondary", disabled: a.active, text: a.active ? "Em uso" : "Usar esta conta", onclick: () => send({ type: "switch", number: a.number }) })
      )
    );
    return card;
  }

  function renderAccounts(force) {
    if (acctHold && !force) {
      acctPending = true;
      return;
    }
    acctPending = false;
    const list = [...S.accounts];
    // Primeiro quem participa da troca automática; dentro de cada grupo, quem renova o semanal antes.
    const reset = (a) => (a.weekly && a.weekly.resetTs ? a.weekly.resetTs : Infinity);
    list.sort((a, b) => Number(a.disabled) - Number(b.disabled) || reset(a) - reset(b) || (a.weekly ? a.weekly.pct : 100) - (b.weekly ? b.weekly.pct : 100) || a.number - b.number);
    const connected = !!(S.server && S.server.connected);
    const hint = list.length
      ? h("p", {
          class: "muted small",
          text: "Ordem: primeiro as contas que participam da troca automática, de quem renova o semanal antes para quem renova depois; no fim, as que não participam, na mesma ordem.",
        })
      : null;
    const grid = h(
      "div",
      { class: "accounts" },
      list.length
        ? list.map((a) => accountCard(a))
        : h("p", { class: "muted", text: connected ? "Nenhuma conta no servidor ainda." : "Entre com Google (em “Sua conta”, lá em cima) para ver as contas do servidor." })
    );
    const act = S.accounts.find((a) => a.active);
    const inUse = h(
      "div",
      { class: "inuse" },
      h("span", { class: "dot on" }),
      "Em uso agora: ",
      h("b", { text: act ? `Conta ${act.number}${!S.privacy && act.email ? ` — ${act.email}` : ""}` : "nenhuma conta" }),
      act ? " (neste computador, escolhida pelo servidor)" : "",
      act && act.session ? ` · sessão ${fmt(act.session.pct)}%` : "",
      act && act.weekly ? ` · semanal ${fmt(act.weekly.pct)}%` : ""
    );
    $("accounts").replaceWith(h("div", { id: "accounts" }, connected ? inUse : null, hint, grid));
    wireAccountHold();
  }

  function wireAccountHold() {
    const box = $("accounts");
    const release = () => {
      setTimeout(() => {
        if (box.contains(document.activeElement) && document.activeElement.tagName === "INPUT" && document.activeElement.type === "text") return;
        acctHold = false;
        if (acctPending) renderAccounts();
      }, 150);
    };
    box.addEventListener("pointerdown", () => (acctHold = true));
    box.addEventListener("focusin", () => (acctHold = true));
    box.addEventListener("pointerup", release);
    box.addEventListener("focusout", release);
  }

  // ------------------------------------------------------------ resto

  function renderMaster() {
    const on = S.swapOn !== false;
    $("masterToggle").checked = on;
    $("masterStatus").replaceChildren(
      h("span", { class: "dot" + (on ? " on" : "") }),
      on ? h("b", { class: "ontext", text: "Ligado" }) : h("b", { text: "Desligado" }),
      on ? " — usando as contas do servidor" : " — o Claude Code está funcionando normalmente, sem troca de conta"
    );
    $("autoCard").classList.toggle("dimmed", !on);
    $("autoToggle").disabled = !on;
    $("btnCheck").disabled = !on;
    renderSession();
  }

  // "Sua conta": a sessão deste VS Code no servidor, no mesmo cartão em que se liga o Swap Plus.
  function renderSession() {
    const sv = S.server || {};
    const busy = !!sv.connecting;
    const needLogin = !sv.connected || sv.status === "revoked" || (sv.status === "disconnected" && sv.addressChanged);
    const kids = [h("div", { class: "k", text: "Sua conta" })];
    if (needLogin) {
      kids.push(
        h(
          "div",
          { class: "v" },
          h("span", { class: "muted", text: sv.status === "revoked" ? "acesso recusado pelo servidor — entre de novo" : "não conectado ao servidor" }),
          h(
            "div",
            { class: "row gap wrap sessbtns" },
            h("button", { text: busy ? "Conectando…" : "Entrar com Google", disabled: busy, onclick: () => send({ type: "connectServer", method: "google" }) }),
            h("button", { class: "secondary", text: "Colar código", disabled: busy, onclick: () => send({ type: "connectServer", method: "code" }) })
          )
        )
      );
    } else {
      const who = sv.myGoogle || (sv.via === "code" ? "conectado por código de conexão" : "conectado");
      kids.push(
        h(
          "div",
          { class: "v" },
          h("div", null, h("b", { text: who })),
          h("div", { class: "muted small", text: [sv.deviceName, sv.host ? `servidor ${sv.host}` : null].filter(Boolean).join(" · ") }),
          sv.myAccount ? h("div", { class: "small", text: `Conta Claude em uso aqui: ${sv.myAccount}` }) : null,
          h("div", { class: "row gap wrap sessbtns" }, h("button", { class: "secondary", text: "Sair", onclick: () => send({ type: "disconnectServer" }) }))
        )
      );
    }
    $("sessionBox").replaceChildren(...kids);
  }

  // ------------------------------------------------------------ servidor

  const SRV_TITLES = {
    off: "Desligado",
    disconnected: "Não conectado",
    connecting: "Conectando",
    online: "Conectado",
    offline: "Servidor fora do ar",
    revoked: "Acesso recusado",
  };

  function renderServer() {
    const sv = S.server || { status: "disconnected", devices: [] };
    const st = sv.status;
    const good = st === "online";
    const badSt = st === "offline" || st === "revoked" || st === "disconnected";
    $("serverStatus").replaceChildren(
      h("span", { class: "dot" + (good ? " on" : badSt ? " bad" : "") }),
      h("b", { class: good ? "ontext" : badSt ? "badtext" : "", text: SRV_TITLES[st] || st }),
      sv.statusText ? ` — ${sv.statusText}` : ""
    );
    // Conectar: entrar com Google (padrão) ou colar o código de conexão gerado no servidor.
    const busyConn = !!sv.connecting;
    const connectBtns = () => [
      h("button", {
        text: busyConn ? "Conectando…" : "Entrar com Google",
        title: `Abre o navegador para você entrar com a sua conta Google${sv.host ? ` em ${sv.host}` : ""}. O dono do servidor precisa ter liberado essa conta.`,
        disabled: busyConn,
        onclick: () => send({ type: "connectServer", method: "google" }),
      }),
      h("button", {
        class: "secondary",
        text: "Colar código",
        title: "Colar o código de conexão (swapplus1:…) gerado no servidor com o comando pair",
        disabled: busyConn,
        onclick: () => send({ type: "connectServer", method: "code" }),
      }),
    ];
    const disconnectBtn = () => h("button", { class: "secondary", text: "Desconectar", onclick: () => send({ type: "disconnectServer" }) });
    // Conectado mas recusado, ou o endereço mudou: conectar de novo (ou desconectar de vez).
    const reconnect = st === "revoked" || (st === "disconnected" && sv.addressChanged);
    $("serverBtns").replaceChildren(
      ...(!sv.connected ? connectBtns() : reconnect ? [...connectBtns(), disconnectBtn()] : [disconnectBtn()])
    );

    const kids = [];

    // Onde o Claude Code lê o login (ex.: Windows com o Gerenciador de Credenciais, variável de ambiente que passa na frente).
    for (const w of sv.storeWarnings || []) {
      kids.push(
        h(
          "div",
          { class: "srvwarn" },
          h("b", { text: sv.storeBlocked && /Gerenciador de Credenciais/.test(w) ? "O Swap Plus não está gravando o login neste computador: " : "Atenção: " }),
          w
        )
      );
    }

    if (sv.rejected) {
      kids.push(
        h(
          "div",
          { class: "srvwarn" },
          h("b", { text: "Login do Claude Code recusado pelo servidor: " }),
          `${sv.rejected.reason}. Esse login fica como está; o envio é tentado de novo em 10 min.`,
          h("button", { text: "Usar a conta do servidor", onclick: () => send({ type: "useServerAccount" }) })
        )
      );
    }

    if (!sv.connected || reconnect) {
      kids.push(
        h(
          "p",
          { class: "muted small srvhow" },
          h("b", { text: "Entrar com Google: " }),
          `o navegador abre, você entra com a sua conta Google e este computador fica conectado${sv.host ? ` a ${sv.host}` : ""}. O dono do servidor precisa ter liberado a sua conta. `,
          h("button", {
            class: "linkbtn",
            text: "Outro endereço…",
            title: "Entrar com Google em outro servidor Swap Plus",
            disabled: busyConn,
            onclick: () => send({ type: "connectServer", method: "googleOther" }),
          }),
          h("br"),
          h("b", { text: "Colar código: " }),
          "o código que começa com swapplus1:, gerado no servidor (comando pair). Vale 10 minutos e uma vez só."
        )
      );
    }

    if (sv.connected || sv.url) {
      const row = (k, v) => [h("span", { class: "k", text: k }), h("span", { class: "v", text: v })];
      kids.push(
        h(
          "div",
          { class: "srvinfo" },
          row("Endereço", sv.url || "—"),
          sv.connected ? row("Este computador", sv.deviceName || "—") : null,
          sv.connected && sv.via ? row("Conectado com", sv.via === "google" ? "conta Google" : "código de conexão") : null,
          sv.connected ? row("Último contato", sv.lastOkWhen || "ainda não houve") : null,
          sv.version ? row("Versão do servidor", sv.version) : null
        )
      );
    }

    if (sv.connected && sv.devices && sv.devices.length) {
      kids.push(h("h3", { text: "Computadores conectados" }));
      kids.push(
        h(
          "div",
          { class: "devs" },
          sv.devices.map((d) =>
            h(
              "div",
              { class: "dev" + (d.current ? " me" : "") },
              h(
                "div",
                { class: "dname" },
                h("span", { class: "dot" + (d.active ? " on" : "") }),
                h("b", { text: d.name }),
                d.current ? h("span", { class: "tag on", text: "este computador" }) : null
              ),
              h(
                "div",
                { class: "dacc" },
                h("div", { text: `usa: ${d.account}` }),
                d.google
                  ? h("div", {
                      class: "dgoogle",
                      text: `Google: ${d.googleEmail || "(e-mail oculto)"}`,
                      title: "Conta Google com que este computador entrou no servidor",
                    })
                  : null
              ),
              h("div", { class: "dseen", text: d.active ? "ativo agora" : d.lastSeenWhen ? `visto ${d.lastSeenWhen}` : "ainda não apareceu" }),
              h("button", {
                class: "secondary",
                text: d.current ? "Desconectar" : "Revogar",
                title: d.current ? "Desconectar este computador do servidor" : "Ele para de receber o login das contas na hora",
                onclick: () => send(d.current ? { type: "disconnectServer" } : { type: "revokeDevice", id: d.id }),
              })
            )
          )
        )
      );
    }

    if (sv.loginPromptOff) {
      kids.push(
        h("p", {
          class: "muted small",
          text: `${sv.loginPromptNote || "Enquanto este computador estiver conectado ao servidor, o login do Claude Code é feito pelo Swap Plus"}: a tela de login do Claude Code fica desligada (claudeCode.disableLoginPrompt) e volta como estava ao desconectar ou desligar o Swap Plus.`,
        })
      );
    }

    if (sv.otherWindow) {
      kids.push(h("p", { class: "muted small", text: "Outra janela do VS Code está cuidando do login deste computador (batimento e gravação); esta janela só mostra o estado." }));
    }

    if (sv.connected && sv.diag) {
      const v = sv.diag.value;
      kids.push(
        h("p", {
          class: "muted small diag",
          text:
            "Diagnóstico: depois que o servidor renova o login de uma conta, o acesso anterior " +
            (v === true
              ? "continua valendo por um tempo — um computador que demorar alguns minutos para receber o acesso novo não fica sem conta."
              : v === false
                ? "deixa de valer na hora — cada computador depende de receber o acesso novo (o que acontece em até 30 s)."
                : "ainda não foi testado (o servidor testa na primeira renovação).") +
            (sv.diag.when ? ` Testado ${sv.diag.when}.` : ""),
        })
      );
    }

    $("serverBox").replaceChildren(...kids);
  }

  function renderAuto() {
    $("autoToggle").checked = S.auto.enabled;
    const r = S.rules;
    const st = STRATS.find((s) => s.id === r.strategy);
    const models = !S.modelNames.length
      ? ""
      : r.onModelLimit === "switchAccount"
        ? `, ${S.modelNames.join("/")} ≥ ${fmt(r.modelPct)}% (quando em uso)`
        : ` · ${S.modelNames.join("/")} ≥ ${fmt(r.modelPct)}%: segue na mesma conta e as conversas novas abrem no Opus 5.5`;
    $("autoStatus").replaceChildren(
      h("span", { class: "dot" + (S.auto.enabled ? " on" : "") }),
      S.auto.enabled ? h("b", { class: "ontext", text: "Ligada" }) : h("b", { text: "Desligada" }),
      S.auto.enabled
        ? ` — decidida pelo servidor, para todos os computadores · troca em sessão ≥ ${fmt(r.sessionPct)}%, semanal ≥ ${fmt(r.weeklyPct)}%${models} · ${st ? st.name : r.strategy} · computadores ${r.devicePlacement === "together" ? "juntos" : "separados"}`
        : " — no servidor: nenhuma troca acontece sozinha em nenhum computador. Os avisos continuam funcionando."
    );
    const last = S.auto.last;
    $("autoLast").textContent = last ? `Última decisão do servidor (${S.auto.lastWhen || "?"}): ${last.text}` : "";
  }

  function renderUi() {
    const set = (key, value) => send({ type: "ui", key, value });
    $("uiBox").replaceChildren(
      h("label", { class: "check" }, h("input", { type: "checkbox", checked: S.privacy, onchange: (e) => set("privacy.hideEmails", e.target.checked) }), "Modo privado: mostrar só “Conta N”, sem e-mail"),
      h("p", {
        class: "muted small privnote",
        text: "Vale para a barra, a lista de contas, esta tela e os avisos do Swap Plus. Não é uma trava: o painel de conta do próprio Claude Code continua mostrando o e-mail, e quem usa este computador usa as contas.",
      }),
      h("label", { class: "check" }, h("input", { type: "checkbox", checked: S.ui.showAccountNumber, onchange: (e) => set("statusBar.showAccountNumber", e.target.checked) }), "Mostrar o número da conta ao lado do ícone de e-mail"),
      h("label", { class: "check" }, h("input", { type: "checkbox", checked: S.ui.showModelWeekly, onchange: (e) => set("statusBar.showModelWeekly", e.target.checked) }), "Mostrar o semanal por modelo (ex.: Fable) na barra"),
      h("p", { class: "muted small", text: "Cor do item na barra: normal abaixo de 70%, amarelo a partir de 70% e vermelho na linha de troca — vale o limite mais perto do fim." }),
      h("p", { class: "muted small", text: "Este computador fala com o servidor a cada 30 s; o servidor consulta o uso das contas na Anthropic." })
    );
  }

  const REASONS = { open: "ao abrir o VS Code", close: "ao fechar o VS Code", periodic: "verificação periódica", manual: "manual" };

  function renderUpdates() {
    const u = S.updates;
    const box = $("updBox");
    if (!u) return box.replaceChildren(h("p", { class: "muted small", text: "Atualizador indisponível." }));
    const L = u.last;
    const newer = (a, b) => {
      const p = (s) => String(s || "").split(/[^\d]+/).filter(Boolean).slice(0, 3).map(Number);
      const x = p(a), y = p(b);
      if (x.length < 3 || y.length < 3) return false;
      for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
      return false;
    };
    const cell = (v, flag) => h("span", { class: flag ? "new" : "", text: v || "—" });
    const rows = [
      h("span", { class: "hd", text: "" }), h("span", { class: "hd", text: "Nesta máquina" }), h("span", { class: "hd", text: "No seu fork" }), h("span", { class: "hd", text: "No original" }),
      h("span", { class: "nm", text: "Extensão Swap Plus" }),
      cell(u.extInstalled),
      cell(L ? L.ext.latest : null, L && newer(L.ext.latest, u.extInstalled)),
      cell(L && L.ext.upstream ? `${L.ext.upstream} (base ${L.ext.base || "?"})` : null, L && newer(L.ext.upstream, L.ext.base)),
    ];
    box.replaceChildren(
      h("div", { class: "upd" }, rows),
      h("p", {
        class: "muted small",
        text: L
          ? `Última verificação: ${L.when || L.ts} (${REASONS[L.reason] || L.reason})${L.error ? ` — erro: ${L.error}` : ""}.`
          : "Ainda não verificou.",
      }),
      h("p", {
        class: "muted small",
        text: `Verifica ao abrir e ao fechar o VS Code e a cada 2 dias, tudo dentro do VS Code. ${u.autoUpdate ? "Instala sozinho, como as outras extensões (Extensions: Auto Update ligado)." : "Só avisa, porque o Auto Update de extensões do VS Code está desligado."} Ao fechar, só verifica: se houver versão nova, ela é instalada na próxima abertura.${u.pendingOnOpen ? " Há versão nova esperando a próxima abertura do VS Code." : ""}`,
      })
    );
  }

  // Histórico paginado: 10 por página (pedido do dono). A página atual é mantida quando
  // chegam eventos novos; se a lista encolher (ex.: Limpar), volta para a última que existe.
  const HIST_PAGE_SIZE = 10;
  let histPage = 0;

  function renderHistory() {
    const all = S.auto.history || [];
    const pages = Math.max(1, Math.ceil(all.length / HIST_PAGE_SIZE));
    if (histPage > pages - 1) histPage = pages - 1;
    if (histPage < 0) histPage = 0;
    const items = all.slice(histPage * HIST_PAGE_SIZE, (histPage + 1) * HIST_PAGE_SIZE);
    const pager = $("histPager");
    pager.classList.toggle("hidden", all.length <= HIST_PAGE_SIZE);
    $("histPage").textContent = `página ${histPage + 1} de ${pages} · ${all.length} eventos`;
    $("histPrev").disabled = histPage === 0;
    $("histNext").disabled = histPage >= pages - 1;
    $("history").replaceChildren(
      ...(items.length
        ? items.map((it) =>
            h(
              "li",
              null,
              h("span", { class: "when", text: it.when || "" }),
              h("span", { class: "kind " + it.kind, text: KIND_LABELS[it.kind] || it.kind }),
              h("span", { class: "htext" }, it.text, it.who ? h("span", { class: "who", text: ` · ${it.who}` }) : null)
            )
          )
        : [h("li", { class: "empty", text: "Nada por aqui ainda. Trocas, alertas e bloqueios aparecem nesta lista." })])
    );
  }

  function renderAll() {
    const err = $("errorBox");
    if (S.error) {
      err.textContent = S.error;
      err.classList.remove("hidden");
    } else {
      err.classList.add("hidden");
    }
    if (!rulesDirty || !draft) {
      draft = draftFromState();
      rulesDirty = false;
      $("rulesDirty").classList.add("hidden");
    }
    renderMaster();
    renderServer();
    renderAuto();
    renderRules();
    renderAccounts();
    renderUi();
    renderUpdates();
    renderHistory();
  }

  // ------------------------------------------------------------ eventos

  window.addEventListener("message", (ev) => {
    const m = ev.data;
    if (m.type === "state") {
      S = m;
      reconcileRuleDrafts();
      renderAll();
    } else if (m.type === "acctSaved") {
      if (!m.ok) ruleFailed(m);
    } else if (m.type === "busy") {
      const b = $("busy");
      b.textContent = m.text || "";
      b.classList.toggle("hidden", !m.on);
    } else if (m.type === "toast") {
      toast(m.text, m.kind);
    }
  });

  $("btnRefresh").addEventListener("click", () => send({ type: "refresh" }));
  $("autoToggle").addEventListener("change", (e) => send({ type: "setAuto", enabled: e.target.checked }));
  $("masterToggle").addEventListener("change", (e) => send({ type: "setEnabled", enabled: e.target.checked }));
  $("btnCheck").addEventListener("click", () => send({ type: "checkNow" }));
  $("btnSave").addEventListener("click", saveRules);
  $("btnUndo").addEventListener("click", () => {
    rulesDirty = false;
    draft = null;
    if (S) renderAll();
  });
  $("btnAdd").addEventListener("click", () => send({ type: "add" }));
  $("histPrev").addEventListener("click", () => { histPage -= 1; renderHistory(); });
  $("histNext").addEventListener("click", () => { histPage += 1; renderHistory(); });
  $("btnUpdates").addEventListener("click", () => send({ type: "checkUpdates" }));

  send({ type: "ready" });
})();
