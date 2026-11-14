# Swap Plus (extensão do VS Code)

Mostra o uso do Claude Code na barra de status e troca de conta sozinha quando uma conta chega perto do limite.
Fork pessoal de [smith89k/claude-swap-status](https://github.com/smith89k/claude-swap-status) (MIT). Usa o CLI
[`swap-plus`](https://github.com/bragarpaulo/swap-plus), fork do claude-swap.

## O que tem

- **Barra de status**: `✉  Sessão █░░░░ 20%  Semanal █░░░░ 29%  Fable ░░░░░ 4%`. O e-mail não aparece; passe o mouse no ícone para ver.
  Cada item muda de cor sozinho: verde abaixo de 70%, amarelo a partir de 70%, vermelho na linha de troca.
- **Clique na barra**: lista as contas (a em uso com ✓). Em cima, conta e e-mail; embaixo, menor:
  `🟢 Sessão 5h sobra 80% · 🟡 Semanal 71% · 🟢 Fable 57% usados, renovam hoje 18h`. **Configurações** é a primeira opção.
- **Troca automática** (começa desligada; liga na tela de Configurações). Padrão:
  - sessão de 5h em **90%**, semanal em **80%**, Fable em **95%**;
  - o limite do Fable só conta enquanto o Fable está em uso. O modelo em uso é lido das transcrições locais do Claude Code (últimos 30 min);
  - na troca, contas com Fable disponível têm preferência;
  - o modelo continua o mesmo depois da troca. A escolha de modelo fica no Claude Code, não na conta.
- **Tela de Configurações** (aba dentro do VS Code): sliders de “avisar em X%” e “trocar em Y%” para cada limite; estratégia
  (mais folga, **aproveitar ao máximo** ou por prioridade); por conta: rotação, linha própria da sessão, prioridade e apelido;
  histórico; simulação.

A decisão de troca é da extensão (`decide()` em `extension.js`); quem executa a troca é o `swap-plus switch N`.
As regras ficam nas configurações do VS Code (`swapPlus.rules.*`). As configurações `autoswitch.*` do motor não são usadas.

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
| `plus/test/smoke.js` | regra de decisão com contas simuladas + teste contra o `swap-plus` real: `npm test` (grava e desfaz) ou `npm run test:readonly` |
| `plus/scripts/` | instalar, atualizar, agendar |
| raiz do repositório | código do projeto original, sem alterações |

Branches: `main` espelha o original; `plus` (padrão) é esta versão.
