(function () {
  "use strict";
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);

  let S = null; // último estado vindo da extensão
  let draft = null; // regras em edição (só vão para o cswap ao salvar)
  let rulesDirty = false;
  let acctHold = false; // usuário mexendo num card de conta: não redesenhar
  let acctPending = false;
  let toastTimer = null;
  const saved = vscode.getState() || {};
  let sortByReset = !!saved.sortByReset;

  const STRATS = [
    {
      id: "best",
      name: "Mais folga",
      tag: "padrão",
      desc: "Só troca quando a conta ativa chega na linha de troca. Vai para a conta com mais cota livre.",
    },
    {
      id: "weekly-first",
      name: "Semanal primeiro",
      desc: "Só troca na linha de troca, mas escolhe a conta cujo semanal renova antes — gasta primeiro a cota que está prestes a zerar.",
    },
    {
      id: "consume-first",
      name: "Aproveitar ao máximo",
      tag: "menos desperdício",
      desc: "Fica sempre na conta cujo semanal renova antes, mesmo sem bater a linha de troca. Entre as que renovam juntas, vai na que tem mais cota sobrando. Troca mais vezes.",
    },
    {
      id: "priority-consume-first",
      name: "Por prioridade",
      desc: "Como “Aproveitar ao máximo”, mas respeitando a prioridade que você der a cada conta (número maior primeiro).",
    },
  ];

  const KIND_LABELS = {
    switch: "Troca automática",
    manual: "Troca manual",
    blocked: "Bloqueado",
    error: "Erro",
    warn: "Aviso",
    alert: "Alerta de uso",
    info: "Info",
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
  const num = (v, d) => (v === null || v === undefined || v === "" || isNaN(Number(v)) ? d : Number(v));
  const clamp = (v) => Math.max(0, Math.min(100, Number(v) || 0));
  const sev = (pct) => (pct >= 85 ? "bad" : pct >= 70 ? "warn" : "");
  const fmt = (v) => String(Math.round(Number(v) * 10) / 10).replace(".", ",");

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

  function parseModels(value, names) {
    if (!value) return [];
    if (String(value).trim().toLowerCase() === "all") return [...names];
    return String(value).split(",").map((s) => s.trim()).filter(Boolean);
  }

  function draftFromState() {
    const r = S.rules;
    const th = num(r["autoswitch.threshold"], 90);
    return {
      th5h: th,
      thWeekly: num(r["autoswitch.weeklyThreshold"], th),
      strategy: r["autoswitch.strategy"] || "best",
      models: parseModels(r["autoswitch.model"], S.modelNames),
      interval: num(r["autoswitch.intervalSeconds"], 60),
      cooldownMin: Math.round(num(r["autoswitch.cooldownSeconds"], 300) / 60),
      hyst: num(r["autoswitch.hysteresisPct"], 10),
      alerts: { ...S.alerts },
    };
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
    const range = h("input", { type: "range", min: o.min, max: o.max, step: o.step, value: o.value, disabled: off || o.readonly });
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
      const f = h("div", { class: "tfill " + sev(current) });
      f.style.width = clamp(current) + "%";
      t.append(f);
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

  function moveMark(m, pct) {
    m.pct = pct;
    if (m.el) {
      m.el.style.left = clamp(pct) + "%";
      m.el.title = `${m.cls === "alert" ? "Avisa" : "Troca"} em ${fmt(pct)}%`;
    }
  }

  function nowText(w) {
    if (!w) return "conta ativa: sem dados";
    return `conta ativa: ${fmt(w.pct)}%${w.in ? ` · renova em ${w.in}` : ""}`;
  }

  // ------------------------------------------------------------ regras

  function renderRules() {
    const box = $("rules");
    box.replaceChildren();
    const act = activeAccount();
    const autoOn = S.auto.enabled;
    const switchHint = autoOn ? null : "Só troca com a “Troca automática” ligada lá em cima.";

    // --- janela de 5 horas
    {
      const mA = { cls: "alert", pct: draft.alerts.fiveHourPct, show: draft.alerts.fiveHourEnabled };
      const mS = { cls: "switch", pct: draft.th5h, show: true };
      const cur = act && act.fiveHour ? act.fiveHour : null;
      box.append(
        h(
          "div",
          { class: "rulegroup" },
          h("div", { class: "rulehead" }, h("h4", { text: "Janela de 5 horas" }), h("span", { class: "now", text: nowText(cur) })),
          track(cur ? cur.pct : null, [mA, mS]),
          sliderRow({
            label: "Avisar quando chegar em",
            toggle: true,
            enabled: draft.alerts.fiveHourEnabled,
            value: draft.alerts.fiveHourPct,
            min: 30, max: 99, step: 1, suffix: "%",
            onToggle: (v) => { draft.alerts.fiveHourEnabled = v; markDirty(); renderRules(); },
            onInput: (v) => { draft.alerts.fiveHourPct = v; moveMark(mA, v); markDirty(); },
          }),
          sliderRow({
            label: "Trocar de conta quando chegar em",
            value: draft.th5h,
            min: 50, max: 99, step: 1, suffix: "%",
            hint: switchHint,
            onInput: (v) => { draft.th5h = v; moveMark(mS, v); markDirty(); },
          })
        )
      );
    }

    // --- semanal (todos os modelos)
    {
      const mA = { cls: "alert", pct: draft.alerts.weeklyPct, show: draft.alerts.weeklyEnabled };
      const mS = { cls: "switch", pct: draft.thWeekly, show: true };
      const cur = act && act.sevenDay ? act.sevenDay : null;
      box.append(
        h(
          "div",
          { class: "rulegroup" },
          h("div", { class: "rulehead" }, h("h4", { text: "Limite semanal (todos os modelos)" }), h("span", { class: "now", text: nowText(cur) })),
          track(cur ? cur.pct : null, [mA, mS]),
          sliderRow({
            label: "Avisar quando chegar em",
            toggle: true,
            enabled: draft.alerts.weeklyEnabled,
            value: draft.alerts.weeklyPct,
            min: 30, max: 99, step: 1, suffix: "%",
            onToggle: (v) => { draft.alerts.weeklyEnabled = v; markDirty(); renderRules(); },
            onInput: (v) => { draft.alerts.weeklyPct = v; moveMark(mA, v); markDirty(); },
          }),
          sliderRow({
            label: "Trocar de conta quando chegar em",
            value: draft.thWeekly,
            min: 50, max: 99, step: 1, suffix: "%",
            hint: switchHint,
            onInput: (v) => {
              draft.thWeekly = v;
              moveMark(mS, v);
              markDirty();
              document.querySelectorAll("[data-weekly-line]").forEach((el) => (el.textContent = fmt(v) + "%"));
              modelMarks.forEach((m) => moveMark(m, v));
            },
          })
        )
      );
    }

    // --- semanal por modelo (Fable etc.)
    const modelMarks = [];
    for (const name of S.modelNames) {
      const on = draft.models.includes(name);
      const mA = { cls: "alert", pct: draft.alerts.modelPct, show: draft.alerts.modelEnabled };
      const mS = { cls: "switch", pct: draft.thWeekly, show: on };
      modelMarks.push(mS);
      const sc = act ? act.scoped.find((s) => s.name === name) : null;
      const switchRow = h(
        "div",
        { class: "rule" + (on ? "" : " off") },
        h(
          "label",
          { class: "tg" },
          h("input", {
            type: "checkbox",
            checked: on,
            onchange: (e) => {
              draft.models = e.target.checked ? [...new Set([...draft.models, name])] : draft.models.filter((m) => m !== name);
              markDirty();
              renderRules();
            },
          }),
          h("span", { text: `Trocar de conta quando o ${name} chegar na linha do semanal` })
        ),
        h("span", { class: "fixed", text: "usa a mesma linha do limite semanal acima" }),
        h("span", { class: "val", "data-weekly-line": "1", text: fmt(draft.thWeekly) + "%" }),
        !on ? h("small", { class: "hint", text: `Desligado: o ${name} pode esgotar numa conta sem a troca acontecer, se o semanal geral ainda tiver folga.` }) : null
      );
      box.append(
        h(
          "div",
          { class: "rulegroup" },
          h("div", { class: "rulehead" }, h("h4", { text: `Limite semanal do ${name}` }), h("span", { class: "now", text: nowText(sc) })),
          track(sc ? sc.pct : null, [mA, mS]),
          sliderRow({
            label: "Avisar quando chegar em",
            toggle: true,
            enabled: draft.alerts.modelEnabled,
            value: draft.alerts.modelPct,
            min: 30, max: 99, step: 1, suffix: "%",
            onToggle: (v) => { draft.alerts.modelEnabled = v; markDirty(); renderRules(); },
            onInput: (v) => { draft.alerts.modelPct = v; moveMark(mA, v); markDirty(); },
          }),
          switchRow
        )
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

    // --- avançado
    $("advanced").replaceChildren(
      sliderRow({
        label: "Verificar a cada",
        value: draft.interval, min: 15, max: 600, step: 15, suffix: " s",
        onInput: (v) => { draft.interval = v; markDirty(); },
      }),
      sliderRow({
        label: "Tempo mínimo entre trocas",
        value: draft.cooldownMin, min: 0, max: 60, step: 1, suffix: " min",
        hint: "Evita trocas em sequência. Não vale quando a conta bate o limite de verdade.",
        onInput: (v) => { draft.cooldownMin = v; markDirty(); },
      }),
      sliderRow({
        label: "Folga mínima da conta de destino",
        value: draft.hyst, min: 0, max: 30, step: 1, suffix: " pts",
        hint: "A conta de destino precisa ter pelo menos essa folga a mais. Evita ficar pulando entre duas contas parecidas.",
        onInput: (v) => { draft.hyst = v; markDirty(); },
      })
    );
  }

  function saveRules() {
    const values = {
      "autoswitch.threshold": draft.th5h,
      "autoswitch.weeklyThreshold": draft.thWeekly,
      "autoswitch.strategy": draft.strategy,
      "autoswitch.model": draft.models.length ? draft.models.join(",") : null,
      "autoswitch.intervalSeconds": draft.interval,
      "autoswitch.cooldownSeconds": draft.cooldownMin * 60,
      "autoswitch.hysteresisPct": draft.hyst,
    };
    rulesDirty = false;
    $("rulesDirty").classList.add("hidden");
    send({ type: "saveRules", values, alerts: draft.alerts });
  }

  // ------------------------------------------------------------ contas

  function meter(label, w) {
    if (!w) return h("div", { class: "meter" }, h("span", { class: "lbl", text: label }), h("div", { class: "bar" }), h("span", { class: "pct muted", text: "—" }));
    const fill = h("div", { class: "fill " + sev(w.pct) });
    fill.style.width = clamp(w.pct) + "%";
    return h(
      "div",
      { class: "meter" },
      h("span", { class: "lbl", text: label }),
      h("div", { class: "bar" }, fill),
      h("span", { class: "pct", text: fmt(w.pct) + "%" }),
      w.in ? h("span", { class: "reset", text: `renova em ${w.in}${w.when ? ` · ${w.when}` : ""}` }) : null
    );
  }

  /** Cota semanal que vai zerar em menos de 24 h sem ter sido usada. */
  function wasteNote(a) {
    const w = a.sevenDay;
    if (!w || !w.resetTs || a.disabled) return null;
    const hours = (w.resetTs - Date.now()) / 3600000;
    const left = 100 - w.pct;
    if (hours <= 0 || hours > 24 || left < 25) return null;
    return h("div", { class: "waste", text: `Zera em ${w.in} com ${fmt(left)}% do semanal sem usar` });
  }

  function accountCard(a) {
    const strategy = draft ? draft.strategy : S.rules["autoswitch.strategy"];
    const prioMatters = strategy === "priority-consume-first";
    const globalTh = draft ? draft.th5h : num(S.rules["autoswitch.threshold"], 90);
    const own = a.threshold !== null && a.threshold !== undefined;
    const acct = (op, value) => send({ type: "account", number: a.number, op, value });

    const thVal = h("span", { class: "val" + (own ? "" : " dim"), text: fmt(own ? a.threshold : globalTh) + "%" });
    const thRange = h("input", { type: "range", min: 50, max: 99, step: 1, value: own ? a.threshold : globalTh, disabled: !own });
    thRange.addEventListener("input", () => (thVal.textContent = fmt(thRange.value) + "%"));
    thRange.addEventListener("change", () => acct("threshold", Number(thRange.value)));

    const prMax = Math.max(10, a.priority || 0);
    const prVal = h("span", { class: "val", text: String(a.priority || 0) });
    const prRange = h("input", { type: "range", min: 0, max: prMax, step: 1, value: a.priority || 0 });
    prRange.addEventListener("input", () => (prVal.textContent = prRange.value));
    prRange.addEventListener("change", () => acct("priority", Number(prRange.value)));

    return h(
      "div",
      { class: "acct" + (a.active ? " active" : "") + (a.disabled ? " off" : "") },
      h(
        "div",
        { class: "ahead" },
        h(
          "div",
          null,
          h("div", { class: "aname" }, h("span", { class: "n", text: `#${a.number}` }), a.alias || a.email),
          h("div", { class: "sub", text: [a.alias ? a.email : null, a.plan, a.org].filter(Boolean).join(" · ") })
        ),
        h(
          "div",
          { class: "badges" },
          a.active ? h("span", { class: "badge on", text: "Em uso" }) : null,
          a.disabled ? h("span", { class: "badge plain", text: "Fora da rotação" }) : null,
          a.status && a.status !== "ok" ? h("span", { class: "badge plain", text: a.statusLabel }) : null
        )
      ),
      h("div", { class: "meters" }, meter("5 horas", a.fiveHour), meter("Semanal", a.sevenDay), a.scoped.map((s) => meter(s.name, s))),
      wasteNote(a),
      h(
        "div",
        { class: "ctl" },
        h("label", null, h("input", { type: "checkbox", checked: !a.disabled, onchange: (e) => acct("disabled", !e.target.checked) }), "Participa da troca automática")
      ),
      h(
        "div",
        { class: "ctl" },
        h(
          "label",
          null,
          h("input", {
            type: "checkbox",
            checked: own,
            onchange: (e) => acct("threshold", e.target.checked ? Number(thRange.value) : null),
          }),
          "Limite próprio de 5h (sair desta conta em)"
        ),
        thRange,
        thVal
      ),
      h("div", { class: "ctl" + (prioMatters ? "" : " dim") }, h("span", { class: "cap", text: prioMatters ? "Prioridade (maior = usada primeiro)" : "Prioridade (só na estratégia “Por prioridade”)" }), prRange, prVal),
      h(
        "div",
        { class: "afoot" },
        h("input", {
          type: "text",
          placeholder: "apelido",
          value: a.alias || "",
          maxlength: "24",
          onchange: (e) => acct("alias", e.target.value.trim()),
        }),
        h("button", { class: "secondary", disabled: a.active, text: a.active ? "Em uso" : "Usar esta conta", onclick: () => send({ type: "switch", number: a.number }) })
      )
    );
  }

  function renderAccounts(force) {
    if (acctHold && !force) {
      acctPending = true;
      return;
    }
    acctPending = false;
    const list = [...S.accounts];
    if (sortByReset) {
      list.sort((a, b) => {
        const ra = a.sevenDay && a.sevenDay.resetTs ? a.sevenDay.resetTs : Infinity;
        const rb = b.sevenDay && b.sevenDay.resetTs ? b.sevenDay.resetTs : Infinity;
        if (ra !== rb) return ra - rb;
        return (a.sevenDay ? a.sevenDay.pct : 100) - (b.sevenDay ? b.sevenDay.pct : 100);
      });
    }
    const sortBox = h(
      "label",
      { class: "check" },
      h("input", {
        type: "checkbox",
        checked: sortByReset,
        onchange: (e) => {
          sortByReset = e.target.checked;
          vscode.setState({ ...(vscode.getState() || {}), sortByReset });
          renderAccounts(true);
        },
      }),
      "Ordenar por quem renova o semanal primeiro (menos usada na frente)"
    );
    const grid = h("div", { class: "accounts" }, list.length ? list.map(accountCard) : h("p", { class: "muted", text: "Nenhuma conta cadastrada ainda." }));
    $("accounts").replaceWith(h("div", { id: "accounts" }, sortBox, grid));
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

  function renderAuto() {
    $("autoToggle").checked = S.auto.enabled;
    const r = S.rules;
    const st = STRATS.find((s) => s.id === (r["autoswitch.strategy"] || "best"));
    const th = num(r["autoswitch.threshold"], 90);
    $("autoStatus").textContent = S.auto.enabled
      ? `Ligada — verifica a cada ${fmt(num(r["autoswitch.intervalSeconds"], 60))} s · troca em 5h ≥ ${fmt(th)}% ou semanal ≥ ${fmt(num(r["autoswitch.weeklyThreshold"], th))}% · ${st ? st.name : r["autoswitch.strategy"]}`
      : "Desligada — nenhuma troca acontece sozinha. Os avisos continuam funcionando.";
    const last = S.auto.last;
    $("autoLast").textContent = last ? `Última verificação (${S.auto.lastWhen || "?"}): ${last.text}` : "";
  }

  function renderUi() {
    const set = (key, value) => send({ type: "ui", key, value });
    $("uiBox").replaceChildren(
      h("label", { class: "check" }, h("input", { type: "checkbox", checked: S.ui.showAccountNumber, onchange: (e) => set("statusBar.showAccountNumber", e.target.checked) }), "Mostrar o número da conta ao lado do ícone de e-mail"),
      h("label", { class: "check" }, h("input", { type: "checkbox", checked: S.ui.showModelWeekly, onchange: (e) => set("statusBar.showModelWeekly", e.target.checked) }), "Mostrar o semanal por modelo (ex.: Fable) na barra"),
      h(
        "div",
        { class: "uirule" },
        sliderRow({
          label: "Atualizar o uso a cada",
          value: S.ui.pollIntervalMinutes, min: 0.5, max: 10, step: 0.5, suffix: " min",
          onInput: () => {},
          onCommit: (v) => set("pollIntervalMinutes", v),
        })
      )
    );
  }

  function renderHistory() {
    const items = S.auto.history || [];
    $("history").replaceChildren(
      ...(items.length
        ? items.map((it) => h("li", null, h("span", { class: "when", text: it.when || "" }), h("span", { class: "kind " + it.kind, text: KIND_LABELS[it.kind] || it.kind }), h("span", { text: it.text })))
        : [h("li", { class: "empty", text: "Nada por aqui ainda. Trocas, alertas e bloqueios aparecem nesta lista." })])
    );
  }

  function renderAll() {
    const err = $("errorBox");
    if (S.error) {
      err.textContent = `Não consegui executar o swap-plus: ${S.error}`;
      err.classList.remove("hidden");
    } else {
      err.classList.add("hidden");
    }
    if (!rulesDirty || !draft) {
      draft = draftFromState();
      rulesDirty = false;
      $("rulesDirty").classList.add("hidden");
    }
    renderAuto();
    renderRules();
    renderAccounts();
    renderUi();
    renderHistory();
  }

  // ------------------------------------------------------------ eventos

  window.addEventListener("message", (ev) => {
    const m = ev.data;
    if (m.type === "state") {
      S = m;
      renderAll();
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
  $("btnCheck").addEventListener("click", () => send({ type: "checkNow", dryRun: false }));
  $("btnSim").addEventListener("click", () => send({ type: "checkNow", dryRun: true }));
  $("btnSave").addEventListener("click", saveRules);
  $("btnUndo").addEventListener("click", () => {
    rulesDirty = false;
    draft = null;
    if (S) renderAll();
  });
  $("btnAdd").addEventListener("click", () => send({ type: "add" }));
  $("btnClear").addEventListener("click", () => send({ type: "clearHistory" }));

  send({ type: "ready" });
})();
