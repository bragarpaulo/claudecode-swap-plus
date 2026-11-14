# Swap Plus (extensão do VS Code)

Mostra o uso do Claude Code na barra de status e troca de conta sozinha quando uma conta chega perto do limite.
Fork pessoal de [smith89k/claude-swap-status](https://github.com/smith89k/claude-swap-status) (MIT). Usa o CLI
[`swap-plus`](https://github.com/bragarpaulo/swap-plus), fork do claude-swap.

## O que tem

- **Barra de status**: um único item, com uma barra fina de cada lado:
  `│  ✉  Sessão (5h): 2% usado — renova hoje 15h  ·  Semanal: 30% usado — renova hoje 18h  ·  Fable: 57% usado — renova hoje 18h  │`.
  O e-mail não aparece; passe o mouse para ver. O item fica amarelo a partir de 70% e vermelho na linha de troca (vale o limite mais perto do fim).
- **Clique na barra**: lista as contas (a em uso com ✓), com **Configurações** em primeiro. Em cima: `Conta 1 — e-mail` e, mais claro, a sessão;
  embaixo: `Semanal: 30% usado — renova hoje 18h  ·  Fable: 57% usado — renova hoje 18h`. As três partes juntas não cabem numa linha da lista do VS Code.
- **Modo privado**: mostra só “Conta 1”, “Conta 2”… sem e-mail, apelido ou organização. Liga sozinho ao importar um **Export Other**.
  Só muda o que o Swap Plus mostra: o painel de conta do Claude Code e o `swap-plus list` continuam mostrando o e-mail.
- **Exportar / importar** (em Configurações): **Export Other** (o outro computador entra em modo privado), **Export Me** (com e-mails)
  e **Importar contas…**. O arquivo `.cswap` leva as credenciais em texto puro, com permissão só para o seu usuário: transfira e apague.
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
