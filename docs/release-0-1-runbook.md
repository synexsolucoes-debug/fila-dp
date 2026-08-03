# Release 0.1 — fonte, banco e recuperação

## Regra de publicação

- `main` é a única fonte autorizada para produção.
- Toda mudança nasce em branch, abre pull request, passa pelo workflow `Release 0 quality gate` e recebe Preview da Vercel.
- O deploy deve exibir um commit em `/api/version`; deploy sem commit conhecido não pode ser promovido.
- O build usa Node 24 fixado por `package.json` e `.nvmrc`.
- O projeto não executa DDL, seed ou limpeza ao abrir páginas ou APIs.

## Banco e migrations

1. Criar uma branch/cópia do banco Neon de produção.
2. Configurar `DATABASE_URL` apontando somente para essa cópia.
3. Para um banco novo, executar `npm run db:migrate`.
4. Para o banco de produção legado, executar uma única vez `npm run db:migrate:baseline`. O comando registra a migration inicial e normaliza tipos/índices existentes.
5. Executar os testes de fumaça no Preview antes de repetir a migration na produção.
6. Nunca editar uma migration já registrada em `fdp_schema_migrations`.

## Gate de aceitação

- `npm ci`, `npm run lint`, `npm run db:check`, `npm test`, `npm run build` e `npm audit --omit=dev --audit-level=high` devem passar.
- Login, criação/movimentação de demanda, Inbox, Planner, relatórios, anexos e permissões devem ser testados no Preview.
- Abrir `GET /api/workspace` duas vezes não pode alterar schema, excluir listas, criar cartões ou persistir mudança de SLA.
- Confirmar `/api/version` no Preview e, depois, em produção.

## Publicação e rollback

1. Faça o merge do PR somente após o Preview aprovado.
2. Migre a cópia do banco e faça o teste completo.
3. Antes da migration de produção, crie um ponto de recuperação/branch no Neon.
4. Execute a migration de produção.
5. Promova o deployment validado. A Vercel permite promover um deployment existente e fazer Instant Rollback para uma versão anterior.
6. Se o aplicativo falhar sem corrupção de dados, faça rollback do deployment da Vercel.
7. Se houver alteração incorreta de dados, use primeiro o Time Travel Assist do Neon para confirmar o instante e restaure a branch dentro da janela de retenção configurada.

Referências operacionais: [promover deployments na Vercel](https://vercel.com/docs/deployments/promoting-a-deployment), [Instant Rollback](https://vercel.com/docs/instant-rollback) e [Point-in-Time Restore no Neon](https://neon.com/blog/announcing-point-in-time-restore).

## Configuração manual ainda necessária

- Ativar proteção da branch `main` no GitHub e exigir o check `quality`.
- Confirmar que a integração Git da Vercel aponta para este repositório e que Preview é criado em cada PR.
- Separar credenciais Neon de Preview e Production.
- Definir e testar a retenção de histórico/PITR conforme o plano contratado no Neon.
