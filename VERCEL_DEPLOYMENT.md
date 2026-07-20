# Migração do Fila DP para a Vercel

O runtime de produção agora é o Next.js nativo. O banco mantém o modelo SQLite/D1, mas usa Turso/libSQL, e os anexos usam Vercel Blob privado. A aplicação continua usando uma pequena camada de compatibilidade D1/R2 para preservar as APIs já implementadas.

## Configuração do projeto

1. Importe este repositório na Vercel e selecione o framework Next.js.
2. Configure as variáveis de [vercel-env.example](./vercel-env.example) em Preview e Production.
3. Crie um banco Turso/libSQL e informe `TURSO_DATABASE_URL` e `TURSO_AUTH_TOKEN`.
4. Crie um Blob store privado e informe `BLOB_READ_WRITE_TOKEN`.
5. Gere `FDP_AUTH_SECRET` com pelo menos 32 bytes aleatórios. Nunca use o valor de exemplo em produção.
6. Execute o primeiro deploy. O schema é criado de forma idempotente na primeira requisição autenticada.

## Dados existentes

A migração do código não copia automaticamente o D1 que estava no Sites. Para preservar os dados atuais, exporte as tabelas do D1 antigo e importe o SQL no banco Turso antes do primeiro uso. Os objetos do R2 precisam ser copiados para o Blob e manter os mesmos `object_key` registrados em `fdp_card_attachments`.

## Publicação via CLI

Com a CLI autenticada (`vercel login` ou `VERCEL_TOKEN`):

```bash
vercel link
vercel env add TURSO_DATABASE_URL production
vercel env add TURSO_AUTH_TOKEN production
vercel env add BLOB_READ_WRITE_TOKEN production
vercel env add FDP_AUTH_SECRET production
vercel --prod
```

O deploy não pode ser concluído sem acesso ao projeto Vercel e sem as credenciais do banco/Blob. Não envie senhas pessoais pelo chat; cadastre os valores diretamente nas Environment Variables da Vercel.
