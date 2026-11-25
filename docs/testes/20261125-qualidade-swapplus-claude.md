# Relatório de teste — 20261125-qualidade-swapplus — claude

- **Commit testado (volta 3):** `ab85ff0` (ab85ff0d98ca55ae79bece012226fc8844f5dba2), último commit de código da branch
  `bragarpaulo/20261125-qualidade-swapplus`, comparado com `origin/main` (`afbf75d`). Durante o teste entrou o
  `1c05f3e`, que traz só o relatório do GPT, sem código.
- **Spec:** `docs/specs/20261125-qualidade-swapplus.md`, só a Fase 1.
- **Veredito (volta 3):** APROVADO. Os 30 critérios passam no `ab85ff0`.
  - O F5 agora abre um VS Code separado, no perfil isolado. Reproduzi o cenário do GPT, com um perfil pai apontando para
    outra porta, e o host não herdou nada dele.
  - O F5 acompanha o `SWAP_PLUS_PORTAS`, e o `limpar` padrão preserva `portas-*`.
  - Nada da volta 2 regrediu.
  - Ficam três sugestões, nenhuma bloqueante.
- As voltas 2 (`deed985`, APROVADO) e 1 (`04004f4`, REPROVADO) continuam abaixo, sem mudanças.

## Volta 3

### Como o teste foi feito

- Tudo foi feito nesta máquina: Node 24.22.3, VS Code portátil, Xvfb próprio (`:96`) e Chromium headless
  (playwright-core).
  - Nada foi enviado ao servidor real, à Anthropic ou ao Google.
  - Nenhum token real foi usado. Não houve push nem tag.
- Meu ambiente rodou nas portas padrão **3008/3009/3010**, com `dev/.dados/`. O tester GPT trabalhou numa pasta dele
  (`/tmp/swap-gpt-v3-repo`, 3018–3020).
- Um VS Code que sobrou da volta 2 do GPT ainda estava aberto no perfil `dev/.dados/vscode/` deste repositório. Não mexi
  nele.
  - Por isso o F5 e o subcomando `vscode` foram testados numa cópia `git archive ab85ff0` (com `git init`), apontando
    para o meu servidor na 3008. Outro VS Code no mesmo perfil passaria a janela para a instância que já estava aberta.
- O ambiente da cópia nas portas 3028–3030 serviu para o F5 com `SWAP_PLUS_PORTAS`.
- Para os prints do VS Code, usei o framebuffer do Xvfb (`-fbdir`) convertido para PNG.
- No fim, encerrei tudo o que abri: ambientes com Ctrl+C (SIGINT), VS Code e Xvfb. Nenhuma porta ficou ocupada.

### Comandos rodados

| Comando | Resultado |
|---|---|
| `node dev/ambiente-local.js testes` | ok. `node --check` (42 arquivos) ok, `smoke --unit` ok. Extensão **112/0**, servidor **305/0**, cliente **183/0**, design ok. **0 bloqueios `[sem-internet]`**. |
| `git diff --check origin/main...ab85ff0` | **acusa** `.vscode/launch.json:47: trailing whitespace`. Ver sugestão 1. |
| `git diff --stat deed985 ab85ff0 -- plus server cliente src` | vazio: o código do produto não mudou desde a volta 2. Só mudaram `launch.json`, `README.md`, `dev/ambiente-local.js` e `dev/medir-desempenho.js`. |
| `node dev/ambiente-local.js` | no ar em 0,3 s: "Cofre já tinha dados (4 contas, 16 serviço(s)): nada semeado de novo". |
| `node dev/ambiente-local.js medir` | ok; todas as metas ok (tabela abaixo). Grava em `dev/.dados/medidas.json`. |
| `medir --portas 3028,3029,3030 --projetos 10 --arquivos 5 --vezes 2` | grava em `dev/.dados/portas-3028/medidas.json`. Com 10 projetos, "mesmoResultado ok": as duas versões acham o limite em `recente-4.jsonl`. Isso confirma a correção do `medir` com menos de 29 projetos. O "scan40 NÃO" é esperado com tão pouco dado e não é critério; a meta vale com o padrão de 300 projetos. |
| `cliente --dados dev/.dados/cliente-claude-v3 --nome "Cliente Claude V3"` | pareou e fez o ciclo. Token `sk-ant-oat01-SIMULADO-1-…`. `~/.claude/.credentials.json` ficou com o mesmo mtime (1795611027). |
| `NODE_OPTIONS="--require ./dev/sem-internet.js" node -e "fetch('https://example.com')…"` | `[sem-internet] bloqueado: example.com:443` e `bloqueado` |
| `--portas 1,2,3` / `3028,3028,3030` / `abc`; `SWAP_PLUS_PORTAS=99999,3029,3030` | todos saem com 2 |

Resultado do `medir` (antes = `origin/main` afbf75d). A máquina estava carregada, com o outro tester rodando junto.

| medida | antes | depois | dep/ant | meta |
|---|---|---|---|---|
| scanLimitErrors — mediana (ms) | 2076 | 315 | 15% | ≤ 40% |
| detectModels — mediana (ms) | 2304 | 286 | 12% | |
| scanLimitErrors — 1ª execução, fria (ms) | 574 | 557 | 97% | |
| varreduras completas/min, 3 janelas | 18 | 4 | 22% | ≤ 4 |
| painel: 1ª abertura com gzip (bytes) | 226712 | 61779 | 27% | ≤ 30% |
| painel: reabertura com If-None-Match (bytes) | 226712 | 0 | 0% | 304 |

A 1ª execução fria saiu parecida nas duas versões porque o cache do disco já estava quente. Não é meta.

### Foco da volta 3

**1. F5 isolado de verdade (bloqueante do GPT na volta 2): corrigido.**
- Montei o cenário do GPT na cópia `ab85ff0`.
  - O VS Code "pai" usa o perfil `scratchpad/pai/user` com `"swapPlus.server.url": "http://127.0.0.1:3999"`, além de
    `HOME` próprio.
  - Ele abre a pasta da cópia, e o F5 roda na configuração "Swap Plus (plus/) — ambiente local".
- O F5 roda `node ./dev/ambiente-local.js vscode --inspect-extensions=9339`. Esse comando abre **outro processo** do
  VS Code com `--user-data-dir=<cópia>/dev/.dados/vscode/user-data`, `--extensions-dir` no mesmo lugar e
  `--no-sandbox`, que o próprio script acrescenta.
  - O Extension Development Host saiu numa janela própria.
  - Os processos do renderer e do host de extensões rodam com o perfil isolado, e não com o do pai.
- **Endereço:** em "Swap Plus: Conectar ao servidor", o host oferece "Entrar com Google **127.0.0.1:3008**", e não o
  `3999` do pai (`v3-vscode-f5-isolado.png`).
  - Conectei pelo código: "conectado ao servidor 127.0.0.1:3008", e a barra mostrou o uso (`v3-vscode-f5-conectado.png`).
- **HOME e CLAUDE_CONFIG_DIR:** a credencial `sk-ant-oat01-SIMULADO-3-0` foi gravada em
  `<cópia>/dev/.dados/home/.claude/.credentials.json`.
  - A `HOME` do pai continuou sem `.claude`, e o `~/.claude` real manteve o mesmo mtime.
- **Segredos/estado:** o `state.vscdb` do perfil isolado tem as chaves de `paulo-local.swap-plus`. O do perfil pai não tem
  nenhuma. O `exthost.log` do pai não registra a ativação do `paulo-local.swap-plus`, e o do perfil isolado registra
  (`onStartupFinished`).
- **Shift+F5** encerra o `ambiente-local` e, com ele, o VS Code isolado: não sobra processo.
- **Depurador:** a configuração composta "Swap Plus (plus/) — ambiente local + depurador" abriu o host isolado e anexou o
  depurador.
  - `ss` mostra a 9339 escutando no host de extensões isolado, com uma conexão aberta a partir do processo do VS Code pai
    (`v3-vscode-f5-depurador.png`).
  - O ícone de depuração mostra 2 sessões.

**2. F5 acompanhando `SWAP_PLUS_PORTAS`.**
- Subi o ambiente da cópia com `SWAP_PLUS_PORTAS=3028,3029,3030` e abri o VS Code pai com a mesma variável no ambiente.
  O F5 abriu o host com `--user-data-dir=<cópia>/dev/.dados/portas-3028/vscode/user-data`.
- "Conectar ao servidor" ofereceu **127.0.0.1:3028** (`v3-vscode-f5-portas-3028.png`). A conexão pelo código do `subir`
  da 3028 funcionou, e a credencial foi para `portas-3028/home/.claude/`.
- Sem a variável no ambiente, o `launch.json` passa `SWAP_PLUS_PORTAS=""` (`${env:…}` vazio). O script trata isso como
  portas padrão: conferido no ambiente do processo `ambiente-local.js vscode` lançado pelo F5.
- Limite: a porta do depurador é sempre 9339 (sugestão 2).

**3. `limpar` padrão preservando `portas-*` (minha sugestão da volta 2): corrigido.**
- Na cópia, com `home`, `tmp`, `vscode`, `portas-3028` e `portas-3038` em `dev/.dados/`:
  - `limpar --sim` → "Apagado: dev/.dados/ (ficaram os ambientes de outras portas: portas-3028, portas-3038; apague cada
    um com limpar --portas)". Só sobraram as duas `portas-*`.
  - `limpar --sim --portas 3028,3029,3030` → "Apagado: dev/.dados/portas-3028/". A 3038 continuou lá.
  - Sem `--sim`, a resposta "n" dá "Nada apagado.", e "s" apaga com a mesma regra.
  - `git status` ficou limpo em todos os casos.
- A pergunta sem `--sim` ainda não cita as `portas-*` que ficam, mas a saída depois cita. Não é defeito.

**4. Nada da volta 2 regrediu.**
- **Link simbólico de subagente e de transcrição.** Rodei o mesmo roteiro da volta 2, chamando o `scanLimitErrors` real
  da extensão com o vscode falso do `smoke.js`, nas duas versões:

| layout | origin/main | ab85ff0 |
|---|---|---|
| A. `subagents/agent.jsonl` é link para arquivo | acha | acha |
| B. pasta `subagents` é link | acha | acha |
| C. pasta da sessão é link | nada | **acha** |
| D. transcrição do projeto é link | nada | **acha** |
| E. pasta do projeto é link | nada | **acha** |
| F. laço + link quebrado | nada | nada (2 ms, sem travar) |
| G. arquivo comum | acha | acha |

- O ganho de tempo se manteve: ver a tabela do `medir`.
- **Apelido e cortes sem meio emoji (motor real, pela API):** `PATCH /v1/accounts/4`, depois `GET /v1/state`.
  - `"x"+30×😀` → 31 pontos de código.
  - `39×"a"+😀` → 40.
  - `41×😀` → 40 (80 unidades UTF-16).
  - `"  "+25×👍🏽+"  "` → 40.
  - Nome de serviço `"V3"+70×😀` → 60 pontos de código.
  - Nenhum deixou surrogate solto.
  - No VS Code, o apelido da conta 2 ("bbb…b👍") aparece inteiro (`v3-vscode-alto-contraste.png`).
- **Reinício (critério 4).**
  - Ctrl+C: "cofre gravado; até mais", e as portas foram liberadas.
  - Subi de novo: "Cofre já tinha dados (4 contas, 27 serviço(s))", no ar em 0,3 s.
  - Painel, antes e depois: 4 contas, 27 serviços, 1 "Hermes (simulado)", 0 nomes repetidos
    (`v3-painel-servicos-antes.png` / `-depois.png`).
- **Propagação da mudança de uso (critério 5).**
  - 10:07:33: `POST :3010/_simular/uso {"conta":3,"sessao":95}`. Nesse momento, uma sonda (serviço com heartbeat a cada
    30 s) estava na conta 3.
  - 10:17:19, **9 min 46 s** depois (dentro do "até 10 min" avisado): o histórico registra `Trocou da conta 3 para a conta
    1: sessão em 95% (linha 90%)` para "Sonda V3" e para o outro serviço ativo na conta 3.
  - A conta 1 estava em 2% (`v3-painel-historico.png`).

### Critérios de aceite (volta 3, ab85ff0)

| # | Critério | Resultado | Evidência |
|---|---|---|---|
| 1 | Sobe em ≤ 15 s com endereço, código e admin; health ok | passou | 0,3 s (duas vezes); `/v1/health` → `{"ok":true,"version":"2.8.0"}` |
| 2 | Admin pelo Google falso vê 4 contas e "Hermes (simulado)" | passou | `v3-painel-dark.png`: contas 1–4, a conta 4 com "Login morto". Serviços com 1 Hermes. |
| 3 | `intruso@local.test` recusado | passou | `v3-painel-intruso.png`: "Conta não liberada" |
| 4 | Ctrl+C e subir de novo não duplica | passou | foco 4 |
| 5 | Uso a 95% → painel mostra; troca no histórico | passou | foco 4 (9 min 46 s) |
| 6 | `testes` passa, 0 bloqueios, totais ≥ 106/283/181 | passou | 112/305/183, 0 bloqueios |
| 7 | `sem-internet` bloqueia example.com | passou | comandos |
| 8 | `cliente` pareia, ciclo, token SIMULADO; `~/.claude` intacto | passou | comandos |
| 9 | VS Code: conectar pelo código, barra com uso, credencial simulada, nada do usuário muda | passou | Subcomando `vscode` (`v3-vscode-conectado.png`): barra "Sessão (5h): 2% … Semanal: 30%", credencial `SIMULADO-1` no `CLAUDE_CONFIG_DIR` isolado. O subcomando foi lançado com `VSCODE_IPC_HOOK_CLI` apontando para um socket falso e sem `--no-sandbox`, e abriu mesmo assim: limpou as variáveis e pôs a flag sozinho. Pelo F5, ver foco 1. |
| 10 | F5 abre o Dev Host com o Swap Plus | passou | foco 1 e 2: agora isolado de verdade |
| 11 | `limpar --sim` apaga só `dev/.dados/`, git limpo | passou | foco 3 |
| 12 | Variações de "NoteWin" → 409 com a mensagem; código continua valendo | passou | "notewin", " NoteWin ", "NOTEWIN" → 409 `name_taken` com a mensagem exata. Depois, o mesmo código conectou "Alfa V3-…" (200). |
| 13 | Σίσυφος × ΣΊΣΥΦΟΣ/σίσυφοσ → 409; variantes conectam | passou | 409, 409; "Σισυφος V3b-…" 200 |
| 14 | José × Jose → conecta; Jose+U+0301 → 409 | passou | 409 para Jose+U+0301; "José V3b-…" e "Jose V3b-…" 200 / 200 |
| 15 | Google com nome repetido | passou (testes + volta 2) | O código do produto não mudou desde `deed985`, quando conferi no VS Code. `google.test.js` passa. |
| 16 | Reconectar o mesmo VS Code com o mesmo nome: um só, token antigo 401, linha no histórico | passou | VS Code: diálogo "Este computador já está conectado a 127.0.0.1:3008. Conectar de novo?" → código → "VSCode Claude V3". Ficou um só serviço com esse nome (id `7ed631d945d8` → `c8feec9e2b7c`), e o histórico registrou `Serviço "VSCode Claude V3" reconectado: o acesso anterior deixou de valer` (`v3-vscode-reconectado.png`). API com `replaces: {deviceId, token}`: 200, token antigo **401**, novo 200, 1 serviço. |
| 17 | Pareamentos simultâneos: nunca dois serviços | passou | Dois `POST /v1/pair` ao mesmo tempo, "Corrida V3-…" e a mesma em minúsculas → 200 + 401 |
| 18 | Renomear B para o nome de A → erro; mudar só a caixa → aceito | passou | Painel (`PATCH /web/api/devices/:id` com CSRF): B → nome de A em maiúsculas dá 409 `name_taken`; B → o próprio nome em maiúsculas dá 200 |
| 19 | Cofre com dois "NoteWin" antigos fica intacto | passou (por teste) | `api.test.js` / `web.test.js` |
| 20 | 3 janelas → 1 aviso e 1 linha | passou (por teste) | `servermode.test.js` 22g |
| 21 | 2 janelas → 1 `limit_hit` | passou (por teste) | `servermode.test.js` 22h |
| 22 | `CLAUDE_CONFIG_DIR` nas varreduras, sem perder transcrição atrás de link | passou | `smoke --unit` e a tabela do foco 4 |
| 23 | Nome e apelido sem surrogate solto | passou | foco 4 |
| 24 | Nome de 55 renomeado para outro de 55 | passou | Painel: 55→55 e →60 dão 200; 61 dá 400 "de 1 a 60 caracteres" |
| 25 | `medir` com as metas | passou | tabela acima |
| 26 | `app.js` gzip ≤ 45.000; If-None-Match → 304 | passou | 41.231 B, `Content-Encoding: gzip`, `Vary: Accept-Encoding`, ETag; 304 com 0 B. `gzip;q=0, *;q=1` → sem gzip (141.455 B). |
| 27 | API sem `Content-Encoding` | passou | `/v1/health` e `/web/api/me` com `Accept-Encoding: gzip`: sem o cabeçalho |
| 28 | `conferir-design` 0 | passou | suíte `testes` |
| 29 | Painel claro e escuro legível; h1 22px | passou | `v3-painel-dark.png`, `v3-painel-light.png`; h1 calculado 22px nos dois |
| 30 | Interruptor no alto contraste usa a cor do tema | passou | Tema "Dark High Contrast", Configurações do Swap Plus: o interruptor "Ligado" tem fundo `rgb(137,209,133)` = `#89d185`, o `charts.green` do tema (`v3-vscode-alto-contraste.png`) |

### Problemas encontrados (volta 3)

Nenhum bloqueante.

#### [SUGESTÃO] 1. Espaço sobrando no `launch.json`
- **Onde:** `.vscode/launch.json:47`, uma linha só com dois espaços antes do `],`.
- **Como reproduzir:** `git diff --check origin/main...ab85ff0` sai com 2 e mostra "trailing whitespace". Na volta 2,
  saía 0.
- Não é critério e não afeta o F5. É só a conferência de diff.

#### [SUGESTÃO] 2. A porta do depurador (9339) não acompanha o `SWAP_PLUS_PORTAS`
- **Onde:** `.vscode/launch.json`, `--inspect-extensions=9339` e a configuração "anexar ao host isolado (porta 9339)".
- **Como reproduzir:**
  1. Com um F5 aberto (por exemplo, `SWAP_PLUS_PORTAS=3028,…`), rode um segundo
     `node dev/ambiente-local.js vscode --inspect-extensions=9339` nas portas padrão, o mesmo comando do F5.
  2. O segundo host abre e ativa o Swap Plus, mas a 9339 continua com o primeiro.
- **Obtido:** a configuração "+ depurador" do segundo anexaria ao host do outro ambiente, sem aviso. O perfil, o `HOME` e o
  servidor seguem certos; só o depurador cai no host errado.
- Também ocupa a 9339 de quem já a usa. Sugestão: derivar a porta do depurador das portas do ambiente, ou documentar.

#### [SUGESTÃO] 3. `limpar --portas` deixa `dev/.dados/` vazio
- Depois de apagar a última `portas-*`, sobra a pasta `dev/.dados/` vazia. Ela é ignorada pelo git, então isso é só
  cosmético.

### Observações (volta 3)

- O F5 fica preso ao perfil `dev/.dados/vscode/` do repositório. Se um VS Code já estiver aberto nesse perfil (pelo
  `vscode` ou por outro F5), a nova janela vai para a instância aberta. Esse é o comportamento normal do VS Code com o
  mesmo `--user-data-dir`. Para dois testers na mesma pasta, o `SWAP_PLUS_PORTAS` resolve.
- Os prints da volta 3 ficam em `docs/testes/prints-claude/v3-*.png`. Os das voltas anteriores foram mantidos.

---

## Volta 2 (deed985)

- **Veredito (volta 2):** APROVADO. Os 30 critérios passaram no `deed985` (deed9853299b0a2079cb0d9bd8c7632b751474c5).
  Os dois bloqueantes da volta 1 foram corrigidos e conferidos: o apelido com meio emoji (meu) e o link simbólico de
  subagente (do GPT).

### Como o teste foi feito

- Tudo foi feito nesta máquina: Node 24.22.3, VS Code portátil 1.148, Xvfb e Chromium headless (playwright-core).
  - Nada foi enviado ao servidor real, à Anthropic ou ao Google.
  - Nenhum token real foi usado. Não houve push nem tag.
- Usei o ambiente no repositório, nas portas padrão **3008/3009/3010**, com os dados em `dev/.dados/`.
  - O tester GPT usou `--portas 3018,3019,3020`, com os dados dele em `dev/.dados/portas-3018/`. Os dois ambientes
    rodaram juntos, sem conflito.
- O cofre em `dev/.dados/` já tinha dados de antes. O `subir` respondeu "Cofre já tinha dados (4 contas, 3 serviço(s)):
  nada semeado de novo".
- Um VS Code que sobrou do outro tester ainda estava aberto no perfil padrão `dev/.dados/vscode/`, aberto às 09:06 e
  ligado ao meu servidor como "NoteWin GPT". Não mexi nele.
  - Por isso abri o meu VS Code com **o mesmo comando do subcomando `vscode`**. Só mudei as pastas:
    `dev/.dados/vscode-claude/` e `dev/.dados/home-claude/`, com Xvfb próprio (`:97`) e depuração na porta 9339.
  - O F5 foi conferido numa cópia `git archive deed985`, porque o `launch.json` aponta sempre para
    `dev/.dados/vscode/`.
- No fim, encerrei com Ctrl+C (SIGINT) o meu ambiente, o meu VS Code e o meu Xvfb.

### Comandos rodados

| Comando | Resultado |
|---|---|
| `node dev/ambiente-local.js testes` | ok em 84 s. `node --check` (42 arquivos) ok, `smoke --unit` ok. Extensão **112/0**, servidor **305/0** (antes 303: entraram os 2 testes do motor para o critério 23), cliente **183/0**, design ok. **0 bloqueios `[sem-internet]`**. |
| `git diff --check origin/main...deed985` | ok |
| `node dev/ambiente-local.js` | no ar em **0,3 s**, com o painel, o código de conexão e `admin@local.test`. Agora avisa: "O número novo pode levar até 10 min". |
| `node dev/ambiente-local.js medir` | ok; todas as metas ok (tabela abaixo) |
| `node dev/ambiente-local.js cliente --dados dev/.dados/cliente-claude --nome "Cliente Claude V2"` | pareou e fez o ciclo. Token `sk-ant-oat01-SIMULADO-1-…`. `~/.claude/.credentials.json` ficou com o mesmo mtime (1795603647). |
| `NODE_OPTIONS="--require ./dev/sem-internet.js" node -e "fetch('https://example.com')…"` | `[sem-internet] bloqueado: example.com:443` e `bloqueado` |
| `--portas 1,2,3` / `3028,3028,3030` / `3028,3029` / `abc`; `SWAP_PLUS_PORTAS=99999,3029,3030` | todos saem com 2 e a mensagem "Use três portas diferentes de 1024 a 65535…" |
| cópia com `git init`: `limpar --sim --portas 3028,3029,3030`, depois `limpar --sim` | 1º: "Apagado: dev/.dados/portas-3028/", e `servidor/` continua lá. 2º: "Apagado: dev/.dados/". `git status` limpo. |
| `node dev/conferir-design.js` | 0. Com `color:#123456` numa cópia, sai 1 e aponta `server/web/app.css:1340`. |

Resultado do `medir` (antes = `origin/main` afbf75d). A máquina estava carregada, com o outro tester rodando junto. Por
isso o "antes" saiu mais lento que na volta 1, mas as proporções valem.

| medida | antes | depois | dep/ant | meta |
|---|---|---|---|---|
| scanLimitErrors — mediana (ms) | 2260 | 281 | 12% | ≤ 40% |
| detectModels — mediana (ms) | 2288 | 292 | 13% | |
| scanLimitErrors — 1ª execução, fria (ms) | 4268 | 386 | 9% | |
| varreduras completas/min, 3 janelas | 18 | 4 | 22% | ≤ 4 |
| painel: 1ª abertura com gzip (bytes) | 226712 | 61779 | 27% | ≤ 30% |
| painel: reabertura com If-None-Match (bytes) | 226712 | 0 | 0% | 304 |

A conferência do `medir` acha o mesmo limite e os mesmos modelos nas duas versões. O ganho de tempo continua mesmo
seguindo links simbólicos.

### Foco da volta 2

**1. Link simbólico de subagente e de transcrição (bloqueante do GPT na volta 1): corrigido.**
- Script próprio (`scanLimitErrors(now-60s, projects)` com `vscode` falso) rodado contra `origin/main` e `deed985`, com o
  mesmo erro de limite em cada layout:

| layout | origin/main | deed985 |
|---|---|---|
| A. `subagents/agent.jsonl` é link para o arquivo (caso do GPT) | acha | **acha** |
| B. pasta `subagents` é link | acha | acha |
| C. pasta da sessão é link | não acha | acha |
| D. transcrição do projeto é link | não acha | acha |
| E. pasta do projeto é link | não acha | acha |
| F. laço (pasta aponta para o próprio projeto) e link quebrado | nada (ok) | nada (ok), sem travar, 1 ms |
| G. controle: arquivo comum | acha | acha |

- A 3.6 lê tudo o que a base lia e um pouco mais. O `smoke.js --unit` agora cobre link de subagente, de projeto, de
  pasta, link quebrado e link para pasta.

**2. Apelido e demais cortes do motor sem meio emoji (meu bloqueante da volta 1): corrigido, no motor real.**
- Testei pela API, com `PATCH /v1/accounts/3` e um serviço pareado, lendo depois `GET /v1/state`:
  - `"x"+30×😀` → 31 pontos de código, inteiro (antes saía meio emoji).
  - `39×"a"+😀` → 40 pontos de código.
  - `41×😀` → 40 emojis inteiros, 80 unidades UTF-16.
  - `"  "+25×👍🏽+"  "` → 40 pontos de código.
  - Nenhum desses deixou surrogate solto.
- Pelo painel, com `PATCH /web/api/accounts/2` e o CSRF do admin: `39×"b"+👍🏽` → `"bbb…b👍"`, sem surrogate.
  - No VS Code, a conta 2 aparece com o apelido inteiro ("…bbbb👍"), sem "▫"; ver `v2-vscode-alto-contraste.png`.
- Nome do serviço com `"N"+70×😀` → gravado com 60 pontos de código, sem surrogate.
- O `planOf`, o `preferModel` e o rótulo do `limitHit` passaram a usar o mesmo `cortar()`.
  - Na leitura do código, isso fecha o resto do padrão que eu tinha apontado.

**3. Reinício do ambiente (critério 4).**
- Ctrl+C no `subir`: "Encerrando (o servidor grava o cofre)…" e "cofre gravado; até mais". As portas foram liberadas.
- Subi de novo: "Cofre já tinha dados (4 contas, 16 serviço(s)): nada semeado de novo", no ar em 0,2 s.
  - Antes e depois: 4 contas (conta1–4, uma vez cada), 16 serviços, 1 "Hermes (simulado)", nenhum nome repetido.
- O VS Code continuou na conta 3 depois do reinício. O painel mostra a sessão da conta 1 em 95%
  (`v2-painel-light-apos-reinicio.png`, `v2-painel-servicos-apos-reinicio.png`).

**4. Propagação da mudança de uso (critério 5).**
- 09:44:33: `POST :3010/_simular/uso {"conta":1,"sessao":95}`.
- 09:53:54: o servidor releu a conta 1 (5h = 95%). Foram 9 min 20 s, dentro do "até 10 min" que o `subir` agora
  avisa.
- No mesmo instante, o histórico registrou uma linha por serviço ativo: `Trocou da conta 1 para a conta 3: sessão em 95%
  (linha 90%)`, para "VSCode Claude V2" e para "outro-v2" (`v2-painel-historico.png`).
- O VS Code passou para a **Conta 3**: a barra mostrou "Sessão (5h): 10% … Semanal: 15%" e a credencial isolada passou a
  `sk-ant-oat01-SIMULADO-3-…`.
- Os serviços "aguardando contato" e o que só faz `GET /v1/state` ("conectado", sem presença ativa) ficaram na conta 1.
  Esse é o comportamento do motor, já visto na volta 1.

**5. F5 (critério 10).**
- Abri a cópia `deed985` num VS Code e apertei F5. Abriu o "[Extension Development Host]" com a barra do Swap Plus
  ("não conectado — clique para entrar com Google"); ver `v2-vscode-f5.png`.
- O Dev Host abre dentro do processo do VS Code que o lançou. Isso é o desvio já aceito pelo PM.

### Critérios de aceite (volta 2, deed985)

| # | Critério | Resultado | Evidência |
|---|---|---|---|
| 1 | Sobe em ≤ 15 s com endereço, código e admin; health ok | passou | 0,3 s e 0,2 s; `/v1/health` → `"ok":true`, 2.8.0 |
| 2 | Admin pelo Google falso vê 4 contas e "Hermes (simulado)" | passou | `v2-painel-dark.png`: contas 1–4, a conta 4 com "Login morto". Aba Serviços com 1 "Hermes (simulado)". |
| 3 | `intruso@local.test` recusado | passou | `v2-painel-intruso.png`: "Conta não liberada" |
| 4 | Ctrl+C e subir de novo não duplica | passou | ver foco 3 |
| 5 | Uso a 95% → painel mostra; troca no histórico | passou | ver foco 4 |
| 6 | `testes` passa, 0 bloqueios, totais ≥ 106/283/181 | passou | 112/305/183, 0 bloqueios |
| 7 | `sem-internet` bloqueia example.com | passou | ver comandos |
| 8 | `cliente` pareia, ciclo, token SIMULADO; `~/.claude` intacto | passou | ver comandos |
| 9 | VS Code: conectar pelo código, barra com uso, credencial simulada, nada do usuário muda | passou | `v2-vscode-conectado.png`: barra com a conta 1 (2%/30%/Fable 57%), credencial isolada `SIMULADO-1`. `~/.claude` com o mesmo mtime; `~/.config/Code` não existe. |
| 10 | F5 abre o Dev Host com o Swap Plus | passou | ver foco 5 |
| 11 | `limpar --sim` apaga só `dev/.dados/`, git limpo | passou | ver comandos (também com `--portas`) |
| 12 | Variações de "NoteWin" → 409 com a mensagem; código continua valendo | passou | API: "notewin", " NoteWin ", "NOTEWIN" → 409 `name_taken` com a mensagem exata. Com "Note  Win" conectado, "Note Win" e "note   win" → 409. O mesmo código, depois, conectou "Outro-V2" (200). No VS Code, " NOTEWIN " pede outro nome com a mensagem (`v2-vscode-codigo-nome-repetido.png`). |
| 13 | Σίσυφος × ΣΊΣΥΦΟΣ/σίσυφοσ → 409; Sisyphos/Σισυφος conectam | passou | 409, 409, 200, 200 |
| 14 | José × Jose → conecta; Jose+U+0301 → 409 | passou | 200 / 200 / 409 |
| 15 | Google com nome repetido | passou | VS Code: "Entrar com Google" com "NOTEWIN" → `POST /v1/login/start 409` e o nome é pedido de novo com a mensagem (`v2-vscode-google-nome-repetido.png`). O conflito na volta do Google está coberto por `google.test.js` e foi visto no VS Code na volta 1. Esse código não mudou. |
| 16 | Reconectar o mesmo VS Code com o mesmo nome: um só, token antigo 401, linha no histórico | passou | Diálogo nativo "Conectar de novo" → código → "VSCode Claude V2". O id passou de `8da7d8283df4` para `0a53f6b7de89`, e ficou 1 só. Histórico: `Serviço "VSCode Claude V2" reconectado: o acesso anterior deixou de valer` (`v2-vscode-reconectado.png`). Pela API com `replaces`: token antigo 200 → **401**, novo 200. |
| 17 | Pareamentos simultâneos: nunca dois serviços | passou | Dois `POST /v1/pair` ao mesmo tempo com "Corrida V2"/"corrida v2" → 200 + 401 e 1 serviço. A disputa de nome com dois códigos está coberta por `api.test.js`. |
| 18 | Renomear B para o nome de A → erro; mudar só a caixa → aceito | passou | Painel: "Outro-V2" → "notewin" dá 409 `name_taken`; "Outro-V2" → "OUTRO-v2" dá 200 |
| 19 | Cofre com dois "NoteWin" antigos fica intacto | passou (por teste) | `api.test.js` e `web.test.js` "(critério 19)" |
| 20 | 3 janelas → 1 aviso e 1 linha | passou (por teste) | `servermode.test.js` 22g |
| 21 | 2 janelas → 1 `limit_hit` | passou (por teste) | `servermode.test.js` 22h |
| 22 | `CLAUDE_CONFIG_DIR` nas varreduras, sem perder transcrição atrás de link | passou | `smoke.js --unit` (seção I, com os casos de link) e a tabela do foco 1 |
| 23 | Nome e **apelido** sem surrogate solto | **passou** | ver foco 2 (motor real, pela API e pelo painel) |
| 24 | Nome de 55 renomeado para outro de 55 | passou | Painel: 55→55 e →60 dão 200; 61 dá 400 "de 1 a 60 caracteres" |
| 25 | `medir` com as metas | passou | tabela acima |
| 26 | `app.js` gzip ≤ 45.000; If-None-Match → 304 | passou | 41.231 B, `Content-Encoding: gzip`, `Vary`, ETag; 304 com 0 B |
| 27 | API sem `Content-Encoding` | passou | `GET /v1/health` e `/web/api/me` com `Accept-Encoding: gzip`: sem `Content-Encoding` |
| 28 | `conferir-design` 0; cor literal → ≠ 0 com arquivo:linha | passou | ver comandos |
| 29 | Painel claro e escuro legível; h1 22px | passou | `v2-painel-dark.png`, `v2-painel-light.png`; h1 calculado 22px nos dois |
| 30 | Interruptor da extensão no alto contraste usa a cor do tema | passou | `v2-vscode-alto-contraste.png`, tema "Default High Contrast" (`vscode-high-contrast`): o fundo do interruptor é `rgb(137,209,133)`, igual a `--vscode-charts-green` (#89d185); o botão é branco, igual a `--vscode-button-foreground` |

Sugestão do GPT na volta 1 (`gzip;q=0, *;q=1`), conferida com curl em `/static/app.js`:

| `Accept-Encoding` | resposta |
|---|---|
| `gzip;q=0, *;q=1` | sem gzip, 141.455 B (corrigido) |
| `*;q=0` | sem gzip |
| `identity` | sem gzip |
| `*` | gzip |
| `br, gzip;q=0.5` | gzip |
| `GZIP` | gzip |

### Problemas encontrados (volta 2)

Nenhum bloqueante.

#### [SUGESTÃO] `limpar` nas portas padrão apaga também o ambiente das outras portas
- **Onde:** `dev/ambiente-local.js`, `limpar()`. Com as portas padrão, `DADOS` é `dev/.dados/`, que contém
  `dev/.dados/portas-*/`.
- **Como reproduzir:** em uma cópia, crie `dev/.dados/portas-3028/x` e rode `node dev/ambiente-local.js limpar --sim`.
- **Esperado / obtido:** quem roda o `limpar` "dele", nas portas padrão, apaga também o cofre e o VS Code do outro
  ambiente, mesmo com ele no ar. A pergunta sem `--sim` diz só "Apagar dev/.dados/ (cofre simulado…)".
- O critério 11 passa, porque só `dev/.dados/` some.
- Sugestão: pular `portas-*` no `limpar` padrão, ou ao menos listar essas pastas na pergunta.

#### [SUGESTÃO] F5 não acompanha o `--portas`
- **Onde:** `.vscode/launch.json`. O perfil é sempre `dev/.dados/vscode/` e o servidor fica em
  `settings.json`, que aponta para 3008 depois do `subir` padrão.
- Com dois ambientes na mesma pasta, o F5 sempre cai no perfil e no servidor das portas padrão. Também colide com um
  `vscode` padrão já aberto. Vale uma linha no README. Não é critério.

### Observações (volta 2)

- **Ritmo do uso:** o aviso novo no `subir` e no README resolve a observação da volta 1. A troca saiu em 9 min 20 s.
- **Histórico da reconexão:** além de "reconectado", aparecem "Serviço … conectado" e "Conta N atribuída a …". Não é
  defeito. A linha pedida pelo critério 16 está lá, e o serviço é um só.
- Não foi testado: a extensão 3.5 contra o servidor 2.8, que é a ressalva conhecida do PM.
- Os prints da volta 2 ficam em `docs/testes/prints-claude/v2-*.png`. Os da volta 1, sem prefixo, foram mantidos.

---

## Volta 1 (04004f4)

- **Commit testado:** `04004f4` (04004f44c641cb747a1e5fec94b7a8ec22eaf348), branch `bragarpaulo/20261125-qualidade-swapplus`,
  comparado com `origin/main` (`afbf75d`). Durante o teste o outro tester gravou `a416541` (só o relatório dele). O código
  é o mesmo do `04004f4`.
- **Spec:** `docs/specs/20261125-qualidade-swapplus.md`, só a Fase 1.
- **Veredito (volta 1):** REPROVADO. Um critério falhou: o **23**, na parte do apelido da conta. O resto passou: 29 critérios
  conferidos, sem regressão nas suítes.


### Como o teste foi feito

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

### Comandos rodados

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

### Critérios de aceite

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

### Problemas encontrados

#### [BLOQUEANTE] Apelido da conta ainda fica com meio emoji (critério 23)
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

#### [SUGESTÃO] `curl -sI` do critério 27 recebe 405
- **Onde:** API (`/v1/health` só aceita GET).
- O critério passa, porque não há `Content-Encoding`, mas o comando escrito na spec não testa nada.
- Sugestão: trocar, na spec ou no README, por `curl -s -D - -o /dev/null -H 'Accept-Encoding: gzip' …`.

#### [SUGESTÃO] `ambiente-local.js` com portas fixas
- Dois testers na mesma pasta não conseguem ter cada um o seu ambiente.
- Um `--portas` ou variáveis de ambiente (`PORTA_API` etc.) evitariam ter que copiar o repositório. Isso não é critério.

### Observações

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
