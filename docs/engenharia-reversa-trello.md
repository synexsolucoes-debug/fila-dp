# Engenharia reversa funcional do Trello, aplicada ao quadro de Demandas

> **O que é este documento.** Uma análise completa de como o Trello modela o
> trabalho — hierarquia, objetos, posições, permissões, automação (Butler),
> visualizações, notificações, API, webhooks e tempo real — e de como cada peça
> se compara ao quadro de Demandas do Vinculato. Serve para três coisas: decidir
> o que copiar, registrar o que **não** copiar, e dar ao time um vocabulário
> comum com os escritórios de DP que hoje controlam a fila no Trello e vão
> migrar para o Vinculato.
>
> **Método e limites.** Engenharia reversa *funcional*, a mesma do
> `docs/engenharia-reversa-sap-hcm.md`: tudo vem da documentação pública da
> Atlassian (support.atlassian.com/trello, developer.atlassian.com/cloud/trello),
> da referência pública da API REST, do formato público do JSON exportado de um
> quadro e do uso do produto. Nenhum código do Trello foi lido, copiado ou
> decompilado, e nenhuma conta foi usada: o que a interface mostra a qualquer
> assinante está documentado. Limites e cotas por plano **mudam com frequência**;
> onde um número depende do plano, o texto diz e manda conferir a página de
> preços antes de usá-lo num argumento comercial.
>
> **Versão considerada.** O Trello de 2025–2026: a interface redesenhada com
> Caixa de entrada (Inbox) e Planejador (Planner), espelhamento de cartões e o
> Butler embutido como "Automação". Planos: Free, Standard, Premium e
> Enterprise.
>
> **Como usar com um cliente.** O que mais ajuda numa migração não é este
> documento, é o JSON do quadro do cliente: *Menu do quadro → Imprimir, exportar
> e compartilhar → Exportar como JSON* (disponível em todos os planos). O §15
> descreve como esse arquivo é lido e o §17 coloca o importador como primeiro
> item do roadmap.

## Sumário

1. [Mapa do Trello](#1-mapa-do-trello)
2. [Hierarquia e identidade dos objetos](#2-hierarquia-e-identidade-dos-objetos)
3. [Quadro](#3-quadro)
4. [Lista](#4-lista)
5. [Cartão](#5-cartão)
6. [Ordem: o campo `pos`](#6-ordem-o-campo-pos)
7. [Etiquetas, membros, datas, checklists e campos personalizados](#7-etiquetas-membros-datas-checklists-e-campos-personalizados)
8. [Comentários, menções, atividade e notificações](#8-comentários-menções-atividade-e-notificações)
9. [Permissões e visibilidade](#9-permissões-e-visibilidade)
10. [Visualizações](#10-visualizações)
11. [Automação (Butler)](#11-automação-butler)
12. [Caixa de entrada, Planejador, e-mail para o quadro e modelos](#12-caixa-de-entrada-planejador-e-mail-para-o-quadro-e-modelos)
13. [Power-Ups](#13-power-ups)
14. [API REST, webhooks e tempo real](#14-api-rest-webhooks-e-tempo-real)
15. [O JSON exportado de um quadro](#15-o-json-exportado-de-um-quadro)
16. [Comparativo item a item com o Vinculato](#16-comparativo-item-a-item-com-o-vinculato)
17. [O que copiar, o que não copiar e roadmap](#17-o-que-copiar-o-que-não-copiar-e-roadmap)
18. [Defeito encontrado durante a análise](#18-defeito-encontrado-durante-a-análise)
19. [Glossário Trello ↔ DP ↔ Vinculato](#19-glossário-trello--dp--vinculato)

---

## 1. Mapa do Trello

| Camada | Objeto | Responsabilidade | No Vinculato |
| --- | --- | --- | --- |
| Organização | Enterprise | Domínio, SSO, políticas e cobrança de várias áreas de trabalho | Plataforma (`/plataforma`, console de workspaces) |
| Área de trabalho | Workspace (na API: `organization`) | Agrupa quadros, membros e cobrança | `fdp_workspaces` |
| Quadro | Board | Um fluxo de trabalho com listas, etiquetas, campos e regras próprios | `fdp_boards` |
| Lista | List | Uma coluna; no uso comum, uma etapa do fluxo | `fdp_lists` (com `kind` e `sla_behavior`) |
| Cartão | Card | A unidade de trabalho | `fdp_cards` (a demanda) |
| Checklist / item | Checklist / CheckItem | Subtarefas do cartão | `fdp_checklist_items` (e `fdp_demand_tasks` do processo) |
| Ação | Action | Registro imutável de tudo o que aconteceu | `fdp_activity_events` + `fdp_audit_events` |
| Notificação | Notification | O que chega para uma pessoa | `fdp_notifications` |
| Automação | Butler (regras, botões, comandos agendados e por data) | Reagir a eventos e encurtar cliques | `fdp_automation_rules` (`lib/automation-rules.ts`) |
| Extensão | Power-Up | Integrações e recursos extras dentro do quadro | Integrações (`fdp_integrations`) e módulos |

A ideia mais importante do Trello, que explica quase todas as decisões dele:
**o cartão é genérico e o quadro é quem dá sentido**. Um cartão não sabe se é
uma admissão, um bug ou uma receita; ele tem título, descrição, datas, pessoas,
etiquetas e campos, e o significado nasce da lista em que está e das etiquetas
que carrega. Isso é o que faz o Trello servir para tudo — e é exatamente o que
o Vinculato **não** pode copiar (§17): no DP a demanda tem tipo de processo,
empresa, colaborador, competência e prazo legal, e é isso que permite calcular
SLA, corte e carteira.

---

## 2. Hierarquia e identidade dos objetos

### 2.1 Identificadores

Todo objeto tem um `id` de 24 caracteres hexadecimais no formato *ObjectId* do
MongoDB. Os 8 primeiros caracteres são o instante de criação em segundos Unix —
por isso a API não precisa de um campo `createdAt` no cartão: a data de criação
é lida do próprio id. Exemplo: `5f1a2b3c…` → `0x5f1a2b3c` segundos.

Além do `id`, quadro e cartão têm:

| Campo | O que é | Exemplo |
| --- | --- | --- |
| `shortLink` | 8 caracteres, estável, usado na URL | `trello.com/c/AbC12xYz` |
| `idShort` (só cartão) | Número sequencial **por quadro** — o "#123" que aparece no cartão | `#123` |
| `shortUrl` / `url` | Link curto e link longo com o título em slug | `/c/AbC12xYz/123-admissao-joao` |

**No Vinculato:** `fdp_cards.id` é UUID e o número humano é `reference_number`,
mostrado como `#DM-2471` (`demandReference` em `board.model.ts`). A diferença
relevante: o `idShort` do Trello recomeça em cada quadro; o `#DM-` do Vinculato
é por workspace, o que é melhor para DP — o número vai em e-mail e no Teams, e
dois quadros com o mesmo `#12` seriam ambíguos.

### 2.2 Estado fechado em vez de apagado

Quadro, lista e cartão têm `closed: true|false`. Arquivar é `closed = true`;
o objeto continua consultável, buscável com filtro e restaurável. Apagar de vez
existe só para cartão e quadro, exige o arquivamento antes e não pode ser
desfeito. Lista nunca é apagada, só arquivada.

**No Vinculato:** `fdp_cards.archived`, rotas `restore` e `permanent`, e uma
terceira saída que o Trello não tem — `cancel`, com motivo. Para DP, cancelar é
diferente de arquivar: uma admissão que desistiu não foi concluída, e o
relatório do mês precisa saber disso.

---

## 3. Quadro

| Campo (API) | Significado | No Vinculato |
| --- | --- | --- |
| `name`, `desc` | Nome e descrição | `name`, `description` |
| `idOrganization` | Área de trabalho dona | `workspace_id` |
| `closed` | Arquivado | — (quadro não arquiva) |
| `prefs.permissionLevel` | `private`, `org`, `public`, `enterprise` | Sempre restrito ao workspace |
| `prefs.comments`, `prefs.invitations`, `prefs.voting` | Quem comenta, quem convida, se há votação | Papéis do workspace |
| `prefs.background*` | Cor ou imagem de fundo | Tema do produto, não do quadro |
| `prefs.cardCovers`, `prefs.cardAging` | Mostrar capas; "envelhecer" visualmente cartões parados | Indicadores de SLA no cartão |
| `labelNames` | Nome de cada cor de etiqueta | `fdp_labels` (por workspace) |
| `memberships[]` | Quem participa e com que papel | `fdp_workspace_members` + acesso por empresa |
| `powerUps`, `pluginData` | Extensões ligadas e dados delas | Módulos e integrações |

Recursos de quadro que merecem nota:

- **Estrelar (favorito)** e **quadros recentes** — o Vinculato tem favoritos e
  recentes de *telas* (`useShortcuts`), não de quadros.
- **Modelo de quadro** — um quadro marcado como modelo é copiado inteiro
  (listas, etiquetas, cartões de exemplo). Ver §12.4.
- **Copiar quadro** com ou sem cartões.
- **Envelhecimento de cartões** (Power-Up *Card Aging*): cartão parado há dias
  fica desbotado ou "rasgado". É um indicador visual de inatividade, não de
  prazo. O Vinculato usa SLA, que é melhor para DP, mas não tem o indicador de
  *parado sem movimentação*, que é diferente de *atrasado* (§17).

---

## 4. Lista

| Campo | Significado |
| --- | --- |
| `name` | Título da coluna |
| `pos` | Ordem no quadro (§6) |
| `closed` | Arquivada |
| `subscribed` | Se a pessoa segue a lista |
| `softLimit` | Limite *sugerido* de cartões (WIP); a lista fica destacada ao passar, mas aceita o cartão |
| `color` | Cor da lista (recurso recente) |

Operações de lista que o Trello oferece no menu da coluna: mover todos os
cartões para outra lista, arquivar todos os cartões, ordenar os cartões (por
data de criação, nome ou data de entrega), copiar a lista, mover a lista para
outro quadro, seguir a lista e definir o limite.

**Diferença de natureza com o Vinculato.** No Trello a lista é só um nome com
posição; nenhum comportamento depende dela, a não ser o que uma regra do Butler
colocar. No Vinculato a lista tem `kind` (a entrada, a concluída, a de
aguardando…) e `sla_behavior` (`running`, `paused`, `completed`), e o SLA para
ou conclui conforme a coluna. Isso é mais forte que o Trello e deve ficar
assim: no DP, "aguardando documento do colaborador" pausa o prazo interno, e
isso não pode depender de alguém lembrar de configurar uma regra.

O que vale trazer: o **limite de WIP** (`softLimit`) é útil na visão por
responsável (colunas da `TeamBoard`) — um analista com 25 demandas abertas é a
informação que o gestor procura de manhã.

---

## 5. Cartão

### 5.1 Campos

| Campo (API) | Significado | No Vinculato |
| --- | --- | --- |
| `name` | Título | `title` |
| `desc` | Descrição em Markdown | `description` (texto) |
| `idList`, `idBoard` | Onde está | `list_id`, `board_id` |
| `pos` | Ordem na lista (§6) | `position` |
| `closed` | Arquivado | `archived` |
| `idMembers[]` | Pessoas no cartão | `fdp_card_assignees` |
| `idLabels[]` | Etiquetas | `fdp_card_labels` |
| `start` | Data de início | — |
| `due`, `dueComplete` | Entrega e "marcado como concluído" | `due_at`, `closed_at` |
| `dueReminder` | Minutos antes da entrega para lembrar (`-1` sem lembrete) | Alertas de SLA (`sla.tick`) |
| `idChecklists[]` | Várias checklists | Uma lista de itens por demanda + tarefas do processo |
| `badges` | Contadores prontos (comentários, anexos, itens feitos/total, votos) | Calculados no snapshot |
| `cover` | Capa: cor, imagem anexada ou foto | — |
| `idAttachmentCover` | Qual anexo é a capa | — |
| `dateLastActivity` | Última atividade de qualquer tipo | `updated_at` (só edição do cartão) |
| `subscribed` | A pessoa segue o cartão | — |
| `isTemplate` | Cartão-modelo | Modelos de processo |
| `cardRole` | `null`, `separator`, `board`, `mirror`, `link` | `fdp_demand_module_links` / vínculos |
| `customFieldItems[]` | Valores de campos personalizados | `fdp_custom_field_values` |
| `idShort`, `shortLink` | Identidade humana (§2.1) | `reference_number` |

O Vinculato acrescenta tudo o que o Trello não tem e o DP exige: empresa,
colaborador, tipo de processo, competência, prazo legal, área solicitante e
responsável, prioridade, SLA com pausas (`fdp_card_sla_pauses`), regra de corte
(`within_cutoff`, `cutoff_rule_code`), versão do processo e etapa atual, e
`version` para concorrência otimista.

### 5.2 Ações sobre o cartão (o verso)

O verso do cartão no Trello é uma lista de ações de um clique: Participar
(*Join*), Membros, Etiquetas, Checklist, Datas, Anexo, Capa, Campos
personalizados, Mover, Copiar, Espelhar, Fazer modelo, Seguir, Compartilhar,
Arquivar. A edição rápida (`e` no teclado ou o lápis no cartão) abre um menu
flutuante com o mesmo conjunto sem abrir o verso.

### 5.3 Cartões especiais

- **Espelho (*mirror*)** — o mesmo cartão aparece em outro quadro; editar em
  um edita nos dois. Resolve "este trabalho é do RH e do DP ao mesmo tempo".
- **Cartão-link** — colar a URL de um cartão, quadro ou site vira um cartão que
  mostra a prévia do destino.
- **Separador** — um cartão que só divide visualmente a lista.
- **Cartão-modelo** — cartão marcado como modelo; "criar a partir do modelo"
  copia checklists, etiquetas, membros e anexos escolhidos.

**No Vinculato:** o que o espelho resolve no Trello, o Vinculato resolve melhor
com as áreas (solicitante × responsável): a demanda é uma só e aparece para as
duas áreas, sem duas cópias para manter em sincronia. Os vínculos com módulos
(`fdp_demand_module_links`) fazem o papel do cartão-link para objetos internos
(colaborador, fechamento PJ, entrega de EPI).

---

## 6. Ordem: o campo `pos`

Esta é a técnica mais copiável do Trello, e o Vinculato já usa a mesma ideia.

- `pos` é um número de ponto flutuante positivo. A lista mostra os cartões em
  ordem crescente de `pos`.
- Cartão novo no fim: `pos = maior pos da lista + 65536` (a API aceita as
  palavras `"top"` e `"bottom"` e faz a conta). No topo: metade do menor.
- Mover entre dois cartões: `pos = (pos_anterior + pos_seguinte) / 2`. Uma
  única linha é escrita, sem renumerar a lista inteira.
- Depois de muitas inserções no mesmo ponto, a diferença entre vizinhos fica
  pequena demais para o ponto flutuante; o servidor então **renormaliza** a
  lista, reescrevendo as posições com espaço de 65536 de novo. Isso é invisível
  para o usuário e é a única operação de ordem que toca várias linhas.

**No Vinculato:** `fdp_lists.position` e `fdp_cards.position` são
`doublePrecision`; a lista nova entra com `max + 1000` (`app/api/lists/route.ts`).
O que falta conferir quando o arraste dentro da coluna for implementado é a
renormalização: com `1000` de espaço, o meio-termo esgota a precisão útil
depois de algumas dezenas de inserções seguidas no mesmo lugar (bem menos que
com 65536, embora ambos aguentem muito antes de colidir de fato). A regra a
copiar é: **quando a diferença entre vizinhos cair abaixo de um limiar,
renormalizar a coluna numa transação**.

---

## 7. Etiquetas, membros, datas, checklists e campos personalizados

### 7.1 Etiquetas

- Pertencem ao **quadro**, não à área de trabalho. Cada quadro tem as suas.
- Cor fixa de uma paleta (verde, amarelo, laranja, vermelho, roxo, azul,
  céu, lima, rosa, preto, com variantes sutil e forte) ou sem cor; nome
  opcional. Etiqueta pode ter só cor.
- Atalhos `1`–`9` e `0` no teclado aplicam a etiqueta por posição ao cartão
  sob o mouse.
- Filtro do quadro por etiqueta, com "sem etiqueta" como opção.

**No Vinculato:** `fdp_labels` é por **workspace**, com cor livre. Para DP isso
é melhor (a etiqueta "eSocial pendente" quer dizer a mesma coisa em todo
quadro). Não copiar a etiqueta por quadro.

### 7.2 Membros e "Participar"

`idMembers` é uma lista sem dono principal: o Trello não distingue
"responsável" de "envolvido". *Participar* (`space` no teclado) adiciona a si
mesmo.

**No Vinculato:** `fdp_card_assignees` também é lista, mas o quadro lê o
**primeiro** como responsável (`responsibleName` em `board.model.ts`) e a
carteira do DP atribui automaticamente. É a decisão certa para DP: toda
demanda tem um dono, e "todo mundo está no cartão" é como uma demanda fica sem
ninguém. O que falta é o conceito do Trello de **seguir** (§8.4), que é ser
avisado sem ser responsável.

### 7.3 Datas

- `start` (início) e `due` (entrega), cada uma opcional; entrega com hora.
- `dueReminder`: lembrete configurável (no momento, 5 min, 1 h, 1 dia, 2 dias
  antes…).
- `dueComplete`: a caixa "concluído" ao lado da data, independente da lista.
- Selo do cartão muda de cor: amarelo perto do vencimento, vermelho vencido,
  verde concluído.
- Data recorrente **não existe** no cartão; é feita com comando agendado do
  Butler (§11) ou Power-Up.

**No Vinculato:** `due_at` e `legal_due_at` (dois prazos, interno e legal — o
Trello não tem essa distinção e o DP precisa dela), SLA em minutos úteis com
calendário (`fdp_workspace_settings`, `fdp_business_holidays`), e rotinas
recorrentes de verdade (`fdp_recurring_templates`). A data de início também
não existe aqui; o mais próximo é `sla_started_at`. Não é falta séria: no DP
quem define o início é o evento (a admissão chegou), não a pessoa.

### 7.4 Checklists

- Um cartão tem **várias** checklists, cada uma com nome e itens ordenados por
  `pos`.
- Item (`checkItem`): `name`, `state` (`complete`/`incomplete`), e — nos planos
  pagos — `due` e `idMember` (data e responsável por item).
- Item pode virar cartão ("converter em cartão").
- Copiar checklist de outro cartão; ocultar itens concluídos.
- O selo mostra `3/7` e fica verde com tudo feito.

**No Vinculato:** `fdp_checklist_items` é muito mais rico — responsável, área,
SLA por item, obrigatoriedade, bloqueio de avanço, evidência exigida,
documento exigido, regra de conclusão e dependências (`depends_on_json`). O que
o Trello tem e o Vinculato não: **agrupar itens em várias checklists com nome**
("Documentos", "eSocial", "Benefícios") e **converter item em demanda**. O
segundo é útil: um item de admissão que virou problema ("CTPS com
divergência") deveria poder virar demanda própria sem copiar à mão.

### 7.5 Campos personalizados

Tipos: texto, número, data, caixa de seleção (*checkbox*) e lista suspensa
(*dropdown*, com cor por opção). São definidos **por quadro** e podem aparecer
na frente do cartão. Na API, a definição está em `customFields` e o valor em
`customFieldItems` (`value.text`, `value.number`, `value.date`,
`value.checked` ou `idValue` para a opção).

**No Vinculato:** `fdp_custom_fields` com `text`, `number`, `date` e `select`,
por workspace, com `required`. Falta o tipo **caixa de seleção** (sim/não), que
é o tipo mais usado no Trello de DP ("exame admissional feito?", "conta
salário aberta?"). Mapear `checkbox` → `select` com Sim/Não no importador
funciona, mas um tipo próprio é barato.

### 7.6 Anexos e capa

Arquivo, link ou integração (Drive, OneDrive, Dropbox). Imagem anexada pode
virar capa. O limite de tamanho por arquivo depende do plano (muito menor no
Free). **No Vinculato:** `fdp_card_attachments` em Vercel Blob privado,
vinculáveis a item, comentário e etapa do processo. Capa não faz sentido para
DP (documento pessoal não deve aparecer em miniatura no quadro — é dado
pessoal sensível exposto a quem só olha a fila).

---

## 8. Comentários, menções, atividade e notificações

### 8.1 Ações (o log)

Tudo no Trello é uma **ação** (`action`) imutável, com `type`, `date`,
`idMemberCreator` e `data` com o antes e o depois. Tipos que importam:

| `type` | Quando |
| --- | --- |
| `createCard`, `copyCard`, `convertToCardFromCheckItem` | Cartão criado |
| `updateCard` | Qualquer campo mudou; `data.old` traz o valor anterior. Mover de lista é `updateCard` com `data.listBefore`/`data.listAfter` |
| `commentCard` | Comentário (o texto está em `data.text`) |
| `addMemberToCard`, `removeMemberFromCard` | Membro |
| `addAttachmentToCard`, `deleteAttachmentFromCard` | Anexo |
| `addChecklistToCard`, `updateCheckItemStateOnCard` | Checklist |
| `moveCardToBoard`, `moveCardFromBoard` | Troca de quadro |
| `createList`, `updateList` | Lista |
| `addLabelToCard`, `removeLabelFromCard` | Etiqueta |

O verso do cartão mostra comentários e atividade misturados, com
"Mostrar detalhes" para revelar as ações automáticas.

**No Vinculato:** `fdp_activity_events` (o feed) e `fdp_audit_events` (antes e
depois estruturados, ator, IP com hash) separados. É a forma certa: o Trello
usa o mesmo log para mostrar e para auditar, e por isso um comentário apagado
some da auditoria também.

### 8.2 Comentários

Markdown, edição e exclusão pelo autor, reações com emoji, anexar ao
comentário. Comentar por e-mail: responder à notificação vira comentário.

### 8.3 Menções

`@usuario` resolve por **nome de usuário único** (`username`), com
autocompletar enquanto se digita. Há também `@card` (todos os membros do
cartão) e `@board` (todos do quadro, com limite e permissão). Quem é
mencionado recebe notificação mesmo sem estar no cartão.

**No Vinculato:** a menção resolve por *trecho do nome*. Ver o defeito no §18.

### 8.4 Seguir (*watch*)

Seguir um cartão, lista ou quadro faz a pessoa receber notificação de toda
mudança, sem ser membro. Membro do cartão segue automaticamente.

**No Vinculato:** não existe. Quem recebe notificação de comentário é o
responsável e os mencionados. O caso de DP: o solicitante da área (gestor que
pediu a admissão) quer saber quando a demanda andou, sem ser responsável por
ela. Hoje ele precisa ser mencionado a cada passo.

### 8.5 Notificações

Sino com lidas/não lidas, agrupamento por cartão, filtro "só não lidas",
e-mail com frequência configurável (imediato, de hora em hora, diário, nunca) e
notificação no celular. **No Vinculato:** `fdp_notifications` e o resumo diário
por e-mail (§4.15 de `docs/arquitetura-operacional.md`).

---

## 9. Permissões e visibilidade

| Papel | Área de trabalho | Quadro |
| --- | --- | --- |
| Administrador | Gerencia membros, cobrança, quadros | Altera configurações, remove membros |
| Membro (normal) | Cria quadros, vê quadros da área | Edita tudo no quadro |
| Observador (pagos) | — | Vê e comenta conforme `prefs.comments`, não edita |
| Convidado | Não é da área; entra em quadros específicos | Conforme o convite |

Visibilidade do quadro: privado (só membros do quadro), área de trabalho,
organização (Enterprise) ou público (indexável). Configurações do quadro
dizem quem comenta (membros, observadores, área, ninguém) e quem convida.

**No Vinculato:** a permissão é mais fina e no lugar certo para DP — papéis do
workspace, acesso por **empresa** (`fdp_member_company_access`), por área e por
módulo. O Trello não tem nada parecido com "esta analista vê só as empresas da
carteira dela", que é o requisito de sigilo básico de um escritório de DP.
Não copiar o quadro público.

---

## 10. Visualizações

| Visão Trello | Para quê | No Vinculato (`boardViewModes`) |
| --- | --- | --- |
| Quadro (Board) | Colunas por lista | `kanban` |
| Tabela (Table) | Linhas com colunas de campo; também na área de trabalho, juntando vários quadros | `table` |
| Calendário | Cartões pela data de entrega | `calendar` |
| Linha do tempo (Timeline) | Barras de início a entrega, agrupadas por lista, membro ou etiqueta | — |
| Painel (Dashboard) | Gráficos: cartões por lista, por membro, por etiqueta, por data | Indicadores do quadro + Command Center |
| Mapa | Cartões com endereço num mapa | — (não serve ao DP) |
| — | — | `team` (colunas por responsável) |
| — | — | `queue` (fila) |
| — | — | `process` (por etapa do processo) |

**Filtros** do Trello: palavra-chave, membro (incluindo "sem membro" e "meus
cartões"), etiqueta, data (sem data, vencido, vence no próximo dia/semana/mês,
concluído), atividade (última semana, duas semanas, quatro semanas, sem
atividade) e "todas as condições" × "qualquer condição". O filtro fica na URL
(`?filter=member:joao,label:urgente`) e pode ser compartilhado.

**No Vinculato:** `DemandFilters` cobre busca, empresa, tipo de processo,
situação, responsável (com "sem dono"), prioridade, prazo, SLA e competência,
com estado na URL. O que falta do Trello: **filtro por etiqueta** e **filtro
por inatividade** ("parada há mais de N dias") — o segundo é o que acha a
demanda esquecida que ainda está no prazo.

**Tabela da área de trabalho** — a visão que junta cartões de vários quadros
filtrando por membro é o "Minha semana" do Vinculato (§4.34 de
`docs/arquitetura-operacional.md`), que já existe.

---

## 11. Automação (Butler)

O Butler é a parte mais estudada do Trello, porque é onde o cartão genérico
vira processo. Ele tem cinco formas:

| Forma | Como dispara | Exemplo |
| --- | --- | --- |
| **Regra** | Um evento no quadro | "Quando um cartão for movido para *Concluído*, marcar a entrega como concluída e arquivar" |
| **Botão de cartão** | Clique no verso do cartão | "Enviar ao financeiro": mover, adicionar etiqueta, atribuir |
| **Botão de quadro** | Clique no topo do quadro | "Fechar a semana": arquivar tudo em *Concluído* |
| **Comando agendado** | Calendário (todo dia, toda segunda, dia 5 do mês, último dia útil…) | "Todo dia 1º, criar o cartão *Folha de {mês}* com a checklist" |
| **Comando por data** | Relativo à data de entrega dos cartões | "Dois dias antes da entrega, adicionar etiqueta *vence logo* e avisar o membro" |

### 11.1 Gramática

Uma regra é **gatilho + filtros + ações**, escrita como frase:

> quando **um cartão** com a etiqueta *Admissão* **for movido para** a lista
> *Documentação* **por qualquer pessoa**, **adicionar** a checklist *Documentos
> admissionais*, **definir** a entrega para **em 3 dias úteis** e **mencionar**
> @rh no comentário.

- **Gatilhos:** cartão criado, movido, arquivado; etiqueta, membro, data,
  anexo, checklist, comentário, campo personalizado alterado; item marcado;
  data se aproximando.
- **Filtros:** com etiqueta, com membro, na lista, com campo de valor X, título
  contendo, por pessoa.
- **Ações:** mover, copiar, arquivar, adicionar/remover etiqueta e membro,
  definir/limpar data, marcar concluído, adicionar checklist, comentar,
  enviar e-mail, criar cartão, ordenar lista, preencher campo, chamar URL
  (webhook) e encadear com variáveis (`{cardname}`, `{username}`, `{date}`).
- **Cotas:** o número de execuções por mês depende do plano (baixo no Free,
  ilimitado ou alto no Enterprise). Regras que estouram a cota param até o mês
  seguinte — exatamente no fechamento, que é quando um DP mais as usa.

### 11.2 O que o Butler resolve que o Vinculato já resolve de outro jeito

| Uso típico do Butler no DP | Vinculato |
| --- | --- |
| Checklist por tipo de demanda ao criar | Modelo de processo / versão de processo instancia etapas e tarefas |
| Prazo relativo ao mover | SLA por política e por etapa, em dias úteis com feriados |
| Cartão recorrente da folha | `fdp_recurring_templates` (Fase 2 do DP Operacional) |
| "Vence em 2 dias → avisar" | Gatilho `sla.tick` + alertas |
| Atribuir por etiqueta/empresa | Carteira do DP com atribuição automática e backup |
| Arquivar concluídos | Coluna `completed` encerra; arquivamento manual |

### 11.3 O que o Butler tem e o Vinculato não

1. **Botões de cartão e de quadro.** Uma sequência de ações nomeada que a
   pessoa dispara com um clique. É a forma mais barata de automação, porque
   não exige que a pessoa preveja o gatilho: ela decide na hora. Para DP:
   "Devolver para a área — falta documento" = mover para *Aguardando*,
   pausar o SLA com o motivo, comentar com o modelo de texto e notificar o
   solicitante.
2. **Ações** que faltam ao executor (`RULE_ACTIONS` hoje é `moveTo`,
   `slaStatus`, `labelId`, `notify`, `instantiateProcessVersionId`): atribuir
   responsável, comentar com modelo, definir prazo e preencher campo.
3. **Variáveis no texto** (`{cardname}`, `{username}`) nos avisos.
4. **A frase legível** como interface. O Vinculato já descreve o gatilho como
   frase (`RULE_TRIGGER_LABELS`); falta fazer o mesmo com condições e ações
   para a regra inteira ser lida em voz alta antes de salvar.

O que **não** copiar: a cota mensal de execuções e a "ação de chamar URL"
dentro de regra — o Vinculato já tem webhooks de saída com proteção contra
SSRF (`tests/webhook-ssrf.test.mts`), e espalhar chamadas HTTP por regras de
usuário recriaria o risco que esse teste fecha.

---

## 12. Caixa de entrada, Planejador, e-mail para o quadro e modelos

### 12.1 Caixa de entrada (Inbox)

Uma lista pessoal, fora dos quadros, onde chega o que precisa ser triado:
encaminhado por e-mail, salvo do Slack ou do Teams, digitado rápido. Da caixa,
o item é arrastado para um quadro e vira cartão.

**No Vinculato:** `fdp_workspace_inbox_items` com conversão em demanda
(`converted_card_id`) e a triagem por agente (§5.2 de
`docs/arquitetura-operacional.md`). A diferença: a do Trello é **pessoal**; a
do Vinculato é do workspace, que é o certo para DP — o e-mail do cliente
chega para o escritório, não para uma pessoa.

### 12.2 Planejador (Planner)

Calendário pessoal ligado ao Google ou Outlook, onde a pessoa arrasta cartões
para blocos de tempo. **No Vinculato:** `fdp_planner_blocks` e
`fdp_calendar_connections` já existem com o mesmo desenho.

### 12.3 E-mail para o quadro

Cada quadro tem um endereço único; o assunto vira título, o corpo vira
descrição, anexos viram anexos, e é possível escolher a lista de destino e a
posição. **No Vinculato:** o canal de entrada é o inbox do workspace.

### 12.4 Modelos

Modelo de quadro (copia estrutura e cartões de exemplo) e modelo de cartão
(§5.3). A galeria pública de modelos do Trello tem quadros de "Onboarding de
funcionário" e "Processo de contratação" — úteis para entender como clientes
montam o DP no Trello antes de migrar: normalmente uma lista por etapa
(*Recebido → Documentação → Exame → Cadastro no sistema → eSocial → Concluído*)
e uma etiqueta por empresa.

---

## 13. Power-Ups

Extensões que rodam **dentro** da interface do Trello em `iframe`, por meio do
*Power-Up client library*. Um Power-Up declara *capabilities*: botão no verso
do cartão, selo na frente do cartão, seção no verso, botão no quadro, campo
extra, item no menu de anexo. Os dados dele ficam em `pluginData`, com
escopo de cartão, quadro ou membro, e visibilidade compartilhada ou privada.

Os mais usados em DP no Trello: campos personalizados (hoje nativos), Card
Aging, calendário, integração com Google Drive e OneDrive, Slack/Teams,
contagem de tempo (horas trabalhadas no cartão), e repetição de cartão.

**No Vinculato:** não há extensão de terceiros rodando na tela — e não deve
haver. Um `iframe` de terceiro dentro de uma demanda de admissão tem acesso a
CPF, salário e dados de saúde na tela. As integrações (Sólides, Tangerino,
Sankhya, Teams) rodam no servidor, com credencial guardada e auditoria. A
**API v1** com OpenAPI (`app/api/v1/openapi.json`) é o caminho para terceiros.

---

## 14. API REST, webhooks e tempo real

### 14.1 API REST

- Base `https://api.trello.com/1/`. Autenticação por chave da aplicação
  (`key`) + token do usuário (`token`), em parâmetro ou no cabeçalho
  `Authorization: OAuth oauth_consumer_key="…", oauth_token="…"`. Token com
  escopo (`read`, `write`, `account`) e validade (`1hour`, `1day`, `30days`,
  `never`). OAuth 1.0a para aplicações de terceiros.
- Recursos aninhados: `GET /boards/{id}/cards`, `/boards/{id}/lists`,
  `/cards/{id}/actions`, `/cards/{id}/checklists`…
- **Escolha de campos e expansão** na mesma chamada:
  `GET /boards/{id}?fields=name,url&lists=open&cards=visible&card_fields=name,idList,due&members=all`.
  É o que permite montar um quadro inteiro numa requisição.
- **Lote:** `GET /batch?urls=/boards/x,/cards/y` (até 10 GETs).
- **Paginação** de ações por `before`/`since` (datas ou ids) e `limit`
  (máx. 1000).
- **Limites de taxa** por chave e por token em janelas de 10 segundos; ao
  passar, resposta 429 e é preciso esperar.

**No Vinculato:** o snapshot do painel faz o papel da chamada aninhada (um
quadro inteiro numa resposta); a API v1 é pequena e voltada a cadastro e
competência. Para migração e BI, faltariam `GET /v1/demands` e
`GET /v1/demands/{id}/activity`.

### 14.2 Webhooks

- `POST /1/webhooks` com `idModel` (quadro, lista, cartão, membro…) e
  `callbackURL`. O Trello faz um `HEAD` na URL para verificar e só cria o
  webhook se receber 200.
- Cada evento é um `POST` com a **ação** (§8.1) e o modelo.
- **Assinatura:** cabeçalho `X-Trello-Webhook` = Base64(HMAC-SHA1(corpo +
  callbackURL, segredo da aplicação)). Concatenar a URL ao corpo impede reusar
  um evento capturado contra outro endpoint.
- Reentrega com espera crescente quando a URL falha; webhook que falha por
  tempo demais é desativado.

**No Vinculato:** `lib/webhooks.ts` e `lib/outbox.ts` (outbox transacional),
com proteção contra SSRF. A ideia de **assinar o corpo junto com a URL de
destino** é a que vale conferir que o Vinculato também faz.

### 14.3 Tempo real

A interface do Trello é uma SPA que mantém um WebSocket aberto e se inscreve
nos modelos que está mostrando (quadro, cartão aberto, membro). Mudança feita
por outra pessoa chega como delta e é aplicada sem recarregar. Edição
simultânea do mesmo campo é *last write wins* — não há aviso de conflito.

**No Vinculato:** consulta periódica (`/api/realtime`, intervalo
`realtime_seconds`, 30 s por padrão) que só diz *se* algo mudou desde a última
marca, seguida de recarga do snapshot. É mais simples e suficiente para a
escala de um DP. Em compensação, o Vinculato tem o que o Trello não tem:
`fdp_cards.version` para **concorrência otimista** — duas analistas editando a
mesma demanda não se sobrescrevem em silêncio. Não trocar isso por *last write
wins*.

---

## 15. O JSON exportado de um quadro

É o formato que o importador (§17) vai ler. Estrutura de topo:

```text
{
  id, name, desc, closed, url, shortLink, idOrganization,
  prefs { permissionLevel, background, … },
  labelNames { green, yellow, … },
  labels[]        { id, name, color, idBoard }
  lists[]         { id, name, closed, pos, softLimit }
  cards[]         { id, name, desc, closed, idList, pos, idShort, shortLink,
                    due, dueComplete, start, idMembers[], idLabels[],
                    idChecklists[], dateLastActivity, customFieldItems[],
                    attachments[] { id, name, url, mimeType, bytes, date } }
  checklists[]    { id, name, idCard, pos,
                    checkItems[] { id, name, state, pos, due, idMember } }
  customFields[]  { id, name, type, options[] { id, value.text, color } }
  members[]       { id, username, fullName }
  actions[]       { id, type, date, idMemberCreator, data { … } }
  pluginData[], powerUps[]
}
```

O que precisa de cuidado na leitura:

| Ponto | Por quê |
| --- | --- |
| `actions[]` vem **truncado** (as ações mais recentes, até um limite) | Comentários antigos de um quadro grande não estão no arquivo. O importador avisa quantos comentários leu e a data do mais antigo, em vez de fingir que trouxe tudo |
| Comentário é `actions[type=commentCard].data.text` | Não há lista de comentários separada |
| Data de criação do cartão não tem campo | Ler dos 8 primeiros caracteres do `id` (§2.1) |
| Anexo é **URL**, não o arquivo | O arquivo hospedado no Trello exige o token do usuário para baixar. O importador grava o link e o nome; baixar o arquivo é uma etapa separada, com aprovação, porque são documentos pessoais |
| `members[]` não traz e-mail | Casar pessoa por `fullName`/`username` com membro do workspace exige confirmação de quem importa, nunca casamento automático por trecho do nome (§18) |
| `labels[].color` pode ser `null` | Etiqueta só com nome |
| `closed` em lista e cartão | Importar arquivados como arquivados, não como abertos |
| Data `due` em UTC (`…Z`) | Converter para `America/Sao_Paulo` antes de calcular SLA; a mesma armadilha da data pura que o `dueTime` do `board.model.ts` documenta |
| Texto em Markdown | A descrição do Vinculato é texto puro; manter o texto sem renderizar |

O CSV exportado (planos pagos) é uma visão achatada do mesmo conteúdo e perde
checklists e comentários; o JSON é sempre a fonte preferida.

---

## 16. Comparativo item a item com o Vinculato

Legenda: **=** equivalente · **+** Vinculato vai além · **−** falta no
Vinculato · **×** não copiar.

| Recurso do Trello | Vinculato | Situação |
| --- | --- | --- |
| Área de trabalho → quadro → lista → cartão | Workspace → quadro → lista → demanda | = |
| Vários quadros por área | Vários quadros por workspace, seleção persistida | = |
| `pos` em ponto flutuante | `position` `doublePrecision` | = (falta renormalização, §6) |
| `idShort` por quadro | `#DM-` por workspace | + |
| Arquivar / restaurar / apagar | Arquivar / restaurar / apagar / **cancelar com motivo** | + |
| Lista sem comportamento | Lista com `kind` e `sla_behavior` | + |
| Limite de WIP na lista | — | − |
| Ordenar lista por data/nome | Ordenação do recorte (`DemandSort`) | = |
| Cartão genérico | Demanda tipada (empresa, colaborador, processo, competência) | + |
| Data de início | — | − (baixa prioridade) |
| Entrega + lembrete | Prazo interno + prazo legal + SLA útil com pausas | + |
| Várias checklists nomeadas | Uma lista de itens por demanda | − |
| Item com responsável e data | Item com responsável, área, SLA, evidência, dependência | + |
| Converter item em cartão | — | − |
| Etiqueta por quadro | Etiqueta por workspace | + (× não voltar ao por quadro) |
| Campos: texto, número, data, lista | `text`, `number`, `date`, `select` | = |
| Campo caixa de seleção | — | − |
| Anexos | Anexos em Blob privado, por item/comentário/etapa | + |
| Capa do cartão | — | × (dado pessoal na miniatura) |
| Espelho de cartão | Área solicitante × responsável na mesma demanda | + |
| Cartão-modelo / modelo de quadro | Modelo e versão de processo (BPMN) | + |
| Comentário com Markdown, reação | Comentário em texto, por tarefa | − (Markdown e reação, baixa prioridade) |
| Menção por `username` com autocompletar | Menção por nome inteiro; ambígua não avisa ninguém | = (corrigido, §18; falta o autocompletar) |
| Seguir cartão/lista/quadro | — | − |
| Log de ações | Feed de atividade + auditoria estruturada separada | + |
| Notificações + e-mail por frequência | Notificações + resumo diário | = |
| Papéis admin/normal/observador/convidado | Papéis + acesso por empresa, área e módulo | + |
| Quadro público | — | × |
| Visões Quadro, Tabela, Calendário | `kanban`, `table`, `calendar` | = |
| Linha do tempo | — | − (média: prazos de admissão/rescisão em barras) |
| Painel de gráficos | Indicadores do quadro + Command Center + relatório mensal | + |
| Mapa | — | × |
| Visão por responsável | `team` | + |
| Filtro por etiqueta | — | − |
| Filtro por inatividade | — | − |
| Filtro na URL | Recorte na URL | = |
| Atalhos de teclado (`n`, `f`, `q`, `space`, `c`, `d`, `l`, `m`, `1–9`, `?`) | `Ctrl+K`, `Alt+←/→` para mover, `Enter` para abrir | − |
| Butler: regras | Regras com gatilhos de cartão, SLA, processo e evento de domínio | = / + |
| Butler: botões de cartão e de quadro | — | − |
| Butler: comandos agendados | Rotinas recorrentes | = |
| Butler: comandos por data | `sla.tick` | = |
| Butler: atribuir, comentar, definir data, preencher campo | Ações: mover, SLA, etiqueta, avisar, iniciar processo | − |
| Caixa de entrada pessoal | Inbox do workspace + triagem por agente | + |
| Planejador | Planner + conexão de calendário | = |
| E-mail para o quadro | Inbox | = |
| Power-Ups em `iframe` | Integrações no servidor + API v1 | × (não abrir a tela a terceiros) |
| API REST com expansão e lote | Snapshot do painel + API v1 pequena | − (falta demandas e atividade na v1) |
| Webhooks assinados | Webhooks com outbox e anti-SSRF | = |
| WebSocket em tempo real, *last write wins* | Consulta periódica + concorrência otimista | = / + |
| Exportar JSON | Exportação do workspace | = |
| **Importar do Trello** | Importador de JSON com prévia (Configurações → Quadros) | = (feito, §4.43 da arquitetura operacional) |

---

## 17. O que copiar, o que não copiar e roadmap

### Copiar (o conceito, não a forma)

1. **O cartão sempre a um clique da ação.** Botões de demanda nomeados que
   executam uma sequência — é a automação que a analista entende sem treino.
2. **Seguir sem ser responsável.** O solicitante acompanha sem ser dono.
3. **Menção que resolve uma pessoa só,** com autocompletar.
4. **Inatividade como sinal próprio,** separado de atraso.
5. **Teclado** para quem passa o dia no quadro.
6. **Renormalização de posição** quando o meio-termo esgota.
7. **Várias checklists nomeadas** e **converter item em demanda.**

### Não copiar

1. **O cartão genérico.** A demanda tipada é o que permite SLA, corte,
   carteira e relatório. Nenhum importador deve criar demanda sem tipo de
   processo e empresa; o que o Trello não diz, o importador pergunta.
2. **Etiqueta por quadro.** Uma etiqueta quer dizer a mesma coisa no
   escritório inteiro.
3. **Capa com imagem, quadro público, Power-Up em `iframe`.** Todos expõem
   dado pessoal a quem não deveria vê-lo.
4. **Cota de automação por mês.** Ela falha justamente no fechamento.
5. **Last write wins.** A concorrência otimista fica.
6. **Membros sem dono principal.** Toda demanda tem um responsável.

### Roadmap priorizado

| # | Item | Por quê | Tamanho |
| --- | --- | --- | --- |
| 0 | ~~Corrigir a menção por trecho do nome (§18)~~ — **feito** (§4.43 de `docs/arquitetura-operacional.md`) | Avisava a pessoa errada | P |
| 1 | ~~**Importador de quadro do Trello (JSON)**~~ — **feito** (§4.43 de `docs/arquitetura-operacional.md`). — prévia antes de gravar: lista → coluna (com `kind`/`sla_behavior` escolhidos), etiqueta → etiqueta do workspace, membro → membro (confirmado à mão), checklist → itens, campo → campo, comentários das ações, anexos como link; tipo de processo e empresa por regra (etiqueta → empresa, lista → processo) ou em lote na prévia | É o que tira o cliente do Trello; sem ele a migração é digitação | G |
| 2 | Botões de demanda (sequência nomeada de ações, por quadro) | A automação que o DP usa de fato no Butler | M |
| 3 | Seguir demanda + notificação a quem segue | Solicitante acompanha sem menção a cada passo | P |
| 4 | Filtro por etiqueta e por inatividade | Achar a demanda esquecida dentro do prazo | P |
| 5 | Novas ações de regra: atribuir, comentar com modelo, definir prazo, preencher campo | Fecha a lacuna do executor (§11.3) | M |
| 6 | Atalhos de teclado do quadro, com `?` mostrando a lista | Velocidade de quem vive no quadro | P |
| 7 | Campo caixa de seleção | Tipo mais usado em Trello de DP; simplifica o importador | P |
| 8 | Limite de WIP por responsável na visão `team` | Distribuir o dia com o número certo | P |
| 9 | Checklists nomeadas e converter item em demanda | Organização das admissões grandes | M |
| 10 | Linha do tempo | Prazos de admissão e rescisão em barras | M |
| 11 | `GET /v1/demands` e atividade na API v1 | BI e integrações do cliente | M |
| 12 | Renormalização de posição | Necessária quando houver arraste dentro da coluna | P |

---

## 18. Defeito encontrado durante a análise

> **Corrigido** em `lib/comment-mentions.ts` (§4.43 de
> `docs/arquitetura-operacional.md`). O texto abaixo descreve o defeito como
> estava.

**Menção por trecho do nome notifica pessoas erradas.**
`app/api/cards/[id]/comments/route.ts` extrai `@palavra` do comentário e
procura membros com `lower(u.name) LIKE '%palavra%'`. Consequências:

- `@ana` notifica Ana, **Mariana**, **Juliana**, **Luciana** e **Ana Paula** — qualquer nome que *contenha* "ana". Em um escritório de DP
  com 20 pessoas, a notificação de um comentário sobre o salário de alguém
  chega a quem não tem nada com a demanda.
- `_` é curinga do `LIKE` e é aceito pela expressão (`[\p{L}0-9._-]`):
  `@a_a` casa com qualquer nome que tenha "a", um caractere qualquer e "a".
- Até 20 destinatários por menção, sem aviso a quem comentou de quem foi
  avisado.

**Como o Trello resolve:** o `@` resolve um `username` único, escolhido no
autocompletar; o texto guarda o identificador e a tela mostra o nome.

**Correção proposta** (item 0 do roadmap): o autocompletar insere uma marca
com o id do membro (`@[Nome](user:ID)` ou equivalente), a rota notifica só os
ids presentes que sejam membros do workspace com acesso à empresa da demanda,
e um `@palavra` solto sem id casa apenas com nome **igual** (sem acento e sem
caixa), e somente se for único — ambíguo não notifica e a tela avisa.

---

## 19. Glossário Trello ↔ DP ↔ Vinculato

| Trello | Em DP | Vinculato |
| --- | --- | --- |
| Workspace / Organization | Escritório ou área de DP | Workspace |
| Board | Fila de um tipo de trabalho ou de um cliente | Quadro |
| List | Etapa | Coluna (`fdp_lists`, com `kind`) |
| Card | Solicitação / chamado | Demanda (`#DM-…`) |
| Member (no cartão) | Quem está com a solicitação | Responsável |
| Join | "Peguei" | Atribuir a si |
| Watch | Acompanhar | — (roadmap 3) |
| Label | Marcação: empresa, urgência, pendência | Etiqueta |
| Due date | Prazo | Prazo interno / prazo legal / SLA |
| Due complete | Feito | Concluída |
| Checklist | Passo a passo, documentos | Itens e tarefas do processo |
| Custom field | Matrícula, competência, CNPJ | Campo personalizado / campos nativos |
| Archive | Arquivar | Arquivar |
| — | Cancelar (desistência) | Cancelar com motivo |
| Butler rule | Regra | Regra de automação |
| Butler button | Atalho de procedimento | — (roadmap 2) |
| Scheduled command | Rotina do mês | Rotina recorrente |
| Template card / board | Modelo | Modelo / versão de processo |
| Power-Up | Integração | Integração / módulo |
| Inbox | Caixa de entrada | Inbox do workspace |
| Planner | Agenda | Planner |
| Action | Histórico | Atividade / auditoria |
| Observer | Só consulta | Papel de leitura |
| Guest | Cliente convidado | Portal do gestor / do colaborador |
