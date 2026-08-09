# Diagnóstico técnico e plano de evolução do Fila DP

Data: 2026-08-08
Repositório analisado: `synexsolucoes-debug/fila-dp`
Base: `main` em `955cf5c`

## Resumo executivo

O Fila DP já é uma aplicação Next.js funcional para gestão visual de demandas, com PostgreSQL/Neon, anexos privados, workspaces, empresas, permissões básicas, quadro Kanban, inbox, planner, relatórios e conectores iniciais. A base é útil como release operacional inicial, mas ainda não é um SaaS multiempresa pronto para receber clientes pagantes.

Os principais bloqueadores são: isolamento multi-tenant dependente apenas da aplicação e sem RLS; modelo de dados ainda centrado em quadros/cartões; autenticação sem rate limiting, MFA ou gestão completa de sessões; ausência dos cadastros centrais de colaboradores e estruturas do DP; integrações síncronas sem fila, execução, retentativa e conciliação; testes insuficientes para banco e isolamento; frontend monolítico; cobrança, planos, LGPD, backup testado e operação SaaS ainda inexistentes.

Esta fase introduz sessões persistidas e revogáveis e corrige o limite de produto da Sólides. Nenhum banco de produção foi acessado e nenhum dado real foi alterado durante o diagnóstico.

## 1. Funcionalidades existentes

- Site público, login próprio e recuperação de senha por token de uso único.
- Workspace ativo, troca de workspace e quatro papéis: administrador, membro, observador e convidado.
- Empresas e restrição de membros por empresa.
- Quadros, listas e demandas com Kanban, tabela, calendário e visão por processo.
- Prioridade, responsável, SLA, pausa, checklist, etiquetas, campos personalizados, comentários, anexos e histórico de atividade.
- Caixa de entrada manual e por webhook, conversão em demanda e busca global básica.
- Planner pessoal e preparação de conexões de calendário.
- Indicadores de headcount, movimentação e custo de folha por competência.
- Configuração genérica de integrações e sincronização inicial para Microsoft Graph e Sankhya.
- Vercel Blob privado para anexos e PostgreSQL/Neon por adaptador de compatibilidade D1.
- Migrations versionadas com checksum, baseline de banco legado e bloqueio de migrations destrutivas não autorizadas.
- CI com lint, migration check, testes, build e auditoria de dependências.

## 2. Funcionalidades completas no escopo atual

“Completa” aqui significa utilizável dentro da release atual, não suficiente para o produto final solicitado.

- CRUD de quadros, listas, empresas, demandas, comentários, etiquetas, campos, feriados, SLAs e regras simples.
- Escopo de workspace aplicado nas rotas principais e validação de acesso à empresa em demandas e anexos.
- Upload privado com limite de 20 MB, lista de MIME/extensões e download autenticado com `nosniff`.
- Webhooks com segredo por workspace, limite de payload, comparação constante e deduplicação simples.
- Proteção contra SSRF nos conectores por HTTPS, host oficial/configurado e bloqueio de rede privada.
- Valores financeiros modelados como `numeric(18,2)` no PostgreSQL.
- Tokens de recuperação armazenados como hash e invalidados depois do uso.

## 3. Funcionalidades incompletas

- A alternância de workspace existe, mas a restrição única de proprietário impede um usuário de possuir vários workspaces.
- O cadastro de empresa contém apenas uma fração dos campos exigidos.
- Não existem Employee, dependentes, documentos de colaborador, histórico contratual, afastamentos ou cadastros auxiliares profissionais.
- Demandas não possuem competência, solicitante estruturado, aprovadores, dependências, recorrência, prazo legal ou fechamento.
- O módulo “Folha” é registro gerencial de métricas; não é ainda a Central de Movimentações nem pré/pós-fechamento.
- Integrações não possuem `sync_run`, itens, mapeamentos, credenciais por workspace, fila, backoff, dead-letter ou conciliação.
- Calendários são apenas configuração; o próprio texto da interface informa que o OAuth ainda será ativado.
- Automações rodam dentro da requisição e suportam apenas três ações simples.
- Notificações são internas; e-mail, Teams, WhatsApp e resumos não estão implementados.
- Relatórios não têm filtros salvos, agendamento, permissões por relatório ou processamento assíncrono.
- Site anuncia planos, mas não há catálogo de planos, assinatura, cobrança, limites ou painel da plataforma.

## 4. Código duplicado e concentração de responsabilidades

- `app/painel/WorkspaceApp.tsx` possui aproximadamente 2 mil linhas e concentra navegação, estado, formulários, regras de apresentação e chamadas para quase todos os módulos.
- `access.css` e `dashboard-modern.css` somam mais de 4,7 mil linhas e apresentam alto custo de manutenção e risco de regressão visual.
- Validações de empresa, papel e escopo são repetidas rota a rota.
- Tipos de processo aparecem como strings em sementes, formulários, filtros, regras e APIs.
- O padrão de resposta/erro e a leitura do corpo JSON são repetidos sem schemas compartilhados.
- Consultas SQL e mapeamento manual de `snake_case` para tipos da UI estão concentrados em `lib/fila-dp-db.ts`.

## 5. Código legado

- A aplicação usa PostgreSQL, mas mantém interfaces e nomes `D1Database`, `D1PreparedStatement` e `R2Bucket` como camada de compatibilidade.
- Permanecem migrations SQLite antigas fora de `drizzle/postgres`; não são executadas em produção, porém confundem manutenção e onboarding.
- `worker/index.ts`, Vite, vinext e dependências Cloudflare permanecem no projeto, embora a documentação declare Vercel/Next.js como runtime de produção.
- README e `VERCEL_DEPLOYMENT.md` ainda afirmam Turso/libSQL e criação de schema no primeiro login, contrariando a implementação atual.
- Existe componente `LegacyCompaniesView` exportado no cliente.

## 6. Riscos de segurança

| Prioridade | Risco | Evidência | Direção |
| --- | --- | --- | --- |
| P0 | Isolamento depende da correção de todas as queries; não há RLS | snapshots Drizzle registram `isRLSEnabled: false` | contexto transacional por workspace, FKs compostas e RLS com testes negativos |
| P1 | Não há rate limiting de login, reset, busca, upload ou integrações | rotas chamam diretamente banco/provedor | limitador distribuído, lockout progressivo e quotas |
| P1 | Não há proteção CSRF explícita nas mutações autenticadas | cookies `SameSite=Lax`, sem validação de `Origin` | validação central de origem/token em todas as mutações, com exceção controlada para webhooks |
| P1 | Sessões antigas eram HMAC autocontidas e não revogáveis | corrigido nesta fase por `fdp_auth_sessions` | adicionar lista de dispositivos, revogação global e rotação |
| P1 | Upload confia em MIME e extensão informados pelo cliente | rota valida apenas `file.type` e extensão | validar assinatura mágica, antivírus/quarentena e limite por workspace |
| P1 | Segredos de conectores são globais por ambiente | `FDP_<CANAL>_*` | cofre criptografado por integração/workspace com rotação e auditoria |
| P2 | Erros internos podem ser devolvidos ao cliente | `apiError` usa `error.message` | códigos públicos estáveis e detalhe apenas em logs estruturados |
| P2 | Não há headers de segurança centralizados documentados/testados | `next.config.ts` vazio | CSP, HSTS, frame-ancestors, Referrer-Policy e Permissions-Policy |

## 7. Riscos de vazamento entre clientes

- Tabelas-filhas como listas, cartões, comentários, anexos, assignees e valores customizados não possuem `workspace_id` direto.
- FKs independentes permitem combinações inconsistentes: um cartão pode, no nível do banco, apontar para quadro de um workspace e empresa de outro.
- `member_company_access` referencia workspace e empresa separadamente, sem garantir no banco que a empresa pertence ao mesmo workspace.
- Não há RLS nem variável de sessão no PostgreSQL para impor o tenant.
- O snapshot do workspace filtra parte do escopo de empresas em memória depois de carregar resultados.
- Não existem testes de integração com dois workspaces e tentativas reais de acesso cruzado.

## 8. Problemas de banco de dados

- `fdp_workspaces_owner_uq` contradiz o requisito de um usuário possuir vários workspaces.
- Papéis, status e tipos são `text` sem `CHECK`, enum ou tabela de domínio.
- Uso de `integer` como booleano e `double precision` para posições mantém herança do modelo SQLite.
- Ausência de versionamento otimista (`version`) para concorrência em demandas e cadastros.
- Auditoria é uma tabela de atividade genérica; não registra de forma consistente antes/depois, IP, request ID e entidade.
- Não há soft delete uniforme, retenção, lixeira nem política de purge.
- Não há schema para sessões (corrigido nesta fase), colaboradores, integrações profissionais, filas, fechamentos e cálculos versionados.
- O histórico usa migrations manuais para os preflights/RLS e possui snapshot Drizzle consolidado em `meta/0012_snapshot.json`.

## 9. Problemas de interface e UX

- Aplicação inteira funciona como uma única tela cliente, sem URLs profundas para módulos, filtros ou registros.
- O carregamento do painel baixa um snapshot grande; faltam paginação, estados locais por recurso e cache orientado a domínio.
- “Folha” pode sugerir ERP de folha, apesar de hoje ser um painel gerencial. Recomenda-se “Conferência e custos”.
- Cadastros complexos futuros não cabem no atual padrão de modais e formulários compactos.
- Há boa presença de rótulos ARIA e responsividade, mas faltam testes automatizados de teclado, foco, contraste e leitores de tela.
- O site comercial anuncia plano gratuito e planos pagos sem existir cobrança/assinatura funcional.

## 10. Regras inconsistentes

- A semente “Admissão completa” concorria com a Sólides. Foi substituída por “Conciliação de colaborador admitido”; novas demandas/templates de admissão são rejeitados pela API.
- A interface ainda conserva uma opção legada de `ADMISSÃO` no editor de automações; a API bloqueia sua gravação. Remover ao decompor o componente de regras.
- A autenticação bootstrap cria apenas o primeiro workspace global; isso não equivale a cadastro SaaS público.
- Administrador tem acesso irrestrito a empresas, enquanto outros membros sem escopo ficam sem acesso; essa semântica precisa ser explícita e testada.
- Exclusão de anexo remove primeiro o Blob e depois o registro; falha de banco pode deixar metadado apontando para objeto ausente.

## 11. Gargalos de performance

- `getWorkspaceSnapshot` dispara cerca de 27 consultas e carrega cartões, checklists, comentários, anexos, métricas, inbox e catálogos em um único payload.
- Cartões, inbox, métricas e parte dos catálogos não possuem paginação.
- O cliente consulta realtime por polling e, ao detectar alteração, recarrega o snapshot completo.
- Integrações e automações são processadas sincronamente na requisição HTTP.
- Cálculos de SLA percorrem dias em JavaScript por cartão e são refeitos na montagem do snapshot.
- O frontend monolítico eleva custo de hidratação e dificulta divisão de bundle.

## 12. Riscos de perda de dados

- Não há rotina no repositório que prove backup, restauração, RPO ou RTO.
- Não há outbox/transação coordenada entre PostgreSQL, Blob e provedores externos.
- Migrations são transacionais, mas o plano de rollback ainda é manual e deve ser ensaiado em cópia de produção.
- Exclusões definitivas existem para demandas, empresas, listas, etiquetas, campos e anexos sem política SaaS uniforme de lixeira/retenção.
- Sincronização externa não possui idempotência forte por execução/item nem dead-letter queue.

## 13. Módulos a reconstruir

1. Identidade, sessões, convites, RBAC/ABAC e administração de plataforma.
2. Camada de tenancy e acesso a dados, eliminando o adaptador D1 do caminho principal.
3. Workspaces, empresas/estabelecimentos e cadastros auxiliares.
4. Colaboradores, dependentes, histórico, documentos e identificadores externos.
5. Demandas/processos sobre um modelo de domínio versionado, com competência e aprovações.
6. Integrações: connector, integration, credential, mapping, sync run/item, inbox técnico e conciliação.
7. Movimentações, pré-fechamento, pós-fechamento, obrigações e pendências.
8. Benefícios, psicólogos e PJ como motores auxiliares versionados.
9. Frontend modular com rotas, server components, paginação e design system.
10. Plataforma SaaS: planos, limites, assinatura, cobrança, suporte e LGPD.

## 14. Plano de migração

1. Criar backup lógico e snapshot do Blob; registrar contagens e checksums por tabela.
2. Aplicar migrations aditivas: sessões, tenancy, auditoria, domínios e novas entidades.
3. Fazer backfill idempotente de `workspace_id` direto e validar registros órfãos/divergentes.
4. Adicionar chaves únicas/compostas e constraints inicialmente `NOT VALID`; validar depois do backfill.
5. Introduzir repositórios PostgreSQL tipados em paralelo ao adaptador D1, com feature flag por módulo.
6. Implementar RLS e contexto transacional; executar suíte de isolamento antes de ativar por módulo.
7. Migrar leitura, depois escrita dupla temporária quando necessária, comparar e cortar o legado.
8. Arquivar migrations SQLite e remover dependências Cloudflare somente após confirmar que nenhum ambiente as usa.
9. Ensaiar rollback em homologação: aplicação anterior + restore/snapshot ou migration reversa validada.
10. Liberar por workspace piloto, observar métricas, ampliar gradualmente e produzir relatório de transformação.

## 15. Plano de execução por fases

### Fase 1 — Diagnóstico e contenção

- Concluído: inventário, baseline, riscos, plano e correção inicial Sólides/sessões.
- Próximo: confirmar ambientes Vercel/Neon/Blob e realizar backup/restauração de homologação.

### Fase 2 — Fundação segura

- Concluída no repositório: contexto de tenant no banco, RLS, FKs compostas, gestão de sessões/dispositivos, CSRF, rate limiting, RBAC por capabilities e auditoria estruturada append-only.
- Gate operacional antes do deploy: executar `npm run db:rehearse-phase2` contra PostgreSQL de teste dedicado e ensaiar backup/restauração. O workspace local não recebeu credenciais de banco para executar esse passo externo.

### Fase 3 — Cadastros

- Concluída no repositório: empresas/estabelecimentos, colaboradores por abas, histórico auditável e cadastros auxiliares de departamentos, cargos, centros de custo e jornadas.
- O diretório de colaboradores usa APIs paginadas e escopo por empresa, sem ampliar o snapshot central.
- CPF é armazenado como HMAC e últimos quatro dígitos; o valor bruto não entra no banco, histórico, logs, URLs ou armazenamento local.
- A Sólides permanece origem da admissão; o Fila DP recebe somente dados de pessoas com admissão concluída e não oferece fluxo concorrente de admissão digital.
- Gate operacional antes do deploy: aplicar a migration `0013_registrations_foundation` em PostgreSQL de homologação e executar o ensaio multi-tenant com backup restaurável.

### Fase 4 — Operação do DP

- Concluída no repositório: demandas vinculáveis a competência e prazo legal, biblioteca versionada e imutável após publicação, competências com lifecycle e gates atômicos, movimentações tipadas, aprovações atribuídas, pré/pós-fechamento, obrigações e pendências idempotentes.
- A central modular **Operação DP** usa APIs de recurso próprias e não amplia o snapshot central do painel.
- Publicar processo e reabrir competência permanecem exclusivos de administrador; decisões exigem aprovador atribuído, escopo da empresa e bloqueiam autoaprovação sensível.
- Dados de movimentação usam allowlists por tipo e a auditoria registra somente resumo e nomes de campos, sem copiar valores sensíveis.
- A Sólides continua como origem da admissão digital; a biblioteca bloqueia processos de admissão concorrentes.
- Gate operacional antes do deploy: aplicar a migration `0014_operation_dp_foundation` em PostgreSQL de homologação e executar `npm run db:rehearse-phase2` com backup restaurável.

### Fase 5 — Módulos auxiliares

- Concluída no repositório: Benefícios, Psicologia e Prestadores PJ usam um motor comum com empresa, competência, fornecedor, entrada/saída versionadas, aprovação atribuída e fechamento.
- Revisões submetidas são imutáveis no PostgreSQL; rejeições produzem uma nova revisão sem apagar o histórico.
- O fechamento da competência bloqueia entregas auxiliares ainda em rascunho, aprovação, rejeição ou somente aprovadas.
- Psicologia aceita apenas indicadores administrativos agregados e rejeita dados clínicos; observadores não possuem capability de leitura desse módulo.
- Gate operacional antes do deploy: aplicar a migration `0015_auxiliary_modules_foundation` em PostgreSQL de homologação e executar `npm run db:rehearse-phase2` com backup restaurável.

### Fase 6 — Integrações

- Concluída no repositório: arquitetura de conectores, cofre AES-256-GCM por workspace com rotação de chave, mapeamentos versionados e imutáveis após publicação, sync runs/items, fila com lease, idempotência, backoff, dead-letter e conciliação auditável.
- Sincronizações manuais apenas enfileiram trabalho; o executor autenticado realiza I/O com provedores fora da requisição do navegador e limita resposta, redirecionamento e endpoint.
- Webhooks assinados registram runs/items e deduplicam por chave externa ou hash, sem depender de tags inseridas no corpo da mensagem.
- Sólides continua aguardando credenciais até confirmar recurso oficial; a API impede estado conectado sem autenticação e teste real.
- Gate operacional antes do deploy: aplicar a migration `0016_integrations_engine`, configurar as chaves do cofre/executor, executar `npm run db:rehearse-phase2` em PostgreSQL de homologação e testar cada conector contra a conta sandbox/oficial do cliente.

### Fase 7 — Plataforma SaaS

- Concluída no repositório: cadastro multi-workspace controlado por flag, provisionamento transacional, onboarding por etapas, catálogo persistido de planos, assinatura por tenant, quotas, faturas e ledger financeiro append-only.
- Checkout e portal usam IDs de preço resolvidos somente no servidor; o webhook Stripe valida a assinatura antes do banco e deduplica o identificador global do evento.
- Administração global usa `FDP_PLATFORM_ADMIN_EMAILS` e contexto próprio no banco. O papel `admin` de um workspace nunca concede acesso cruzado a clientes.
- Limites de empresas, usuários e integrações são aplicados no servidor sob advisory lock; esconder uma ação na interface não é usado como controle de plano.
- Gate operacional antes do deploy: aplicar a migration `0017_saas_foundation`, configurar URL pública/Stripe/operadores, executar o rehearsal multi-tenant, homologar checkout e portal no modo teste e só então avaliar `FDP_ALLOW_SELF_SIGNUP=true`.

### Fase 5.1 — Controle de pagamento de psicólogos e PJ

- Concluída no repositório: os módulos de Psicologia e Prestadores PJ deixaram de ser apenas
  entregas genéricas do motor auxiliar e passaram a ter o modelo de pagamento exigido pelo produto.
- Psicólogos: cadastro administrativo/financeiro, lançamento de consulta com valor unitário
  histórico, fechamento por profissional e competência, ajustes append-only com motivo,
  pagamento com nota opcional e relatórios.
- PJ: cadastro com contrato e meio complementar, políticas versionadas de limite da nota
  (prestador → contrato → empresa → workspace), créditos e descontos tipados, apuração na ordem
  obrigatória (créditos e descontos antes do limite), nota esperada, complemento, controle
  assistido do Caju, conciliação e snapshot imutável.
- Nenhum limite fixo em código: `R$ 6.000,00` deixou de ser regra embutida e passou a ser
  política configurável e versionada.
- O complemento não declara integração pronta: a resposta da API informa `connected: false` e a
  documentação registra exatamente o que falta para tornar o conector operacional.
- Validação executada: lint, `db:check` (21 migrations), 93 testes e build aprovados; além disso
  `npm run db:rehearse-payments` aplicou as migrations em PostgreSQL 16 real e verificou
  constraints, imutabilidade de fechamento, ajustes append-only e isolamento multi-tenant sob RLS
  com papel sem superusuário.
- Detalhamento, permissões, rollback e pendências: `docs/pagamentos-psicologos-e-pj.md`.

### Fase 8 — Experiência

- Concluída no repositório: central de ação no painel, busca global multi-domínio e correções de
  acessibilidade nas superfícies novas.
- O painel responde "o que precisa ser feito agora?" com indicadores clicáveis derivados de
  consultas reais, filtrados por capability e escopo de empresa, agregados em uma única ida ao banco.
- Indicadores zerados não são exibidos e o módulo de Ponto — inexistente no produto — não é
  simulado: a resposta declara o que não é coberto.
- A busca passou a cobrir empresas, colaboradores (matrícula e CPF por HMAC, exibido mascarado),
  psicólogos, prestadores PJ, competências e integrações, sempre respeitando permissão.
- A paleta de busca virou um diálogo modal de verdade: `Esc` fecha, `Tab` fica preso e o foco
  retorna — o rótulo `ESC` do cabeçalho era uma afordância falsa até aqui.
- Validação: lint, `db:check`, 102 testes e build aprovados; consultas conferidas contra
  PostgreSQL 16 real com dados semeados.
- Detalhamento e pendências: `docs/fase-8-experiencia.md`.

### Fase 9 — Escala

- Concluída no repositório: observabilidade estruturada, outbox transacional, webhooks de saída
  assinados e API pública versionada.
- Logs estruturados carregam correlação (`requestId`, `workspaceId`, `syncRunId`, `jobId`,
  `deliveryId`, `apiKeyId`) e recusam PII por lista de bloqueio no próprio logger.
- O evento de domínio é gravado no mesmo lote da mutação que o originou; é append-only e imutável
  depois de publicado. O publicador roda fora da requisição e é idempotente por endpoint/evento.
- Entregas de webhook usam assinatura HMAC sobre `<timestamp>.<corpo>`, lease com
  `FOR UPDATE SKIP LOCKED`, backoff exponencial, dead-letter e log de entrega; o destino é
  restrito a HTTPS público, sem rede interna.
- A API `/api/v1` autentica por chave com escopos, limita por minuto no banco, aplica idempotência
  nas escritas e pagina por cursor. A escrita reusa o serviço interno em vez de duplicar regra.
- O OpenAPI descreve apenas endpoints implementados.
- Validação: lint, `db:check` (22 migrations), 118 testes e build aprovados; ensaio contra
  PostgreSQL 16 real cobrindo outbox, lease, limites, idempotência e isolamento.
- Detalhamento e pendências: `docs/fase-9-escala.md`.

### Fase 10 — Comercialização

- Site, suporte, LGPD e documentação comercial.

## Alterações implementadas nesta fase

- Nova área modular de Cadastros separada do snapshot e do componente monolítico do painel.
- Modelo de empresas ampliado com dados fiscais e endereço; a hierarquia matriz/filial representa empresa/estabelecimento sem migração destrutiva.
- Novas tabelas `fdp_employees`, `fdp_departments`, `fdp_positions`, `fdp_cost_centers` e `fdp_work_schedules`, com FKs compostas e RLS forçado.
- APIs de recurso para colaboradores, histórico e catálogos auxiliares, com paginação, RBAC e escopo de empresa.
- Auditoria atômica para empresas, colaboradores e catálogos; exclusões de mestres viraram inativação.
- Proteção de CPF por HMAC dedicado (`FDP_PII_HASH_SECRET`) e redação defensiva em auditoria.

- Nova tabela `fdp_auth_sessions` com token opaco armazenado como HMAC, expiração e revogação.
- Login cria sessão persistida; logout revoga a sessão no PostgreSQL.
- Semente de admissão interna substituída por conciliação cadastral.
- Sólides adicionada como integração externa em estado `needs_credentials`.
- API bloqueia criação de demandas, templates, SLAs e condições de automação de admissão digital.
- Site e exemplos visuais deixam de anunciar execução de admissão pelo Fila DP.
- Migration preserva dados históricos, desativa apenas a semente/política interna legada e não executa `DELETE`.

## Rollback da migration 0003

Antes do rollback, exportar `fdp_auth_sessions`, `fdp_process_templates`, `fdp_sla_policies` e `fdp_integrations` e registrar contagens. O rollback da aplicação exige encerrar todas as sessões novas e publicar simultaneamente a versão anterior.

1. Revogar sessões ativas e retirar tráfego da versão nova.
2. Restaurar nomes/checklist da semente somente onde o identificador determinístico e os valores esperados coincidirem.
3. Reativar a política legada apenas se a decisão de produto também for revertida.
4. Remover a integração Sólides somente quando continuar vazia e com status `needs_credentials`.
5. Remover `fdp_auth_sessions` apenas depois de confirmar que a aplicação anterior está ativa.

Como o rollback inclui `DROP TABLE` e potencial remoção de sementes, ele não é automatizado no caminho normal de migrations. Deve ser executado por runbook aprovado sobre backup restaurável.

## Baseline e validação

- Node.js: 24.x.
- Testes locais: 43/43 após a conclusão da Fase 2.
- Lint e TypeScript: aprovados.
- `db:check`: aprovado com quinze migrations.
- Build Next.js de produção: aprovado, com 21 páginas/rotas estáticas ou dinâmicas geradas.
- Instalação completa (produção + desenvolvimento): 17 vulnerabilidades reportadas pelo npm, sendo 9 altas em dependências de desenvolvimento/transitivas.
- Auditoria somente das dependências de produção: uma vulnerabilidade moderada transitiva em `undici` dentro de `@vercel/blob`; nenhuma alta ou crítica.

### Atualização da Fase 2 (incremento seguro)

- Mutações de `/api/*` agora exigem cabeçalho `Origin` igual à origem da requisição; webhooks de provedor permanecem exceção controlada por segredo.
- `proxy.ts` e `next.config.ts` centralizam a proteção de origem e os cabeçalhos HTTP de segurança.
- Login possui limitação persistente em PostgreSQL, com chaves HMAC de identidade/endereço, janela de 15 minutos e respostas `429` com `Retry-After`.
- O bootstrap inicial usa um guard singleton transacional para impedir dois workspaces concorrentes; erros internos do login são registrados apenas no servidor e devolvem mensagem genérica.
- Retornos de login/logout passam por validação same-origin que rejeita caminhos com normalização para host externo.
- O proprietário pode ter vários workspaces; FKs compostas impedem combinações entre workspaces em empresas, acesso empresa-membro e métricas de RH.
- A migration de constraints executa preflight e falha com diagnóstico explícito quando encontra dados legados inconsistentes; não corrige nem exclui dados automaticamente.
- Validação local desta atualização: 23 testes, lint, `db:check` (8 migrations) e build Next.js aprovados.
- `fdp_companies`, quadros, listas, cartões, tabelas-filhas e tabelas diretas de métricas/catálogo/SLA/configuração/automações agora usam RLS com `app.workspace_id` e `FORCE ROW LEVEL SECURITY`.
- Webhooks validam o segredo antes de consultar o workspace e estabelecem contexto tenant antes de acessar integração, inbox e atividade; as três tabelas estão sob RLS.
- Oito tabelas-filhas receberam `workspace_id` direto, backfill com preflight fail-fast e FKs compostas; referências de card/membro em notificações, planner, calendário, inbox, SLA e atividade também foram fechadas.
- A tela de segurança lista dispositivos ativos e permite revogar um, os demais ou todos; `last_seen_at` tem atualização limitada e a troca de senha encerra todas as sessões.
- RBAC passou a usar capabilities centralizadas e default-deny. Configurações de integração, dados de membros e métricas de folha são projetados conforme o papel; sincronização externa é exclusiva de administrador.
- `fdp_audit_events` registra mudanças administrativas com antes/depois em JSONB, request ID, RLS e trigger append-only. A API de auditoria exige capability administrativa.
- O executor de migration agora preserva blocos PostgreSQL `DO $$ ... $$`; um teste de regressão impede voltar ao parser inseguro por ponto e vírgula.
- `scripts/rehearse-phase2-db.mjs` cria um schema efêmero, aplica todas as migrations, simula dois workspaces e verifica negação sem contexto, RLS, FKs cruzadas e auditoria imutável. Ele não foi executado localmente porque não há URL PostgreSQL de teste neste ambiente.
- O gerador padrão do Drizzle falha neste host por `uv_os_get_passwd ENOMEM`; o snapshot consolidado da Fase 2 (`meta/0012_snapshot.json`) foi gerado com o workaround local de `process.geteuid`. Os snapshots intermediários não representam cada migration manual individual, mas SQL, journal e snapshot final estão alinhados.

## Decisão arquitetural recomendada

Manter Next.js e PostgreSQL/Neon. Remover gradualmente a compatibilidade D1 do caminho de produção e criar uma camada de acesso tipada orientada a tenant. Usar RLS como defesa adicional, não como substituto da autorização na aplicação. Separar processamento assíncrono de integrações e relatórios. Evoluir por fatias verticais com feature flags e backfills idempotentes, preservando o produto utilizável ao fim de cada fase.
