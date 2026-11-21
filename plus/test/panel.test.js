"use strict";
// Testes da tela de configurações da extensão (plus/media/panel.html, panel.js, panel.css) — node:test.
// Rodar:  node --test plus/test/panel.test.js
//
// 1) Conferências de texto dos arquivos (sem rodar nada): os quatro marcadores que a extensão preenche,
//    a regra de segurança da página (nenhum script ou estilo embutido), todo id que o panel.js procura
//    existe no panel.html, e toda mensagem que a tela manda tem quem receba na extensão.
// 2) A tela de verdade rodando num DOM de mentira (tela-falsa.js): não quebra com nenhum estado e manda
//    a mensagem certa em cada controle. Nada aqui ativa a extensão nem fala com servidor nenhum.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { abrirTela, inteira, MEDIA } = require("./tela-falsa");

const PLUS = path.join(__dirname, "..");
// Quebras de linha iguais em qualquer sistema (no Windows o git pode entregar os arquivos com CRLF).
const ler = (...p) => fs.readFileSync(path.join(PLUS, ...p), "utf8").replace(/\r\n/g, "\n");
const html = ler("media", "panel.html");
const js = ler("media", "panel.js");
const css = ler("media", "panel.css");
const ext = ler("extension.js");
const manifest = JSON.parse(ler("package.json"));

/** Todas as ocorrências do grupo 1 de uma expressão. */
const todas = (texto, re) => [...texto.matchAll(re)].map((m) => m[1]);
/** O texto de dentro de handleMessage (até a seção seguinte do arquivo). */
const handleMessage = (() => {
  const i = ext.indexOf("async function handleMessage(m) {");
  assert.ok(i > 0, "extension.js tem a função handleMessage");
  return ext.slice(i, ext.indexOf("\n}\n", i));
})();

// ================================================================ 1) os arquivos

test("panel.html: os quatro marcadores, os três arquivos e a mesma regra de segurança (CSP)", () => {
  assert.deepEqual(fs.readdirSync(MEDIA).sort(), ["panel.css", "panel.html", "panel.js"], "plus/media tem os três arquivos de sempre");
  for (const nome of ["panel.css", "panel.js", "panel.html"]) assert.ok(ext.includes(`"${nome}"`), `a extensão abre ${nome}`);

  assert.deepEqual([...new Set(todas(html, /\{\{(\w+)\}\}/g))].sort(), ["csp", "css", "js", "nonce"], "só os quatro marcadores que a extensão preenche");
  for (const k of ["csp", "nonce", "css", "js"]) assert.ok(ext.includes(`.replace(/\\{\\{${k}\\}\\}/g`), `a extensão preenche {{${k}}}`);

  const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(html);
  assert.ok(csp, "a página declara a CSP");
  assert.equal(csp[1], "default-src 'none'; style-src {{csp}}; img-src {{csp}} data:; script-src 'nonce-{{nonce}}';");
  assert.match(html, /<link rel="stylesheet" href="\{\{css\}\}">/);
});

test("panel.html: nenhum script ou estilo embutido, nada de fora", () => {
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  assert.equal(scripts.length, 1, "um <script> só");
  assert.equal(scripts[0][1].trim(), 'nonce="{{nonce}}" src="{{js}}"', "o script é o panel.js, com o nonce");
  assert.equal(scripts[0][2].trim(), "", "sem código dentro do <script>");
  assert.doesNotMatch(html, /<style\b/i, "sem <style>");
  assert.doesNotMatch(html, /\sstyle\s*=/i, "sem atributo style=");
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i, "sem onclick= e parecidos");
  assert.doesNotMatch(html, /javascript:/i);
  for (const [nome, texto] of [["panel.html", html], ["panel.css", css], ["panel.js", js]]) {
    assert.doesNotMatch(texto, /https?:\/\/|url\(\s*["']?\/\//i, `${nome} não busca nada de fora`);
  }
  assert.doesNotMatch(css, /@import/i);
});

test("panel.js: escreve sempre como texto e nunca cria estilo ou script", () => {
  for (const proibido of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function", "cssText", 'setAttribute("style"', "createElement(\"script\")", "createElement(\"style\")"]) {
    assert.ok(!js.includes(proibido), `panel.js não usa ${proibido}`);
  }
  assert.doesNotMatch(js, /\bstyle\s*:/, "nenhum atributo style passado ao criar elementos");
  assert.doesNotMatch(js, /localStorage|sessionStorage|fetch\(|XMLHttpRequest|WebSocket/, "a tela só fala com a extensão");
});

test("panel.js × panel.html: todo id procurado existe (e é único)", () => {
  const ids = todas(html, /\sid="([^"]+)"/g);
  assert.equal(new Set(ids).size, ids.length, `ids repetidos no panel.html: ${ids.filter((x, i) => ids.indexOf(x) !== i).join(", ")}`);

  const procurados = [...new Set([...todas(js, /\$\(\s*"([^"]+)"\s*\)/g), ...todas(js, /getElementById\(\s*"([^"]+)"\s*\)/g)])];
  assert.ok(procurados.length >= 20, "achei as procuras do panel.js");
  const faltando = procurados.filter((id) => !ids.includes(id));
  assert.deepEqual(faltando, [], `ids que o panel.js procura e o panel.html não tem: ${faltando.join(", ")}`);
  // Toda procura é por um nome escrito ali mesmo: $(variável) escaparia desta conferência.
  const chamadas = (js.match(/\$\(/g) || []).length;
  assert.equal(chamadas, todas(js, /\$\(\s*"([^"]+)"\s*\)/g).length, "toda chamada $( ) leva o id escrito entre aspas");
  assert.equal((js.match(/getElementById\(/g) || []).length, 1, "getElementById só na definição do $");

  // As ligações de dentro do panel.html também apontam para ids que existem.
  for (const atributo of ["for", "aria-labelledby", "aria-describedby"]) {
    for (const alvo of todas(html, new RegExp(`\\s${atributo}="([^"]+)"`, "g")).flatMap((v) => v.split(/\s+/))) {
      assert.ok(ids.includes(alvo), `${atributo}="${alvo}" aponta para um id que não existe`);
    }
  }
});

test("mensagens: tudo o que a tela manda tem quem receba na extensão; nada do que saiu da tela é mandado", () => {
  const enviados = [...new Set(todas(js, /send\(\{\s*type:\s*"(\w+)"/g))].sort();
  assert.deepEqual(enviados, ["checkUpdates", "connectServer", "disconnectServer", "openPanel", "ready", "saveAlerts", "setEnabled", "switch", "ui", "useServerAccount"]);
  assert.equal((js.match(/\bsend\(/g) || []).length, todas(js, /send\(\{\s*type:\s*"(\w+)"/g).length, "todo send( ) leva o tipo escrito ali mesmo");
  assert.equal((js.match(/postMessage\(/g) || []).length, 1, "a tela só fala com a extensão pelo send( )");
  for (const tipo of enviados) assert.ok(handleMessage.includes(`case "${tipo}":`), `a extensão trata a mensagem ${tipo}`);

  // O painel abre no endereço que a extensão guarda: a tela não manda endereço nenhum.
  assert.match(js, /send\(\{ type: "openPanel" \}\)/);
  const abrir = handleMessage.slice(handleMessage.indexOf('case "openPanel":'));
  assert.doesNotMatch(abrir, /\bm\./, "o tratamento de openPanel não lê nada da mensagem");
  assert.match(abrir, /openInBrowser\(/);

  // Opções de exibição e jeitos de conectar: os mesmos nomes dos dois lados.
  const permitidas = JSON.parse(/case "ui": \{\s*const allowed = (\[[^\]]*\]);/.exec(handleMessage)[1]);
  const chavesUi = todas(js, /\{ key: "([\w.]+)", box:/g);
  assert.deepEqual(chavesUi.slice().sort(), permitidas.slice().sort(), "as três opções de exibição");
  const metodos = JSON.parse(/const CONNECT_METHODS = (\[[^\]]*\]);/.exec(ext)[1]);
  assert.deepEqual([...new Set(todas(js, /method: "(\w+)"/g))].sort(), metodos.slice().sort());

  // Os seis avisos são as seis configurações swapPlus.alerts.* do package.json.
  const avisos = [...todas(js, /\{ on: "(\w+)", pct:/g), ...todas(js, /\{ on: "\w+", pct: "(\w+)"/g)].sort();
  const noManifesto = Object.keys(manifest.contributes.configuration.properties).filter((k) => k.startsWith("swapPlus.alerts.")).map((k) => k.slice("swapPlus.alerts.".length)).sort();
  assert.deepEqual(avisos, noManifesto);

  // O que saiu da tela: regras, ajustes das contas, outros serviços, histórico.
  for (const tipo of ["setAuto", "saveRules", "account", "revokeDevice", "add", "checkNow", "refresh"]) {
    assert.ok(!js.includes(`type: "${tipo}"`), `a tela não manda mais ${tipo}`);
    assert.ok(handleMessage.includes(`case "${tipo}":`), `a extensão continua tratando ${tipo} (telas antigas abertas)`);
  }
});

test("textos fixos da tela e nome do comando", () => {
  const cmd = manifest.contributes.commands.find((c) => c.command === "swapPlus.openSettings");
  assert.equal(`${cmd.category}: ${cmd.title}`, "Swap Plus: Configurações");
  assert.match(html, /<title>Swap Plus — Configurações<\/title>/);
  assert.ok(ext.includes('"Swap Plus — Configurações"'), "título da aba");

  const naTela = [
    "<h1>Swap Plus neste VS Code</h1>",
    "Desligado, este VS Code para de falar com o servidor e de trocar de conta. Os outros serviços não mudam.",
    ">Conexão</h2>",
    ">Conta em uso aqui</h2>",
    ">Trocar de conta</h3>",
    "<summary>Mais opções deste VS Code</summary>",
    ">Avisar quando chegar em</h3>",
    ">Exibição</h3>",
    ">Atualizações da extensão</h3>",
    ">Verificar agora</button>",
    "Contas, regras de troca, usuários e os outros serviços ficam no painel do Swap.",
    ">Abrir o painel</button>",
    "Só o administrador entra no painel.",
  ];
  for (const t of naTela) assert.ok(html.includes(t), `panel.html tem: ${t}`);
  const noScript = [
    '"Entrar com Google"',
    '"Colar código"',
    '"Outro endereço…"',
    '"Sair"',
    '"Usar a conta do servidor"',
    '"Usar esta conta"',
    '"Troca automática: "',
    '" — muda-se no painel do Swap"',
    '"Neste Swap os serviços andam juntos: trocar aqui troca também nos outros que estão em uso."',
  ];
  for (const t of noScript) assert.ok(js.includes(t), `panel.js tem: ${t}`);
  assert.doesNotMatch(html + js, /Salvar regras|Histórico|Adicionar conta|Revogar|Computadores conectados|Prioridade|Usar regra padrão/, "nada do que foi para o painel do Swap");
});

// ================================================================ 2) a tela rodando

const HORA = 3600e3;
const janela = (pct, em, quando, horas, nivel = "ok") => ({ pct, in: em, when: quando, resetTs: 1800000000000 + horas * HORA, level: nivel, idle: false });
const conta = (o) => ({
  number: o.number,
  email: `conta${o.number}@exemplo.com`,
  alias: o.alias || null,
  org: "",
  plan: "Max",
  active: !!o.active,
  status: o.status || "ok",
  statusLabel: o.statusLabel || "ok",
  loginDead: !!o.loginDead,
  stale: false,
  ageMin: 1,
  session: o.session === undefined ? janela(10 * o.number, "2h", "hoje 18:00", 2) : o.session,
  weekly: o.weekly === undefined ? janela(20, "3d", "ter 24/11 18:00", 72 + o.number) : o.weekly,
  models: o.models || [],
  disabled: !!o.disabled,
  threshold: null,
  weeklyThreshold: null,
  modelThreshold: null,
  priority: 0,
  devices: o.devices || [],
});

/** Estado no formato do buildPayload() da extensão: conectado, conta 1 em uso, 4 outras contas. */
function estado(mudar) {
  const s = {
    type: "state",
    error: null,
    fetchedAt: 1800000000000,
    swapOn: true,
    privacy: false,
    server: {
      status: "online",
      statusText: "conectado a swap.exemplo.com. O servidor guarda os logins, renova e escolhe a conta deste computador.",
      connected: true,
      connecting: false,
      url: "https://swap.exemplo.com",
      host: "swap.exemplo.com",
      via: "google",
      deviceName: "PC de teste",
      myGoogle: "pessoa@exemplo.com",
      myAccount: "Conta 1 — conta1@exemplo.com",
      lastOkWhen: "hoje 14:32",
      version: "2.5.3",
      devices: [{ id: "d1", name: "PC de teste", current: true }, { id: "d2", name: "Hermes", current: false }],
      diag: null,
      rejected: null,
      canUploadLogins: true,
      addressChanged: false,
      configuredUrl: null,
      storeWarnings: [],
      storeBlocked: false,
      loginPromptOff: true,
      loginPromptNote: "Enquanto este computador estiver conectado ao servidor, o login do Claude Code é feito pelo Swap Plus",
      otherWindow: false,
    },
    accounts: [
      conta({ number: 1, active: true, alias: "trabalho", devices: ["PC de teste", "Hermes"], models: [{ name: "Fable", ...janela(48, "3d", "ter 24/11 18:00", 72) }] }),
      conta({ number: 2, session: janela(88, "40m", "hoje 15:15", 0.7, "warn"), weekly: janela(96, "1d", "dom 22/11 17:00", 24, "bad") }),
      conta({ number: 3, loginDead: true, status: "relogin_required", statusLabel: "precisa logar de novo", session: null, weekly: null }),
      conta({ number: 4, disabled: true }),
      conta({ number: 5, devices: ["Hermes"] }),
    ],
    modelNames: ["Fable"],
    modelsInUse: [],
    watch: [],
    rules: { sessionPct: 90, weeklyPct: 80, modelPct: 95, devicePlacement: "separate" },
    alerts: { fiveHourEnabled: true, fiveHourPct: 80, weeklyEnabled: true, weeklyPct: 70, modelEnabled: false, modelPct: 85 },
    auto: { enabled: true, last: null, lastWhen: null, history: [] },
    autoModel: { enabled: true },
    updates: { enabled: true, autoUpdate: true, pendingOnOpen: false, extInstalled: "3.2.0", last: { ts: "2026-11-21T12:00:00.000Z", when: "hoje 09:00", reason: "open", error: null, ext: { installed: "3.2.0", latest: "3.2.0" } } },
    ui: { showAccountNumber: false, showModelWeekly: true },
  };
  if (mudar) mudar(s);
  return s;
}
const semConexao = (s) => {
  s.error = "Este computador ainda não está conectado ao servidor.";
  s.accounts = [];
  Object.assign(s.server, { status: "disconnected", connected: false, deviceName: null, myGoogle: null, lastOkWhen: null, via: null, devices: [], loginPromptOff: false });
};

/** O mesmo elemento? (Comparar elementos com assert.equal faria o relatório de uma falha despejar a tela inteira.) */
const mesmo = (a, b, msg) => assert.ok(a === b, msg);

test("a tela abre, manda só “ready” e espera o primeiro estado com os controles desabilitados", () => {
  const tela = abrirTela();
  assert.deepEqual(tela.levar(), [{ type: "ready" }]);
  assert.equal(tela.$("masterToggle").disabled, true);
  assert.equal(tela.$("btnPanel").disabled, true);
  assert.equal(tela.$("more").open, false, "“Mais opções” começa fechado");
  assert.match(tela.texto(tela.$("connStatus")), /Carregando/);
  // eventos forçados em controles desabilitados não mandam nada
  for (const id of ["masterToggle", "alFiveOn", "uiPrivacy"]) tela.forcar(tela.$(id), "change");
  tela.forcar(tela.$("btnPanel"));
  tela.mover(tela.$("alFivePct"), 55);
  tela.avancar(1000);
  // toast e “ocupado” podem chegar antes do estado
  tela.entregar({ type: "toast", kind: "info", text: "antes do estado" });
  tela.entregar({ type: "busy", on: true, text: "ocupado" });
  assert.equal(tela.texto(tela.$("toast")), "antes do estado");
  assert.equal(tela.texto(tela.$("busy")), "ocupado");
  assert.deepEqual(tela.levar(), []);
  inteira(tela, "antes do estado");
});

test("conectado: conexão, conta em uso, lista para trocar e as linhas da troca automática e dos serviços juntos", () => {
  const tela = abrirTela();
  tela.levar();
  tela.entregar(estado());
  assert.deepEqual(tela.levar(), [], "desenhar não manda nada");
  assert.equal(tela.$("masterToggle").checked, true);
  assert.equal(tela.texto(tela.$("masterState")), "Ligado");
  assert.equal(tela.texto(tela.$("connStatus")), "Conectado a swap.exemplo.com");
  assert.equal(tela.texto(tela.$("connFacts")), "Este serviço: PC de teste entrou com pessoa@exemplo.com último contato: hoje 14:32");
  assert.ok(tela.botao("Sair") && !tela.botao("Entrar com Google"));
  const agora = tela.texto(tela.$("acctNow"));
  assert.match(agora, /^Conta 1 “trabalho” conta1@exemplo\.com Max Sessão 5h 10% renova em 2h · hoje 18:00 Semanal 20% renova em 3d · ter 24\/11 18:00 Fable 48% /);
  assert.match(agora, /Também em uso em: Hermes Troca automática: ligada — muda-se no painel do Swap$/);
  // as outras contas: primeiro as que dá para usar (quem renova o semanal antes na frente), no fim as que não dá
  const ordem = tela.$("acctList").children.map((li) => Number(li.getAttribute("data-n")));
  assert.deepEqual(ordem, [2, 5, 4, 3]);
  assert.equal(tela.texto(tela.linha(2)), "Conta 2 conta2@exemplo.com 5h 88% semana 96% Usar esta conta");
  assert.match(tela.texto(tela.linha(5)), /em uso em: Hermes/);
  assert.equal(tela.$("btnPanel").disabled, false);
  assert.equal(tela.texto(tela.$("footNote")), "Só o administrador entra no painel.");
  assert.doesNotMatch(tela.texto(tela.doc.body), /andam juntos/);
  inteira(tela, "conectado");

  tela.entregar(estado((s) => ((s.rules.devicePlacement = "together"), (s.auto.enabled = false))));
  assert.equal(tela.texto(tela.$("switchNotes")), "Neste Swap os serviços andam juntos: trocar aqui troca também nos outros que estão em uso.");
  assert.match(tela.texto(tela.$("acctNow")), /Troca automática: desligada — muda-se no painel do Swap$/);

  // modo privado: a extensão manda sem e-mail e sem apelido, e a tela não inventa
  tela.entregar(
    estado((s) => {
      s.privacy = true;
      for (const a of s.accounts) Object.assign(a, { email: null, alias: null });
      s.server.myGoogle = "(e-mail oculto)";
    })
  );
  assert.doesNotMatch(tela.texto(tela.$("acctCard")), /@/);
  assert.match(tela.texto(tela.$("acctNow")), /^Conta 1 Max /);
  assert.equal(tela.$("uiPrivacy").checked, true);
  inteira(tela, "modo privado");
});

test("liga/desliga: manda setEnabled e mostra “Desligando…” até a extensão confirmar", () => {
  const tela = abrirTela();
  tela.levar();
  tela.entregar(estado());
  tela.clicar(tela.$("masterToggle"));
  assert.deepEqual(tela.levar(), [{ type: "setEnabled", enabled: false }]);
  assert.equal(tela.texto(tela.$("masterState")), "Desligando…");
  tela.entregar(estado()); // estado antigo, do ciclo que estava em andamento
  assert.equal(tela.$("masterToggle").checked, false, "o estado antigo não desfaz o clique");
  tela.entregar(estado((s) => ((s.swapOn = false), (s.server.status = "off"))));
  assert.equal(tela.texto(tela.$("masterState")), "Desligado");
  assert.match(tela.texto(tela.$("connStatus")), /^Desligado$/);
  assert.match(tela.texto(tela.$("acctNow")), /está desligado neste VS Code/);
  assert.equal(tela.visivel(tela.$("acctList")), false, "desligado: a lista de contas (antiga) não aparece");
  tela.clicar(tela.$("masterToggle"));
  assert.deepEqual(tela.levar(), [{ type: "setEnabled", enabled: true }]);
  assert.equal(tela.texto(tela.$("masterState")), "Ligando…");
  tela.entregar({ type: "toast", kind: "error", text: "não deu" });
  assert.equal(tela.texto(tela.$("masterState")), "Desligado", "um erro da extensão desfaz a espera");
  // sem confirmação nenhuma, a espera acaba sozinha
  tela.clicar(tela.$("masterToggle"));
  tela.levar();
  tela.avancar(21000);
  assert.equal(tela.texto(tela.$("masterState")), "Desligado");
  assert.equal(tela.$("masterToggle").checked, false);
  inteira(tela, "liga/desliga");
});

test("conexão: cada botão manda a sua mensagem; parado ou desabilitado não manda nada", () => {
  const tela = abrirTela();
  tela.levar();
  tela.entregar(estado(semConexao));
  assert.equal(tela.texto(tela.$("connStatus")), "Não conectado");
  assert.match(tela.texto(tela.$("connBox")), /Este VS Code ainda não está conectado a swap\.exemplo\.com/);
  mesmo(tela.botao("Sair"), null, "sem conexão não há “Sair”");
  assert.equal(tela.visivel(tela.$("connFacts")), false);
  assert.match(tela.texto(tela.$("acctNow")), /Entre no cartão “Conexão”/);
  for (const [rotulo, method] of [["Entrar com Google", "google"], ["Colar código", "code"], ["Outro endereço…", "googleOther"]]) {
    tela.clicar(tela.botao(rotulo));
    assert.deepEqual(tela.levar(), [{ type: "connectServer", method }], rotulo);
  }
  // sem conexão o painel não abre daqui (a extensão abre o endereço da conexão)
  assert.equal(tela.$("btnPanel").disabled, true);
  assert.match(tela.texto(tela.$("footNote")), /conecte este VS Code primeiro/);
  tela.clicar(tela.$("btnPanel"));
  tela.forcar(tela.$("btnPanel"));
  assert.deepEqual(tela.levar(), []);

  // entrando com Google: os três botões ficam parados
  tela.entregar(estado((s) => (semConexao(s), (s.server.connecting = true))));
  for (const rotulo of ["Conectando…", "Colar código", "Outro endereço…"]) {
    tela.clicar(tela.botao(rotulo));
    tela.forcar(tela.botao(rotulo));
  }
  assert.deepEqual(tela.levar(), [], "conexão em andamento: nenhum botão manda nada");

  // acesso recusado: entrar de novo ou sair
  tela.entregar(estado((s) => (s.server.status = "revoked")));
  assert.equal(tela.texto(tela.$("connStatus")), "Acesso recusado");
  assert.ok(tela.botao("Entrar com Google") && tela.botao("Sair"));
  tela.clicar(tela.botao("Sair"));
  assert.deepEqual(tela.levar(), [{ type: "disconnectServer" }]);

  // servidor fora do ar: o motivo vem da extensão; a lista antiga fica, sem dar para trocar
  tela.entregar(estado((s) => Object.assign(s.server, { status: "offline", statusText: "tempo esgotado. Enquanto isso o login do Claude Code não é mexido." })));
  assert.equal(tela.texto(tela.$("connStatus")), "Servidor fora do ar");
  assert.match(tela.texto(tela.$("connBox")), /^Tempo esgotado\. Enquanto isso o login do Claude Code não é mexido\. O Swap Plus tenta de novo sozinho a cada 30 segundos\./);
  assert.match(tela.texto(tela.$("switchNotes")), /Sem resposta do servidor agora/);
  tela.clicar(tela.botaoDaConta(2));
  tela.forcar(tela.botaoDaConta(2));
  assert.deepEqual(tela.levar(), []);

  // avisos deste computador e “Usar a conta do servidor”
  tela.entregar(estado((s) => Object.assign(s.server, { storeWarnings: ["O Claude Code lê o login do Gerenciador de Credenciais do Windows."], storeBlocked: true, rejected: { reason: "o login não bate com a conta" }, otherWindow: true })));
  assert.match(tela.texto(tela.$("connBox")), /O Swap Plus não está gravando o login neste computador: O Claude Code lê o login do Gerenciador de Credenciais/);
  assert.match(tela.texto(tela.$("connBox")), /Login do Claude Code recusado pelo servidor: o login não bate com a conta\./);
  assert.match(tela.texto(tela.$("connBox")), /Outra janela do VS Code está cuidando do login/);
  tela.clicar(tela.botao("Usar a conta do servidor"));
  assert.deepEqual(tela.levar(), [{ type: "useServerAccount" }]);
  inteira(tela, "conexão");
});

test("trocar de conta: conta permitida manda switch; login morto, fora da troca e não liberada ficam desabilitadas com o motivo", () => {
  const tela = abrirTela();
  tela.levar();
  tela.entregar(estado());

  // permitida
  assert.equal(tela.botaoDaConta(2).disabled, false);
  tela.clicar(tela.botaoDaConta(2));
  assert.deepEqual(tela.levar(), [{ type: "switch", number: 2 }]);
  assert.equal(tela.texto(tela.botaoDaConta(2)), "Trocando…");
  mesmo(tela.doc.activeElement, tela.botaoDaConta(2), "o foco do teclado continua no botão");
  tela.clicar(tela.botaoDaConta(2));
  tela.forcar(tela.botaoDaConta(2));
  tela.forcar(tela.botaoDaConta(5));
  assert.deepEqual(tela.levar(), [], "com uma troca em andamento, outro clique (na mesma ou em outra conta) não manda nada");
  tela.entregar(estado((s) => ((s.accounts[0].active = false), (s.accounts[1].active = true), (s.fetchedAt += 1000))));
  assert.match(tela.texto(tela.$("acctNow")), /^Conta 2 /);
  mesmo(tela.linha(2), null, "a conta em uso sai da lista");
  assert.equal(tela.texto(tela.botaoDaConta(1)), "Usar esta conta");
  mesmo(tela.doc.activeElement, tela.$("acctNow"), "depois da troca o foco vai para a conta em uso");

  // o servidor recusou (nenhum estado novo chega): a espera acaba sozinha
  tela.clicar(tela.botaoDaConta(5));
  assert.deepEqual(tela.levar(), [{ type: "switch", number: 5 }]);
  tela.avancar(7000);
  assert.equal(tela.texto(tela.botaoDaConta(5)), "Usar esta conta");
  assert.equal(tela.botaoDaConta(5).getAttribute("aria-disabled"), null);

  // login morto
  tela.entregar(estado());
  assert.equal(tela.botaoDaConta(3).disabled, true);
  assert.match(tela.texto(tela.linha(3)), /Login morto: é preciso entrar de novo com esta conta/);
  // fora da troca, com a troca automática ligada: o servidor tiraria este VS Code dela na hora
  assert.equal(tela.botaoDaConta(4).disabled, true);
  assert.match(tela.texto(tela.linha(4)), /Fora da troca: com a troca automática ligada/);
  for (const n of [3, 4]) {
    tela.clicar(tela.botaoDaConta(n));
    tela.forcar(tela.botaoDaConta(n));
  }
  assert.deepEqual(tela.levar(), [], "conta desabilitada não manda nada (nem com clique forçado)");
  assert.ok(tela.$(tela.botaoDaConta(3).getAttribute("aria-describedby")), "o motivo está ligado ao botão");

  // computador que não envia logins: quem resolve o login morto é o administrador
  tela.entregar(estado((s) => (s.server.canUploadLogins = false)));
  assert.match(tela.texto(tela.linha(3)), /Login morto: o administrador precisa entrar de novo com esta conta, no painel do Swap\./);

  // troca automática desligada: a conta fora da troca pode ser usada à mão
  tela.entregar(estado((s) => (s.auto.enabled = false)));
  assert.equal(tela.botaoDaConta(4).disabled, false);
  assert.match(tela.texto(tela.linha(4)), /fora da troca/);
  tela.clicar(tela.botaoDaConta(4));
  assert.deepEqual(tela.levar(), [{ type: "switch", number: 4 }]);

  // se um dia o estado disser que a conta não está liberada para este serviço
  tela.entregar(estado((s) => ((s.accounts[4].allowed = false), (s.fetchedAt += 5000))));
  assert.equal(tela.botaoDaConta(5).disabled, true);
  assert.match(tela.texto(tela.linha(5)), /Não liberada para este serviço/);
  tela.clicar(tela.botaoDaConta(5));
  assert.deepEqual(tela.levar(), []);
  inteira(tela, "trocar de conta");
});

test("mais opções: avisos mandam saveAlerts só com o que mudou (sliders depois de uma pausa); exibição, atualizações e painel", () => {
  const tela = abrirTela();
  tela.levar();
  tela.entregar(estado());
  assert.deepEqual([tela.$("alFiveOn").checked, tela.$("alFivePct").value, tela.texto(tela.$("alFiveVal"))], [true, "80", "80%"]);
  assert.deepEqual([tela.$("alModelOn").checked, tela.$("alModelPct").disabled], [false, true]);
  assert.equal(tela.texto(tela.$("alModelLabel")), "Limite semanal do Fable");

  for (const [id, chave, valor] of [["alFiveOn", "fiveHourEnabled", false], ["alWeekOn", "weeklyEnabled", false], ["alModelOn", "modelEnabled", true]]) {
    tela.clicar(tela.$(id));
    assert.deepEqual(tela.levar(), [{ type: "saveAlerts", alerts: { [chave]: valor } }], id);
  }
  assert.equal(tela.$("alFivePct").disabled, true, "aviso desmarcado: o slider dele fica parado");
  // a extensão confirma (o estado traz o que a pessoa marcou) e depois os três avisos voltam a ficar ligados
  tela.entregar(estado((s) => (s.alerts = { fiveHourEnabled: false, fiveHourPct: 80, weeklyEnabled: false, weeklyPct: 70, modelEnabled: true, modelPct: 85 })));
  assert.deepEqual([tela.$("alFiveOn").checked, tela.$("alWeekOn").checked, tela.$("alModelOn").checked], [false, false, true]);
  tela.entregar(estado((s) => (s.alerts = { fiveHourEnabled: true, fiveHourPct: 80, weeklyEnabled: true, weeklyPct: 70, modelEnabled: true, modelPct: 85 })));
  for (const [id, chave, valor] of [["alFivePct", "fiveHourPct", 75], ["alWeekPct", "weeklyPct", 65], ["alModelPct", "modelPct", 90]]) {
    tela.mover(tela.$(id), valor - 1);
    tela.mover(tela.$(id), valor);
    assert.deepEqual(tela.levar(), [], "nada vai antes da pausa");
    tela.avancar(400);
    assert.deepEqual(tela.levar(), [{ type: "saveAlerts", alerts: { [chave]: valor } }], id);
  }
  assert.equal(tela.texto(tela.$("alFiveVal")), "75%");
  // estado que chega no meio do arrasto não mexe no slider; voltar ao valor gravado não salva nada
  const gravado = (s) => (s.alerts = { fiveHourEnabled: true, fiveHourPct: 75, weeklyEnabled: true, weeklyPct: 65, modelEnabled: true, modelPct: 90 });
  tela.entregar(estado(gravado));
  tela.mover(tela.$("alFivePct"), 91, false);
  tela.entregar(estado(gravado));
  assert.equal(tela.$("alFivePct").value, "91");
  tela.mover(tela.$("alFivePct"), 75);
  tela.avancar(400);
  assert.deepEqual(tela.levar(), []);
  // sem confirmação da extensão em 4 s, a caixa volta ao que está gravado
  tela.clicar(tela.$("alWeekOn"));
  tela.levar();
  tela.avancar(4500);
  assert.equal(tela.$("alWeekOn").checked, true);

  for (const [id, key, value] of [["uiPrivacy", "privacy.hideEmails", true], ["uiAcctNumber", "statusBar.showAccountNumber", true], ["uiModelWeekly", "statusBar.showModelWeekly", false]]) {
    tela.clicar(tela.$(id));
    assert.deepEqual(tela.levar(), [{ type: "ui", key, value }], id);
  }

  assert.match(tela.texto(tela.$("updBox")), /^Versão instalada: 3\.2\.0 · última publicada: 3\.2\.0 Última verificação: hoje 09:00 \(ao abrir o VS Code\)\./);
  tela.clicar(tela.$("btnUpdates"));
  assert.deepEqual(tela.levar(), [{ type: "checkUpdates" }]);
  tela.clicar(tela.$("btnPanel"));
  assert.deepEqual(tela.levar(), [{ type: "openPanel" }], "openPanel vai sem endereço nenhum");
  inteira(tela, "mais opções");
});

test("“Mais opções deste VS Code” abre fechado e lembra aberto/fechado pela API de estado do webview", () => {
  let tela = abrirTela();
  assert.equal(tela.$("more").open, false);
  tela.clicar(tela.$("more").todos().find((e) => e.tagName === "SUMMARY"));
  assert.deepEqual(tela.guardado(), { moreOpen: true });
  tela = abrirTela({ guardado: tela.guardado() });
  assert.equal(tela.$("more").open, true, "a tela reabre como a pessoa deixou");
  tela.clicar(tela.$("more").todos().find((e) => e.tagName === "SUMMARY"));
  assert.deepEqual(tela.guardado(), { moreOpen: false });
  for (const lixo of ["lixo", 7, null, [], { moreOpen: "sim" }]) assert.equal(abrirTela({ guardado: lixo }).$("more").open, false, `estado guardado estranho: ${JSON.stringify(lixo)}`);
});

test("estado incompleto ou estragado nunca derruba a tela; texto com marcação aparece como texto", () => {
  const tela = abrirTela();
  tela.levar();
  const quebrados = [
    { type: "state" },
    { type: "state", server: null, accounts: null, alerts: null, ui: null, auto: null, rules: null, updates: null },
    { type: "state", server: "x", accounts: "x", alerts: 5, ui: [], auto: 0, rules: "y", updates: "z", swapOn: "sim", privacy: "não", error: { a: 1 } },
    { type: "state", swapOn: true, server: { status: "online", connected: true }, accounts: [null, 5, "x", {}, { number: "abc" }, { number: 1 }, { number: 2, active: true, session: {}, weekly: { pct: "x" }, models: "x" }] },
    { type: "state", swapOn: true, server: { status: "online", connected: true, devices: [null, 3, { current: true }], storeWarnings: [null, 4, "aviso"], rejected: {}, host: 42 }, accounts: [{ number: 1, active: true, models: [null, {}, { pct: 10 }], devices: [null, 7, "A"], session: { pct: 250 }, weekly: { pct: -3, in: 5 } }] },
    { type: "state", swapOn: true, server: { status: "online", connected: true }, accounts: [{ number: 1, active: true }, { number: 1, active: true }, { number: 1e21 }], alerts: { fiveHourEnabled: true, fiveHourPct: 1000, weeklyEnabled: null, weeklyPct: "70", modelEnabled: 1, modelPct: null }, updates: { last: { ext: null, reason: 5, error: {} }, extInstalled: null } },
    null,
    "texto",
    42,
    [],
    { type: "toast" },
    { type: "toast", text: null, kind: "error" },
    { type: "busy" },
    { type: "acctSaved", ok: false, number: 1 },
    { type: "tipo-desconhecido" },
  ];
  for (const [i, m] of quebrados.entries()) {
    tela.entregar(m);
    inteira(tela, `estado quebrado ${i}`);
  }
  // campo que não veio: a caixa fica desabilitada em vez de mostrar um valor inventado
  tela.entregar(quebrados[1]);
  for (const id of ["alFiveOn", "alFivePct", "uiPrivacy", "uiModelWeekly"]) assert.equal(tela.$(id).disabled, true, id);

  // erro que nenhuma situação conhecida explica aparece inteiro
  tela.entregar({ type: "state", swapOn: true, error: "erro que a tela não conhece", server: { status: "inventado", connected: true } });
  assert.match(tela.texto(tela.$("connBox")), /erro que a tela não conhece/);

  // nomes vindos do servidor nunca viram marcação
  tela.entregar(estado((s) => Object.assign(s.accounts[0], { alias: "<img src=x onerror=alert(1)>", email: "<b>x</b>@exemplo.com", devices: ["PC de teste", "<i>d</i>"] })));
  assert.match(tela.texto(tela.$("acctNow")), /“<img src=x onerror=alert\(1\)>” <b>x<\/b>@exemplo\.com/);
  assert.equal(tela.$("acctNow").todos().filter((e) => ["IMG", "B", "I", "SCRIPT"].includes(e.tagName) && e.textContent === "").length, 0);
  assert.deepEqual(tela.levar(), [], "estados quebrados não mandam nada");
  inteira(tela, "depois dos estados quebrados");

  // uma parte que falha ao desenhar vira um aviso curto e as outras continuam
  const lista = tela.$("acctList");
  lista.removeAttribute("id");
  tela.entregar(estado((s) => ((s.accounts[0].session.pct = 35), (s.server.lastOkWhen = "hoje 14:33"))));
  assert.equal(tela.erros.length, 0, "o erro não escapa");
  assert.match(tela.texto(tela.$("renderError")), /^Não consegui desenhar a conta em uso nesta tela/);
  assert.match(tela.texto(tela.$("connFacts")), /hoje 14:33/, "a conexão foi atualizada mesmo assim");
  lista.id = "acctList";
  tela.entregar(estado());
  inteira(tela, "depois de voltar ao normal");
  assert.equal(tela.$("acctList").children.length, 4);
});
