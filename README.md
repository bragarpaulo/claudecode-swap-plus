# Swap Plus

Mostra o uso das suas contas do Claude Code na barra de status do VS Code e troca de conta sozinho quando uma
delas chega perto do limite: sessão de 5 horas, limite semanal e limite semanal do Fable.

```
│  ✉  Sessão (5h): 2% usado — renova hoje 15h  ·  Semanal: 30% usado — renova hoje 18h  ·  Fable: 57% usado — renova hoje 18h  │
```

O Swap Plus tem três partes, as três neste repositório:

- a **extensão do VS Code** (código em [`plus/`](plus/)), instalada em cada computador, no Mac e no Windows. Ela se
  atualiza sozinha, dentro do VS Code;
- o **servidor Swap Plus** (código em [`server/`](server/)), que guarda e renova os logins de todas as contas, decide
  as trocas para todos os **serviços** conectados (cada VS Code, o Hermes) e tem um painel no navegador (contas,
  serviços, usuários e regras de troca);
- o **Swap Plus Cliente** (código em [`cliente/`](cliente/)), novo na 3.2 ([NOVIDADES-3.2.md](NOVIDADES-3.2.md)): faz
  o trabalho da extensão sem o VS Code, para o Hermes e outros serviços em segundo plano usarem o Claude Code com as
  mesmas contas. Manual em [`cliente/README.md`](cliente/README.md).

O que mudou por último (nome de serviço único, aviso e limite uma vez por computador, painel mais leve e o ambiente
local de testes): [NOVIDADES-3.6.md](NOVIDADES-3.6.md). Antes: a conta segue o modelo que cada serviço usa
([NOVIDADES-3.5.md](NOVIDADES-3.5.md)); modelo preferido e secundário no painel ([NOVIDADES-3.4.md](NOVIDADES-3.4.md)).
Antes disso (a conversa que parou no limite retoma sozinha depois da troca): [NOVIDADES-3.3.md](NOVIDADES-3.3.md).
O que mudou na 3.0: [NOVIDADES-3.0.md](NOVIDADES-3.0.md).

## Instalar

O passo a passo completo está no **[MANUAL](MANUAL.md)**. Em resumo, um comando instala a extensão:

- **Mac** (Terminal):

  ```bash
  curl -fsSL https://raw.githubusercontent.com/bragarpaulo/claudecode-swap-plus/main/plus/scripts/install.sh | bash
  ```

- **Windows** (PowerShell):

  ```powershell
  irm https://raw.githubusercontent.com/bragarpaulo/claudecode-swap-plus/main/plus/scripts/install.ps1 | iex
  ```

Depois, abra o VS Code, clique no Swap Plus na barra de baixo e, no aviso que aparece, em **Entrar com Google**.

## Ambiente local (desenvolvimento e testes)

Tudo roda nesta máquina, com **dados simulados**: sem banco, sem conta, servidor ou credencial de verdade e **sem nada
saindo para a internet**. Só precisa do Node 22 ou mais novo (nada para instalar com npm).

```bash
node dev/ambiente-local.js            # sobe o ambiente (Ctrl+C encerra)
```

Sobe o **servidor Swap Plus de verdade** (`server/src/server.js`: API e painel em `http://127.0.0.1:3008/`, admin em
`127.0.0.1:3009`) falando com um **Anthropic e um Google falsos** (`dev/simulado/fora-falso.js`, em
`127.0.0.1:3010`). Na primeira vez, o cofre recebe os dados de [`dev/simulado/dados.json`](dev/simulado/dados.json)
(4 contas `conta1@local.test`…`conta4@local.test`, tokens `sk-ant-oat01-SIMULADO-…`, a conta Google liberada
`pessoa@local.test` e o serviço "Hermes (simulado)"); rodar de novo não repete nada. O terminal mostra o endereço do
painel, um **código de conexão** e como mudar o uso de uma conta ao vivo (`POST /_simular/uso`). No painel, entre com
"Entrar com Google" e escolha **admin@local.test** no Google simulado.

| Comando | O que faz |
| --- | --- |
| `node dev/ambiente-local.js` (ou `subir`) | sobe o ambiente (portas 3008, 3009 e 3010, ou as de `--portas`; porta ocupada: diz qual e sai) |
| `node dev/ambiente-local.js testes` | roda tudo offline: `node --check`, `plus/test/smoke.js --unit`, as suítes da extensão, do servidor e do cliente e a conferência de design (`dev/conferir-design.js`). Resumo por suíte, com quantas conexões para fora foram bloqueadas (o esperado é 0) |
| `node dev/ambiente-local.js medir` | medidas de desempenho antes (`origin/main`) × depois (este código), na mesma execução; grava `medidas.json` na pasta do ambiente (`dev/.dados/` ou `dev/.dados/portas-A/`) |
| `node dev/ambiente-local.js cliente` | o Swap Plus Cliente contra o servidor local: pareia e faz um ciclo, com `HOME` e `CLAUDE_CONFIG_DIR` em `dev/.dados/cliente/` (`--dados dev/.dados/<outra>` e `--nome <nome>` mudam a pasta e o nome) |
| `node dev/ambiente-local.js vscode` | abre o VS Code (Extension Development Host) com a extensão de `plus/`, com perfil, `HOME`, `CLAUDE_CONFIG_DIR` e `TMPDIR` em `dev/.dados/` e o servidor local nas configurações. Precisa do VS Code (`code` no PATH ou `CODE_BIN=<pasta>/bin/code`); sem ele, mostra como instalar e sai com código 2. Sem tela: `xvfb-run -a node dev/ambiente-local.js vscode --no-sandbox` |
| `node dev/ambiente-local.js limpar` | apaga `dev/.dados/` (pede confirmação; `--sim` pula), menos os ambientes de outras portas (`dev/.dados/portas-*`, que se apagam com `limpar --portas …`). Não mexe em mais nada |

- **Nada sai para a internet:** todo processo Node iniciado pelo ambiente carrega [`dev/sem-internet.js`](dev/sem-internet.js),
  que recusa (`ENETUNREACH`) qualquer conexão fora de `127.0.0.1`, `::1` e `localhost` e anota cada tentativa
  (`[sem-internet] bloqueado: <host>:<porta>`). Para usar em outro comando:
  `NODE_OPTIONS=--require=./dev/sem-internet.js node ...` (ou `NODE_OPTIONS="--require ./dev/sem-internet.js"`, com aspas).
- **F5 no VS Code** (com este repositório aberto, configuração "Swap Plus (plus/) — ambiente local") abre a extensão de
  `plus/` num **VS Code separado**, com o mesmo perfil isolado do subcomando `vscode` (`--user-data-dir` e
  `--extensions-dir` em `dev/.dados/vscode/`) — nunca como janela do VS Code em que você apertou F5, que herdaria o seu
  perfil (configurações e segredos, inclusive o acesso de um servidor de verdade). Para parar em breakpoints, use
  "Swap Plus (plus/) — ambiente local + depurador" (anexa ao host pela porta 9339). Outras portas: defina
  `SWAP_PLUS_PORTAS` antes de abrir o VS Code. Suba o ambiente (`node dev/ambiente-local.js`) antes de conectar.
- **Outras portas** (dois ambientes na mesma pasta): `--portas 3018,3019,3020` em qualquer subcomando (ou
  `SWAP_PLUS_PORTAS=3018,3019,3020`). Os dados desse ambiente ficam em `dev/.dados/portas-3018/`; use o mesmo `--portas`
  no `cliente`, no `vscode` e no `limpar` dele.
- **O uso muda no ritmo de verdade:** depois de um `POST /_simular/uso`, o servidor só relê a conta no próximo ciclo
  dela (conta em uso perto de uma linha: 2,5 min; longe das linhas: 10 min; as outras: 20 min).
- **Conferir a compressão:** a API não responde `HEAD` (`curl -I` recebe 405); use GET mostrando os cabeçalhos:
  `curl -s -D - -o /dev/null -H 'Accept-Encoding: gzip' http://127.0.0.1:3008/static/app.js`.
- Tudo o que o ambiente grava fica em `dev/.dados/` (fora do git).

## Como o projeto está organizado

| Pasta | O que é |
| --- | --- |
| [`plus/`](plus/) | a extensão Swap Plus e os instaladores (`plus/scripts/`). Detalhes, regras de troca e como publicar uma versão nova: [`plus/README.md`](plus/README.md) |
| [`server/`](server/) | o servidor Swap Plus (Node, em Docker) e o painel web. Especificação em [`server/SPEC.md`](server/SPEC.md) e [`server/WEB-SPEC.md`](server/WEB-SPEC.md); instalação e operação em [`server/deploy/LEIA-ME.md`](server/deploy/LEIA-ME.md) |
| [`cliente/`](cliente/) | o Swap Plus Cliente (Node, sem dependências): o trabalho da extensão sem o VS Code, para o Hermes e outros serviços. Manual em [`cliente/README.md`](cliente/README.md); instalação no servidor (Docker) em [`cliente/deploy/LEIA-ME.md`](cliente/deploy/LEIA-ME.md) |
| [`dev/`](dev/) | o ambiente local com dados simulados (ver "Ambiente local", acima) |
| [`.github/workflows/`](.github/workflows/) | `plus-release.yml` (testa e publica a extensão), `plus-install-test.yml` (instala num Mac e num Windows limpos) e `server-ci.yml` (testes e imagem do servidor) |

**O motor foi aposentado.** Até a 2.x existia também o motor, o comando `swap-plus` (CLI Python, fork do
[claude-swap](https://github.com/realiti4/claude-swap)), num repositório próprio, que foi **apagado**. A 3.0 não usa mais o motor
nem o modo local: o instalador e a própria extensão removem o motor antigo dos computadores.

A extensão começou do [claude-swap-status](https://github.com/smith89k/claude-swap-status) e foi reescrita em
[`plus/`](plus/). Os arquivos na raiz fora de `plus/`, `server/` e `cliente/` (`src/`, `dist/`, `package.json`…) são
o código desse original, mantidos só como referência. O Swap Plus não usa esses arquivos.

## Licença

MIT, como os projetos de onde o Swap Plus veio: claude-swap-status (smith89k) e claude-swap (realiti4). Não é um
produto da Anthropic; "Claude" é marca da Anthropic.
