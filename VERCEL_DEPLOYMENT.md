# Publicacao do Vinculato na Vercel

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
6. Defina `FDP_AUTH_SECRET`, `FDP_PII_HASH_SECRET`, `FDP_INTEGRATION_VAULT_KEY` e `FDP_INTEGRATION_WORKER_SECRET` com valores aleatorios e diferentes. A chave do cofre deve representar exatamente 32 bytes em base64; o segredo do executor deve ter ao menos 32 caracteres.
7. Configure `FDP_APP_URL`, `FDP_PLATFORM_ADMIN_EMAILS` e a integração Stripe. Mantenha `FDP_ALLOW_SELF_SIGNUP=false` até homologar cadastro, cobrança e suporte.
8. Em uma branch/banco Neon dedicado a testes, defina `FDP_PHASE2_TEST_DATABASE_URL`
   e `FDP_ALLOW_EPHEMERAL_SCHEMA_TEST=true` e execute `npm run db:rehearse-phase2`.
   O ensaio cria e remove somente um schema aleatório com prefixo `fdp_phase2_`.
9. Antes do deploy da aplicação, execute `npm run db:migrate` em um job
   controlado. Nunca crie ou altere schema na primeira requisição.

O codigo tambem aceita `POSTGRES_URL` ou `NEON_DATABASE_URL`, mas
`DATABASE_URL` e a variavel padrao da integracao da Vercel.

## Variaveis obrigatorias

```text
DATABASE_URL=postgresql://...neon.tech/...
BLOB_READ_WRITE_TOKEN=...
FDP_AUTH_SECRET=...
FDP_PII_HASH_SECRET=...
FDP_INTEGRATION_VAULT_KEY=...base64-de-32-bytes...
FDP_INTEGRATION_VAULT_KEY_VERSION=1
FDP_INTEGRATION_WORKER_SECRET=...
FDP_ALLOW_SELF_SIGNUP=false
FDP_PLATFORM_ADMIN_EMAILS=operador@example.com
FDP_APP_URL=https://app.example.com
STRIPE_SECRET_KEY=...
STRIPE_WEBHOOK_SECRET=...
```

Nao compartilhe esses valores no chat ou no repositorio.

## SaaS e Stripe

Instale a integração Stripe no Marketplace da Vercel ou configure manualmente `STRIPE_SECRET_KEY` e `STRIPE_WEBHOOK_SECRET`. Cadastre no Stripe os preços recorrentes e depois publique somente os identificadores `price_...` no console `/plataforma`.

Configure o webhook para `POST /api/saas/webhook/stripe` e habilite, no mínimo, `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid` e `invoice.payment_failed`. O endpoint lê o corpo bruto e rejeita qualquer evento cuja assinatura não corresponda ao segredo do ambiente.

O catálogo migra com Gratuito ativo e os planos pagos em rascunho, sem preços comerciais presumidos. Depois da homologação:

1. configure os valores e IDs Stripe no console global;
2. ative os planos desejados;
3. execute um checkout em modo teste;
4. confirme a assinatura e a fatura no ledger local;
5. somente então habilite `FDP_ALLOW_SELF_SIGNUP=true`.

## Dados existentes

A troca do provedor nao copia automaticamente os dados do Turso. Antes de
liberar o acesso da equipe, exporte e valide os registros legados, execute
`npm run db:migrate:baseline` uma única vez no Neon que já contenha tabelas e
depois execute `npm run db:migrate`. Bancos vazios usam apenas `db:migrate`.

## Integrações externas

Endpoints e parâmetros não secretos ficam na configuração do conector. Tokens,
client secrets e chaves entram no diálogo de credenciais e são cifrados no
PostgreSQL com AES-256-GCM; o navegador nunca recebe o valor novamente. A chave
mestra e o segredo do executor ficam exclusivamente nas Environment Variables:

```text
FDP_INTEGRATION_VAULT_KEY
FDP_INTEGRATION_VAULT_KEY_VERSION
FDP_INTEGRATION_VAULT_KEYS
FDP_INTEGRATION_WORKER_SECRET
FDP_INTEGRATION_ALLOWED_HOSTS
FDP_EMAIL_WEBHOOK_SECRET
FDP_WHATSAPP_WEBHOOK_SECRET
FDP_TEAMS_WEBHOOK_SECRET
FDP_EMAIL_WEBHOOK_SECRET_WORKSPACE_ID
FDP_WHATSAPP_WEBHOOK_SECRET_WORKSPACE_ID
FDP_TEAMS_WEBHOOK_SECRET_WORKSPACE_ID
FDP_EMAIL_WEBHOOK_SECRETS
FDP_WHATSAPP_WEBHOOK_SECRETS
FDP_TEAMS_WEBHOOK_SECRETS
```

O botão **Sincronizar agora** cria uma execução idempotente e um job; ele não
chama o provedor dentro da requisição do navegador. Acione
`POST /api/integrations/worker` com `x-fila-dp-worker-secret` e `workspaceId`
por um scheduler protegido. Cada chamada processa no máximo um job, com lease,
backoff exponencial e dead-letter. O endpoint do conector deve devolver JSON no
formato `{ "items": [...] }`, `{ "records": [...] }` ou o formato oficial
normalizado pelo mapeamento ativo. Para entrada por webhook, use
`/api/integrations/webhook/email`, `/api/integrations/webhook/whatsapp` ou
`/api/integrations/webhook/teams`, enviando o segredo no header
`x-fila-dp-secret` e um corpo com `senderName`, `subject` e `body`.

Em uma instalação com vários workspaces, use os segredos por workspace. O valor
é um objeto JSON e deve ser configurado como variável sensível:

```json
{"WORKSPACE_ID_1":"segredo-aleatorio-1","WORKSPACE_ID_2":"segredo-aleatorio-2"}
```

Por exemplo, o mapa do Teams fica em `FDP_TEAMS_WEBHOOK_SECRETS`. O segredo
global antigo continua aceito apenas quando está vinculado explicitamente ao
workspace por `FDP_<CANAL>_WEBHOOK_SECRET_WORKSPACE_ID`. Endpoints de saída só
podem usar domínios oficiais, o mesmo domínio definido em
`FDP_<CANAL>_ENDPOINT`, ou hosts aprovados em
`FDP_INTEGRATION_ALLOWED_HOSTS`.

OneDrive e Teams oficiais usam Microsoft Graph/OAuth; WhatsApp usa Cloud API
ou um provedor homologado; e-mail precisa de um relay/webhook (por exemplo,
um provedor transacional). Sem essas credenciais e endpoints, a integração
permanece corretamente como **Aguardando credenciais**.

### Microsoft Teams e OneDrive com as credenciais do aplicativo

Para Teams e OneDrive, o Vinculato troca `clientId`, `tenantId` e `clientSecret`
por um token temporário usando `client_credentials`. Esses valores são salvos
somente pelo diálogo de credenciais e permanecem cifrados no cofre.

1. Na Central de Integrações, use **Rotacionar credencial** e informe
   `clientId`, `tenantId` e `clientSecret`; depois execute **Verificar conexão**.
2. No Microsoft Entra, em **API permissions**, inclua as permissoes de
   aplicacao necessarias para os recursos escolhidos e clique em **Grant admin
   consent**. A permissao minima varia conforme o endpoint e a politica do
   tenant; o administrador deve validar as permissoes de leitura do Graph antes
   de aprovar.
3. No cartao da integracao, salve o endpoint Graph que deseja consultar. Exemplos:

   - Teams (canal): `https://graph.microsoft.com/v1.0/teams/TEAM_ID/channels/CHANNEL_ID/messages`
   - Teams (chat): `https://graph.microsoft.com/v1.0/chats/CHAT_ID/messages` — exige a permissão de aplicação `ChatMessage.Read.All` (ou `Chat.Read.All`)
   - OneDrive: `https://graph.microsoft.com/v1.0/drives/DRIVE_ID/root/children`

4. Publique um mapeamento, clique em **Sincronizar agora** e deixe o executor
   processar o job. A resposta `value` do Graph passa pelo mapeamento ativo.

O endpoint precisa ser acessivel pelo servidor e o aplicativo precisa ter acesso
ao time/canal ou drive indicado. Essas credenciais permitem leitura e
sincronizacao para a Inbox; nao habilitam gravacao de mensagens ou arquivos de
volta no Microsoft 365.

### Folha e custo de pessoal via Sankhya

O conector ERP aceita token/API key ou os campos `clientId`, `clientSecret` e
`xToken`, armazenados no cofre. O endpoint deve pertencer ao domínio oficial ou
à allowlist operacional. Confirme o endpoint e o contrato na documentação da
conta do cliente antes de ativar o mapeamento.

Para consultar a folha, salve no cartao **ERP / Folha** o endpoint de consulta
e, quando necessario, o corpo JSON da requisicao Sankhya. A resposta normalizada
para custos deve conter:

```json
{
  "metrics": [
    {
      "companyId": "ID_DA_EMPRESA_NO_FILA_DP",
      "period": "2026-07",
      "headcount": 120,
      "admissions": 4,
      "terminations": 2,
      "payrollCost": 385000.50,
      "externalId": "COMP-2026-07"
    }
  ]
}
```

Assim o custo fica vinculado a empresa e alimenta Turnover, custo por periodo
e relatorios gerenciais. A API Sankhya exige permissao do usuario de integracao
para o servico/entidade consultado; nao usamos acesso direto ao banco.

Quando a resposta usar nomes diferentes, crie um mapeamento estruturado e
publique uma nova versão, por exemplo:

```json
{"externalIdField":"ID","fields":[{"source":"CODEMP","target":"companyId","transform":"identity","required":true},{"source":"PERREF","target":"period","transform":"date","required":true}]}
```

Um corpo JSON sem segredos pode ficar na configuração do conector. Tokens,
chaves e senhas são rejeitados nessa configuração e devem permanecer no cofre.

Planilhas Sankhya devem seguir o layout fornecido pelo proprio ERP (cabecalhos,
ordem e campos obrigatorios). O Vinculato pode receber um CSV normalizado, mas a
importacao XLSX do Sankhya continua dependendo do modelo da tela de destino.

## Publicacao via CLI

Com a CLI autenticada (`vercel login` ou `VERCEL_TOKEN`):

```bash
vercel link
vercel env add DATABASE_URL production
vercel env add BLOB_READ_WRITE_TOKEN production
vercel env add FDP_AUTH_SECRET production
vercel env add FDP_INTEGRATION_VAULT_KEY production
vercel env add FDP_INTEGRATION_WORKER_SECRET production
vercel env add FDP_APP_URL production
vercel env add FDP_PLATFORM_ADMIN_EMAILS production
vercel env add STRIPE_SECRET_KEY production
vercel env add STRIPE_WEBHOOK_SECRET production
vercel --prod
```

Para o primeiro uso, prefira conectar o Neon pelo Marketplace: a Vercel
preenche a URL e os demais parametros de conexao sem expor o segredo no shell.
