# Fila DP

Plataforma full-stack de gestão visual de demandas de Departamento Pessoal.
O deploy de produção usa Next.js na Vercel, Turso/libSQL para o banco e Vercel
Blob privado para anexos.

## Prerequisites

- Node.js `>=22.13.0`

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
- `db/index.ts` mantém uma camada de compatibilidade D1/R2 sobre libSQL e Blob
- `db/schema.ts` e `lib/fila-dp-db.ts` definem o modelo e a criação idempotente do schema
- `vercel.json` configura o build nativo do Next.js
- `VERCEL_DEPLOYMENT.md` descreve as credenciais e o processo de publicação

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

Em produção na Vercel, `/login` usa e-mail e senha próprios com cookie de sessão
assinado por `FDP_AUTH_SECRET`. Os headers do Sites continuam sendo aceitos
como compatibilidade durante a transição.

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
- `npm test`: gerar o build e verificar o HTML renderizado
- `npm run db:generate`: generate Drizzle migrations after schema changes

## Learn More

- [vinext Documentation](https://github.com/cloudflare/vinext)
- [Drizzle D1 Guide](https://orm.drizzle.team/docs/get-started/d1-new)
