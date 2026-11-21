# Swap Plus Cliente no Contabo — o cliente do Hermes: instalação e operação

Escrito em 20/11/2026 e **instalado no servidor nesse dia** (seção seguinte). O código do cliente tem testes
automáticos (`node --test cliente/test/*.test.js`), que passam no Linux, no Mac e no Windows, e a imagem Docker é
construída e executada na conferência automática do GitHub.

## Como está instalado (20/11/2026)

Feito a pedido do Paulo ("tudo automático, nada manual"), sem recriar o contêiner do Hermes:

| o quê | como ficou |
| --- | --- |
| cliente | stack `swap-plus-cliente-hermes` (Portainer, id 20), contêiner `swap-plus-cliente-hermes`, imagem `swap-plus-cliente:1.0.0`; no Swap é o computador "Hermes (servidor)", conectado por código |
| pasta de login | `/srv/hermes-personal/data/swap-plus-login` no host (variável `SWAP_PLUS_CLIENTE_LOGIN_DIR` da stack). O Hermes já enxerga essa pasta como `/opt/data/swap-plus-login`, sem bind novo; o login do Claude Code fica em `claude/` dentro dela |
| Claude Code no Hermes | binário nativo 2.1.323 em `/opt/data/.local/bin/claude` (está no `PATH` do contêiner), baixado como o usuário do Hermes e conferido pelo checksum do manifesto oficial. Fica no volume de dados, não na imagem |
| plugin | `claude-subscription-directsdk-experimental` 0.4.0, do catálogo oficial, em `/opt/data/plugins/`; `claude_config_dir` = `/opt/data/swap-plus-login/claude` no `config.yaml` do Hermes |
| trava de modelo | `/opt/data/extra_pkgs/hermes_model_lock.py` ganhou a exceção para o provedor do plugin (cópia anterior ao lado, `.antes-claude-code-20261120`). O resto da trava não mudou |
| gateway do Hermes | reiniciado uma vez com `scripts/hermes/geise/reiniciar_hermes.sh` (11 s; saúde ok, WhatsApp conectado) para carregar a exceção. O contêiner não foi recriado e o modelo padrão continua o Codex |

Conferido de verdade: o cliente em dia e saudável; `claude auth status` dentro do Hermes reconhecendo o login; duas
chamadas reais pelo Hermes (`hermes chat --oneshot`) com o provedor do plugin, uma pelo apelido (`haiku`) e uma pelo
nome da lista (`claude-haiku-4-5-20251001`), as duas respondidas pelo Claude Code (no log: `provider=
claude-subscription-directsdk-experimental`); e o cliente passando a **ativo** depois do uso.

**Modelo do Hermes (20/11/2026, 22:05, a pedido do Paulo):** as conversas passaram a usar o Fable 5.2 pelo Claude
Code, com raciocínio alto. Feito pelo mesmo caminho do painel (Modelos → Main model): `model.provider` =
`claude-subscription-directsdk-experimental`, `model.default` = `claude-fable-5-2[1m]`, `agent.reasoning_effort` =
`high`. Para só as conversas mudarem, as 20 tarefas auxiliares que estavam em `auto` (seguiam o modelo principal)
ficaram presas a `openai-codex` / `gpt-6.1-sol`, e `fallback_providers` ganhou o Codex como reserva. Não mudaram: a
transcrição (`stt`: OpenAI `gpt-4o-transcribe`), os subagentes (`delegation`), a compressão e o padrão das rotinas
(`cron.model`), todos no GPT. **Rotinas (22:17, também a pedido do Paulo):** as 26 que usam IA (21 ativas e 5
pausadas) foram fixadas, uma a uma, com `hermes cron edit`, no provedor do plugin, modelo `claude-fable-5-2[1m]` e
raciocínio `high`. As outras 76 são só script (`no_agent`) e não usam modelo nenhum. Rotina com IA criada depois
disto segue o `cron.model` do config, que continua no GPT. Antes de trocar, uma rotina de teste com entrega `local`
rodou pelo agendador no Fable e foi removida. Cópias de antes: `/opt/data/config.yaml.antes-fable-20261120`,
`/opt/data/cron/jobs.json.antes-fable-20261120` e `jobs.json.antes-fable-rotinas-20261120` (o `jobs.json` guarda
também o andamento das rotinas: para voltar, limpe o modelo de cada uma com `hermes cron edit <id> --model ""
--provider "" --reasoning-effort ""` em vez de repor o arquivo). Para voltar: no painel, Modelos → Main model → Change → OpenAI Codex
`gpt-6.1-sol`, e `hermes config set agent.reasoning_effort medium`.

**Correções de 21/11/2026 (madrugada), depois que o Paulo viu o chat do aplicativo cair no GPT:**

- **Aplicativo (Desktop) mandando "modelo Claude + provedor do GPT".** O aplicativo guarda na máquina a última
  escolha manual de modelo e a de provedor separadamente. Depois da troca do modelo principal ele ficou com o modelo
  novo (`claude-fable-5-2[1m]`) e o provedor antigo (`openai-codex`) e passou a criar as conversas com esse par, que
  não existe: cada mensagem falhava três vezes (404, uns 9 s) e só então a reserva (GPT) respondia. Reproduzido com
  `hermes chat --oneshot --provider openai-codex -m 'claude-fable-5-2[1m]'`. Correção no servidor, sem depender do
  aplicativo: `/opt/data/extra_pkgs/hermes_model_lock.py` ganhou `repair_route` (marcador
  `HERMES_CLAUDE_ROUTE_REPAIR_V1`), instalada em `LocalSessionPolicy.effective`: quando a rota de uma sessão com
  política de lançamento (aplicativo, linha de comando) resolve em "modelo claude-* no provedor `openai-codex` ou
  `anthropic`" e o perfil está no plugin, a sessão segue a rota do perfil, mantendo o modelo pedido. Sessões de modo
  seguro e qualquer outro par ficam como estavam; erro dentro da regra devolve o resultado original. No mesmo
  arquivo, o GPT forçado da trava antiga passou a ser resolvido para o próprio Codex (antes era montado em cima da
  rota padrão, que deixou de ser o Codex). Cópia de antes: `hermes_model_lock.py.antes-reparo-20261121`. Revisada por
  dois revisores independentes antes de instalar; gateway reiniciado às 01:01–01:03 (84 s: esperou uma rotina
  terminar). Depois: o mesmo comando responde pelo Fable em 2,1 s, sem falha; GPT escolhido de propósito continua no
  GPT; o padrão do perfil sai pelo Fable.
- **Resposta a mensagem de voz saindo pelo GPT.** `auxiliary.voice_chat` é a rota das respostas a áudio e o padrão
  dela é seguir o modelo principal; em 20/11 ela tinha sido presa ao GPT junto com as tarefas internas, por engano.
  Voltou ao padrão (`provider: auto`, sem modelo; cópia de antes: `config.yaml.antes-voz-20261121`). A transcrição
  (`stt`) continua no GPT. As outras 20 tarefas auxiliares seguem presas a `openai-codex` / `gpt-6.1-sol`.
- Ainda não visto depois destas correções: uma mensagem do aplicativo em si (o caminho foi testado pela linha de
  comando, que usa a mesma política de lançamento) e uma mensagem de voz respondida pelo Fable.
- Possível complemento, não feito: o par espelhado (modelo GPT no provedor do plugin), que o aplicativo poderia
  mandar se o modelo principal voltasse para o GPT.

**21/11/2026, 02:27–02:50 — limite de uso no meio do trabalho, e o que mudou por causa dele:**

- **O que aconteceu.** Às 02:27 a conta 20 bateu o limite da sessão de 5 h. O Swap trocou todos os serviços para a
  conta 22 às 02:27:24 (quem avisou foi a extensão do VS Code; o servidor não tinha lido a conta a tempo). O Hermes
  caiu para a reserva (GPT) e ficou nela: ele arma uma espera até o horário de reinício informado pelo provedor
  (`agent._rate_limited_until`, 73 min) e essa espera era da conta antiga.
- **Hermes volta ao modelo principal quando a conta muda.** Em `/opt/data/extra_pkgs/hermes_model_lock.py`, regra
  `apply_swap_account_recovery` (marcador `HERMES_CLAUDE_SWAP_RECOVERY_V1`): ao armar a espera no provedor do Claude
  Code, guarda a conta que estava no login (`oauthAccount.accountUuid` do `.claude.json` da pasta de login); no começo
  de cada mensagem seguinte, se o login já é de outra conta, responde "reabriu" em `_primary_quota_reopened_early` e o
  Hermes volta ao Fable. Mesma conta, login ilegível ou qualquer erro: comportamento original. Cópia de antes:
  `hermes_model_lock.py.antes-troca-20261121`. Simulada contra o código de verdade; gateway reiniciado às 02:49
  (esperou 3 min sem mensagens); conferido: WhatsApp e teste pela linha de comando respondidos pelo Fable.
  Ainda não visto ao vivo: um limite batendo de novo com a regra no ar.
- **O que continua igual:** na mensagem em que o limite bate, o Hermes ainda responde pela reserva; ele não avisa o
  Swap sozinho nem espera a troca. Com o servidor 2.5.4 (abaixo) a troca deve acontecer antes do limite na maioria
  das vezes.
- **Servidor do Swap 2.5.3 e 2.5.4 publicados (02:38 e 02:45)** pelo procedimento de sempre (imagem montada no
  servidor, `SWAP_PLUS_VERSAO` trocada pelo Portainer). 2.5.3: painel com "serviços" e estados de presença.
  2.5.4: a conta em uso é lida a tempo (ver `NOVIDADES-3.2.md` e `server/SPEC.md`). Voltar atrás: a mesma variável
  com `2.5.2` (a imagem continua no servidor).
- **Extensão 3.2.0 publicada às 02:42** (tag `plus-v3.2.0`), com o OK do dono.

Conferido depois da troca: uma mensagem de verdade pela API do gateway (o mesmo processo do WhatsApp) respondida pelo
`claude-fable-5-2[1m]` com uso de ferramenta, em 5,5 s, sem a trava trocar por GPT; e o cliente acompanhando sozinho
uma troca de conta decidida pelo Swap.

Ainda não conferido: uma conversa do WhatsApp em si (o gateway foi testado pela API dele, não por uma mensagem de
WhatsApp); se as conversas já abertas antes da troca mudam de modelo na hora ou só quando reiniciam (o Hermes reinicia
as sessões de madrugada); uma rotina (cron) com o provedor; a renovação do acesso durante a madrugada (o servidor
renova e o cliente regrava: o healthcheck acusa se falhar).

Para lembrar:

- o binário do Claude Code (360 MB) e a pasta de login ficam dentro de `/srv/hermes-personal/data`, então entram no
  backup do Hermes. Na pasta de login só há um acesso de até ~8 h, sem refresh token;
- o Claude Code não se atualiza sozinho ali (o plugin liga `DISABLE_AUTOUPDATER`). Para trocar de versão, repita o
  download com a versão e o checksum novos;
- na próxima vez que a imagem do Hermes for refeita, vale levar o binário para dentro dela, como no `comando-ia`
  (o trecho do Dockerfile está em [Ligar o Hermes](#ligar-o-hermes-roteiro), passo 1), e apagar o do volume;
- registrar no `central-comando-server`: a stack no `catalogo.json`, a linha na tabela de stacks e a nota datada
  (seção final deste arquivo).

O Swap Plus Cliente é o trabalho da extensão do VS Code sem o VS Code: um serviço a mais no Swap Plus, que
recebe do servidor o acesso da conta escolhida para ele e o grava numa pasta de login do Claude Code. O Hermes usa
essa pasta pelo plugin oficial `claude-subscription-directsdk`, que roda o executável oficial do Claude Code como
modelo. Funcionamento em [`../README.md`](../README.md).

Segue o padrão dos outros grupos do servidor: stack própria criada pelo Portainer, contêiner com teto de CPU, memória
e processos, rede própria, usuário sem privilégio, sistema de arquivos só de leitura.

## O que precisa do OK do Paulo

Pelas regras do servidor (`central-comando-server`), cada um destes pede confirmação na hora, e nada aqui vale como
autorização permanente:

- publicar código e implantar (os passos de [Instalação do cliente](#instalação-do-cliente));
- qualquer coisa que recrie ou reinicie o Hermes (os passos de [Ligar o Hermes](#ligar-o-hermes-roteiro));
- mudar a trava `gateway_model_lock`, que hoje troca modelo Claude por GPT no gateway do Hermes;
- o primeiro teste de verdade, que gasta uso de uma conta.

A instalação do cliente **não** gasta uso de conta (não chama a Anthropic) e **não** mexe no Hermes.

## O que fica onde

| o quê | onde |
| --- | --- |
| código (cópia deste repositório) | `/opt/swap-plus/app` (a mesma cópia do Swap Plus Servidor) |
| compose da stack | `/opt/swap-plus/app/cliente/deploy/compose.yaml` (o Portainer guarda a cópia que está valendo) |
| dados do cliente | `/opt/swap-plus-cliente/hermes/dados` — 10000:10000, 700. `conexao.json` é o acesso deste cliente ao Swap: **segredo** (pela API dá para trocar de conta, mudar regras e revogar serviços). Não entra no Hermes |
| pasta compartilhada com o Hermes | `/opt/swap-plus-cliente/hermes/login` — 10000:10000, 700. Dentro, `claude/` é a pasta de login do Claude Code |
| imagem | `swap-plus-cliente:<versão>`, construída no host; a versão está na variável `SWAP_PLUS_CLIENTE_VERSAO` da stack |
| rede | `swap-plus-cliente`, 10.88.3.0/24 — só este contêiner; sem porta no host |
| para onde ele fala | só `https://swap.assistentes.si` (Cloudflare → Caddy → Swap Plus), como a extensão e o `comando-ia` |
| usuário | 10000:10000, o do Hermes: os dois leem e gravam a mesma pasta de login |
| backup | nenhum: perdeu a pasta de dados, pareia de novo |
| logs | `docker logs swap-plus-cliente-hermes` (json-file, 3 × 5 MB) |

Por que a pasta compartilhada é a **mãe** (`login/`) e não a `login/claude/`: o Claude Code e o cliente travam o login
também por uma pasta ao lado, `claude.lock`. Os dois só enxergam a mesma trava se montarem a pasta de cima.

## Arquivos desta pasta

| arquivo | para quê |
| --- | --- |
| `Dockerfile` | a imagem (Node 22, sem dependências; contexto = raiz do repositório) |
| `compose.yaml` | a stack `swap-plus-cliente-hermes` |
| `preparar.sh` | prepara o host: rede, pastas, imagem. Sem `--apply` é só simulação |
| `entrar.sh` | conecta o cliente "Hermes (servidor)" com **login do Google**, como a extensão do VS Code: mostra um endereço para você abrir e entrar com o seu e-mail |
| `parear.sh` | o outro jeito de conectar: por código de conexão, sem navegador e sem mostrar segredo na tela |

## Instalação do cliente

Tudo como root, no servidor.

1. **Código.** Atualize a cópia do repositório (o cliente está na pasta `cliente/`):

   ```sh
   git -C /opt/swap-plus/app pull --ff-only      # ou copie o repositório, como na instalação do servidor
   ```

2. **Host.** Rede, pastas e imagem. Primeiro a simulação, depois valendo:

   ```sh
   sh /opt/swap-plus/app/cliente/deploy/preparar.sh
   sh /opt/swap-plus/app/cliente/deploy/preparar.sh --apply
   ```

3. **Conectar com o seu e-mail.** O mesmo login com Google da extensão do VS Code:

   ```sh
   bash /opt/swap-plus/app/cliente/deploy/entrar.sh --versao 1.0.0
   ```

   O script mostra um endereço. Abra no navegador (do computador ou do celular) e entre com a sua conta Google: a do
   administrador, ou uma liberada no painel em **Usuários**. O endereço vale 10 minutos. Pronto o login, o cliente
   passa a existir no Swap — no painel, em **Serviços**, ele aparece como "Hermes (servidor)" com o e-mail que
   conectou — e já grava o primeiro login do Claude Code na pasta compartilhada.

   O outro jeito, sem navegador (o código de conexão nasce dentro do contêiner do Swap e não aparece na tela; no
   painel o cliente aparece como "por código de conexão"):

   ```sh
   bash /opt/swap-plus/app/cliente/deploy/parear.sh --versao 1.0.0
   ```

   Os dois scripts recusam se já houver um `conexao.json`, e no fim mostram a situação. Se aparecer **sem conta**: no
   painel do Swap, em **Contas**, clique na linha da conta para abrir e vá em **Ajustes desta conta → Serviços
   permitidos**; libere as contas para "Hermes (servidor)" (um serviço novo não entra sozinho nas contas que têm
   lista própria). O aviso que os scripts e o cliente 1.0.0 mostram ainda diz "Computadores permitidos": é o nome
   antigo do mesmo ajuste.

4. **Stack.** Pela API do Portainer (primeiro a simulação), que confere imagem, rede, pastas e a conexão antes de
   criar:

   ```sh
   python3 /opt/swap-plus/app/cliente/deploy/portainer_stack_create_cliente.py --versao 1.0.0
   python3 /opt/swap-plus/app/cliente/deploy/portainer_stack_create_cliente.py --versao 1.0.0 --apply
   ```

   Ou pela tela: **Stacks → Add stack**, nome `swap-plus-cliente-hermes`, cole o `cliente/deploy/compose.yaml` e
   defina a variável `SWAP_PLUS_CLIENTE_VERSAO`. Criada pelo Portainer (API ou tela) a stack fica com controle total;
   pela linha de comando ficaria "Limited".

   **Pasta de login dentro dos dados do Hermes** (foi como se instalou em 20/11/2026, para não recriar o Hermes):
   crie a pasta de dentro do contêiner dele (`docker exec -u 10000 hermes mkdir -m 0700 /opt/data/swap-plus-login`)
   e passe `--login-dir /srv/hermes-personal/data/swap-plus-login` ao `preparar.sh`, ao `entrar.sh`/`parear.sh` e ao
   `portainer_stack_create_cliente.py`.

5. **Conferir.**

   ```sh
   docker ps --filter name=swap-plus-cliente-hermes --format '{{.Names}}  {{.Status}}'     # healthy em ~1 min
   docker exec swap-plus-cliente-hermes swap-plus-cliente status
   docker exec swap-plus node /app/server/src/cli.js devices                                # "Hermes (servidor)" na lista
   ```

   `status` deve dizer **em dia**, a conta e até quando o acesso vale. No painel do Swap o cliente aparece em
   **Serviços**. Sem o Hermes usando, ele aparece como **conectado · sem uso agora**: é o esperado no modo
   `auto` (ver [Presença](#presença-auto-ou-sempre)). Já a linha de comando do Swap (`cli.js devices` e
   `cli.js status`) mostra "visto há …" contando do último batimento, não do último contato: com o Hermes sem uso
   esse tempo cresce, e isso não quer dizer que o cliente caiu.

## Ligar o Hermes (roteiro)

Em 20/11/2026 o Hermes foi ligado por um caminho mais curto, sem recriar o contêiner
([Como está instalado](#como-está-instalado-20112026)): os passos 3, 4 e 5 abaixo foram executados; os passos 1 e 2
(Claude Code dentro da imagem e bind próprio da pasta de login) **não**, e ficam como o caminho para quando a imagem
do Hermes for refeita. Cada passo que recria ou reinicia o Hermes segue o procedimento de sempre (OK do Paulo,
drenar antes, fora de 01:00–05:30, `validar_hermes.sh` depois) e é registrado no `central-comando-server`.

**Onde escolher o Claude Code no Hermes:**

- **numa conversa** (WhatsApp, painel, aplicativo): `/model fable --provider claude-subscription-directsdk-experimental`
  (ou `opus`, `sonnet`, `haiku`). Vale só para aquela conversa; para voltar: `/model gpt-6.1-sol --provider openai-codex`;
- **numa rotina**: na tela **Cron** do painel, o provedor e o modelo da rotina;
- **como padrão de tudo**: na tela **Modelos** do painel, **Model Settings → Main model → Change**, provedor "Claude
  Subscription DirectSDK (Experimental)". Atenção: isso muda o modelo de todas as sessões novas, WhatsApp incluído (o
  botão **Switch model** da tela de chat do painel faz a mesma coisa). O provedor "Anthropic" da mesma lista é outro
  (chave de API) e continua sendo trocado por GPT pela trava.

1. **Claude Code dentro do contêiner do Hermes.** Hoje não há (`claude` saiu da imagem em 07/11 porque nada usava).
   O `npm` do contêiner é um atalho para a loja de ferramentas em `/opt/data/tools`, então `npm i -g` não serve. O
   caminho já usado no servidor é o do `apps/comando-ia/Dockerfile`: o binário nativo, fixado por sha256, dentro da
   imagem. No `stacks/hermes-personal/Dockerfile` do `central-comando-server`, antes do `ENV` final:

   ```dockerfile
   # Claude Code (binário nativo linux-x64 para glibc), fixado e conferido pelo checksum do manifesto oficial:
   # https://downloads.claude.ai/claude-code-releases/2.1.323/manifest.json -> platforms.linux-x64.checksum
   ARG CLAUDE_CODE_VERSION=2.1.323
   ARG CLAUDE_CODE_SHA256=604d29a6869409106b6a1110bdadcc8b72e8654a5a865d23258f938a696e348e
   RUN set -eu; \
       curl -fsSL --retry 3 -o /usr/local/bin/claude \
         "https://downloads.claude.ai/claude-code-releases/${CLAUDE_CODE_VERSION}/linux-x64/claude"; \
       echo "${CLAUDE_CODE_SHA256}  /usr/local/bin/claude" | sha256sum -c -; \
       chmod 0755 /usr/local/bin/claude
   ENV DISABLE_AUTOUPDATER=1
   ```

   A 2.1.323 era a versão "stable" em 20/11/2026 (a mais nova era a 2.1.330); o checksum acima é o do manifesto
   oficial, consultado nesse dia. Ela atende todos os modelos do plugin (README dele: Opus 5.5 → 2.1.280; Sonnet 5.5
   → 2.1.284; Haiku 5.5 → 2.1.293; Fable 5.2 → 2.1.321). O contêiner é Debian 13 (glibc 2.41, x86_64) e
   `/usr/local/bin` está no `PATH` dele. O binário tem uns 360 MB. Isso pede uma etiqueta nova da imagem do Hermes
   (por exemplo `hermes-personal-runtime:v0.23.0-contabo.2`) e as mudanças que acompanham uma etiqueta nova
   (variável `HERMES_RUNTIME_IMAGE`, o padrão no `hermes-release-watch` e nos scripts de release). Conferir a imagem
   antes de trocar: `docker run --rm --entrypoint /usr/local/bin/claude <imagem nova> --version`.

2. **A pasta de login dentro do Hermes.** Um bind a mais na stack `hermes`, com a pasta-mãe:

   ```yaml
       - type: bind
         source: /opt/swap-plus-cliente/hermes/login
         target: /opt/swap-plus-login
         bind:
           create_host_path: false
   ```

   Leitura e escrita: o Claude Code grava ali arquivos dele (`sessions/`, `policy-limits.json`…) e é por essas
   gravações que o cliente sabe que o Hermes está usando. Os passos 1 e 2 mudam a stack do Hermes: uma recriação só.

3. **O plugin.** Como o usuário do Hermes (uid 10000), de dentro do contêiner:

   ```sh
   H="docker exec -it -u 10000 hermes /opt/hermes/.venv/bin/hermes"     # -it: a instalação pode pedir confirmação
   $H plugins install claude-subscription-directsdk
   $H config set plugins.entries.claude-subscription-directsdk-experimental.settings.claude_config_dir /opt/swap-plus-login/claude
   ```

   Nunca `yes |` com `hermes plugins` (já encheu o disco uma vez). O plugin é marcado como experimental pelos autores
   (Nous Research) e pede Hermes 0.21.4 ou mais novo; o do servidor é 0.23.1, e o catálogo dele já oferece o plugin
   (versão 0.4.0; conferido com `hermes plugins search claude-subscription`). Se depois de instalar o provedor não
   aparecer no `hermes model`, reinicie só o gateway (`scripts/hermes/geise/reiniciar_hermes.sh`, que espera o
   Hermes ficar sem uso).

4. **A trava de modelo.** A regra `gateway_model_lock` (`/opt/data/extra_pkgs/hermes_model_lock.py`, no host
   `/srv/hermes-personal/data/extra_pkgs/`) troca por GPT, no gateway, toda sessão cujo provedor é `anthropic` **ou
   cujo modelo tem nome começando com `claude`**. O provedor do plugin não é `anthropic`, mas os modelos dele têm
   nomes como `claude-sonnet-5-5[1m]`: escolhido pelo gateway, o Claude Code seria trocado por GPT. Para valer, a
   regra precisa de uma exceção para o provedor do plugin, logo antes do `if` que decide a troca:

   ```python
           if provider.startswith("claude-subscription-directsdk"):
               return model, runtime
   ```

   Mudar essa regra é decisão do Paulo. Ela é carregada na subida do gateway: vale depois de reiniciá-lo (a
   recriação dos passos 1 e 2 já reinicia). Pela leitura do código, a trava só age nas sessões do gateway; o
   `hermes chat` pela linha de comando (o teste do passo 5) não passa por ela.

5. **Onde usar.** O Codex continua sendo o padrão. O Claude Code entra onde for escolhido: num perfil, numa rotina
   (cron) ou numa conversa, com o provedor `claude-subscription-directsdk-experimental` e o modelo (`sonnet`, `opus`,
   `fable`, `haiku`). Teste de uma linha, **que gasta uso da conta**:

   ```sh
   $H chat --oneshot -q "Responda só: ok" --provider claude-subscription-directsdk-experimental -m sonnet
   ```

O que conferir no primeiro teste:

- **Chave da API no ambiente.** A stack do Hermes tem chaves da Anthropic no `stack.env`. O README do plugin diz que
  ele tira `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` e `ANTHROPIC_FOUNDRY_API_KEY` do ambiente do Claude Code, para a
  chamada sair pela assinatura e não pela chave. As variáveis do servidor têm outros nomes (`FA_CLAUDE_API`,
  `FSC_CLAUDE_API`), mas confira com `/usage` no Hermes que a conta em uso é a do Swap.
- **O cliente percebe o uso.** Logo depois de uma resposta, `swap-plus-cliente status` deve mostrar **ativo**, e o
  painel do Swap, o cliente como **ativo agora**.
- **Consumo de memória.** Cada chamada do plugin sobe um processo do Claude Code de uns 250 MB (até 4 ao mesmo tempo,
  ajustável no plugin). O teto do Hermes hoje é folgado, mas vale olhar o `docker stats` na primeira rotina.

Dois limites conhecidos, para decidir com calma:

- **Quem conversa com o Hermes alcança a pasta de login.** Qualquer conversa com terminal lê
  `/opt/swap-plus-login/claude/.credentials.json`. Lá só há um acesso de até ~8 h, sem refresh token (o login de
  verdade nunca sai do Swap), mas é um acesso válido à conta da vez. É o mesmo tipo de exposição do login do Codex
  que já mora em `/opt/data`.
- **O Claude Code dentro do Hermes é só o modelo.** O plugin desliga as ferramentas próprias dele (`--tools ''`): quem
  executa ferramentas, pede aprovação e compacta a conversa continua sendo o Hermes.

## Presença: auto ou sempre

Variável `SWAP_PLUS_CLIENTE_PRESENCA` da stack (padrão `auto`).

- **auto**: o cliente só conta como serviço ativo no Swap enquanto o Hermes usa o Claude Code e por 10 minutos
  depois do último uso (o Swap ainda o considera ativo por mais 5). Parado, ele só consulta o servidor a cada 2 minutos para manter o login válido: não segura conta nem gasta
  o orçamento de leitura de uso. Se a conta dele precisar de decisão enquanto está parado (morreu, foi desativada,
  passou da linha de troca), ele manda um batimento avulso para o Swap decidir.
- **sempre**: ativo o tempo todo. Com a regra "Serviços: Separados", uma conta fica sempre ocupada pelo Hermes, e a
  leitura de uso dela (a cada 10 min longe de uma linha de troca, a cada 2,5 a 5 min perto de uma) pesa no orçamento de
  24 leituras por hora do Swap: de 6 a 16 das 24, e os outros serviços ativos dividem o resto.

Com a regra "Serviços: Juntos", um limite batido por um serviço troca a conta de todos os ativos, o Hermes
entre eles.

No painel do Swap (servidor 2.5.3 ou mais novo), em **Serviços**, o cliente aparece assim:

- **ativo agora**: enquanto o Hermes usa o Claude Code e por uns 15 minutos depois do último uso (os 10 do cliente
  mais os 5 do Swap). No modo `sempre`, o tempo todo;
- **conectado · sem uso agora**: o cliente está ligado e consultando o Swap, sem o Hermes usando (é o que o
  `status` do cliente chama de **parado**). É assim que ele fica entre uma tarefa e outra do Hermes, e está tudo
  certo: cada consulta conta como contato;
- **sem contato · visto …**: o cliente não fala com o Swap há mais de 5 minutos (contêiner parado, sem rede, ou em
  espera depois de um 403 ou de um 429). Veja [Operação](#operação);
- **aguardando contato · o servidor reiniciou há pouco**: só nos 5 minutos depois de o Swap reiniciar, até o cliente
  falar com ele de novo.

Ver o cliente ora como **ativo agora**, ora como **conectado · sem uso agora**, é o esperado: ele não desliga, só
passa de um para o outro conforme o Hermes usa ou não o Claude Code. Um batimento avulso também o deixa como
**ativo agora** por até 5 minutos.

## Operação

```sh
docker exec swap-plus-cliente-hermes swap-plus-cliente status          # situação
docker exec swap-plus-cliente-hermes swap-plus-cliente status --json   # a mesma, para script
docker exec swap-plus-cliente-hermes swap-plus-cliente trocar          # pede a melhor conta agora
docker exec swap-plus-cliente-hermes swap-plus-cliente trocar 3        # pede a conta 3
docker exec swap-plus-cliente-hermes swap-plus-cliente limite          # avisa que a conta bateu o limite
docker logs --since 1h swap-plus-cliente-hermes
```

O log só fala quando algo muda (conta trocada, login gravado, perdeu contato, voltou). O token do cliente e os
acessos das contas nunca vão para o log.

| situação | o que é | o que fazer |
| --- | --- | --- |
| em dia | o login gravado é o da conta atribuída e tem validade | nada |
| sem conta | o Swap não tem conta para este cliente | painel: Contas → Serviços permitidos; ver se há conta viva |
| sem contato com o servidor | rede, Swap fora do ar, 403 ou 429 | o login gravado segue valendo até vencer; o cliente tenta de novo sozinho (depois de 403 espera 5 min; de 429, 10 min). Passados 5 min sem falar com o Swap, o painel mostra o cliente como **sem contato** |
| acesso revogado | o Swap respondeu 401: o cliente foi revogado | parear de novo (abaixo). Revogado, ele **não chama mais** o servidor: 20 respostas 401 em 10 min bloqueiam o IP do servidor, que o `comando-ia` e o `casa-cameras` dividem |
| não pode gravar o login | há um login feito à mão na pasta (com refresh token) | apague esse login da pasta; o cliente não envia nem sobrescreve login manual |
| credencial ainda não gravada | a gravação falhou ou o login mudou durante ela | tenta de novo sozinho em até 1 min; se persistir, veja a mensagem no log (permissão da pasta?) |

**Parear de novo** (cliente revogado, pasta de dados perdida):

```sh
# pare a stack no Portainer; depois:
docker exec swap-plus node /app/server/src/cli.js devices        # ache o id do "Hermes (servidor)" antigo
docker exec swap-plus node /app/server/src/cli.js revoke <id>    # se ainda estiver lá
rm /opt/swap-plus-cliente/hermes/dados/conexao.json
bash /opt/swap-plus/app/cliente/deploy/parear.sh --versao <versão>
# suba a stack de novo no Portainer
```

**Atualizar a versão.** Código novo → etiqueta nova (nunca reconstruir por cima); mesmo número com código novo leva
sufixo (`1.0.0-2`):

```sh
git -C /opt/swap-plus/app pull --ff-only
sh /opt/swap-plus/app/cliente/deploy/preparar.sh --versao <nova> --apply
python3 /opt/server-contabo/scripts/hermes/portainer_stack_update.py --stack swap-plus-cliente-hermes \
  --set SWAP_PLUS_CLIENTE_VERSAO=<nova> --backup-dir /var/backups/portainer-stacks            # simulação
# ... e de novo com --apply. Se o compose mudou: --compose /opt/swap-plus/app/cliente/deploy/compose.yaml
```

Para voltar, o mesmo comando com a versão anterior. Trocar a versão do cliente não mexe no Hermes: durante os
segundos em que o cliente reinicia, o login gravado continua valendo.

**Tirar do ar.** Remova a stack no Portainer, revogue o cliente no Swap (`cli.js revoke <id>`) e apague
`/opt/swap-plus-cliente`. O login que estiver na pasta vence sozinho em algumas horas.

## Depois de instalar: registrar no repositório do servidor

No `central-comando-server`, junto com a subida (ou logo depois, nunca antes):

- a stack em `scripts/relatorio/catalogo.json` (senão aparece como "Não catalogado" no relatório);
- uma linha na tabela de stacks de `docs/administracao.md` e uma nota datada do que foi feito;
- a entrada em `andamento/status.json`;
- a decisão de backup: nenhum (re-parear recria tudo).
