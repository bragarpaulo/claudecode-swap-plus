# Swap Plus — extensão do VS Code

Mostra o uso das suas contas do Claude Code na barra de status do VS Code e troca de conta sozinha quando
uma delas chega perto do limite: sessão de 5 horas, limite semanal e limite semanal do Fable.

```
│  ✉  Sessão (5h): 2% usado — renova hoje 15h  ·  Semanal: 30% usado — renova hoje 18h  ·  Fable: 57% usado — renova hoje 18h  │
```

- **Clique na barra:** lista as contas, com a que está em uso marcada, e as **Configurações**.
- **Configurações:** regras de aviso e de troca com sliders, estratégia (mais folga, aproveitar ao máximo ou
  por prioridade), ordem e ajustes de cada conta, modo privado, exportar e importar contas, atualizações.
- **Funciona no Mac e no Windows** e se atualiza sozinha, dentro do VS Code.

## Instalar

O passo a passo completo, incluindo como levar as contas para outro computador, está no
**[MANUAL](MANUAL.md)**. Em resumo, um comando instala o motor e a extensão:

- **Mac** (Terminal):

  ```bash
  curl -fsSL https://raw.githubusercontent.com/bragarpaulo/swap-plus-vscode/main/plus/scripts/install.sh | bash
  ```

- **Windows** (PowerShell):

  ```powershell
  irm https://raw.githubusercontent.com/bragarpaulo/swap-plus-vscode/main/plus/scripts/install.ps1 | iex
  ```

## Como o projeto está organizado

| Repositório | O que é |
| --- | --- |
| **este** — [bragarpaulo/swap-plus-vscode](https://github.com/bragarpaulo/swap-plus-vscode) | a extensão Swap Plus (código em [`plus/`](plus/)), o manual e os instaladores |
| [bragarpaulo/swap-plus](https://github.com/bragarpaulo/swap-plus) | o motor: o comando `swap-plus`, que guarda as contas e faz a troca |

Os dois são forks e acompanham os projetos originais:

- o **motor** vem do [claude-swap](https://github.com/realiti4/claude-swap). A cada 2 dias o GitHub confere se
  saiu versão estável nova; se saiu, roda os testes do original e publica a versão do Swap Plus, que a extensão
  instala sozinha;
- a **extensão** começou do [claude-swap-status](https://github.com/smith89k/claude-swap-status) e foi
  reescrita em [`plus/`](plus/). Quando o original lança versão nova, o GitHub abre um aviso (issue) aqui para
  avaliar se há algo a trazer.

Detalhes da extensão, regras de troca e como publicar uma versão nova: [`plus/README.md`](plus/README.md).

Os arquivos na raiz fora de `plus/` (`src/`, `dist/`, `package.json`…) são o código do claude-swap-status
original, mantidos como referência para comparar com as versões novas dele. O Swap Plus não usa esses arquivos.

## Licença

MIT, como os dois projetos originais: claude-swap-status (smith89k) e claude-swap (realiti4). Não é um
produto da Anthropic; "Claude" é marca da Anthropic.
