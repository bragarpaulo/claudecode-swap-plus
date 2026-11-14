# Manual do Swap Plus

Como levar suas contas do Claude Code para outro computador (Mac ou Windows) sem precisar logar de novo
em cada uma, com as mesmas regras de troca, avisos e ajustes.

São três etapas:

1. **No computador principal:** exportar as contas.
2. **No outro computador:** instalar o Swap Plus.
3. **No outro computador:** importar as contas e conferir.

Leva uns 10 minutos.

## Antes de começar

**No computador principal**, o Swap Plus já precisa estar funcionando, com as contas cadastradas. A barra
embaixo, à esquerda do VS Code, mostra `│ ✉ Sessão (5h): …`.

**No outro computador** você vai precisar de:

- internet;
- o **VS Code** instalado ([code.visualstudio.com](https://code.visualstudio.com));
- a extensão **Claude Code** instalada no VS Code (aba Extensões → procure "Claude Code" → Instalar).
  Não precisa logar nela; as contas vêm no arquivo.

Não precisa ser administrador da máquina.

---

## Etapa 1 — No computador principal: exportar as contas

1. Clique na barra do Swap Plus, embaixo à esquerda do VS Code.
2. Na lista que abre lá em cima, escolha **Configurações…** (a primeira opção).
3. Desça até **Exportar e importar contas**.
4. Escolha um dos botões:

   | Botão | Quando usar | Como o outro computador mostra as contas |
   | --- | --- | --- |
   | **Export Other** | o outro computador fica à vista de outras pessoas | só "Conta 1", "Conta 2"… sem e-mail (modo privado) |
   | **Export Me** | o computador é só seu | com os e-mails, igual a este |

5. Escolha onde salvar. O padrão é a Mesa (Desktop), com o nome `swap-plus-other.cswap` ou `swap-plus-me.cswap`.
6. Leve o arquivo para o outro computador por **pen drive, AirDrop ou cabo**.

> **Cuidado com o arquivo.** Ele tem as credenciais de todas as contas, em texto puro. Não mande por e-mail,
> WhatsApp ou nuvem. Na Etapa 3 você vai apagá-lo.

**O que vai no arquivo:** as contas e todas as configurações do Swap Plus — regras de troca (sessão, semanal,
Fable), avisos, estratégia, troca automática ligada ou desligada, exibição e os ajustes de cada conta (se
participa da rotação, linha própria e prioridade).

**O que não vai:** o histórico e o caminho do executável, que são de cada máquina.

---

## Etapa 2 — No outro computador: instalar o Swap Plus

Um comando instala tudo: o `uv` (se faltar), o motor (`swap-plus`) e a extensão Swap Plus do VS Code.
Siga a parte do seu sistema.

### Mac

1. Abra o **Terminal**: `Cmd + Espaço`, digite `Terminal` e aperte Enter.
2. Cole este comando e aperte Enter:

   ```bash
   curl -fsSL https://raw.githubusercontent.com/bragarpaulo/swap-plus-vscode/main/plus/scripts/install.sh | bash
   ```

3. Espere até aparecer **`==> Pronto`**. No caminho ele mostra:
   - `uv … já instalado` ou a instalação do uv;
   - `Motor (swap-plus)` e, no fim dessa parte, `swap-plus 1.x.x`;
   - `Extensão Swap Plus (VS Code)` e `Extension 'swap-plus.vsix' was successfully installed.`
4. No VS Code: se ele estava aberto, aperte `Cmd + Shift + P`, digite **Developer: Reload Window** e aperte Enter.
   Se estava fechado, é só abrir.

### Windows

1. Abra o **PowerShell**: menu Iniciar, digite `PowerShell` e abra o **Windows PowerShell**
   (não precisa ser "como administrador").
2. Cole este comando e aperte Enter:

   ```powershell
   irm https://raw.githubusercontent.com/bragarpaulo/swap-plus-vscode/main/plus/scripts/install.ps1 | iex
   ```

3. Espere até aparecer **`==> Pronto`**. No caminho ele mostra as mesmas três partes do Mac (uv, motor e extensão).
4. **Feche e abra o VS Code** (ou `Ctrl + Shift + P` → **Developer: Reload Window**).

### Como saber se deu certo

Embaixo, à esquerda do VS Code, aparece a barra do Swap Plus: `│ ✉ sem conta ativa │`.
Ainda sem contas, porque elas entram na próxima etapa.

---

## Etapa 3 — No outro computador: importar as contas e conferir

1. Coloque o arquivo da Etapa 1 numa pasta fácil (por exemplo, a Mesa).
2. Clique na barra do Swap Plus → **Configurações…**
3. Desça até **Exportar e importar contas** → **Importar contas…** → escolha o arquivo.
4. Espere a mensagem **"N contas importadas, com as regras de troca, os avisos e os ajustes de cada conta"**.
   Se o arquivo era um **Export Other**, ela também diz *"Modo privado ligado: aqui aparece só “Conta N”"*.
5. Na mesma mensagem, clique em **Apagar o arquivo**. Se você copiou o arquivo para outro lugar, apague lá
   também e esvazie a Lixeira.
6. **Escolha a conta:** clique na barra do Swap Plus e escolha uma conta. O ✓ marca a que está em uso, e o
   Claude Code passa a usar essa conta em até 30 segundos.
7. **Confira:**
   - a barra mostra `│ ✉ Sessão (5h): X% usado — renova … · Semanal: … · Fable: … │`;
   - em **Configurações → Contas** estão todas as contas, com os mesmos ajustes do computador principal;
   - em **Configurações → Atualizações da extensão** aparecem as versões instaladas.

Pronto. Se a troca automática estava ligada no computador principal, ela já vem ligada aqui.

---

## Depois disso

- **Atualizações:** automáticas. A extensão verifica ao abrir e ao fechar o VS Code e a cada 2 dias, e
  instala sozinha, do mesmo jeito que as outras extensões. Tudo acontece dentro do VS Code. Para ver ou
  forçar: **Configurações → Atualizações da extensão → Verificar agora**.
- **Mudar a ordem das contas:** **Configurações → Contas**, setas ↑ ↓ em cada conta.
- **Ligar ou desligar o modo privado:** **Configurações → Exibição**.
- **Adicionar uma conta só neste computador:** logue a conta no Claude Code, clique na barra →
  **Adicionar conta…**
- **Levar mudanças para o outro computador de novo:** repita as Etapas 1 e 3; a Etapa 2 não precisa.
  As configurações e os ajustes de cada conta são atualizados e as contas novas entram. As contas que já
  existiam lá continuam como estão (o login delas não é trocado).

## Sobre o modo privado

Ele muda só o que o **Swap Plus** mostra (barra, lista de contas, tela de configurações e avisos). Não é uma
trava:

- o painel de conta do próprio Claude Code (na lateral) e o comando `/status` continuam mostrando o e-mail
  da conta em uso;
- o comando `swap-plus list` também mostra;
- quem usa o computador usa as contas.

## Problemas comuns

| O que aparece | O que fazer |
| --- | --- |
| A barra mostra **Swap Plus: erro** | O motor não foi encontrado. Rode o comando da Etapa 2 de novo e recarregue o VS Code. |
| Mac: `command not found: swap-plus` no Terminal | Feche e abra o Terminal. |
| Windows: `swap-plus não é reconhecido` | Feche e abra o PowerShell. |
| Windows: o comando da Etapa 2 dá erro de "execução de scripts" | Rode antes: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` e tente de novo. |
| **Importar contas** dá erro | O arquivo pode ter sido corrompido na cópia. Gere outro (Etapa 1). |
| A barra não aparece depois de instalar | Recarregue o VS Code (`Cmd/Ctrl + Shift + P` → **Developer: Reload Window**). |

## Remover

- **Extensão:** VS Code → Extensões → Swap Plus → Desinstalar.
- **Motor:** no Terminal/PowerShell, `uv tool uninstall claude-swap`.
- **Contas guardadas pelo Swap Plus neste computador:** `swap-plus purge` (antes de remover o motor).
  Apaga a pasta `~/.claude-swap-backup` e as credenciais guardadas por ele.

---

Mais detalhes: [extensão](plus/README.md) · [motor](https://github.com/bragarpaulo/swap-plus).
