# Auditoria estratégica do produto SaaS — Painel Admin e Workspace

Data: 2026-08-11
Repositório: `synexsolucoes-debug/fila-dp` (Vinculato)
Escopo: `/plataforma` (administração global) e `/painel` (workspace do cliente)

Este documento é uma auditoria **de produto**, complementar ao diagnóstico técnico de
`docs/diagnostico-arquitetura-2026-08.md`. Ele não repete o inventário de fases: parte do que
existe hoje no código e responde o que impede o Vinculato de operar como SaaS vendável, ativável
e retentivo. Toda afirmação abaixo foi verificada no código; as referências apontam o arquivo.

---

## 1. Diagnóstico atual

### 1.1 O que já está bem estruturado

Esta é uma base incomum para um SaaS deste estágio. O que segue não é cortesia — é o que
dispensa reconstrução.

**Fundação de dados e tenancy.** RLS com `FORCE ROW LEVEL SECURITY`, FKs compostas impedindo
combinações entre workspaces, contexto de tenant por transação e um ensaio executável que prova
o isolamento no banco restaurado (`scripts/rehearse-backup-restore.mjs`). A verificação foi
comprovada como não-vazia: concedendo `BYPASSRLS`, o ensaio acusa o vazamento. Poucos produtos
nesta faixa conseguem afirmar isso.

**Autorização.** Capabilities centralizadas com default-deny (`lib/authorization.ts`), exceção
individual restritiva vencendo o papel, e resolução de módulo que distingue "o papel não
permite" de "o plano não inclui" (`lib/modules.ts`) — a diferença entre pedir acesso ao
administrador e pedir upgrade. Limites de assentos, empresas e integrações são aplicados no
servidor sob advisory lock (`app/api/members/route.ts:60`), não escondendo botão na interface.

**Auditoria.** `fdp_audit_events` e `fdp_platform_audit_events` são append-only com trigger no
PostgreSQL, com antes/depois em JSONB e `request_id`. O console global grava trilha em toda
ação administrativa.

**Regras de negócio impostas em várias camadas.** A proibição de evento de hora virar valor é
imposta no vocabulário, na aplicação, no `CHECK` do PostgreSQL e na exportação. A ordem de
cálculo do PJ e a imutabilidade de fechamento têm trigger no banco. Isso é o oposto do padrão
de mercado, em que a regra vive só no formulário.

**Honestidade de produto.** `findProhibitedClaims` em `lib/marketing.ts` reprova o build se uma
página anunciar o que o produto não faz. Integrações aparecem com estado real. O console global
não tem botão decorativo.

**Infraestrutura de escala já pronta.** Outbox transacional, webhooks assinados com lease e
dead-letter, API `/api/v1` com escopos, idempotência e cursor, logger que recusa PII por
construção (`lib/observability.ts`), 32 suítes de teste e CI com lint, typecheck, `db:check`,
testes, build e `npm audit`.

### 1.2 Onde estão os gargalos

O padrão do repositório é claro e vale nomear, porque ele explica quase toda a lista: **o
backend está muito à frente do produto**. Há capacidade construída, testada e auditada que
nenhum usuário consegue alcançar. O gargalo dominante não é de engenharia de dados — é de
superfície, de ativação e de instrumentação de negócio.

#### Painel administrativo (`/plataforma`)

| # | Gargalo | Evidência |
| --- | --- | --- |
| A1 | **Nenhuma métrica de negócio.** O overview devolve quatro contagens: workspaces, assinaturas ativas, inadimplentes e onboardings concluídos. Não existe MRR, ARR, churn, LTV, ARPA, conversão de trial ou receita em risco em lugar nenhum do código. | `app/api/platform/overview/route.ts:20`; busca por `mrr\|churn\|ltv` no repositório retorna zero |
| A2 | **O dado de receita existe e não é usado.** `fdp_workspace_subscriptions.contracted_monthly_price_cents` guarda o preço contratado por cliente, e `fdp_billing_invoices`/`fdp_billing_events` mantêm o ledger. Falta apenas a agregação. | `app/api/platform/workspaces/[id]/detail/route.ts:33`; `db/schema.ts:1274` |
| A3 | **Funil comercial construído e não exposto.** `/api/platform/leads` tem pipeline completo (`new → contacted → qualified → discarded`), auditoria e totais por status. Nenhuma tela consome. Os contatos do site caem num buraco. | `app/api/platform/leads/route.ts`; nenhuma referência em `app/plataforma/*` |
| A4 | **Prontidão de cobrança sem tela.** `/api/platform/billing-readiness` responde objetivamente se dá para cobrar cliente real. Só é acessível por curl. | `app/api/platform/billing-readiness/route.ts` |
| A5 | **`window.prompt()` como interface de decisão crítica.** Suspender workspace, arquivar, cancelar, bloquear usuário, transferir propriedade e renomear usam prompt nativo. Sem validação em tela, sem dizer o impacto ("isso derruba 14 usuários e 3 empresas"), quebra em mobile, inacessível, e o motivo obrigatório vira texto descartado. | `app/plataforma/PlatformConsole.tsx:143,282`; `PlatformDetail.tsx:156,272` |
| A6 | **Sem sinal de saúde do cliente.** O detalhe traz plano, membros, empresas, módulos e auditoria. Não traz último acesso do grupo, volume de uso nos últimos 30 dias, módulos contratados e nunca abertos, nem tendência. Sem isso, churn só é descoberto no cancelamento. | `app/api/platform/workspaces/[id]/detail/route.ts` |
| A7 | **Suporte sem ferramenta.** Não existe acesso assistido (impersonation) auditado, visão dos erros do cliente (`/api/client-errors` grava e não tem tela), nem canal de aviso/manutenção. Os Termos prometem "acesso da equipe de suporte autorizado, temporário, justificado e auditado" — o mecanismo não existe no código. | `app/termos/page.tsx:57`; `app/api/client-errors/route.ts` |
| A8 | **Auditoria global inutilizável para investigação.** Lista fixa dos 80 eventos mais recentes, sem filtro por ator, período, ação ou workspace, sem busca e sem exportação. Não atende pedido de titular nem apuração de incidente. | `app/api/platform/overview/route.ts:41` |
| A9 | **Administração global sem controle de identidade forte.** Operadores vêm de `FDP_PLATFORM_ADMIN_EMAILS`. Não há MFA obrigatório, elevação temporária, aprovação de segundo operador para ação destrutiva, nem trilha de quem entrou na lista e quando. Rotacionar exige deploy. | `lib/platform-authorization.ts` |
| A10 | **Listas sem paginação.** Workspaces `LIMIT 200`, leads `LIMIT 100`, auditoria `LIMIT 80`. Funciona hoje e degrada em silêncio: a partir do limite, o console passa a mentir sem avisar. | `app/api/platform/overview/route.ts:29` |

#### Workspace do cliente (`/painel`)

| # | Gargalo | Evidência |
| --- | --- | --- |
| W1 | **Nenhuma URL profunda.** O painel inteiro é estado React em `/painel`: 15 telas num `type View`, sem `useSearchParams`, sem `pushState`. Não dá para mandar o link de uma demanda a um colega, o botão voltar sai do produto, F5 perde o contexto e o bundle não divide por rota. É o atrito de navegação nº 1 e o mais caro de adiar. | `app/painel/WorkspaceApp.tsx:67`; busca por `pushState\|useSearchParams` em `app/painel` retorna zero |
| W2 | **Snapshot monolítico.** `getWorkspaceSnapshot` dispara 26 consultas em paralelo mais duas sequenciais e carrega cartões, checklists, comentários, anexos, atividades, métricas e catálogos sem paginação. Ele é devolvido por **73 pontos em 32 rotas de mutação**: mover um cartão recarrega a operação inteira. | `lib/fila-dp-db.ts:274-334`; contagem por `grep -rn getWorkspaceSnapshot app/api` |
| W3 | **Polling que amplifica o problema.** A cada 30s (configurável até 5s) o cliente consulta `/api/realtime`; havendo qualquer atividade de qualquer pessoa no grupo, recarrega o snapshot completo. Com 10 pessoas ativas, o custo é multiplicado por 10 sem que ninguém tenha pedido nada. | `app/painel/WorkspaceApp.tsx:496-520` |
| W4 | **Escopo por empresa filtrado em memória.** As linhas são buscadas e depois descartadas em JavaScript. Correto no resultado, caro no caminho, e deixa a regra fora do banco — onde o resto do produto a impõe. | `lib/fila-dp-db.ts:339-345` |
| W5 | **Onboarding autodeclarado e sem ação.** "Concluir" apenas marca a etapa. Nada verifica se existe empresa cadastrada, membro convidado ou primeira demanda criada, e o passo não leva ao módulo correspondente. O checklist mede intenção, não valor entregue. | `app/api/saas/onboarding/route.ts:36`; `app/painel/features/saas/SaasView.tsx:154` |
| W6 | **Não existe e-mail transacional em nenhum ponto do produto.** Convidar alguém gera um link que o administrador precisa copiar e enviar por fora, válido por 30 minutos. E **não existe "esqueci minha senha"**: a tela de recuperação instrui a pessoa a pedir um link ao administrador, e o login sequer tem o link. Isto é, ao mesmo tempo, atrito de ativação, custo de suporte recorrente e risco de abandono no primeiro dia. | `app/api/members/route.ts:85-95`; `app/recuperar/page.tsx:10`; busca por `resend\|sendgrid\|nodemailer\|smtp` retorna zero |
| W7 | **Colaboração parada no comentário.** Não há menção (`@`), notificação de atribuição fora do produto, resumo diário, nem indicação de quem está olhando o quê. Notificações são in-app: só chegam a quem já estava dentro. | `db/schema.ts` (`fdp_notifications`); ausência de canal externo |
| W8 | **Recursos entregues e invisíveis.** Chaves da API pública, webhooks de saída e a auditoria do workspace têm rota completa, com escopos e capabilities — e **nenhuma tela**. O cliente que comprou "API pública" não consegue emitir uma chave sem curl. | `app/api/settings/api-keys/route.ts`, `app/api/settings/webhooks/route.ts`, `app/api/audit/route.ts`; zero referências no cliente |
| W9 | **Ajuda decorativa.** O botão de ajuda do cabeçalho exibe um toast genérico. Não há central de ajuda, tour, artigo contextual nem caminho para o suporte de dentro do produto. | `app/painel/WorkspaceApp.tsx:1259` |
| W10 | **Navegação plana e configuração escondida.** 15 itens em duas seções no menu, mais um modal de Configurações com nove seções, sem busca de configuração, sem itens recentes e sem hierarquia por frequência de uso. | `app/painel/WorkspaceApp.tsx:1154-1172` |
| W11 | **Sem portabilidade.** Existem exportações pontuais (Caju, ponto), mas não há exportação do workspace. Vira objeção de venda ("e se eu quiser sair?") e pendência de LGPD art. 18. | ausência de rota de exportação geral |
| W12 | **Um componente de 2.116 linhas.** `WorkspaceApp.tsx` concentra navegação, estado, formulários, apresentação e chamadas de quase todos os módulos. Já apontado em 08/08 e ainda o maior risco de regressão visual do produto. | `app/painel/WorkspaceApp.tsx` |

---

## 2. Melhorias prioritárias

### 2.1 No painel administrativo

**A1. Torre de métricas de negócio.** Substituir as quatro contagens por um painel que responda
as perguntas de operação de SaaS: MRR e sua variação no mês, receita nova / expansão / contração
/ churn, MRR em risco (assinaturas `past_due`), ARPA, conversão de trial, tempo médio até
onboarding concluído. O dado já está em `contracted_monthly_price_cents` e no ledger de faturas —
o esforço é de uma consulta agregada e uma faixa de cartões, não de modelagem.

**A2. Tela de leads.** A rota existe com pipeline e auditoria. Expor uma tabela com filtro por
status, contato, origem e tempo desde a entrada, com transição de estado em um clique. Sem isso,
o formulário do site comercial está gerando registro que ninguém lê.

**A3. Prontidão de cobrança visível.** Trazer `/api/platform/billing-readiness` para o topo do
console como um bloco de bloqueios pendentes. É a resposta a "já posso cobrar cliente real?", e
hoje só é acessível por linha de comando.

**A4. Diálogos de decisão no lugar do `window.prompt`.** Toda ação destrutiva deve mostrar o que
vai acontecer antes de acontecer: quantos usuários perdem acesso, quantas empresas e competências
ficam congeladas, o que é reversível. O motivo obrigatório passa a ser campo com validação e
histórico, não uma string perdida.

**A5. Saúde do cliente no detalhe do workspace.** Último acesso do grupo, usuários ativos nos
últimos 7 e 30 dias, volume de demandas e fechamentos por competência, módulos contratados sem
nenhum uso, erros recentes. Um score simples (adoção × recência × amplitude de módulos) já
transforma o console em ferramenta de retenção.

**A6. Acesso assistido auditado.** Sessão de suporte com escopo, prazo, justificativa obrigatória,
consentimento registrável e trilha visível também para o cliente. É o que os Termos já prometem
e é o que evita o antipadrão de pedir a senha do cliente.

**A7. Auditoria global investigável.** Filtro por ator, ação, entidade, período e workspace,
paginação por cursor e exportação assinada. É requisito de apuração de incidente e de resposta a
titular.

**A8. Endurecer a identidade de plataforma.** MFA obrigatório para operador global, elevação
temporária com expiração, e a lista de operadores em tabela auditável em vez de variável de
ambiente.

### 2.2 No workspace

**W1. Rotas reais no painel.** `/painel/demandas/:id`, `/painel/ponto/:folha`, `/painel/cadastros`
— com filtros na querystring. É pré-requisito de compartilhamento, de voltar/avançar, de
recuperação de contexto e de divisão de bundle. Todo mês adiado aumenta o custo, porque cada
módulo novo nasce preso ao estado central.

**W2. Fim do snapshot como resposta de mutação.** Mutações devolvem o recurso afetado; a tela
invalida só aquele domínio. O carregamento inicial passa a ser paginado por recurso. Isso corta
a latência percebida de cada ação e reduz custo de banco proporcionalmente ao número de usuários
ativos — hoje os dois crescem juntos.

**W3. E-mail transacional e recuperação de senha por conta própria.** Um provedor (Resend, SES),
quatro mensagens iniciais: convite, redefinição de senha, atribuição de demanda e resumo de
pendências. O link de "esqueci minha senha" no login sozinho elimina uma classe inteira de
chamado e desbloqueia a ativação de quem entra fora do horário do administrador.

**W4. Onboarding verificado e acionável.** Cada etapa é concluída pela evidência (existe empresa,
existe segundo membro, existe primeira demanda fechada), não pelo clique, e cada etapa leva ao
módulo com o formulário já aberto. A medida certa não é "checklist concluído", é **tempo até a
primeira demanda encerrada** — que hoje não é medido.

**W5. Expor API, webhooks e auditoria do workspace.** Três telas sobre rotas que já existem,
testadas e com capability. É o menor esforço com maior efeito de valor percebido do backlog
inteiro: o cliente passa a ver o que já comprou.

**W6. Colaboração real.** Menção com notificação, atribuição que avisa fora do produto, resumo
diário opcional por e-mail e indicação de leitura. A operação de DP é coordenada entre pessoas;
hoje a coordenação acontece no WhatsApp e volta como retrabalho.

**W7. Ajuda de verdade.** Substituir o toast por painel contextual com o artigo da tela atual,
atalho para a busca global e caminho para abrir chamado com o `requestId` já preenchido — a
infraestrutura de referência de suporte já existe em `app/painel/request-error.ts`.

**W8. Exportação do workspace.** Exportação completa (CSV/JSON) por competência e por domínio,
autosserviço e auditada. Vende contra a objeção de aprisionamento e resolve o art. 18.

### 2.3 Matriz de prioridade

Impacto = efeito sobre receita, ativação, retenção ou risco. Esforço = tamanho estimado para uma
equipe pequena que conhece esta base.

| # | Melhoria | Área | Impacto | Esforço |
| --- | --- | --- | --- | --- |
| 1 | Recuperação de senha autosserviço + e-mail transacional | Workspace | **Alto** | **Baixo** |
| 2 | Métricas de negócio (MRR, churn, receita em risco, conversão) | Admin | **Alto** | **Baixo** |
| 3 | Telas de API keys, webhooks e auditoria do workspace | Workspace | **Alto** | **Baixo** |
| 4 | Tela de leads sobre a rota existente | Admin | Médio | **Baixo** |
| 5 | Prontidão de cobrança no console | Admin | Médio | **Baixo** |
| 6 | Diálogos de decisão com impacto (fim do `window.prompt`) | Admin | Médio | **Baixo** |
| 7 | Convite por e-mail com validade útil (7 dias) e reenvio | Workspace | **Alto** | **Baixo** |
| 8 | Onboarding verificado por evidência + deep link por etapa | Workspace | **Alto** | Médio |
| 9 | Rotas reais e URLs profundas no painel | Workspace | **Alto** | **Alto** |
| 10 | Mutação devolve recurso, não snapshot; leitura paginada | Workspace | **Alto** | **Alto** |
| 11 | Saúde e uso do cliente no console | Admin | **Alto** | Médio |
| 12 | Acesso assistido auditado (suporte) | Admin | **Alto** | Médio |
| 13 | Escopo de empresa no SQL/RLS em vez de memória | Workspace | Médio | Médio |
| 14 | Menções, notificação de atribuição e resumo diário | Workspace | **Alto** | Médio |
| 15 | Auditoria global com filtro, cursor e exportação | Admin | Médio | Médio |
| 16 | MFA obrigatório e operadores em tabela auditável | Admin | **Alto** | Médio |
| 17 | Exportação/portabilidade do workspace | Workspace | Médio | Médio |
| 18 | Ajuda contextual e abertura de chamado no produto | Workspace | Médio | **Baixo** |
| 19 | Paginação nas listas do console | Admin | **Baixo** | **Baixo** |
| 20 | Decomposição de `WorkspaceApp.tsx` | Workspace | Médio | **Alto** |

Os itens 1 a 7 somam menos esforço que o item 9 sozinho e cobrem os três buracos que hoje
custam dinheiro: cliente que não consegue entrar, operação que não sabe quanto fatura e recurso
pago que ninguém vê.

---

## 3. Novas funcionalidades sugeridas

### 3.1 Para aumentar valor percebido e reduzir churn

**Alertas proativos de prazo legal.** O produto já conhece competência, obrigação, SLA e
pendência bloqueante. Falta transformar isso em aviso antes do vencimento, no canal certo, com o
responsável nomeado. Um produto de DP que avisa antes do FGTS vencer não é substituído por
planilha.

**Painel do cliente final (portal de solicitação).** Um endereço externo onde o gestor da empresa
atendida abre solicitação, acompanha o andamento e aprova o que precisa de aprovação, sem ocupar
assento. Amplia o valor sem aumentar o custo de licença e cria dependência positiva.

**Relatórios com filtro salvo, agendamento e envio.** Hoje relatórios existem, mas nada é salvo
nem enviado. Relatório que chega sozinho na sexta é o hábito que segura a renovação.

**Health score e alerta de risco para a própria operação.** Aviso interno quando um cliente cai
de uso, quando um módulo contratado nunca foi aberto ou quando a assinatura entra em `past_due`
— ação antes do cancelamento, não depois.

**Trilha de aprovação por e-mail.** Aprovar movimentação e fechamento sem entrar no produto,
com link assinado e prazo curto. Reduz o gargalo humano típico do fechamento de competência.

### 3.2 Automações

**Regras por evento com condição e ação compostas.** O motor atual é simples e roda dentro da
requisição. Com o outbox já implementado, a evolução natural é processamento assíncrono com
retentativa, ações encadeadas e simulação antes de publicar.

**Rotinas de competência.** Abrir a competência já criando as demandas recorrentes, atribuindo
responsáveis por empresa e aplicando o SLA da política — hoje isso é trabalho manual repetido
todo mês.

**Conciliação assistida.** A conciliação de integração já existe; falta sugerir a resolução com
base no histórico de decisões e permitir aplicar em lote.

### 3.3 Relatórios avançados

- Custo por empresa, centro de custo e competência com comparação temporal.
- Produtividade por analista e por processo, com SLA cumprido e retrabalho.
- Painel de fechamento: o que falta, quem está travando e desde quando.
- Exportação agendada para o contador e para o ERP.

### 3.4 Integrações essenciais

- **E-mail transacional** — pré-requisito de quase tudo acima (item 1 da matriz).
- **WhatsApp / Teams / Slack** para aviso de prazo e aprovação, onde a operação de DP já vive.
- **Calendário** — as conexões Google/Microsoft estão modeladas e paradas em configuração; o
  OAuth fecha o ciclo do planner.
- **Contabilidade/ERP** por exportação padronizada, com o conector Sólides já operante como
  referência de qualidade.
- **SSO (Google/Microsoft)** para clientes com mais de 20 assentos — objeção comum em venda
  corporativa e caminho de menor atrito de login.

---

## 4. Roadmap sugerido de execução

### Fase 1 — Quick wins (≈ 3 semanas)

Objetivo: parar de perder cliente na porta e enxergar o próprio negócio.

1. Provedor de e-mail transacional + convite por e-mail com validade de 7 dias e reenvio.
2. "Esqueci minha senha" no login, autosserviço, com o mesmo token já implementado.
3. Métricas de negócio no console global (MRR, variação, receita em risco, conversão de trial).
4. Telas de leads e de prontidão de cobrança sobre as rotas que já existem.
5. Telas de chaves da API, webhooks de saída e auditoria dentro do workspace.
6. Diálogos de decisão com impacto declarado no lugar do `window.prompt`.
7. Ajuda contextual com abertura de chamado carregando o `requestId`.

Resultado esperado: ativação deixa de depender do administrador estar online; a operação passa a
ter MRR e churn na tela; três recursos pagos deixam de ser invisíveis.

### Fase 2 — Estabilização (≈ 8 a 10 semanas)

Objetivo: tirar a dívida que encarece toda funcionalidade futura.

1. Rotas reais e URLs profundas no painel, com divisão de bundle por módulo.
2. Fim do snapshot como resposta de mutação; leitura paginada e invalidação por domínio.
3. Escopo de empresa aplicado no SQL/RLS em vez de memória.
4. Decomposição progressiva de `WorkspaceApp.tsx` acompanhando as rotas.
5. Onboarding verificado por evidência, com deep link por etapa e medição de tempo até o
   primeiro fechamento.
6. Saúde e uso do cliente no console, com alerta interno de risco.
7. Acesso assistido auditado, MFA de operador global e operadores em tabela auditável.
8. Auditoria global com filtro, cursor e exportação; paginação nas listas do console.
9. Menções, notificação de atribuição e resumo diário.

Resultado esperado: a interface deixa de ser um único estado gigante, o custo por usuário ativo
para de crescer junto com o time do cliente, e o suporte ganha ferramenta em vez de promessa
contratual.

### Fase 3 — Inovação e diferencial competitivo (≈ 12 semanas)

Objetivo: transformar conformidade em vantagem.

1. Alertas proativos de prazo legal com responsável nomeado, no canal do cliente.
2. Portal do cliente final para solicitação e aprovação sem consumir assento.
3. Motor de automação assíncrono sobre o outbox, com simulação antes de publicar.
4. Rotinas de abertura de competência e conciliação assistida em lote.
5. Relatórios com filtro salvo, agendamento e envio automático.
6. Exportação e portabilidade autosserviço, fechando o art. 18 e a objeção de aprisionamento.
7. SSO corporativo e conectores adicionais com sandbox de mapeamento.
8. Assistente do painel com ações executáveis sob confirmação, aproveitando o limite de
   privacidade já implementado em `lib/assistant`.

---

## 5. Como medir se a auditoria funcionou

Sem estes números, as fases acima viram opinião. Nenhum deles é coletado hoje.

| Indicador | Onde nasce | Meta inicial |
| --- | --- | --- |
| Tempo até a primeira demanda encerrada | Workspace, a partir da criação | < 48 h |
| Onboarding concluído por evidência | `fdp_workspace_onboarding` + verificação real | > 70 % em 14 dias |
| Convites que viram acesso | Convite emitido × primeiro login | > 80 % |
| Chamados por conta de acesso/senha | Suporte | tende a zero após a Fase 1 |
| MRR, churn de receita e receita em risco | Assinaturas + ledger de faturas | visível diariamente |
| Workspaces sem acesso há 14 dias | Sessões por workspace | alerta automático |
| Módulos contratados com uso zero | Telemetria de módulo | revisão mensal |

---

## 6. Recomendação final

A ordem importa mais que a lista. A tentação natural, olhando o item W1 e W2, é começar pela
reescrita da navegação — é o problema mais visível para quem lê o código. Seria um erro de
sequenciamento: **um cliente que não consegue redefinir a própria senha não chega a reclamar da
URL**, e uma operação que não sabe seu MRR não consegue justificar o investimento na reescrita.

A Fase 1 inteira custa menos que o item 9 sozinho e destrava receita, ativação e visibilidade.
A Fase 2 é o que impede que cada módulo novo nasça com a mesma dívida. A Fase 3 é o que
diferencia — e só faz sentido depois que o cliente consegue entrar, ativar e perceber o que
comprou.
