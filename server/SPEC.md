# Swap Plus Servidor — especificação (2.0)

Fonte única para quem implementa o servidor (`server/`) e o modo servidor da extensão (`plus/`).
Tudo em português (código, comentários, mensagens). Node 22, **sem dependências de terceiros**.
**Nunca registrar em log nem devolver ao cliente o `refreshToken`.** Access tokens também nunca vão para log.

> **2.5.3 (21/11/2026): "serviço" no lugar de "computador", e a presença dos serviços.** Tudo o que se conecta ao servidor
> (um VS Code, o cliente do Hermes, um robô) é um **serviço** nos textos que o servidor gera: histórico, avisos, e-mails ao
> dono, páginas, mensagens de erro da API, ajuda e saídas da linha de comando, e o painel. "Computador" ficou só para a
> máquina em que a pessoa está sentada. Nenhum nome mudou no código nem no contrato: campos (`devices`, `deviceId`,
> `assignedDevices`, `accountDevices`, `devicePlacement`), rotas (`/v1/devices`, `/web/api/devices/:id`), ids, variáveis e
> comandos da CLI são os mesmos, e as entradas já gravadas no histórico ficam com o texto antigo (não há migração). Quem
> conecta sem mandar `name` passa a se chamar "serviço" (era "computador"); os nomes já guardados não mudam. Neste documento
> "dispositivo" é o registro `Device` do cofre, ou seja, um serviço. A presença de cada serviço (ativo, conectado, aguardando
> contato, sem contato) está em "Presença dos serviços" (engine.js, abaixo); os rótulos da tela, em WEB-SPEC.md, "2.5.3".

## Por que existe

O refresh token de cada conta Claude é de uso único (renovar invalida o anterior; o acesso dura ~8 h).
Com a mesma cópia do login em dois computadores, o que renova primeiro mata a cópia do outro.
O servidor (VPS, Docker) é o **único** que guarda o refresh token e renova. Os serviços conectados (clientes)
recebem só o access token da conta que o servidor escolheu para eles, e o servidor é quem decide as trocas
(mesma regra da extensão, `plus/rules.js`).

## Layout no repositório e na imagem

```
plus/rules.js              regras de troca (decide(), windows(), ...) — compartilhado
server/src/store.js        cofre criptografado (PRONTO, não mudar a interface)
server/src/anthropic.js    chamadas à Anthropic (renovar, uso, perfil)
server/src/engine.js       agendador: renova, lê uso, decide trocas por dispositivo, histórico
server/src/server.js       API HTTPS + pareamento + login com Google + admin local; ponto de entrada (node server/src/server.js)
server/src/google.js       login com Google: configuração, sessões em memória, PKCE, troca do code, id_token, páginas HTML
server/src/notify.js       caixa de saída dos avisos por e-mail ao dono (DATA_DIR/avisos/; o host entrega)
server/src/cli.js          CLI de admin (fala com o admin local em 127.0.0.1)
server/test/*.test.js      testes com node:test e uma Anthropic de mentira (rodam no servidor)
server/Dockerfile          contexto de build = raiz do repo
server/entrypoint.sh
```
Na imagem: `/app/plus/rules.js` e `/app/server/src/*.js` → `require("../../plus/rules")` funciona nos dois lugares.

## Variáveis de ambiente (servidor)

| var | padrão | |
|---|---|---|
| `DATA_DIR` | `/data` | cofre `store.enc`, `tls/`, `avisos/` (caixa de saída dos avisos ao dono) |
| `MASTER_KEY_FILE` | `/run/secrets/swap_plus_master_key` | 64 hex (32 bytes) |
| `PORT` | `8443` | API |
| `ADMIN_PORT` | `8444` | só `127.0.0.1` dentro do container |
| `TLS_MODE` | `self` | `self` = HTTPS com certificado próprio (cliente fixa a impressão digital); `off` = HTTP puro atrás de proxy (Traefik) que faz o TLS |
| `PUBLIC_URL` | — | URL que os clientes usam (vai no código de conexão) |
| `PUBLIC_HOST` | — | IP/host para o SAN do certificado próprio |
| `TRUST_PROXY` | `0` | `1` = usar o 1º IP de `X-Forwarded-For` (só atrás do proxy) |
| `ALLOW_IPS` | vazio | lista de IPs/CIDR IPv4 aceitos na API (vazio = todos) |
| `USAGE_MAX_PER_HOUR` | `24` | orçamento de consultas ao endpoint de uso (a Anthropic aceita ~30/h); o servidor guarda no máximo 6 para gastar de uma vez |
| `REFRESH_AHEAD_MIN` | `120` | renova quando faltam menos que isso para o access token vencer |
| `ANTHROPIC_TOKEN_URL` | `https://platform.claude.com/v1/oauth/token` | trocável nos testes |
| `ANTHROPIC_API_BASE` | `https://api.anthropic.com` | trocável nos testes |
| `GOOGLE_CLIENT_ID_FILE` | `/run/secrets/google_client_id` | lido na subida; faltando → login com Google desligado |
| `GOOGLE_CLIENT_SECRET_FILE` | `/run/secrets/google_client_secret` | idem (nunca vai para log nem resposta) |
| `GOOGLE_AUTH_URL` | `https://accounts.google.com/o/oauth2/v2/auth` | trocável nos testes |
| `GOOGLE_TOKEN_URL` | `https://oauth2.googleapis.com/token` | trocável nos testes |
| `TZ` | `America/Sao_Paulo` | textos "hoje 18:00" do `rules.js` |
| `ADMIN_EMAILS` | — | administrador(es) do painel web, separados por vírgula (produção: o e-mail do administrador, variável `SWAP_PLUS_ADMIN_EMAILS` da stack). Lido só na subida, sem rota para mudar. Vazio → painel desligado (aviso no log). Também decide quais serviços conectados com Google enviam logins (abaixo, "Quem envia logins"). Detalhes em WEB-SPEC.md |
| `RESTIC_PASS_FILE` | `/run/secrets/restic_swap_plus_pass` | senha do backup, só para o kit de recuperação do painel (opcional: sem o arquivo, "não disponível") |
| `NOTICE_LOGIN_DAYS` | `1` | quantos dias antes do fim do login de uma conta sai o e-mail dela ao dono (1 a 30); um e-mail por login |
| `NOTICE_WEEKLY` | `1` | resumo semanal por e-mail ao dono (as contas que vencem nos 7 dias seguintes); `0` desliga |
| `NOTICE_WEEKLY_DAY` | `1` | dia da semana do resumo: `0` = domingo … `6` = sábado (padrão: segunda) |
| `NOTICE_WEEKLY_HOUR` | `8` | hora do resumo (0 a 23), no fuso do servidor (`TZ`) |
| `NOTICES_ENABLED` | `1` | avisos por e-mail ao dono (abaixo, "Avisos por e-mail ao dono"); `0` desliga (nada é gravado em `DATA_DIR/avisos/`) |

Login com Google ligado = client id + client secret + `PUBLIC_URL`. Retorno cadastrado no Google Cloud:
`${PUBLIC_URL}/auth/google/callback` (produção: `https://swap.assistentes.si/auth/google/callback`, atrás do Caddy + Cloudflare
com `TLS_MODE=off` e `TRUST_PROXY=1`). Os arquivos precisam ser legíveis pelo usuário `node` (uid 1000) no container.

## Estado no cofre (`store.state`)

```js
{
  version: 1,
  nextNumber: 1,                 // próximo número de conta
  accounts: { "<n>": Account },
  devices: { "<id>": Device },
  pairing: { codeHash, expiresAt, attempts } | null,
  rules: { ...parcial de RULE_DEFAULTS } | null,   // efetivas = { ...RULE_DEFAULTS, ...rules }
  autoSwitch: true,
  history: [ { ts, kind, text, device } ],          // mais novo primeiro, máx. 100
  diag: { oldTokenValidAfterRefresh: true|false|undefined, checkedAt } ,
  allowedEmails: [ "pessoa@empresa.com" ],          // contas Google que podem conectar serviços (minúsculas); não dão painel
}
Account = {
  number, email, orgUuid, orgName, plan: { label } | null, alias: null,
  oauthAccount: {...},          // o bloco oauthAccount do ~/.claude.json dessa conta
  cred: { accessToken, refreshToken, expiresAt /*ms*/, scopes, subscriptionType, rateLimitTier,
          refreshTokenExpiresAt? /*ms: fim do login; ausente = desconhecido*/ },
  gen: 1,                       // sobe a cada token novo (renovação ou login novo)
  loginWarnedOn: null | "AAAA-MM-DD",   // último dia (fuso do servidor) em que avisou "o login vence"
  dead: null | { reason: "relogin_required", at },
  disabled: false, threshold: null, priority: 0,   // + weeklyThreshold, modelThreshold (ausente = null = regra geral)
  usage: null | Usage, usageFetchedAt: null, usageError: null,
  lastGoodUsage: null | Usage, lastGoodAt: null,
  nextPollAt: 0, pollBackoffUntil: 0, refreshBackoffUntil: 0, refreshFailures: 0,
  addedAt, lastRefreshAt: null,
}
Usage = { fiveHour?: { pct, resetsAt }, sevenDay?: { pct, resetsAt }, scoped?: [ { name, pct, resetsAt } ] }
Device = { id, name, platform, googleEmail: "e-mail"|null /*null = pareado por código*/, tokenHash, createdAt, lastSeen, assigned: n|null, lastSwitchAt: 0, models: [],
           lastSwitchBy /* "assign" | "auto" | "limit" | "manual" | "painel" | "group" | "follow" | "renew" (só o motor lê) */,
           held? /* { number, gen }: o último acesso que o serviço buscou (2.5.5); ausente = ainda não buscou nenhum */,
           heldBefore? /* { number, gen, until }: a conta de antes, ainda segurada até `until` (3 min depois da busca) */ }
// lastSeen = criação, último batimento (heartbeat) ou último limite batido: é o uso, e só ele diz quem está ativo.
// O contato de cada serviço (presença, 2.5.3) fica só na memória do motor: nada de `contacts`, `lastContact`,
// `connected` ou `presence` entra no cofre.
```

## anthropic.js

```js
createAnthropic({ tokenUrl, apiBase, fetchImpl = fetch }) → {
  refresh(cred)  → { ok: true, cred } | { ok: false, error: "invalid_grant"|"invalid_client"|"transient", status }
  usage(accessToken) → { ok: true, usage: Usage } | { ok: false, error: "unauthorized"|"rate_limited"|"transient"|"bad_response", status, retryAfterSec }
  profile(accessToken) → { uuid, email, orgUuid } | null
}
```
- refresh: `POST tokenUrl` JSON `{grant_type:"refresh_token", refresh_token, client_id:"9d1c250a-e61b-44d9-88ed-5944d1962f5e"}`,
  headers `Content-Type: application/json`, `User-Agent: swap-plus-server/2.0`. Resposta: `access_token`, `expires_in` (s),
  `refresh_token` (novo, pode faltar → manter o antigo), `scope` (string separada por espaço → `scopes`).
  `expiresAt = agora + expires_in*1000`. Erro 400/401/403 com corpo JSON `error` ∈ {invalid_grant, invalid_client} → esse erro; resto → transient.
  `refreshTokenExpiresAt` (fim do login; renovar o acesso não muda) vem do `cred` recebido e nunca é apagado; só é recalculado
  (`agora + refresh_token_expires_in*1000`) se a resposta trouxer `refresh_token_expires_in` numérico > 0 (número ou número em texto).
  Vale também para o `cred` da falha "refresh token novo sem access token".
- usage: `GET {apiBase}/api/oauth/usage`, headers `Authorization: Bearer`, `anthropic-beta: oauth-2025-04-20`.
  Normalizar: `five_hour`/`seven_day` = `{utilization, resets_at}` (podem faltar ou ser null; utilization pode ser null) →
  `fiveHour/sevenDay = {pct: utilization, resetsAt: resets_at}`; `limits[]` com `scope.model.display_name` e `percent` numérico →
  `scoped: [{name, pct: percent, resetsAt: resets_at}]`. 401 → unauthorized, 429 → rate_limited (+ Retry-After), resto → transient/bad_response.
- profile: `GET {apiBase}/api/oauth/profile` → `account.uuid`, `account.email_address`, `organization.uuid`.
- timeout 15 s em tudo (AbortSignal.timeout).

## engine.js

```js
class Engine {
  constructor({ store, anthropic, now = Date.now, log = console, env = process.env, isAdminEmail = null, notify = null })
                                        // notify: fn({ subject, text }) dos avisos ao dono (notify.js); null = sem avisos
                                        // o endereço do painel nos avisos vem de env.PUBLIC_URL
  setAdminCheck(fn)                     // fn(email) → bool: quem é administrador (o server.js passa o de ADMIN_EMAILS no createApp)
  canUploadLogins(device)               // pode enviar logins? googleEmail nulo (código) ou fn(googleEmail) === true
  start(); stop()                       // tick a cada 15 s (setInterval com unref)
  async tick()                          // 1) renovações  2) uma leitura de uso (se o orçamento deixar)  3) decisões por dispositivo
  rulesEffective()                      // { ...RULE_DEFAULTS, ...state.rules }
  publicList(deviceId)                  // { schemaVersion: 1, activeAccountNumber, accounts: PublicAccount[] }
  records()                             // { "<n>": { disabled, threshold, weeklyThreshold, modelThreshold, priority, alias } } (linhas próprias: null = regra geral; linesFor)
  stateFor(deviceId)                    // StateResponse (abaixo)
  devicesList(currentId = null)         // os serviços, para mostrar (StateResponse.devices e PanelState): + current, active e a presença
  touch(deviceId)                       // presença: o serviço fez um pedido autenticado (qualquer rota); só na memória, não suja o cofre
  forgetContact(deviceId)               // serviço revogado ou desfeito: o contato dele sai da memória
  async heartbeat(deviceId, { models, live })   // lastSeen/models; sem conta → atribui; roda a decisão desse dispositivo
  async credentialFor(deviceId)         // { number, gen, claudeAiOauth: {accessToken, expiresAt, scopes, subscriptionType, rateLimitTier, refreshTokenExpiresAt?}, oauthAccount } | null
  async switchDevice(deviceId, number|null, by = "manual")  // null = melhor conta; "together": troca o grupo inteiro
  async limitHit(deviceId, label)       // decide com limitHit; { switched, text }; "together": troca o grupo inteiro na hora
  async addLogin({ claudeAiOauth, oauthAccount, plan, deviceId?, number? })   // { number, created } ou lança Error com .code
  async updateAccount(number, patch)    // disabled/threshold/weeklyThreshold/modelThreshold (50–100 ou null)/priority/alias
  async setLoginExpiresAt(number, ms)   // preenche cred.refreshTokenExpiresAt à mão → { number, loginExpiresAt (ISO) }; erros not_found / invalid
  async removeAccount(number)
  async setRules({ rules, autoSwitch })
  pushHistory(kind, text, deviceId)
}
```
PublicAccount (mesmo formato do `swap-plus list --json` que a extensão já lê):
`{ number, email, organizationName, organizationUuid, plan: {label}|null, alias, active, disabled, usageStatus, usage, usageAgeSeconds, lastGoodUsage, lastGoodAgeSeconds, dead: bool, loginExpiresAt, accessExpiresAt, assignedDevices: [nome] }`
- `usageStatus`: `"relogin_required"` se dead; `"ok"` se `usage` lido e sem erro depois; `"unavailable"` se a última leitura falhou (mantém `lastGoodUsage`); `"unknown"` sem leitura.
- `usage` só quando status ok. Idades em segundos a partir de `usageFetchedAt` / `lastGoodAt`.
- `loginExpiresAt`: ISO de `cred.refreshTokenExpiresAt` (quando o login acaba de vez; só um `/login` novo resolve) ou `null` = desconhecido.
- `accessExpiresAt`: ISO de `cred.expiresAt` (o access token atual; o servidor renova sozinho). `null` só se não houver data válida
  (ex.: `expiresAt` 0 depois de uma renovação incompleta).

Fim do login (`refreshTokenExpiresAt`, epoch ms, gravado pelo Claude Code dentro de `claudeAiOauth`; logins antigos não têm):
- `addLogin` guarda o do login recebido (número finito > 0; em segundos vira ms; inválido = desconhecido) e mantém depois da renovação
  feita na hora. Todas as renovações seguintes mantêm, a não ser que a resposta traga `refresh_token_expires_in`. Login novo da conta troca
  pela data do login novo (sem o campo → desconhecido).
- `credentialFor` entrega em `claudeAiOauth.refreshTokenExpiresAt` (não é segredo; o Claude Code usa para avisar "sign-in ends").
  Desconhecido → a chave não vai (nem `null`).
- Aviso: a cada ciclo, conta viva com a data conhecida e menos de 3 dias para ela → no máximo 1x por dia (fuso do servidor) por conta,
  histórico `kind:"alert"` "O login da conta N (apelido ou começo do e-mail) vence DD/MM HH:MM — entre de novo com ela no Claude Code
  de qualquer serviço conectado." (`venceu` se a data já passou). O dia avisado fica em `loginWarnedOn` (zera com login novo ou data nova).
- `stateFor().warnings` (calculado na hora): `{ kind: "dead", account: N, text }` para contas mortas e
  `{ kind: "login_expiring", account: N, text }` (mesmo texto do histórico) enquanto faltar menos de 3 dias.
- E-mail ao dono (abaixo): não acompanha mais o alerta diário. Sai UM por login, quando falta menos de 1 dia
  (`NOTICE_LOGIN_DAYS`) para ele vencer; o vencimento já avisado fica em `acc.loginMailedFor` (data nova → avisa de novo).
  Antes disso quem avisa é o resumo semanal. Aviso que não gravou é tentado de novo em 10 min.
- `setLoginExpiresAt(number, ms)`: para contas enviadas antes de o servidor guardar a data. `ms` = epoch em ms (número ou número em texto)
  depois de "agora - 1 dia" e até 5 anos à frente, senão `invalid`; conta inexistente → `not_found`. Muda `cred.refreshTokenExpiresAt` no lugar,
  sob a trava da conta; grava o cofre; histórico "Validade do login da conta N preenchida".

Renovação (passo 1): para cada conta viva com refreshToken, se `expiresAt - agora < REFRESH_AHEAD_MIN` e fora do backoff:
mutex por conta → `anthropic.refresh` → **grava o cofre antes de qualquer outra coisa** (`await store.save()`), `gen++`, `lastRefreshAt`.
`invalid_grant` → `dead = {reason:"relogin_required", at}` + histórico. transient → backoff 1, 2, 5, 10, 10… min.
Diagnóstico único: na 1ª renovação bem-sucedida com `diag.oldTokenValidAfterRefresh` indefinido, testar o access token ANTIGO no endpoint de uso
(conta no orçamento) e gravar true/false + log ("acesso antigo continua valendo depois de renovar: sim/não").
Se o token tiver vencido mesmo assim (servidor parado), renovar antes de usar.

Renovação da conta em uso (desde a 2.5.5). O diagnóstico acima deu **não** em 15/11/2026: a Anthropic cancela o acesso antigo
no instante da renovação, e o serviço que está com ele só busca o novo no contato seguinte (a extensão, em até 30 s; o cliente
parado, em até ~2 min). Nesse intervalo toda chamada dele ao Claude falha com `401 OAuth access token has been revoked` e o
Claude Code encerra a conversa depois de duas tentativas (21/11/2026 09:53: buraco de 19 s, três conversas paradas; o mesmo em
16/11 09:51). Troca de conta não tem esse buraco: o acesso da conta antiga continua valendo até o serviço gravar a nova.
- **Quem segura a conta** (`holders(acc)`): os serviços **por perto** (`around`: presença ≠ `"none"` — ativo, conectado ou
  aguardando contato depois de um reinício — ou último contato há no máximo 15 min, `HOLD_CONTACT_MS`: um cliente que pausa
  5 a 10 min depois de um 403/429 some da tela e continua com o acesso na mão) cujo `held` é
  `{ number: acc.number, gen: acc.gen }`. `held` é gravado em toda entrega de credencial (`credentialFor` → `deliver`) e vai
  para o cofre **na hora** (não no ciclo seguinte: uma queda nesses segundos deixaria o motor novo sem saber quem segura o quê).
  Serviço trocado de conta que ainda não buscou a nova continua segurando a antiga; e, **por 3 min depois de buscar a nova**
  (`heldBefore: { number, gen, until }`, `HELD_GRACE_MS`), segura as duas: buscar não prova que gravou (a gravação local pode
  falhar e só é tentada de novo em 1 min). Serviço sem contato há mais de 15 min (desligado) não segura nada — ao voltar, o
  primeiro contato dele busca o acesso novo.
  `start()` chama `adoptHeld()`: serviço sem `held` (conectado antes da 2.5.5) e atribuído a uma conta viva ganha o da conta dele.
- Conta que ninguém segura: renova como acima, quando faltam menos de `REFRESH_AHEAD_MIN` (120 min).
- Conta que alguém segura, com `ahead` = a antecedência dela (`aheadMs`):
  - faltando mais de `ahead/2` (60 min): **espera** (o log diz uma vez por acesso: "conta N: adiada, X está com o acesso
    dela"). Numa troca comum os serviços saem dela sozinhos, e ela renova no ciclo seguinte à busca do último;
  - faltando menos de `ahead/2`: o `drainStep` (começo do passo 3, só com `autoSwitch`) **tira os serviços dela**. No modo
    `"together"`, se ela é a conta do grupo, o grupo inteiro vai junto, como numa troca automática (`lastSwitchBy = "auto"`,
    histórico "Serviços trocados juntos para a conta Y: o login da conta N vai ser renovado — A e B"). Os outros presentes
    nela (os parados, quem segue sozinho, cada um no modo `"separate"`) saem um a um, para a conta do grupo se puderem usá-la,
    senão para a melhor deles ("Trocou da conta N para a conta Y: o login da conta N vai ser renovado"; quem sai um a um
    fica com `lastSwitchBy = "renew"`, que não define a conta do grupo). Até renovar, a conta N **não é destino de troca**
    (`engine.leaving`, só na memória; `recordsFor`/`sharedRecords` a marcam `disabled` para as escolhas);
  - faltando `min(30 min, ahead/4)` (o piso; 30 min é o mínimo que o `credentialFor` entrega): **renova assim mesmo**, com o
    buraco de sempre, e o log avisa ("faltam N min para o acesso vencer e X ainda está com ele; renovo assim mesmo").
- Destino da troca para renovar (`renewTarget`): `bestAccountFor` com `requireOk` (abaixo das linhas, com margem; no modo
  `"separate"`, só conta livre), entre as contas com leitura de uso de até 1 h (`CAND_STALE_SEC`) e com o acesso longe de
  vencer — primeiro as que têm `2 × ahead` (4 h) pela frente, depois as que só não estão na vez de renovar.
- **Ou saem todos, ou ninguém.** Se um só dos serviços por perto ficaria na conta (o grupo sem destino, ou um serviço que só
  pode usar esta conta — "Serviços permitidos"), ninguém é trocado e a conta não é marcada em `leaving`: ela continuaria
  segurada de qualquer jeito e ficaria fora dos destinos à toa. Renova no piso.
- Limites conhecidos (aceitos na 2.5.5): no caminho do piso a folga contra uma falha da Anthropic ao renovar é de 30 min
  (era de 120; no caminho normal, com troca, fica perto de 60); `credentialFor` chamado no meio da renovação da mesma conta
  pode entregar o acesso que acabou de ser cancelado (janela de menos de 1 s, já existia).
- `refreshRetry` (renovação sem resposta) e a renovação por 401 na leitura de uso não esperam ninguém: nas duas o acesso
  antigo já pode ter sido cancelado.

Uso (passo 2): orçamento `USAGE_MAX_PER_HOUR` (balde que recarrega continuamente e guarda no máximo 6 leituras, ou o
orçamento de 1 hora se ele for menor que 6). Uma leitura por ciclo, nesta ordem:
1. conta marcada para ler logo (limite batido, login novo);
2. conta em uso (atribuída a dispositivo ativo, visto nos últimos 5 min) que está na vez;
3. as outras contas que estão na vez.

Em cada grupo, a mais atrasada primeiro. Piso das outras: depois de 2 leituras seguidas de contas em uso, a seguinte é
de outra conta, se alguma estiver na vez (as marcadas para ler logo não entram nessa contagem).

Quando a conta entra na vez, contado da última leitura dela:
- conta em uso perto de uma linha de troca, ou ainda sem leitura: 2,5 min. "Perto" é a até 15 pontos abaixo da linha da
  sessão, ou a até 5 abaixo da linha semanal ou da do modelo (a do modelo só com `onModelLimit: "switchAccount"`);
- conta em uso longe das linhas, ou com uma linha já passada: 10 min;
- as outras: 20 min; mortas nunca.

O balde e a contagem das leituras seguidas ficam só na memória (recomeçam quando o servidor reinicia); nada disso vai
para o cofre. Até a 2.5.3 a regra era "conta em uso a cada 3 min, as outras a cada 20, a mais atrasada primeiro": com 23
contas tudo ficava atrasado e a conta em uso só era lida a cada 42 min (medido em 21/11/2026). 401 → renovar e tentar de novo uma vez;
429 → pausa global pelo Retry-After (mín. 10 min); outros erros → backoff por conta 2, 5, 10 min.

Decisão (passo 3), por dispositivo ativo e com `autoSwitch`:
- sem conta, ou conta morta/desativada/removida → atribuir a melhor (abaixo) e registrar no histórico.
- senão `decide()` do `rules.js` com `list = publicList(deviceId)` (activeAccountNumber = conta do dispositivo),
  `records` = records() + contas de **outros dispositivos ativos** marcadas `disabled: true` (para não dividirem a sessão de 5h),
  `r = rulesEffective()`, `modelIds = device.models`, `now`, `lastSwitchAt = device.lastSwitchAt`.
  Se `kind === "blocked"`, tentar de novo sem bloquear as contas dos outros (dividir é melhor que parar).
- `switch` → `device.assigned = to`, `lastSwitchAt = agora`, histórico `kind:"switch"` com o texto do decide.
Melhor conta (atribuição inicial / `switchDevice(null)`): vivas, não desativadas, com uso conhecido, não usadas por outro dispositivo ativo;
estratégia `max` → menor `sevenDay.resetsAt` com ≥ 20% sobrando e abaixo das linhas (com margem); senão mais folga
(`min(linha - pct)` entre sessão e semanal). Sem uso conhecido → a viva de menor número. Ninguém livre → permitir as de outros dispositivos.
`autoSwitch === false` → só a atribuição inicial; `limitHit` só registra.

Regra **Serviços** (`rules.devicePlacement`, só do servidor; `decide()` não usa; até a 2.5.2 a tela e o histórico diziam
"Computadores"): `"separate"` (padrão) = o que está acima (cada serviço ativo numa conta; contas dos outros ocupadas;
`spreadOut` separa quem caiu na mesma conta). `"together"` = todos os ativos na MESMA conta e trocando juntos (gastam a
mesma sessão de 5 h). `setRules` aceita só esses dois valores (senão `invalid_rules`);
quando a regra muda, vale na hora (decide todos os ativos) e o histórico registra "Serviços juntos: ..." / "Serviços separados: ...".
No modo `"together"` nenhuma conta fica ocupada e não há `spreadOut`; uma decisão para o grupo inteiro (`togetherStep`, a cada ciclo e
em todo `decideDevice`):
- **Conta do grupo**, entre os ativos: a do que trocou por último (`lastSwitchBy` ∈ auto, limit, manual, painel, group — a atribuição
  `"assign"` não conta), se ela ainda serve para ele (existe, viva, liberada para ele e, com a troca automática ligada, na rotação);
  empate: a conta com mais ativos nela. Senão a melhor conta (`bestAccountFor`, mesma estratégia), primeiro entre as que todos podem usar.
- **Troca**: `decide()` para a conta do grupo com os modelos em uso de TODOS os serviços do grupo (união), intervalo mínimo contado da
  última troca de qualquer um deles e destino entre as contas que todos podem usar (sem nenhuma: as liberadas para o serviço da conta
  do grupo). Se trocar, todos os ativos que podem usar a conta nova vão para ela: histórico `kind:"switch"`, `device: null`,
  "Serviços trocados juntos para a conta N: <motivo> — A e B" (um só trocando: o texto de sempre, "Trocou da conta X para a conta N: ...").
- Sem troca: quem pode usar a conta do grupo e está em outra entra nela ("Trocou da conta X para a conta N: serviços juntos na mesma
  conta"; sem conta: "Conta N atribuída a ..."); com a troca automática desligada, só quem precisa de conta (sem conta, morta, removida,
  não liberada).
- Quem **não pode** usar a conta do grupo (`accountDevices`) nunca vai para ela: segue sozinho — a melhor conta liberada para ele, com o
  seu próprio `decide()`.
- `limitHit`: `decide()` com o limite para a conta do serviço (com os ativos nela) e todos os ativos que podem usar a conta nova
  trocam na hora: "Serviços trocados juntos na hora para a conta N: a conta X bateu o ... — A e B" (`device` = quem bateu).
- `switchDevice`: troca o grupo inteiro (os ativos + este) para a conta escolhida; quem não pode usá-la fica. Histórico
  "Serviços trocados juntos para a conta N: troca manual pelo painel" / "pelo serviço X" (+ " (melhor conta)"); quem pediu fica com
  `lastSwitchBy` = by, os outros `"group"`. Só este trocando: o texto de sempre ("Troca manual da conta X para a conta N").
- Serviço que conecta ou volta a ficar ativo (heartbeat depois de mais de 5 min sem batimento) entra na conta do grupo dos outros ativos:
  a troca antiga dele deixa de valer para escolher a conta do grupo (`lastSwitchBy = "follow"`).
- `assignBest` (sem conta, morta, removida, não liberada, desativada): a conta do grupo dos outros ativos, se puder usá-la; senão a melhor
  liberada para ele.

Presença dos serviços (desde a 2.5.3; **para mostrar** — painel e `StateResponse.devices` — e, desde a 2.5.5, para saber quem
segura cada conta na hora de renovar (`holders`, acima); nenhuma decisão de troca por uso a consulta):
- Por quê: `lastSeen` só sobe no batimento (`heartbeat`) e no limite batido (`limitHit`), e é ele que diz quem está **ativo**
  (`isActive`: `lastSeen` há no máximo `ACTIVE_MS` = 5 min). O cliente sem VS Code (`cliente/`, o do Hermes), quando está sem uso,
  não manda batimento: só lê `GET /v1/state` a cada ~2 min, o que não mexe no `lastSeen`. Até a 2.5.2 a tela o mostrava como
  "parado", embora ligado.
- **Contato** = um pedido autenticado, de qualquer rota. O server.js chama `engine.touch(deviceId)` no único ponto em que o token do
  dispositivo é aceito (abaixo, "API"). `touch` guarda `agora` em `engine.contacts` (Map `deviceId → ms`), **só na memória**: não
  escreve no registro do serviço (o `lastSeen` fica como estava), não marca `dirty` e nunca vai para o cofre nem para o disco. Id que
  não é de um serviço do cofre é ignorado (o mapa não cresce). `forgetContact(deviceId)` apaga a entrada: o server.js chama quando o
  serviço é revogado ou desfeito.
- Constantes: `CONTACT_MS = ACTIVE_MS` (5 min; exportada). `engine.startedAt` = a hora em que este processo subiu.
- Cada item de `devicesList()` ganha três campos (`presenceOf(dev)` → `{ lastContact, connected, presence }`):
  - `lastContact`: ms ou `null` — o mais novo entre o contato da memória e o `lastSeen` (`lastContactOf`); `null` = nunca apareceu.
  - `connected`: `true` se `lastContact` não é `null` e `agora - lastContact <= CONTACT_MS`.
  - `presence`, o primeiro que valer:
    - `"active"`: `isActive` (a definição de sempre);
    - `"connected"`: não está ativo e `connected` é `true`;
    - `"waiting"`: nem ativo nem conectado, sem contato desde que este processo subiu (`lastContact` é `null` ou anterior a
      `startedAt`) e o processo subiu há menos de `CONTACT_MS`. É passageiro: um reinício ou uma atualização apaga os contatos da
      memória, e um serviço ocioso só volta a aparecer no próximo pedido dele (o cliente sem uso lê o estado a cada ~2 min);
      enquanto isso ele não é dado como sumido;
    - `"none"`: o resto.
- Depois de um reinício o `lastContact` recomeça do `lastSeen` do cofre. Passados `CONTACT_MS` da subida ninguém mais fica em
  `"waiting"`: quem ainda não chamou passa a `"none"`.
- O que **não** muda: `isActive`, `heartbeat`, `limitHit` e todas as decisões (contas ocupadas, "Serviços: Juntos",
  `setAccountDevices`) continuam olhando só o `lastSeen`. Um serviço só conectado não ocupa conta, não entra no grupo, não recebe
  conta pelo contato (isso é do batimento e do `credentialFor`) e não conta em `status().activeDevices`.
- `GET /v1/devices`, `GET /admin/devices` e `GET /admin/status` não levam esses campos (lista fechada do server.js, abaixo): o
  "visto …" da CLI (`status`, `devices`) continua sendo o `lastSeen`, ou seja, o último batimento, não o último contato.
- Compatibilidade: são campos a mais em `StateResponse.devices`. A extensão (`plus/`, que copia só os campos que conhece) e o
  cliente sem VS Code (`cliente/`, que não lê `devices`) não mudaram por causa disso. O painel mostra a presença (WEB-SPEC.md, "2.5.3").

addLogin: com `deviceId` de um serviço que não pode enviar logins (`canUploadLogins` false) → `not_admin` (403) antes de tudo:
não confere, não renova, não fala com a Anthropic (o server.js já recusa antes; esta é a segunda trava).
Exige `claudeAiOauth.refreshToken` e `oauthAccount.emailAddress`. Só aceita login **comprovadamente vivo**:
- refresh token já gasto pelo servidor (`spentRefresh`) → `stale_login`; o mesmo refresh token que a conta já guarda → nada a fazer.
- se o access token enviado ainda vale, confere a identidade com `profile()` ANTES de gastar o login (errada → `identity_mismatch`, nada gasto).
- **sempre** renova o login recebido na hora (com o refresh token dele): `invalid_grant`/`no_refresh_token` → `dead_login`;
  falha temporária → `refresh_failed`. Nos dois casos nada muda (o login antigo da conta, se existir, fica).
- confere a identidade do token RENOVADO com `profile()` (falhando, a identidade que veio na renovação): e-mail (sem diferenciar
  maiúsculas) e, se vier, organização têm de bater com o `oauthAccount` (senão `identity_mismatch`; sem como conferir → aceita com aviso no log).
- conta existente (e-mail + `organizationUuid`) → troca `cred` pelo token RENOVADO, `oauthAccount`, `dead = null`, `gen++`, `lastRefreshAt`,
  e o refresh token enviado entra em `spentRefresh`; senão cria com `nextNumber++` (gen 1). `plan.label` do corpo, ou de `subscriptionType`
  (team→Team, max→Max, pro→Pro, enterprise→Enterprise). Grava o cofre. Histórico "Login da conta N recebido".
- o cliente nunca mais usa o refresh token que enviou (o servidor gastou): depois de `POST /v1/logins` grava a credencial do servidor por cima.

## Avisos por e-mail ao dono (notify.js)

O servidor só **escreve um arquivo por aviso** em `DATA_DIR/avisos/` (no host: `/opt/swap-plus/data/avisos/`). Um processo do
host (fora do container) lê essa pasta a cada minuto e entrega ao Painel do Servidor, que manda o e-mail ao dono. Nada aqui usa
rede nem senha. `NOTICES_ENABLED=0` desliga (nada é gravado, nem a pasta é criada).

```js
writeNotice(dir /* DATA_DIR */, { subject, text }, { env, now, log }?)  // → { ok: true, id, file } | { ok: false, skipped: "disabled" } | { ok: false, error }
createNotifier({ dir, env, now, log }) → notify({ subject, text })    // + notify.enabled, notify.dir; o server.js passa ao motor
```
- Mesmo formato e limites do comando `servidor-aviso` do servidor: arquivo `aviso-<AAAAMMDD-HHMMSS>-<8 hex>.json` (hora local, `TZ`)
  com `{"id","assunto","texto","criado_em"}` (`criado_em` = epoch em **segundos**, inteiro), JSON compacto em UTF-8; `id` casa com
  `^aviso-[A-Za-z0-9_-]{14,74}$`. Assunto em 1 linha, até 120 caracteres; texto até 2.000; sem caracteres de controle (no texto só a
  quebra de linha); passou do limite → corta com "…". Assunto vazio → nada gravado.
- Atômico: temporário `.<id>.tmp` (O_EXCL, 0600) + rename na mesma pasta. Pasta criada com 0700. Limpeza a cada aviso: avisos com
  mais de 48 h e o que passar de 500 arquivos (só `aviso-*.json`), e temporários esquecidos há mais de 1 h.
- **Nunca lança**: erro (disco cheio, pasta sem permissão…) só vai para o log `[avisos]`.

Gatilhos no motor (sem `notify`, nenhum; o texto diz a conta — número, apelido, e-mail — e como renovar):
- **Resumo semanal** (`weeklyStep`, desde a 2.5.0): uma vez a cada horário marcado (`NOTICE_WEEKLY_DAY`/`NOTICE_WEEKLY_HOUR`,
  padrão segunda às 8h, fuso do servidor). Lista as contas vivas cujo login vence nos 7 dias seguintes (a que vence antes
  primeiro), as que já pararam de valer e as sem data conhecida. Sem conta vencendo o resumo sai assim mesmo
  (`Swap Plus: nenhuma conta vence nesta semana`). O instante do último fica no cofre (`state.weeklyNoticeAt`): reiniciar
  não repete, e servidor parado na hora manda ao voltar. Na primeira subida com este recurso só começa a contar (o
  primeiro resumo sai no próximo horário marcado). Assunto com conta: `Swap Plus: N contas vencem nesta semana`
  (com uma só: `Swap Plus: 1 conta vence nesta semana (conta N, DD/MM HH:MM)`). `NOTICE_WEEKLY=0` desliga.
  À mão: `POST /admin/weekly-notice` (CLI `resumo`; `{ preview: true }` / `resumo ver` só mostra o texto) — não mexe na
  marca do resumo automático.
- **Login que vence em menos de 1 dia** (`NOTICE_LOGIN_DAYS`): UM aviso por login (`loginMailedFor`), no ciclo em que a
  conta entra nesse prazo. O alerta do histórico e do painel continua desde 3 dias antes, 1x por dia, sem e-mail.
  Assunto `Swap Plus: login da conta N vence DD/MM HH:MM` (`venceu`, se já passou).
- **Conta que morre** (passa a `dead`, `markDead`): 1 na hora. Assunto `Swap Plus: o login da conta N parou de valer`; o texto traz o
  motivo e, com `dead.cause === "no_response"`, que "a renovação anterior ficou sem resposta".
- **Cofre sem gravar** (`saveFailed` passa a true): 1 por incidente (acaba quando o cofre volta a gravar), no máximo 1 por hora se o
  cofre ficar indo e voltando. "NÃO reinicie o servidor: há login renovado só na memória" + veja o disco. Se o próprio aviso não
  grava (o disco cheio pega a caixa de saída também), tenta de novo a cada minuto enquanto o incidente durar.
- "Como renovar": `Para renovar: abra <PUBLIC_URL> → Contas → conta N → Entrar de novo, e entre com <e-mail da conta> na página da
  Claude; copie o código e cole no painel. (Ou faça /login no Claude Code de um serviço do administrador.)`
- `engine.status().notices = { enabled, dir }` (o `GET /admin/status` do admin local mostra o mesmo em `notices`).

## API (server.js)

HTTPS (`TLS_MODE=self`, cert em `DATA_DIR/tls/cert.pem` + `key.pem`) ou HTTP (`off`). JSON, corpo máx. 256 KB.
Autenticação: `Authorization: Bearer <token do dispositivo>`; guardado como sha256 hex; comparação com `timingSafeEqual`.
`ALLOW_IPS` checado antes de tudo (403). Limite de tentativas: 20 respostas 401 por IP em 10 min → 429 por 10 min.
Contato (presença, desde a 2.5.3): em toda rota com token, assim que o token é aceito — antes de ler o corpo e de chamar a rota — o
servidor chama `engine.touch(device.id)`, uma vez por pedido, seja qual for a rota e dê ela certo ou não depois (400, 409, 422…).
Pedido de IP fora de `ALLOW_IPS` (403), de IP bloqueado (429), para rota ou método que não existe (404/405) ou sem token válido
(401) é barrado antes e não conta. As rotas sem token (`/v1/health`, `/v1/pair`, `/v1/login/*`, `/auth/google/*`), o admin local e
o painel (`/web/*`, que usa cookie) também não contam. Onde um serviço é apagado — revogação, o serviço órfão do login com Google e o desfazer do retorno do
Google quando o cofre não grava, todos por `forgetDevice` — o servidor chama `engine.forgetContact(id)`. As duas chamadas só
acontecem se o motor tiver o método (`typeof … === "function"`). O que o motor faz com isso: "Presença dos serviços", acima.

| método e caminho | corpo | resposta |
|---|---|---|
| `GET /v1/health` (sem auth) | — | `{ ok: true, version }` |
| `POST /v1/pair` (sem auth) | `{ code, name, platform }` | `{ deviceId, token }` — código de uso único, 10 min, 5 erros descartam o código |
| `POST /v1/heartbeat` | `{ models: [id], live: { email, orgUuid, expiresAt } \| null }` | StateResponse |
| `GET /v1/state` | — | StateResponse |
| `GET /v1/credential` | — | `{ number, gen, claudeAiOauth: { accessToken, expiresAt, scopes, subscriptionType, rateLimitTier, refreshTokenExpiresAt? }, oauthAccount }` (nunca `refreshToken`) ou 409 `{error:"no_account"}` |
| `POST /v1/logins` | `{ claudeAiOauth, oauthAccount, plan? }` | `{ number, created }` ou 422 `{error: code, message}`; serviço que não é do administrador → 403 `not_admin` (abaixo) |
| `POST /v1/switch` | `{ number \| null }` | StateResponse |
| `POST /v1/events` | `{ kind: "limit_hit", label }` | `{ switched, text, state }` |
| `PATCH /v1/accounts/:n` | `{ disabled?, threshold?, weeklyThreshold?, modelThreshold?, priority?, alias? }` (linhas: 50–100 ou null = regra geral) | StateResponse |
| `DELETE /v1/accounts/:n` | — | StateResponse |
| `PUT /v1/rules` | `{ rules?, autoSwitch? }` | StateResponse |
| `GET /v1/devices` | — | `[ { id, name, platform, googleEmail, createdAt, lastSeen, assigned, current } ]` |
| `DELETE /v1/devices/:id` | — | `{ ok: true }` |
| `POST /v1/login/start` (sem auth) | `{ name, platform }` | `{ sessionId, pollToken, authUrl, expiresAt }` |
| `POST /v1/login/poll` (sem auth) | `{ sessionId, pollToken }` | `{ status: "pending" }` \| `{ status: "ok", deviceId, token }` (uma vez) \| `{ status: "denied", email }` \| 404 `expired` |
| `GET /auth/google/start?s=<id>` (navegador) | — | 302 para o Google (ou página HTML de erro) |
| `GET /auth/google/callback?code&state` (navegador) | — | página HTML (pronto / conta não liberada / erro) |

### Login com Google ("login de dispositivo")

O VS Code não recebe o retorno do navegador; por isso ele inicia, abre `authUrl` no navegador e consulta o resultado.
- `start`: sessão **em memória** (reiniciar o servidor desfaz logins em andamento): `id` 16 bytes base64url, `pollToken` 32 bytes
  (só o sha256 fica), `state` 16 bytes, PKCE `code_verifier`; vale 10 min; máx. 50 sessões vivas (429 `too_many_logins`).
  `authUrl = PUBLIC_URL + "/auth/google/start?s=" + id`.
- `/auth/google/start`: 302 para `GOOGLE_AUTH_URL` com `client_id`, `redirect_uri`, `response_type=code`, `scope=openid email`, `state`,
  `code_challenge` (S256), `code_challenge_method=S256`, `prompt=select_account`.
- `/auth/google/callback`: acha a sessão pelo `state`; troca o `code` (form-urlencoded: code, client_id, client_secret, redirect_uri,
  grant_type=authorization_code, code_verifier); confere o `id_token` (veio direto do Google por TLS, sem validar assinatura — OIDC 3.1.3.7):
  `iss` ∈ {accounts.google.com, https://accounts.google.com}, `aud` contém o client id (e `azp`, se vier, é o client id), `exp` no futuro,
  `email_verified` true. E-mail do administrador (`ADMIN_EMAILS`) ou em `allowedEmails` (comparação pela `emailKey`: minúsculas e,
  no Gmail, sem pontos e sem `+algo`) → cria o dispositivo (como no pareamento, com `googleEmail`), grava o cofre, histórico
  `Serviço "X" conectado com a conta Google Y`, página "Pronto! Conectado." (o texto não cita programa: a extensão e o cliente sem VS Code entram por aqui). Não liberado → página de recusa e `poll` → `denied`.
  `error` na query, troca recusada ou id_token inválido → página de erro e a sessão continua `pending` (dá para tentar de novo pelo mesmo link).
  Recarregar o retorno depois de concluído mostra o mesmo resultado sem falar com o Google.
- Depois do retorno do Google a sessão vale pelo menos mais 5 min. Se vencer com o serviço criado e o VS Code não buscou o acesso,
  o dispositivo é desfeito (ninguém tem o token dele).
- A mesma conta Google pode conectar vários serviços (cada um é um dispositivo separado, revogável sozinho). `deny` não derruba
  quem já conectou.
- Desligado (sem client id/secret ou sem `PUBLIC_URL`): `/v1/login/*` → 503 `{ error: "google_off" }`; `/auth/google/*` → página 503.
- Limite por IP (janela de 10 min) → 429 com `Retry-After`: `login/start` 10, `login/poll` 600, `/auth/google/start` 30, `/auth/google/callback` 30.
- Páginas: HTML sem JS, tema escuro, tudo escapado; cabeçalhos `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'`,
  `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`. Nunca vão para log: code, tokens, id_token, client_secret
  (o log das requisições só tem o caminho, sem a query).

### Quem envia logins (só os serviços do administrador)

Um serviço **pode enviar logins** (`canUploadLogins`) se: conectou com Google e o `googleEmail` é de administrador (`ADMIN_EMAILS`,
comparação pela `emailKey`, a mesma do painel), **ou** foi pareado por código (`googleEmail` nulo — o código só sai pela linha de comando
ou pelo painel, que são do administrador). Os outros (contas Google liberadas com `allow`) usam as contas do servidor.
- `StateResponse.device.canUploadLogins: true|false` (GET `/v1/state`, heartbeat, troca, etc.). Quem decide é o server.js com o
  `ADMIN_EMAILS` desta subida (e passa o mesmo `isAdmin` ao motor em `engine.setAdminCheck`).
- `POST /v1/logins` de quem não pode → 403 `{ error: "not_admin", message: "Só os serviços do administrador enviam logins ao servidor.
  Este serviço usa as contas do servidor." }`, conferido antes do corpo e **sem chamar** `engine.addLogin` (nada vai para a Anthropic;
  o login enviado não é gasto). Não conta como tentativa sem autorização (não bloqueia o IP). Log `[logins] login recusado de "X" (conta
  Google Y)...` a cada recusa (sem token) e histórico `kind:"alert"` "Login recusado de "X": só o administrador envia logins" no máximo
  uma vez por serviço por dia (fuso do servidor; lembrado só na memória).
- O administrador saiu de `ADMIN_EMAILS` (mudança + reinício): os serviços dele conectados com Google passam a `canUploadLogins: false`
  (continuam conectados, usando as contas do servidor). Sem `ADMIN_EMAILS`, só os pareados por código enviam.

StateResponse:
```js
{ serverTime, version,
  device: { id, name, assigned, lastSwitchAt, canUploadLogins },
  list: { schemaVersion: 1, activeAccountNumber, accounts: PublicAccount[] },
  records, rules, autoSwitch,
  credential: { number, gen, expiresAt } | null,
  history: [ { ts, kind, text, device } ],   // últimos 40
  devices: [ { id, name, platform, googleEmail, createdAt, lastSeen, assigned, current, active,
               lastContact, connected, presence } ],   // engine.devicesList; os três últimos: presença, desde a 2.5.3
  diag,
  warnings: [ { kind: "dead" | "login_expiring", account: n, text } ] }
```
Erros: `{ error, message }` com status adequado. Nada de stack trace na resposta.

Admin local (HTTP em `127.0.0.1:ADMIN_PORT`, só dentro do container, sem auth):
`POST /admin/pair-code` → `{ code, expiresAt, connect }`; `GET /admin/status` (inclui `google` e `notices: { enabled, dir }`); `GET /admin/devices`; `DELETE /admin/devices/:id`;
`GET /admin/allowed` → `{ enabled, offReason, callbackUrl, adminEmails, allowedEmails, pendingLogins }`;
`POST /admin/allow { email }` → `{ ok, email, added, admin, google }` (o administrador não entra na lista: `added: false, admin: true`);
`POST /admin/deny { email }` → `{ ok, email, removed, devices: [{id, name}], panelSessions, google }`; e-mail do administrador → 409 `{ error: "admin" }`.
Código de pareamento: 10 caracteres de `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`. **Código de conexão** (o que a pessoa cola no VS Code):
`swapplus1:` + base64url(JSON `{ url: PUBLIC_URL, code, fp }`), `fp` = sha256 do certificado (formato do Node `X509Certificate.fingerprint256`) quando `TLS_MODE=self`, senão `null`.
CLI: `node server/src/cli.js pair|status|devices|revoke <id>|allow <email>|deny <email>|allowed|login-expires <n> <data>` (imprime em
português; `status` e `allowed` mostram o(s) administrador(es) de `ADMIN_EMAILS`, ou que o painel está desligado).

## Docker

`server/Dockerfile`: `node:22-alpine`, `apk add --no-cache openssl tini`, copia `plus/rules.js` → `/app/plus/rules.js` e `server/src` → `/app/server/src`,
`USER node`, `ENTRYPOINT ["/sbin/tini","--","/app/server/entrypoint.sh"]`, `HEALTHCHECK` via `node -e` no `/v1/health` do admin local.
`entrypoint.sh`: se `TLS_MODE=self` e não houver certificado, gera (EC prime256v1, 3650 dias, CN swap-plus, SAN `IP:`/`DNS:` de `PUBLIC_HOST`);
imprime a impressão digital; `exec node /app/server/src/server.js`.
Encerramento (SIGTERM/SIGINT): fecha as portas, espera `engine.stop()` por até 52 s, grava o cofre (se falhar, tenta de novo por
até 5 s; `BUSY` = outro dono da trava, não insiste) e sai; saída forçada em 62 s. Compose: `stop_grace_period: 75s`.

## Cliente (extensão, `plus/`)

> **3.0 (15/11/2026): a extensão é só modo servidor.** O que esta seção diz sobre `swapPlus.mode`, modo local,
> `executablePath`, motor `swap-plus`, envio dos logins guardados pelo motor ("Enviar os logins deste computador") e
> oferta de regras locais não vale mais: tudo isso saiu. Continuam valendo o batimento, a aplicação da credencial, o
> envio do login atual (só serviços do administrador, `canUploadLogins`), `tokenOrigin` e o resto do contrato. O
> `POST /v1/logins` usa 90 s de tempo máximo no cliente.
>
> **3.2.0 (21/11/2026): a tela de Configurações mostra só este VS Code.** A tela (webview "Swap Plus — Configurações"; o
> comando `swapPlus.openSettings` passou de "Configurar trocas automáticas" para "Configurações") ficou com: o liga/desliga
> do Swap Plus neste VS Code; o cartão **Conexão** (até a 3.1.3, "Servidor": situação, "Entrar com Google", "Colar código",
> "Outro endereço…", "Sair", os avisos deste VS Code e "Usar a conta do servidor"); **Conta em uso aqui**, com "Trocar de
> conta" ("Usar esta conta" → `POST /v1/switch`) e a troca automática só como leitura; e, em "Mais opções deste VS Code",
> os avisos (`swapPlus.alerts.*`), a exibição e as atualizações. Saíram da tela o liga/desliga da troca automática, as
> regras, os ajustes por conta, "+ Adicionar conta", a lista de dispositivos com revogar e o histórico: isso fica no painel
> web (botão "Abrir o painel"). Mensagens novas da tela: `saveAlerts { alerts }` (grava só as configurações deste VS Code,
> sem pedido ao servidor) e `openPanel` (abre no navegador o endereço guardado na conexão). O resto não mudou: ciclo,
> gravação da credencial, envio de login, fila, janela dona, conectar e desconectar. Os tratadores que a tela não usa mais
> (`setAuto`, `saveRules`, `account`, `add`, `revokeDevice`) continuam na extensão, e o comando "Ligar/desligar troca
> automática" da paleta continua valendo (`PUT /v1/rules`).

Configurações: `swapPlus.mode` (`"local"` | `"server"`, padrão `"local"`), `swapPlus.server.url`. As duas, e também `swapPlus.enabled`
e `swapPlus.executablePath`, têm `"scope": "machine"` (só valem nas configurações do usuário: o `settings.json` de um projeto aberto não
escolhe servidor, modo nem executável). A extensão declara `capabilities.untrustedWorkspaces.supported: false` (não roda em pasta não confiável).
Segredos: token do dispositivo em `context.secrets` (`swapPlus.server.token`); `url` (onde o token foi emitido), `fp`, `deviceId` em `globalState`.
Comandos: `swapPlus.connectServer` ("Conectar ao servidor": entrar com Google ou colar o código de conexão), `swapPlus.disconnectServer`.
"Entrar com Google" (servidor com `PUBLIC_URL` atrás de TLS de verdade, `fp: null`): `POST /v1/login/start` → abrir `authUrl` no navegador →
`POST /v1/login/poll` a cada ~2 s até `ok` (guardar `deviceId`/`token` como no pareamento), `denied` (mostrar o e-mail — no modo privado
não), 404 `expired` ou `expiresAt`; 503 `google_off` → oferecer o código de conexão; 429 → esperar o `Retry-After`. `pollToken` e `token`
nunca vão para log. Cancelou e o servidor criou o acesso mesmo assim → revoga esse acesso (com `tokenOrigin` = o endereço do login).

`plus/serverClient.js`: `createServerClient({ url, token, fp, tokenOrigin, timeoutMs })` → `{ request(method, path, body), url, fp, origin }`
com `https`/`http` do Node, timeout 15 s (ou `timeoutMs`); `http://` só para localhost (`bad_url`); se `fp` existe, aceita só o certificado
com essa impressão digital; sem `fp`, validação normal. **O token só vale no endereço em que foi emitido:** quem passa `token` passa
`tokenOrigin` (o `url` guardado na conexão); origem diferente da de `url` → `origin_mismatch`, sem nenhum envio. `originOf(url)` exportado.

`plus/claudeAuth.js` (credencial do Claude Code, Mac/Windows/Linux):
- `readLive()` → `null` (não há login) | `{ claudeAiOauth, raw, source }` | lança `live_unreadable` (com `.reason`) quando não consegue ler
  (Keychain trancado sem arquivo reserva, JSON quebrado, erro de arquivo). macOS: Keychain `"Claude Code-credentials"` (com sufixo quando
  `CLAUDE_CONFIG_DIR` está definida) e, sem item, o arquivo; demais: `<configHome>/.credentials.json`. `configHome = CLAUDE_CONFIG_DIR || ~/.claude`.
- `writeLive(claudeAiOauth, { canReplace, dropTrustedDevice })` → mescla só a chave `claudeAiOauth` (preserva `mcpOAuth` etc.); **sempre tira
  o `refreshToken`** (nunca grava `refreshToken: ""`); recusa `accessToken` vazio e `expiresAt` ≤ agora (`bad_credential`). Tudo sob as travas
  do Claude Code (`<configHome>/.oauth_refresh.lock`, a legada `<configHome>.lock` e, em volta da gravação, `.storage-write.lock`).
  `canReplace(atual)`: compare-and-swap — sob a trava relê a credencial; se o login atual tem `refreshToken` e `canReplace` não devolve `true`
  → `live_changed`; leitura falhou → `live_unreadable`. `dropTrustedDevice: true` tira também `trustedDeviceToken` e
  `trustedDeviceEnrolledAfterRefusalAtMs` (são da conta). macOS: só pelo stdin do `security -i` (o segredo nunca vai nos argumentos).
- `writeOauthAccount(oauthAccount)` → `~/.claude.json` com a trava `~/.claude.json.lock`: lê, troca só `oauthAccount`, grava atômico.
- `liveIdentity()` → `{ email, orgUuid } | null` (do `oauthAccount` do `~/.claude.json`).
- `credentialStoreWarnings()` → `string[]` (síncrona): `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` definidas, ou Windows lendo o login do
  Gerenciador de Credenciais (`CLAUDE_CODE_FORCE_WINDOWS_CREDMAN=1` ou recurso `tengu_windows_credman`).
- `withClaudeCredentialLocks(fn)` → roda `fn` sob as travas do login (o `writeLive` lá dentro não trava de novo).

Modo servidor na extensão:
- **Endereço do token:** conectado, o endereço usado é SEMPRE o `url` guardado na conexão (`tokenOrigin` em todo `createServerClient`,
  inclusive na revogação do acesso órfão e na chave do cache do cliente). Endereço das configurações do usuário com outra origem, `origin_mismatch`
  ou token sem `url` guardado → status *desconectado: o endereço mudou, conecte de novo*, sem nenhuma chamada. Revogar este serviço
  (reconectar/desconectar) vai para o servidor que emitiu o token.
- **Fila única:** ciclo (batimento + gravação), troca manual, limite batido e "usar a conta do servidor" rodam um de cada vez. Desligar o Swap
  Plus, voltar ao modo local e desconectar seguram o ciclo e esperam o que estiver em andamento; antes de cada `writeLive` a extensão confere
  de novo que está ligada e no modo servidor.
- **Janela dona:** com várias janelas do VS Code, uma só (trava em arquivo no temporário, por usuário e pasta do Claude Code, renovada a cada
  10 s e a cada ciclo; velha depois de 25 s) faz o batimento, envia login novo e grava; as outras só fazem `GET /v1/state`. Uma ação da pessoa
  (troca, limite, usar a conta do servidor) faz a janela dela assumir.
- A cada 30 s (e logo depois de qualquer ação): `POST /v1/heartbeat` com modelos em uso (`detectModels`) e identidade/validade do login atual.
- Se `credential.gen` mudou, ou a conta logada não é a atribuída, ou a validade do login atual difere da do servidor → `GET /v1/credential`
  → `writeLive(acesso, { canReplace, dropTrustedDevice })` + `writeOauthAccount`. `canReplace` só aceita substituir um login com refresh token
  se ele já foi enviado, recusado como morto/gasto ou descartado pela pessoa (hash do refresh token; o token nunca é guardado).
  `live_changed`/`live_unreadable` → pula este ciclo, sem aviso. `dropTrustedDevice: true` quando a conta gravada não é a do login atual.
  O `applied` é salvo logo depois do `writeLive`; erro no `writeOauthAccount` é avisado uma vez e não faz regravar a cada minuto.
  Falha de gravação: espera 1 min (a troca manual não espera). Troca manual e limite só dizem "agora na conta N"/"Trocou" se gravaram.
- `readLive` que falhou (`live_unreadable`): nada é enviado nem gravado e o estado "login recusado" fica como estava.
- Serviço com `state.device.canUploadLogins: false` não envia logins (o servidor responderia 403 `not_admin`): usa as contas do servidor.
- Se o login atual tem `refreshToken` (login novo no navegador) → `POST /v1/logins` (timeout 45 s) com ele e o `oauthAccount`, sob uma trava
  entre janelas por login (`mkdir`; existe = outra janela enviando), e em seguida grava a credencial do servidor por cima. Respostas 422:
  `dead_login`/`stale_login` → login gasto, grava a do servidor; `refresh_failed`/`profile_unavailable` → tenta de novo em ~1 min, sem aviso;
  outro motivo (`identity_mismatch`...) → não grava por cima, avisa e tenta de novo em 10 min. Enviado mas sem como gravar a credencial do
  servidor (409 `no_account`, falha de gravação) → tira só o `refreshToken` do login atual (sob a trava, se ainda for o mesmo), para o Claude
  Code não renová-lo e matar a cópia do servidor.
- **Tela de login do Claude Code:** enquanto o modo servidor está ligado (ligado + conectado), `claudeCode.disableLoginPrompt: true` nas
  configurações globais do VS Code (sem refresh token, um 401 abriria a tela de login); o valor anterior fica no `globalState` e volta ao sair
  do modo servidor, desligar ou desconectar. Aviso uma vez: "Enquanto estiver no modo servidor, o login do Claude Code é feito pelo Swap Plus".
- `credentialStoreWarnings()` aparece no cartão Conexão (até a 3.1.3, "Servidor") e na barra. Windows lendo do Gerenciador de Credenciais →
  não grava (a gravação seria ignorada) e explica.
- Ao conectar pela 1ª vez a um servidor: oferecer "Enviar os logins deste computador" (só no modo servidor; no modo local é recusado):
  `swap-plus export` para um temporário → cada conta com refreshToken vai em `POST /v1/logins` (plan do `swap-plus list --json`) → apaga o
  temporário. Mostrar quantas foram aceitas/recusadas e por quê. E, se as regras de troca daqui (`swapPlus.rules.*` e
  `swapPlus.autoSwitch.enabled`) diferem das do servidor, oferecer "Usar as regras deste computador no servidor" → `PUT /v1/rules
  { rules, autoSwitch }` (uma vez por servidor).
- Erro de limite nas transcrições → `POST /v1/events {kind:"limit_hit"}`. Troca manual pela lista → `POST /v1/switch`.
- Barra, lista e tela usam `list`/`records`/`rules`/`history` do servidor (mesmo formato de hoje) — só no modo servidor; no modo local a lista
  é sempre a do motor daqui. Histórico: serviço que saiu da lista aparece pelo `deviceName` da entrada. Tela ganha: dispositivos (com revogar)
  e o modo (local/servidor). Regras, troca automática (`srv.state.autoSwitch`) e ajustes por conta vão para o servidor (`PUT /v1/rules`,
  `PATCH /v1/accounts/:n`). Desde a 3.2.0 a tela não mostra mais o histórico, os dispositivos, as regras nem os ajustes por conta (nota
  "3.2.0", no alto desta seção): tudo isso se vê e se muda no painel web.
- No modo servidor a extensão **nunca** chama o motor local (`swap-plus`) exceto o `list`/`export` da migração; o atualizador também não
  consulta nem oferece o motor.
- Swap Plus desligado (1.9): sem heartbeat, sem nenhuma chamada ao servidor e sem gravar credencial.
