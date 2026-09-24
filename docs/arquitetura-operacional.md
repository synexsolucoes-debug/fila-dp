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

### 3.5 Motor de Jornadas — evento de domínio inicia processo sozinho

Até aqui, uma versão publicada só virava demanda quando alguém clicava em
"iniciar processo". O gatilho `domain_event` do motor de automação
(`lib/automation-rules.ts`, `lib/domain-event-automations.ts`) fecha o primeiro
elo do que a documentação de produto chama de **Jornada**: um evento de
domínio (`employee.admitted`, por enquanto — o único emitido em produção,
pela criação manual de colaborador em `POST /api/employees`) inicia sozinho a
versão publicada que uma regra do workspace escolheu, sem esperar alguém abrir
a tela.

A regra funciona assim:

- **Gatilho** `domain_event` + **condição** `{ domainEvent: "employee.admitted", … }`
  — a rota (`app/api/catalog/route.ts`) recusa gravar sem um nome de evento que
  o catálogo (`lib/domain-events.ts`) reconheça.
- **Ação** `{ instantiateProcessVersionId, boardId? }` — a única ação que faz
  sentido aqui, porque é a única que não pressupõe um `cardId` que ainda não
  existe. A rota recusa qualquer outro par (gatilho ≠ `domain_event` com esta
  ação, ou `domain_event` com outra ação): uma regra assim seria salva e nunca
  faria nada.
- **Execução**: `runDomainEventAutomations` roda **depois** do lote que gravou
  o evento — nunca dentro dele. Iniciar um processo é consequência de o fato
  já existir, não parte do mesmo fato: se a versão foi despublicada ou o
  quadro removido, o cadastro que disparou o evento continua valendo, e a
  regra é apenas ignorada com o motivo (nunca lança).
- **Idempotência**: a chave do evento `process.instance_started` amarra a
  regra ao evento que a disparou (`automation:{ruleId}:{event.idempotencyKey}`).
  A mesma ocorrência não abre uma segunda demanda, e duas regras diferentes
  para o mesmo evento não colidem entre si.
- A demanda nasce pela **mesma** `prepareProcessInstance` da instanciação
  manual — checklist da etapa inicial, prazo calculado, evento de domínio
  gravado no mesmo lote — só a origem do gatilho muda.

O que isto deliberadamente ainda não faz: não há subprocesso paralelo com
junção (uma etapa por área, todas ao mesmo tempo, um veredito que espera
todas) — hoje a versão publicada continua sendo um fluxo sequencial só, com
fan-out para outras áreas via `create_task` nas automações de etapa
(`lib/process-automations.ts`). E só um evento tem emissor em produção: ligar
`termination.requested`, `role.change_requested` e os demais do catálogo a um
ponto real de emissão é o próximo passo, não este.

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

Nove fontes entram em um `UNION ALL` único. Consultar fonte a fonte obriga a
trazer `limite` linhas de **cada** uma para escolher as `limite` primeiras do
conjunto: o custo cresce com o número de fontes, não com o tamanho da página.

A paginação é por **cursor**, e o cursor carrega a tupla inteira da ordenação —
urgência, prazo, criação e identificador. Página numerada devolveria item
repetido e pularia outro, porque a fila muda enquanto a pessoa lê; e um cursor
por uma coluna só pularia itens empatados.

Uma das nove fontes é a **falha de execução que esgotou as tentativas**. Ela não
segue sozinha e exige decisão humana; se existisse apenas na tela de
integrações, ficaria esperando alguém abrir aquela tela por acaso.

### 4.3 Motor de Prazos — passo 1: ler o vencimento onde ele já mora

Duas fontes novas respondem "o que vence esta semana?" sem criar a tabela de
prazos que a análise de produto cogitava: **obrigação legal**
(`fdp_compliance_obligations`, aberta ou em andamento) e **CA de EPI vencendo**
(`fdp_epi_products.ca_expires_on`, dentro de 60 dias ou já vencido). Nenhuma das
duas guarda uma data própria — elas leem a que já existe, porque uma segunda
cópia da mesma data divergiria da fonte no primeiro `PATCH` que uma esquecesse
de atualizar as duas.

- **Obrigação legal** mantém o próprio status de sempre (`open`, `in_progress`,
  `blocked`) — não um "vencendo"/"vencida" sintético. A urgência do conjunto já
  trata `blocked` como tier 0, igual a vencido: uma obrigação travada ordena
  junto do que está atrasado, o prazo estando perto ou não.
- **CA de EPI** não tem status de fluxo — só existe ou não existe o produto. A
  fonte sintetiza `safe`/`warning`/`overdue` a partir da data, o mesmo
  vocabulário que `sla_status` de demanda já usa: a Central não ganhou uma
  terceira régua de urgência, ela reaproveitou a que já tinha.
- Nenhuma das duas é recortada por `mineCondition` de propósito distinto:
  obrigação tem dono (`owner_user_id`) e é recortada por ele; EPI é do
  workspace, não de uma pessoa nem de uma empresa (o mesmo motivo de `triage` e
  `integration_failure` não terem recorte pessoal).
- `blockedReasonOf` passou a receber a fonte, porque `blocked` significa duas
  coisas diferentes agora — pendência de fechamento numa, motivo próprio da
  obrigação na outra — e reaproveitar a mesma frase contaria uma causa que a
  linha não tem como saber.

**O que isto ainda não faz**, com a mesma honestidade do resto do documento:
não há motor de antecedência configurável (avisar 45/15/5 dias antes, por
tipo), não há escalonamento por notificação externa, e só dois tipos de
vencimento têm fonte — experiência, férias, contrato PJ e documento continuam
sem uma. Cada um desses é a mesma receita: achar a data que já existe em algum
lugar do produto e registrar uma fonte aqui, nunca uma tabela nova.

| Verificação | Onde |
| --- | --- |
| A união prepara contra o schema real | `npm run db:rehearse-work` |
| O plano e o tempo com volume de cliente grande | `npm run db:measure-work` |

### 4.4 Notificação externa — convite e recuperação de acesso por e-mail

Até aqui só a confirmação de cadastro (`sendSignupConfirmationEmail`, §80)
enviava e-mail de verdade — convite de membro e link de recuperação
**geravam o link e paravam**: a tela devolvia a URL para o administrador
copiar e mandar por fora. `lib/email.ts` generalizou o adaptador do Resend
(`dispatchTransactionalEmail`) e `POST /api/members` e
`POST /api/members/[id]/recovery` passaram a chamar
`sendMemberActivationEmail`/`sendAccessRecoveryEmail` logo depois de gravar o
token de recuperação, usando o `id` da própria linha do token como
`Idempotency-Key` do Resend.

A postura é deliberadamente diferente da confirmação de cadastro:

- **Nunca bloqueia.** As duas funções devolvem `null` sem e-mail configurado
  e nunca lançam — uma falha de envio vira log
  (`members.activation_email_failed` / `members.recovery_email_failed`) e a
  resposta da rota continua sendo o convite ou o link criado, exatamente como
  hoje. O comportamento que o administrador já usa (copiar o link e mandar
  por fora) não deixou de existir; o e-mail é um canal a mais.
- A resposta ganhou `emailSent: boolean`, para a tela distinguir "enviei e
  também copiei o link" de "só copiei o link" sem adivinhar pela ausência de
  erro.

**O que isto ainda não faz**: não existe "esqueci minha senha" autosserviço
(o link de recuperação continua sendo gerado por um administrador para um
membro específico, nunca pelo próprio usuário), e não existe um primitivo de
link assinado genérico reutilizável por outras ações (aprovação por e-mail,
por exemplo) — cada fluxo ainda tem seu próprio token
(`fdp_access_recovery_tokens`, `fdp_contractor_invoice_tokens`).

| Verificação | Onde |
| --- | --- |
| O adaptador e as duas mensagens nunca lançam sem provedor configurado | `tests/email.test.mts` |

### 4.5 Unidade — o primeiro passo da Matriz de Requisitos

`fdp_establishments` é um cadastro auxiliar novo, no mesmo desenho simples de
`fdp_departments`/`fdp_positions`/`fdp_cost_centers`/`fdp_work_schedules`/
`fdp_unions` (código, nome, status, recortado por empresa e workspace): a
análise de produto de set/2026 nomeou a falta de uma unidade/estabelecimento
distinta da empresa — cliente com mais de um endereço físico sob o mesmo CNPJ
(matriz e obra, loja e depósito) não tinha onde registrar isso além do nome da
própria empresa. Por já existir o framework genérico de cadastros auxiliares
(`app/api/registrations/catalogs/[resource]/route.ts`), a unidade entrou sem
nenhuma rota nova: só a entrada em `lib/registrations.ts` e a tela em
`RegistrationsView.tsx`, exatamente como `unions` entrou antes dela.

Colaborador já escolhe a unidade: `fdp_employees.establishment_id`
(0096_employee_establishment.sql) é uma FK opcional, no mesmo padrão de
`cost_center_id`/`work_schedule_id` — nula para todo colaborador existente,
sem migração de dado nenhum, porque nenhum tinha unidade antes de a coluna
existir. `POST`/`PATCH /api/employees` e a tela de cadastro aceitam o campo
exatamente como aceitam centro de custo e jornada.

Obrigação legal também já é localizada por unidade:
`fdp_compliance_obligations.establishment_id` (0097_obligation_establishment.sql)
segue o mesmo padrão — FK opcional, nula em toda obrigação existente. A visão
geral de Operações (`/api/operations/overview`) passou a devolver a lista de
unidades ativas da empresa junto com aprovadores, e o formulário de nova
obrigação (`OperationDialogs.tsx`) ganhou o campo, sempre opcional: uma
obrigação sem unidade continua válida, exatamente como hoje.

**O que isto ainda não faz** — e é deliberado, para não entregar mais do que
os vínculos em si: a Matriz de Requisitos genérica (que juntaria EPI, exame
ocupacional e treinamento sob um mesmo cadastro, hoje cada um seria uma
tabela à parte) continua sendo o próximo passo, não este, e nenhuma tela
ainda filtra ou agrupa obrigação legal por unidade — o dado existe para ser
preenchido e consultado depois, não para gerar um relatório novo já neste
incremento. Cada vínculo é um incremento à parte, pelo mesmo motivo de
`fdp_unions` ter entrado sozinho: mudar uma tabela sem um consumidor real do
vínculo seria a "tabela para o futuro" que a regra de arquitetura deste
documento recusa (§93).

| Verificação | Onde |
| --- | --- |
| RLS forçado e o mesmo desenho tenant-scoped dos outros cadastros auxiliares | `tests/sankhya-catalog-xlsx.test.mts` |
| Colaborador e obrigação legal aceitam unidade do mesmo jeito que aceitam centro de custo e jornada | `tests/sankhya-catalog-xlsx.test.mts`, `tests/obligation-establishment.test.mts` |

### 4.6 Cargo rico, passo 1 — grau de risco e atividades especiais

`fdp_positions` já tinha CBO como dado "rico" do cargo, sem consumidor além da
própria tela de cadastro (0013_registrations_foundation.sql). Grau de risco
(`risk_level`, vocabulário fechado none/low/medium/high) e atividades
especiais (`special_activities`, texto livre) entram no mesmo padrão — nenhum
dos dois tem taxonomia imposta pelo produto, porque não é o Vinculato quem
decide o que é "atividade especial" no cliente. A análise de produto de
set/2026 nomeou isto como base da Matriz de Requisitos e do futuro controle
de exames ocupacionais: sem saber o risco de um cargo, não há como decidir
depois quais exames ou treinamentos ele exige.

**O que isto ainda não faz** — e é deliberado: nenhuma regra usa `risk_level`
ainda para decidir nada automaticamente (nenhum EPI obrigatório é sugerido a
partir do risco, nenhum exame é exigido a partir da atividade especial). Os
dois campos são hoje só cadastro, consumidos pela própria tela de cargo,
exatamente como `cbo_code` já era antes deles. Controle de exames
ocupacionais (ASO) e a Matriz de Requisitos genérica continuam sendo os
próximos passos.

| Verificação | Onde |
| --- | --- |
| Colunas novas com default seguro, vocabulário fechado no risco, e a importação do Sankhya não sobrescreve o que foi cadastrado manualmente | `tests/position-risk-profile.test.mts` |

### 4.7 Unidade como terceira dimensão da regra de EPI obrigatório

`fdp_epi_requirements` já tinha duas dimensões de escopo — departamento e
cargo, com NULL significando "qualquer um" (0048_epi_compliance.sql). Unidade
entrou como a terceira, no mesmo desenho: obra e escritório da mesma empresa
podem exigir EPIs diferentes para o mesmo cargo, e até aqui a única saída era
duplicar o cargo por endereço. Diferente dos vínculos de §4.5, este toca a
função pura que decide conformidade
(`lib/epi-compliance.ts#buildEpiCompliance`): a precedência "regra mais
específica vence" (`specificity`) passa a contar as três dimensões, não duas,
e as três rotas que leem a matriz (`/api/epi/requirements`,
`/api/epi/employees/[id]`, `/api/epi/dashboard`, `/api/epi/reports`) recortam
por `establishment_id` do mesmo jeito que já recortavam por
`department_id`/`position_id`.

O índice único da regra (`fdp_epi_requirements_scope_product_uq`) precisou
ser recriado para incluir `COALESCE(establishment_id, '')`: como toda regra
existente tem unidade nula, a chave nova é estritamente mais restritiva que a
anterior — nenhuma regra que já era única deixa de ser.

| Verificação | Onde |
| --- | --- |
| A coluna é nova e nula, e a função pura trata unidade como mais uma dimensão de especificidade | `tests/epi-requirement-establishment.test.mts` |

### 4.8 Controle de exames ocupacionais (ASO), passo 1

`fdp_occupational_exams` é o segundo consumidor real do grau de risco
descrito em §4.6: se um cargo tem risco, o próximo passo é saber se o
colaborador está com o ASO em dia para ele. Diferente do Dashboard de
Acidente de Trabalho (`fdp_work_accidents`, 0083), que anonimiza o
colaborador porque é estatístico, o exame ocupacional tem FK real para
`fdp_employees` — é a própria razão do módulo existir: "este colaborador
específico está apto?", não "quantos acidentes tivemos este mês?".

O vocabulário é fechado nos dois eixos que importam: `exam_type`
(admissional/periódico/retorno ao trabalho/mudança de função/demissional/
outro) e `result` (apto/inapto/apto com restrição), ambos com `CHECK` no
banco e validados de novo em `lib/occupational-exams.ts`. Restrição
funcional (`restriction_notes`) só existe quando o resultado é "apto com
restrição" — imposto por `CHECK` e pela validação de entrada.

A fronteira clínica segue a mesma praticada em Psicologia
(`lib/auxiliary.ts#assertNoClinicalData`, tests/psychology-clinical-boundary):
o fato administrativo (apto/inapto/restrição funcional) entra, diagnóstico,
prontuário, medicação e sintoma não. A guarda ficou em
`lib/occupational-exams.ts#assertNoClinicalData` — dedicada, não reaproveitou
a de `lib/auxiliary.ts`, porque aquela é escopada a `moduleType ===
"psychology"` e pensada para o sistema de provedores (psicólogo/operadora de
benefício/terceirizada) que não existe em ASO.

A tela ainda não tem página própria: vive embutida na ficha do colaborador
(`EmployeeExamsPanel`, aba "Exames (ASO)" em `RegistrationsView.tsx`), no
mesmo padrão de onde os painéis de EPI e psicologia já vivem antes de terem
tela dedicada. Por isso a capacidade de escrita (`exams.manage`,
`exams.delete`) entrou no módulo `registrations`, não num módulo "safety" —
negar Cadastros fecha a aba, e isso é o correto hoje.

A coluna `next_due_date` tem índice parcial (`WHERE next_due_date IS NOT
NULL`) pensado para o Motor de Prazos (§4.3), mas ainda não está ligada a
ele.

**O que isto ainda não faz** — e é deliberado: `next_due_date` não alimenta a
Central de Trabalho ainda (nenhuma unidade de trabalho nasce quando um exame
vence); `risk_level` do cargo não determina automaticamente que tipos de
exame um colaborador precisa (isso seria a Matriz de Requisitos genérica,
ainda não construída); e não há tela própria fora da ficha do colaborador.

| Verificação | Onde |
| --- | --- |
| Isolamento por tenant, FK real para o colaborador, vocabulário fechado, restrição só com o resultado certo, fronteira clínica e permissões por capacidade | `tests/occupational-exams.test.mts` |

### 4.9 Retorno ao trabalho não passa por cima do exame ocupacional, passo 1

O problema que a análise de produto nomeou é preciso: "retorno sem ASO; gestor
escala quem não pode". `PATCH /api/employees/[id]` é hoje o único lugar que
muda `employment_status` — não existe ainda um "Motor de Jornadas" com um
evento próprio de afastamento/retorno — então é ali que a regra entra: na
transição de `on_leave` para `active`, a rota consulta o exame ocupacional
mais recente do colaborador e recusa a reativação se o resultado for
"inapto".

Deliberadamente **não** bloqueia por falta de exame. O módulo de ASO acabou
de nascer (§4.8); a maioria dos colaboradores hoje não tem nenhum registro, e
tratar a ausência de dado como bloqueio pararia reativações legítimas em
empresas que ainda não usam o controle de exames. Exigir o exame de retorno
antes de liberar — a régua mais rígida que a NR-7 pede — é o próximo passo,
depois de validar este com uso real.

**O que isto ainda não faz** — e é deliberado: não exige que um exame de
retorno exista (só reage ao que já está registrado como inapto); não avisa o
gestor sobre uma restrição funcional ativa (`fit_with_restriction`) ao montar
a escala, porque isso depende do Motor de Jornadas, ainda não construído; e
não cobre afastamento/retorno como evento de negócio — continua sendo edição
direta do cadastro.

| Verificação | Onde |
| --- | --- |
| A função pura só bloqueia por "inapto", e a rota consulta o exame certo na transição certa | `tests/occupational-exams.test.mts` |

### 4.10 Link assinado genérico, passo 1 — dar ciência da entrega de EPI

O roteiro de produto pede um "link assinado genérico" (aprovar, responder,
enviar documento, dar ciência), reaproveitando o portal do prestador
(`lib/contractor-invoice-portal.ts`, §84). Ciência de entrega de EPI é o
primeiro consumidor real dele: hoje `fdp_epi_deliveries.signature_name` só
existe se alguém do DP/SESMT digitar o nome do colaborador pela tela — quem
entrega o EPI precisa estar junto de quem tem acesso ao sistema.

O token, o hash e o prazo são exatamente os do portal do prestador — mesmo
`<workspace>.<segredo>`, mesmo hash guardado em vez do token, mesmo teto de
dias. É reuso deliberado da mesma primitiva, não uma segunda implementação: a
tabela nova (`fdp_epi_delivery_ack_links`) e a rota pública
(`/portal/epi/[token]`) seguem o desenho de `fdp_contractor_invoice_portal_links`
e `/portal/nota/[token]` ponto a ponto — um link vivo por entrega, RLS
resolvida a partir do próprio token, toda recusa como o mesmo 404 genérico.

A confirmação assina a entrega pela mesma coluna que `PATCH
/api/epi/deliveries/[id]` já assina, mas por uma escrita mais estreita
(`lib/epi-service.ts#prepareSignDelivery`): o portal só faz uma coisa
(confirmar), então não reusa a rota inteira do painel — que aceita qualquer
status e observação — para uma pessoa sem sessão.

**O que isto ainda não faz** — e é deliberado: o arquivo
`lib/contractor-invoice-portal.ts` continua com o nome da nota fiscal mesmo
emprestando a primitiva para EPI — renomeá-lo para algo neutro é limpeza
adiada, não parte deste passo; não há geração em lote (o portal de nota gera
para toda uma competência de uma vez, este gera um link por entrega, do jeito
que o `signDelivery` manual já funciona hoje); e o link não vira aviso por
e-mail automático — quem gera copia e envia, como já acontece com o texto do
portal de nota.

| Verificação | Onde |
| --- | --- |
| Isolamento por tenant, um link vivo por entrega, situação e recusa por código, e a escrita estreita de assinatura | `tests/epi-delivery-ack-link.test.mts` |

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
