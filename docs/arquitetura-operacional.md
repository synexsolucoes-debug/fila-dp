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

### 4.11 Treinamentos obrigatórios (NR), passo 1

Mesmo passivo do ASO (§4.8), com a mesma causa: "quando vence o próximo
treinamento?" mora em planilha ou memória, e um treinamento vencido em
atividade de risco (trabalho em altura, espaço confinado, elétrica) é auto de
infração antes de ser acidente.

Diferente do exame ocupacional, o produto não fecha o vocabulário do
treinamento (`training_name` é texto livre) — a mesma razão de
`fdp_positions.special_activities` (0098): o Vinculato não decide quais NRs
existem nem quais delas o cliente aplica, e fechar isso em vocabulário seria
inventar uma taxonomia que não é do produto inventar. Só a validade é
estruturada, porque é ela que responde "está em dia?", e a mesma régua de
`epi_ca_expiry` (§4.3) — vencido, vencendo em 60 dias, no prazo — decide a
situação exibida.

A tela segue o mesmo lugar do ASO: embutida na ficha do colaborador
(`EmployeeTrainingsPanel`), porque treinamento também não tem página própria
ainda. As capacidades (`trainings.view/manage/delete`) entram no módulo
`registrations` pelo mesmo motivo de `exams.*`.

**O que isto ainda não faz** — e é deliberado: `valid_until` não alimenta a
Central de Trabalho ainda (mesmo estado do ASO); nenhuma regra deriva quais
treinamentos um cargo exige a partir do `risk_level` ou das
`special_activities` (isso seria a Matriz de Requisitos genérica); e não há
tela própria fora da ficha do colaborador.

| Verificação | Onde |
| --- | --- |
| Isolamento por tenant, FK real para o colaborador, nome livre mas não vazio, validade não anterior à conclusão, e a régua de situação | `tests/mandatory-trainings.test.mts` |

### 4.12 O colaborador ganha endereço — Motor de Prazos, passo 2

ASO (§4.8) e treinamento (§4.11) ficaram de fora da Central de Trabalho
quando nasceram porque faltava para onde apontar: as duas telas vivem dentro
da ficha do colaborador, e `lib/panel-routes.ts` (§43, §44) não sabia abrir um
colaborador específico por endereço — só demanda e item de triagem tinham essa
porta. Um item de "ASO vence" sem link para a pessoa certa seria o que o
próprio módulo de rotas já nomeia como o erro a evitar: "um endereço que
promete e não entrega".

A extensão é a mesma receita que já existia para demanda e triagem:
`registrations` entra em `VIEWS_WITH_RECORD`, o id do colaborador vira o
segmento final do caminho (`/painel/cadastros/<id>`), e uma aba opcional
(`?aba=exams` ou `?aba=trainings`) manda a ficha abrir direto na aba certa —
sem a aba, abre na aba pessoal, como sempre abriu. `RegistrationsView` lê o
id uma vez só, ao montar, no mesmo padrão de `initialItemId` da Central de
Triagem: busca o colaborador por `GET /api/employees/[id]` e abre a ficha; se
a pessoa não alcança aquele colaborador, a rota de dados recusa e a tela
mostra o erro de sempre, não uma exceção nova.

Com o endereço existindo, as duas fontes que já tinham o dado
(`next_due_date` do ASO, `valid_until` do treinamento) entram na Central como
`occupational_exam_due` e `training_due`, no mesmo desenho de `epi_ca_expiry`
(§4.3): janela de 60 dias, vocabulário `safe`/`warning`/`overdue`, sem
responsável individual — o vencimento é do grupo, não de quem cadastrou.

**O que isto ainda não faz** — e é deliberado: se um colaborador tiver mais
de um exame/treinamento vencendo na mesma janela, cada um vira um item
separado — não existe "só o mais recente conta". Corrigir isso pediria um
segundo parâmetro de `workspace_id` numa subconsulta que `buildWorkItemQuery`
não suporta hoje, e o caso é raro (um exame novo normalmente substitui o
anterior antes de ele vencer de novo).

*Atualização (§4.15):* na época em que este passo nasceu, nenhum item da
Central de Trabalho tinha aviso por e-mail — o resumo diário ainda não
existia. Ele chegou depois lendo `workItemSources` inteiro (todas as fontes
que um administrador enxergaria em `/api/work`), então `occupational_exam_due`
e `training_due` entraram de graça, sem precisar estender nada aqui: um
administrador já recebe os dois no resumo diário desde que §4.15 nasceu.

| Verificação | Onde |
| --- | --- |
| O colaborador tem endereço próprio, a aba não sobrevive sem o registro, e o link do Motor de Prazos aponta para a pessoa | `tests/panel-routes.test.mts`, `tests/work-items.test.mts` |

### 4.13 CAT pendente — Motor de Prazos, passo 3

A análise de produto nomeou o problema com precisão: "prazo de 1 dia útil;
investigação solta". A CAT (Comunicação de Acidente de Trabalho) tem um prazo
que nenhum outro item do Motor de Prazos tinha até aqui — um dia útil (Lei
8.213/91, art. 22), não uma janela de meses — e passado o prazo a obrigação
não prescreve: o item fica na fila até alguém emitir a CAT, do mesmo jeito que
uma falha de integração fica até alguém reprocessar (§4, `integration_failure`),
não como o CA de EPI que sai sozinho da fila em 60 dias.

`catDeadline` (`lib/work-accidents.ts`) só pula sábado e domingo — feriado
municipal, estadual e nacional não entram, porque o produto não tem
calendário de feriados por empresa. A função é deliberadamente mais
permissiva que a lei (nunca marca vencido antes da hora), nunca mais rígida:
um prazo que soasse vencido cedo demais seria pior que um que soa vencido
tarde demais.

O recorte a acidentes com afastamento (`leave_days > 0`) segue a mesma
convenção que o dashboard já usa para a métrica de CAT — "o subconjunto que a
CAT pesa" (§83) — não é este passo que decide o escopo, é o módulo que já
decidiu. `fdp_work_accidents` não tem FK de colaborador (é anonimizado, de
propósito, §83), então o link vai para a tela do módulo (`/painel/acidentes`),
não para uma pessoa como ASO e treinamento (§4.12).

**O que isto ainda não faz** — e é deliberado: não considera feriados (só
sábado e domingo); não cobre acidentes sem afastamento, que a lei também
exige CAT em um dia útil — isso pediria decidir se o produto quer alertar
sobre todo acidente ou só os que já entram na métrica hoje, e essa decisão
não é deste passo; e não é o "plano de ação" que a análise de produto também
nomeou — investigação e ações corretivas continuam sem registro estruturado,
só o prazo da CAT ganhou fila.

| Verificação | Onde |
| --- | --- |
| O prazo pula fim de semana e mais nada, o item não some sozinho da fila, e o recorte é o mesmo do dashboard | `tests/work-accidents.test.mts`, `tests/work-items.test.mts` |

### 4.14 Plano de ação do acidente, passo 1 — a demanda de investigação

A outra metade do problema que §4.13 não fechou: "investigação solta". A
solução não é um objeto novo — cartão, checklist, comentário e anexo já
existem em Demandas, e a análise de desconto de EPI (`lib/epi-service.ts
#prepareDiscountDemand`) já resolve exatamente essa pergunta ("preciso que
alguém investigue isto") do mesmo jeito. `prepareAccidentInvestigationDemand`
segue o desenho ponto a ponto: mesma busca de coluna de entrada, mesma
tolerância a quadro sem coluna, mesmo cartão comum.

A diferença está em quem pede e quem executa. No desconto de EPI, SESMT pede
e DP decide — duas áreas, dois papéis. Na investigação de acidente, apurar e
investigar são o mesmo ato, da mesma área; por isso a nova chave de
roteamento `safety.investigation` resolve as duas pontas (`requesterAreaId`
e `responsibleAreaId` do cartão apontam para a mesma área), em vez de exigir
duas áreas configuradas para uma decisão que é uma só.

`fdp_work_accidents.investigation_card_id` é a única coluna nova: nula até
alguém abrir o plano de ação, e a FK para `fdp_cards` exige que o cartão já
exista — por isso a rota insere o cartão **antes** de atualizar o acidente,
os dois no mesmo lote. Não há gatilho automático por gravidade: é o SESMT,
no momento em que apura, que decide se o caso precisa de investigação, e uma
regra automática estaria adivinhando o que só uma pessoa sabe.

**O que isto ainda não faz** — e é deliberado: não sugere quando abrir um
plano de ação (nenhuma regra por gravidade, dias de afastamento ou tipo);
não fecha o cartão automaticamente quando a investigação termina — isso
continua sendo mover o cartão no quadro, como qualquer demanda; e continua
exigindo que o workspace configure a área `safety.investigation` em
Plataforma → Operações antes do primeiro uso, o mesmo custo de configuração
que a análise de desconto de EPI já cobra.

| Verificação | Onde |
| --- | --- |
| O cartão nasce antes do vínculo, a guarda contra duplo clique está na condição do UPDATE, e a mesma área resolve as duas pontas | `tests/work-accidents.test.mts` |

### 4.15 Resumo diário por e-mail, passo 1 — o que está vencido

O roteiro de produto pede "notificação externa (e-mail + Teams; WhatsApp em
seguida) com resumo diário": quem não abre o sistema não é alcançado. §4.4
generalizou o adaptador de e-mail, mas só para convite e recuperação de
acesso — nunca para trabalho pendente. Este é o primeiro consumidor real do
canal para esse fim.

Não é uma fonte nova de trabalho: é a mesma pergunta que `/api/work?prazo=
vencido` já resolve, perguntada por fora, uma vez por dia. `lib/work-
digest.ts` monta a união de `buildWorkCenterQuery`/`buildWorkCountsQuery`
(§9) com `scope: "team"` e `due: "overdue"`, para o conjunto de fontes que o
papel `admin` enxerga — o único papel que hoje vê todas as empresas do
workspace sem depender de `fdp_member_company_access`. Só administradores
recebem, e só quando há pelo menos um item vencido: um resumo vazio todo dia
é ruído, não aviso, e a mesma régua de "nunca notifica sem necessidade" que
o resto do produto já segue.

`GET /api/cron/work-digest` segue o desenho do executor de integrações
(§29): lista os workspaces ativos de uma conexão sem tenant, processa cada
um com a conexão escopada dele dentro de um `try` que isola falha de um
tenant do restante da varredura, e autentica por `Authorization: Bearer`
(`CRON_SECRET` ou `FDP_WORK_DIGEST_CRON_SECRET`) — o mesmo motivo de sempre
para não ser uma rota da Vercel Cron: o plano Hobby recusa mais de um
disparo diário por rota, e o GitHub Actions (`work-digest-cron.yml`,
11h UTC) cobre isso sem custo. A chave de idempotência do Resend
(`work-digest:{workspaceId}:{userId}:{data}`) impede que um reprocessamento
do mesmo dia vire e-mail duplicado. Segue a mesma postura de convite e
recuperação (§4.4): nunca lança — sem `FDP_APP_URL` configurado, a rota nem
tenta montar o resumo, porque nenhum link do e-mail funcionaria.

**O que isto ainda não faz** — e é deliberado: só administradores recebem;
um membro com acesso restrito por empresa (`fdp_member_company_access`) não
recebe nada, porque cada um veria um recorte diferente e isso pediria
repetir a consulta por destinatário — deixado para quando houver um segundo
consumidor real dessa segmentação. Não há preferência de opt-out por
workspace ou por pessoa (ainda): o canal liga sozinho assim que
`FDP_APP_URL` e o provedor de e-mail estão configurados. E o resumo cobre
só "vencido" — "vencendo em breve" (a janela de 60 dias que a Central já
usa para EPI, ASO e treinamento) fica de fora, porque misturar as duas
coisas no mesmo e-mail exigiria decidir como apresentá-las juntas sem
confundir o que já é urgente com o que ainda não é. Teams e WhatsApp,
que o roteiro pede em seguida, ainda não têm canal de saída nenhum — hoje
Teams só existe como **origem** de movimentação (`lib/teams-integration.ts`),
não como destino de aviso.

| Verificação | Onde |
| --- | --- |
| Sem item vencido não há e-mail, a consulta usa o escopo do time e não o de "meus itens", a chave de idempotência inclui o dia, e a rota exige o segredo agendado | `tests/work-digest.test.mts`, `tests/email.test.mts` |

### 4.16 Motor de Jornadas, passo 1 — aplicar afastamento e desligamento

O roteiro de produto pede um "Motor de Jornadas" para admissão, desligamento,
transferência, mudança de função, afastamento e retorno como eventos de
negócio — hoje cada um é edição direta do cadastro, sem trilha própria. Mas
`fdp_employee_movements` (0014, "operação DP") já existe desde antes deste
roteiro, com aprovação, segregação de função para tipos sensíveis e os
próprios tipos `leave` e `termination` no vocabulário — só faltava alguém
usá-lo. `status = 'applied'` estava no `CHECK` da coluna desde a criação da
tabela, e nenhuma rota jamais escrevia esse valor: uma movimentação aprovada
ficava aprovada para sempre, e `fdp_employees.employment_status` continuava
mudando só por `PATCH /api/employees/[id]`, sem relação nenhuma com a
aprovação que acabara de acontecer em paralelo.

`POST /api/operations/movements/[id]/apply` fecha essa lacuna para os dois
tipos que representam entrar ou sair da folha ativa. Segue o único precedente
que o produto já tinha para "aplicar": `app/api/registrations/contractors/
[id]/movements/[movementId]/route.ts` — aplicar é a única transição que
escreve no cadastro, e escreve na mesma transação que marca a movimentação
como aplicada, para não existir um estado intermediário onde uma vale e a
outra não. `lib/operations.ts#movementEmploymentEffect` é a função pura que
decide o efeito: `leave` → `on_leave`, `termination` → `terminated` (com
`termination_date` gravado a partir de `lastWorkingDate`, quando informado),
e nenhum dos outros seis tipos (salário, férias, transferência, benefício,
conciliação, desconto de EPI) toca `employment_status` — eles não decidem
isso, e aplicar continua só marcando `applied` para eles.

A guarda contra corrida dupla está na condição do próprio `UPDATE`, não só na
checagem que vem antes dela: `status = 'approved'` no `UPDATE` da
movimentação e `employment_status = ?` (o valor exigido antes de aplicar) no
`UPDATE` do colaborador. Um segundo clique depois do primeiro já ter passado
não corrompe nada — as duas atualizações simplesmente afetam zero linhas.

**O que isto ainda não faz** — e é deliberado: `transfer` entre empresas
diferentes ainda não move nada (§4.17 cobre o motivo); não há retorno
automático de afastamento na data de fim — a reativação continua sendo o
`PATCH` de sempre, já guardado pelo exame ocupacional (§4.9); aplicar não
respeita `effective_date` — quem aplica decide quando, a data de vigência é
só informativa; e admissão continua fora de propósito (§6.2: "a admissão
digital é executada na Sólides").

| Verificação | Onde |
| --- | --- |
| Só movimentação aprovada aplica, a guarda contra duplo clique está na condição do UPDATE, e só afastamento/desligamento tocam a situação do colaborador | `tests/movement-apply.test.mts` |

### 4.17 Motor de Jornadas, passo 2 — aplicar transferência na mesma empresa

Continuação de §4.16: `transfer` era o único tipo de movimentação sensível
que "aplicar" ainda deixava de fora, e a lacuna nomeada ali (mudar de empresa
cruzaria RLS) só existe para o caso entre empresas — dentro da mesma empresa
não há fronteira nenhuma para cruzar, é o mesmo `UPDATE` que
`PATCH /api/employees/[id]` já faz para departamento, cargo e centro de
custo.

`lib/operations.ts#movementTransferEffect` decide os três casos:
`targetCompanyId` ausente (`missing_target` — a tela exige o campo, então só
acontece por uma movimentação criada fora dela), empresa diferente da atual
(`cross_company` — recusa com motivo claro), e mesma empresa
(`same_company` — aplica o que foi informado, com `COALESCE` preservando o
que não foi). A recusa acontece **antes** do `d1.batch`, nunca dentro dele:
aplicar é tudo-ou-nada, e uma transferência entre empresas recusada continua
"aprovada" — nunca "aplicada" para um efeito que não aconteceu.

**O que isto ainda não faz** — e é deliberado: transferência entre empresas
continua sem caminho de aplicação automática; quem precisa disso move o
colaborador manualmente e a movimentação fica "aprovada" sem fechar — não há
hoje um jeito de marcá-la resolvida sem o efeito real acontecer. E os
campos de destino (`departmentId`, `positionId`, `costCenterId`) continuam
sendo texto livre na tela, sem validar que o identificador existe antes de
aprovar — o mesmo risco que `PATCH /api/employees/[id]` já aceita hoje para
os mesmos campos; um identificador inválido só aparece na hora de aplicar,
como erro de banco.

| Verificação | Onde |
| --- | --- |
| `missing_target`, `cross_company` e `same_company` cobrem os três casos, a recusa de empresa diferente vem antes do batch, e o UPDATE preserva com COALESCE o que não foi informado | `tests/movement-apply.test.mts` |

### 4.18 Dossiê do colaborador, passo 1 — EPI, ASO e treinamento num PDF só

O problema que o roteiro de produto nomeou: montar os subsídios de uma defesa
trabalhista hoje é abrir três telas diferentes (EPI, ASO, treinamento) e
copiar à mão. As três já são dados estruturados e reais desde §4.3, §4.8 e
§4.11 — nada de tabela nova, é leitura, como a Central de Trabalho (§93).
`GET /api/employees/[id]/dossier` junta os três num PDF, no mesmo gerador
(`pdf-lib`) já usado pelo recibo de pagamento PJ
(`lib/contractor-batch-statement-pdf.ts`).

Acidente de trabalho fica de fora de propósito: `fdp_work_accidents` é
anonimizado, sem FK de colaborador (§83) — não há o que juntar.

Cada seção é consultada só quando quem pede tem a capacidade dela
(`epi.view`, `exams.view`, `trainings.view`), no mesmo desenho de
`lib/work-items.ts` para a Central de Trabalho (§9: "uma fonte a que o
usuário não tem acesso simplesmente não é consultada"). A diferença que
importa aqui: uma seção sem capacidade imprime "sem permissão para
consultar", nunca "0 registros" — as duas frases significam coisas
diferentes num documento que vai para uma defesa, e confundi-las seria pior
que não gerar a seção.

**O que isto ainda não faz** — e é deliberado: não inclui acidente de
trabalho (não há FK para incluir, ver acima); o botão vive só na ficha do
colaborador (`RegistrationsView`), sem geração em lote para vários
colaboradores de uma vez; e o layout é uma tabela simples por seção — sem
gráfico, sem resumo executivo, sem assinatura digital do documento.

| Verificação | Onde |
| --- | --- |
| Uma seção sem permissão nunca aparece como "0 registros", o PDF nasce válido com listas vazias e com seções nulas, e a tela baixa pelo mesmo padrão de blob do recibo PJ | `tests/employee-dossier-pdf.test.mts` |

### 4.19 Command Center — saúde e conformidade em Relatórios

O roteiro de produto nomeou a lacuna com precisão: "diretoria sem visão de
saúde". `IndicatorsView` (a tela "Relatórios") já respondia turnover e custo
de folha (`hrMetrics`) — mas quem dirige o grupo não abre EPI, ASO ou o
painel de acidentes todo dia, e nenhum desses três aparecia em lugar
nenhum fora do próprio módulo.

Os cinco números que a nova seção soma já existem: exame vencido
(`fdp_occupational_exams.next_due_date`, §4.8), treinamento vencido
(`fdp_trainings.valid_until`, §4.11), acidente no período
(`fdp_work_accidents.occurred_on`, §83), CAT pendente — a mesma condição
(`cat_issued = 0 AND leave_days > 0`) que já decide o item `cat_pending` da
Central de Trabalho (§4.13) — e obrigação legal vencida, com o mesmo
vocabulário de status (`open`/`in_progress`/`blocked` com prazo já passado)
que a fonte `compliance_obligation` da Central de Trabalho usa. Nada de
tabela nova: `GET /api/reports` ganhou cinco `SELECT count(*)` a mais,
escopados por empresa do mesmo jeito que `hrMetrics` já era.

O escopo por empresa usa `(?::boolean OR company_id = ANY(?::text[]))` —
genuinamente parametrizado, não um fragmento de SQL montado em string. A
primeira versão interpolava a cláusula (`${...}`), e isso quebrou o CI: uma
consulta com `${...}` sai da faixa que `npm run verify:sql` consegue
preparar contra o schema real e cai na contagem de "não verificada", que
tem teto — quatro consultas novas nesse formato empurraram o total acima do
limite. O primitivo `ANY(?::text[])` já era usado em
`app/api/payments/contractors/invoices/portal-links/route.ts`; reaproveitá-lo
manteve as cinco consultas verificáveis de verdade.

CAT pendente e obrigação vencida são estado atual, não recorte de período:
um caso pendente não deveria sumir do painel simplesmente porque a
diretoria mudou o filtro de data para "últimos 7 dias". Acidentes, ao
contrário, usam a mesma janela `from`/`to` do resto do relatório — é
"quantos aconteceram nesse recorte", uma pergunta diferente.

**Passo 2 — taxa de conformidade de EPI.** O passo 1 deixou essa métrica de
fora porque agregar `lib/epi-compliance.ts#buildEpiCompliance` (que calcula
por colaborador) num número único de grupo pedia decidir o que "conformidade
do grupo" significa. A decisão: dos colaboradores ativos do recorte que têm
pelo menos uma regra de EPI aplicável, qual fração está com o status
`compliant`. Quem não tem regra nenhuma cadastrada (`unconfigured`) fica fora
do denominador — não é "descumprindo", é "sem regra ainda", uma situação
diferente que inflaria ou esvaziaria a taxa sem dizer nada sobre conformidade
real. Quando o denominador é zero (nenhum colaborador do recorte tem regra
cadastrada), a taxa é `null` — a tela mostra "—", nunca "100%" nem "0%", que
seriam ambos falsos.

Diferente das cinco contagens do passo 1 (um `SELECT count(*)` cada), a
conformidade de EPI é um cálculo em memória — `buildEpiCompliance` já existe,
é puro, e é a mesma função que o dashboard de EPI por empresa usa
(`app/api/epi/dashboard/route.ts`); duplicar sua lógica de precedência de
regras em SQL teria criado exatamente o risco que o próprio módulo evita
("ninguém aparece em dia numa tela e sem EPI noutra"). A alternativa a essa
duplicação não é um laço de uma consulta por empresa (N+1) — `applies()`
dentro de `buildEpiCompliance` já casa cada regra pela empresa do
colaborador, então três consultas (colaborador, regra, saldo) cobrem o
recorte inteiro numa única passada, escopadas pelo mesmo primitivo
`(?::boolean OR company_id = ANY(?::text[]))` das outras cinco.

**O que isto ainda não faz** — e é deliberado: os seis números não têm link
para a tela que os resolve, diferente da Central de Trabalho (§9) — é leitura
de painel, não uma fila acionável; e não entra na exportação CSV existente
desta tela.

| Verificação | Onde |
| --- | --- |
| As cinco contagens são SQL agregado (não a tabela inteira filtrada em memória) e genuinamente parametrizado com ANY(?::text[]), CAT pendente e obrigação vencida ignoram o período e acidentes o usa, a conformidade de EPI reaproveita `buildEpiCompliance` numa única passada sem N+1 e exclui quem não tem regra do denominador, e a tela não inventa número antes do relatório chegar | `tests/command-center-safety.test.mts` |

### 4.20 Portal do Gestor, passo 1 — minha equipe

O roteiro de produto nomeou o Portal do Gestor como P1: "DP como central
telefônica" — um gestor de área liga ou manda WhatsApp para o DP perguntar
algo que ele mesmo resolveria se tivesse onde olhar. A visão completa tem
quatro peças (catálogo em linguagem de gestor, acompanhamento, minhas
pendências, minha equipe), mas as três primeiras pressupõem a quarta: sem
saber quem cada gestor gerencia, não há o que catalogar, acompanhar ou
enfileirar. Por isso "minha equipe" é o primeiro passo, sozinho.

`fdp_employees.manager_employee_id` já existia desde a fundação dos
cadastros (0013) e já tinha um consumidor real — a guarda de exclusão em
`app/api/employees/[id]/route.ts` recusa apagar um colaborador que ainda é
gestor de alguém — mas nenhuma tela jamais preenchia esse campo, e nada lia
"quem esta pessoa gerencia" a partir dele. A lacuna maior, porém, era outra:
uma conta de plataforma (`fdp_users`/`fdp_workspace_members`) e um
colaborador (`fdp_employees`) são dois cadastros hoje sem ligação nenhuma —
o gestor loga com uma conta, mas o "quem ele gerencia" mora no cadastro do
colaborador que ele *é*.

`fdp_workspace_members.employee_id` (0104) fecha exatamente essa segunda
lacuna. A decisão de fazer o vínculo explícito, em vez de casar contas e
colaboradores por e-mail, foi deliberada: `fdp_employees.email` é opcional e
não único (0013 não tem `UNIQUE` nela) — um e-mail em branco casaria com
qualquer conta sem vínculo, inflando a equipe de qualquer gestor com gente
que não tem nada a ver com ele. Uma coluna explícita, preenchida por quem
administra o grupo, não tem esse risco: nula até alguém vincular (a maioria
das contas continua sem corresponder a nenhum colaborador — donos, DP, TI),
única por colaborador (duas contas não podem afirmar ser a mesma pessoa), e
com `ON DELETE SET NULL` — perder o cadastro do colaborador não derruba a
conta de acesso.

O vínculo entra pelos dois lados que já existiam, sem tela nova:

- Na ficha do colaborador (`RegistrationsView`, aba "Vínculo e lotação"), o
  campo **Gestor** grava `manager_employee_id` — o campo que a rota já
  aceitava desde 0013, mas nenhum formulário preenchia.
- Em "Usuários e acessos" (`WorkspaceApp.tsx`), cada linha ganha
  **colaborador vinculado**, que grava `employee_id` no membro.

Os dois usam o mesmo desenho: busca por nome/matrícula
(`GET /api/employees?search=`) em vez de uma lista só, pelo mesmo motivo que
a própria ficha de colaboradores pagina e busca — o cadastro pode ter
milhares de linhas. Nenhum dos dois entrou na consulta do snapshot do
workspace (`getWorkspaceSnapshot`): ela é carregada a cada troca de tela e de
grupo, e `tests/registrations-phase3.test.mts` já garante que essa consulta
fica livre de `fdp_employees` — o nome de quem já está vinculado é resolvido
à parte, sob demanda (`GET /api/employees/[id]`), não juntado ali.

`GET /api/gestor/team` é autosserviço puro: não recebe parâmetro nenhum, só
lê o `employee_id` da própria conta autenticada e devolve quem tem
`manager_employee_id` apontando para ela, entre os colaboradores ativos. Três
estados, três mensagens diferentes — não inventar dado importa tanto aqui
quanto no Dossiê (§4.18): conta sem vínculo ("fale com o administrador"),
vínculo sem ninguém reportando ("equipe vazia agora") e a lista de fato, cada
um uma situação real e distinguível, nunca a mesma tela genérica de "nada
aqui".

A tela vive em `/gestor`, endereço próprio — decisão do produto, não deste
passo: quem abre esta tela é um gestor de área, não o DP, e não deveria
precisar da densidade operacional do painel inteiro só para ver o próprio
time. Mesma sessão de sempre (`requireChatGPTUser`), casca diferente, no
mesmo espírito de `app/portal/epi/[token]` — corpo grande, um caminho só.

**O que isto ainda não faz** — e é deliberado: nenhum catálogo de pedidos,
acompanhamento ou fila de pendências — as outras três peças do Portal do
Gestor, que dependiam desta primeira; a tela não mostra situação de EPI/ASO/
treinamento de cada colaborador da equipe, só o roster (nome, cargo, empresa,
admissão); `DEPARTMENT_MANAGER`/`EMPLOYEE_MANAGER` como modo de
responsabilidade num processo (`lib/process-management.ts`) continuam
configuráveis no modelador mas não verificados em
`lib/process-instances.ts` — o vínculo que este passo criou poderia alimentar
essa verificação, mas isso é fatia futura, não parte deste passo; e não há
como um gestor delegar ou ver a equipe de outro gestor (hierarquia de vários
níveis) — só a própria, direta.

| Verificação | Onde |
| --- | --- |
| O vínculo é opcional, único por colaborador e `SET NULL` ao apagar o colaborador; a rota de vínculo recusa colaborador de outro grupo ou já vinculado a outra conta; `GET /api/gestor/team` nunca aceita parâmetro de entrada e distingue sem-vínculo de equipe-vazia; e nem o vínculo nem o nome do colaborador entram na consulta do snapshot | `tests/gestor-portal.test.mts` |

### 4.21 Cargo de risco sem exame — Motor de Prazos, passo 4

`fdp_positions.risk_level` existe desde a migration 0098 justamente para isso
— decidir que tipos de exame um cargo exige — mas nunca teve consumidor.
Fora do próprio formulário de cadastro do cargo (`RegistrationsView`), nenhuma
rota, relatório ou fila jamais lia essa coluna. Era exatamente o padrão que já
rendeu outros passos deste roadmap: um valor legal, aceito e guardado, sem
ninguém do outro lado perguntando por ele.

`occupational_exam_due` (§4.8, §4.12) já cobre "ASO vencendo" — mas só para
quem **já tem** um exame registrado com `next_due_date`. Ele é cego para o
colaborador que está num cargo de risco e nunca teve exame nenhum: sem
registro, não há `next_due_date` para vencer, e a pessoa simplesmente não
aparece em lugar algum do Motor de Prazos. É exatamente o caso que a NR-7
mais cobra — o exame admissional — e o mais fácil de esquecer numa admissão
corrida.

A nova fonte (`position_risk_exam_missing`) fecha essa lacuna: colaborador
ativo, cargo com `risk_level IN ('medium', 'high')`, sem nenhuma linha em
`fdp_occupational_exams`. Sem tabela nova — é leitura cruzada de duas tabelas
que já existem, no mesmo desenho de todas as fontes do Motor de Prazos (§9).

Diferente do CA de EPI (janela de 60 dias) e igual à CAT pendente (§4.13), o
item não tem prazo futuro para vencer — a obrigação nasce com a admissão, não
com uma data que ainda vai chegar. Por isso a "data de referência" é
`admission_date` (sempre no passado, para quem já está ativo) e o item já
nasce `overdue`. Cargo de risco `high` entra com prioridade `urgent`; `medium`
com `high` — a mesma lógica de graduar urgência por gravidade que a Central
já usa em pendência bloqueante (§9).

**O que isto ainda não faz** — e é deliberado: não decide quais tipos de
exame um cargo específico exige (isso seria a Matriz de Requisitos genérica,
ainda não construída, a mesma lacuna que §4.8 e §4.11 já nomeavam); não
reavalia se um exame antigo demais (ex.: um admissional de anos atrás, sem
periódico desde então) ainda "conta" — a régua é só "existe alguma linha",
não "existe uma linha válida"; e não entra nas contagens do Command Center
(§4.19) nem no resumo diário por e-mail (§4.15, embora `position_risk_exam_missing`
já entre automaticamente nele — o mesmo motivo do §4.12 atualizado: o resumo
lê `workItemSources` inteiro).

| Verificação | Onde |
| --- | --- |
| A fonte cobre quem nunca teve exame (não duplica ASO vencendo), recorta a cargos de risco médio/alto e colaborador ativo, não tem janela de 60 dias, gradua prioridade por gravidade, e o link abre o colaborador | `tests/work-items.test.mts` |

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
