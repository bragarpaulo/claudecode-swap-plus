# Painel web do Swap Plus Servidor — especificação (2.1)

Painel em `https://swap.assistentes.si/` (mesma origem da API), em português, para o Paulo configurar tudo pelo
navegador (o VS Code só obedece). Login com Google, **só do administrador** (`ADMIN_EMAILS`, abaixo). As contas Google
liberadas (`state.allowedEmails`) só conectam computadores pelo VS Code: não entram no painel.
Sem dependências de terceiros; sem CDN (CSP só `'self'`). Node 22. Atrás de Caddy + Cloudflare (`TLS_MODE=off`,
`TRUST_PROXY=1`, `PUBLIC_URL=https://swap.assistentes.si`).

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
- O administrador também conecta computadores (login "device" com Google) **sem precisar estar** na lista de liberadas.
- Comparação de e-mail (`emailKey`, google.js) em todo lugar que compara: administrador, lista (liberar, tirar,
  repetidos), login do painel, login dos computadores e derrubar sessões no `deny`. Minúsculas; em `gmail.com` /
  `googlemail.com` a parte local perde os pontos e o `+algo` e o domínio vira `gmail.com`
  (`Dono.Exemplo+x@googlemail.com` = `donoexemplo@gmail.com`). Outros domínios: só minúsculas. O e-mail é guardado e
  mostrado como veio (aparado, em minúsculas).

## Login no painel (Google)

- `GET /web/login` → cria uma sessão de login do Google do tipo **web** (mesmo cliente OAuth "Claude Swap", mesmo
  retorno `PUBLIC_URL/auth/google/callback`, PKCE + state) e redireciona ao Google. O callback já existente
  (`server/src/google.js`) distingue o tipo pela sessão do `state`: tipo `device` = fluxo atual dos computadores;
  tipo `web` = cria a sessão do painel.
- Sessão do painel: token de 32 bytes (base64url) no cookie `sp_sess` (`Path=/; HttpOnly; Secure; SameSite=Lax;
  Max-Age=2592000`); no cofre guarda só o sha256 em `state.webSessions[id] = { tokenHash, email, createdAt, lastSeen,
  expiresAt (30 dias), ua (resumo do User-Agent), ip }`. **Só o administrador** ganha sessão:
  - conta liberada (na lista) que não é administrador → página 403 "Esta conta pode conectar computadores, mas o painel
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
| `PATCH /web/api/accounts/:n` | `{ disabled?, threshold?, priority?, alias? }` → `engine.updateAccount` |
| `DELETE /web/api/accounts/:n` | `engine.removeAccount` (a tela pede confirmação) |
| `POST /web/api/devices/:id/switch` | `{ number \| null }` → `engine.switchDevice(id, number, "painel")` |
| `DELETE /web/api/devices/:id` | revoga o computador |
| `POST /web/api/allowed` / `DELETE /web/api/allowed/:email` | libera / tira conta Google **para conectar computadores** (não dá painel). Repetido pela `emailKey` não entra de novo. Liberar o administrador não faz nada (`{ added: false, admin: true }`); tirar o administrador → **409** `{ error: "admin" }` (ele não depende da lista) |
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
  accounts: [ PublicAccount + { loginExpiresAt, accessExpiresAt, lastRefreshAt, gen, disabled, threshold, priority, alias, assignedDevices: [{ id, name }] } ],
  rules, ruleDefaults, autoSwitch,
  devices: [ { id, name, platform, googleEmail, createdAt, lastSeen, active, assigned } ],
  allowedEmails: [ ... ],                                // contas que podem conectar computadores (como foram guardadas)
  history: [ { ts, kind, text, device, deviceName } ],   // últimos 100
  warnings: [ { kind, text, account? } ],                // ex.: login que vence em menos de 3 dias, conta morta, Google desligado
  diag, google: { enabled, callbackUrl } }
```

## Telas (uma página, abas ou seções)

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

Menu: **Contas · Computadores · Usuários**. No topo à direita, **Minha conta** (e-mail do administrador, kit de
recuperação, sessões abertas, sair). Histórico: botão discreto "Histórico" no topo (abre um painel lateral/lista).
Sem perfis de regras: as regras são UMA só (gerais), ficam dentro de **Contas**, abaixo da lista.

**Contas**
- Botão **+ Adicionar conta** (login pela assinatura Claude, direto no painel — ver "Adicionar conta pela assinatura").
- Lista: participantes da troca primeiro, na ordem da fila (semanal que renova antes primeiro; empate: menos uso);
  embaixo, grupo recolhido **Fora da troca (N)**.
- Cartão da conta como hoje + **Computadores permitidos**: "Todos" ou caixas por computador (um ou mais).
  `state.accountDevices["<n>"] = null | [deviceId...]` (null = todos). Remover computador/conta limpa as listas.
- Abaixo da lista, seção **Regras de troca** (o formulário de regras de hoje: sessão/semanal/modelo %, modelo
  preferido, estratégia, horas, intervalo, margem, limite do modelo) + **troca automática** ligada/desligada.

**Computadores**: grade de quadradinhos, um por computador: nome (renomear), sistema, usuário (conta Google), último
contato (ativo/parado), **conta Claude logada nele agora** (número + e-mail) com o uso dela em barras pequenas; ações:
trocar de conta (só entre as permitidas para esse computador; "melhor conta"), desconectar. Bloco "Conectar um
computador" (passo a passo + código de reserva).

**Usuários**: tabela (e-mail, papel: Administrador/Usuário, computadores conectados, desde quando, ações): liberar
(e-mail), tirar (admin não sai). É quem pode conectar computadores; o painel continua só do administrador.

**Regra de uso no motor**: um computador só recebe/troca para contas cujo `accountDevices` é null ou contém o id
dele. Regras de troca: as gerais (`{...RULE_DEFAULTS, ...state.rules}`), iguais para todos.

**Rotas** (além das de hoje): `PUT /web/api/accounts/:n/devices { devices: null | [id] }`,
`PATCH /web/api/devices/:id { name }`, `PUT /web/api/rules` (já existe), e as de "Adicionar conta pela assinatura".
PanelState: cada conta ganha `devices: null | [id]`; cada computador ganha `allowedAccounts: [n]` (calculado).

**Adicionar conta pela assinatura** (como o `/login` do Claude Code com código colado):
`POST /web/api/claude-login/start` → `{ loginId, authUrl }` (PKCE + state guardados em memória, 10 min);
a pessoa abre o authUrl, entra na conta Claude, copia o código mostrado e cola no painel;
`POST /web/api/claude-login/finish { loginId, code }` → troca o código por tokens, confere a identidade (perfil),
cria/atualiza a conta (mesmas regras do addLogin: grava o cofre antes, gen, refreshTokenExpiresAt) → `{ number, created }`.
