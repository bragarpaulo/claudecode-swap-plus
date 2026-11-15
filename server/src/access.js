"use strict";
// Computadores permitidos por conta Claude (WEB-SPEC 2.3): cada conta Claude diz quais computadores podem usá-la.
//
// No cofre:   state.accountDevices = { "<número da conta>": null | [deviceId, ...] }
//   - sem entrada (ou null) = TODOS os computadores, inclusive os que conectarem depois;
//   - lista = só esses computadores (computador novo NÃO entra sozinho: só usa as contas com "Todos");
//   - lista vazia = nenhum computador usa a conta;
//   - valor estragado (nem lista nem null) = nenhum computador (fecha em vez de liberar tudo);
//   - tabela inteira ausente (cofre de antes da 2.3) = sem restrição nenhuma.
// Vale igual para todo computador (conectado com Google ou pareado por código; administrador ou não).
// Regras de troca: as gerais ({ ...RULE_DEFAULTS, ...state.rules }), iguais para todos — nada aqui.
//
// Funções puras (só leem/mudam o `state` recebido; não gravam o cofre, não registram histórico).
//
// =====================================================================================================
// COMO INTEGRAR NO MOTOR (server/src/engine.js)
// =====================================================================================================
//   const access = require("./access");
//   ERROR_STATUS: acrescentar  not_allowed: 409   (not_found e invalid já existem)
//
// 1) records() fica como está (é o global: vai para a extensão em stateFor e para o painel). Nunca mandar para
//    a extensão nem gravar o resultado de filterRecordsForDevice: ele marca `disabled: true` nas contas não
//    permitidas, e a tela mostraria "fora da rotação" (e o botão inverteria o ajuste de verdade). Auxiliar:
//        recordsFor(dev) { return access.filterRecordsForDevice(this.records(), this.st, dev); }
//
// 2) needsAssign(dev): depois de `if (cur.dead) return "dead";` e ANTES do teste de `disabled`:
//        if (!access.canUse(this.st, dev, cur.number)) return "not_allowed";
//    (vale com a troca automática ligada ou desligada: é permissão, não preferência.)
//
// 3) assignBest(dev, why): no mapa de motivos,
//        not_allowed: `a conta ${from} não está liberada para este computador`
//    e, quando `to === null`, tratar "not_allowed" igual a "removed" (dev.assigned = null + alerta
//    "Nenhuma conta disponível para ..."), para o computador nunca ficar numa conta não permitida.
//
// 4) decideDevice(dev) e limitHit(deviceId): trocar `const base = this.records();` por
//        const base = this.recordsFor(dev);
//    As DUAS chamadas de decide() (a com as contas dos outros dispositivos bloqueadas e a de reserva
//    "dividir é melhor que parar") usam `base`: a reserva nunca abre uma conta não permitida.
//
// 5) bestAccountFor(dev, ...): trocar `const recs = this.records();` por
//        const recs = this.recordsFor(dev);       // dev null → sem restrição
//    Isso cobre assignBest, spreadOut e switchDevice(id, null) ("melhor conta").
//
// 6) switchDevice(deviceId, number): no ramo com número, depois dos testes de "não existe" e "morta":
//        if (!access.canUse(this.st, dev, n)) throw fail("not_allowed",
//          `a conta ${n} não está liberada para o computador "${dev.name || dev.id}"; libere no painel (Contas → Computadores permitidos)`);
//    (vale para a extensão — POST /v1/switch — e para o painel — POST /web/api/devices/:id/switch.)
//
// 7) credentialFor(deviceId): nunca entregar acesso de conta não permitida (a regra pode mudar durante o await):
//        if (!acc || acc.dead || !acc.cred || !acc.cred.accessToken || !access.canUse(this.st, dev, acc.number)) return null;
//    e, depois da renovação,
//        if (!cur || cur.dead || cur !== acc || !access.canUse(this.st, d2, cur.number)) continue;
//    (na volta do laço o needsAssign → "not_allowed" troca a conta.)
//
// 8) removeAccount(number): depois de apagar a conta e antes do `await this.save()`:
//        access.onAccountRemoved(this.st, n);
//    (addLogin pode reaproveitar um número livre — wantNumber —; sem isso a conta nova herdaria a lista da antiga.)
//
// 9) Todo lugar que apaga um computador (`delete st.devices[id]`) chama, logo depois e antes de gravar:
//        access.onDeviceRemoved(st, id);
//    Hoje em server.js: revokeDevice, sweepLogins (computador órfão do login com Google) e o desfazer do
//    callback do Google quando o cofre não grava. Lista que fica vazia continua vazia (nunca vira "todos").
//
// 10) Método novo (o painel chama este, não o access.setAccountDevices direto):
//        async setAccountDevices(number, devices) {
//          const value = access.setAccountDevices(this.st, number, devices);   // lança .code "not_found" / "invalid"
//          const n = Number(number);
//          this.pushHistory("info", `Computadores que podem usar a conta ${n}: ${access.devicesLabel(this.st, value)}`, null);
//          for (const d of this.deviceList()) {
//            if (Number(d.assigned) !== n || access.canUse(this.st, d, n)) continue;
//            if (this.isActive(d)) this.decideDevice(d); else d.assigned = null;   // troca já (ou na próxima conexão)
//          }
//          this.dirty = true;
//          await this.save();
//          return value;
//        }
//
// 11) (opcional) toPublic/publicList(deviceId): `allowed: access.canUse(this.st, dev, a.number)` — campo novo
//     (a extensão ignora campos que não conhece) para a lista do VS Code mostrar quais contas este computador pode usar.
// (Opcional) store.js: `accountDevices: {}` no estado inicial; sem isso funciona igual (faltando = todos).
//
// =====================================================================================================
// COMO INTEGRAR NO PAINEL (server/src/web.js e server/web/*)
// =====================================================================================================
// Rota:  PUT /web/api/accounts/:n/devices   corpo { devices: null | [deviceId, ...] }   (CSRF como as outras)
//    { m: "PUT", p: /^\/web\/api\/accounts\/(\d{1,6})\/devices$/, body: true, fn: panel(putAccountDevices, change) }
//    - needAccount(n) (404 como as outras rotas de conta);
//    - corpo sem a chave `devices` → 400 (null precisa vir escrito: null = todos os computadores);
//    - `const devices = await engine.setAccountDevices(n, body.devices)` (erro .code "invalid" → 400 com a
//      mensagem em português do erro); note(`Computadores da conta ${n} ajustados pelo painel (${me})`);
//      resposta done(sess, { number: n, devices }).
// PanelState:
//    - cada conta:       devices: access.accountDevicesFor(st, a.number)     // null = todos; [id...] = só esses
//    - cada computador:  allowedAccounts: access.allowedAccountsList(st, d)  // [n...] (sempre lista, em ordem)
// Tela Contas, no cartão de cada conta, "Computadores permitidos":
//    - caixa "Todos" marcada quando devices === null (inclui os computadores que conectarem depois);
//    - desmarcada: uma caixa por computador (nome, sistema, usuário/conta Google), marcadas as da lista; ao
//      desmarcar "Todos", começar com todos os computadores atuais marcados (para não tirar ninguém de surpresa);
//      nenhuma marcada → aviso "Nenhum computador pode usar esta conta";
//    - Salvar → PUT { devices: null } (Todos) ou { devices: [id, ...] }.
// Tela Computadores: "trocar de conta" oferece só `allowedAccounts` do computador (+ "melhor conta"); sem nenhuma
//    → "Nenhuma conta liberada para este computador (veja Contas → Computadores permitidos)".
// =====================================================================================================

const { emailKey } = require("./google");

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function fail(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/**
 * Chave para comparar contas Google — a mesma emailKey do google.js (minúsculas; em gmail.com / googlemail.com
 * a parte local perde os pontos e o "+algo" e o domínio vira gmail.com). "" se não parecer e-mail.
 */
function normalizeEmail(v) {
  return emailKey(v);
}

/** Número de conta (inteiro > 0; aceita também "2" em texto, como vem da URL) ou null. */
function accountNumberOf(v) {
  if (typeof v === "number") return Number.isInteger(v) && v > 0 ? v : null;
  if (typeof v === "string" && /^[1-9]\d{0,8}$/.test(v.trim())) return Number(v.trim());
  return null;
}

/** Id do computador (texto não vazio) ou null (sem computador = sem restrição). */
function deviceIdOf(device) {
  return isObj(device) && typeof device.id === "string" && device.id ? device.id : null;
}

/** A tabela state.accountDevices, ou null se não existir. */
function table(state) {
  return isObj(state) && isObj(state.accountDevices) ? state.accountDevices : null;
}

/** O valor guardado para a conta deixa o computador `id` usar? (null/sem entrada = todos; estragado = ninguém) */
function entryAllows(state, n, id) {
  const t = table(state);
  if (!t || !hasOwn(t, String(n))) return true;
  const v = t[String(n)];
  if (v === null || v === undefined) return true;
  return Array.isArray(v) && v.includes(id);
}

function accountExists(state, n) {
  const accs = isObj(state) && isObj(state.accounts) ? state.accounts : null;
  return !!accs && hasOwn(accs, String(n)) && isObj(accs[String(n)]);
}

function deviceExists(state, id) {
  const devs = isObj(state) && isObj(state.devices) ? state.devices : null;
  return !!devs && hasOwn(devs, id) && isObj(devs[id]);
}

/** Números das contas do cofre, em ordem. */
function accountNumbers(state) {
  const accs = isObj(state) && isObj(state.accounts) ? state.accounts : {};
  const out = new Set();
  for (const [k, a] of Object.entries(accs)) {
    if (!isObj(a)) continue;
    const n = accountNumberOf(a.number) ?? accountNumberOf(k);
    if (n !== null) out.add(n);
  }
  return [...out].sort((a, b) => a - b);
}

/** Texto curto de um valor para mensagens de erro. */
function shown(v) {
  if (typeof v === "string") return `"${v.slice(0, 64)}"`;
  if (v === null || v === undefined || typeof v === "number" || typeof v === "boolean") return String(v);
  return Array.isArray(v) ? "uma lista" : typeof v === "object" ? "um objeto" : typeof v;
}

/**
 * O computador pode usar a conta `number`? Só a permissão (não confere se a conta existe ou está viva):
 * sem entrada/null = sim; lista = só se o id do computador está nela. Número inválido = não.
 * Sem computador (null) = sim.
 */
function canUse(state, device, number) {
  const n = accountNumberOf(number);
  if (n === null) return false;
  const id = deviceIdOf(device);
  if (!id) return true;
  return entryAllows(state, n, id);
}

/**
 * Contas que o computador pode usar: null = todas (nenhuma conta do cofre o exclui); senão Set com os números
 * das contas do cofre que ele pode usar (Set vazio = nenhuma). Sem computador → null.
 */
function accountsAllowedFor(state, device) {
  const id = deviceIdOf(device);
  if (!id || !table(state)) return null;
  const all = accountNumbers(state);
  const ok = all.filter((n) => entryAllows(state, n, id));
  return ok.length === all.length ? null : new Set(ok);
}

/** Para o painel (PanelState, cada computador): números das contas do cofre que ele pode usar, em ordem. */
function allowedAccountsList(state, device) {
  return accountNumbers(state).filter((n) => canUse(state, device, n));
}

/**
 * Para o painel (PanelState, cada conta): null = todos os computadores; [id...] = só esses (só os que ainda
 * existem, na ordem guardada). Valor estragado → [] (ninguém, como o motor trata).
 */
function accountDevicesFor(state, number) {
  const n = accountNumberOf(number);
  const t = table(state);
  if (n === null || !t || !hasOwn(t, String(n))) return null;
  const v = t[String(n)];
  if (v === null || v === undefined) return null;
  if (!Array.isArray(v)) return [];
  return v.filter((id) => typeof id === "string" && deviceExists(state, id));
}

/**
 * Cópia de `records` ({ "<n>": { disabled, threshold, priority, alias } }) com `disabled: true` nas contas que o
 * computador não pode usar — para o decide() do rules.js e a escolha da melhor conta. Não muda o `records`
 * recebido. Conta do cofre que faltar em `records` e não for permitida ganha `{ disabled: true }`.
 */
function filterRecordsForDevice(records, state, device) {
  const out = {};
  if (isObj(records)) for (const [k, r] of Object.entries(records)) out[k] = isObj(r) ? { ...r } : r;
  const id = deviceIdOf(device);
  if (!id || !table(state)) return out;
  const keys = new Set(Object.keys(out));
  for (const n of accountNumbers(state)) keys.add(String(n));
  for (const k of keys) {
    const n = accountNumberOf(k);
    if (n === null || entryAllows(state, n, id)) continue;
    out[k] = { ...(isObj(out[k]) ? out[k] : {}), disabled: true };
  }
  return out;
}

/**
 * Grava quais computadores podem usar a conta. devices: lista de ids de computadores que existem (texto, sem
 * repetidos; [] = nenhum computador) ou null (todos: apaga a entrada). → o valor gravado (lista em ordem, cópia)
 * ou null. Erros (.code): "not_found" (a conta não existe); "invalid" (não é lista nem null, id inválido,
 * computador que não existe, repetido). Com erro nada muda.
 */
function setAccountDevices(state, number, devices) {
  if (!isObj(state)) throw fail("invalid", "estado inválido");
  const n = accountNumberOf(number);
  if (n === null || !accountExists(state, n)) {
    const what = typeof number === "number" || typeof number === "string" ? String(number).slice(0, 20) : "?";
    throw fail("not_found", `a conta ${what} não existe`);
  }
  if (devices === null) {
    const t = table(state);
    if (t) delete t[String(n)];
    return null;
  }
  if (!Array.isArray(devices)) {
    throw fail("invalid", "devices precisa ser uma lista de ids de computadores ou null (todos os computadores)");
  }
  const seen = new Set();
  for (const id of devices) {
    if (typeof id !== "string" || !id) throw fail("invalid", `id de computador inválido: ${shown(id)}`);
    if (seen.has(id)) throw fail("invalid", `o computador ${shown(id)} aparece repetido`);
    if (!deviceExists(state, id)) throw fail("invalid", `o computador ${shown(id)} não existe (foi desconectado?)`);
    seen.add(id);
  }
  const value = [...seen].sort();
  if (!isObj(state.accountDevices)) state.accountDevices = {};
  state.accountDevices[String(n)] = value;
  return [...value];
}

/** Conta removida: apaga a lista dela (um número reaproveitado depois começa com "todos"). → true se havia. */
function onAccountRemoved(state, number) {
  const n = accountNumberOf(number);
  const t = table(state);
  if (n === null || !t || !hasOwn(t, String(n))) return false;
  delete t[String(n)];
  return true;
}

/**
 * Computador removido: tira o id de todas as listas. Lista que fica vazia continua vazia (nenhum computador —
 * nunca vira "todos"). → números das contas que mudaram.
 */
function onDeviceRemoved(state, id) {
  const t = table(state);
  if (typeof id !== "string" || !id || !t) return [];
  const changed = [];
  for (const k of Object.keys(t)) {
    const v = t[k];
    if (!Array.isArray(v) || !v.includes(id)) continue;
    t[k] = v.filter((x) => x !== id);
    changed.push(accountNumberOf(k) ?? k);
  }
  return changed;
}

/** Para o histórico: "todos os computadores" | "nenhum computador" | "Mac" | "Mac" e "Windows" | "A", "B" e "C". */
function devicesLabel(state, devices) {
  if (devices === null || devices === undefined) return "todos os computadores";
  const devs = isObj(state) && isObj(state.devices) ? state.devices : {};
  const names = (Array.isArray(devices) ? devices : [])
    .filter((id) => typeof id === "string" && id)
    .map((id) => `"${(hasOwn(devs, id) && isObj(devs[id]) && devs[id].name) || id}"`);
  if (!names.length) return "nenhum computador";
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} e ${names[names.length - 1]}`;
}

module.exports = {
  normalizeEmail,
  accountsAllowedFor,
  allowedAccountsList,
  accountDevicesFor,
  canUse,
  filterRecordsForDevice,
  setAccountDevices,
  onAccountRemoved,
  onDeviceRemoved,
  devicesLabel,
};
