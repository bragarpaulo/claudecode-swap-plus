# Swap Plus Cliente no Contabo — o cliente do Hermes: instalação e operação

Escrito em 20/11/2026. **Ainda não instalado no servidor**: este arquivo é o roteiro. A imagem, a stack e os dois
scripts desta pasta foram escritos e revisados, mas **não rodaram** (o computador em que foram escritos não tem
Docker); a primeira instalação é também o primeiro teste deles. O código do cliente, esse sim, tem testes
automáticos (`node --test cliente/test/*.test.js`).

O Swap Plus Cliente é o trabalho da extensão do VS Code sem o VS Code: um "computador" a mais no Swap Plus, que
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
| dados do cliente | `/opt/swap-plus-cliente/hermes/dados` — 10000:10000, 700. `conexao.json` é o acesso deste cliente ao Swap: **segredo** (pela API dá para trocar de conta, mudar regras e revogar computadores). Não entra no Hermes |
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
   passa a existir no Swap — no painel, em **Computadores**, ele aparece como "Hermes (servidor)" com o e-mail que
   conectou — e já grava o primeiro login do Claude Code na pasta compartilhada.

   O outro jeito, sem navegador (o código de conexão nasce dentro do contêiner do Swap e não aparece na tela; no
   painel o cliente aparece como "conectado por código"):

   ```sh
   bash /opt/swap-plus/app/cliente/deploy/parear.sh --versao 1.0.0
   ```

   Os dois scripts recusam se já houver um `conexao.json`, e no fim mostram a situação. Se aparecer **sem conta**: no
   painel do Swap, **Contas → Ajustes desta conta → Computadores permitidos**, libere as contas para "Hermes
   (servidor)" (um computador novo não entra sozinho nas contas que têm lista própria).

4. **Stack.** No Portainer: **Stacks → Add stack**, nome `swap-plus-cliente-hermes`, cole o
   `cliente/deploy/compose.yaml` e defina a variável `SWAP_PLUS_CLIENTE_VERSAO` (a mesma versão do passo 3). Criada
   pelo Portainer a stack fica com controle total; pela linha de comando ficaria "Limited".

5. **Conferir.**

   ```sh
   docker ps --filter name=swap-plus-cliente-hermes --format '{{.Names}}  {{.Status}}'     # healthy em ~1 min
   docker exec swap-plus-cliente-hermes swap-plus-cliente status
   docker exec swap-plus node /app/server/src/cli.js devices                                # "Hermes (servidor)" na lista
   ```

   `status` deve dizer **em dia**, a conta e até quando o acesso vale. No painel do Swap o cliente aparece em
   **Computadores**. Parado (sem o Hermes usando), ele aparece como visto há alguns minutos: é o esperado no modo
   `auto` (ver [Presença](#presença-auto-ou-sempre)).

## Ligar o Hermes (roteiro)

**Nada desta seção foi executado nem testado.** É o que falta do lado do Hermes, com o que já se sabe do servidor.
Cada passo que recria ou reinicia o Hermes segue o procedimento de sempre (OK do Paulo, drenar antes, fora de
01:00–05:30, `validar_hermes.sh` depois) e é registrado no `central-comando-server`.

1. **Claude Code dentro do contêiner do Hermes.** Hoje não há (`claude` saiu da imagem em 07/11 porque nada usava).
   O `npm` do contêiner é um atalho para a loja de ferramentas em `/opt/data/tools`, então `npm i -g` não serve. O
   caminho já usado no servidor é o do `apps/comando-ia/Dockerfile`: o binário nativo, fixado por sha256, dentro da
   imagem, com `DISABLE_AUTOUPDATER=1`. Isso pede uma etiqueta nova da imagem do Hermes (por exemplo
   `hermes-personal-runtime:v0.23.0-contabo.2`) e as mudanças que acompanham uma etiqueta nova (variável
   `HERMES_RUNTIME_IMAGE`, o padrão no `hermes-release-watch` e nos scripts de release). O plugin pede uma versão
   mínima do Claude Code por modelo (README dele: Opus 5.5 → 2.1.280; Sonnet 5.5 → 2.1.284; Haiku 5.5 → 2.1.293;
   Fable 5.2 → 2.1.321).

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
   H="docker exec -u 10000 hermes /opt/hermes/.venv/bin/hermes"
   $H plugins install claude-subscription-directsdk
   $H config set plugins.entries.claude-subscription-directsdk-experimental.settings.claude_config_dir /opt/swap-plus-login/claude
   ```

   Nunca `yes |` com `hermes plugins` (já encheu o disco uma vez). O plugin é marcado como experimental pelos autores
   (Nous Research) e pede Hermes 0.21.4 ou mais novo; o do servidor é 0.23.1.

4. **A trava de modelo.** A regra `gateway_model_lock` do `sitecustomize` do Hermes troca qualquer modelo
   Claude/Anthropic do gateway por GPT via Codex. Enquanto ela valer, escolher o Claude Code não tem efeito no
   gateway. Abrir uma exceção para o provedor `claude-subscription-directsdk-experimental` é decisão do Paulo (o módulo
   `hermes_model_lock.py` fica só no servidor).

5. **Onde usar.** O Codex continua sendo o padrão. O Claude Code entra onde for escolhido: num perfil, numa rotina
   (cron) ou numa conversa, com o provedor `claude-subscription-directsdk-experimental` e o modelo (`sonnet`, `opus`,
   `fable`, `haiku`). Teste de uma linha, **que gasta uso da conta**:

   ```sh
   $H --provider claude-subscription-directsdk-experimental -m sonnet chat -q "Responda só: ok"
   ```

   (confira a forma exata do comando na versão do Hermes instalada; o README do plugin mostra
   `hermes --provider claude-subscription-directsdk-experimental -m sonnet`.)

O que conferir no primeiro teste:

- **Chave da API no ambiente.** A stack do Hermes tem chaves da Anthropic no `stack.env`. O README do plugin diz que
  ele tira `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` e `ANTHROPIC_FOUNDRY_API_KEY` do ambiente do Claude Code, para a
  chamada sair pela assinatura e não pela chave. As variáveis do servidor têm outros nomes (`FA_CLAUDE_API`,
  `FSC_CLAUDE_API`), mas confira com `/usage` no Hermes que a conta em uso é a do Swap.
- **O cliente percebe o uso.** Logo depois de uma resposta, `swap-plus-cliente status` deve mostrar **ativo**, e o
  painel do Swap, o cliente visto "agora".
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

- **auto**: o cliente só conta como computador ativo no Swap enquanto o Hermes usa o Claude Code e por 10 minutos
  depois do último uso (o Swap ainda o considera ativo por mais 5). Parado, ele só consulta o servidor a cada 2 minutos para manter o login válido: não segura conta nem gasta
  o orçamento de leitura de uso. Se a conta dele precisar de decisão enquanto está parado (morreu, foi desativada,
  passou da linha de troca), ele manda um batimento avulso para o Swap decidir.
- **sempre**: ativo o tempo todo. Com a regra "computadores separados", uma conta fica sempre ocupada pelo Hermes, e a
  leitura de uso dela (a cada 3 min) pesa no orçamento de 24 leituras por hora do Swap, que os outros computadores
  ativos dividem.

Com a regra "computadores juntos", um limite batido por um computador troca a conta de todos os ativos, o Hermes
entre eles.

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
| sem conta | o Swap não tem conta para este cliente | painel: Contas → Computadores permitidos; ver se há conta viva |
| sem contato com o servidor | rede, Swap fora do ar, 403 ou 429 | o login gravado segue valendo até vencer; o cliente tenta de novo sozinho (depois de 403 espera 5 min; de 429, 10 min) |
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
