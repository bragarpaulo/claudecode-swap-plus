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
