# Swap Plus Servidor — especificação (2.0)

Fonte única para quem implementa o servidor (`server/`) e o modo servidor da extensão (`plus/`).
Tudo em português (código, comentários, mensagens). Node 22, **sem dependências de terceiros**.
**Nunca registrar em log nem devolver ao cliente o `refreshToken`.** Access tokens também nunca vão para log.

## Por que existe

O refresh token de cada conta Claude é de uso único (renovar invalida o anterior; o acesso dura ~8 h).
Com a mesma cópia do login em dois computadores, o que renova primeiro mata a cópia do outro.
O servidor (VPS, Docker) é o **único** que guarda o refresh token e renova. Os computadores (clientes)
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
server/src/cli.js          CLI de admin (fala com o admin local em 127.0.0.1)
server/test/*.test.js      testes com node:test e uma Anthropic de mentira (rodam no servidor)
server/Dockerfile          contexto de build = raiz do repo
server/entrypoint.sh
```
Na imagem: `/app/plus/rules.js` e `/app/server/src/*.js` → `require("../../plus/rules")` funciona nos dois lugares.

## Variáveis de ambiente (servidor)

| var | padrão | |
|---|---|---|
| `DATA_DIR` | `/data` | cofre `store.enc`, `tls/` |
| `MASTER_KEY_FILE` | `/run/secrets/swap_plus_master_key` | 64 hex (32 bytes) |
| `PORT` | `8443` | API |
| `ADMIN_PORT` | `8444` | só `127.0.0.1` dentro do container |
| `TLS_MODE` | `self` | `self` = HTTPS com certificado próprio (cliente fixa a impressão digital); `off` = HTTP puro atrás de proxy (Traefik) que faz o TLS |
| `PUBLIC_URL` | — | URL que os clientes usam (vai no código de conexão) |
| `PUBLIC_HOST` | — | IP/host para o SAN do certificado próprio |
| `TRUST_PROXY` | `0` | `1` = usar o 1º IP de `X-Forwarded-For` (só atrás do proxy) |
| `ALLOW_IPS` | vazio | lista de IPs/CIDR IPv4 aceitos na API (vazio = todos) |
| `USAGE_MAX_PER_HOUR` | `24` | orçamento de consultas ao endpoint de uso (a Anthropic aceita ~30/h) |
| `REFRESH_AHEAD_MIN` | `120` | renova quando faltam menos que isso para o access token vencer |
| `ANTHROPIC_TOKEN_URL` | `https://platform.claude.com/v1/oauth/token` | trocável nos testes |
| `ANTHROPIC_API_BASE` | `https://api.anthropic.com` | trocável nos testes |
| `GOOGLE_CLIENT_ID_FILE` | `/run/secrets/google_client_id` | lido na subida; faltando → login com Google desligado |
| `GOOGLE_CLIENT_SECRET_FILE` | `/run/secrets/google_client_secret` | idem (nunca vai para log nem resposta) |
| `GOOGLE_AUTH_URL` | `https://accounts.google.com/o/oauth2/v2/auth` | trocável nos testes |
| `GOOGLE_TOKEN_URL` | `https://oauth2.googleapis.com/token` | trocável nos testes |
| `TZ` | `America/Sao_Paulo` | textos "hoje 18:00" do `rules.js` |
| `ADMIN_EMAILS` | — | administrador(es) do painel web, separados por vírgula (produção: o e-mail do administrador, variável `SWAP_PLUS_ADMIN_EMAILS` da stack). Lido só na subida, sem rota para mudar. Vazio → painel desligado (aviso no log). Detalhes em WEB-SPEC.md |
| `RESTIC_PASS_FILE` | `/run/secrets/restic_swap_plus_pass` | senha do backup, só para o kit de recuperação do painel (opcional: sem o arquivo, "não disponível") |

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
  allowedEmails: [ "pessoa@empresa.com" ],          // contas Google que podem conectar computadores (minúsculas); não dão painel
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
           lastSwitchBy /* "assign" | "auto" | "limit" | "manual" | "painel" | "group" | "follow" (só o motor lê) */ }
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
  constructor({ store, anthropic, now = Date.now, log = console, env = process.env })
  start(); stop()                       // tick a cada 15 s (setInterval com unref)
  async tick()                          // 1) renovações  2) uma leitura de uso (se o orçamento deixar)  3) decisões por dispositivo
  rulesEffective()                      // { ...RULE_DEFAULTS, ...state.rules }
  publicList(deviceId)                  // { schemaVersion: 1, activeAccountNumber, accounts: PublicAccount[] }
  records()                             // { "<n>": { disabled, threshold, weeklyThreshold, modelThreshold, priority, alias } } (linhas próprias: null = regra geral; linesFor)
  stateFor(deviceId)                    // StateResponse (abaixo)
  async heartbeat(deviceId, { models, live })   // lastSeen/models; sem conta → atribui; roda a decisão desse dispositivo
  async credentialFor(deviceId)         // { number, gen, claudeAiOauth: {accessToken, expiresAt, scopes, subscriptionType, rateLimitTier, refreshTokenExpiresAt?}, oauthAccount } | null
  async switchDevice(deviceId, number|null, by = "manual")  // null = melhor conta; "together": troca o grupo inteiro
  async limitHit(deviceId, label)       // decide com limitHit; { switched, text }; "together": troca o grupo inteiro na hora
  async addLogin({ claudeAiOauth, oauthAccount, plan })   // { number, created } ou lança Error com .code
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
  de qualquer computador conectado." (`venceu` se a data já passou). O dia avisado fica em `loginWarnedOn` (zera com login novo ou data nova).
- `stateFor().warnings` (calculado na hora): `{ kind: "dead", account: N, text }` para contas mortas e
  `{ kind: "login_expiring", account: N, text }` (mesmo texto do histórico) enquanto faltar menos de 3 dias.
- `setLoginExpiresAt(number, ms)`: para contas enviadas antes de o servidor guardar a data. `ms` = epoch em ms (número ou número em texto)
  depois de "agora - 1 dia" e até 5 anos à frente, senão `invalid`; conta inexistente → `not_found`. Muda `cred.refreshTokenExpiresAt` no lugar,
  sob a trava da conta; grava o cofre; histórico "Validade do login da conta N preenchida".

Renovação (passo 1): para cada conta viva com refreshToken, se `expiresAt - agora < REFRESH_AHEAD_MIN` e fora do backoff:
mutex por conta → `anthropic.refresh` → **grava o cofre antes de qualquer outra coisa** (`await store.save()`), `gen++`, `lastRefreshAt`.
`invalid_grant` → `dead = {reason:"relogin_required", at}` + histórico. transient → backoff 1, 2, 5, 10, 10… min.
Diagnóstico único: na 1ª renovação bem-sucedida com `diag.oldTokenValidAfterRefresh` indefinido, testar o access token ANTIGO no endpoint de uso
(conta no orçamento) e gravar true/false + log ("acesso antigo continua valendo depois de renovar: sim/não").
Se o token tiver vencido mesmo assim (servidor parado), renovar antes de usar.

Uso (passo 2): orçamento `USAGE_MAX_PER_HOUR` (balde que recarrega continuamente). Contas atribuídas a dispositivos ativos
(visto nos últimos 5 min) a cada 3 min; as outras a cada 20 min; mortas nunca. Escolhe a mais atrasada. 401 → renovar e tentar de novo uma vez;
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

Regra **Computadores** (`rules.devicePlacement`, só do servidor; `decide()` não usa): `"separate"` (padrão) = o que está acima
(cada computador ativo numa conta; contas dos outros ocupadas; `spreadOut` separa quem caiu na mesma conta). `"together"` = todos os
ativos na MESMA conta e trocando juntos (gastam a mesma sessão de 5 h). `setRules` aceita só esses dois valores (senão `invalid_rules`);
quando a regra muda, vale na hora (decide todos os ativos) e o histórico registra "Computadores juntos: ..." / "Computadores separados: ...".
No modo `"together"` nenhuma conta fica ocupada e não há `spreadOut`; uma decisão para o grupo inteiro (`togetherStep`, a cada ciclo e
em todo `decideDevice`):
- **Conta do grupo**, entre os ativos: a do que trocou por último (`lastSwitchBy` ∈ auto, limit, manual, painel, group — a atribuição
  `"assign"` não conta), se ela ainda serve para ele (existe, viva, liberada para ele e, com a troca automática ligada, na rotação);
  empate: a conta com mais ativos nela. Senão a melhor conta (`bestAccountFor`, mesma estratégia), primeiro entre as que todos podem usar.
- **Troca**: `decide()` para a conta do grupo com os modelos em uso de TODOS os computadores do grupo (união), intervalo mínimo contado da
  última troca de qualquer um deles e destino entre as contas que todos podem usar (sem nenhuma: as liberadas para o computador da conta
  do grupo). Se trocar, todos os ativos que podem usar a conta nova vão para ela: histórico `kind:"switch"`, `device: null`,
  "Computadores trocados juntos para a conta N: <motivo> — A e B" (um só trocando: o texto de sempre, "Trocou da conta X para a conta N: ...").
- Sem troca: quem pode usar a conta do grupo e está em outra entra nela ("Trocou da conta X para a conta N: computadores juntos na mesma
  conta"; sem conta: "Conta N atribuída a ..."); com a troca automática desligada, só quem precisa de conta (sem conta, morta, removida,
  não liberada).
- Quem **não pode** usar a conta do grupo (`accountDevices`) nunca vai para ela: segue sozinho — a melhor conta liberada para ele, com o
  seu próprio `decide()`.
- `limitHit`: `decide()` com o limite para a conta do computador (com os ativos nela) e todos os ativos que podem usar a conta nova
  trocam na hora: "Computadores trocados juntos na hora para a conta N: a conta X bateu o ... — A e B" (`device` = quem bateu).
- `switchDevice`: troca o grupo inteiro (os ativos + este) para a conta escolhida; quem não pode usá-la fica. Histórico
  "Computadores trocados juntos para a conta N: troca manual pelo painel" / "pelo computador X" (+ " (melhor conta)"); quem pediu fica com
  `lastSwitchBy` = by, os outros `"group"`. Só este trocando: o texto de sempre ("Troca manual da conta X para a conta N").
- Computador que conecta ou volta a ficar ativo (heartbeat depois de mais de 5 min parado) entra na conta do grupo dos outros ativos:
  a troca antiga dele deixa de valer para escolher a conta do grupo (`lastSwitchBy = "follow"`).
- `assignBest` (sem conta, morta, removida, não liberada, desativada): a conta do grupo dos outros ativos, se puder usá-la; senão a melhor
  liberada para ele.

addLogin: exige `claudeAiOauth.refreshToken` e `oauthAccount.emailAddress`. Só aceita login **comprovadamente vivo**:
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

## API (server.js)

HTTPS (`TLS_MODE=self`, cert em `DATA_DIR/tls/cert.pem` + `key.pem`) ou HTTP (`off`). JSON, corpo máx. 256 KB.
Autenticação: `Authorization: Bearer <token do dispositivo>`; guardado como sha256 hex; comparação com `timingSafeEqual`.
`ALLOW_IPS` checado antes de tudo (403). Limite de tentativas: 20 respostas 401 por IP em 10 min → 429 por 10 min.

| método e caminho | corpo | resposta |
|---|---|---|
| `GET /v1/health` (sem auth) | — | `{ ok: true, version }` |
| `POST /v1/pair` (sem auth) | `{ code, name, platform }` | `{ deviceId, token }` — código de uso único, 10 min, 5 erros descartam o código |
| `POST /v1/heartbeat` | `{ models: [id], live: { email, orgUuid, expiresAt } \| null }` | StateResponse |
| `GET /v1/state` | — | StateResponse |
| `GET /v1/credential` | — | `{ number, gen, claudeAiOauth: { accessToken, expiresAt, scopes, subscriptionType, rateLimitTier, refreshTokenExpiresAt? }, oauthAccount }` (nunca `refreshToken`) ou 409 `{error:"no_account"}` |
| `POST /v1/logins` | `{ claudeAiOauth, oauthAccount, plan? }` | `{ number, created }` ou 422 `{error: code, message}` |
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
  "Computador X conectado com a conta Google Y", página "Pronto! Pode voltar ao VS Code.". Não liberado → página de recusa e `poll` → `denied`.
  `error` na query, troca recusada ou id_token inválido → página de erro e a sessão continua `pending` (dá para tentar de novo pelo mesmo link).
  Recarregar o retorno depois de concluído mostra o mesmo resultado sem falar com o Google.
- Depois do retorno do Google a sessão vale pelo menos mais 5 min. Se vencer com o computador criado e o VS Code não buscou o acesso,
  o dispositivo é desfeito (ninguém tem o token dele).
- A mesma conta Google pode conectar vários computadores (cada um é um dispositivo separado, revogável sozinho). `deny` não derruba
  quem já conectou.
- Desligado (sem client id/secret ou sem `PUBLIC_URL`): `/v1/login/*` → 503 `{ error: "google_off" }`; `/auth/google/*` → página 503.
- Limite por IP (janela de 10 min) → 429 com `Retry-After`: `login/start` 10, `login/poll` 600, `/auth/google/start` 30, `/auth/google/callback` 30.
- Páginas: HTML sem JS, tema escuro, tudo escapado; cabeçalhos `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'`,
  `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`. Nunca vão para log: code, tokens, id_token, client_secret
  (o log das requisições só tem o caminho, sem a query).

StateResponse:
```js
{ serverTime, version,
  device: { id, name, assigned, lastSwitchAt },
  list: { schemaVersion: 1, activeAccountNumber, accounts: PublicAccount[] },
  records, rules, autoSwitch,
  credential: { number, gen, expiresAt } | null,
  history: [ { ts, kind, text, device } ],   // últimos 40
  devices: [ { id, name, assigned, lastSeen, current } ],
  diag,
  warnings: [ { kind: "dead" | "login_expiring", account: n, text } ] }
```
Erros: `{ error, message }` com status adequado. Nada de stack trace na resposta.

Admin local (HTTP em `127.0.0.1:ADMIN_PORT`, só dentro do container, sem auth):
`POST /admin/pair-code` → `{ code, expiresAt, connect }`; `GET /admin/status` (inclui `google`); `GET /admin/devices`; `DELETE /admin/devices/:id`;
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
Encerramento (SIGTERM/SIGINT): fecha as portas, espera `engine.stop()` por até 40 s, grava o cofre (se falhar, tenta de novo por
até 5 s; `BUSY` = outro dono da trava, não insiste) e sai; saída forçada em 50 s. Compose: `stop_grace_period: 60s`.

## Cliente (extensão, `plus/`)

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
  ou token sem `url` guardado → status *desconectado: o endereço mudou, conecte de novo*, sem nenhuma chamada. Revogar este computador
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
- Se o login atual tem `refreshToken` (login novo no navegador) → `POST /v1/logins` (timeout 45 s) com ele e o `oauthAccount`, sob uma trava
  entre janelas por login (`mkdir`; existe = outra janela enviando), e em seguida grava a credencial do servidor por cima. Respostas 422:
  `dead_login`/`stale_login` → login gasto, grava a do servidor; `refresh_failed`/`profile_unavailable` → tenta de novo em ~1 min, sem aviso;
  outro motivo (`identity_mismatch`...) → não grava por cima, avisa e tenta de novo em 10 min. Enviado mas sem como gravar a credencial do
  servidor (409 `no_account`, falha de gravação) → tira só o `refreshToken` do login atual (sob a trava, se ainda for o mesmo), para o Claude
  Code não renová-lo e matar a cópia do servidor.
- **Tela de login do Claude Code:** enquanto o modo servidor está ligado (ligado + conectado), `claudeCode.disableLoginPrompt: true` nas
  configurações globais do VS Code (sem refresh token, um 401 abriria a tela de login); o valor anterior fica no `globalState` e volta ao sair
  do modo servidor, desligar ou desconectar. Aviso uma vez: "Enquanto estiver no modo servidor, o login do Claude Code é feito pelo Swap Plus".
- `credentialStoreWarnings()` aparece no cartão Servidor e na barra. Windows lendo do Gerenciador de Credenciais → não grava (a gravação seria
  ignorada) e explica.
- Ao conectar pela 1ª vez a um servidor: oferecer "Enviar os logins deste computador" (só no modo servidor; no modo local é recusado):
  `swap-plus export` para um temporário → cada conta com refreshToken vai em `POST /v1/logins` (plan do `swap-plus list --json`) → apaga o
  temporário. Mostrar quantas foram aceitas/recusadas e por quê. E, se as regras de troca daqui (`swapPlus.rules.*` e
  `swapPlus.autoSwitch.enabled`) diferem das do servidor, oferecer "Usar as regras deste computador no servidor" → `PUT /v1/rules
  { rules, autoSwitch }` (uma vez por servidor).
- Erro de limite nas transcrições → `POST /v1/events {kind:"limit_hit"}`. Troca manual pela lista → `POST /v1/switch`.
- Barra, lista e tela usam `list`/`records`/`rules`/`history` do servidor (mesmo formato de hoje) — só no modo servidor; no modo local a lista
  é sempre a do motor daqui. Histórico: computador que saiu da lista aparece pelo `deviceName` da entrada. Tela ganha: dispositivos (com revogar)
  e o modo (local/servidor). Regras, troca automática (`srv.state.autoSwitch`) e ajustes por conta vão para o servidor (`PUT /v1/rules`,
  `PATCH /v1/accounts/:n`).
- No modo servidor a extensão **nunca** chama o motor local (`swap-plus`) exceto o `list`/`export` da migração; o atualizador também não
  consulta nem oferece o motor.
- Swap Plus desligado (1.9): sem heartbeat, sem nenhuma chamada ao servidor e sem gravar credencial.
