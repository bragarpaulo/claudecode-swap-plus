# Novidades do Swap Plus 3.6

## Servidor 2.8.0, extensão 3.6.0 e cliente 1.2.0 (25/11/2026): qualidade — sem registro duplicado, mais leve e com ambiente local

### Nome de serviço único

- **O problema:** cada pareamento ou login com Google criava um serviço novo, sem olhar o nome. Reinstalar o VS Code
  e conectar de novo deixava dois "NoteWin"; "NoteWin" e "notewin" conviviam; nome vazio virava "serviço" duas vezes;
  e o painel deixava renomear para um nome que já existia.
- **Agora:** dois serviços não podem ter o mesmo nome. O pedido é recusado com a mensagem **"Já existe um serviço com
  este nome; escolha outro ou desconecte o antigo no painel."**
  - Maiúsculas não contam, em nenhum alfabeto ("NoteWin" = "notewin", "ÇAÇA" = "çaça", "Σίσυφος" = "σίσυφοσ").
    Espaços nas pontas e repetidos também não. O acento conta: "José" e "Jose" são nomes diferentes.
  - Vale no pareamento por código (o código **continua valendo** para tentar com outro nome), no login com Google
    (no início e de novo no retorno do Google, que mostra a mesma mensagem) e ao renomear no painel.
  - **Reconectar o mesmo computador não dá conflito com ele mesmo:** a extensão e o cliente mandam o acesso antigo
    (`replaces`) quando conectam de novo ao **mesmo** servidor. O servidor troca o antigo pelo novo na mesma gravação
    e anota no histórico `Serviço "NoteWin" reconectado: o acesso anterior deixou de valer`. O acesso antigo nunca vai
    para outro endereço.
  - Na extensão, nome recusado mostra a mensagem e pede outro nome (a caixa volta com o nome digitado). No cliente,
    o comando sai com erro e a dica `--nome <outro nome>` (ou `SWAP_PLUS_NOME`).
  - **Os serviços que já estão duplicados ficam como estão:** nada é apagado, desconectado nem renomeado. Renomear um
    deles para um nome livre funciona.
- **Nome com até 60 caracteres** também no painel (antes, 40 ao renomear e 60 ao conectar: um nome de 41 a 60 não podia
  ser renomeado para ele mesmo). O nome e o apelido de conta não ficam mais com meio emoji no fim.

### Aviso e limite uma vez por computador

- **"Chegou a X%"**: com várias janelas do VS Code abertas, cada janela avisava (3 janelas = 3 notificações e 3 linhas
  iguais no histórico). Agora só a janela que cuida do computador avisa, e cada aviso é reivindicado por um arquivo no
  temporário: **1 notificação e 1 linha**, mesmo quando outra janela assume. As outras janelas continuam vendo o
  histórico e a barra. (A notificação aparece na janela que cuida do computador, que nem sempre é a que está na frente.)
- **Limite batido**: duas janelas que viam o mesmo erro no mesmo instante podiam avisar o servidor as duas (duas trocas
  ou dois avisos). Agora só a janela que cuida do computador procura o erro, e a reivindicação é atômica: **1 aviso ao
  servidor** por erro.
- Com `CLAUDE_CONFIG_DIR` definido, a extensão agora acha o limite batido e o modelo em uso na pasta certa (antes olhava
  sempre `~/.claude/projects`).

### Mais leve

Medido com `node dev/ambiente-local.js medir` (antes = `origin/main` em `afbf75d`; esta máquina, Node 24.22.3,
300 projetos × 40 transcrições antigas + 5 recentes):

| Medida | Antes | Depois |
| --- | --- | --- |
| Procura do limite batido (mediana) | 989 ms | 293 ms (30%) |
| Detecção do modelo em uso (mediana) | 1.022 ms | 246 ms (24%) |
| Varreduras completas por minuto, 3 janelas do VS Code | 18 | 4 |
| Painel: primeira abertura (index.html + app.js + app.css) | 226.712 bytes | 61.779 bytes (27%) |
| Painel: reabertura | 226.712 bytes | 0 bytes (304) |

- As transcrições do Claude Code são varridas uma vez para as duas coisas (limite e modelo), com até 32 leituras em
  paralelo, a lista de cada pasta relida só quando a pasta muda e o resultado reaproveitado por até 10 s. Só a janela que
  cuida do computador varre; as outras usam o resultado dela. Uma varredura em andamento não é empilhada. O preço: um
  limite batido pode ser visto até ~10 s mais tarde.
- O painel web manda os arquivos comprimidos (gzip) e, na reabertura, só confirma que não mudaram (ETag/304). As
  respostas da API continuam sem compressão, porque levam acesso das contas.

### Design

- Painel web: tamanhos de título na escala que o próprio painel declara (22 px no título, 18 px no celular, 12 px nas setas
  de ordenação) e cores sempre pelas variáveis do tema (botão de perigo, interruptor, bolinha "em uso").
- Tela de configurações da extensão: o interruptor ligado usa as cores do tema do VS Code (no alto contraste, o verde do
  tema, não um verde fixo).
- `node dev/conferir-design.js` confere isso automaticamente (roda nos testes).

### Ambiente local (desenvolvimento e testes)

`node dev/ambiente-local.js` sobe o servidor de verdade com um Anthropic e um Google falsos e dados simulados, sem
banco e sem nada saindo para a internet. Subcomandos `testes`, `medir`, `cliente`, `vscode` e `limpar`. Detalhes no
[README](README.md#ambiente-local-desenvolvimento-e-testes). O F5 do VS Code agora abre a extensão de `plus/` (antes
abria o projeto original da raiz).

### Compatibilidade

- **Servidor 2.8.0 com extensão 3.5.0 / cliente 1.1.0** (conferido no código da 3.5.0):
  - Login com Google com nome repetido: recusado já no início, e a 3.5.0 mostra "o servidor … recusou o pedido: Já
    existe um serviço com este nome…". Se o conflito só aparecer no retorno do Google, o servidor responde 409 à
    consulta, e a 3.5.0 mostra a mesma mensagem. Ela não fica esperando até a sessão vencer.
  - **Pareamento por código com nome repetido: a 3.5.0 mostra a mensagem genérica dela** ("o código não foi aceito…
    gere outro no servidor"), que engana: o código continua valendo e o problema é o nome. Basta conectar de novo com
    outro nome. A 3.6.0 mostra a mensagem certa.
  - Reconectar com a 3.5.0 e o mesmo nome dá conflito com o próprio computador (ela não manda `replaces`): escolha outro
    nome ou desconecte o antigo no painel. Com a 3.6.0, não.
- **Extensão 3.6.0 / cliente 1.2.0 com servidor antigo:** `replaces` e `caps` são ignorados; tudo funciona como antes.
- **Ordem recomendada para publicar:** servidor 2.8.0 primeiro, depois a extensão 3.6.0 e o cliente 1.2.0.
- O cofre não muda de formato: voltar para a versão anterior não precisa de nenhum passo.
