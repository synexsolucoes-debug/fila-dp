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

## Central de Integrações

A fase 6 substitui sincronizações longas dentro da requisição por um motor rastreável: conectores usam credenciais criptografadas por workspace, mapeamentos versionados, execuções e itens idempotentes, fila com lease/backoff/dead-letter e conciliação explícita.

- Configure `FDP_INTEGRATION_VAULT_KEY` com 32 bytes em base64 e um `FDP_INTEGRATION_WORKER_SECRET` distinto, com ao menos 32 caracteres.
- Segredos são cifrados com AES-256-GCM e nunca retornam à interface; rotação revoga o envelope anterior sem apagar o histórico auditável.
- Mapeamentos publicados são imutáveis. Uma alteração exige nova versão.
- Solicitações manuais apenas enfileiram a execução; o executor autenticado processa um job por chamada e aplica retentativa exponencial até a dead-letter.
- Webhooks assinados usam a mesma trilha de runs/items e deduplicação forte por identificador externo ou hash do payload.
- A Sólides permanece como origem da admissão digital e nunca é marcada como conectada sem recurso oficial confirmado, credencial e teste real de autenticação.

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
- `npm run db:rehearse-phase2`: aplicar todas as migrations em schema efêmero e testar dois tenants nas Fases 2 a 6, inclusive cofre, integrações idempotentes e imutabilidade; exige `FDP_PHASE2_TEST_DATABASE_URL` e `FDP_ALLOW_EPHEMERAL_SCHEMA_TEST=true`
- `npm run db:migrate`: aplicar migrations em banco PostgreSQL vazio ou versionado
- `npm run db:migrate:baseline`: registrar uma instalação legado existente antes da primeira migration controlada

## Learn More

- [vinext Documentation](https://github.com/cloudflare/vinext)
- [Drizzle D1 Guide](https://orm.drizzle.team/docs/get-started/d1-new)
