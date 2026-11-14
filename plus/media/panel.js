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
  const saved = vscode.getState() || {};
  let manualOrder = !!saved.manualOrder; // padrão: ordem automática (quem participa e renova antes primeiro)

  const STRATS = [
    {
      id: "headroom",
      name: "Mais folga",
      tag: "padrão",
      desc: "Troca só quando a conta ativa chega numa linha de troca e vai para a conta com mais folga.",
    },
    {
      id: "max",
      name: "Aproveitar ao máximo",
      tag: "menos desperdício",
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
              label: "Trocar de conta quando chegar em",
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
      const watching = (S.watch || []).includes(name);
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
      const cc = S.claudeCode || {};
      const ccBox = same
        ? h(
            "div",
            { class: "ccbox" + (cc.ready ? " ok" : "") },
            cc.error
              ? h("span", { text: `Não consegui ler as configurações do Claude Code: ${cc.error}` })
              : cc.ready
                ? h("span", null, h("b", { class: "ontext", text: "Claude Code pronto: " }), `quando o ${name} acabar, ele oferece o Opus 5.5${cc.opusEffort ? `, no esforço ${cc.opusEffort} (o mesmo do ${name})` : ""}.`)
                : h(
                    "span",
                    null,
                    `O Claude Code ainda não está preparado: hoje ele ofereceria ${cc.opusDefault ? "o Opus" : `o modelo padrão (${cc.model || "o do plano"})`}${cc.opusEffort ? ` no esforço ${cc.opusEffort}` : ""}. `,
                    h("button", { class: "secondary", text: "Deixar pronto", onclick: () => send({ type: "prepareClaudeCode" }) })
                  ),
            h("div", {
              class: "muted small",
              text: `O Swap Plus não consegue trocar o modelo de uma conversa aberta (o Claude Code não deixa). Quando o ${name} acabar, ele pergunta “Switch models?”: escolha “Switch to Opus 5.5”. Vale para a conversa, na mesma conta. O Swap Plus avisa antes, na linha de aviso acima.`,
            })
          )
        : null;
      box.append(
        group(`Limite semanal do ${name}`, sc, "usado", "modelPct", "modelEnabled", "modelPct", null, {
          badge: h("span", { class: "tag" + (watching ? " on" : ""), text: watching ? "em uso agora" : "não está em uso" }),
          noSwitch: same,
          before: h(
            "div",
            { class: "onlimit" },
            h("div", { class: "cap", text: `Quando o ${name} acabar na conta em uso:` }),
            h(
              "div",
              { class: "strategies two" },
              choice("sameAccount", "Seguir na mesma conta com o Opus 5.5", `A conta não muda. O Claude Code pergunta e você troca para o Opus 5.5 na mesma conversa. Prioriza o ${name} enquanto houver.`),
              choice("switchAccount", `Trocar de conta para continuar no ${name}`, `O Swap Plus troca para outra conta que ainda tem ${name}, na linha de troca abaixo.`)
            ),
            ccBox
          ),
          hint: watching
            ? `O ${name} está em uso: esta linha vale agora.` + (autoOn ? "" : " (Só troca com a “Troca automática” ligada.)")
            : `Vale quando o ${name} estiver em uso. Agora ele não está, então só a sessão e o semanal decidem.`,
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

    // --- avançado
    $("advanced").replaceChildren(
      sliderRow({
        label: "Verificar a cada",
        value: draft.intervalSec, min: 15, max: 600, step: 15, suffix: " s",
        onInput: (v) => { draft.intervalSec = v; markDirty(); },
      }),
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

  function accountCard(a, idx, total) {
    const strategy = draft ? draft.strategy : S.rules.strategy;
    const prioMatters = strategy === "priority";
    const globalTh = draft ? draft.sessionPct : S.rules.sessionPct;
    const own = a.threshold !== null && a.threshold !== undefined;
    const acct = (op, value) => send({ type: "account", number: a.number, op, value });

    const thVal = h("span", { class: "val" + (own ? "" : " dim"), text: fmt(own ? a.threshold : globalTh) + "%" });
    const thRange = h("input", { type: "range", min: 50, max: 100, step: 1, value: own ? a.threshold : globalTh, disabled: !own });
    thRange.addEventListener("input", () => (thVal.textContent = fmt(thRange.value) + "%"));
    thRange.addEventListener("change", () => acct("threshold", Number(thRange.value)));

    const prMax = Math.max(10, a.priority || 0);
    const prVal = h("span", { class: "val", text: String(a.priority || 0) });
    const prRange = h("input", { type: "range", min: 0, max: prMax, step: 1, value: a.priority || 0 });
    prRange.addEventListener("input", () => (prVal.textContent = prRange.value));
    prRange.addEventListener("change", () => acct("priority", Number(prRange.value)));

    return h(
      "div",
      { class: "acct" + (a.active ? " active" : "") + (a.disabled ? " off" : " rot") },
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
          !manualOrder
            ? null
            : h(
                "div",
                { class: "order" },
                h("button", { class: "secondary arrow", title: "Subir uma posição", disabled: idx === 0, text: "↑", onclick: () => send({ type: "move", number: a.number, dir: "up" }) }),
                h("button", { class: "secondary arrow", title: "Descer uma posição", disabled: idx === total - 1, text: "↓", onclick: () => send({ type: "move", number: a.number, dir: "down" }) })
              ),
          a.active ? h("span", { class: "badge on", text: "Em uso" }) : null,
          a.disabled ? h("span", { class: "badge plain", text: "Fora da rotação" }) : null,
          a.status && a.status !== "ok" ? h("span", { class: "badge plain", text: a.statusLabel }) : null
        )
      ),
      h("div", { class: "meters" }, meter("Sessão 5h", a.session), meter("Semanal", a.weekly), a.models.map((m) => meter(m.name, m))),
      wasteNote(a),
      h(
        "div",
        { class: "ctl" },
        h("label", null, h("input", { type: "checkbox", class: "rotbox", checked: !a.disabled, onchange: (e) => acct("disabled", !e.target.checked) }), "Participa da troca automática")
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
          "Linha própria da sessão de 5h"
        ),
        thRange,
        thVal
      ),
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
  }

  function renderAccounts(force) {
    if (acctHold && !force) {
      acctPending = true;
      return;
    }
    acctPending = false;
    const list = [...S.accounts];
    if (manualOrder) {
      list.sort((a, b) => a.number - b.number);
    } else {
      // Primeiro quem participa da troca automática; dentro de cada grupo, quem renova o semanal antes.
      const reset = (a) => (a.weekly && a.weekly.resetTs ? a.weekly.resetTs : Infinity);
      list.sort((a, b) => Number(a.disabled) - Number(b.disabled) || reset(a) - reset(b) || (a.weekly ? a.weekly.pct : 100) - (b.weekly ? b.weekly.pct : 100) || a.number - b.number);
    }
    const sortBox = h(
      "label",
      { class: "check" },
      h("input", {
        type: "checkbox",
        checked: manualOrder,
        onchange: (e) => {
          manualOrder = e.target.checked;
          vscode.setState({ ...(vscode.getState() || {}), manualOrder });
          renderAccounts(true);
        },
      }),
      "Ordenar pelo número da conta (e mudar a posição com as setas ↑ ↓)"
    );
    const hint = h("p", {
      class: "muted small",
      text: manualOrder
        ? "As setas ↑ ↓ mudam a posição (o número) da conta. Apelido, ajustes e histórico vão junto; a sessão aberta não é afetada."
        : "Ordem automática: primeiro as contas que participam da troca automática, de quem renova o semanal antes para quem renova depois; no fim, as que não participam, na mesma ordem.",
    });
    const grid = h("div", { class: "accounts" }, list.length ? list.map((a, i) => accountCard(a, i, list.length)) : h("p", { class: "muted", text: "Nenhuma conta cadastrada ainda." }));
    const act = S.accounts.find((a) => a.active);
    const inUse = h(
      "div",
      { class: "inuse" },
      h("span", { class: "dot on" }),
      "Em uso agora: ",
      h("b", { text: act ? `Conta ${act.number}${!S.privacy && act.email ? ` — ${act.email}` : ""}` : "nenhuma conta" }),
      act && act.session ? ` · sessão ${fmt(act.session.pct)}%` : "",
      act && act.weekly ? ` · semanal ${fmt(act.weekly.pct)}%` : ""
    );
    $("accounts").replaceWith(h("div", { id: "accounts" }, inUse, sortBox, hint, grid));
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
    const st = STRATS.find((s) => s.id === r.strategy);
    const models = !S.modelNames.length
      ? ""
      : r.onModelLimit === "switchAccount"
        ? `, ${S.modelNames.join("/")} ≥ ${fmt(r.modelPct)}% (quando em uso)`
        : ` · quando o ${S.modelNames.join("/")} acaba, segue na mesma conta com o Opus 5.5`;
    $("autoStatus").replaceChildren(
      h("span", { class: "dot" + (S.auto.enabled ? " on" : "") }),
      S.auto.enabled ? h("b", { class: "ontext", text: "Ligada" }) : h("b", { text: "Desligada" }),
      S.auto.enabled
        ? ` — verifica a cada ${fmt(r.intervalSec)} s · troca em sessão ≥ ${fmt(r.sessionPct)}%, semanal ≥ ${fmt(r.weeklyPct)}%${models} · ${st ? st.name : r.strategy}`
        : " — nenhuma troca acontece sozinha. Os avisos continuam funcionando."
    );
    const last = S.auto.last;
    $("autoLast").textContent = last ? `Última verificação (${S.auto.lastWhen || "?"}): ${last.text}` : "";
  }

  function renderUi() {
    const set = (key, value) => send({ type: "ui", key, value });
    $("uiBox").replaceChildren(
      h("label", { class: "check" }, h("input", { type: "checkbox", checked: S.privacy, onchange: (e) => set("privacy.hideEmails", e.target.checked) }), "Modo privado: mostrar só “Conta N”, sem e-mail"),
      h("p", {
        class: "muted small privnote",
        text: "Vale para a barra, a lista de contas, esta tela e os avisos do Swap Plus. Não é uma trava: o painel de conta do próprio Claude Code e o comando swap-plus list continuam mostrando o e-mail, e quem usa este computador usa as contas.",
      }),
      h("label", { class: "check" }, h("input", { type: "checkbox", checked: S.ui.showAccountNumber, onchange: (e) => set("statusBar.showAccountNumber", e.target.checked) }), "Mostrar o número da conta ao lado do ícone de e-mail"),
      h("label", { class: "check" }, h("input", { type: "checkbox", checked: S.ui.showModelWeekly, onchange: (e) => set("statusBar.showModelWeekly", e.target.checked) }), "Mostrar o semanal por modelo (ex.: Fable) na barra"),
      h("p", { class: "muted small", text: "Cor do item na barra: normal abaixo de 70%, amarelo a partir de 70% e vermelho na linha de troca — vale o limite mais perto do fim." }),
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
      h("span", { class: "nm", text: "Motor (swap-plus)" }),
      cell(L ? L.cli.installed : null),
      cell(L ? L.cli.latest : null, L && newer(L.cli.latest, L.cli.installed)),
      cell(L ? L.cli.upstream : null, L && newer(L.cli.upstream, L.cli.latest)),
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
        text: `Verifica ao abrir e ao fechar o VS Code e a cada 2 dias, tudo dentro do VS Code. ${u.autoUpdate ? "Instala sozinho, como as outras extensões (Extensions: Auto Update ligado)." : "Só avisa, porque o Auto Update de extensões do VS Code está desligado."} Ao fechar, só verifica: se houver versão nova, ela é instalada na próxima abertura. Versão nova do original: o GitHub roda os testes do original e só então prepara o motor no seu fork.${u.pendingOnOpen ? " Há versão nova esperando a próxima abertura do VS Code." : ""}`,
      })
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
    renderUpdates();
    renderHistory();
    $("rowExportMe").classList.toggle("hidden", !!S.privacy);
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
  $("btnExportOther").addEventListener("click", () => send({ type: "export", mode: "other" }));
  $("btnExportMe").addEventListener("click", () => send({ type: "export", mode: "me" }));
  $("btnImport").addEventListener("click", () => send({ type: "import" }));
  $("btnUpdates").addEventListener("click", () => send({ type: "checkUpdates" }));

  send({ type: "ready" });
})();
