# Fase 9 — Escala: outbox, webhooks assinados, API pública e observabilidade

Data: 2026-08-09
Migration: `0019_outbox_webhooks_public_api`
Versão da API pública: `2026-08-09`

Esta fase abre o produto para integração programática sem abrir mão das garantias que as fases
anteriores construíram: tenant isolado, permissão no servidor e auditoria de tudo.

## 1. Observabilidade (§83)

`lib/observability.ts` emite log estruturado em JSON com os identificadores de correlação do
produto: `requestId`, `workspaceId`, `userId`, `connectorId`, `syncRunId`, `jobId`,
`deliveryId`, `apiKeyId` e `route`.

**PII não entra em log por construção.** Campos como e-mail, nome, CPF, token, Pix, conta,
credencial, assinatura e corpo de requisição são descartados por uma lista de bloqueio antes da
serialização — não é disciplina do autor da chamada, é o logger que recusa. Objetos aninhados
também são descartados: só escalares e listas de escalares passam.

O caminho de erro da API (`apiErrorResponse`) passou a registrar `requestId`, nome e mensagem do
erro apenas no servidor; o cliente continua recebendo somente o código público e o `requestId`.

`requestIdFrom` reaproveita um `x-fila-dp-request-id` válido e gera um novo quando o cabeçalho
está ausente ou malformado, o que permite seguir uma operação da borda até a entrega do webhook.

## 2. Transactional Outbox (§80)

`fdp_domain_events` guarda o evento de domínio. `prepareDomainEvent(d1, …)` devolve um statement
que entra **no mesmo `batch` da mutação de negócio** — o fechamento PJ e o de psicólogos já
emitem seus eventos assim. Não existe evento sem fato nem fato sem evento.

- A carga é **allowlisted**: identificadores, estado e valores agregados. Nome, CPF e qualquer
  dado pessoal do colaborador não atravessam a fronteira do workspace.
- Eventos são append-only e, depois de publicados, imutáveis — garantido por trigger.
- O publicador roda fora da requisição do usuário e é idempotente: a entrega é única por
  `(workspace, endpoint, evento)`.

Eventos disponíveis hoje: `psychology_closing.closed`, `psychology_closing.reopened`,
`contractor_closing.closed`, `contractor_closing.reopened`. Os demais tipos declarados existem
no vocabulário e passam a ser emitidos conforme cada fluxo for coberto.

## 3. Webhooks de saída (§93)

`fdp_webhook_endpoints` e `fdp_webhook_deliveries` implementam entrega assinada com repetição.

**Assinatura**: `X-Fila-DP-Signature: t=<unix>,v1=<hmac-sha256 hex>` calculado sobre
`<timestamp>.<corpo>`. O timestamp entra no material assinado justamente para permitir que o
receptor recuse entregas antigas — assinar só o corpo permitiria replay indefinido.

Cabeçalhos acompanhantes: `X-Fila-DP-Event-Id`, `X-Fila-DP-Event-Type`,
`X-Fila-DP-Delivery-Id`, `X-Fila-DP-Attempt`.

**Como verificar no seu lado:**

1. Recalcule o HMAC com o segredo do endpoint sobre `<t>.<corpo bruto>` e compare em tempo constante.
2. Recuse se `|agora - t| > 300` segundos.
3. Deduplique por `X-Fila-DP-Event-Id`: uma repetição é reenvio, não um fato novo.

**Entrega**: reivindicação com lease (`FOR UPDATE SKIP LOCKED`) para que dois executores nunca
disparem o mesmo webhook; backoff exponencial de 30s até 1h; `max_attempts` esgotado leva a
`dead_letter`; cada tentativa grava status HTTP, trecho da resposta e código de erro.

**Destino**: só HTTPS, sem credenciais na URL e com bloqueio de rede interna (localhost, faixas
privadas e link-local) — um webhook de saída não pode virar SSRF. O segredo é selado com
AES-256-GCM no cofre por versão de chave e exibido uma única vez, na criação.

Desativar um endpoint cancela as entregas ainda não enviadas.

## 4. API pública `/api/v1` (§92)

Autenticação por `Authorization: Bearer fdp_<prefixo>_<segredo>`. A chave é guardada **apenas
como HMAC**; o token completo existe uma única vez, na resposta da criação, e não é recuperável.

- **Escopos**: `companies.read`, `employees.read`, `competences.read`, `payments.read`,
  `payments.write`. Cada rota exige o seu antes de qualquer consulta de negócio.
- **Limite por chave**: janela fixa de 1 minuto contada no banco (vale entre instâncias), com
  `429` e `Retry-After`.
- **Idempotência**: `Idempotency-Key` nas escritas. Mesma chave e mesmo corpo devolvem a
  resposta original; mesma chave com corpo diferente responde `409` — nunca uma segunda
  execução silenciosa. Registros expiram em 24 horas.
- **Paginação por cursor** em todas as listagens; nada carrega coleção inteira.
- **Versionamento** no caminho e em `X-Fila-DP-Api-Version`; `X-Fila-DP-Request-Id` volta em
  toda resposta.

Endpoints implementados:

| Método | Caminho | Escopo |
| --- | --- | --- |
| GET | `/api/v1/companies` | `companies.read` |
| GET | `/api/v1/employees` | `employees.read` |
| GET | `/api/v1/competences` | `competences.read` |
| GET | `/api/v1/contractor-closings` | `payments.read` |
| POST | `/api/v1/contractor-components` | `payments.write` |
| GET | `/api/v1/openapi.json` | público |

O `POST /api/v1/contractor-components` é o caminho pelo qual um ERP envia comissões e descontos
do mês. Ele **reusa a mesma função de serviço da interface** (`createContractorComponent`), então
competência fechada e fechamento concluído recusam o lançamento exatamente igual — a regra não
foi duplicada. Além da `Idempotency-Key`, o `externalId` reconhece o registro já criado pelo
sistema de origem e devolve `200` em vez de duplicar.

CPF nunca é exposto: `/api/v1/employees` devolve apenas os quatro últimos dígitos.

O documento OpenAPI descreve **exclusivamente** os endpoints acima. Um contrato que promete algo
inexistente é pior do que a ausência de contrato.

### Segurança de borda

`/api/v1/*` e `/api/webhooks/worker` estão fora da checagem de mesma origem porque se autenticam
por segredo próprio, não por cookie de sessão. As rotas do painel continuam exigindo `Origin`
igual — a proteção contra CSRF não foi afrouxada.

## 5. Variáveis de ambiente novas

| Variável | Uso |
| --- | --- |
| `FDP_API_KEY_SECRET` | HMAC das chaves da API pública. Sem ela, cai em `FDP_AUTH_SECRET`. |
| `FDP_INTEGRATION_WORKER_SECRET` | Já existente; passa a autenticar também `/api/webhooks/worker`. |
| `FDP_INTEGRATION_VAULT_KEY(S)` | Já existente; passa a selar também o segredo dos webhooks. |

## 6. Validação executada

- `npm run lint`, `npm run db:check` (22 migrations), `npm test` (118 testes, 16 novos) e
  `npm run build`: aprovados.
- `npm run db:rehearse` contra **PostgreSQL 16 real**, em banco limpo: as 22 migrations aplicam,
  e o SQL verifica o outbox imutável e append-only, a entrega única por evento, a reivindicação
  com lease (inclusive um segundo executor sendo barrado), os CHECKs de status e de HTTPS, a
  unicidade do hash da chave, a contagem e o reinício da janela do limite, a unicidade da
  idempotência e o isolamento multi-tenant com papel sem `SUPERUSER`/`BYPASSRLS`.

O ensaio recusa rodar em banco que já contenha tabelas do Vinculato: ele semeia identificadores
fixos e precisa de um banco vazio e descartável.

## 7. Pendências desta fase

- **Relatórios e exportações pesadas continuam síncronos.** A fila de entregas e a de integrações
  existem; mover relatório e exportação para trás dela é o próximo passo natural.
- **Backups e DR (§86) seguem sem prova.** Não há rotina de restauração testada no repositório e
  esta fase não afirma que existe — declarar backup testado sem teste seria falso.
- **Automações (§64)** continuam com as ações simples da fase anterior; o outbox agora dá a base
  de eventos para construí-las corretamente.
- **Marketplace de conectores (§91)** não foi iniciado.
- A entrega de webhook depende de um acionador externo chamando `/api/webhooks/worker`
  (mesmo modelo do executor de integrações). Um agendador próprio ainda não faz parte do produto.
