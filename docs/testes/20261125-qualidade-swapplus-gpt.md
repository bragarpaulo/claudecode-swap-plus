# Relatório de teste — 20261125-qualidade-swapplus — GPT

- **Commit testado** `04004f44c641cb747a1e5fec94b7a8ec22eaf348`
- **Base local `origin/main`** `afbf75d6b60c14e52f56c4d5ec3caf1f562bf6a4`
- **Veredito** REPROVADO
- **Escopo** Fase 1, Node 24.22.3, painel e APIs em loopback, Google e Anthropic simulados.

## Comandos rodados

| Comando | Resultado |
|---|---|
| `git diff origin/main...04004f4 --check` | OK |
| `node dev/ambiente-local.js testes` | 42 arquivos em `node --check`, smoke unitário e design OK. Extensão 112, servidor 303, cliente 183. Zero falhas e zero bloqueios de rede. Swap Plus usa JavaScript diretamente, conforme a spec. |
| `node dev/ambiente-local.js` | Ambiente no ar em 0,2 s, cofre com 4 contas e 1 serviço. |
| `node dev/ambiente-local.js cliente --dados dev/.dados/cliente-gpt` | Pareamento, ciclo e credencial simulada. |
| `node dev/ambiente-local.js vscode` | VS Code portátil, Xvfb, perfil do script e proxy Chromium apontado a loopback. Pareamento, conflito Google, reconexão e alto contraste. |
| `node dev/ambiente-local.js medir` | Todas as metas passaram para a massa padrão. |
| `node dev/ambiente-local.js limpar --sim` | Execução em cópia temporária. O alvo sumiu e o arquivo de controle vizinho permaneceu. |

## Critérios de aceite

| # | Critério | Resultado | Evidência |
|---|---|---|---|
| 1 | Subida, código, administrador e health | Passou | 0,2 s. Health administrativo `{"ok":true,"version":"2.8.0"}`. |
| 2 | Admin simulado, quatro contas, Hermes | Passou | Navegador Orca autenticado como admin, quatro contas com a fixture e um Hermes. O cliente de teste já havia adicionado outro serviço quando o print foi feito. |
| 3 | Recusar intruso | Passou | Google simulado exibiu “Conta não liberada” para `intruso@local.test`. |
| 4 | Reinício idempotente | Parcial | Subida limpa confirmou 4 contas e 1 serviço. Em dois processos contra o mesmo cofre temporário, `semear()` devolveu `semeou: true` e depois `semeou: false`, com 4 contas e 1 serviço em ambos. Preservei o ambiente compartilhado. As portas 3018–3020 já estavam ocupadas durante a tentativa de reinício completo. |
| 5 | Alterar uso, atualizar painel e trocar | Parcial | Simulador confirmou sessão da conta 1 em 95%. Aguardava-se o próximo polling da conta para verificar a mudança no painel e o histórico correspondente. |
| 6 | Suítes offline | Passou | 598 testes além do smoke, zero falhas e zero bloqueios. |
| 7 | Guarda de rede | Passou | Com `NODE_OPTIONS`, a sonda indicada na spec retornou `bloqueado` e a linha para `example.com:443`. |
| 8 | Cliente e isolamento | Passou | O cliente registrou token simulado. O mtime de `~/.claude/.credentials.json` permaneceu em `1795603647`. |
| 9 | VS Code real, barra e credencial | Passou | Barra com sessão 10% e semanal 15% na conta 3. Credencial simulada na pasta isolada e mtime real preservado. |
| 10 | F5 abre a extensão Swap Plus | Parcial | Configuração aponta para `plus/` com perfil isolado. O passo de F5 foi tentado no VS Code portátil, mas a abertura de um host novo ficou sem confirmação. |
| 11 | Limpeza restrita | Passou | Cópia via `git archive`, com sentinela fora de `.dados`. |
| 12 | Duplicado por caixa e espaços, código preservado | Passou | `api.test.js` e `nomes.test.js`. |
| 13 | Sigma grego e acento | Passou | `nomes.test.js`. |
| 14 | José, Jose e NFD | Passou | `nomes.test.js`. |
| 15 | Duplicado no Google | Passou | VS Code real recusou `Hermes (simulado)` e reabriu o nome com a mensagem. O conflito em retorno do Google, a página e o poll estão em `google.test.js`. |
| 16 | Reconectar ao mesmo servidor | Passou | Um único `NoteWin GPT` e histórico de reconexão no painel. A revogação do token anterior foi verificada em `api.test.js`. |
| 17 | Pareamento concorrente | Passou | `api.test.js`, inclusive dois códigos válidos independentes. |
| 18 | Renomear para nome em uso e mudar caixa própria | Passou | `web.test.js`. |
| 19 | Preservar duplicados legados | Passou | `api.test.js` e `web.test.js`. |
| 20 | Um aviso e uma linha em três instâncias | Passou | `servermode.test.js`. |
| 21 | Um evento de limite em duas instâncias | Passou | `servermode.test.js` com arquivos regulares. |
| 22 | Transcrições no `CLAUDE_CONFIG_DIR` | Falhou em regressão | Smoke passou com arquivos regulares. O inventário novo omite transcrições de subagentes acessíveis por link simbólico, que a versão base lia. |
| 23 | Corte Unicode de nome e apelido | Passou | `nomes.test.js` e `api.test.js`. |
| 24 | Renomear 55 caracteres | Passou | `web.test.js`. |
| 25 | Benchmark de varredura e painel | Passou | Tabela abaixo. |
| 26 | gzip de app.js e ETag | Passou | 41.231 B com gzip. ETag retornou 304, 0 B. Há um desvio adicional de negociação descrito abaixo. |
| 27 | API sem gzip | Passou | `GET /v1/health` sem `Content-Encoding` mesmo pedindo gzip. |
| 28 | Validador de design | Passou | Suíte limpa. Em cópia temporária, `color: #123456` apontou `server/web/app.css:1341` e saiu com 1. |
| 29 | Painel claro e escuro | Passou | Renderizei ambos no Orca, com títulos, ação Desconectar e indicadores de presença. O `h1` computado foi 22px. |
| 30 | Interruptor no Dark High Contrast | Passou | VS Code real com o tema aplicado. O interruptor ligado usa `--vscode-charts-green` e o botão usa `--vscode-button-foreground`. |

## Problemas encontrados

### [BLOQUEANTE] A varredura ignora erro de limite em transcrição de subagente com link simbólico

- **Onde** `plus/transcricoes.js:63` e `plus/transcricoes.js:87`.
- **Como reproduzir** Em uma pasta temporária, crie um arquivo regular com a linha JSON `{"isApiErrorMessage":true,"error":"rate_limit","message":{"content":"limit"}}`. Crie a pasta `projects/p/sessao/subagents` e, dentro dela, o link simbólico `agent.jsonl` para o arquivo. Em Node com o módulo `vscode` simulado, chame `require("./plus/extension")._test.scanLimitErrors(Date.now() - 60000, projects)` imediatamente depois de criar o arquivo. Repita com `plus/extension.js` da base local e a mesma árvore.
- **Esperado / obtido** A base seguiu o link e devolveu o erro. O commit testado devolveu `null`. O inventário filtra `Dirent.isFile()` antes de tentar `stat`, que seguiria o link. Nesse layout, a janela dona deixa de emitir o evento de limite e perde a oportunidade de troca automática associada.

### [SUGESTÃO] Curinga ignora exclusão explícita de gzip

- **Onde** `server/src/web.js:634`.
- **Como reproduzir** Envie `Accept-Encoding: gzip;q=0, *;q=1` em `GET /static/app.js` no ambiente local.
- **Esperado / obtido** O cliente exclui gzip especificamente. A resposta veio com `Content-Encoding: gzip` e 41.231 B porque a decisão aceita qualquer item positivo, inclusive o curinga.

## Medições

| Medida | `origin/main` | `04004f4` | Proporção |
|---|---:|---:|---:|
| `scanLimitErrors`, mediana em ms | 864 | 275 | 32% |
| `detectModels`, mediana em ms | 885 | 264 | 30% |
| `scanLimitErrors`, execução fria em ms | 959 | 359 | 37% |
| Varreduras completas por minuto, 3 janelas simuladas | 18 | 4 | 22% |
| Primeira abertura do painel, bytes | 226.712 | 61.779 | 27% |
| Reabertura do painel, bytes | 226.712 | 0 | 0% |

As três respostas da reabertura retornaram 304. A massa padrão foi 300 projetos × 40 transcrições antigas mais 5 recentes, com 10 execuções de cada varredura.

## Observações

- Os desvios explicitamente aceitos pelo PM foram considerados dentro do escopo de aprovação. Nenhum token real foi usado.
- Evidência visual em [prints-gpt](prints-gpt/), com painel claro e escuro, barra do VS Code, conflito de Google e configurações em alto contraste.

## Volta 2

- **Commit testado** `deed9853299b0a2079cb0d9bd8c7632b751474c5`.
- **Base local `origin/main`** `afbf75d6b60c14e52f56c4d5ec3caf1f562bf6a4`.
- **Veredito** REPROVADO. O F5 carrega a extensão correta, mas reutiliza o perfil do VS Code que iniciou a depuração.
- **Escopo** Fase 1, Node 24.22.3, VS Code portátil 1.148.0 em Xvfb. Ambiente GPT nas portas 3018–3020 com dados simulados. Os sete desvios aceitos pelo PM permanecem considerados no teste.

### Comandos rodados

| Comando | Resultado |
|---|---|
| `git diff origin/main...deed985 --check` | OK. |
| `node dev/ambiente-local.js testes --portas 3018,3019,3020` | Sintaxe de 42 arquivos, smoke e design aprovados. Extensão 112, servidor 305, cliente 183. Zero falhas e zero bloqueios na suíte. |
| `node dev/ambiente-local.js subir --portas 3018,3019,3020` | Subiu em 0,3 s. Interrompi via SIGINT e subi de novo contra o mesmo cofre. |
| `node dev/ambiente-local.js cliente --portas 3018,3019,3020 --nome 'Cliente GPT V2'` | Pareou, completou ciclo e gravou o acesso simulado da conta 3. |
| `node dev/ambiente-local.js vscode --portas 3018,3019,3020` | VS Code portátil com perfil isolado, Xvfb e proxy Chromium em loopback. |
| `node dev/ambiente-local.js medir --portas 3018,3019,3020` | Todas as metas passaram. JSON de saída em `dev/.dados/medidas.json`. |
| `node dev/ambiente-local.js limpar --portas 3018,3019,3020 --sim` | Em cópia descartável, removeu o diretório da porta e preservou as sentinelas vizinhas. |

### Critérios de aceite

| # | Resultado | Evidência |
|---|---|---|
| 1 | Passou | Subida em 0,3 s, código novo e `GET /v1/health` administrativo com `ok:true`. |
| 2 | Passou | O Google simulado autenticou o admin. Estado do painel antes do cliente e do VS Code com quatro contas e um Hermes. |
| 3 | Passou | Sessão separada no Google simulado recusou `intruso@local.test` com “Conta não liberada”. |
| 4 | Passou | Após SIGINT e nova subida, o cofre continuou com quatro contas e um Hermes atribuído à conta 1. |
| 5 | Passou | Simulador recebeu 95% às 09:43. Painel mostrou a sessão em 95% e o histórico registrou Hermes de 1 para 3 às 09:46:03, com linha de sessão de 90%. Ajustei a linha de modelo da conta 1 para 65%, ativei troca na linha do modelo e zerei o cooldown para exercitar a cadência real de conta ativa perto de uma linha. A sessão foi a causa registrada. O ciclo padrão de até 10 min ficou sem medição direta nesta volta. [Histórico](prints-gpt/volta2-painel-troca.png) |
| 6 | Passou | 600 testes de extensão, servidor e cliente, mais smoke, sintaxe e design. Zero bloqueios. |
| 7 | Passou | A sonda prescrita com `NODE_OPTIONS` retornou `bloqueado` e nomeou `example.com:443`. |
| 8 | Passou | Cliente em dia, credencial simulada em `dev/.dados/portas-3018/cliente/.claude`. |
| 9 | Passou | VS Code real conectado à conta 3, sessão 10% e semanal 15%. Credencial simulada no HOME isolado. O mtime do arquivo real permaneceu em `1795603647`. [Barra](prints-gpt/volta2-vscode-status.png) |
| 10 | Falhou no isolamento | F5 abriu o Extension Development Host com `paulo-local.swap-plus`. O host herdou o perfil pai em vez do perfil do `launch.json`. [F5](prints-gpt/volta2-vscode-f5.png) |
| 11 | Passou | Em cópia descartável, a limpeza com as portas alternativas preservou os dados do ambiente irmão e a sentinela fora de `.dados`. |
| 12 | Passou | Suíte de nomes/API verificou duplicata por caixa e espaços e preservação do código. VS Code real também reabriu o campo de nome após a recusa. [Conflito](prints-gpt/volta2-vscode-nome-duplicado.png) |
| 13 | Passou | `nomes.test.js` verificou sigma grego e acento. |
| 14 | Passou | `nomes.test.js` verificou José, Jose e NFD. |
| 15 | Passou por teste automatizado | `google.test.js` verificou o conflito no retorno do Google, a página e o poll. Nesta volta usei o VS Code real para a recusa equivalente por código. |
| 16 | Passou | VS Code real reconectou `NoteWin GPT V2` após o conflito. Ficou um registro com ID novo e histórico de revogação. `api.test.js` e `google.test.js` cobriram a substituição. |
| 17 | Passou | `api.test.js` verificou concorrência com dois códigos válidos independentes. |
| 18 | Passou | `web.test.js` verificou conflito de renomeação e mudança de caixa do próprio nome. |
| 19 | Passou | `api.test.js` e `web.test.js` preservaram duplicados legados. |
| 20 | Passou | `servermode.test.js` verificou um aviso e uma linha em três instâncias. |
| 21 | Passou | `servermode.test.js` verificou um evento de limite em duas instâncias. |
| 22 | Passou | O smoke voltou a encontrar o erro de limite do subagente atrás de link simbólico e detectou o modelo. Testou também link de projeto, link de transcrição, link quebrado e link para pasta com sufixo `.jsonl`. |
| 23 | Passou | API verificou nome em até 60 pontos de código. Um PATCH no servidor local gravou exatamente `x` e 39 emojis no apelido, sem surrogate solto. `engine.test.js` conferiu o cofre. Em cópia descartável, um teste adicional chamou o motor real para plano, `preferModel` e rótulo de limite e confirmou os cortes em 40, 40 e 80 pontos de código. |
| 24 | Passou | `web.test.js` aceitou a renomeação para 55 caracteres. |
| 25 | Passou | Benchmark abaixo. |
| 26 | Passou | `gzip;q=0, *;q=1` retornou 141.455 B, sem `Content-Encoding`. Gzip e ETag foram verificados pelo benchmark. |
| 27 | Passou | `web.test.js` e `GET /v1/health` com `Accept-Encoding: gzip` confirmaram API sem gzip. |
| 28 | Passou | Validador limpo na suíte. Em cópia descartável, `color: #123456` foi detectado em `server/web/app.css:1341` com código 1. |
| 29 | Passou | Painel renderizado em claro e escuro com `h1` computado em 22 px. [Claro](prints-gpt/volta2-painel-claro.png) · [Escuro](prints-gpt/volta2-painel-escuro.png) |
| 30 | Passou | Configurações da extensão em Dark High Contrast no VS Code real, com interruptor ligado e comando Sair visíveis. [Alto contraste](prints-gpt/volta2-vscode-alto-contraste.png) |

### [BLOQUEANTE] F5 reutiliza o perfil do editor que iniciou a depuração

- **Onde** `.vscode/launch.json`, configuração “Swap Plus (plus/) — ambiente local”, e instrução de F5 no README.
- **Como reproduzir localmente** Em uma cópia de `deed985`, configure dois endereços de loopback distintos. Coloque `http://127.0.0.1:3018` no perfil inicial do VS Code portátil (`--user-data-dir=/tmp/gptv2-f5-parent`) e `http://127.0.0.1:3098` em `dev/.dados/vscode/user-data/User/settings.json`. Desligue as atualizações nos dois perfis. Abra a cópia no perfil inicial, pressione F5 e inspecione o endereço informado pela barra de status. Nenhuma conexão precisa ser acionada.
- **Esperado** O host de desenvolvimento lê o perfil isolado indicado em `launch.json`. O endereço, a sessão e o armazenamento do editor inicial não são compartilhados com esse host.
- **Obtido** A extensão ativou e mostrou `127.0.0.1:3018` mesmo com `3098` no diretório indicado pelo launch. O VS Code registrou a ativação de `paulo-local.swap-plus` em `/tmp/gptv2-f5-parent/logs/.../window3/exthost/exthost.log`. O renderer também rodou com `--user-data-dir=/tmp/gptv2-f5-parent`. O diretório do launch continha apenas `User/`, sem logs. Isso reproduz a leitura de configurações do perfil inicial e deixa o ambiente local sujeito ao endereço desse perfil. Usei somente endereços fictícios de loopback. O subcomando `vscode --portas ...` criou e usou o perfil separado como esperado.

### [SUGESTÃO] Escopo dos dados de benchmark e limpeza padrão

- `medir --portas 3018,3019,3020` grava `dev/.dados/medidas.json` assim como o benchmark padrão. Duas execuções usam o mesmo caminho de saída.
- Em cópia descartável, `limpar --sim` sem portas apagou também o diretório de um ambiente alternativo, por ele ficar dentro de `dev/.dados/`. A limpeza com portas próprias preservou a pasta irmã. O README documenta a remoção da raiz no caso padrão.

### Medições da Volta 2

| Medida | `origin/main` | `deed985` | Proporção |
|---|---:|---:|---:|
| `scanLimitErrors`, mediana em ms | 1.853 | 285 | 15% |
| `detectModels`, mediana em ms | 1.417 | 248 | 18% |
| `scanLimitErrors`, execução fria em ms | 1.018 | 384 | 38% |
| Varreduras completas por minuto, 3 janelas | 18 | 4 | 22% |
| Primeira abertura do painel, bytes | 226.712 | 61.779 | 27% |
| Reabertura do painel, bytes | 226.712 | 0 | 0% |

As três respostas condicionais retornaram 304. A massa padrão foi 300 projetos × 40 transcrições antigas mais 5 recentes, com dez execuções por varredura. O benchmark mediu a massa padrão e o smoke exercitou a correção de links. Frente a `origin/main`, `app.css` ganhou 141 B (0,29%) e `panel.css` ganhou 61 B (0,49%), dentro de 1%. Os testes usaram dados fictícios, sem push nem tag.
