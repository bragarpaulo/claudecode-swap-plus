# Painel web do Swap Plus Servidor — especificação (2.1)

Painel em `https://swap.assistentes.si/` (mesma origem da API), em português, para o Paulo configurar tudo pelo
navegador (o VS Code só obedece). Login com Google, **só do administrador** (`ADMIN_EMAILS`, abaixo). As contas Google
liberadas (`state.allowedEmails`) só conectam serviços pelo VS Code: não entram no painel.
Sem dependências de terceiros; sem CDN (CSP só `'self'`). Node 22. Atrás de Caddy + Cloudflare (`TLS_MODE=off`,
`TRUST_PROXY=1`, `PUBLIC_URL=https://swap.assistentes.si`).

Vocabulário (desde a 2.5.3; ver "2.5.3", no fim): tudo o que se conecta ao Swap — um VS Code, o cliente do Hermes, um robô — é
um **serviço**. "Computador" é só a máquina em que a pessoa está sentada. Os ids, os endereços e os nomes de campo não mudaram
(`#computadores`, `?next=computadores`, `devices`).

## Arquivos

```
server/src/web.js        rotas do painel (sessão por cookie, CSRF, /web/api/*, arquivos estáticos)
server/web/index.html    página única (SPA)
server/web/app.js        lógica da tela (JS puro, sem bibliotecas)
server/web/app.css       estilo (tema escuro e claro por prefers-color-scheme; celular e computador)
server/test/web.test.js  testes (node:test) — rodam no servidor
```
Imagem: `server/web/` vai para `/app/server/web/` (Dockerfile + .dockerignore).

## Administrador (`ADMIN_EMAILS`)

- Variável de ambiente, lista separada por vírgula (espaço e `;` também servem). Produção: no compose,
  `ADMIN_EMAILS: ${SWAP_PLUS_ADMIN_EMAILS:?...}` — o e-mail do administrador (variável `SWAP_PLUS_ADMIN_EMAILS` da stack,
  só no Portainer, no servidor; o repositório é público e não tem o e-mail). Regra do dono: o administrador tem acesso
  total e só ele entra no painel.
- Lida **só na subida**: não há rota no painel nem na API (nem no admin local) para mudar (ninguém se promove e o dono
  não se tranca fora). Mudar = editar o compose e reiniciar.
- Sem `ADMIN_EMAILS` (ou só com entradas que não são e-mail): **painel desligado** — `GET /` e `GET /web/login` mostram a
  página "Painel desligado" (503) explicando o que definir; `/web/api/*` → 503 `{ error: "panel_off" }`; aviso no log na
  subida. Entrada que não é e-mail é ignorada com aviso no log (não derruba o servidor, que renova os logins).
- O administrador também conecta serviços (login "device" com Google) **sem precisar estar** na lista de liberadas.
- Comparação de e-mail (`emailKey`, google.js) em todo lugar que compara: administrador, lista (liberar, tirar,
  repetidos), login do painel, login dos serviços e derrubar sessões no `deny`. Minúsculas; em `gmail.com` /
  `googlemail.com` a parte local perde os pontos e o `+algo` e o domínio vira `gmail.com`
  (`Dono.Exemplo+x@googlemail.com` = `donoexemplo@gmail.com`). Outros domínios: só minúsculas. O e-mail é guardado e
  mostrado como veio (aparado, em minúsculas).

## Login no painel (Google)

- `GET /web/login` → cria uma sessão de login do Google do tipo **web** (mesmo cliente OAuth "Claude Swap", mesmo
  retorno `PUBLIC_URL/auth/google/callback`, PKCE + state) e redireciona ao Google. O callback já existente
  (`server/src/google.js`) distingue o tipo pela sessão do `state`: tipo `device` = fluxo atual dos serviços;
  tipo `web` = cria a sessão do painel.
- Sessão do painel: token de 32 bytes (base64url) no cookie `sp_sess` (`Path=/; HttpOnly; Secure; SameSite=Lax;
  Max-Age=2592000`); no cofre guarda só o sha256 em `state.webSessions[id] = { tokenHash, email, createdAt, lastSeen,
  expiresAt (30 dias), ua (resumo do User-Agent), ip }`. **Só o administrador** ganha sessão:
  - conta liberada (na lista) que não é administrador → página 403 "Esta conta pode conectar serviços, mas o painel
    é só do administrador." (com "Entrar com outra conta");
  - conta fora de tudo → página 403 "não liberada".
- A cada pedido do painel o e-mail da sessão precisa continuar administrador (pela `emailKey`): se `ADMIN_EMAILS` mudar
  (reinício), as sessões de quem saiu respondem 401 e saem do cofre (e a limpeza periódica também as tira).
- `GET /web/login?next=<aba>` (opcional; só `geral|computadores|regras|acesso|historico`): depois de entrar volta para
  `/#<aba>` (o kit de recuperação usa `?next=acesso`). Qualquer outro valor é ignorado (volta para `/`).
- `POST /web/logout` → apaga a sessão e o cookie.
- CSRF: todo método que muda algo exige `Origin` igual à origem de `PUBLIC_URL` **e** cabeçalho `X-CSRF-Token`
  igual ao `csrf` da sessão (aleatório, guardado na sessão, entregue por `/web/api/me`).
- Limites por IP: `/web/login` 20/10 min; respostas 401 do painel 60/10 min.
- Páginas: `Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:;
  connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`, `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`. API: `Cache-Control: no-store`.

## Rotas

| rota | o que faz |
|---|---|
| `GET /` | `web/index.html` (sem sessão a própria página mostra a tela de login com o botão "Entrar com Google") |
| `GET /static/app.js`, `/static/app.css` | arquivos do painel |
| `GET /web/login`, `POST /web/logout` | acima |
| `GET /web/api/me` | `{ email, admin: true, csrf, expiresAt }` ou 401 |
| `GET /web/api/state` | PanelState (abaixo) |
| `PUT /web/api/rules` | `{ rules?, autoSwitch? }` → `engine.setRules` |
| `PATCH /web/api/accounts/:n` | `{ disabled?, threshold?, weeklyThreshold?, modelThreshold?, priority?, alias? }` → `engine.updateAccount` (linhas: 50–100 ou null) |
| `DELETE /web/api/accounts/:n` | `engine.removeAccount` (a tela pede confirmação) |
| `POST /web/api/devices/:id/switch` | `{ number \| null }` → `engine.switchDevice(id, number, "painel")` |
| `DELETE /web/api/devices/:id` | revoga o serviço |
| `POST /web/api/allowed` / `DELETE /web/api/allowed/:email` | libera / tira conta Google **para conectar serviços** (não dá painel). Repetido pela `emailKey` não entra de novo. Liberar o administrador não faz nada (`{ added: false, admin: true }`); tirar o administrador → **409** `{ error: "admin" }` (ele não depende da lista) |
| `POST /web/api/pair-code` | `{ code, connect, expiresAt }` (código de conexão de reserva) |
| `GET /web/api/sessions` / `DELETE /web/api/sessions/:id` | sessões do painel abertas (qual navegador, quando) |
| `GET /web/api/recovery-kit` | kit de recuperação (abaixo); exige também `X-CSRF-Token` |

Erros: `{ error, message }` em português. Nunca devolver token, refresh token, hash de token nem segredo (a única
exceção é o kit de recuperação, que existe para isso).

Kit de recuperação (`GET /web/api/recovery-kit`): a chave mestra do cofre (`MASTER_KEY_FILE`) e a senha do backup
(`RESTIC_PASS_FILE`, padrão `/run/secrets/restic_swap_plus_pass`, opcional), para o dono guardar fora do servidor.
- Só para a sessão do administrador aberta (login no Google) há **menos de 15 min**; senão 403
  `{ error: "reauth", message, login: "/web/login?next=acesso" }`. Sem sessão / quem não é mais administrador → 401.
- Resposta `{ masterKey: Item, backupPassword: Item, advice, loginAt, availableUntil }`, `Item = { available: true,
  value, file } | { available: false, value: null, file, why }` (arquivo que não existe → "não disponível").
  `Cache-Control: no-store`. Os valores nunca vão para log; o histórico registra "Kit de recuperação visto pelo painel (e-mail)".

PanelState:
```js
{ version, serverTime, me: { email, admin: true },
  adminEmails: [ ... ],                                  // ADMIN_EMAILS (definidos no servidor)
  accounts: [ PublicAccount + { loginExpiresAt, accessExpiresAt, lastRefreshAt, gen, disabled, threshold, weeklyThreshold, modelThreshold, priority, alias, assignedDevices: [{ id, name }] } ],
  rules, ruleDefaults, autoSwitch,
  devices: [ { id, name, platform, googleEmail, createdAt, lastSeen, lastContact, active, connected, presence, assigned } ],
                                                         // lastContact, connected, presence: presença do serviço, desde a 2.5.3 (ver "2.5.3")
  allowedEmails: [ ... ],                                // contas que podem conectar serviços (como foram guardadas)
  history: [ { ts, kind, text, device, deviceName } ],   // últimos 100
  warnings: [ { kind, text, account? } ],                // ex.: login que vence em menos de 3 dias, conta morta, Google desligado
  diag, google: { enabled, callbackUrl } }
```

## Telas (uma página, abas ou seções)

> Desenho da 2.1, guardado como registro, com as palavras da época. Os menus de hoje são os da "2.3" (Contas · Serviços ·
> Usuários), com o que as "2.5.x" mudaram. O que esta lista e a "2.2" chamam de "computador" a tela chama de **serviço**
> desde a 2.5.3.

1. **Visão geral**: um cartão por conta (número, apelido, e-mail, plano, organização), barras de sessão 5h / semanal /
   por modelo (verde/amarelo/vermelho pelas linhas das regras), quando renova cada janela, quais computadores estão
   nela, situação ("ok", "login morto — entre de novo com esta conta no Claude Code de qualquer computador conectado",
   "fora da rotação"), validade do acesso e **até quando vale o login** (aviso em amarelo se < 3 dias). Ações: fora da
   rotação liga/desliga, apelido, linha própria da sessão, prioridade, remover.
2. **Computadores**: nome, sistema, conta Google, último contato, conta em uso; ações: trocar de conta (escolher ou
   "melhor conta"), desconectar. Bloco "Conectar um computador": passo a passo do VS Code (Entrar com Google) e botão
   para gerar um código de conexão de reserva.
3. **Regras**: sessão %, semanal %, modelo %, modelo preferido, estratégia (Aproveitar ao máximo / Mais folga /
   Por prioridade), horas para "cota prestes a zerar", intervalo mínimo entre trocas, margem, o que fazer quando o
   limite de um modelo acaba (seguir na mesma conta / trocar de conta), troca automática ligada/desligada. Salvar.
4. **Acesso**: "Administrador: <e-mail> (definido no servidor)"; "Contas que podem conectar computadores" (liberar /
   tirar; o administrador, se estiver na lista, aparece marcado e sem "Tirar"); **Recuperação** (botão "Mostrar o kit de
   recuperação" → as duas chaves com "Copiar" cada, ou "Entrar de novo com Google" se o login tem mais de 15 min; some
   sozinho em 5 min; texto: "Guarde estas duas chaves FORA deste servidor (gerenciador de senhas ou um arquivo no seu
   computador). Se o servidor for perdido, só com elas o backup abre."); sessões do painel abertas (encerrar).
5. **Histórico**: eventos com data, computador e texto.
Topo: e-mail logado, botão Sair, avisos (`warnings`). Atualiza sozinho a cada 30 s (pausa com a aba oculta).
Visual sóbrio, no estilo da tela de configurações da extensão (plus/media/panel.css serve de referência de cores e
componentes), legível no celular (sem rolagem horizontal), acessível (rótulos, foco visível, contraste).

## 2.2 — Menus e cadastros (pedido do dono, 14/11/2026)

Menu do painel, nesta ordem: **Contas · Computadores · Regras · Padrões · Acessos · Histórico**. Cada um é um cadastro
(criar / ver / editar / remover) com a configuração correspondente.

**Estado novo no cofre** (o e-mail é sempre comparado pela chave normalizada de `access.js`/`emailKey`):
```js
state.ruleProfiles = { "<id>": { id, name, rules: { ...parcial de RULE_DEFAULTS }, createdAt, updatedAt } }
state.access = { "<emailNormalizado>": { email, accounts: null | [n...], profileId: null | "<id>", createdAt, updatedAt } }
state.defaults = { newAccessAccounts: null | [n...] }   // contas destinadas a um acesso novo (null = todas)
// já existentes: state.rules (= regras dos Padrões), state.autoSwitch (Padrões), state.allowedEmails (lista de acessos)
```
- Regras efetivas de um computador: perfil do acesso dele (`access[email].profileId`) por cima de `RULE_DEFAULTS`;
  sem perfil, as dos **Padrões** (`{ ...RULE_DEFAULTS, ...state.rules }`). Pareado por código: Padrões.
- Contas que um computador pode usar: `access[email].accounts` (null = todas); pareado por código: todas.
- O administrador também tem um registro em `state.access` (editável: perfil e contas), mas não pode ser removido.
- Remover um perfil → os acessos que usavam voltam aos Padrões. Remover uma conta Claude → sai de todas as listas.

**Rotas novas do painel** (mesma sessão/CSRF):
| rota | o que faz |
|---|---|
| `POST /web/api/profiles` `{ name, rules }` | cria perfil de regras → `{ profile }` |
| `PUT /web/api/profiles/:id` `{ name?, rules? }` | edita |
| `DELETE /web/api/profiles/:id` | remove (acessos voltam aos Padrões) |
| `PUT /web/api/defaults` `{ rules?, autoSwitch?, newAccessAccounts? }` | Padrões (`rules` → `engine.setRules`) |
| `POST /web/api/allowed` `{ email, accounts?, profileId? }` | cria acesso (contas padrão = `defaults.newAccessAccounts`) |
| `PUT /web/api/access/:email` `{ accounts?, profileId? }` | edita acesso |
| `DELETE /web/api/allowed/:email` | remove acesso (como hoje; admin → 409) |
| `PATCH /web/api/devices/:id` `{ name }` | renomeia computador |
PanelState ganha: `ruleProfiles: [ { id, name, rules, usedBy: [email] } ]`, `access: [ { email, admin, accounts, profileId, devices: [id] } ]`,
`defaults: { rules, autoSwitch, newAccessAccounts }`; cada computador ganha `email` do acesso e `profileId` efetivo.

**Telas**
- **Contas**: as que participam da troca primeiro, na ordem da fila (semanal que renova antes primeiro); as que NÃO
  participam ficam embaixo num grupo recolhido "Fora da troca (N)" (abre ao clicar). Cartão como hoje + "Acessos que
  podem usar esta conta". Sem botão de criar (conta nova entra pelo login no Claude Code de um computador conectado —
  explicar isso num bloco "Como adicionar uma conta").
- **Computadores**: lista; por computador: nome (renomear), acesso (e-mail), regras em uso (perfil), conta atual,
  trocar de conta (só entre as permitidas ao acesso dele), desconectar; bloco "Conectar um computador".
- **Regras**: lista de perfis (nome, resumo: sessão/semanal/modelo/estratégia, quais acessos usam); criar, editar
  (mesmo formulário de regras de hoje), duplicar, remover.
- **Padrões**: as regras gerais (formulário de hoje), troca automática ligada/desligada, contas destinadas a um acesso novo.
- **Acessos**: administrador (fixo) + contas Google liberadas; por acesso: perfil de regras (lista: "Padrões" + perfis),
  contas destinadas ("Todas" ou caixas por conta), computadores conectados com ele; criar (e-mail + perfil + contas),
  editar, remover. Seção "Recuperação" (kit) continua aqui, só para o administrador.
- **Histórico**: como hoje.

## 2.3 — SUBSTITUI a 2.2: só 3 menus (pedido do dono, 14/11/2026, mais "clean")

Menu: **Contas · Serviços · Usuários** (até a 2.5.0 o segundo menu aparecia como "Computadores"; ver "2.5.1"). No topo
à direita, **Minha conta** (e-mail do administrador, kit de recuperação, sessões abertas, sair). Histórico: botão
discreto "Histórico" no topo (abre um painel lateral/lista).
Sem perfis de regras: as regras são UMA só (gerais), ficam dentro de **Contas**, abaixo da lista.

**Contas**
- Botão **+ Adicionar conta** (login pela assinatura Claude, direto no painel — ver "Adicionar conta pela assinatura").
- Lista: participantes da troca primeiro, na ordem da fila (semanal que renova antes primeiro; empate: menos uso);
  embaixo, grupo recolhido **Fora da troca (N)**. Desde a 2.5.1 a lista é uma coluna de linhas que abrem e fecham, com
  as contas em uso no alto (ver "2.5.1"); na 2.5.2 o grupo saiu e as contas fora da troca ficam no fim da lista.
- Cartão da conta como hoje + **Serviços permitidos** ("Computadores permitidos" até a 2.5.2): "Todos" ou caixas por serviço
  (um ou mais). `state.accountDevices["<n>"] = null | [deviceId...]` (null = todos). Remover serviço/conta limpa as listas.
- Abaixo da lista, seção **Regras de troca** (o formulário de regras de hoje: sessão/semanal/modelo %, modelo
  preferido, estratégia, horas, intervalo, margem, limite do modelo; desde a 2.5.6, também o mínimo do modelo preferido
  no destino: ver "2.5.6") + **troca automática** ligada/desligada.
- Nas Regras de troca, escolha **Serviços** ("Computadores" até a 2.5.2; `rules.devicePlacement`, logo abaixo da troca
  automática; faz parte do rascunho: só vale em "Salvar regras"; "Voltar ao padrão" volta para Separados):
  - **Separados** (`"separate"`, padrão): "Cada serviço numa conta (cada um com a sua sessão de 5 h)."
  - **Juntos** (`"together"`): "Todos na mesma conta, a do topo da fila, e trocam juntos (gastam a mesma sessão de 5 h)."
  - Aviso: "Vale para os serviços ativos agora. Um serviço só usa contas liberadas para ele (“Serviços permitidos”, no cartão
    da conta): se não puder usar a conta dos outros, fica na melhor conta liberada para ele." O resumo do topo mostra
    "serviços juntos na mesma conta" quando Juntos.
  - Vai em `PUT /web/api/rules { rules: { devicePlacement } }` (rota de hoje; o motor recusa outro valor com 400 `invalid_rules`).
    Motor: SPEC.md, "Regra Serviços".

**Serviços** (o menu "Computadores" até a 2.5.0): grade de quadradinhos (linhas que abrem e fecham desde a 2.5.2), um por serviço: nome (renomear), sistema, usuário (conta Google), último
contato (ativo/parado até a 2.5.2; desde a 2.5.3, uma das quatro situações de presença: ver "2.5.3"), **conta Claude logada
nele agora** (número + e-mail) com o uso dela em barras pequenas; ações: trocar de conta (só entre as permitidas para esse
serviço; "melhor conta"), desconectar. Bloco "Conectar um serviço" ("Conectar um computador" até a 2.5.2; passo a passo +
código de reserva).

**Usuários** (colunas, ordenação e confirmação na linha: ver "2.5.2"): tabela (e-mail, papel: Administrador/Usuário, serviços conectados, desde quando, ações): liberar
(e-mail), tirar (admin não sai). É quem pode conectar serviços; o painel continua só do administrador.

**Regra de uso no motor**: um serviço só recebe/troca para contas cujo `accountDevices` é null ou contém o id
dele. Regras de troca: as gerais (`{...RULE_DEFAULTS, ...state.rules}`), iguais para todos. Com **Serviços: Juntos**
a permissão continua valendo mais: a conta do grupo nunca é posta num serviço que não pode usá-la.

**Rotas** (além das de hoje): `PUT /web/api/accounts/:n/devices { devices: null | [id] }`,
`PATCH /web/api/devices/:id { name }`, `PUT /web/api/rules` (já existe), e as de "Adicionar conta pela assinatura".
PanelState: cada conta ganha `devices: null | [id]`; cada serviço ganha `allowedAccounts: [n]` (calculado).

**Adicionar conta pela assinatura** (como o `/login` do Claude Code com código colado):
`POST /web/api/claude-login/start` → `{ loginId, authUrl }` (PKCE + state guardados em memória, 10 min);
a pessoa abre o authUrl, entra na conta Claude, copia o código mostrado e cola no painel;
`POST /web/api/claude-login/finish { loginId, code }` → troca o código por tokens, confere a identidade (perfil),
cria/atualiza a conta (mesmas regras do addLogin: grava o cofre antes, gen, refreshTokenExpiresAt) → `{ number, created }`.

## 2.4 — "Entrar de novo" (renovar o login de uma conta) e avisos por e-mail (15/11/2026)

**No painel (Contas)** — o mesmo fluxo de **+ Adicionar conta** (start → abrir o `authUrl` → entrar → colar o código → finish),
mas para uma conta que já existe, com o e-mail dela já pedido na página da Claude:
- No cartão da conta, quando o login está **morto** ou **vence em menos de 3 dias** (ou já venceu): a caixa de aviso do cartão traz
  o botão **Entrar de novo** ao lado do texto ("Login vence em 2 dias (sex 20/11 14:00). Entre de novo com <e-mail> para renovar.").
- Sempre, dentro de **Ajustes desta conta**: um bloco discreto "Login desta conta: entre de novo com <e-mail> para renovar" com o
  botão **Entrar de novo** (secundário, pequeno).
- A caixa de adicionar vira "Entrar de novo na Conta N", o passo 2 diz "Entre com <e-mail> e autorize. Se a página abrir com
  outra conta Claude, saia dela primeiro (ou use uma janela anônima)." e o botão de concluir vira "Concluir".
- Situação "login morto" e os avisos do topo (`warnings`) apontam para o botão: "clique em “Entrar de novo” no cartão da conta N
  (ou entre com ela no Claude Code de um serviço do administrador)".

**Rotas** (as mesmas do "Adicionar conta pela assinatura"):
- `POST /web/api/claude-login/start { loginHint? }` → `{ loginId, authUrl, expiresAt }` (+ `loginHint`, quando usado).
  `loginHint` = e-mail da conta; sendo um e-mail válido (`claudelogin.cleanLoginHint`: texto aparado, até 254 caracteres, sem
  espaço/controle/`<>"'(),;:\`, com `@` e ponto no domínio), vai como **`login_hint`** na URL de autorização, logo depois do
  `state` — o mesmo parâmetro (e a mesma posição) do Claude Code (comentários no topo de `claudelogin.js`). Inválido (ou que não é
  texto) → **ignorado**: o login segue como um "Adicionar conta" normal (aviso no log).
- `POST /web/api/claude-login/finish { loginId, code }` → como antes (`{ ok, number, created, email, message, state }`); com
  `loginHint` no start, a resposta ganha `loginHint` (o e-mail pedido) e `otherEmail` (true = entrou com OUTRO e-mail).
  - Mesmo e-mail: "Conta N (e-mail): entrou de novo. O login novo já vale e o servidor guarda e renova ele sozinho."
  - **Outro e-mail**: a conta pedida NÃO muda, e a mensagem diz exatamente o que aconteceu: "Atenção: você entrou com X, não com Y.
    Foi criada uma conta nova, a conta N (X)." ou "O login novo foi para a conta N (X), que já estava no servidor." + "A conta M (Y)
    continua como estava, com o login antigo." (ou "Nenhuma conta com Y foi mudada") + como tentar de novo. O painel mostra essa
    mensagem em destaque. Histórico: "Conta N adicionada/atualizada pelo painel (login da assinatura) — o pedido era entrar de novo
    com Y, mas entrou com X".

**Avisos por e-mail ao dono** (SPEC.md, "Avisos por e-mail ao dono"): conta que morreu (na hora), cofre sem gravar (1 por
incidente) e o vencimento dos logins. Na 2.4 o do vencimento saía 1 vez por conta por dia, desde 3 dias antes. Desde a 2.5.0 são
dois: um **resumo semanal** (padrão: segunda às 8h) com as contas cujo login vence nos 7 dias seguintes, e **um e-mail por
login** quando falta menos de 1 dia para ele vencer (`NOTICE_LOGIN_DAYS`). O alerta de 3 dias continua no painel e no histórico,
sem e-mail. Os avisos de login explicam como renovar pelo **Entrar de novo** deste painel.

## 2.5.1 — Menu "Serviços" e contas em linhas que abrem e fecham (pedido do dono, 20/11/2026)

Só a tela mudou (`server/web/`): nenhuma rota nem campo novo. O PanelState já mandava tudo (`loginExpiresAt`,
`assignedDevices`, `usage`, `disabled`, `alias`).

**Menu: Contas · Serviços · Usuários.** O menu "Computadores" passou a se chamar **Serviços** (o rótulo da aba e o título
da página dela). Só o nome na tela: o id da seção, o endereço `#computadores` e o `?next=computadores` do login continuam.
Os outros textos com "computadores" não mudaram na 2.5.1 (regra "Computadores: Separados/Juntos", "Computadores permitidos",
"Computadores nela", "Em N computadores", "Conectar um computador"…): passaram a "serviços" na 2.5.3 (ver "2.5.3"), e é com os
nomes de hoje que esta seção e a "2.5.2" os citam.

**Contas: uma coluna de linhas** (no lugar da grade de cartões). Cada conta é uma linha que abre e fecha:
- A página abre com **todas recolhidas**. O que está aberto fica só na memória da página (por número da conta): continua
  igual nas atualizações de 30 s e some ao recarregar.
- **Linha recolhida** (cerca de duas linhas de texto na tela larga; empilhada abaixo de 960 px):
  - "Conta N", o apelido (se houver) e o e-mail; etiquetas "Em 1 serviço" / "Em N serviços" (conta em uso), "Nº na fila" e "Login morto";
  - **uma barra de uso**: a do limite mais perto de parar a conta = a maior porcentagem entre sessão 5h, semanal e os de
    modelo (empate: sessão, depois semanal), com o rótulo ("Sessão 5h", "Semanal", "Fable"…), a porcentagem, as cores de
    sempre (pela linha de troca daquele limite) e "renova <quando>" ("sem uso nas últimas 5 horas" na sessão parada). Sem
    leitura de uso: "Ainda sem leitura de uso." ("Sem dados de uso." no login morto);
  - **Participa da troca** / **Fora da troca**: só um indicador (bolinha + texto). O liga/desliga fica no cartão aberto.
- **Clicar na linha abre o cartão ali mesmo** (sem janela), embaixo dela, com tudo o que o cartão já tinha: plano e
  organização, situação, as barras todas, serviços nela, serviços permitidos, acesso, login, aviso com "Entrar de
  novo", "Participa da troca", "Ajustes desta conta" e "Remover conta". Clicar de novo fecha.
- **Ordem**: primeiro as contas **em uso** (com serviço nelas agora — `assignedDevices`), inclusive uma conta fora da
  troca que esteja em uso; depois as outras que participam, na ordem da fila. A etiqueta "Nº na fila" é a posição na
  fila, não na lista (a conta em uso sobe sem mudar de posição). As que não participam e não estão em uso continuam no
  grupo recolhido **Fora da troca (N)** (até a 2.5.2, que acabou com o grupo: ver "2.5.2").
- **Alerta de login** (a validade é o `loginExpiresAt`, o mesmo "Login vale até" do cartão): faltando **menos de 3 dias**,
  a linha ganha o ícone de alerta, a borda amarela e a linha **"Fazer login até <data e hora>"** piscando; já vencido,
  em vermelho, **"Login venceu em <data e hora>"**. Aparece com a conta recolhida e com ela aberta (a linha é o cabeçalho
  do cartão), além da caixa de aviso com "Entrar de novo" de sempre. Sem data conhecida: nenhum alerta. **Login morto**:
  como antes (borda vermelha, situação e caixa com "Entrar de novo") e, na linha, a etiqueta "Login morto" e uma linha
  vermelha parada.
- O piscar é uma animação de CSS (`loginblink`), sem temporizador de JS; com `prefers-reduced-motion: reduce` a linha fica
  parada, com a mesma cor.
- Acessibilidade: a linha é um `<button>` com `aria-expanded` e `aria-controls` (o corpo do cartão); Enter e Espaço abrem
  e fecham. O corpo é irmão do botão, não filho: os controles de dentro não abrem nem fecham o cartão. A atualização de
  30 s devolve o foco ao mesmo controle (`data-k`) sem rolar a página. "Ver conta N" (avisos do topo) abre o cartão.
- Rascunho de "Ajustes desta conta" ainda não salvo: a linha mostra "Alterações não salvas", mesmo com o cartão fechado.

## 2.5.2 — Fim do grupo "Fora da troca", serviços em linhas, tabela de usuários e busca em cada aba (pedido do dono, 20/11/2026)

De novo só a tela mudou (`server/web/`): nenhuma rota nem campo novo. Tudo sai do PanelState e das rotas que já existiam.

**Contas: uma lista só.** O grupo recolhido "Fora da troca (N)" saiu. As contas que não participam da troca são linhas
como as outras, no **fim da lista** (por número), com o indicador "Fora da troca" de sempre. Ordem completa: contas em
uso (as que participam, na ordem da fila; depois as fora da troca que estiverem em uso) → as outras que participam, na
ordem da fila → as fora da troca sem uso. A frase útil do grupo foi para a "Situação" do cartão aberto: "fora da troca
(a troca automática não usa esta conta; dá para usá-la numa troca manual, em Serviços, ou ligar “Participa da troca” de
novo, abaixo)".

**Serviços: linhas que abrem e fecham**, como as contas (no lugar da grade de quadradinhos):
- A página abre com **todos recolhidos**; o que está aberto fica só na memória da página (por id do serviço) e
  continua igual nas atualizações de 30 s. Ordem: os ativos primeiro; depois, por nome (como antes; desde a 2.5.3, pela
  situação de presença e depois por nome: ver "2.5.3").
- **Linha recolhida** (cerca de duas linhas na tela larga; empilhada abaixo de 960 px): bolinha de ativo/parado (desde a
  2.5.3, uma cor para cada situação de presença) e o nome; sistema e quem conectou (e-mail do Google ou "conectado por
  código"); a conta Claude de agora — "Conta N" com **uma barra**, a mesma da linha da conta (o limite de maior porcentagem;
  o nome do limite e "renova <quando>" vão na linha de baixo), ou "Sem conta Claude agora" / "Conta N (não existe mais no
  servidor)"; e o contato (até a 2.5.2: "ativo agora", ou "parado" e "visto <quando>", ou "ainda não apareceu"; desde a
  2.5.3, a situação em cima e o detalhe embaixo: ver "2.5.3"). Conta de login morto: etiqueta "Login morto" na linha.
- **Cartão aberto** = o que o quadradinho tinha: sistema, usuário e contato; "Conta Claude agora" com as barras todas;
  "Trocar para" (só as contas permitidas); **Renomear** (o campo aparece no alto do cartão) e **Desconectar**.
- Mesma acessibilidade das contas: a linha é um `<button>` com `aria-expanded`/`aria-controls`; o corpo é irmão dele.
  Nome digitado e ainda não salvo: a linha mostra "Nome não salvo", mesmo com o cartão fechado.
- O bloco "Conectar um serviço" continua embaixo da lista.

**Usuários: tabela** com as colunas **Usuário** (e-mail, com "você"), **Situação** (Administrador / Liberado / Não
liberado — este saiu da lista mas ainda tem serviço conectado), **Serviços** (quantos e quais), **Desde** e as ações.
- **Liberar um usuário**: formulário no alto (e-mail + botão). O que der errado aparece **embaixo do campo** — campo
  vazio, e-mail que não parece válido, ou a mensagem que o servidor devolveu — e o campo fica marcado (`aria-invalid`,
  `aria-describedby`). O sucesso também aparece ali ("… liberado. Ele já pode conectar…").
- **Ações por linha** (as que o servidor tem): **Tirar** (liberado) e **Liberar de novo** (não liberado); o
  administrador é "fixo". Não há "editar": não existe rota para isso.
- **Tirar** não abre janela: a linha ganha uma faixa embaixo com a pergunta e os botões "Tirar usuário" / "Cancelar"
  (o foco vai para Cancelar; Esc cancela; sair da aba cancela). Se o servidor falhar, o erro aparece nessa faixa.
  O resultado ("… não está mais liberado.") aparece no alto da tabela.
- **Ordenar**: os cabeçalhos Usuário, Situação e Serviços são botões (`aria-sort`); clicar de novo inverte. Ordem
  inicial: situação (administrador, liberados, não liberados), com o e-mail desempatando.
- **Celular** (até 720 px): cada linha vira um cartão empilhado (e-mail e ação em cima; "Situação:", "Serviços:" e
  "Desde:" embaixo). O cabeçalho some — ali não dá para ordenar. Sem rolagem horizontal.

**Busca em cada aba** (Contas, Serviços, Usuários): um campo acima da lista, que filtra enquanto a pessoa digita.
- Procura em **todos os dados do item**, inclusive os que só aparecem com o cartão aberto. Conta: "Conta N", apelido,
  e-mail, plano, organização, "participa da troca" / "fora da troca", "em uso" e os nomes dos serviços nela,
  "Nº na fila", "login morto", "Fazer login até…" / "Login venceu…", "sem leitura de uso", serviços permitidos.
  Serviço: nome, sistema, e-mail de quem conectou ou "por código de conexão" (até a 2.5.3: "conectado por código"), o contato (até a 2.5.2: "ativo agora" /
  "parado" / "ainda não apareceu"; desde a 2.5.3, o texto inteiro da situação de presença: ver "2.5.3"), "Conta N" (ou
  "sem conta"), apelido e e-mail dessa conta, "login morto". Usuário: e-mail, situação, "você" e os nomes dos serviços.
  As porcentagens não entram.
- Sem diferença de maiúsculas e de acentos ("servico" acha "Serviço"). Com mais de uma palavra, **todas** precisam
  aparecer, em qualquer ordem e campo; e, se algum item tem a **frase inteira**, ficam só esses ("em uso" não traz a
  conta "sem leitura de uso"; "conta 7" não traz a que está em 7º na fila).
- Ao lado do campo: **"N de M"** (com texto na busca) e o **×** que limpa; **Esc** limpa. Sem resultado: "Nada
  encontrado para “…”" com o botão "Limpar a busca".
- O texto de cada aba fica só na memória: continua na atualização de 30 s e ao trocar de aba; some ao recarregar. A
  busca só esconde linhas — não muda a ordem nem o que está aberto — e o campo não pega o foco na atualização.
  "Ver conta N" (avisos do topo) limpa a busca das contas se ela esconde a conta.

## 2.5.3 — "Serviço" no lugar de "computador" e a presença dos serviços (pedido do dono, 21/11/2026)

Duas mudanças. A primeira é só de palavra, na tela e nos textos que o servidor gera. A segunda traz três campos novos em cada
serviço do PanelState, calculados pelo motor (SPEC.md, "Presença dos serviços"). Nenhuma rota nova.

**"Serviço" no lugar de "computador".** Tudo o que se conecta ao Swap — um VS Code, o cliente do Hermes, um robô — é um
**serviço**, na tela e nos textos que o servidor gera (histórico, avisos do topo, e-mails ao dono, páginas montadas pelo
servidor, mensagens de erro, linha de comando). A aba já se chamava Serviços desde a 2.5.1; faltava o resto.
- Rótulos fixos (entre parênteses, como eram até a 2.5.2):
  - aba e título da página: **Serviços** (desde a 2.5.1);
  - no cartão da conta e em "Ajustes desta conta": **Serviços permitidos** ("Computadores permitidos"); no cartão, também
    **Serviços nela** ("Computadores nela");
  - nas Regras de troca: **Serviços**, com **Separados** / **Juntos** ("Computadores");
  - o bloco embaixo da lista de serviços: **Conectar um serviço** ("Conectar um computador");
  - a etiqueta da linha da conta: **Em 1 serviço** / **Em N serviços** ("Em 1 computador" / "Em N computadores");
  - no resumo do topo, com a regra em Juntos: "serviços juntos na mesma conta";
  - no Histórico: o tipo de evento "Serviço" ("Computador") e, na entrada de um serviço que já saiu e não deixou o nome,
    "serviço removido" ("computador removido").
- Na aba Serviços, embaixo do título: "Serviço é tudo o que está conectado ao Swap: um VS Code, um agente como o Hermes, um robô."
- "Computador" ficou só onde é a máquina em que a pessoa está sentada: "No computador, abra o VS Code com a extensão Swap Plus
  instalada." (passo 1 de "Conectar um serviço") e "um arquivo no seu computador" (kit de recuperação).
- Não mudaram: ids, classes e endereços (`sec-computadores`, `tab-computadores`, `q-computadores`, `#computadores`,
  `?next=computadores`), nomes de campo (`devices`, `assignedDevices`, `allowedAccounts`, `rules.devicePlacement`) e rotas
  (`/web/api/devices/:id`, `/web/api/accounts/:n/devices`). As entradas já gravadas no histórico ficam com o texto antigo.
- Os textos que mandam a pessoa para a extensão usam os nomes da extensão 3.2.0: comando **"Swap Plus: Configurações"** (era
  "Swap Plus: Configurar trocas automáticas") e cartão **"Conexão"** (era "Servidor"). Estão no bloco "Conectar um serviço", na
  lista de serviços vazia e na página 403 "Painel só do administrador".

**Presença dos serviços: quatro situações.** Até a 2.5.2 um serviço aparecia como "ativo agora" ou "parado", pelo `active`
(batimento nos últimos 5 min). Um cliente sem uso — o do Hermes entre duas tarefas — não manda batimento: só lê o estado a cada
~2 min, e aparecia "parado" estando ligado. Agora o servidor marca o **contato** (qualquer pedido autenticado do serviço, de
qualquer rota; só na memória do motor) e a tela mostra quatro situações.

PanelState — cada item de `devices` tem estes campos, e só estes: `id, name, platform, googleEmail, createdAt, lastSeen,
lastContact, active, connected, presence, assigned, allowedAccounts`. Os três novos:
- `lastContact`: número (ms) ou `null` — o último contato do serviço. Nunca é mais antigo que o `lastSeen`, que continua sendo o
  último batimento (o uso). `null` = o serviço nunca apareceu.
- `connected`: boolean — o último contato foi há no máximo 5 min (`CONTACT_MS`, no motor).
- `presence`: uma destas, a primeira que valer:
  - `"active"`: o `active` de sempre (batimento nos últimos 5 min);
  - `"connected"`: não está ativo, mas falou com o servidor nos últimos 5 min;
  - `"waiting"`: nem ativo nem conectado, ainda não falou com o servidor desde que ele subiu, e ele subiu há menos de 5 min.
    É passageira: num reinício ou numa atualização os contatos da memória se perdem, e sem ela os serviços ociosos pareceriam
    sumidos até o próximo pedido deles;
  - `"none"`: o resto.
- Motor que não manda esses campos (`web.js`, `devicesNow`): `lastContact` = `lastSeen`; `connected` = `active`; `presence` sai
  de `active` e `connected` (`"active"`, `"connected"` ou `"none"`). Com um `presence` que o painel não conhece, a mesma conta.
- É só para mostrar. A troca automática, as contas ocupadas e a regra Serviços continuam olhando só os ativos.
- Os mesmos três campos saem em `StateResponse.devices` (a API dos serviços); a extensão e o cliente sem VS Code não os leem.

Na tela (`server/web/app.js`, trecho "presença dos serviços"; a página usa o `presence` e, se ele não vier, cai no `active` e no
`connected`):

| `presence` | texto | bolinha | no resumo (um / vários) |
|---|---|---|---|
| `active` | `ativo agora` | verde (`.dot.on`, a de antes) | ativo agora / ativos agora |
| `connected` | `conectado · sem uso agora` | azul (`.dot.conn`, cor `--conn`) | conectado / conectados |
| `waiting` | `aguardando contato · o servidor reiniciou há pouco` | só o contorno, cinza (`.dot.wait`) | aguardando contato |
| `none` | `sem contato · visto <quando>`; sem data nenhuma, `sem contato · ainda não apareceu` | cinza cheia (`.dot`, a do "parado" de antes) | sem contato |

- `<quando>` é a data do `lastContact` (num servidor antigo, sem o campo, a do `lastSeen`), no formato de data de sempre do
  painel (`fmtWhen`).
- **Linha recolhida**: a bolinha antes do nome; na última coluna, a situação em cima ("ativo agora", "conectado", "aguardando
  contato", "sem contato") e o detalhe embaixo ("sem uso agora", "o servidor reiniciou há pouco", "visto …", "ainda não
  apareceu"). Para leitor de tela os dois saem juntos, com " · " no meio.
- **Cartão aberto**, em "Contato": o texto inteiro.
- As bolinhas valem nos temas escuro e claro: `--conn` tem uma cor em cada tema, e as outras usam as cores que já existiam.
- **Legenda** "O que quer dizer cada situação" (recolhida), no alto da aba: a bolinha e uma frase para cada uma das quatro.
- **Resumo do topo**: `5 serviços (3 ativos agora, 1 conectado, 1 sem contato)`. Os grupos saem na ordem da tabela; grupo sem
  ninguém não aparece; singular e plural combinam (`2 conectados`, `2 aguardando contato`). Com um serviço só, sem o número
  dentro: `1 serviço (ativo agora)`. Sem nenhum: `nenhum serviço`. Até a 2.5.2 era "1 computador (ativo agora)" ou "(parado)"
  e "N computadores (M ativos agora)".
- **Ordem** da aba: ativos, conectados, aguardando contato, sem contato; dentro de cada grupo, por nome.
- **Busca** dos serviços: entra o texto inteiro da situação (acha por "conectado", "sem uso", "sem contato", "aguardando"…).
- A palavra **"parado" saiu do painel**.
- A etiqueta "Em N serviços" da linha da conta continua contando os serviços que estão **na conta** (`assignedDevices`), ativos
  ou não: não é presença.

## 2.5.6 — Regra "Mínimo de Fable sobrando no destino" (pedido do dono, 21/11/2026)

Em 21/11/2026 às 14:03 o servidor trocou todos os serviços, por conta própria (estratégia "Aproveitar ao máximo"), para
uma conta com a cota semanal sobrando mas com o Fable em 89%. Doze minutos depois o Fable dela acabou e duas conversas
pararam. O dono pediu um ajuste na tela para isso, começando em 10%. A regra no motor: `server/SPEC.md`, "Mínimo do
modelo preferido no destino".

- **Onde:** Contas → **Regras de troca** → **Ajustes finos**, logo depois de "Margem da conta de destino".
- **Campo:** número inteiro (`<input type="number" id="rPreferMin" name="preferMinFreePct" min="0" max="50" step="1">`),
  unidade **%**, rótulo **Mínimo de Fable sobrando no destino**.
- **Dica:** "Numa troca que o servidor faz por conta própria (para aproveitar uma cota que vai zerar ou para renovar um
  login), a conta de destino precisa ter pelo menos isso do Fable sobrando. Troca obrigatória (conta na linha ou limite
  batido) não olha este número. De 0 a 50. Padrão: 10." O "10" vem de `ruleDefaults.preferMinFreePct` (`data-def`), como
  nos outros campos.
- **Comportamento do formulário:** igual ao dos outros três números de "Ajustes finos" (`NUM_FIELDS` no `app.js`): faz
  parte do rascunho ("Alterações não salvas", "Desfazer"), só vale em **Salvar regras**, "Voltar ao padrão" põe 10, e
  valor vazio ou fora de 0–50 marca o campo e mostra "Mínimo de Fable sobrando no destino: use um número de 0 a 50."
- **Envio:** `PUT /web/api/rules { rules: { preferMinFreePct: <número> } }` (a rota de sempre; só as regras que mudaram).
  Texto no lugar de número → 400. O motor ajusta para a faixa. `PanelState.rules` e `PanelState.ruleDefaults` passam a
  trazer a chave (`ruleDefaults` é o `RULE_DEFAULTS` do `plus/rules.js`).
- O rótulo e a dica dizem "Fable" (texto fixo, como o resto do formulário); a regra vale para o modelo escolhido em
  "Modelo preferido". Com "Nenhum (sem preferência)", ela não tem efeito.
- **Linha de comando:** `rule preferMinFreePct 20`.
- **Com 10 (o padrão), a troca das 14:03 ainda aconteceria** (a conta tinha 11% sobrando). Para ela não acontecer, o
  número precisa ser maior (20, por exemplo). O que mudou junto, e vale com qualquer número: a conta em uso passa a
  ser lida a cada 2,5 min desde 15 pontos antes da linha do modelo (era 5), para a troca sair na linha de 95% antes de
  o Fable acabar (`server/SPEC.md`, "Uso (passo 2)").
