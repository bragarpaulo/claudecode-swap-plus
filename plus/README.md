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
  e **Importar contas…**. O arquivo `.cswap` leva as contas e também as regras de troca, os avisos, a exibição, a troca automática
  ligada/desligada e os ajustes de cada conta (rotação, linha própria, prioridade). Não leva o caminho do executável nem o histórico.
  As credenciais vão em texto puro, com permissão só para o seu usuário: transfira e apague.
- **Troca automática** (começa desligada; liga na tela de Configurações). Padrão:
  - sessão de 5h em **90%**, semanal em **80%**, Fable em **95%**;
  - o limite do Fable só conta enquanto o Fable está em uso. O modelo em uso é lido das transcrições locais do Claude Code (últimos 30 min);
  - na troca, contas com Fable disponível têm preferência;
  - o modelo continua o mesmo depois da troca. A escolha de modelo fica no Claude Code, não na conta.
- **Tela de Configurações** (aba dentro do VS Code): sliders de “avisar em X%” e “trocar em Y%” para cada limite; estratégia
  (mais folga, **aproveitar ao máximo** ou por prioridade); por conta: rotação (contas que participam ficam contornadas de
  verde), linha própria da sessão, prioridade e apelido; histórico; simulação; atualizações da extensão.
- **Ordem das contas** (na tela e na lista da barra): primeiro as que participam da troca automática, de quem renova o semanal
  antes para quem renova depois; no fim, as que não participam, na mesma ordem. Opcional: ordenar pelo número da conta e mudar
  a posição com as setas ↑ ↓ (`swap-plus swap`).

A decisão de troca é da extensão (`decide()` em `extension.js`); quem executa a troca é o `swap-plus switch N`.
As regras ficam nas configurações do VS Code (`swapPlus.rules.*`). As configurações `autoswitch.*` do motor não são usadas.

## Instalar

Passo a passo completo, com Mac e Windows e como levar as contas para outro computador: **[MANUAL](../MANUAL.md)**.

- Mac: `curl -fsSL https://raw.githubusercontent.com/bragarpaulo/swap-plus-vscode/main/plus/scripts/install.sh | bash`
- Windows (PowerShell): `irm https://raw.githubusercontent.com/bragarpaulo/swap-plus-vscode/main/plus/scripts/install.ps1 | iex`

Os scripts instalam o `uv` se faltar, o motor (`swap-plus`, da última release de
[bragarpaulo/swap-plus](https://github.com/bragarpaulo/swap-plus/releases)) e a extensão (da última release
[daqui](https://github.com/bragarpaulo/swap-plus-vscode/releases)), e removem a extensão original se estiver instalada.
Para simular sem instalar: `--dry-run` no Mac; `$env:SWAP_PLUS_DRY_RUN = "1"` antes do comando no Windows.

## Atualizações

Seguem o esquema das extensões do VS Code. **Nada roda fora do VS Code**:

- **Na sua máquina**, a extensão verifica **ao abrir e ao fechar o VS Code** e a cada **2 dias**. Com **Extensions: Auto Update**
  ligado no VS Code, instala sozinha: o motor na hora; a extensão nova vale depois de recarregar a janela. Com ele desligado,
  só avisa. Ao fechar, só verifica: se houver versão nova, ela é instalada logo na próxima abertura.
  Dá para verificar à mão em **Configurações → Atualizações da extensão → Verificar agora**.
- **No GitHub**, o workflow `plus-sync.yml` do [fork do motor](https://github.com/bragarpaulo/swap-plus/actions) olha o
  claude-swap original a cada 2 dias. Quando sai uma versão **estável** (betas ficam de fora), ele monta o original + o comando
  `swap-plus`, roda a bateria de testes do original e só então publica a release `plus-vX.Y.Z`. Se a extensão percebe a versão
  nova antes, e o `gh` estiver logado na máquina, ela pede ao GitHub para rodar na hora.
- O workflow `plus-upstream.yml` daqui olha a extensão original a cada 2 dias e abre uma issue quando sai versão nova.
  O Swap Plus foi reescrito em `plus/`, então nada entra sozinho: a issue é para avaliar se há algo a portar.
- O workflow `plus-install-test.yml` instala tudo num Mac e num Windows limpos do GitHub (com o VS Code) sempre que os
  instaladores mudam ou sai versão nova da extensão.

Publicar uma versão nova da extensão: subir a `version` em `plus/package.json`, commit, e
`git tag plus-vX.Y.Z && git push origin main plus-vX.Y.Z`. O workflow `plus-release.yml` testa, empacota e publica;
as instalações se atualizam sozinhas.

## Estrutura

| Caminho | O que é |
| --- | --- |
| `plus/extension.js` | a extensão (barra de status, alertas, troca automática, export/import) |
| `plus/updater.js` | as atualizações (motor e extensão) |
| `plus/media/` | a tela de Configurações |
| `plus/test/smoke.js` | `--unit`: regra de troca, textos e atualizador com dados simulados; sem flag: também contra o `swap-plus` real (grava e desfaz) |
| `plus/scripts/install.sh` / `install.ps1` | instalação a partir das releases (Mac / Windows) |
| `plus/scripts/dev-install.sh` | empacota a partir deste código e instala (desenvolvimento) |
| `.github/workflows/plus-*.yml` | publicar a extensão, testar a instalação e avisar sobre a original |
| `../MANUAL.md` | o passo a passo para instalar e levar as contas para outro computador |
| raiz do repositório | código do claude-swap-status original, só como referência |

Branch único: `main`.
