# Novidades do Swap Plus 2.0

> **Há uma versão mais nova:** veja as [novidades da 3.0](NOVIDADES-3.0.md).

O que mudou da versão 1.8 para a 2.0. Passo a passo completo no [MANUAL](MANUAL.md).

## Versão 2.0 — o servidor

- **Servidor Swap Plus** em **https://swap.assistentes.si**. Ele guarda os logins de todas as contas e atende todos
  os computadores.
- **Fim do "login morto" entre computadores.** Só o servidor renova os logins. Os computadores recebem só o acesso da
  conta que o servidor escolheu para cada um.
- **Renovação sozinha.** O acesso dura cerca de 8 horas, e o servidor renova 2 horas antes de vencer.
- **Aviso antes de o login vencer.** O login de cada conta vence de vez em cerca de um mês. O painel avisa 3 dias antes.
  Aí é só entrar de novo com aquela conta: no painel (**Contas** → **+ Adicionar conta**) ou no Claude Code (`/login`)
  em qualquer computador conectado.
- **Conectar com o Google.** No VS Code: `Ctrl/Cmd + Shift + P` → **Swap Plus: Conectar ao servidor** →
  **Entrar com Google**. O código de conexão continua como alternativa.
- **Primeira conexão sem trabalho.** O Swap Plus oferece:
  - **Enviar os logins deste computador** — manda ao servidor as contas vivas que ele ainda não tem, com o mesmo
    número quando o número está livre, e pula as que ele já tem. Essa pergunta só aparece nos computadores do
    administrador (os outros só usam as contas do servidor; o servidor recusa login vindo deles).
  - As regras de troca mudam só pelo painel ou pela tela do Swap (não há mais pergunta para levá-las ao servidor).
- **Painel no navegador**, no mesmo endereço, com login pelo Google. Só o administrador (a conta Google definida no
  servidor) entra. O menu tem três itens:
  - **Contas** — as contas Claude na ordem da fila, o uso de cada uma, os ajustes de cada conta e as **regras de
    troca**. As que não participam da troca ficam no grupo **Fora da troca**;
  - **Computadores** — um quadradinho por computador, com a conta Claude logada nele agora. Dá para renomear, trocar
    de conta e desconectar;
  - **Usuários** — as contas Google que podem conectar computadores.

  No topo: **Histórico**, **Atualizar** e **Minha conta** (seu e-mail, **Sair**, o kit de recuperação e as sessões
  abertas).
- **Adicionar conta pelo painel.** Em **Contas** → **+ Adicionar conta**: você entra na conta Claude da assinatura,
  copia o código que aparece e cola no painel. Não precisa de computador, e o login fica só no servidor.
- **Suas outras contas Google.** O administrador libera outras contas Google dele em **Usuários** (por exemplo, uma
  para cada computador). Elas só conectam computadores.
- **Computadores permitidos.** Em cada conta Claude (**Ajustes desta conta**), o administrador escolhe quais
  computadores podem usá-la: todos ou só alguns.
- **Regras no servidor.** As regras de troca valem para todos os computadores conectados.
- **Tela de login do Claude Code desligada** enquanto o computador está conectado ao servidor. Volta ao normal ao
  desconectar.
- **Windows:** se o Claude Code do Windows usar o Gerenciador de Credenciais do Windows, o Swap Plus avisa e não grava
  (raro).
- **Backup diário** na nuvem (R2) com o cofre, as chaves, a imagem e o código. No painel, **Minha conta → Mostrar o
  kit de recuperação** mostra a chave mestra e a senha do backup (é preciso ter entrado com o Google há menos de
  15 minutos; o kit some sozinho em 5 minutos). Guarde as duas **fora do servidor**.
- **Atenção:** não use o Swap Plus antigo (modo local) para trocar de conta em contas que já estão no servidor.

## Versão 1.9

- **Desligar o Swap Plus.** Um botão para desligar tudo por um tempo: barra do Swap Plus → **Desligar o Swap Plus**.
  Desligado, ele não troca de conta nem mexe no login.
- **Login salvo na hora.** Quando você entra numa conta (ou o acesso dela é renovado), o Swap Plus guarda a versão
  nova na mesma hora.
- **Nunca troca para conta com login morto.** A troca automática pula essas contas. Na lista elas aparecem como
  **Login morto — entrar de novo**.

## Como atualizar

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
3. Conecte ao servidor: veja [Começando com o servidor](MANUAL.md#começando-com-o-servidor-20).
