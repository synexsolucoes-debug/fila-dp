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

### Módulos de pessoas, benefícios e PJ

- A migration `0004_people_benefits_pj.sql` cria pessoas, vínculos profissionais, políticas e movimentações de benefícios e fechamentos PJ.
- Ela deve ser aplicada no Neon antes de publicar a versão da aplicação que expõe esses módulos.
- Após migrar, valide no Preview: cadastro de funcionário CLT, cadastro de vínculo PJ, política de benefício, lançamento por competência e fechamento PJ.
- O fechamento PJ deve bloquear aprovação quando o valor da nota divergir do valor esperado; valores financeiros devem aparecer somente para administrador e membro.

### Fonte Funcionários GRUPO OPYT.xlsx

- A aba `GRUPO OPYT` é a fonte cadastral aceita pelo importador em **Funcionários → Sincronizar planilha**.
- A sincronização é restrita ao administrador e não armazena o XLSX: o arquivo é processado em memória e descartado após a importação.
- Pessoa e vínculo são atualizados de forma idempotente; CPF é usado somente em memória para gerar uma chave HMAC e não é gravado em texto aberto.
- CNPJ válido tem prioridade no vínculo com a empresa. Empresas ainda inexistentes são criadas como empresas do grupo, subordinadas à empresa principal.
- `Salário` alimenta o valor mensal do vínculo. Valores numéricos de `V. A.` e `VT` geram movimentos de benefício na competência selecionada; marcações como `X` não são tratadas como valor financeiro.
- Fórmulas quebradas e abas auxiliares não alimentam o cadastro. A planilha contém fórmulas legadas com `#REF!`, `#VALUE!` e `#NAME?`, por isso apenas campos-fonte da aba principal são importados.
- O caminho local do OneDrive não existe na Vercel. Para sincronizar uma atualização, o administrador deve enviar a versão atual do arquivo pelo painel; uma conexão automática futura exigirá Microsoft Graph/SharePoint com credenciais próprias.

## Gate de aceitação

- `npm ci`, `npm run lint`, `npm run db:check`, `npm test`, `npm run build` e `npm audit --omit=dev --audit-level=high` devem passar.
- Login, criação/movimentação de demanda, Inbox, Planner, relatórios, anexos, funcionários, benefícios, fechamento PJ e permissões devem ser testados no Preview.
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
- Configurar `CRON_SECRET` e confirmar uma execução 200 de `/api/cron/sla` nos logs de produção.
- Validar o domínio do remetente no Resend antes de habilitar convites e recuperação por e-mail.
- Definir `FDP_INTEGRATION_ENCRYPTION_KEY` antes de conectar calendários externos.
- Executar `GET /api/health` e confirmar banco conectado após cada publicação.
