"use strict";
// Swap Plus Cliente — o ciclo: o mesmo trabalho que a extensão do VS Code faz no "modo servidor", sem VS Code.
//
// A cada 30 s o cliente:
//   1. olha a pasta de login para saber se o Claude Code está sendo usado (atividade.js);
//   2. fala com o servidor — ATIVO (em uso, ou presença "sempre"): POST /v1/heartbeat, como a extensão;
//      PARADO: só GET /v1/state, a cada 2 min. Parado, o cliente não conta como computador ativo no servidor:
//      não ocupa conta (regra "computadores separados") nem gasta o orçamento de leitura de uso;
//   3. se a conta atribuída mudou, o acesso foi renovado ou o login local não confere, busca a credencial
//      (GET /v1/credential) e grava na pasta de login com o claudeAuth.js da extensão (travas do Claude Code,
//      gravação atômica, nunca refresh token).
//
// Parado, o servidor não decide trocas para este cliente. Por isso, quando o estado mostra que a conta dele
// precisa de decisão (morta, desativada, sem conta, ou acima da linha de troca), o cliente manda um batimento
// avulso — no máximo um a cada 5 min — e o servidor decide na hora.
//
// O que este cliente NUNCA faz: enviar login ao servidor (POST /v1/logins) e gravar por cima de um login com
// refresh token feito à mão na pasta (só com SWAP_PLUS_SUBSTITUIR_LOGIN=1). O token do cliente e os tokens de
// acesso nunca vão para log.

const { erro } = require("./arquivos");

const CICLO_MS = 30 * 1000; // batimento de quem está ativo (igual à extensão)
const OCIOSO_MS = 2 * 60 * 1000; // parado: consulta o estado a cada 2 min
const JANELA_ATIVA_MS = 10 * 60 * 1000; // Claude Code usado nos últimos 10 min = ativo
const PROMOVER_MS = 5 * 60 * 1000; // parado e a conta precisa de decisão: no máximo 1 batimento avulso a cada 5 min
const REDE_DE_NOVO_MS = 2000; // falha de rede: uma segunda tentativa depois de 2 s (igual à extensão)
const REGRAVAR_MS = 60 * 1000; // gravação falhou: espera 1 min para tentar a mesma credencial
const PAUSA_403_MS = 5 * 60 * 1000; // o servidor recusou (403): não insiste por 5 min
const PAUSA_429_MS = 10 * 60 * 1000; // pedidos demais (429): 10 min
const CREDMAN_RE = /Gerenciador de Credenciais/;

const MSG_DESCONECTADO = "Este cliente ainda não foi conectado ao servidor. Rode: swap-plus-cliente conectar <código de conexão>";
const MSG_REVOGADO = "O servidor não reconhece mais este cliente (o acesso foi revogado). Conecte de novo: swap-plus-cliente conectar <código de conexão>";
const MSG_SEM_CONTA =
  "O servidor não tem conta para este cliente agora (nenhuma conta viva, ou nenhuma liberada para ele). No painel: Contas → Computadores permitidos.";

/** Mesma conta? quem = { email (minúsculo), orgUuid }; alvo = { email, orgUuid }. (Igual à extensão.) */
function mesmaIdentidade(quem, alvo) {
  if (!quem || !alvo || !alvo.email) return false;
  return quem.email === String(alvo.email).toLowerCase() && (!quem.orgUuid || !alvo.orgUuid || quem.orgUuid === alvo.orgUuid);
}

/** Modelos declarados na configuração + os vistos nas transcrições, sem repetir (o servidor guarda até 20). */
function juntarModelos(fixos, vistos) {
  const out = [];
  for (const id of [...(vistos || []), ...(fixos || [])]) if (typeof id === "string" && id && !out.includes(id)) out.push(id);
  return out.slice(0, 20);
}

function hora(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "?";
  const d = new Date(ms);
  const dois = (n) => String(n).padStart(2, "0");
  return `${dois(d.getDate())}/${dois(d.getMonth() + 1)} ${dois(d.getHours())}:${dois(d.getMinutes())}`;
}

class Cliente {
  /**
   * @param {object} o
   *   cfg         configuração resolvida (config.js)
   *   estado      Estado (estado.js)
   *   lib         plus/serverClient.js
   *   auth        plus/claudeAuth.js (já apontando para a pasta de login: config.aplicarAmbiente)
   *   regras      plus/rules.js
   *   modelSwitch plus/modelSwitch.js
   *   atividade   atividade.js
   *   agora, log, espera, versao   (trocáveis nos testes)
   */
  constructor(o) {
    this.cfg = o.cfg;
    this.estado = o.estado;
    this.lib = o.lib;
    this.auth = o.auth;
    this.regras = o.regras;
    this.modelSwitch = o.modelSwitch;
    this.atividade = o.atividade;
    this.agora = o.agora || Date.now;
    this.log = o.log || { debug() {}, info() {}, warn() {}, error() {} };
    this.espera = o.espera || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.versao = o.versao || null;
    this.mem = {
      resp: null, // último estado recebido do servidor
      ultimoEstadoEm: 0,
      ultimoContatoEm: 0,
      ultimaPromocaoEm: 0,
      falhaGravacao: null, // { chave: "numero|gen", em, erro }
      avisados: new Set(),
      limiteDesde: this.agora(), // erros de limite anteriores à subida do cliente não contam
      pausaAte: 0,
      pausaMotivo: null,
      gravadoEm: 0,
      ultimoRegistro: null,
    };
  }

  // ------------------------------------------------------------------ ciclo

  /** Um ciclo completo. `forcar`: age como ativo e ignora esperas (subida, logo depois de conectar, "uma-vez"). */
  async ciclo({ forcar = false } = {}) {
    return this.comServidor({ forcar }, async (ctx) => {
      const { t, cliente, ativ, live } = ctx;
      const m = this.mem;
      let resp = m.resp;
      let consultou = false;
      if (ctx.ativo) {
        resp = await this.bater(cliente, ctx.modelos, live);
        consultou = true;
      } else if (!resp || t - m.ultimoEstadoEm >= OCIOSO_MS) {
        resp = this.conferir(await this.pedir(cliente, "GET", "/v1/state"));
        consultou = true;
      }
      if (consultou) this.recebeu(resp, t);
      if (!ctx.ativo && consultou && this.pedeDecisao(resp) && t - m.ultimaPromocaoEm >= PROMOVER_MS) {
        m.ultimaPromocaoEm = t;
        this.log.debug("parado, mas a conta deste cliente precisa de decisão: batimento avulso");
        resp = await this.bater(cliente, ctx.modelos, live);
        this.recebeu(resp, t);
      }
      let forcarGravacao = false;
      const lim = this.limiteVisto(ativ, resp);
      if (lim) {
        const r = await cliente.request("POST", "/v1/events", { kind: "limit_hit", label: lim.rotulo });
        m.limiteDesde = Math.max(m.limiteDesde, lim.ts);
        if (r && r.state) {
          resp = this.conferir(r.state);
          this.recebeu(resp, t);
        }
        forcarGravacao = !!(r && r.switched);
        this.log.info(`a conta bateu o ${lim.rotulo}: ${r && r.switched ? "o servidor trocou de conta" : "o servidor não trocou"}${r && r.text ? ` (${r.text})` : ""}`);
      }
      return { resp, forcarGravacao };
    });
  }

  /** Pede ao servidor a conta `numero` (null = a melhor) e grava. */
  async trocar(numero) {
    return this.comServidor({ forcar: true, jaTentar: true }, async (ctx) => {
      const resp = this.conferir(await ctx.cliente.request("POST", "/v1/switch", { number: numero === null || numero === undefined ? null : Number(numero) }));
      this.recebeu(resp, ctx.t);
      return { resp, forcarGravacao: true };
    });
  }

  /** Avisa o servidor que a conta bateu o limite (para quem chama o Claude Code e viu o erro). */
  async informarLimite(rotulo) {
    let texto = null;
    const s = await this.comServidor({ forcar: true, jaTentar: true }, async (ctx) => {
      const r = await ctx.cliente.request("POST", "/v1/events", { kind: "limit_hit", label: String(rotulo || "limite de uso").slice(0, 80) });
      texto = { trocou: !!(r && r.switched), texto: (r && r.text) || null };
      const resp = this.conferir(r && r.state);
      this.recebeu(resp, ctx.t);
      return { resp, forcarGravacao: !!(r && r.switched) };
    });
    return { ...s, limite: texto };
  }

  /**
   * Parte comum: confere a conexão, monta o cliente HTTP, lê a pasta de login, roda `fn` (que fala com o
   * servidor e devolve o estado), grava a credencial se for o caso e registra a situação.
   */
  async comServidor({ forcar = false, jaTentar = false }, fn) {
    const t = this.agora();
    const m = this.mem;
    let con;
    try {
      con = this.estado.conexao();
    } catch (e) {
      return this.situar(t, { estado: "desconectado", mensagem: e.message }, null);
    }
    if (!con) return this.situar(t, { estado: "desconectado", mensagem: MSG_DESCONECTADO }, null);
    if (con.revogadoEm) return this.situar(t, { estado: "revogado", mensagem: MSG_REVOGADO }, con);
    if (m.conexaoDe !== con.deviceId) {
      // Conexão nova (conectou de novo, talvez em outro servidor): o que se sabia do servidor antigo não vale mais.
      m.conexaoDe = con.deviceId;
      m.resp = null;
      m.ultimoEstadoEm = 0;
      m.ultimaPromocaoEm = 0;
      m.falhaGravacao = null;
      m.pausaAte = 0;
      m.pausaMotivo = null;
    }
    if (!forcar && t < m.pausaAte) return this.situar(t, { estado: "offline", mensagem: m.pausaMotivo }, con);

    let cliente;
    try {
      // O token só vale no endereço em que foi emitido (tokenOrigin): nunca vai para outro lugar.
      cliente = this.lib.createServerClient({ url: con.url, token: con.token, fp: con.fp || null, tokenOrigin: con.url });
    } catch (e) {
      return this.situar(t, { estado: "desconectado", mensagem: `O endereço do servidor guardado na conexão não serve (${e.code || "erro"}). Conecte de novo.` }, con);
    }

    const bloqueio = this.bloqueio();
    const ativ = await this.atividade.detectar(this.cfg.pastaClaude, { agora: t, desdeLimite: m.limiteDesde });
    const usando = ativ.ultimaAtividade > 0 && t - ativ.ultimaAtividade <= JANELA_ATIVA_MS;
    const ativo = forcar || this.cfg.presenca === "sempre" || usando;
    const live = await this.lerLive();
    const ctx = { t, con, cliente, ativ, ativo, live, modelos: juntarModelos(this.cfg.modelos, ativ.modelos) };

    let resp;
    let gravacao;
    try {
      const r = await fn(ctx);
      resp = r.resp;
      gravacao = await this.sincronizar(cliente, resp, { live, bloqueio, forcar: r.forcarGravacao, jaTentar: jaTentar || forcar });
    } catch (e) {
      return this.falhou(t, e, con, ativo);
    }
    return this.situar(t, this.resumir(resp, gravacao, bloqueio), con, { ativo, usando, resp });
  }

  // ------------------------------------------------------------------ servidor

  /** Pedido com uma segunda tentativa quando a rede falha (só leitura de estado e batimento). */
  async pedir(cliente, metodo, caminho, corpo) {
    try {
      return await cliente.request(metodo, caminho, corpo);
    } catch (e) {
      if (!e || (e.code !== "network" && e.code !== "timeout")) throw e;
      await this.espera(REDE_DE_NOVO_MS);
      return cliente.request(metodo, caminho, corpo);
    }
  }

  async bater(cliente, modelos, live) {
    const resumo = live.quem
      ? { email: live.quem.email, orgUuid: live.quem.orgUuid || null, expiresAt: live.oauth && typeof live.oauth.expiresAt === "number" ? live.oauth.expiresAt : null }
      : null;
    return this.conferir(await this.pedir(cliente, "POST", "/v1/heartbeat", { models: modelos, live: resumo }));
  }

  conferir(resp) {
    if (!resp || typeof resp !== "object" || !resp.list || !Array.isArray(resp.list.accounts)) {
      throw erro("bad_response", "O servidor respondeu algo inesperado (estado sem a lista de contas).", { status: 200 });
    }
    return resp;
  }

  recebeu(resp, t) {
    this.mem.resp = resp;
    this.mem.ultimoEstadoEm = t;
    this.mem.ultimoContatoEm = t;
    this.mem.pausaAte = 0;
    this.mem.pausaMotivo = null;
  }

  /** Parado: a conta deste cliente precisa que o servidor decida? (sem conta, morta, desativada, acima da linha) */
  pedeDecisao(resp) {
    const cred = resp.credential;
    if (!cred) return true;
    const acc = resp.list.accounts.find((a) => a && a.number === cred.number);
    if (!acc) return true;
    if (acc.dead || acc.disabled || acc.usageStatus === "relogin_required") return true;
    if (resp.autoSwitch === false) return false;
    let w = null;
    let linhas = null;
    try {
      w = this.regras.windows(acc);
      linhas = this.regras.linesFor(acc, { ...this.regras.RULE_DEFAULTS, ...(resp.rules || {}) }, resp.records);
    } catch {
      return false;
    }
    if (!w || !linhas) return false; // sem leitura de uso: nada a decidir
    const passou = (j, linha) => j && typeof j.pct === "number" && typeof linha === "number" && j.pct >= linha;
    return passou(w.session, linhas.session) || passou(w.weekly, linhas.weekly);
  }

  /** Erro de limite novo (numa transcrição, ou avisado na pasta) → { rotulo, ts } quando há o que avisar ao servidor. */
  limiteVisto(ativ, resp) {
    const h = ativ.limite;
    if (!h) return null;
    const semAviso = () => {
      this.mem.limiteDesde = Math.max(this.mem.limiteDesde, h.ts);
      return null;
    };
    // Limite de um modelo (Fable, Opus, Sonnet): só o do Fable troca de conta, e só se a regra do servidor mandar.
    // Aviso que não diz qual limite foi (o Hermes só sabe "bateu"): decide pelo uso da conta (modeloPeloUso).
    const modelo = this.modelSwitch.limitModel(h.text, h.rateLimitType) || (h.aviso && !h.text && !h.rateLimitType ? this.modeloPeloUso(resp) : null);
    if (modelo) {
      if (modelo === "Fable" && resp.rules && resp.rules.onModelLimit === "switchAccount") return { rotulo: "limite do Fable", ts: h.ts };
      return semAviso();
    }
    const rotulo = this.rotuloDaConta(h.text);
    return rotulo ? { rotulo, ts: h.ts } : semAviso();
  }

  /**
   * Aviso de limite sem dizer qual: se, na última leitura da conta em uso, o limite do modelo preferido está no fim
   * (90% ou mais) e a sessão e o semanal estão abaixo das linhas de troca, foi o do modelo. → o nome dele, ou null.
   * Importa porque o servidor trata os dois de jeitos diferentes: limite da conta troca para qualquer conta com
   * folga; limite do modelo só troca para conta que ainda tem o modelo (senão ficaria pulando de conta à toa).
   */
  modeloPeloUso(resp) {
    try {
      const cred = resp.credential;
      const acc = cred ? resp.list.accounts.find((a) => a && a.number === cred.number) : null;
      const r = { ...this.regras.RULE_DEFAULTS, ...(resp.rules || {}) };
      const w = acc ? this.regras.windows(acc) : null;
      if (!w || !r.preferModel) return null;
      const m = w.models.find((x) => x.name === r.preferModel);
      if (!m || !(Number(m.pct) >= 90)) return null;
      const linhas = this.regras.linesFor(acc, r, resp.records);
      const abaixo = (j, linha) => !j || typeof j.pct !== "number" || j.pct < linha;
      return abaixo(w.session, linhas.session) && abaixo(w.weekly, linhas.weekly) ? r.preferModel : null;
    } catch {
      return null;
    }
  }

  /** Igual ao limitLabel da extensão. */
  rotuloDaConta(texto) {
    const t = String(texto || "");
    if (this.modelSwitch.TRANSIENT_LIMIT_RE.test(t)) return null; // "not your usage limit": passageiro
    if (/5-hour|five.?hour|session/i.test(t)) return "limite da sessão de 5h";
    if (/weekly|week|seven.?day/i.test(t)) return /fable|opus|sonnet/i.test(t) ? null : "limite semanal";
    if (/fable|opus|sonnet/i.test(t)) return null;
    return "limite de uso";
  }

  // ------------------------------------------------------------------ pasta de login

  async lerLive() {
    const out = { oauth: null, quem: null, ilegivel: false, motivo: null };
    try {
      const l = await this.auth.readLive();
      out.oauth = l && l.claudeAiOauth && typeof l.claudeAiOauth === "object" ? l.claudeAiOauth : null;
    } catch (e) {
      out.ilegivel = true;
      out.motivo = (e && (e.reason || e.code)) || "erro";
      return out;
    }
    try {
      out.quem = (await this.auth.liveIdentity()) || null;
    } catch {}
    return out;
  }

  /** No Windows, o Claude Code pode estar lendo o login do Gerenciador de Credenciais: gravar o arquivo não adiantaria. */
  bloqueio() {
    try {
      const w = (this.auth.credentialStoreWarnings() || []).find((x) => CREDMAN_RE.test(String(x)));
      return w ? String(w) : null;
    } catch {
      return null;
    }
  }

  avisarUmaVez(chave, texto) {
    if (this.mem.avisados.has(chave)) return;
    this.mem.avisados.add(chave);
    this.log.warn(texto);
  }

  /**
   * Deixa na pasta de login a credencial da conta que o servidor atribuiu a este cliente.
   * → { tipo: "igual" | "gravou" | "sem_conta" | "bloqueado" | "login_manual" | "pulou" | "esperando" | "falhou", ... }
   */
  async sincronizar(cliente, resp, { live, bloqueio = null, forcar = false, jaTentar = false }) {
    const cred = resp.credential;
    if (!cred) return { tipo: "sem_conta" };
    if (bloqueio) return { tipo: "bloqueado", mensagem: bloqueio };
    if (live.ilegivel) return { tipo: "pulou", erro: "live_unreadable", mensagem: `Não consegui ler o login atual do Claude Code (${live.motivo}).` };
    if (live.oauth && live.oauth.refreshToken && !this.cfg.substituirLogin) {
      const mensagem =
        `Há um login do Claude Code feito à mão em ${this.cfg.pastaClaude} (com refresh token). Este cliente não envia logins ao servidor nem apaga esse. ` +
        "Use outra pasta, apague esse login, ou defina SWAP_PLUS_SUBSTITUIR_LOGIN=1 para o cliente gravar por cima.";
      this.avisarUmaVez("login_manual", mensagem);
      return { tipo: "login_manual", mensagem };
    }

    const t = this.agora();
    const aplicado = this.estado.aplicado();
    const conta = resp.list.accounts.find((a) => a && a.number === cred.number) || null;
    const alvo = conta ? { email: conta.email, orgUuid: conta.organizationUuid || null } : null;
    const mudou = !aplicado || aplicado.number !== cred.number || aplicado.gen !== cred.gen;
    const identidadeOk = mesmaIdentidade(live.quem, alvo) || (!mudou && !!aplicado && aplicado.noIdentity === true);
    const validadeLocal = live.oauth && typeof live.oauth.expiresAt === "number" ? live.oauth.expiresAt : null;
    if (!forcar && !mudou && identidadeOk && validadeLocal === cred.expiresAt) return { tipo: "igual", number: cred.number, expiresAt: cred.expiresAt };

    const chave = `${cred.number}|${cred.gen}`;
    const f = this.mem.falhaGravacao;
    if (!jaTentar && f && f.chave === chave && t - f.em < REGRAVAR_MS) return { tipo: "esperando", erro: f.erro, mensagem: f.mensagem };

    let r;
    try {
      r = await cliente.request("GET", "/v1/credential");
    } catch (e) {
      if (e && (e.status === 409 || e.code === "no_account")) return { tipo: "sem_conta" };
      throw e;
    }
    const o = r && r.claudeAiOauth;
    if (!o || typeof o.accessToken !== "string" || !o.accessToken || typeof o.expiresAt !== "number") {
      throw erro("bad_response", "O servidor respondeu uma credencial incompleta.", { status: 200 });
    }
    // Só o que a extensão grava: acesso, validade e os campos do plano. Nunca refresh token.
    const limpo = { accessToken: o.accessToken, expiresAt: o.expiresAt };
    for (const k of ["scopes", "subscriptionType", "rateLimitTier"]) if (o[k] !== undefined) limpo[k] = o[k];
    const oa = r.oauthAccount && typeof r.oauthAccount === "object" && r.oauthAccount.emailAddress ? r.oauthAccount : null;
    const destino = oa ? { email: oa.emailAddress, orgUuid: oa.organizationUuid || null } : alvo;
    const trocando = !mesmaIdentidade(live.quem, destino);

    try {
      await this.auth.writeLive(limpo, {
        canReplace: (atual) => !atual || !atual.refreshToken || this.cfg.substituirLogin === true,
        dropTrustedDevice: trocando,
      });
    } catch (e) {
      const code = (e && e.code) || "erro";
      if (code === "live_changed" || code === "live_unreadable") return { tipo: "pulou", erro: code, mensagem: "O login do Claude Code mudou durante a gravação; tento de novo no próximo ciclo." };
      const mensagem = `Não consegui gravar o login do Claude Code em ${this.cfg.pastaClaude}: ${(e && e.message) || code}`;
      this.mem.falhaGravacao = { chave, em: t, erro: code, mensagem };
      this.avisarUmaVez(`gravacao:${code}`, mensagem);
      return { tipo: "falhou", erro: code, mensagem };
    }
    this.mem.falhaGravacao = null;
    this.mem.gravadoEm = t;

    const novo = { number: r.number, gen: r.gen, expiresAt: limpo.expiresAt, at: t, noIdentity: !oa };
    if (oa) {
      try {
        await this.auth.writeOauthAccount(oa);
      } catch (e) {
        novo.noIdentity = true;
        this.avisarUmaVez(`identidade:${(e && e.code) || "erro"}`, `Gravei o acesso, mas não a identidade da conta (.claude.json): ${(e && e.message) || e}`);
      }
    }
    await this.estado.gravarAplicado(novo);
    const trocou = !!aplicado && aplicado.number !== r.number;
    this.log.info(
      trocou
        ? `conta trocada: agora na conta ${r.number} (antes ${aplicado.number}); acesso válido até ${hora(limpo.expiresAt)}`
        : `login gravado: conta ${r.number}; acesso válido até ${hora(limpo.expiresAt)}`
    );
    return { tipo: "gravou", number: r.number, expiresAt: limpo.expiresAt, trocou };
  }

  // ------------------------------------------------------------------ situação

  resumir(resp, gravacao, bloqueio) {
    const cred = resp.credential;
    const g = gravacao || { tipo: "sem_conta" };
    if (!cred || g.tipo === "sem_conta") return { estado: "sem_conta", mensagem: MSG_SEM_CONTA };
    const numero = g.number !== undefined ? g.number : cred.number;
    const conta = resp.list.accounts.find((a) => a && a.number === numero) || null;
    const base = {
      conta: { numero, email: (conta && conta.email) || null, apelido: (conta && conta.alias) || null, plano: (conta && conta.plan && conta.plan.label) || null },
      avisos: (resp.warnings || []).filter((w) => w && w.account === numero && w.text).map((w) => String(w.text)),
    };
    if (g.tipo === "igual" || g.tipo === "gravou") return { ...base, estado: "ok", mensagem: null, acessoExpiraEm: g.expiresAt };
    if (g.tipo === "bloqueado" || g.tipo === "login_manual") return { ...base, estado: "bloqueado", mensagem: g.mensagem || bloqueio };
    return { ...base, estado: "pendente", mensagem: g.mensagem || `A credencial ainda não foi gravada (${g.erro || g.tipo}).` };
  }

  async falhou(t, e, con, ativo) {
    const status = Number(e && e.status) || 0;
    const m = this.mem;
    if (status === 401) {
      // Outro processo conectou de novo enquanto este ciclo rodava (o "conectar" revoga o acesso antigo): o 401 é
      // do acesso antigo. A conexão nova fica como está; o próximo ciclo já usa ela.
      let atual = null;
      try {
        atual = this.estado.conexao();
      } catch {}
      if (atual && (atual.deviceId !== con.deviceId || atual.token !== con.token)) {
        return this.situar(t, { estado: "offline", mensagem: "A conexão com o servidor foi trocada durante este ciclo; o próximo já usa a nova.", erro: "conexao_trocada" }, atual, { ativo });
      }
      // Cada 401 conta no limite de tentativas por IP do servidor (20 em 10 min bloqueiam o IP): para de chamar.
      // Gravado ANTES de seguir: o próximo ciclo já tem de encontrar a conexão marcada.
      con = { ...con, revogadoEm: t };
      try {
        await this.estado.gravarConexao(con);
      } catch (x) {
        // Sem conseguir registrar, a pausa segura as chamadas enquanto este processo viver.
        m.pausaAte = Infinity;
        m.pausaMotivo = MSG_REVOGADO;
        this.log.error(`não consegui registrar a revogação em ${this.estado.arqConexao}: ${x.message}`);
      }
      return this.situar(t, { estado: "revogado", mensagem: MSG_REVOGADO }, con, { ativo });
    }
    const mensagem = (e && e.message) || "Falha ao falar com o servidor.";
    if (status === 403) {
      m.pausaAte = t + PAUSA_403_MS;
      m.pausaMotivo = `O servidor recusou o pedido (403): ${mensagem} Nova tentativa às ${hora(m.pausaAte).slice(6)}.`;
    } else if (status === 429) {
      m.pausaAte = t + PAUSA_429_MS;
      m.pausaMotivo = `O servidor pediu para esperar (429). Nova tentativa às ${hora(m.pausaAte).slice(6)}.`;
    }
    return this.situar(t, { estado: "offline", mensagem: m.pausaMotivo && t < m.pausaAte ? m.pausaMotivo : mensagem, erro: (e && e.code) || "erro" }, con, { ativo });
  }

  /** Grava situacao.json (sem segredo), registra no log quando algo muda e devolve o retrato. */
  async situar(t, parcial, con, extra = {}) {
    const aplicado = this.estado.aplicado();
    const s = {
      em: t,
      versao: this.versao,
      estado: parcial.estado,
      mensagem: parcial.mensagem || null,
      erro: parcial.erro || null,
      servidor: con ? con.url : null,
      cliente: con ? con.nome || this.cfg.nome : this.cfg.nome,
      pastaClaude: this.cfg.pastaClaude,
      presenca: { modo: this.cfg.presenca, ativo: !!extra.ativo, emUso: !!extra.usando },
      conta: parcial.conta || null,
      // Fora do "ok" vale a validade do que está gravado: o Claude Code segue funcionando até ela.
      acessoExpiraEm: parcial.acessoExpiraEm || (aplicado && aplicado.expiresAt) || null,
      gravadoEm: (aplicado && aplicado.at) || null,
      ultimoContatoEm: this.mem.ultimoContatoEm || null,
      avisos: parcial.avisos || [],
    };
    try {
      await this.estado.gravarSituacao(s);
    } catch (e) {
      this.avisarUmaVez("situacao", `Não consegui gravar a situação em ${this.estado.arqSituacao}: ${e.message}`);
    }
    this.registrar(s);
    return s;
  }

  registrar(s) {
    const chave = `${s.estado}|${s.conta ? s.conta.numero : ""}|${s.presenca.ativo}|${s.mensagem || ""}`;
    if (chave === this.mem.ultimoRegistro) return;
    this.mem.ultimoRegistro = chave;
    const presenca = s.presenca.ativo ? "ativo" : "parado";
    if (s.estado === "ok") {
      const c = s.conta;
      this.log.info(`em dia — conta ${c.numero}${c.apelido ? ` (${c.apelido})` : ""}, acesso até ${hora(s.acessoExpiraEm)}, ${presenca}`);
    } else {
      const nivel = s.estado === "offline" || s.estado === "pendente" ? "warn" : "error";
      this.log[nivel](`${s.estado}: ${s.mensagem || "sem detalhe"}`);
    }
    for (const a of s.avisos) this.avisarUmaVez(`aviso:${a}`, `aviso do servidor: ${a}`);
  }

  // ------------------------------------------------------------------ rodar

  /**
   * Fica rodando até `parar` (AbortSignal) disparar. `aCadaCiclo()` devolvendo false encerra (a trava foi perdida).
   */
  async rodar({ parar = null, aCadaCiclo = null } = {}) {
    let primeiro = true;
    while (!(parar && parar.aborted)) {
      try {
        await this.ciclo({ forcar: primeiro });
      } catch (e) {
        this.log.error(`o ciclo falhou: ${(e && e.message) || e}`);
      }
      primeiro = false;
      if (aCadaCiclo && aCadaCiclo() === false) break;
      await this.espera(CICLO_MS, parar);
    }
  }
}

module.exports = {
  Cliente,
  mesmaIdentidade,
  juntarModelos,
  hora,
  CICLO_MS,
  OCIOSO_MS,
  JANELA_ATIVA_MS,
  PROMOVER_MS,
  REGRAVAR_MS,
  PAUSA_403_MS,
  PAUSA_429_MS,
  MSG_DESCONECTADO,
  MSG_REVOGADO,
  MSG_SEM_CONTA,
};
