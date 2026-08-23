# Operação de agentes

Este documento é para quem **opera** o Vinculato, não para quem o escreve. Ele
responde às perguntas que aparecem quando um agente para de trazer dado, quando
uma entrada não é reconhecida, ou quando alguém precisa desligar a automação
agora.

A arquitetura por trás está em [`arquitetura-operacional.md`](./arquitetura-operacional.md);
aqui está o que fazer.

---

## O que é um agente, e o que ele nunca faz

Um agente é um **executor controlado**: ele lê um sistema de origem, interpreta o
que leu e **propõe**. Ele não é um assistente de conversa, não tem personalidade,
não tem prompt editável e não recebe instrução em linguagem natural.

O que um agente **não pode fazer**, em nenhuma configuração:

- executar SQL;
- escrever direto no banco;
- decidir regra trabalhista;
- aprovar remuneração, desligamento ou lançamento financeiro;
- escrever no ERP sem autorização explícita;
- contornar o processo.

Toda proposta passa por um motor determinístico. Quando ele não tem certeza, o
item vai para a **triagem** — nunca para um palpite.

---

## Os agentes que existem

| Agente | O que lê | Como |
| --- | --- | --- |
| **Sankhya** | Cadastro de colaboradores no ERP | Navegador autenticado (RPA) |
| **Tangerino** | Fichas de admissão e ponto | API |
| **Sólides** | Admissões concluídas | API |
| **Microsoft Teams** | Mensagens de movimentação | Webhook — **não é executor** |

O Teams aparece na Central de Agentes como **canal**: ele produz propostas, mas
quem as traz é um webhook. Não há execução a disparar, e por isso a linha dele
mostra execução vazia em vez de fingir que tem uma.

---

## Onde tudo isso fica

`Relatórios e integrações › Agentes` — `/painel/agentes`.

A tela responde três perguntas, nesta ordem: **está rodando?**, **o que ele
fez?**, **posso parar?**.

### Configurar um conector: as duas portas

Configuração é outra coisa que operar, e mora em dois lugares — de propósito:

| Onde | Quem | O que configura |
|---|---|---|
| `Relatórios e integrações › Integrações` | quem tem `integrations.manage` no workspace | endereço, destino, referência da conta, corte de admissões, avisos do Teams |
| Console da plataforma › Integrações | administrador da plataforma | os mesmos campos, em qualquer workspace, **mais** o conector Sankhya |

**As regras são as mesmas nos dois lugares.** Uma função só (`lib/connector-config.ts`)
valida o que entra; o que muda entre as portas é quem pode abrir e o que fica
registrado. Pela plataforma, toda gravação exige **motivo administrativo** e
entra nas auditorias global **e** do workspace.

Duas consequências que surpreendem quem grava pela primeira vez:

- **Gravar substitui a configuração inteira.** Por isso o formulário nasce
  preenchido com o que está lá: salvar em branco apagaria o resto.
- **Gravar devolve o conector para `aguardando credencial`.** Trocar o endereço
  invalida a conexão que foi provada contra o endereço antigo — é a conexão que
  precisa ser provada de novo, não a configuração que se perdeu.

O Sankhya continua sendo exceção nos dois sentidos: só a plataforma o
configura, e o console do workspace recusa explicitamente quem tentar.

---

## Ativar um agente

Um agente só existe depois que a **integração** dele existe. A ordem é:

1. `Relatórios e integrações › Estado das integrações` — conecte o conector e
   salve a credencial;
2. teste a conexão até ela ficar **Conectada**;
3. publique um mapeamento ativo (é ele que diz o que ler);
4. em `Agentes`, escolha a **cadência**.

Enquanto faltar qualquer um dos três primeiros passos, a varredura **não**
enfileira o agente — e o motivo aparece nomeado, em vez de o agente ficar
parado sem explicação.

### Cadências

| Escolha | Quando usar |
| --- | --- |
| **Somente manual** | O agente só roda quando alguém clica. Use enquanto valida a configuração. |
| **A cada 15 minutos** | Origem que muda o dia inteiro e cujo atraso custa caro. |
| **A cada 30 minutos** | Acompanha a varredura agendada, sem folga entre um ciclo e outro. |
| **De hora em hora** | Origem que consolida dados ao longo do dia. |
| **De hora em hora, no expediente** | Não bate no sistema de origem de madrugada nem no fim de semana. |
| **Uma vez por dia** | Origem que só muda de verdade uma vez por dia. |

Não existe cadência menor que 15 minutos. Um pedido abaixo disso é **recusado**,
e não corrigido em silêncio.

"No expediente" é o expediente **do seu grupo**: segunda a sexta, das 8h às 18h,
no fuso configurado no conector.

---

## Pausar e reativar

`Agentes › Pausar`. A pausa vale **imediatamente e por grupo**, sem deploy.

Enquanto pausado:

- nenhuma leitura nova é feita;
- nenhuma proposta dele é considerada, mesmo que chegue por outro caminho;
- o que já estava na fila continua valendo.

Reativar devolve o agente à cadência configurada. Um conector que estava **sem
credencial** não vira "conectado" por um clique de reativação — isso seria
declarar conectado o que nunca autenticou.

Toda pausa e toda reativação ficam na auditoria com o nome de quem fez.

---

## Executar agora

`Agentes › Executar agora`, com confirmação.

O botão **enfileira**; ele não executa na hora. A execução acontece fora da sua
tela, e é por isso que ela não trava esperando. O resultado aparece assim que a
varredura drenar a fila.

Dois cliques em cinco minutos produzem **uma** execução: a chave de idempotência
é a mesma. E se já houver execução em andamento para aquele agente, o pedido é
recusado com essa frase — não com um erro genérico.

Disparar manualmente **empurra** a próxima execução automática: rodar agora e de
novo em dois minutos não é o que quem clicou pediu.

---

## Triagem

`Relatórios e integrações › Triagem` — `/painel/triagem`.

A triagem é onde o sistema admite não ter certeza. Cada item abre com **o motivo
da incerteza** e **o que resolve**, antes de qualquer botão.

| O que aparece | Significa |
| --- | --- |
| "O agente não identificou a quem esta entrada se refere" | Escolha o colaborador e a empresa. Nada é aplicado até o vínculo ser confirmado. |
| "A leitura ficou abaixo do mínimo" | Confira a origem ao lado e decida. |
| "Ação sensível" | Salário, desligamento, aprovação ou escrita em ERP. A decisão é sempre de uma pessoa, com qualquer confiança. |
| "A automação está desligada neste grupo" | Toda entrada vem para cá enquanto a política estiver assim. |
| "Faltaram dados obrigatórios" | Complete o que falta com a mensagem original ao lado. |

A confiança aparece em palavra — **Alta**, **Média**, **Baixa** — com o número ao
lado. As faixas são as mesmas que o motor usa para decidir.

**Confirmar não é um atalho.** O item segue pela rota do módulo que o governa, e
ela reavalia versão, etapa, destino autorizado, checklist, evidência,
responsável, aprovador e concorrência do zero — exatamente como faria se a
pessoa tivesse feito a mesma coisa pela tela do módulo.

Ações disponíveis: **confirmar**, **recusar**, **descartar** e **encaminhar**.
Encaminhar não resolve: o item continua na fila, e o que muda é de quem a
operação espera a decisão.

A nota da decisão vai para a auditoria. "Rejeitado" sem motivo é uma linha de
histórico que não ajuda ninguém seis meses depois.

### Dado pessoal

CPF, CNPJ, e-mail e telefone aparecem **redigidos**, com o final visível. É o
suficiente para conferir de quem é a entrada sem distribuir o documento inteiro
para quem só precisa classificar.

---

## Quando algo falha

A tela nunca mostra um código cru. Ela diz o que aconteceu, qual foi o impacto e
o que destrava.

### Estados do agente

| Estado | O que significa | O que fazer |
| --- | --- | --- |
| **Ativo** | Executando na cadência configurada | Nada |
| **Nunca executado** | Ainda não rodou neste grupo | Execute uma vez para validar a configuração |
| **Pausado** | Alguém desligou | Reative quando quiser voltar |
| **Sem credencial** | O conector não tem credencial válida | Configure a credencial em Integrações |
| **Erro na última execução** | A última tentativa falhou | O agente tentará de novo, com espera crescente |
| **Degradado** | Três ou mais falhas seguidas | O dado pode estar desatualizado. Abra o histórico e veja o erro |
| **Atrasado** | O horário previsto passou de um ciclo | A varredura agendada pode estar parada — avise quem administra |

### Espera crescente

Depois de uma falha, o agente espera antes de tentar de novo: **1, 5, 15 e 60
minutos**. O teto é uma hora. Isso existe para não martelar um sistema de origem
que já se sabe indisponível.

Depois da terceira falha seguida, o agente é marcado como **degradado** — e isso
aparece, em vez de ele parar em silêncio.

### A tela da origem mudou (`UI_CHANGED`)

Os agentes de navegador dependem da tela do sistema de origem. Quando um campo
muda de nome ou sai do lugar, o agente **falha explicitamente** com
`UI_CHANGED`, dizendo qual etapa e qual elemento não foram encontrados.

Isso é o comportamento **correto**, e não um defeito. A alternativa — tentar
adivinhar — leria o campo errado e devolveria um status plausível e falso.

Quando acontecer:

1. o último dado válido **é preservado**: nada é sobrescrito com leitura falha;
2. a execução aparece no histórico com a etapa exata que quebrou;
3. falhas repetidas marcam o agente como degradado;
4. o item fica visível na Central de Trabalho, junto com o restante do trabalho
   que exige ação humana.

O que **não** fazer: reprocessar em série esperando que funcione. Se a tela
mudou, ela vai continuar mudada — quem precisa agir é quem mantém o conector.

---

## Reprocessar

Quando uma execução esgota as tentativas, ela vai para **dead-letter**: fica
visível, parada, esperando decisão humana. Ela nunca é descartada em silêncio.

`Agentes › Ver histórico › Reprocessar` devolve a execução à fila.

**O que já foi importado não é importado de novo.** O reprocessamento reaproveita
a mesma execução, com as mesmas chaves de idempotência: um registro já
processado é reconhecido como reentrega e ignorado.

Dois cliques em reprocessar devolvem **um** job.

---

## Histórico e logs

`Agentes › Ver histórico` mostra, por execução: quando começou, como terminou,
quantos itens vieram, quantos entraram, quantos foram ignorados, quantos
falharam, quanto tempo levou e — quando falhou — por quê.

O log técnico linha a linha fica atrás de um clique, e é paginado. Ele é detalhe
de diagnóstico, não leitura de rotina.

Nenhuma credencial aparece em log: o que entra nele é filtrado na escrita.

---

## Segurança

- **A automação nunca contorna a regra de negócio.** Toda ação passa pela rota de
  domínio, que reavalia tudo do zero.
- **Ação sensível sempre exige uma pessoa**, qualquer que seja a confiança e
  qualquer que seja a configuração do grupo.
- **O agente não escolhe consulta.** A IA do produto responde a partir de um
  catálogo fechado de perguntas autorizadas, sem SQL e sem acesso a tabela.
- **A pausa é imediata e não depende de deploy.**
- **Toda ação fica na auditoria** — pausar, reativar, mudar cadência, executar,
  reprocessar, resolver triagem e encaminhar.
- **Segredo não vai para log, para tela nem para payload.**

---

## Política de automação do grupo

`Agentes` mostra, no topo, a política vigente. Ela vale para o grupo inteiro:

| Política | Efeito |
| --- | --- |
| **Desligada** | Toda entrada vai para triagem |
| **Só sugere** *(padrão)* | Nenhuma ação acontece sem confirmação |
| **Automática para rotina de alta confiança, com evidência** | O motor pode aplicar ações de rotina sozinho — nunca as sensíveis |

O padrão é conservador de propósito. Na dúvida entre automatizar e pedir
confirmação, o produto pede confirmação.
