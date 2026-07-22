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

## Integrações externas

As telas de integrações guardam apenas o endpoint e a conta. Os tokens devem
ser adicionados nas Environment Variables da Vercel, nunca no formulário:

```text
FDP_EMAIL_TOKEN
FDP_WHATSAPP_TOKEN
FDP_TEAMS_TOKEN
FDP_DRIVE_TOKEN
FDP_ONEDRIVE_TOKEN
FDP_ERP_TOKEN
FDP_MICROSOFT_CLIENT_ID
FDP_MICROSOFT_TENANT_ID
FDP_MICROSOFT_CLIENT_SECRET
FDP_TEAMS_ENDPOINT
FDP_ONEDRIVE_ENDPOINT
FDP_SANKHYA_BASE_URL
FDP_SANKHYA_CLIENT_ID
FDP_SANKHYA_CLIENT_SECRET
FDP_SANKHYA_X_TOKEN
FDP_SANKHYA_REQUEST_BODY
FDP_SANKHYA_METRIC_FIELD_MAP
FDP_EMAIL_WEBHOOK_SECRET
FDP_WHATSAPP_WEBHOOK_SECRET
FDP_TEAMS_WEBHOOK_SECRET
```

O botão **Sincronizar agora** espera que o endpoint configurado devolva JSON no
formato `{ "items": [...] }`. Para entrada por webhook, use
`/api/integrations/webhook/email`, `/api/integrations/webhook/whatsapp` ou
`/api/integrations/webhook/teams`, enviando o segredo no header
`x-fila-dp-secret` e um corpo com `senderName`, `subject` e `body`.

OneDrive e Teams oficiais usam Microsoft Graph/OAuth; WhatsApp usa Cloud API
ou um provedor homologado; e-mail precisa de um relay/webhook (por exemplo,
um provedor transacional). Sem essas credenciais e endpoints, a integração
permanece corretamente como **Aguardando credenciais**.

### Microsoft Teams e OneDrive com as credenciais do aplicativo

Para Teams e OneDrive, o Fila DP troca automaticamente `client_id`, `tenant_id`
e `client_secret` por um token temporario usando o fluxo `client_credentials`.
Nunca coloque o `client_secret` no formulario do sistema ou no codigo-fonte.

1. Na Vercel, adicione `FDP_MICROSOFT_CLIENT_ID`,
   `FDP_MICROSOFT_TENANT_ID` e `FDP_MICROSOFT_CLIENT_SECRET` em **Production**
   (e tambem em **Preview**, se for testar em preview).
2. No Microsoft Entra, em **API permissions**, inclua as permissoes de
   aplicacao necessarias para os recursos escolhidos e clique em **Grant admin
   consent**. A permissao minima varia conforme o endpoint e a politica do
   tenant; o administrador deve validar as permissoes de leitura do Graph antes
   de aprovar.
3. No cartao da integracao, salve o endpoint Graph que deseja consultar. Exemplos:

   - Teams: `https://graph.microsoft.com/v1.0/teams/TEAM_ID/channels/CHANNEL_ID/messages`
   - OneDrive: `https://graph.microsoft.com/v1.0/drives/DRIVE_ID/root/children`

4. Publique um novo deploy e clique em **Sincronizar agora**. A resposta `value`
   do Graph e convertida em itens da Inbox; respostas genericas continuam usando
   o formato `{ "items": [...] }`.

O endpoint precisa ser acessivel pelo servidor e o aplicativo precisa ter acesso
ao time/canal ou drive indicado. Essas credenciais permitem leitura e
sincronizacao para a Inbox; nao habilitam gravacao de mensagens ou arquivos de
volta no Microsoft 365.

### Folha e custo de pessoal via Sankhya

O conector ERP aceita o fluxo OAuth 2.0 do Sankhya. A autenticacao usa
`FDP_SANKHYA_CLIENT_ID`, `FDP_SANKHYA_CLIENT_SECRET` e `FDP_SANKHYA_X_TOKEN`;
o token temporario e gerado pelo servidor em `POST /authenticate`. O Gateway
oficial usa endpoints `https://api.sankhya.com.br/gateway/v1/mge/service.sbr`
ou o ambiente sandbox, conforme a documentacao do cliente.

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

Quando a resposta do Sankhya usar nomes de campos diferentes, configure
`FDP_SANKHYA_METRIC_FIELD_MAP` como JSON, por exemplo:

```json
{"companyId":"CODEMP","period":"PERREF","headcount":"QTDPESSOAS","admissions":"ADMISSOES","terminations":"DESLIGAMENTOS","payrollCost":"VLRFOLHA"}
```

O corpo da chamada Gateway pode ficar em `FDP_SANKHYA_REQUEST_BODY` como segredo
ou na configuracao do conector. A consulta deve retornar os campos da folha
necessarios para o mapeamento.

Planilhas Sankhya devem seguir o layout fornecido pelo proprio ERP (cabecalhos,
ordem e campos obrigatorios). O Fila DP pode receber um CSV normalizado, mas a
importacao XLSX do Sankhya continua dependendo do modelo da tela de destino.

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
