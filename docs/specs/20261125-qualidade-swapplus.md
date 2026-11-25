# Spec técnica — 20261125-qualidade-swapplus Qualidade do Swap Plus: ambiente local simulado, duplicidade, erros, performance e design

## Contexto

Demanda `/home/orca/.orca/bots/pm/time/demandas/20261125-qualidade-swapplus.md` (pedido do Paulo em 2026-11-25, uma de 8
demandas iguais, uma por projeto). Objetivos, na ordem de prioridade do PM:

1. ambiente local de teste com **dados simulados**, subindo com um comando só, sem banco, sem servidor real e **sem nada saindo
   para a internet**;
2. nenhum caminho que grave a mesma informação duas vezes;
3. erros corrigidos;
4. performance com medida antes/depois;
5. telas seguindo o padrão visual do próprio projeto.

Fora do escopo: deploy (publicar a extensão, imagem do servidor, Portainer), dados reais, credenciais, migração destrutiva,
reescrever ou trocar a stack, funcionalidade nova além do ambiente local.

**Tamanho: G.** A spec tem duas fases. A **Fase 1 entra nesta volta**. A Fase 2 fica registrada para uma próxima demanda
(ver o fim de "Solução proposta").

## Situação atual

O repositório tem três programas, todos em **JavaScript puro (CommonJS), sem dependências npm e sem passo de build**:

| Parte | Pasta | O que é | Versão |
| --- | --- | --- | --- |
| Extensão do VS Code | `plus/` | barra de status, tela de configurações (webview `plus/media/panel.*`), troca de conta, gancho de retomada (`plus/hooks/retomar.js`), atualizador (`plus/updater.js`, lê as releases do GitHub) | 3.5.0 (`plus/package.json`) |
| Servidor | `server/` | HTTP(S) próprio em Node (`server/src/server.js`), motor de troca (`engine.js`), cofre = **um arquivo JSON criptografado** (`store.js`, AES-256-GCM, sem banco), painel web (`server/web/index.html`, `app.js`, `app.css`), roda em Docker | 2.7.0 (`VERSION` em `server/src/server.js`) |
| Cliente | `cliente/` | o trabalho da extensão sem VS Code (Hermes e outros serviços) | 1.1.0 (`cliente/package.json`) |

Os arquivos da raiz `src/`, `dist/`, `package.json`, `tsconfig.json`, `convert.js` e `.github/workflows/publish.yml` são do
projeto original (claude-swap-status). Ficam **só como referência** (README, "Como o projeto está organizado") e o Swap Plus
não os usa.

Linha de base medida nesta máquina (Node 24.22.3, npm 11.19.1, 2026-11-25, branch a partir de `afbf75d`):

| Suíte | Comando | Resultado | Tempo |
| --- | --- | --- | --- |
| extensão (rápido) | `node plus/test/smoke.js --unit` | "Tudo certo." | 0,1 s |
| extensão | `node --test plus/test/*.test.js` | 106 ok, 0 falhas | 9,5 s |
| servidor | `node --test server/test/*.test.js` | 283 ok, 0 falhas | 41,4 s |
| cliente | `cd cliente && node --test test/*.test.js` | 181 ok, 0 falhas | 1,6 s |

Não há linter configurado (só o `node --check` no CI). O VS Code **não está instalado** nesta máquina (não há `code` no PATH).
`xvfb-run` está instalado. Docker não.

### O que já existe e é reaproveitado

- `plus/test/tela-falsa.js`: DOM falso que roda o `panel.html` e o `panel.js` de verdade no Node.
- `plus/test/servermode.test.js`: a extensão inteira contra um servidor falso.
- O servidor já aceita trocar os endereços de fora por variáveis: `ANTHROPIC_API_BASE`, `ANTHROPIC_TOKEN_URL`,
  `GOOGLE_AUTH_URL`, `GOOGLE_TOKEN_URL`, `GOOGLE_CLIENT_ID_FILE`, `GOOGLE_CLIENT_SECRET_FILE`. `http://` é aceito para
  `127.0.0.1`/`localhost`.
- Também configuráveis: `TLS_MODE=off`, `DATA_DIR`, `MASTER_KEY_FILE`, `PORT`, `ADMIN_PORT`, `PUBLIC_URL`, `ADMIN_EMAILS` e
  `NOTICES_ENABLED=0`.
- O `id_token` do Google é conferido sem assinatura (`readIdToken` em `server/src/google.js`: confere iss/aud/exp/e-mail).
  Por isso um Google falso local funciona.
- A extensão aceita `http://` só para loopback (`plus/serverClient.js`). Também respeita `CLAUDE_CONFIG_DIR` para o login
  (`plus/claudeAuth.js`) e tem `swapPlus.updates.enabled=false` para não ir ao GitHub.

### Problemas encontrados (o que esta spec corrige)

**Duplicidade**

- **D1. Serviço com nome repetido.** `createDevice` (`server/src/server.js` ~l. 710) cria um serviço novo a cada pareamento
  ou login com Google, sem olhar o nome. Também passam:
  - reinstalar o VS Code e conectar de novo, o que deixa dois "NoteWin";
  - "NoteWin" e "notewin";
  - nome vazio, que vira "serviço" duas vezes;
  - renomear pelo painel para um nome que já existe (`patchDevice`, `server/src/web.js` ~l. 756).
- **D2. Aviso de "chegou a X%" em dobro.** `checkAlerts()` (`plus/extension.js` ~l. 517) roda em **toda** janela do VS Code
  (é chamado nos dois ramos de `serverSync`, l. 2441 e 2484). O "já avisei" fica no `globalState`, que cada janela só vê
  com atraso. Com 3 janelas abertas saem 3 notificações e 3 linhas iguais no histórico.
- **D3. Trava do limite não é atômica.** `claimLimit(ts)` (~l. 1091) lê `swap-plus-limit.lock` e depois grava, sem trava
  entre as duas coisas. Duas janelas que veem o mesmo erro no mesmo instante passam as duas. O resultado são dois
  `POST /v1/events {limit_hit}`, ou seja, duas trocas ou dois avisos.

Verificados e **sem** duplicidade (nada a mudar):
- `storeLogin`/`findAccount` (conta é pela identidade e-mail + organização, e a gravação é síncrona);
- `allowEmail`/`denyEmail` (pela `emailKey`);
- `srvQueue` (troca manual, ciclo e limite em fila única);
- `checkModelSwitch` e `checkModelBlock` (só na janela dona, com arquivo-marcador);
- registro de comandos e listeners em `activate` (uma vez só, todos em `context.subscriptions`).

**Erros**

- **E1. `CLAUDE_CONFIG_DIR` ignorado em dois lugares.** `detectModels` (l. 237) e `limitRoot` (l. 1006) usam
  `~/.claude/projects` fixo, mas `claudeConfigDir()` (l. 319) já respeita a variável. Com `CLAUDE_CONFIG_DIR` definido, o
  limite batido nunca é visto e o modelo em uso nunca é detectado. Isso também impede isolar o ambiente local.
- **E2. `cleanText` corta no meio de um emoji.** `cleanText` (`server/src/server.js` l. 154) corta por unidade UTF-16
  (`slice(0, max)`). Um nome com emoji na posição 60 fica com meio emoji (surrogate solto `\ude00`, verificado), e o mesmo
  vale para o apelido da conta (40).
- **E3. Limites de tamanho diferentes para o nome do serviço.** O pareamento e o Google aceitam até 60 caracteres
  (`cleanText(body.name, 60)`). O painel, ao renomear, aceita só 40 (`DEVICE_NAME_MAX`, `web.js` l. 52). Um serviço chamado
  com 41–60 caracteres não pode ser renomeado para o mesmo nome.
- **E4. F5 abre a extensão errada.** O `.vscode/launch.json` da raiz abre o código do projeto original (`dist/`,
  `preLaunchTask` de build), não `plus/`.

**Performance**

- **P1.** Toda janela do VS Code varre `~/.claude/projects` inteiro: `scanLimitErrors` a cada 15 s e `detectModels` a cada
  30 s, com `readdir` + `stat` em série, um arquivo de cada vez.
  - Medido com 300 projetos × 40 transcrições antigas: **mediana 920 ms por varredura** (50 × 20: 86 ms).
  - `stat` em série: 1.004 ms. Com 32 em paralelo: 304 ms (medido).
  - Uma varredura começa mesmo se a anterior ainda não acabou.
- **P2.** O painel web (`staticFile`, `web.js` l. 616) lê os arquivos do disco a cada pedido e os manda sem compressão e sem
  ETag (`Cache-Control: no-cache`). Toda abertura baixa **226.712 bytes**. Com gzip seriam 61.490.

**Design** (padrão que o próprio projeto declara)

- `server/web/app.css` declara no topo a escala de espaço 4/8/12/16/24/32/48 e de tipos 12/13/14/15/16/18/22, e as cores
  em variáveis no `:root` (tema escuro e claro). Desvios encontrados:
  - `font-size` fora da escala:
    - l. 121 `h1` 20px;
    - l. 386 `.logincard h1` 26px;
    - l. 1068 `.thsort::after` 11px;
    - l. 1071 e 1072 9px;
    - l. 1255 `.sechead` 20px.
  - cor literal fora das variáveis:
    - l. 209 `button.danger { color: #fff }`;
    - l. 341 `#fff` no gradiente do `input.sw`;
    - l. 571 `rgba(46,160,67,0.2)` no `.dot.on`.
- `plus/media/panel.css` declara "Cores: sempre as variáveis `--vscode-*` do tema", mas tem:
  - l. 8 `--green: #2ea043` fixo;
  - l. 74 `background: #fff` no botão do interruptor.

  Os dois quebram no tema de alto contraste.

## Solução proposta

### Fase 1 — entra nesta volta

#### 1. Ambiente local com dados simulados (prioridade 1)

Um comando, sem dependências para instalar:

```bash
node dev/ambiente-local.js            # = "subir"
```

Subcomandos (todos em `dev/ambiente-local.js`):

| Subcomando | O que faz |
| --- | --- |
| `subir` (padrão) | Cria (se não existir) a pasta de dados `dev/.dados/` e semeia o cofre (ver "Dados simulados") só se ele estiver vazio. Sobe o **Anthropic/Google falso** (`dev/simulado/fora-falso.js`) em `127.0.0.1:3010` e o **servidor Swap Plus real** (`server/src/server.js`) em `127.0.0.1:3008` (API + painel; admin local em `127.0.0.1:3009`). No terminal: o endereço do painel (`http://127.0.0.1:3008/`), um **código de conexão** novo (o admin local, como `cli.js pair`), o e-mail de administrador simulado e como mudar o uso das contas. Ctrl+C encerra tudo (o servidor grava o cofre). |
| `testes` | Roda tudo offline, em sequência: `node --check` em `plus/`, `server/src`, `cliente/src` e `dev/`; `node plus/test/smoke.js --unit` (nunca o modo completo, que vai ao GitHub); `node --test plus/test/*.test.js`; `node --test server/test/*.test.js`; `node --test cliente/test/*.test.js`; `node dev/conferir-design.js`. Imprime um resumo por suíte e sai ≠ 0 se alguma falhar. |
| `medir` | Roda `dev/medir-desempenho.js` (antes/depois; ver item 4). |
| `cliente` | Roda o Swap Plus Cliente contra o servidor local: pareia com um código novo e faz um ciclo. Tudo isolado: `HOME` e `CLAUDE_CONFIG_DIR` em `dev/.dados/cliente/`. |
| `vscode` | Se houver `code` no PATH (ou `CODE_BIN`), abre o **Extension Development Host** com `--extensionDevelopmentPath=plus`, `--user-data-dir` e `--extensions-dir` em `dev/.dados/vscode/` e `--disable-extensions`. O ambiente fica isolado: `HOME=dev/.dados/home`, `CLAUDE_CONFIG_DIR=dev/.dados/home/.claude`, `TMPDIR=dev/.dados/tmp`. O `User/settings.json` já vem com `swapPlus.server.url = http://127.0.0.1:3008` e `swapPlus.updates.enabled = false`. Sem `code`: mostra como instalar (ver "Testes esperados") e sai com código 2. Em máquina sem tela: `xvfb-run -a node dev/ambiente-local.js vscode`. |
| `limpar` | Apaga `dev/.dados/` (pede confirmação; `--sim` pula). Só mexe nessa pasta. |

Regras do ambiente local:

- **Nada sai para a internet.** `dev/sem-internet.js` entra em todos os processos Node que o `ambiente-local.js` inicia
  (servidor, falso, cliente, testes) por `NODE_OPTIONS=--require <caminho absoluto>/dev/sem-internet.js`.
  - Ele troca `net.Socket.prototype.connect`, `dns.lookup` e `dns.promises.lookup`. Qualquer destino que não seja
    `127.0.0.1`, `::1`, `localhost` ou socket Unix/pipe falha com erro `ENETUNREACH`.
  - Cada tentativa vai para `stderr` como `[sem-internet] bloqueado: <host>:<porta>` e é contada.
  - O `testes` mostra o total de bloqueios no resumo. O esperado é 0. Se der > 0, a suíte passa mesmo assim, mas o resumo
    diz qual teste tentou sair, e isso entra no relatório do tester.
- Portas fixas: **3008** (API + painel), **3009** (admin, só 127.0.0.1) e **3010** (Anthropic/Google falso). Não colidem
  com 3001–3007 dos outros projetos. Porta ocupada: o `subir` diz qual e sai, sem trocar de porta sozinho.
- Variáveis do servidor no `subir`:
  - `TLS_MODE=off`, `PUBLIC_URL=http://127.0.0.1:3008`, `PORT=3008`, `ADMIN_PORT=3009`;
  - `DATA_DIR=dev/.dados/servidor`, `MASTER_KEY_FILE=dev/.dados/chave-mestra`, gerada com `crypto.randomBytes(32)` e
    modo 0600;
  - `ANTHROPIC_API_BASE=http://127.0.0.1:3010`, `ANTHROPIC_TOKEN_URL=http://127.0.0.1:3010/v1/oauth/token`;
  - `GOOGLE_AUTH_URL=http://127.0.0.1:3010/google/auth`, `GOOGLE_TOKEN_URL=http://127.0.0.1:3010/google/token`;
  - `GOOGLE_CLIENT_ID_FILE` e `GOOGLE_CLIENT_SECRET_FILE` em `dev/.dados/` (valores fictícios);
  - `ADMIN_EMAILS=admin@local.test`, `NOTICES_ENABLED=0`, `TZ=America/Sao_Paulo`.
- `dev/.dados/` entra no `.gitignore` da raiz.

**Dados simulados** (`dev/simulado/dados.json`, editável à mão; `dev/simulado/semear.js` grava no cofre com a classe `Store`
do próprio servidor):

- 4 contas, com tokens fictícios no formato `sk-ant-oat01-SIMULADO-<n>-…`:
  - conta 1: sessão 2%, semanal 30%, Fable 57%;
  - conta 2: semanal 85%, acima da linha de troca padrão de 80%;
  - conta 3: plano sem Fable;
  - conta 4: login morto (`dead`).
- E-mails `conta1@local.test` a `conta4@local.test`.
- Lista de contas Google liberadas: `pessoa@local.test`.
- 1 serviço já conectado: "Hermes (simulado)".
- Semeadura idempotente: só roda com o cofre vazio. Rodar `subir` duas vezes não cria conta nem serviço repetido.

**Anthropic/Google falso** (`dev/simulado/fora-falso.js`, só `node:http`, ouvindo só em 127.0.0.1):

- `GET /api/oauth/usage`: devolve o uso da conta dona do `Authorization: Bearer` (lido do `dados.json`, recarregado a cada
  pedido).
- `GET /api/oauth/profile` e `GET /v1/models`: perfil e catálogo fictícios. A conta 3 não tem o Fable no catálogo.
- `POST /v1/oauth/token`: renovação. Devolve tokens novos `…-SIMULADO-<n>-<contador>`, e o refresh token velho passa a
  responder `invalid_grant` (uso único, como o real).
- `POST /_simular/uso` `{ "conta": 2, "sessao": 95 }` (também `semanal`, `fable`): muda o uso ao vivo, para o tester
  provocar uma troca. O `subir` imprime um exemplo com `curl`.
- `GET /google/auth`: página com dois botões, "Entrar como admin@local.test" e "Entrar como intruso@local.test".
  - O clique volta para `redirect_uri` com `code` e `state`.
  - `POST /google/token` devolve um `id_token` **sem assinatura** (cabeçalho `alg: none`) com `iss=accounts.google.com`,
    `aud`=client id fictício, `email` e `email_verified: true`, `exp` = agora + 1 h.
- Formato das respostas: copiar das funções de teste existentes (`server/test/anthropic.test.js`,
  `usage-poll.test.js`, `google.test.js`), que já simulam esses endpoints.

README da raiz: nova seção "Ambiente local (desenvolvimento e testes)", com os subcomandos acima, o que instalar e o aviso de
que nada ali usa contas ou servidor de verdade.

`.vscode/launch.json` da raiz: a primeira configuração passa a ser "Swap Plus (plus/) — ambiente local".
- `extensionDevelopmentPath=${workspaceFolder}/plus`, sem `preLaunchTask`;
- `env` com `HOME`, `CLAUDE_CONFIG_DIR` e `TMPDIR` em `${workspaceFolder}/dev/.dados/…`.

A configuração antiga continua, renomeada para "Original (claude-swap-status, só referência)". Isso corrige o E4.

#### 2. Duplicidade (prioridade 2)

**D1 — nome de serviço único.** Regra **aprovada pelo PM em 2026-11-25 (opção A)**. O Paulo pode trocar pela opção B
("substituir o antigo") antes do merge.

- Dois serviços **não podem ter o mesmo nome**. O pedido é recusado com HTTP **409**, `error: "name_taken"`, mensagem
  **"Já existe um serviço com este nome; escolha outro ou desconecte o antigo no painel."**
- Comparação: `chaveNome(s)` em novo `server/src/nomes.js`:

  ```js
  String(s).normalize("NFC").replace(/\s+/gu, " ").trim().toUpperCase().toLowerCase().normalize("NFC")
  ```

  - Não diferencia maiúsculas em nenhum alfabeto: "NoteWin" = "notewin", "ÇAÇA" = "çaça", e "ΣΊΣΥΦΟΣ" = "σίσυφος" =
    "σίσυφοσ" (σ/ς/Σ iguais, verificado no Node 24).
  - Acento conta: "José" ≠ "Jose". A forma composta e a decomposta do mesmo acento são iguais.
  - Espaços repetidos e espaços nas pontas não contam.
- Onde vale:
  1. `POST /v1/pair`: a conferência é feita **imediatamente antes** de `createDevice`, sem `await` entre as duas. Dois
     pareamentos simultâneos com o mesmo nome: um passa, o outro recebe 409. O código de conexão **não é gasto** quando
     o pedido é recusado.
  2. `POST /v1/login/start` (Google): confere já no início (resposta rápida, 409). Confere de novo e de forma definitiva em
     `deviceCallback`, logo antes de `createDevice`, na mesma parte síncrona.
     - Se der conflito no retorno, a página no navegador mostra a mesma mensagem (página de erro existente, `pageError`).
     - A sessão de login termina com `{ nameTaken: true }`, e o `POST /v1/login/poll` passa a responder
       `{ status: "name_taken", message }`.
  3. `PATCH /web/api/devices/:id` (renomear no painel): conflito com **outro** serviço dá 409 com a mesma mensagem.
     Renomear para o mesmo nome com outra caixa ("notewin" → "NoteWin") é permitido.
  4. CLI do admin: não cria serviços, nada muda.
- **Reconectar o mesmo computador não pode dar conflito com ele mesmo.** O pedido de pareamento ou login passa a aceitar
  `replaces: { deviceId, token }` (opcional), com o acesso antigo deste mesmo computador.
  - Se `sha256(token)` bater com o `tokenHash` daquele serviço, ele fica fora da conferência de nome.
  - Quando o novo é criado, o antigo é removido **na mesma gravação do cofre**, com `forgetDevice`, e entra no histórico a
    linha `Serviço "<nome>" reconectado: o acesso anterior deixou de valer`.
  - `replaces` inválido é ignorado sem erro, e a regra de nome vale normalmente.
  - No Google, o `replaces` fica na sessão em memória: só o hash do token, nunca o token.
- Extensão (`plus/extension.js` + `plus/serverClient.js`):
  - Em `connectByCode` e `connectByGoogle`, quando já há conexão com a **mesma origem**, manda `replaces` com o `deviceId`
    e o token guardados.
  - Ao receber `name_taken` (409 ou status do poll), mostra a mensagem e reabre `askDeviceName` com o nome digitado,
    até a pessoa escolher outro ou desistir.
  - O `DELETE` do serviço antigo em `finishConnect` continua (o 404 já é ignorado).
- Cliente (`cliente/src/conexao.js` e `cli.js`): manda `replaces` quando já tem conexão com a mesma origem. Ao receber
  `name_taken`, sai com código ≠ 0 e a mensagem, mais a dica `--nome <outro>` (ou como o nome é configurado hoje no
  `cliente/src/config.js`).
- **O que já está duplicado hoje fica como está**: nada é apagado, desconectado nem renomeado. A regra só vale para
  pedidos novos. Renomear um dos duplicados existentes para outro nome livre funciona.
- O painel (`server/web/app.js`) mostra a mensagem do 409 no aviso de erro que já usa para os outros erros do renomear.

**D2 — aviso uma vez só por computador.**
- `checkAlerts()` passa a rodar só quando `isOwnerNow()` é verdadeiro.
- Antes de avisar, a extensão reivindica a chave do aviso (`conta|janela|linha|renovação`, a mesma de hoje) criando o
  arquivo `os.tmpdir()/swap-plus-avisos/<sha1(chave)>` com `flag: "wx"`. `EEXIST` = outra janela já avisou, então pula.
  Isso cobre a passagem de dona entre janelas.
- Os arquivos com mais de 8 dias são apagados no `activate`.
- O `globalState` continua como hoje, como segunda barreira.

**D3 — trava do limite atômica.**
- Extrair de `withOwnerLock` um `withDirLock(dir, fn)` genérico: `mkdir` atômico, trava esquecida há > 5 s é tomada.
- `claimLimit` faz ler → comparar → gravar dentro de `withDirLock(LIMIT_LOCK + ".d", …)`. Trava ocupada = não reivindica
  (outra janela está reivindicando).
- Junto com o P1 (só a janela dona varre), fica no máximo uma reação por erro.

#### 3. Erros (prioridade 3)

- **E1.** `detectModels` e `limitRoot` passam a usar `path.join(claudeConfigDir(), "projects")`, calculado na hora (não na
  carga do módulo). O gancho de teste `setLimitRoot` continua funcionando.
- **E2.** `cleanText` corta por ponto de código: `[...s].slice(0, max).join("")`. O mesmo vale para os outros cortes de nome
  e apelido na API (`cleanText(body.alias, 40)`).
- **E3.** `DEVICE_NAME_MAX` do painel passa a **60**, igual ao pareamento. Nenhum nome existente fica impossível de
  renomear. O texto da mensagem de erro acompanha.
- **E4.** Ver o item 1 (`launch.json`).
- Qualquer outro erro que o `testes` ou o ambiente local mostrarem durante a implementação: corrigir e listar no PR, com o
  passo para reproduzir.

#### 4. Performance (prioridade 4), com medida antes/depois

- **P1 — transcrições do Claude Code.**
  - Só a janela **dona** varre: `checkLimitErrors` retorna logo se `!isOwnerNow()`. As outras janelas não varrem. A dona
    que fecha solta a posição (`releaseOwner`), e outra assume no próximo ciclo.
  - Um **inventário único** (novo, no `extension.js` ou num `plus/transcricoes.js`) serve `scanLimitErrors` e
    `detectModels`:
    - lista de `.jsonl` (inclusive `subagents/`) com `mtimeMs`;
    - a lista de arquivos de cada pasta só é relida quando o `mtime` da pasta muda;
    - `stat` com até 32 em paralelo;
    - resultado reaproveitado por até 10 s.
  - Varredura em andamento: o próximo tique é pulado, sem empilhar.
- **P2 — painel web.**
  - `staticFile` guarda em memória o conteúdo, o gzip (nível 9) e um ETag (`"sha256-<16 hex>"`) de cada arquivo. Recarrega
    quando o `mtime` do arquivo muda.
  - Responde `Content-Encoding: gzip` (+ `Vary: Accept-Encoding`) quando o pedido aceita gzip, e **304** sem corpo quando
    `If-None-Match` bate.
  - Só os 3 arquivos estáticos (`index.html`, `app.js`, `app.css`). As respostas da API continuam sem compressão, porque
    levam acesso das contas (o motivo do comentário em `server/deploy/Caddyfile.bloco`).
- **Medida**: `dev/medir-desempenho.js` (subcomando `medir`) mede o "antes" e o "depois" na mesma execução.
  - O "antes" é o código de `origin/main`, extraído com `git archive origin/main plus server` para uma pasta temporária.
  - Imprime uma tabela:
    - mediana de 10 execuções de `scanLimitErrors` e de `detectModels`, com 300 projetos × 40 transcrições antigas + 5
      recentes, em pasta temporária;
    - número de varreduras completas por minuto com 3 janelas simuladas. Antes: 3 × (4 + 2) = 18. Esperado depois: ≤ 4;
    - bytes do painel na primeira abertura (com `Accept-Encoding: gzip`) e numa reabertura (com `If-None-Match`), medidos
      contra um servidor de teste em porta livre.
  - Grava o resultado em `dev/.dados/medidas.json`.
  - Os números antes/depois vão para a descrição do PR e para `NOVIDADES-3.6.md`.

#### 5. Design (prioridade 5)

- `server/web/app.css`:
  - `font-size` na escala declarada:
    - `h1` 20 → 22px;
    - `.logincard h1` 26 → 22px;
    - `.sechead` (celular) 20 → 18px;
    - setas de ordenação 11px/9px → 12px.
  - `button.danger` e o gradiente do `input.sw`: `#fff` → `var(--accent-fg)`.
  - Novo token `--okring` nos dois temas, para o `.dot.on`: escuro `rgba(46,160,67,0.2)`, claro `rgba(31,136,61,0.2)`.
- `plus/media/panel.css`:
  - `--green: var(--vscode-charts-green, #2ea043)`;
  - botão do interruptor: `background: var(--vscode-button-foreground, #fff)`.
- `dev/conferir-design.js`: conferência automática que roda no `testes`.
  - Falha (código ≠ 0, com arquivo:linha) se `app.css` tiver `font-size` em px fora de {12,13,14,15,16,18,22}.
  - Também falha se `app.css` ou `panel.css` tiverem cor literal (`#hex`, `rgb(`, `rgba(`) fora dos blocos de definição
    de variáveis (`:root`, `@media (prefers-color-scheme: light) { :root … }`, `body.vscode-light`, `body.vscode-dark`,
    `body.vscode-high-contrast`) e fora do segundo argumento de `var()`.
  - Sombras (`box-shadow` com `rgba(0,0,0,…)`) entram na lista de exceções do próprio script, com comentário.

#### Versões e documentação

- Versões: `plus/package.json` → **3.6.0**, `VERSION` do servidor → **2.8.0**, `cliente/package.json` → **1.2.0**.
  Mudou o comportamento de conexão (`name_taken`, `replaces`).
- Novo `NOVIDADES-3.6.md`, no padrão dos anteriores, com a regra do nome, o ambiente local e as medidas. Link no README.
- `server/SPEC.md` e `server/WEB-SPEC.md`: documentar `replaces`, o 409 `name_taken` e o status `name_taken` do poll.

### Fase 2 — próxima volta (não entra agora)

- Teste automatizado no **Extension Development Host** (`@vscode/test-electron` com VS Code já instalado, via `xvfb-run`),
  sem baixar nada nos testes.
- Linter (ESLint sem dependências no repositório é impossível; avaliar `node --check` + `tsc --checkJs` opcional).
- Revisão visual completa do painel e da tela de configurações (espaçamentos fora da escala de 4/8: há ~60 ocorrências de
  2/6/10/14px em `app.css` e `panel.css`, que pedem um olhar de design antes de mexer).
- Decidir o destino de `.github/workflows/publish.yml` (ver "Deploy").

### Arquivos a criar ou alterar

- `dev/ambiente-local.js` — **novo**: subcomandos `subir`, `testes`, `medir`, `cliente`, `vscode`, `limpar`.
- `dev/sem-internet.js` — **novo**: bloqueio de conexões fora do loopback.
- `dev/simulado/fora-falso.js` — **novo**: Anthropic + Google falsos.
- `dev/simulado/dados.json` — **novo**: contas e uso simulados.
- `dev/simulado/semear.js` — **novo**: semeadura idempotente do cofre.
- `dev/medir-desempenho.js` — **novo**: medida antes/depois.
- `dev/conferir-design.js` — **novo**: conferência de cores e tipos.
- `.gitignore` — acrescentar `dev/.dados/`.
- `.vscode/launch.json` — configuração do `plus/` com ambiente isolado (E4).
- `README.md` — seção "Ambiente local"; link do NOVIDADES-3.6.
- `NOVIDADES-3.6.md` — **novo**.
- `server/src/nomes.js` — **novo**: `chaveNome`, `cortar(s, max)` por ponto de código.
- `server/src/server.js`:
  - `cleanText` por ponto de código;
  - conferência de nome em `pair`, `loginStart` e `deviceCallback`;
  - `replaces`;
  - `status: "name_taken"` no poll;
  - `VERSION` 2.8.0.
- `server/src/google.js` — sessão de login guarda `replacesId` e `replacesHash` e o resultado `nameTaken` (se a sessão
  morar aqui).
- `server/src/web.js` — `patchDevice` com a regra; `DEVICE_NAME_MAX` = 60; `staticFile` com cache, gzip e ETag/304.
- `server/web/app.js` — mostrar a mensagem do 409 ao renomear (se o tratamento genérico ainda não mostrar).
- `server/web/app.css` — desvios de design.
- `server/SPEC.md`, `server/WEB-SPEC.md` — documentação da API.
- `plus/extension.js`:
  - E1;
  - D2: `checkAlerts` só na dona + reivindicação por arquivo;
  - D3: `withDirLock` + `claimLimit`;
  - P1: só a dona varre, inventário compartilhado, sem sobreposição;
  - `replaces` e `name_taken` na conexão.
- `plus/serverClient.js` — `pair` e `loginStart` aceitam `replaces`; erro `name_taken` exposto com `code`.
- `plus/media/panel.css` — desvios de design.
- `plus/package.json` — 3.6.0.
- `cliente/src/conexao.js`, `cliente/src/cli.js`, `cliente/package.json` — `replaces`, `name_taken`, 1.2.0.
- Testes novos (ver "Testes esperados") em `server/test/`, `plus/test/`, `cliente/test/`.

### Dados e migrações

Não há banco. O cofre (`store.enc`) **não muda de formato**: nenhum campo novo é obrigatório e nada é apagado. Serviços já
duplicados continuam lá. Os arquivos novos na máquina (`$TMPDIR/swap-plus-avisos/`, `swap-plus-limit.lock.d/`) são
temporários e descartáveis. Reversível: voltar a versão anterior não precisa de nenhum passo.

### Decisões técnicas

- **Servidor real + "de fora" falso, em vez de um servidor falso.** O tester exercita o mesmo código que vai para produção
  (motor, cofre, painel), e só a Anthropic e o Google são trocados, por variáveis que o servidor já tem.
- **Script Node sem dependências** (`dev/ambiente-local.js`), e não Docker nem `npm run`. Docker não está instalado, o
  projeto não tem dependências npm, e o `package.json` da raiz é do projeto original.
- **Bloqueio de rede por `--require`** em vez de confiar que os testes não saem: dá prova verificável do "nada sai para a
  internet" (lição de outras demandas).
- **Portas 3008/3009/3010.** O Swap Plus não tinha porta na tabela do PM ("sem web"), mas o servidor tem painel web. O PM
  deve registrar essas portas em `projetos.md`.
- **Nome único com `toUpperCase().toLowerCase()` + NFC.** É o *case folding* completo disponível no JavaScript sem
  biblioteca: resolve σ/ς/Σ e ß/SS e mantém acentos distintos, como o PM pediu. NFKC foi descartado porque juntaria
  caracteres diferentes (ex.: ﬁ e fi).
- **`replaces` com o token antigo**, e não "mesmo nome + mesma conta Google". O pareamento por código não tem conta Google,
  e só o próprio computador conhece o token. Assim a regra A não bloqueia a reconexão legítima, e a troca é atômica (não
  depende do `DELETE` posterior, que pode falhar sem rede).
- **Avisos e varredura só na janela dona**, porque é a janela que já faz o batimento e grava o login. Isso elimina D2 e
  reduz P1 de N janelas para 1. O preço: a notificação aparece na janela dona, não necessariamente na que está na frente.
- **gzip só nos estáticos do painel**: as respostas da API levam acesso das contas, e o projeto já decidiu não comprimi-las.
- **Medida "antes" tirada de `origin/main` pelo próprio script**, para os testers repetirem a comparação na máquina deles
  sem depender dos números desta spec.

## Critérios de aceite (verificáveis)

Todos no ambiente local, nesta máquina ou em outra com Node ≥ 22. "Repo" = a raiz do repositório na branch da demanda.

**Ambiente local**

1. Dado o repo sem `dev/.dados/`, quando rodo `node dev/ambiente-local.js`, então em até 15 s o terminal mostra o endereço
   `http://127.0.0.1:3008/`, um código de conexão e o e-mail `admin@local.test`, sem erro. `curl -s
   http://127.0.0.1:3009/v1/health` responde `"ok":true`.
2. Dado o ambiente no ar, quando abro `http://127.0.0.1:3008/` e entro como `admin@local.test` pelo Google falso, então o
   painel mostra exatamente 4 contas (`conta1@local.test`…`conta4@local.test`) com os usos de `dados.json` e o serviço
   "Hermes (simulado)".
3. Dado o ambiente no ar, quando entro como `intruso@local.test`, então o painel recusa a entrada (página de conta não
   liberada).
4. Dado o ambiente já usado uma vez, quando paro (Ctrl+C) e rodo `node dev/ambiente-local.js` de novo, então o painel
   continua com 4 contas e 1 "Hermes (simulado)" (semeadura não duplica).
5. Dado o ambiente no ar, quando rodo o `curl` de exemplo impresso (`POST /_simular/uso` com a conta em uso a 95% na
   sessão), então em até 2 ciclos de uso o painel mostra o novo percentual. Com a troca automática ligada e um serviço
   ativo nessa conta, o histórico registra a troca.
6. Dado o repo, quando rodo `node dev/ambiente-local.js testes`, então todas as suítes passam e o resumo final mostra
   **0 bloqueios** `[sem-internet]`. Os totais são ≥ 106 (extensão), ≥ 283 (servidor) e ≥ 181 (cliente), mais os testes
   novos.
7. Dado o `dev/sem-internet.js`, quando rodo `NODE_OPTIONS=--require ./dev/sem-internet.js node -e
   "fetch('https://example.com').then(()=>console.log('saiu'),e=>console.log('bloqueado'))"`, então aparece `bloqueado` e a
   linha `[sem-internet] bloqueado: example.com:443`.
8. Dado o ambiente no ar, quando rodo `node dev/ambiente-local.js cliente`, então o cliente pareia e completa um ciclo, e
   `dev/.dados/cliente/.claude/.credentials.json` tem um token `…SIMULADO…`. `~/.claude` do usuário não muda (conferir
   `stat -c %Y ~/.claude/.credentials.json` antes e depois, se existir).
9. Dado que o VS Code está instalado, quando rodo `node dev/ambiente-local.js vscode` (ou `xvfb-run -a …`), conecto pelo
   código e espero 30 s, então:
   - a barra de status mostra o uso da conta escolhida;
   - `dev/.dados/home/.claude/.credentials.json` tem o token simulado;
   - `~/.claude` e as configurações do VS Code do usuário não mudam.

   Sem VS Code, o comando sai com código 2 e mostra como instalar.
10. Dado o repo aberto no VS Code, quando aperto F5, então abre o Extension Development Host com a extensão de `plus/`
    (aparece "Swap Plus" na barra), não a "Claude Swap Status".
11. `node dev/ambiente-local.js limpar --sim` apaga só `dev/.dados/`. `git status` fica limpo depois.

**Duplicidade**

12. Dado um serviço "NoteWin" conectado, quando pareio outro computador com o nome "notewin", " NoteWin " ou "NOTEWIN",
    então recebo 409 `name_taken` com a mensagem "Já existe um serviço com este nome; escolha outro ou desconecte o antigo
    no painel." Nenhum serviço é criado e o código de conexão continua valendo para outra tentativa. O mesmo vale para
    "Note  Win" (dois espaços) com um "Note Win" conectado.
13. Dado um serviço "Σίσυφος", quando pareio com "ΣΊΣΥΦΟΣ" ou "σίσυφοσ", então recebo 409. Pareando com "Sisyphos" ou
    "Σισυφος" (sem acento), conecta.
14. Dado um serviço "José", quando pareio com "Jose", então conecta. Pareando com "Jose" + U+0301 (acento decomposto), recebo
    409.
15. Dado um serviço "NoteWin", quando entro com Google pelo VS Code (ou pelo `cliente`) com o nome "notewin", então o VS Code
    mostra a mensagem e pede outro nome. A página do navegador mostra a mesma mensagem e nenhum serviço novo aparece no
    painel.
16. Dado este VS Code já conectado como "NoteWin", quando conecto de novo ao **mesmo** servidor com o mesmo nome, então
    conecta, o painel mostra **um** "NoteWin" (o novo), o token antigo passa a receber 401, e o histórico tem "Serviço
    "NoteWin" reconectado: o acesso anterior deixou de valer".
17. Dado dois pareamentos simultâneos com o mesmo nome (teste automatizado com `Promise.all`), então exatamente um recebe 200
    e o outro 409.
18. Dado os serviços "A" e "B", quando renomeio "B" para "a" no painel, então aparece o erro com a mensagem. Renomeando "A"
    para "a", é aceito.
19. Dado um cofre que já tem dois serviços "NoteWin" (montado no teste), quando o servidor sobe e roda, então os dois
    continuam conectados e nenhum é apagado.
20. Dado 3 instâncias da extensão no mesmo computador (teste automatizado em `servermode.test.js`, mesmo `TMPDIR`, mesmo
    servidor falso), quando a conta passa da linha de aviso, então sai **1** notificação e **1** linha de "chegou a X%" no
    histórico.
21. Dado 2 instâncias que veem o mesmo erro de limite ao mesmo tempo (teste automatizado), então o servidor falso recebe
    **1** `POST /v1/events {kind:"limit_hit"}`.

**Erros**

22. Dado `CLAUDE_CONFIG_DIR=/tmp/x` com um erro de limite em `/tmp/x/projects/p/s.jsonl` (teste automatizado), quando
    `checkLimitErrors` roda, então ele acha o erro. O mesmo vale para `detectModels` com um modelo usado há 1 min.
23. Dado o nome `"NoteWin 😀"` repetido até passar de 60 caracteres, quando pareio, então o nome gravado tem no máximo 60
    pontos de código e nenhum surrogate solto (`/[\uD800-\uDFFF]/u` não casa com `name.normalize()`). O mesmo vale para o
    apelido de conta com 40.
24. Dado um serviço com nome de 55 caracteres, quando renomeio no painel para outro nome de 55, então é aceito.

**Performance**

25. Dado `node dev/ambiente-local.js medir`, então a tabela mostra antes e depois, e:
    - mediana de `scanLimitErrors` depois ≤ **40%** da de antes (300 × 40);
    - varreduras por minuto com 3 janelas: antes 18, depois ≤ 4;
    - bytes da primeira abertura do painel com gzip ≤ **30%** dos de antes (226.712 → ≤ 68.000);
    - reabertura com ETag: resposta 304 e 0 bytes de corpo nos 3 arquivos.
26. Dado o ambiente no ar, `curl -s -o /dev/null -w '%{size_download}' -H 'Accept-Encoding: gzip'
    http://127.0.0.1:3008/static/app.js` mostra ≤ 45.000. Com `-H "If-None-Match: <etag recebido>"`, o código é 304.
27. Dado `curl -sI -H 'Accept-Encoding: gzip' http://127.0.0.1:3008/v1/health` (ou qualquer rota da API), então **não** há
    `Content-Encoding`.

**Design**

28. `node dev/conferir-design.js` sai com 0. Se eu acrescentar `color: #123456;` numa regra comum de `app.css`, ele sai ≠ 0
    apontando o arquivo e a linha.
29. No painel local, tema escuro e claro (alternar o tema do sistema ou forçar `prefers-color-scheme` nas ferramentas do
    navegador): título, botões "perigo", interruptores e bolinhas de "em uso" ficam legíveis. Os tamanhos de título seguem
    a escala (22px no `h1`).
30. Na tela de configurações da extensão (critério 9), com o tema "Dark High Contrast", o interruptor ligado usa as cores do
    tema (não o verde fixo).

## Testes esperados

- **Automatizados** (todos entram no `node dev/ambiente-local.js testes` e no CI que já existe):
  - `server/test/nomes.test.js` — `chaveNome` (critérios 12–14, inclusive σ/ς/Σ, NFD, espaços) e `cortar` (23).
  - `server/test/api.test.js` — 409 no pair (12), código não gasto, pareamentos simultâneos (17), `replaces` válido e
    inválido (16), cofre com duplicados antigos intacto (19), `cleanText` com emoji (23).
  - `server/test/google.test.js` — 409 no `login/start`, conflito no retorno → página + `status: "name_taken"` no poll
    (15), `replaces` pela sessão.
  - `server/test/web.test.js` — renomear com conflito e com caixa diferente do próprio (18), limite de 60 (24), estáticos
    com gzip/ETag/304 e API sem compressão (25–27).
  - `plus/test/servermode.test.js` — 3 instâncias → 1 aviso (20), 2 instâncias → 1 `limit_hit` (21), `name_taken` reabre o
    nome, `replaces` enviado só para a mesma origem.
  - `plus/test/clientlibs.test.js` — `serverClient.pair`/`loginStart` com `replaces` e erro `name_taken`.
  - `plus/test/smoke.js` — `CLAUDE_CONFIG_DIR` em `scanLimitErrors`/`detectModels` (22), inventário compartilhado e "sem
    sobreposição".
  - `cliente/test/conexao.test.js` — `replaces` e saída com `name_taken`.
  - `dev/conferir-design.js` — critério 28.
- **Manuais** (passo a passo para os testers):
  1. Instale o Node ≥ 22 se faltar (nesta máquina já há o 24.22.3). Nada mais é necessário para os critérios 1–8 e 10–29.
  2. Para os critérios 9 e 30, instale o VS Code: `sudo snap install code --classic` ou o `.deb` de
     code.visualstudio.com (`sudo apt install ./code_*.deb`). Em servidor sem tela, use `xvfb-run -a`. A instalação usa a
     internet; o ambiente e os testes não.
  3. `node dev/ambiente-local.js testes` → critério 6.
  4. Terminal 1: `node dev/ambiente-local.js`. Navegador: `http://127.0.0.1:3008/` → critérios 1–5, 26–27, 29.
  5. Terminal 2: `node dev/ambiente-local.js cliente` → critério 8. Rode de novo com o mesmo nome em outra pasta de dados
     (`--dados dev/.dados/cliente2`) → critério 12 pelo cliente.
  6. Terminal 2: `node dev/ambiente-local.js vscode` → critérios 9, 15, 16 e 30 (conectar, reconectar e conectar com nome
     repetido).
  7. `node dev/ambiente-local.js medir` → critério 25. Anexe a tabela ao relatório.
  8. `node dev/ambiente-local.js limpar --sim` → critério 11.

## Riscos e rollback

- **Extensões e clientes antigos contra o servidor novo.** Uma extensão 3.5.0 que receba 409 `name_taken` mostra o erro
  genérico de pareamento (ela já mostra a mensagem do servidor), o que é aceitável. Mas no Google ela recebe um
  `status: "name_taken"` desconhecido no poll e pode ficar esperando até a sessão vencer (10 min).
  - Mitigação: o servidor só responde `name_taken` no poll se o pedido de `login/start` trouxe `caps: ["name_taken"]`
    (a extensão 3.6 e o cliente 1.2 mandam).
  - Para os antigos, responde `status: "denied"` com a mensagem no campo que eles já mostram.
  - O desenvolvedor confere o que a 3.5.0 faz com `denied` em `waitGoogleLogin`.
- **Reconectar de outro servidor ou outra origem** não manda `replaces`. Se o nome já existir no servidor novo, a pessoa
  precisa escolher outro nome (esse é o comportamento desejado pela regra A).
- **Aviso só na janela dona.** A pessoa pode não ver a notificação se estiver em outra janela. O histórico e a barra
  continuam iguais em todas.
- **Inventário com cache de 10 s.** Um erro de limite pode ser visto até ~10 s mais tarde que hoje (15 s de intervalo +
  cache). Isso é aceitável, porque a reação hoje já leva até 15 s.
- **gzip/ETag.** Proxies (Caddy/Cloudflare) já lidam com `Content-Encoding` e `Vary`. Se der problema, basta desligar o
  gzip no `staticFile`.
- **Rollback:** reverter o merge. O formato do cofre não muda, então as versões anteriores (servidor 2.7.0, extensão 3.5.0,
  cliente 1.1.0) voltam a funcionar sem passo extra. Os arquivos temporários novos podem ficar.

## Deploy

Fora do escopo desta demanda: nada é publicado por ela. Como funciona hoje, para registro:

- **Extensão:** **não** vai para o Marketplace nem para o Open VSX (`publisher: paulo-local`).
  - Subir a versão em `plus/package.json` e criar a tag `plus-v<versão>` (ex.: `plus-v3.6.0`).
  - O GitHub Actions `plus-release.yml` testa no Ubuntu e no Windows, empacota com
    `npx @vscode/vsce@3 package --no-dependencies` e confere o conteúdo do `.vsix`.
  - Depois cria a **GitHub Release** com `swap-plus.vsix`.
  - As instalações se atualizam sozinhas pelo atualizador da extensão (lê as releases do GitHub). Máquinas novas usam
    `plus/scripts/install.sh` (Mac) ou `install.ps1` (Windows).
- **Servidor:** manual, sem CI de deploy (o `server-ci.yml` só testa e constrói a imagem).
  - Imagem Docker construída no servidor (Contabo).
  - Stack pelo Portainer (`server/deploy/portainer_stack_create_swap_plus.py`, e para atualizar
    `portainer_stack_update.py --set SWAP_PLUS_VERSAO=<nova>`), conforme `server/deploy/LEIA-ME.md`.
  - Nenhuma variável nova é obrigatória.
- **Cliente:** Docker no servidor, conforme `cliente/deploy/LEIA-ME.md`.
- **Ordem recomendada quando o Paulo for publicar:** servidor 2.8.0 primeiro, depois a extensão 3.6.0 e o cliente 1.2.0.
  O servidor novo convive com clientes antigos (ver Riscos).
- **Atenção:** `.github/workflows/publish.yml` é do projeto original. Uma tag `v*` dispara uma tentativa de publicar a
  extensão **antiga** da raiz no Marketplace/Open VSX (passos pulados sem `VSCE_PAT`/`OVSX_PAT`). Não usar tags `v*`.
  Remover ou desligar esse workflow fica para a Fase 2, com OK do Paulo.
