# Swap Plus (extensão do VS Code)

Mostra o uso do Claude Code na barra de status e troca de conta sozinha quando uma conta chega perto do limite.
Fork pessoal de [smith89k/claude-swap-status](https://github.com/smith89k/claude-swap-status) (MIT). Usa o CLI
[`swap-plus`](https://github.com/bragarpaulo/swap-plus), fork do claude-swap.

## O que tem

- **Barra de status**: `✉ | 5h: █░░░░ 12% R:2h | 7d: █░░░░ 27% R:8h | Fable: ░░░░░ 1%`. O e-mail não aparece; passe o mouse no ícone para ver.
- **Clique na barra**: lista as contas (a em uso vem marcada), com **Configurações** como primeira opção.
- **Tela de Configurações** (aba dentro do VS Code):
  - regras com slider para cada limite — janela de 5h, semanal e semanal do Fable: *avisar em X%* e *trocar de conta em Y%*;
  - para qual conta ir: mais folga, semanal primeiro, **aproveitar ao máximo** (gasta antes a cota que está prestes a zerar) ou por prioridade;
  - por conta: participa ou não da troca automática, limite próprio de 5h, prioridade, apelido, “usar esta conta”;
  - histórico de trocas e alertas; botão de simulação (mostra o que faria, sem trocar).

A troca automática roda enquanto o VS Code está aberto e começa **desligada**.

## Instalar

```bash
# 1) motor
uv tool install --force "git+https://github.com/bragarpaulo/swap-plus@plus"
swap-plus add          # com a conta logada no Claude Code; repita para cada conta

# 2) extensão
git clone https://github.com/bragarpaulo/swap-plus-vscode && cd swap-plus-vscode
plus/scripts/install.sh   # empacota e instala no VS Code
```

Depois: `Cmd+Shift+P` → **Developer: Reload Window**.

## Atualizações

`plus/scripts/swap-plus-update.sh` traz cada versão **estável** nova dos projetos originais para os dois forks
(betas ficam de fora) e reinstala o motor aqui, depois de um build de teste e do teste da extensão.

```bash
plus/scripts/swap-plus-update.sh --check   # só verifica
plus/scripts/swap-plus-update.sh           # sincroniza e reinstala o que mudou
plus/scripts/schedule.sh                   # agenda para todo dia às 10:15 (launchd)
plus/scripts/schedule.sh --remove          # desfaz o agendamento
```

O script espera os dois repositórios lado a lado (`swap-plus/` e `swap-plus-vscode/`). Log em `~/Library/Logs/swap-plus-update.log`.

O agendamento usa cópias próprias dos dois forks em `~/.local/share/swap-plus` (o macOS não deixa tarefas em
segundo plano lerem `~/Documents`). Elas acompanham o que estiver publicado no branch `plus` de cada fork.

A extensão original é só a parte visual, e a daqui foi reescrita em `plus/`. Por isso, quando o original muda,
o código dele entra no fork mas a tela do Plus não muda sozinha: o script avisa, para avaliar se há algo a portar.

## Estrutura

| Caminho | O que é |
| --- | --- |
| `plus/extension.js` | a extensão (barra de status, alertas, troca automática) |
| `plus/media/` | a tela de Configurações |
| `plus/test/smoke.js` | teste contra o `swap-plus` real: `npm test` (grava e desfaz) ou `npm run test:readonly` |
| `plus/scripts/` | instalar, atualizar, agendar |
| raiz do repositório | código do projeto original, sem alterações |

Branches: `main` espelha o original; `plus` (padrão) é esta versão.
