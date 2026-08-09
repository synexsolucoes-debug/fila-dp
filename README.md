# Fila DP

Plataforma full-stack de gestão, integração e conferência operacional para
Departamento Pessoal. O deploy de produção usa Next.js na Vercel,
PostgreSQL/Neon e Vercel Blob privado para anexos.

## Prerequisites

- Node.js `24.x`

## Quick Start

```bash
npm install
npm run dev
npm run build
```

This starter does not use `wrangler.jsonc`.

## Arquitetura de produção

- edit site code under `app/`
- `app/` contém as telas e rotas do Next.js
- `db/index.ts` mantém temporariamente uma API compatível com D1 sobre PostgreSQL/Neon e uma API compatível com R2 sobre Blob
- `db/schema.ts` define o modelo PostgreSQL; `scripts/migrate.mjs` é o único caminho autorizado para criar ou alterar schema
- `vercel.json` configura o build nativo do Next.js
- `VERCEL_DEPLOYMENT.md` descreve as credenciais e o processo de publicação

## Cadastros operacionais

A área **Cadastros** administra empresas/estabelecimentos, colaboradores, departamentos, cargos, centros de custo e jornadas. Colaboradores são carregados por APIs paginadas e não fazem parte do snapshot central do painel.

- CPF é validado e persistido somente como HMAC e quatro últimos dígitos; configure `FDP_PII_HASH_SECRET`.
- Alterações de empresa, colaborador e catálogos geram auditoria estruturada no mesmo lote da mutação.
- Exclusão de cadastro mestre é inativação, preservando vínculos e histórico.
- A Sólides permanece a origem da admissão digital. Inclusões manuais no Fila DP representam apenas pessoas já admitidas.

## Operação DP

A área **Operação DP** organiza competências, movimentações, aprovações atribuídas, conferências de pré e pós-fechamento, obrigações legais, pendências bloqueantes e a biblioteca versionada de processos.

- O fechamento de competência usa transições dedicadas e atômicas, com gates para movimentações, aprovações, obrigações e pendências.
- Movimentações aceitam somente campos permitidos por tipo; valores sensíveis não são copiados para a auditoria.
- Processos publicados são imutáveis. Uma alteração exige nova versão e a publicação é exclusiva de administrador.
- Reabrir uma competência fechada exige administrador, justificativa e registro auditável.
- A admissão digital continua exclusivamente no Sólides; a Operação DP não cria um fluxo concorrente.

## Módulos auxiliares

Benefícios, Psicologia e Prestadores PJ compartilham um fluxo controlado por empresa e competência: entrada versionada, aprovação atribuída, saída validada e fechamento.

- Revisões enviadas são imutáveis; uma rejeição exige nova revisão e preserva todo o histórico anterior.
- O fechamento global da competência é bloqueado enquanto existir entrega auxiliar que não esteja fechada ou cancelada.
- Psicologia armazena somente quantidades e protocolos administrativos agregados. Diagnóstico, CID, prontuário, medicação e notas clínicas são proibidos.
- Aprovações validam responsável atribuído, acesso à empresa e segregação contra autoaprovação.

## Central de ação e busca global

O painel abre respondendo **o que precisa ser feito agora**: indicadores clicáveis de demandas vencidas, aprovações atribuídas a você, pendências bloqueantes, itens de fechamento, obrigações no radar, pagamentos e fechamentos pendentes, notas divergentes, complemento a carregar e erros de integração. Detalhes em `docs/fase-8-experiencia.md`.

- Cada indicador vem de uma consulta real, respeita a capability do papel e o escopo de empresa do membro, e leva ao módulo responsável. Indicadores zerados não aparecem.
- O módulo de Ponto ainda não existe no produto e por isso não há indicador de ponto — a API declara o que não é coberto em vez de simular.
- A busca global (`Ctrl`+`K`) cobre demandas, empresas, colaboradores, psicólogos, prestadores PJ, competências e integrações. CPF é pesquisado por HMAC e exibido sempre mascarado.

## Controle de pagamento: Psicólogos e PJ

Dois módulos dedicados respondem às perguntas financeiras da operação. Documentação completa em `docs/pagamentos-psicologos-e-pj.md`.

- **Psicólogos**: quantas consultas válidas cada profissional realizou na competência e quanto pagar. O valor unitário é congelado no lançamento — reajustar a tabela não altera consultas antigas. Ajustes são append-only, com motivo e autor. O módulo é exclusivamente administrativo e financeiro: nenhum dado clínico é aceito.
- **PJ**: quanto o prestador tem a receber, quanto deve emitir de nota e quanto vai para o meio complementar. A ordem do cálculo é obrigatória — `líquido = base + créditos - descontos`, depois `nota = mínimo(líquido, limite)`, depois `complemento = líquido - nota`, e o Caju Saldo Livre recebe o complemento quando configurado.
- O limite da nota não é constante de código: políticas versionadas por workspace, empresa, contrato e prestador são resolvidas na ordem prestador → contrato → empresa → workspace, e competências já apuradas mantêm o limite que usaram.
- Concluir um fechamento grava snapshot imutável; reabrir exige capability própria e justificativa, garantidas também por trigger no PostgreSQL.
- O complemento em cartão de benefício é controle assistido com exportação: **não há integração oficial implementada** com a plataforma.
- Ensaio contra PostgreSQL real: `FDP_PAYMENTS_TEST_DATABASE_URL=... FDP_ALLOW_EPHEMERAL_SCHEMA_TEST=true npm run db:rehearse-payments`.

## Central de Integrações

A fase 6 substitui sincronizações longas dentro da requisição por um motor rastreável: conectores usam credenciais criptografadas por workspace, mapeamentos versionados, execuções e itens idempotentes, fila com lease/backoff/dead-letter e conciliação explícita.

- Configure `FDP_INTEGRATION_VAULT_KEY` com 32 bytes em base64 e um `FDP_INTEGRATION_WORKER_SECRET` distinto, com ao menos 32 caracteres.
- Segredos são cifrados com AES-256-GCM e nunca retornam à interface; rotação revoga o envelope anterior sem apagar o histórico auditável.
- Mapeamentos publicados são imutáveis. Uma alteração exige nova versão.
- Solicitações manuais apenas enfileiram a execução; o executor autenticado processa um job por chamada e aplica retentativa exponencial até a dead-letter.
- Webhooks assinados usam a mesma trilha de runs/items e deduplicação forte por identificador externo ou hash do payload.
- A Sólides permanece como origem da admissão digital e nunca é marcada como conectada sem recurso oficial confirmado, credencial e teste real de autenticação.

## Plataforma SaaS

A Fase 7 transforma o provisionamento singleton em cadastro multi-workspace e adiciona onboarding, catálogo de planos, quotas, assinatura e administração global separada dos papéis de cada cliente.

- `FDP_ALLOW_SELF_SIGNUP=true` habilita a criação pública de contas e grupos; em produção ela permanece desligada por padrão.
- `FDP_PLATFORM_ADMIN_EMAILS` define os operadores globais. Ser administrador de um workspace não concede acesso a `/plataforma`.
- Checkout e portal usam Stripe no servidor. O navegador escolhe apenas plano e periodicidade; os IDs de preço são resolvidos pelo catálogo persistido.
- O webhook `/api/saas/webhook/stripe` valida a assinatura sobre o corpo bruto antes de acessar o banco e deduplica eventos por workspace.
- Eventos financeiros e auditoria global são append-only; cartão, chave secreta e payload bruto do provedor não são persistidos.
- Limites de usuários, empresas e integrações são aplicados no servidor sob lock transacional.
- Planos pagos nascem como rascunho. Um operador da plataforma deve configurar preços `price_...`, valores e ativá-los antes da oferta.

## Continuidade e prontidão de cobrança

Detalhes e resultado medido em `docs/continuidade-e-prontidao-de-cobranca.md`.

- `npm run db:rehearse-restore` faz o ciclo completo de backup e restauração contra PostgreSQL real e verifica contagem por tabela, políticas de RLS, `FORCE ROW LEVEL SECURITY`, triggers, constraints, isolamento multi-tenant no banco restaurado e imutabilidade de fechamento concluído. Falha em qualquer verificação reprova o ensaio.
- A verificação de isolamento foi comprovada como não-vazia: concedendo `BYPASSRLS` ao papel de aplicação, o ensaio acusa o vazamento.
- Os tempos medidos referem-se ao volume do ensaio e **não são promessa de RTO em produção**.
- `GET /api/platform/billing-readiness` responde se dá para cobrar cliente real: chaves, URL pública, plano ativo com preço no provedor, webhook com evento processado e assinatura criada pelo checkout. `ready` só é verdadeiro quando todos os bloqueios caem, e nenhum segredo é devolvido.

## Site comercial

O site publica apenas o que o produto faz. Detalhes e checklist em `docs/fase-10-comercializacao.md`.

- Páginas: Solução, Funcionalidades, Integrações, Planos, Demonstração, FAQ, Contato, Termos, Privacidade e Subprocessadores/DPA.
- A página de planos lê o catálogo persistido e só mostra preço quando o plano está ativo e é cobrável; caso contrário, condição sob consulta.
- As integrações aparecem com estado real — disponível, parcial ou preparado. Sólides e Caju são declarados como preparados, sem integração oficial implementada.
- O formulário de contato grava um registro real com consentimento, limite por endereço e protocolo. Os contatos são lidos apenas pela administração da plataforma.
- `findProhibitedClaims` em `lib/marketing.ts` reprova o build se alguma página anunciar admissão digital própria, prontuário, cálculo tributário ou substituição de ERP.

## API pública e webhooks

A API `/api/v1` e os webhooks de saída abrem a operação para integração programática. Documentação completa em `docs/fase-9-escala.md`.

- Autenticação por chave (`Authorization: Bearer fdp_...`) com escopos, limite por minuto, idempotência nas escritas e paginação por cursor. A chave é guardada apenas como HMAC e exibida uma única vez.
- `GET /api/v1/openapi.json` descreve **somente** os endpoints implementados: empresas, colaboradores, competências, fechamentos PJ e lançamento de créditos/descontos PJ.
- A escrita reusa o mesmo serviço da interface: competência fechada e fechamento concluído recusam o lançamento igual. `Idempotency-Key` e `externalId` impedem duplicidade.
- Webhooks são assinados com HMAC sobre `<timestamp>.<corpo>` em `X-Fila-DP-Signature`. Recuse entregas com mais de 300 segundos e deduplique por `X-Fila-DP-Event-Id`.
- Eventos nascem em outbox transacional, no mesmo lote do fato; entregas têm lease, backoff exponencial e dead-letter.
- Configure `FDP_API_KEY_SECRET` para emitir chaves; o executor de entregas usa `FDP_INTEGRATION_WORKER_SECRET`.
- Ensaio de banco: `FDP_PAYMENTS_TEST_DATABASE_URL=... FDP_ALLOW_EPHEMERAL_SCHEMA_TEST=true npm run db:rehearse` (exige banco vazio e descartável).

## Autenticação

OpenAI workspace sites can read the current user's email from
`oai-authenticated-user-email`.

SIWC-authenticated workspace sites may also receive
`oai-authenticated-user-full-name` when the user's SIWC profile has a non-empty
`name` claim. The full-name value is percent-encoded UTF-8 and is accompanied by
`oai-authenticated-user-full-name-encoding: percent-encoded-utf-8`.

Treat the full name as optional and fall back to email when it is absent:

```tsx
import { headers } from "next/headers";

export default async function Home() {
  const requestHeaders = await headers();
  const email = requestHeaders.get("oai-authenticated-user-email");
  const encodedFullName = requestHeaders.get("oai-authenticated-user-full-name");
  const fullName =
    encodedFullName &&
    requestHeaders.get("oai-authenticated-user-full-name-encoding") ===
      "percent-encoded-utf-8"
      ? decodeURIComponent(encodedFullName)
      : null;

  const displayName = fullName ?? email;
  // ...
}
```

Em produção na Vercel, `/login` usa e-mail e senha próprios com sessão opaca,
persistida e revogável. `FDP_AUTH_SECRET` protege o hash do token; o token bruto
fica apenas no cookie seguro do navegador. Os headers do Sites continuam sendo
aceitos como compatibilidade fora da Vercel durante a transição.

Cada usuário pode revisar e revogar os próprios dispositivos em **Perfil e
segurança**. O sistema persiste somente um rótulo resumido do dispositivo e um
HMAC do endereço, nunca o IP ou o user-agent brutos. A redefinição de senha
revoga todas as sessões existentes.

## Compatibilidade com Sites

Os helpers em `app/chatgpt-auth.ts` continuam disponíveis para páginas que
precisam ler o usuário atual:

- Use `getChatGPTUser()` for optional signed-in UI.
- Use `requireChatGPTUser(returnTo)` for server-rendered pages that should send
  anonymous visitors through Sign in with ChatGPT.
- Use `chatGPTSignInPath(returnTo)` and `chatGPTSignOutPath(returnTo)` for
  browser links or actions.
- Pass a same-origin relative `returnTo` path for the destination after sign-in
  or sign-out. The helper validates and safely encodes it.
- Mark protected pages with `export const dynamic = "force-dynamic"` because
  they depend on per-request identity headers.

O fluxo antigo por headers do Sites permanece somente como fallback. Novos
deploys devem usar a sessão própria e a validação de membros do workspace.

## Useful Commands

- `npm run dev`: start local development
- `npm run build`: gerar o build Next.js para a Vercel
- `npm test`: executar testes de segurança, tenancy, migrations e HTML renderizado
- `npm run db:generate`: generate Drizzle migrations after schema changes
- `npm run db:check`: validar journal, metadados e operações destrutivas
- `npm run db:rehearse-phase2`: aplicar todas as migrations em schema efêmero e testar dois tenants nas Fases 2 a 7, inclusive SaaS, cobrança idempotente, cofre e imutabilidade; exige `FDP_PHASE2_TEST_DATABASE_URL` e `FDP_ALLOW_EPHEMERAL_SCHEMA_TEST=true`
- `npm run db:migrate`: aplicar migrations em banco PostgreSQL vazio ou versionado
- `npm run db:migrate:baseline`: registrar uma instalação legado existente antes da primeira migration controlada

## Learn More

- [vinext Documentation](https://github.com/cloudflare/vinext)
- [Drizzle D1 Guide](https://orm.drizzle.team/docs/get-started/d1-new)
