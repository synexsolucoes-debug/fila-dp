# Arquitetura operacional do Vinculato

Data: 2026-08-22

Este documento descreve **como o trabalho anda dentro do Vinculato**. Ele não é
um inventário de módulos nem um roadmap: é o vocabulário comum que integrações,
agentes, processos e IA passam a usar, e a explicação de por que cada fronteira
está onde está.

Um desenvolvedor novo deve conseguir ler este documento e responder, sem abrir o
código: o que é um evento, o que é um processo, o que é uma demanda, quem pode
mover o quê, e o que a IA pode ver.

---

## 1. O que o Vinculato é

Uma plataforma de **operação, controle, conferência e orquestração** de processos
administrativos e de Departamento Pessoal.

Ele **não** substitui, e não deve tentar substituir: ERP, sistema de folha,
sistema de ponto, prontuário, mensageria, emissor fiscal ou sistema de admissão
digital. Esses continuam sendo **sistemas de origem**.

O Vinculato é a camada onde a organização responde:

| Pergunta | Onde a resposta mora |
| --- | --- |
| O que aconteceu? | Evento de domínio (`fdp_domain_events`) |
| O que precisa ser feito? | Central de Trabalho (`GET /api/work`) |
| Quem precisa fazer? | Responsável da etapa e do item |
| Qual é o prazo? | SLA da etapa e da demanda |
| Em qual processo isso está? | Versão de processo e etapa atual da demanda |
| De onde veio? | Origem e `externalId` do evento |
| Qual evidência existe? | `evidenceRefs` do evento, anexos da demanda |
| O que está bloqueando? | Bloqueadores da transição, pendências bloqueantes |
| O que falta para concluir? | Checklist da etapa |

---

## 2. O fluxo

```
Fonte  →  Evento  →  Agente/Conector  →  Normalização  →  Processo
       →  Unidade de trabalho  →  Demanda/Execução  →  Evidência
       →  Conclusão  →  Auditoria
```

Cada seta abaixo é código, não intenção.

### 2.1 Fonte

O sistema onde o fato aconteceu: Sólides, Sankhya, Tangerino, Teams, ou o próprio
Vinculato quando a operação acontece aqui.

### 2.2 Evento

Duas camadas, e a distinção importa:

- **`fdp_integration_events`** — o que *chegou de fora*, cru, com o
  identificador da origem. É onde a deduplicação acontece, no índice único
  `(workspace_id, integration_id, external_event_id)`.
- **`fdp_domain_events`** — o que *aconteceu no domínio*, no vocabulário do
  Vinculato. Ele é o catálogo versionado de `lib/domain-events.ts`.

Todo evento de domínio carrega: nome, `schemaVersion`, origem, workspace,
`entityType`, `entityId` (quando conhecido), `externalId`, `correlationId`,
`causationId`, `occurredAt`, `receivedAt`, payload, `evidenceRefs` e
`idempotencyKey`.

O catálogo declara, por evento, quais chaves o payload pode carregar. Um evento
de admissão não consegue carregar valor financeiro — não porque alguém revisou,
mas porque `sanitizeEventPayload` descarta o que não está declarado.

### 2.3 Agente ou conector

Automação que **lê** um sistema de origem. Ela normaliza e emite evento; ela não
decide e não escreve no domínio. Ver §5.

### 2.4 Normalização

O texto da origem nunca vira regra interna. `admission.status_changed` carrega
tanto `rawStatus` (o que a origem escreveu) quanto `normalizedStatus` (o
vocabulário do Vinculato). Quando a tradução estiver errada, é pelo `rawStatus`
que se descobre.

### 2.5 Processo → demanda

Ver §3. É o elo que não existia.

### 2.6 Evidência, conclusão, auditoria

Evidência é anexo e referência (`evidenceRefs`). Conclusão é a etapa terminal do
processo. Auditoria é `fdp_audit_events`, append-only por trigger, com antes e
depois.

---

## 3. Processo, versão, instância, etapa e demanda

Este é o vocabulário que mais causava confusão, porque o produto tinha **dois**
conceitos de processo convivendo.

| Termo | O que é | Onde mora |
| --- | --- | --- |
| **Processo** (definição) | O trabalho, descrito de forma versionada. Nome, dono, criticidade, empresas. | `fdp_process_definitions` |
| **Versão** | O desenho publicado: BPMN, etapas, SLA, responsáveis, documentos, aprovações. Imutável depois de publicada. | `fdp_process_versions` + `fdp_process_step_configs` |
| **Instância** | Uma execução daquela versão. **A instância é a demanda** — não existe tabela separada. | `fdp_cards` com `process_version_id` |
| **Etapa** | Onde a instância está agora, dentro daquela versão. | `fdp_cards.current_step_id` |
| **Demanda** | A unidade de trabalho que alguém abre, executa e conclui. | `fdp_cards` |

### 3.1 A regra que não se quebra

**A demanda fica presa à versão que a originou.** Publicar a v5 não move nada da
v4: quem começou sob uma regra termina sob ela. Isso não depende de disciplina —
a chave estrangeira de `fdp_cards` para `fdp_process_versions` não tem
`ON DELETE`, então a versão em uso não some, e a coluna `process_version_id`
aponta a versão específica, nunca "a atual".

### 3.2 Como uma versão publicada gera trabalho

```
Processo "Admissão", versão 4  (publicada)
        │
        │  POST /api/processes/versions/{id}/instantiate
        ▼
Demanda "Admissão — Maria Silva"
  process_definition_id = Admissão
  process_version_id    = v4
  current_step_id       = primeira etapa do desenho
  checklist             = itens da etapa + um por documento obrigatório
```

A etapa inicial é **o destino da primeira seta que sai do evento de início** — não
o evento em si, porque ninguém trabalha em "Início".

### 3.3 Como a etapa avança

`POST /api/cards/{id}/process` e nada mais. Não existe caminho que mova etapa por
`UPDATE` direto. O serviço confere, nesta ordem, e recusa na primeira falha:

1. a demanda segue esta versão;
2. a demanda não está arquivada;
3. a etapa atual existe no desenho;
4. o desenho liga a etapa atual ao destino pedido;
5. o checklist da etapa está concluído;
6. a evidência exigida está anexada;
7. quem está movendo é o responsável (ou administrador);
8. quando a etapa exige aprovação, quem move é aprovador — e não é quem abriu a
   demanda;
9. a etapa e a versão da linha não mudaram desde a leitura (§7).

`GET` na mesma rota devolve os destinos possíveis **com o motivo de cada
bloqueio**, para a tela desabilitar o botão dizendo o que resolve.

### 3.4 Demanda legada e `fdp_process_templates`

Demanda sem `process_version_id` continua funcionando exatamente como antes.
**Não há conversão automática de histórico**: converter sem regra comprovada
inventaria vínculo, e vínculo inventado em DP vira erro trabalhista.

`fdp_process_templates` (os modelos de checklist antigos) **permanece**. Ele e a
Biblioteca de Processos convivem: o primeiro dá checklist a uma demanda solta, o
segundo define um fluxo executável. A transição é por adoção, não por migração
forçada — e `demands_from_process` (§8) é o número que dirá quando o legado
puder ser aposentado.

---

## 4. Unidade de trabalho e a Central de Trabalho

O produto tem quatro objetos que significam "alguém precisa fazer algo":

- `fdp_cards` — demandas;
- `fdp_employee_movements` — movimentações;
- `fdp_auxiliary_executions` — entregas auxiliares;
- `fdp_operational_pending_items` — pendências operacionais.

Mais aprovações (`fdp_movement_approval_steps`) e triagem
(`fdp_agent_proposals`, `fdp_movement_suggestions`).

**Eles não foram fundidos, e não devem ser.** Cada um carrega invariantes
próprias no banco — imutabilidade de fechamento, ordem de cálculo, append-only.
Uma fusão destrutiva jogaria essas garantias fora.

O que existe é uma **camada de leitura**: `lib/work-items.ts` define o contrato
`WorkItem` e um registro de fontes, e `GET /api/work` responde "o que está comigo
hoje?". Nenhuma escrita passa por ali; cada item traz o `href` da tela que o
resolve.

### 4.1 A regra para o futuro

Funcionalidade nova que produza trabalho **registra uma fonte em
`lib/work-items.ts`**. Ela não cria o quinto objeto paralelo com a quinta tela.

### 4.2 A tela

`/painel/trabalho` responde "o que está comigo hoje?" item a item. Ela não
substitui Demandas nem nenhuma outra: cada linha leva à tela do módulo que
resolve aquele item, e nada é editado ali dentro.

**O servidor decide tudo o que muda o conjunto** — escopo, filtros, ordenação,
agrupamento, contadores e página. A tela decide só a apresentação. Filtrar no
navegador exigiria baixar a fila inteira para esconder metade dela, e é assim
que uma lista de trabalho fica lenta justamente para quem tem mais trabalho.

Sete fontes entram em um `UNION ALL` único. Consultar fonte a fonte obriga a
trazer `limite` linhas de **cada** uma para escolher as `limite` primeiras do
conjunto: o custo cresce com o número de fontes, não com o tamanho da página.

A paginação é por **cursor**, e o cursor carrega a tupla inteira da ordenação —
urgência, prazo, criação e identificador. Página numerada devolveria item
repetido e pularia outro, porque a fila muda enquanto a pessoa lê; e um cursor
por uma coluna só pularia itens empatados.

Uma das sete fontes é a **falha de execução que esgotou as tentativas**. Ela não
segue sozinha e exige decisão humana; se existisse apenas na tela de
integrações, ficaria esperando alguém abrir aquela tela por acaso.

| Verificação | Onde |
| --- | --- |
| A união prepara contra o schema real | `npm run db:rehearse-work` |
| O plano e o tempo com volume de cliente grande | `npm run db:measure-work` |

---

## 5. Agentes

A cadeia é obrigatória e não tem atalho:

```
Agente  →  proposta  →  motor determinístico  →  serviço de domínio
        →  execução  →  auditoria
```

O agente **propõe**. Ele não executa SQL, não escreve no domínio, não decide
regra trabalhista, não aprova remuneração, desligamento ou financeiro, não
escreve em ERP e não contorna processo.

Isso não é promessa de documentação: `lib/agent-proposals.ts` é uma função pura
sem acesso a banco — há teste que reprova se ele ganhar um — e a única saída dele
é uma decisão.

### 5.1 Níveis de confiança

| Situação | Decisão |
| --- | --- |
| Agente pausado no workspace | recusa |
| Proposta sem agente ou sem evento de origem | recusa |
| Ação fora do catálogo | recusa |
| Entidade não identificada | **triagem** |
| Automação desligada no grupo | **triagem** |
| Ação sensível (salário, desligamento, aprovação, reabertura, ERP) | **sugestão — sempre humano** |
| O próprio agente pediu validação | sugestão |
| Confiança < 0,50 | **triagem** |
| Confiança < 0,85, ou grupo não configurado para automação | sugestão |
| Sem evidência anexada | sugestão |
| Confiança ≥ 0,85, rotina, grupo confiável, com evidência | **execução** |

Ação sensível nunca executa sozinha, qualquer que seja a confiança e qualquer que
seja a configuração do grupo.

### 5.2 Triagem

Quando o sistema não identifica com segurança o colaborador, a empresa, o
processo, a categoria, o responsável, a ação ou o contexto, a entrada **vira item
de triagem** — nunca um palpite. Quem classifica é uma pessoa, e a classificação
entra no histórico.

`/painel/triagem` é a leitura única sobre as **duas** filas de incerteza que
existem: `fdp_agent_proposals` (o que um agente propôs e o motor não autorizou) e
`fdp_movement_suggestions` (o que a leitura do Teams reconheceu sem os dados
obrigatórios). Elas não foram fundidas — guardam regras diferentes — e cada uma
continua sendo resolvida pela rota que a governa:

| Origem | Rota que resolve |
| --- | --- |
| Proposta de agente | `POST /api/agents/proposals/:id/resolve` |
| Sugestão do Teams | `POST /api/integrations/movements/:id` |

A Central de Triagem **não tem porta de escrita própria**: há teste que reprova
se ela ganhar uma. Confirmar ali chama a rota do módulo, que reavalia versão,
etapa, destino autorizado, checklist, evidência, responsável, aprovador e
concorrência do zero.

O que a tela mostra, e por quê:

- **o motivo da incerteza**, com o que resolve — cada código do motor tem uma
  frase própria, e há teste que reprova quando um código novo chega sem
  tradução. O pior desfecho possível é alguém confirmar um vínculo por
  eliminação porque a tela não explicou o que estava em dúvida;
- **confiança em palavra**, com o número junto, usando os mesmos limiares do
  motor — importados, não copiados, porque duas réguas divergem;
- **o payload em frases rotuladas**, com no máximo doze campos e sem objeto
  aninhado. Documento, e-mail e telefone aparecem redigidos: esconder tudo
  tornaria a conferência impossível, mostrar tudo distribuiria dado sensível sem
  necessidade;
- **o histórico**: quem resolveu, quando, com que decisão, com que nota e com
  que resultado.

Encaminhar um item para outra pessoa não é resolver: ele continua na mesma fila,
com o mesmo estado, e o que muda é de quem a operação espera a decisão
(`assigned_to` na própria proposta, e não uma fila de encaminhamento ao lado).

### 5.3 Kill switch

Todo agente pode ser desativado por workspace, sem deploy:
`PATCH /api/agents` com `{ agentKey, enabled: false }`.

O interruptor é `fdp_integrations.status`, o mesmo que o webhook já respeita —
não existe um segundo lugar por onde a automação continue rodando depois de
pausada.

### 5.4 Agente e integração não são a mesma coisa

**Integração** é a conexão: para onde apontar, com que credencial, com que
mapeamento. **Agente** é o executor que lê aquela origem, interpreta e propõe.

| Canal | Integração | Agente executor |
| --- | --- | --- |
| `sankhya_browser` | sim | sim — navegador |
| `tangerino` | sim | sim — API |
| `solides` | sim | sim — API |
| `teams` | sim | **não** — a entrada é webhook; não há nada a buscar |

Por isso a Central de Agentes mostra o Teams com execução vazia em vez de fingir
que ele tem uma.

### 5.5 Execução automática

A execução recorrente **não criou runner nem tabela**. A conferência exigida
antes de criar devolveu tudo já em produção: `fdp_integration_jobs` (reserva,
espera, dead-letter), `fdp_integration_sync_runs` (contadores e erro),
`fdp_integration_run_logs` (log por execução) e a varredura agendada que já
drena essa fila. O que faltava era **quando** enfileirar.

Nenhum agente roda dentro da requisição de quem abriu a tela: o botão "Executar
agora" **enfileira**, e a varredura executa.

| Cadência | Intervalo | Expediente |
| --- | --- | --- |
| Somente manual | — | — |
| A cada 15 minutos | 15 min | não |
| A cada 30 minutos | 30 min | não |
| De hora em hora | 60 min | não |
| De hora em hora, no expediente | 60 min | sim |
| Uma vez por dia | 24 h | sim |

Quinze minutos é o piso: abaixo disso a varredura de meia em meia hora deixa de
fazer sentido e um provedor com limite de requisições vira um incidente nosso.
Cadência abaixo do piso é **recusada na entrada**, não corrigida em silêncio.

"No expediente" significa o expediente **do grupo**: segunda a sexta, das 8h às
18h, no fuso configurado no conector. A persistência segue em UTC.

Onde mora cada garantia:

| Garantia | Onde |
| --- | --- |
| Dois runners não pegam o mesmo job | `lease_token` + `FOR UPDATE SKIP LOCKED` |
| Dois jobs não existem para o mesmo conector | índice único parcial `fdp_integration_jobs_active_uq` |
| Execução longa não perde a reserva | `renewAgentLease`, chamado a cada fase pelo worker de navegador |
| Reserva abandonada volta à fila | a consulta de reserva aceita `leased` com prazo vencido |
| Não se martela origem fora do ar | espera de 1, 5, 15 e 60 minutos em `consecutive_failures` |
| Falha repetida não passa despercebida | `degraded_since` a partir da terceira falha seguida |
| Item irrecuperável não some | `dead_letter`, visível e reprocessável |

**Custo**: agente pausado, sem credencial, sem mapeamento publicado, com cadência
manual ou fora do expediente nem chega a ser enfileirado, e o motivo de cada
recusa é nomeado na resposta da varredura.

**Reprocessar** devolve o **mesmo** job à fila, com o mesmo `run_id` e, portanto,
as mesmas chaves de idempotência dos itens. O que já entrou não entra de novo —
um job novo com chave nova reabriria a porta que a idempotência fecha.

| Verificação | Onde |
| --- | --- |
| Dois runners, lease, timeout, backoff, dead-letter, idempotência | `npm run db:rehearse-scheduler` |
| Cadência, expediente, fuso e estado do agente | `tests/agent-schedule.test.mts` |

---

## 6. Fronteiras dos sistemas externos

| Sistema | Papel | O que o Vinculato **não** faz |
| --- | --- | --- |
| **Sólides** | Origem da admissão digital | Não reconstrói admissão por API; não oferece fluxo concorrente de admissão |
| **Sankhya** | Sistema de registro (ERP) | Não sobrescreve estado operacional interno com dado externo; preserva o valor externo **e** o do Vinculato |
| **Teams** | Canal de comunicação | Teams não é domínio: mensagem vira evento, evento vira trabalho |
| **Tangerino** | Fonte de ponto e de andamento de admissão, quando disponível | Seletores provisórios permanecem marcados como provisórios até validação real |
| **Caju** | Meio de pagamento complementar | Não gera arquivo fora do modelo oficial cadastrado |
| **Vinculato** | Orquestração, conferência e execução operacional | Não é ERP, não é folha, não é ponto |

### 6.1 Teams, ponta a ponta

```
Mensagem no Teams
   → Power Automate
   → POST /api/integrations/webhook/teams?workspaceId=…  (segredo por workspace)
   → fdp_integration_events         (dedup pelo id da mensagem)
   → interpretação                   (lib/teams-movements.ts)
   → demanda | sugestão | nada
```

O `workspaceId` vem na URL mas **não** é aceito por si só: a requisição só passa
se o segredo conferir com o daquele workspace.

### 6.2 Sólides e Tangerino, e o limite honesto

Automação por navegador é **somente leitura** e totalmente isolada do domínio:
abrir → ler → identificar → normalizar → **emitir evento**. Nunca abrir → decidir
→ alterar.

Quando um seletor falha, a admissão **não** é marcada como alterada. O evento
`source.ui_changed` é emitido, a última informação válida é preservada, e nenhuma
decisão é tomada sobre leitura incompleta.

---

## 7. Concorrência

Onde as pessoas realmente colidem, existe controle otimista:

- `fdp_cards`, `fdp_contractor_closings` e `fdp_time_sheets` têm `version`,
  incrementada por trigger — em trigger, e não em cada `UPDATE`, porque um
  caminho de escrita esquecer de somar transformaria a coluna em falsa garantia.
- Quem quer a garantia acrescenta `AND version = ?` e trata zero linhas como
  **409 Conflict**.
- A interface diz "este registro foi alterado por outra pessoa" e oferece
  recarregar.

`npm run db:rehearse-concurrency` exercita, com conexões paralelas de verdade:
duas edições da mesma demanda, dois webhooks idênticos, dois workers, duas
aprovações e dois fechamentos. Em todos, um vence e o outro é recusado.

---

## 8. IA

O modelo **não recebe SQL e não recebe acesso a tabela**. Ele recebe respostas.

`lib/assistant/named-queries.ts` é um catálogo fechado de perguntas autorizadas.
Para cada pergunta, o servidor:

1. valida o usuário;
2. valida a capability;
3. aplica o workspace;
4. aplica o escopo de empresa;
5. executa a consulta escrita por nós;
6. agrega;
7. remove o que não for número ou data;
8. entrega ao modelo.

Quem escolhe a consulta é um casamento determinístico por termo — **nunca o
modelo**. Deixar a IA escolher seria dar a ela a decisão de qual dado sai do
ambiente.

Toda consulta é agregada por construção, e nenhuma seleciona coluna de
identificação pessoal. Há teste que reprova as duas coisas.

O registro guarda a consulta, o usuário, o workspace, o horário, a duração e os
agregados — **não** a pergunta em texto livre, que pode conter PII.

---

## 9. Telemetria de adoção

`fdp_workspace_usage_counters` mede, por grupo e por mês, sem PII:

`demands_from_process`, `process_steps_advanced`, `process_instances_completed`,
`events_received`, `events_deduplicated`, `triage_opened`,
`agent_actions_automatic`, `agent_actions_refused`, `work_center_opened`,
`assistant_queries`, `deep_links_opened`.

São esses números que dizem se a consolidação está funcionando — e é a razão
entre `agent_actions_automatic` e `agent_actions_refused` que diz se a automação
está calibrada.

---

## 10. Endereços do painel

O painel troca de visão por estado, mas o estado tem endereço
(`lib/panel-routes.ts`). Funciona: atualizar a página, voltar, avançar, abrir em
nova aba, copiar link, mandar para um colega e abrir um registro direto.

Endereço é um **pedido**, nunca uma permissão: quem recusa continua sendo o
servidor, na rota de dados. Deep link sem sessão redireciona ao login preservando
o destino.

---

## 11. A regra final de arquitetura

A partir daqui, nenhuma funcionalidade operacional nova cria isoladamente:

- novo objeto de trabalho → registre uma fonte em `lib/work-items.ts`;
- nova máquina de aprovação → use o modelo de aprovação existente;
- novo mecanismo de evento → use o catálogo em `lib/domain-events.ts`;
- novo mecanismo de integração → entre por `fdp_integration_events`;
- novo sistema de status → use o vocabulário do domínio que já existe.

O objetivo é impedir que o próximo módulo seja o quinto objeto paralelo.

---

## 12. Onde ler mais

- `docs/diagnostico-arquitetura-2026-08.md` — diagnóstico técnico e fases.
- `docs/auditoria-estrategica-saas-2026-08.md` — auditoria de produto.
- `docs/integracao-teams-e-tangerino.md`, `docs/integracao-solides.md`,
  `docs/integracao-sankhya.md` — cada integração em detalhe.
- `docs/pagamentos-psicologos-e-pj.md` — o motor de pagamento PJ.
- `docs/conferencia-de-ponto.md` — a fronteira do ponto.
- `docs/controle-de-epi.md` — a fronteira do EPI.
- `docs/operacao-de-agentes.md` — como operar os agentes no dia a dia.
