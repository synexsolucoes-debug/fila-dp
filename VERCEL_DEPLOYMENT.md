# Publicacao do Fila DP na Vercel

O runtime de producao e o Next.js nativo. O banco recomendado agora e o Neon
Postgres pelo Marketplace da Vercel; o app mantem uma camada de compatibilidade
D1 para que as rotas existentes continuem funcionando durante a migracao. Os
anexos usam Vercel Blob privado.

## Configuracao com Neon

1. Abra o projeto na Vercel e entre em **Storage**.
2. Escolha **Create Database** e selecione **Neon**.
3. Conecte o banco ao projeto e habilite **Production** e **Preview**.
4. Confirme que `DATABASE_URL` foi criada nas Environment Variables.
5. Crie um Blob privado e confirme `BLOB_READ_WRITE_TOKEN`.
6. Defina `FDP_AUTH_SECRET` com pelo menos 32 bytes aleatorios.
7. Faca um novo deploy. O schema e criado de forma idempotente na primeira
   requisicao autenticada.

O codigo tambem aceita `POSTGRES_URL` ou `NEON_DATABASE_URL`, mas
`DATABASE_URL` e a variavel padrao da integracao da Vercel.

## Variaveis obrigatorias

```text
DATABASE_URL=postgresql://...neon.tech/...
BLOB_READ_WRITE_TOKEN=...
FDP_AUTH_SECRET=...
```

Nao compartilhe esses valores no chat ou no repositorio.

## Dados existentes

A troca do provedor nao copia automaticamente os dados do Turso. O banco Neon
novo inicia vazio e o Fila DP cria suas tabelas no primeiro login. Se precisar
preservar dados, sera necessario exportar o Turso e importar os registros para
o Neon antes de liberar o acesso da equipe.

## Publicacao via CLI

Com a CLI autenticada (`vercel login` ou `VERCEL_TOKEN`):

```bash
vercel link
vercel env add DATABASE_URL production
vercel env add BLOB_READ_WRITE_TOKEN production
vercel env add FDP_AUTH_SECRET production
vercel --prod
```

Para o primeiro uso, prefira conectar o Neon pelo Marketplace: a Vercel
preenche a URL e os demais parametros de conexao sem expor o segredo no shell.
