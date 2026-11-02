# Vinculato — guia para sessões de IA

Produto: plataforma de Departamento Pessoal multi-cliente. Next.js 16 (App
Router) na Vercel, PostgreSQL/Neon com RLS por cliente, anexos no Vercel Blob.
Toda a interface, documentação e mensagens de commit são em **português**.

## Antes de escrever código

- Leia `docs/arquitetura-operacional.md` §11 antes de qualquer funcionalidade
  que produza trabalho (demanda, prazo, alerta, jornada).
- Regra trabalhista (prazo, férias, rescisão, ASO, eSocial): use a skill
  `dp-legislacao-brasil`. Regra legal sem fonte citada não entra.
- O banco só muda por migration nova em `drizzle/postgres/` (numerada) aplicada
  por `scripts/migrate.mjs`. Nunca edite migration já aplicada. Toda migration
  precisa ser idempotente (a CI aplica duas vezes).

## Comandos

| Para | Comando |
|---|---|
| Subir localmente | ver "Rodar localmente" no `README.md` |
| Lint / tipos | `npm run lint` · `npm run typecheck` |
| Testes (todos os `tests/*.test.mts` e `.mjs`, ~12 s) | `npm test` |
| Tudo que a CI de qualidade roda | `npm run ci` |
| SQL do produto contra o schema real | `npm run verify:sql` (precisa de banco) |

Teste novo entra sozinho: basta o nome terminar em `.test.mts`.

## Regras que não se negociam

- **Isolamento entre clientes.** Rota usa `getWorkspaceContext` / `getScopedD1`;
  nunca consulte tabela de cliente sem o tenant da conexão. Prova de isolamento
  só vale com papel sem superusuário (superusuário ignora RLS).
- **Navegador não toca o banco.** Arquivo `"use client"` não importa `db/`,
  `next/headers` nem quem os importa. `tests/client-server-boundary.test.mts`
  reprova.
- **Sem dado pessoal em log.** Use `log()` de `lib/observability.ts`; ele
  descarta e-mail, nome, CPF, token e corpo de requisição.
- **Saúde: resultado, nunca diagnóstico.** ASO e Psicologia guardam
  apto/inapto/restrição de função, não doença.
- **IA e agentes propõem; o motor determinístico decide.**
- **Nomes preservados:** tabelas `fdp_*`, variáveis `FDP_*`, `getD1` e módulos
  `lib/fila-dp-*` ficam como estão — renomear quebra bancos instalados.

## Onde as coisas moram

- Telas do painel: `app/painel/features/<módulo>/`. `app/painel/WorkspaceApp.tsx`
  é a raiz e já é grande demais — código novo de tela vai para `features/`.
- Rotas: `app/api/**/route.ts`. Rota **nova** chama um serviço em `lib/` em vez
  de escrever SQL na própria rota.
- Sessão e login: `lib/auth/session.ts`.
- Regras puras (sem banco): `lib/*-rules.ts`, `lib/dp-calendar.ts` (dia útil).
- Estilo: tokens `--ui-*` em `app/globals.css`. Não crie cor fixa nem família
  nova de tokens por módulo; todo componente precisa funcionar em `.theme-dark`.
