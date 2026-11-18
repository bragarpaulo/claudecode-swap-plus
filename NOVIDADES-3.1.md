# Novidades do Swap Plus 3.1

## Fable acabou → Opus 5.5 sozinho

Quando o Fable da conta em uso acaba, o Swap Plus troca sozinho o **modelo padrão do Claude Code** daquele
computador para o **Opus 5.5**. Toda conversa nova já abre no Opus 5.5, na mesma conta. Quando o Fable volta (porque
renovou, ou porque o computador foi para uma conta que ainda tem Fable), o modelo padrão volta para o Fable, também
sozinho.

- **Quando troca:** quando o Claude Code mostra "You've hit your Fable limit" numa conversa, ou quando o uso do Fable
  chega na **linha do modelo** (padrão 95%) com a regra **Seguir na mesma conta**.
- **Aviso:** aparece um aviso na hora, e a troca fica no **Histórico** da tela de Configurações ("Modelo padrão").
- **O que ele não mexe:** se o seu modelo padrão já é outro (por exemplo, Sonnet), o Swap Plus não muda nada. Se você
  voltar o modelo à mão depois da troca, ele respeita a sua escolha até o Fable renovar.
- **Faz parte das duas regras** de "Quando o Fable acabar" (não é uma opção à parte). A tela mostra em que modelo as
  conversas novas estão abrindo. Para o Swap Plus nunca mexer no modelo, desligue `swapPlus.autoModel.enabled` nas
  configurações do VS Code (vale para aquele computador; o modelo volta ao que era).
- **Com a regra Trocar de conta:** o Swap Plus primeiro tenta passar o computador para uma conta que ainda tem Fable.
  O modelo só muda para o Opus 5.5 se nenhuma conta tiver Fable.

## O que continua manual

O Claude Code não deixa outra extensão trocar o modelo de uma **conversa que já está aberta**. Se ela parar com
"You've hit your Fable limit", escolha **Opus 5.5** no seletor de modelo (embaixo da caixa de mensagem) e mande
"continue". O aviso do Swap Plus lembra disso na hora.

Para as conversas abertas nem pararem, use a regra **Trocar de conta**: enquanto alguma conta tiver Fable, o Swap Plus
troca a conta antes do limite e a conversa segue no Fable.

## Outras correções

- O erro passageiro "Server is temporarily limiting requests (not your usage limit)" não é mais tratado como limite
  da conta (antes podia disparar uma troca de conta sem necessidade).
- Saiu o botão **Deixar pronto**: o Swap Plus agora cuida do modelo padrão sozinho.

## 3.1.1 e servidor 2.4.2

- **Tela mais simples:** saiu a caixa "Trocar o modelo sozinho". As duas opções de "Quando o Fable acabar" já dizem
  tudo: **Seguir na mesma conta com o Opus 5.5** ou **Trocar de conta para continuar no Fable** (e, sem nenhuma conta
  com Fable, as conversas novas vão para o Opus 5.5).
- **Trocar de conta para continuar no Fable** agora vale mesmo com a conversa já no Opus 5.5 (antes só valia com o
  Fable "em uso", e depois de passar para o Opus ele nunca voltava a procurar uma conta com Fable). Se a sessão ou o
  semanal estourarem e nenhuma conta tiver Fable, troca mesmo assim.
- **Servidor 2.4.1:** com "dar preferência a contas com Fable", a estratégia "Aproveitar ao máximo" não tira mais você
  de uma conta com Fable para uma sem.

## 3.1.2

- **Fim do "servidor fora do ar" falso.** No Mac, 1 em cada 4 pedidos falhava em meio segundo (o Node desistia de
  cada endereço da Cloudflare depois de 250 ms, e a conexão às vezes leva 300–500 ms). Agora cada tentativa tem 6 s
  (0 falhas em 40 pedidos medidos no Mac), e o batimento tenta de novo uma vez, 2 s depois, antes de mostrar
  "fora do ar".

## Como atualizar

Nada a fazer: a extensão se atualiza sozinha ao abrir ou fechar o VS Code. Para usar na hora, rode o comando de
instalação do [MANUAL](MANUAL.md) e recarregue a janela do VS Code.
