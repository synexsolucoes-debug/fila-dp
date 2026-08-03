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
7. Antes do deploy, aponte `DATABASE_URL` para uma copia/branch do Neon e rode
   `npm run db:migrate`.
8. Valide o Preview, crie um ponto de recuperacao no Neon, rode a mesma
   migration em producao e somente entao promova o deploy. As rotas HTTP nunca
   criam ou alteram tabelas.

O codigo tambem aceita `POSTGRES_URL` ou `NEON_DATABASE_URL`, mas
`DATABASE_URL` e a variavel padrao da integracao da Vercel.

## Variaveis obrigatorias

```text
DATABASE_URL=postgresql://...neon.tech/...
BLOB_READ_WRITE_TOKEN=...
FDP_AUTH_SECRET=...
CRON_SECRET=...
FDP_INTEGRATION_ENCRYPTION_KEY=...
FDP_PUBLIC_URL=https://fila-dp.vercel.app
```

Nao compartilhe esses valores no chat ou no repositorio.

## E-mail, SLA e recuperação de acesso

Conecte o Resend pelo Marketplace da Vercel ou defina `RESEND_API_KEY` e
`FDP_EMAIL_FROM`. O domínio do remetente deve estar validado no Resend. Com isso,
convites, recuperação de senha e alertas de SLA são enviados automaticamente;
sem a chave, o administrador ainda recebe o link para compartilhamento manual.

O cron `/api/cron/sla` é protegido por `CRON_SECRET` e está configurado em
`vercel.json` para executar diariamente às 11:00 UTC. Em planos que permitem
maior frequência, o agendamento pode ser alterado para horário ou a cada poucos
minutos. O processamento persiste o estado, gera níveis de escalonamento e usa
chaves idempotentes para evitar alertas duplicados.

## Calendários Google e Microsoft

Defina `FDP_INTEGRATION_ENCRYPTION_KEY` e as credenciais do provedor:

```text
FDP_GOOGLE_CALENDAR_CLIENT_ID
FDP_GOOGLE_CALENDAR_CLIENT_SECRET
FDP_MICROSOFT_CALENDAR_CLIENT_ID
FDP_MICROSOFT_CALENDAR_CLIENT_SECRET
FDP_MICROSOFT_TENANT_ID
```

Cadastre nos provedores as URLs de retorno
`https://SEU-DOMINIO/api/calendar/oauth/google/callback` e
`https://SEU-DOMINIO/api/calendar/oauth/microsoft/callback`. Os tokens são
criptografados antes de serem persistidos. Cada usuário conecta sua própria
agenda pelo Planner e pode sincronizar os blocos de tempo sem compartilhar
tokens no navegador.

## WhatsApp Cloud API

Além do webhook simplificado, a rota do WhatsApp aceita diretamente o payload
assinado da Meta. Configure `FDP_WHATSAPP_VERIFY_TOKEN` e
`FDP_WHATSAPP_APP_SECRET`; use como callback
`/api/integrations/webhook/whatsapp?workspaceId=WORKSPACE_ID`. No cadastro da
integração, o campo **Conta / origem** deve conter o `phone_number_id` da Meta,
impedindo que uma mensagem assinada seja vinculada ao grupo errado.

## Antivírus de anexos

Opcionalmente configure `FDP_ANTIVIRUS_ENDPOINT` e `FDP_ANTIVIRUS_TOKEN`. O
serviço deve aceitar os bytes do arquivo e responder JSON com `{"clean":true}`.
Para bloquear qualquer upload quando o scanner estiver indisponível, defina
`FDP_REQUIRE_ANTIVIRUS=true`.

## Dados existentes

A troca do provedor nao copia automaticamente os dados do Turso. O banco Neon
novo inicia vazio e precisa receber `npm run db:migrate` antes do primeiro
acesso. Se precisar preservar dados, sera necessario exportar o Turso e importar
os registros para o Neon antes de liberar o acesso da equipe.

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
FDP_INTEGRATION_ALLOWED_HOSTS
FDP_EMAIL_WEBHOOK_SECRET
FDP_WHATSAPP_WEBHOOK_SECRET
FDP_TEAMS_WEBHOOK_SECRET
FDP_EMAIL_WEBHOOK_SECRETS
FDP_WHATSAPP_WEBHOOK_SECRETS
FDP_TEAMS_WEBHOOK_SECRETS
```

O botão **Sincronizar agora** espera que o endpoint configurado devolva JSON no
formato `{ "items": [...] }`. Para entrada por webhook, use
`/api/integrations/webhook/email`, `/api/integrations/webhook/whatsapp` ou
`/api/integrations/webhook/teams`, enviando o segredo no header
`x-fila-dp-secret` e um corpo com `senderName`, `subject` e `body`.

Em uma instalação com vários workspaces, use os segredos por workspace. O valor
é um objeto JSON e deve ser configurado como variável sensível:

```json
{"WORKSPACE_ID_1":"segredo-aleatorio-1","WORKSPACE_ID_2":"segredo-aleatorio-2"}
```

Por exemplo, o mapa do Teams fica em `FDP_TEAMS_WEBHOOK_SECRETS`. O segredo
global antigo continua aceito apenas quando existe um único workspace ativo no
canal, para não interromper integrações já publicadas. Endpoints de saída só
podem usar domínios oficiais, o mesmo domínio definido em
`FDP_<CANAL>_ENDPOINT`, ou hosts aprovados em
`FDP_INTEGRATION_ALLOWED_HOSTS`.

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

   - Teams (canal): `https://graph.microsoft.com/v1.0/teams/TEAM_ID/channels/CHANNEL_ID/messages`
   - Teams (chat): `https://graph.microsoft.com/v1.0/chats/CHAT_ID/messages` — exige a permissão de aplicação `ChatMessage.Read.All` (ou `Chat.Read.All`)
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
      "headcountStart": 118,
      "headcountEnd": 120,
      "leavesCount": 3,
      "admissions": 4,
      "terminations": 2,
      "voluntaryTerminations": 1,
      "involuntaryTerminations": 1,
      "baseSalary": 250000,
      "variablePay": 18000,
      "overtimePay": 12000,
      "additionalPay": 8000,
      "vacationPay": 16000,
      "terminationPay": 14000,
      "employeeInss": 24000,
      "employeeIrrf": 16000,
      "employerInss": 52000,
      "ratContribution": 7000,
      "thirdPartyContributions": 14000,
      "fgts": 23000,
      "benefitsCost": 36000,
      "provisionsCost": 28000,
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
{"companyId":"CODEMP","period":"PERREF","headcountStart":"QTDPESSOASINICIO","headcountEnd":"QTDPESSOASFIM","leavesCount":"QTDAFASTADOS","admissions":"ADMISSOES","terminations":"DESLIGAMENTOS","baseSalary":"VLRBASE","grossPayroll":"VLRFOLHABRUTA","employerInss":"VLRINSSPATRONAL","fgts":"VLRFGTS","benefitsCost":"VLRBENEFICIOS","provisionsCost":"VLRPROVISOES","payrollCost":"CUSTOFOLHA"}
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
