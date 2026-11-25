# Relatório de teste — 20261125-qualidade-swapplus — claude

- **Commit testado:** `04004f4` (04004f44c641cb747a1e5fec94b7a8ec22eaf348), branch `bragarpaulo/20261125-qualidade-swapplus`,
  comparado com `origin/main` (`afbf75d`). Durante o teste o outro tester gravou `a416541` (só o relatório dele). O código
  é o mesmo do `04004f4`.
- **Spec:** `docs/specs/20261125-qualidade-swapplus.md`, só a Fase 1.
- **Veredito:** REPROVADO. Um critério falhou: o **23**, na parte do apelido da conta. O resto passou: 29 critérios
  conferidos, sem regressão nas suítes.

## Como o teste foi feito

- Tudo foi feito nesta máquina: Node 24.22.3, VS Code portátil 1.148 em `~/.local/opt/vscode` e Xvfb.
  - Nada foi enviado ao servidor real, à Anthropic ou ao Google.
  - Nenhum token real foi usado. Não houve push nem tag.
- O outro tester estava com o ambiente dele em 3008/3009/3010, na mesma pasta. Por isso não usei o ambiente dele nem rodei
  `limpar` ali.
  - O `ambiente-local.js` não aceita outras portas: elas são constantes.
  - Criei então uma **cópia** do commit (`git archive 04004f4`) numa pasta temporária. Nela, troquei só as três
    constantes de porta para **3018/3019/3020**. Os critérios 1–5, 8–16, 18, 23, 24, 26–30 e 11 foram conferidos nessa
    cópia.
  - `testes` e `medir` rodaram no repositório. Eles não usam essas portas.
- Painel: aberto com Chromium headless (playwright-core já instalado na máquina), login pelo Google falso.
- VS Code:
  - sem tela, no Xvfb, aberto pelo `node dev/ambiente-local.js vscode`;
  - comandado pelo protocolo de depuração do Chromium, mais `xdotool` para os diálogos nativos;
  - prints em `docs/testes/prints-claude/`.

## Comandos rodados

| Comando | Resultado |
|---|---|
| `node dev/ambiente-local.js testes` | ok em 55 s. node --check (42 arquivos) ok. smoke --unit ok. Extensão **112/0**, servidor **303/0**, cliente **183/0**, design ok. **0 bloqueios `[sem-internet]`**. |
| `NODE_OPTIONS="--require ./dev/sem-internet.js" node -e "fetch('https://example.com')…"` | `[sem-internet] bloqueado: example.com:443` + `bloqueado` (com aspas, desvio aceito do crit. 7) |
| `node dev/ambiente-local.js` (cópia, 3018) | no ar em **0,2 s**: painel, código de conexão e `admin@local.test`; `curl :3019/v1/health` → `{"ok":true,"version":"2.8.0"}` |
| `node dev/ambiente-local.js medir` | ok em 51 s; todas as metas ok (tabela abaixo) |
| `node dev/ambiente-local.js cliente` (cópia) | pareou, ciclo feito, token `sk-ant-oat01-SIMULADO-1-0…` |
| `node dev/conferir-design.js` | 0; com `color: #123456` → 1 e `server/web/app.css:527`; com `font-size: 17px` → 1 e a linha |
| `node dev/ambiente-local.js limpar --sim` (cópia com `git init`) | `Apagado: dev/.dados/`; `git status` limpo; nada versionado em `dev/.dados` |

Resultado do `medir` (antes = `origin/main` afbf75d):

| medida | antes | depois | dep/ant | meta |
|---|---|---|---|---|
| scanLimitErrors — mediana (ms) | 958 | 316 | 33% | ≤ 40% |
| detectModels — mediana (ms) | 972 | 306 | 32% | |
| varreduras completas/min, 3 janelas | 18 | 4 | 22% | ≤ 4 |
| painel: 1ª abertura com gzip (bytes) | 226712 | 61779 | 27% | ≤ 30% |
| painel: reabertura com If-None-Match (bytes) | 226712 | 0 | 0% | 304 |

## Critérios de aceite

| # | Critério | Resultado | Evidência |
|---|---|---|---|
| 1 | Sobe em ≤ 15 s com endereço, código e admin; health ok | passou | 0,2 s; saída com painel, `swapplus1:…`, `admin@local.test`; health `"ok":true` |
| 2 | Admin pelo Google falso vê 4 contas e "Hermes (simulado)" | passou | `painel-dark.png`, `painel-servicos-apos-reinicio.png`. Contas 1–4 com os usos do `dados.json`. A conta 3 aparece "Ainda sem leitura" no primeiro minuto e recebe a leitura no ciclo seguinte. A conta 4 aparece com "Login morto". |
| 3 | `intruso@local.test` recusado | passou | `painel-intruso.png`: "Conta não liberada" |
| 4 | Ctrl+C e subir de novo não duplica | passou | "Cofre já tinha dados (4 contas, 1 serviço(s)): nada semeado de novo"; cada `contaN@local.test` 1×; 1 Hermes |
| 5 | `_simular/uso` conta 1 a 95% → painel mostra; troca no histórico | passou (obs.) | Curl às 09:08:31. Às 09:17:17 o histórico registrou: `Trocou da conta 1 para a conta 3: sessão em 95% (linha 90%)`, no serviço ativo (Cliente). O painel e a extensão mostram 5h 95%. Ver Observações sobre o tempo. |
| 6 | `testes` passa, 0 bloqueios, totais ≥ 106/283/181 | passou | 112/303/183, 0 bloqueios |
| 7 | `sem-internet` bloqueia example.com | passou | ver comandos |
| 8 | `cliente` pareia, ciclo, token SIMULADO; `~/.claude` intacto | passou | `stat ~/.claude/.credentials.json` mostra 1795603647 antes e depois |
| 9 | VS Code: conectar pelo código, barra com uso, credencial simulada, nada do usuário muda | passou | `vscode-conectado.png`: "Sessão (5h): 10% … Semanal: 15%" (conta 3). `dev/.dados/home/.claude/.credentials.json` tem `sk-ant-oat01-SIMULADO-3-0`. `~/.claude` não mudou e não existe `~/.config/Code`. |
| 10 | F5 abre o Dev Host com o Swap Plus | passou | `vscode-f5.png`: configuração "Swap Plus (plus/) — ambiente local", Dev Host com a barra do Swap Plus ("não conectado", perfil do F5 sem `password-store=basic`; desvio aceito) |
| 11 | `limpar --sim` apaga só `dev/.dados/`, git limpo | passou | ver comandos |
| 12 | "notewin", " NoteWin ", "NOTEWIN", "Note  Win" → 409 com a mensagem; código continua valendo | passou | API: os quatro dão 409 `name_taken` com a mensagem exata. Depois, com o mesmo código, "Outro-12" → 200. Pelo cliente, `--dados …/cliente2` também dá a mensagem. No VS Code, `vscode-codigo-nome-repetido.png`. |
| 13 | Σίσυφος × ΣΊΣΥΦΟΣ/σίσυφοσ → 409; Sisyphos/Σισυφος conectam | passou | 409, 409, 200, 200 |
| 14 | José × Jose → conecta; Jose+U+0301 → 409 | passou | 200 / 409 |
| 15 | Google com nome repetido: VS Code mostra e pede outro; página mostra; nenhum serviço novo | passou | No início do login, `notewin` → 409 em `login/start` (`vscode-google-nome-repetido-inicio.png`). No retorno, "Corrida3" estava livre ao iniciar e foi ocupado antes do callback. A página mostrou "Nome em uso" com a mensagem (`navegador-google-nome-repetido.png`). O VS Code reabriu o nome com a mensagem (`vscode-google-nome-repetido-retorno.png`). O cofre ficou com 1 "corrida3". |
| 16 | Reconectar o mesmo VS Code com o mesmo nome: um só, token antigo 401, linha no histórico | passou | `vscode-reconectar-dialogo.png` → `vscode-reconectado.png`. O id passou de 6392718a786c para 73125fed176a e ficou 1 "Tester VS". O histórico tem `Serviço "Tester VS" reconectado: o acesso anterior deixou de valer`. Pela API, o token antigo dá `/v1/state` 401 e o novo, 200. |
| 17 | Pareamentos simultâneos: um 200, outro 409 | passou (por teste) | Os testes automáticos de `api.test.js` passam, com código "infinito" para isolar o nome. Em caixa-preta, com o mesmo código, sai 200 + **401** (código já gasto), porque só há um código ativo por vez. O que importa vale: nunca saem dois serviços. |
| 18 | Renomear B para o nome de A → erro; A para outra caixa → aceito | passou | API: 409 e 200. Na tela, o aviso aparece com a mensagem (`painel-renomear-409.png`). |
| 19 | Cofre com dois "NoteWin" antigos fica intacto | passou (por teste) | `api.test.js` e `web.test.js` "(critério 19)" |
| 20 | 3 janelas → 1 aviso e 1 linha | passou (por teste) | `servermode.test.js` 22g |
| 21 | 2 janelas → 1 `limit_hit` | passou (por teste) | `servermode.test.js` 22h |
| 22 | `CLAUDE_CONFIG_DIR` em `checkLimitErrors`/`detectModels` | passou (por teste) | `smoke.js --unit`, seção I |
| 23 | Nome e **apelido** cortados sem surrogate solto | **falhou** | O nome passou: 60 pontos de código, sem surrogate. O **apelido falhou**: ver o problema 1. |
| 24 | Nome de 55 renomeado para outro de 55 | passou | 55→55 e 55→60 dão 200; 61 dá 400 "de 1 a 60 caracteres" |
| 25 | `medir` com as metas | passou | tabela acima |
| 26 | `app.js` gzip ≤ 45.000; If-None-Match → 304 | passou | 41.231 bytes, `Content-Encoding: gzip`, `Vary`, ETag `"sha256-…"`; 304 com 0 bytes |
| 27 | API sem `Content-Encoding` | passou | `GET /v1/health` e `/web/api/me` sem `Content-Encoding`. O `curl -sI` do critério recebe 405, porque a API não tem HEAD; a conferência foi com GET. |
| 28 | `conferir-design` 0; cor literal → ≠ 0 com arquivo:linha | passou | ver comandos |
| 29 | Painel claro e escuro legível; h1 22px | passou | `painel-dark.png`, `painel-light.png`, `painel-interruptor-*.png`. Estilos calculados: h1 22px nos dois temas. Interruptor com o botão em `--accent-fg`. `--okring` com `rgba(46,160,67,.2)` no escuro e `rgba(31,136,61,.2)` no claro. "Desconectar" legível nos dois. |
| 30 | Interruptor da extensão no alto contraste usa a cor do tema | passou | `vscode-configuracoes-alto-contraste.png` e `vscode-configuracoes-escuro.png`. Interruptor em `var(--vscode-charts-green)` e botão em `--vscode-button-foreground` (`panel.css:8,73-74`). |

## Problemas encontrados

### [BLOQUEANTE] Apelido da conta ainda fica com meio emoji (critério 23)
- **Onde:** `server/src/engine.js:2892`. Lá, `next.alias = v.trim().slice(0, 40)` corta por unidade UTF-16.
  - O `cleanText(body.alias, 40)` do `server.js` já corta por ponto de código.
  - Mas o motor corta de novo, agora em 40 **unidades UTF-16**.
  - O mesmo caminho vale para o apelido pelo painel.
- **Como reproduzir:** com o ambiente no ar e um serviço conectado (token `T`):
  `curl -X PATCH :3008/v1/accounts/3 -H "Authorization: Bearer T" -H 'Content-Type: application/json' -d '{"alias":"x😀😀😀…(30 emojis)"}'`
  e depois `GET /v1/state`.
- **Esperado:** apelido com até 40 pontos de código e sem surrogate solto.
- **Obtido:** `"x😀…(19 emojis)\ud83d"`, com 21 pontos de código, 40 unidades e um **surrogate solto**.
  - O VS Code e o painel mostram um caractere quebrado ("▫"/"�") no fim do apelido; ver
    `vscode-configuracoes-escuro.png`, conta 3.
  - O teste do critério 23 (`api.test.js`) não pega o erro por dois motivos: usa o motor falso (`FakeEngine`), e o
    texto dele (`"Conta 😀"` × 10) termina exatamente na 40ª unidade, sem cortar emoji.
- **Correção sugerida:** usar `cortar(v.trim(), 40)` de `server/src/nomes.js` no motor e cobrir com um teste no motor real.
  - `preferModel` (`engine.js:360`) tem o mesmo padrão, mas recebe nomes de modelo e não entra no critério.

### [SUGESTÃO] `curl -sI` do critério 27 recebe 405
- **Onde:** API (`/v1/health` só aceita GET).
- O critério passa, porque não há `Content-Encoding`, mas o comando escrito na spec não testa nada.
- Sugestão: trocar, na spec ou no README, por `curl -s -D - -o /dev/null -H 'Accept-Encoding: gzip' …`.

### [SUGESTÃO] `ambiente-local.js` com portas fixas
- Dois testers na mesma pasta não conseguem ter cada um o seu ambiente.
- Um `--portas` ou variáveis de ambiente (`PORTA_API` etc.) evitariam ter que copiar o repositório. Isso não é critério.

## Observações

- **Critério 5 (tempo):** a troca saiu cerca de 9 min depois do curl.
  - A conta 1 estava "longe das linhas" (sessão 2%), e nesse caso o motor relê a cada 10 min (`POLL_ACTIVE_FAR_MS`).
  - "Até 2 ciclos de uso" vale se o ciclo for esse de 10 min. Quem espera ver o número em poucos minutos pode achar que
    não funcionou.
  - Vale o `subir` avisar que a leitura pode levar até 10 min, ou o `_simular/uso` marcar a conta para ler logo.
- **Troca só nos serviços ativos:** só o "Cliente (simulado)" trocou. O Hermes semeado e os serviços pareados pela API não
  mandam batimento, então ficam na conta 1. Esse é o comportamento esperado do motor.
- **Diálogo "Conectar de novo?" do VS Code:** no Linux sem tela ele é nativo e não aparece no print da janela, só no da
  tela inteira (`vscode-reconectar-dialogo.png`). Enquanto está aberto, um novo "Conectar" mostra "já há uma conexão em
  andamento". Não é defeito.
- **API ouvindo em `0.0.0.0:3008` com `ALLOW_IPS=127.0.0.1`:** desvio aceito pelo PM.
- **Regressões:** nenhuma.
  - As suítes antigas continuam passando, com totais acima da linha de base.
  - Painel, extensão e cliente fizeram os fluxos principais sem erro.
- Não foi testado: a extensão 3.5 contra o servidor 2.8, que é a ressalva conhecida do PM.
