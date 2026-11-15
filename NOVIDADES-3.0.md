# Novidades do Swap Plus 3.0

O que mudou da versão 2.x para a 3.0. Passo a passo completo no [MANUAL](MANUAL.md).

## O que mudou

- **Só servidor.** O Swap Plus agora é só a extensão do VS Code + o servidor (**https://swap.assistentes.si**). O modo
  local acabou: todo computador se conecta ao servidor, que é o único que guarda e renova os logins.
- **Motor removido sozinho.** O motor antigo (o comando `swap-plus`) não é mais usado. Com o computador conectado ao
  servidor, a extensão o remove e avisa. O repositório dele foi arquivado. A pasta `~/.claude-swap-backup` (cópias
  antigas dos logins do modo local) não é apagada: com todas as contas no servidor, pode apagar à mão (veja
  [Veio da versão 2.x?](MANUAL.md#veio-da-versão-2x)).
- **Instaladores só da extensão.** O comando de instalação baixa e instala só a extensão (não instala mais o `uv` nem
  o motor). Se encontrar o motor antigo, remove e avisa na tela.
- **Começar ficou mais curto:** instalar → abrir o VS Code → clicar no Swap Plus na barra de baixo → **Entrar com
  Google**, no aviso que aparece.
- **Contas novas só pelo servidor:** no painel (**Contas** → **+ Adicionar conta**) ou com `/login` no Claude Code de
  um computador do administrador. Saíram o exportar e importar contas (arquivo `.cswap`) e, da lista de comandos do
  VS Code, **Swap Plus: Adicionar conta**, **Export Me**, **Export Other** e **Importar contas**.
- **Regras só no servidor.** As regras de troca não ficam mais nas configurações do VS Code de cada computador: mudam
  pelo painel ou pela tela de Configurações do Swap Plus, e valem para todos.

## Como passar para a 3.0

1. Rode o comando do seu sistema:
   - Mac (Terminal):

     ```bash
     curl -fsSL https://raw.githubusercontent.com/bragarpaulo/swap-plus-vscode/main/plus/scripts/install.sh | bash
     ```

   - Windows (PowerShell):

     ```powershell
     irm https://raw.githubusercontent.com/bragarpaulo/swap-plus-vscode/main/plus/scripts/install.ps1 | iex
     ```

2. Feche e abra o VS Code.
3. Olhe o Swap Plus na barra de baixo. Se ele mostra o uso da conta (`Sessão (5h): …`), pronto. Se mostra **não
   conectado**, clique nele e, no aviso que aparece, em **Entrar com Google**.
4. Contas que só estavam no modo local de um computador não vão sozinhas para o servidor: entre de novo com cada uma
   (veja [Contas novas](MANUAL.md#contas-novas)).
5. Faça o mesmo em todos os computadores. Um computador que ainda use o Swap Plus antigo no modo local pode renovar
   por conta própria um login que está no servidor, e aí a conta morre no servidor.

O que mudou antes, na 2.0: [NOVIDADES-2.0.md](NOVIDADES-2.0.md).
