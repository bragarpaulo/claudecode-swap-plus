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

## Como o projeto está organizado

| Pasta | O que é |
| --- | --- |
| [`plus/`](plus/) | a extensão Swap Plus e os instaladores (`plus/scripts/`). Detalhes, regras de troca e como publicar uma versão nova: [`plus/README.md`](plus/README.md) |
| [`server/`](server/) | o servidor Swap Plus (Node, em Docker) e o painel web. Especificação em [`server/SPEC.md`](server/SPEC.md) e [`server/WEB-SPEC.md`](server/WEB-SPEC.md); instalação e operação em [`server/deploy/LEIA-ME.md`](server/deploy/LEIA-ME.md) |
| [`cliente/`](cliente/) | o Swap Plus Cliente (Node, sem dependências): o trabalho da extensão sem o VS Code, para o Hermes e outros serviços. Manual em [`cliente/README.md`](cliente/README.md); instalação no servidor (Docker) em [`cliente/deploy/LEIA-ME.md`](cliente/deploy/LEIA-ME.md) |
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
