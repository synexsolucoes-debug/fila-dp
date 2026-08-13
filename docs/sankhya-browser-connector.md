# Sankhya Browser Connector

## Objetivo

O conector consulta o DP Explorer pela interface web do Sankhya, sem API, e sincroniza colaboradores com o Vinculato. Ele é um módulo opcional por workspace. Não existe configuração, credencial, sessão, arquivo, log ou resultado global do Sankhya.

## Arquitetura

```mermaid
flowchart LR
  UI[Next.js / Vercel] --> API[Route Handlers autenticados]
  API --> DB[(PostgreSQL / Neon com RLS)]
  CRON[Vercel Cron] --> DB
  WORKER[Worker RPA containerizado] --> DB
  WORKER --> BROWSER[Playwright: 1 BrowserContext por execução]
  BROWSER --> SANKHYA[Ambiente web Sankhya]
  WORKER --> BLOB[Vercel Blob privado]
```

O Next.js somente valida, configura e enfileira. O cron somente cria jobs agendados. Playwright nunca roda dentro de uma requisição HTTP da Vercel. O worker containerizado usa lease, `FOR UPDATE SKIP LOCKED`, retry limitado e um contexto novo por execução.

O diretório `worker/sankhya` contém o executor compartilhado, o modo persistente e o modo `once`. Em produção, o Vinculato usa `.github/workflows/sankhya-worker.yml`: cada disparo cria um runner efêmero, drena a fila PostgreSQL e encerra. Playwright não roda em requisição Vercel, não depende de processo ocioso e não mantém sessão entre execuções.

O backend dispara o workflow pela API fixa do GitHub, usando um fine-grained PAT limitado ao repositório e à permissão `Actions: write`. O payload contém somente `{ "ref": "main" }`: `workspaceId`, integração, credencial e dados do cliente nunca saem do banco para o GitHub. O runner descobre os jobs com consultas escopadas por tenant.

## Multi-tenancy

- `workspaceId` é obtido da sessão no backend, nunca aceito como autoridade do frontend.
- Todas as tabelas filhas possuem `workspace_id`, FKs compostas e RLS forçado.
- O worker abre uma conexão escopada por workspace antes de reivindicar jobs.
- O lock parcial `fdp_sankhya_active_run_uq` impede dois runs ativos para `(workspace_id, integration_id)`.
- Workspaces distintos podem executar em paralelo até `FDP_SANKHYA_WORKER_CONCURRENCY`.
- Downloads ficam em diretório temporário aleatório criado por execução e removido no `finally`.
- Cookies, `localStorage`, `sessionStorage`, página, contexto e browser são destruídos depois do job, inclusive após falha.

## Feature flag por workspace

O módulo `sankhya_browser` é cadastrado pela migration, mas não faz parte de nenhum plano. A plataforma deve concedê-lo explicitamente em Configuração operacional para cada cliente piloto. Sem `fdp_workspace_module_grants.granted = 1`, o conector não aparece e os endpoints recusam a operação.

## Credenciais

Usuário e senha usam o cofre existente AES-256-GCM, com IV aleatório, tag de autenticação, AAD por canal e versão de chave. A senha nunca é retornada. A API pública devolve somente presença, fingerprint abreviada, versão, data de verificação e dica mascarada do usuário, como `ria********`.

O worker descriptografa a credencial depois de reivindicar o job e apenas para a execução. Logs, auditorias, eventos e erros passam por allowlists e sanitização. Recomenda-se criar no Sankhya um usuário dedicado de consulta, limitado ao DP Explorer e à rotina necessária.

O Sankhya possui cofre exclusivo: `FDP_SANKHYA_VAULT_KEYS` no formato `{"1":"base64","2":"base64"}` e `FDP_SANKHYA_VAULT_KEY_VERSION`. O worker externo nunca recebe a chave global das demais integrações. A versão anterior permanece no keyring enquanto existirem envelopes cifrados com ela.

## Fluxo de execução

1. Usuário com `integrations.execute` inicia teste ou sincronização.
2. Backend resolve o workspace autenticado, valida grant, integração, configuração e credencial.
3. Run e job são criados atomicamente e retornam `202`.
4. Worker reivindica o job e cria browser/contexto/diretório exclusivos.
5. URL e cada navegação HTTPS passam por validação de rede pública e resolução DNS periódica.
6. Worker autentica, detecta CAPTCHA/MFA/bloqueio/senha expirada e abre o DP Explorer.
7. Executa a rotina aguardando estados observáveis, sem delay fixo de negócio.
8. Prioriza XLSX/CSV; valida extensão, assinatura, tamanho e conteúdo. A tabela é fallback limitado.
9. Dados crus são normalizados e validados antes do banco.
10. Colaborador é associado por `externalEmployeeId`, matrícula e, quando necessário, HMAC do CPF.
11. Mudanças são classificadas como nova, alterada, sem alteração ou inválida. Snapshot minimizado não guarda CPF completo.
12. Logs, contagens, auditoria e eventos são persistidos no workspace.
13. `finally` tenta logout, limpa storage/cookies, fecha contexto/browser e remove temporários.

## Estados e retry

Runs: `queued`, `running`, `authenticating`, `navigating`, `processing`, `extracting`, `importing`, `succeeded`, `partial`, `failed`, `requires_user_action` e `canceled`.

Retry só ocorre para falha transitória de rede, indisponibilidade ou timeout, até o máximo configurado (1 a 3). Login inválido, usuário bloqueado, senha expirada, falta de permissão, CAPTCHA, MFA e configuração insegura não são repetidos automaticamente.

## SSRF e navegação

- Configuração aceita somente HTTPS, sem credenciais na URL.
- Por padrão, somente `*.sankhya.com.br` é aceito.
- Hosts adicionais exigem `FDP_SANKHYA_BROWSER_ALLOWED_HOSTS` no web app e no worker.
- `localhost`, `.local`, metadata endpoints, IPs privados, loopback, link-local, CGNAT e faixas reservadas são bloqueados.
- DNS é revalidado durante a sessão; um origin não permanece confiável indefinidamente.
- `file:`, HTTP e protocolos executáveis são bloqueados.

## Seletores e manutenção

Seletores ficam em `lib/sankhya/selectors.ts`. Priorize roles e nomes acessíveis, labels, `aria-label`, texto estável e atributos semânticos. CSS é apenas fallback de login.

Para adicionar uma rotina: crie contrato próprio; adicione seletores centralizados; implemente navegação/extração sem acoplar DOM ao banco; crie normalizador, validação e importador idempotente; emita eventos minimizados; cubra sucesso, layout alterado, arquivo inválido e isolamento no mock.

Erros `SELECTOR_NOT_FOUND`, `DP_EXPLORER_NOT_FOUND` e `UI_CHANGED` são contados como possíveis quebras de layout. Recorrência em vários workspaces indica manutenção do conector, não erro do cliente.

## Diagnósticos e LGPD

Screenshot só é capturado após erro técnico. Campos de senha são mascarados e inputs/células são desfocados. O arquivo fica em Blob privado, com chave contendo workspace/integração/run, limite de 5 MB, retenção de 1 a 168 horas e leitura somente por PlatformAdmin. O worker remove objeto e metadado expirados.

Não são persistidos cookies, storage, senha, CPF completo no snapshot, dados bancários ou conteúdo bruto do download. Arquivos nunca são executados.

## Variáveis de ambiente

Web e worker:

- `DATABASE_URL`
- `FDP_SANKHYA_VAULT_KEYS` ou `FDP_SANKHYA_VAULT_KEY`
- `FDP_SANKHYA_VAULT_KEY_VERSION`
- `FDP_SANKHYA_BROWSER_ALLOWED_HOSTS`
- `BLOB_READ_WRITE_TOKEN`

Somente worker:

- `FDP_SANKHYA_WORKER_POLL_MS` (padrão 5000)
- `FDP_SANKHYA_WORKER_CONCURRENCY` (padrão 3, máximo 10)
- `FDP_SANKHYA_WORKER_MAX_JOBS` (padrão 10 por workspace e varredura)
- `FDP_SANKHYA_WORKER_RETRY_WAIT_MS` (padrão 90000 no modo one-shot)
- `FDP_SANKHYA_WORKER_BUDGET_MS` (padrão 35 minutos no modo one-shot)
- `FDP_SANKHYA_CHROMIUM_SANDBOX` (`true` no runner Linux não-root)
- `PORT` para health check

Somente aplicação Vercel:

- `FDP_SANKHYA_ACTIONS_TOKEN`
- `FDP_SANKHYA_ACTIONS_REPOSITORY` (padrão `synexsolucoes-debug/fila-dp`)
- `FDP_SANKHYA_ACTIONS_WORKFLOW` (padrão `sankhya-worker.yml`)
- `FDP_SANKHYA_ACTIONS_REF` (padrão `main`)

`FDP_SANKHYA_BROWSER_ENDPOINT` pode fixar uma origem adicional operada centralmente.

## Deploy

1. Aplique `0038_sankhya_browser_connector.sql` pelo comando oficial.
2. Faça deploy do Next.js na Vercel.
3. Habilite GitHub Actions e publique `.github/workflows/sankhya-worker.yml` na branch `main`.
4. Configure as mesmas chaves de cofre, banco, HMAC e Blob como Repository secrets do GitHub.
5. Configure o PAT de disparo no ambiente Production da Vercel e confirme o workflow manualmente.
6. Conceda o módulo somente ao workspace piloto.
7. Cadastre URL, empresa, contexto, usuário dedicado e senha.
8. Execute Testar conexão; só depois execute sincronização.
9. Valide no ambiente real os textos/roles do DP Explorer e o arquivo exportado.

### GitHub Actions

1. Em `Settings → Secrets and variables → Actions`, cadastre Repository secrets: `DATABASE_URL`, `FDP_SANKHYA_VAULT_KEYS` (ou `FDP_SANKHYA_VAULT_KEY`), `FDP_SANKHYA_VAULT_KEY_VERSION` e, se usado, `BLOB_READ_WRITE_TOKEN`.
2. Cadastre a Repository variable `FDP_SANKHYA_BROWSER_ALLOWED_HOSTS`; ausente, o workflow usa `*.sankhya.com.br`.
3. Crie um fine-grained PAT com acesso somente a `synexsolucoes-debug/fila-dp` e permissão de repositório `Actions: Read and write`. Não conceda `Contents: write`, administração ou acesso a outros repositórios.
4. Grave o PAT como `FDP_SANKHYA_ACTIONS_TOKEN` apenas no ambiente Production da Vercel; configure também repositório, workflow e ref conforme a lista acima e faça novo deploy.
5. Em `Settings → Billing → Budgets and alerts`, deixe o orçamento de Actions em zero e habilite a interrupção quando o limite for atingido. Repositórios privados no GitHub Free têm 2.000 minutos mensais incluídos.
6. Execute `Worker Sankhya sob demanda` manualmente uma vez. Sem jobs, ele deve concluir com zero processados; depois use `Testar conexão` no Vinculato.

O workflow agendado genérico roda nos minutos 17 e 47, consumindo no máximo aproximadamente 1.440 minutos mínimos por mês. Ele também acorda o RPA com o `GITHUB_TOKEN` efêmero quando o PAT da Vercel estiver indisponível. A franquia é compartilhada com CI e execuções Sankhya; monitore o consumo. Referências: [uso incluído](https://docs.github.com/en/billing/reference/product-usage-included), [dispatch de workflow](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event) e [segredos](https://docs.github.com/en/actions/concepts/security/secrets).

## Testes e mock

`npm run test:sankhya` cobre cofre, máscara, SSRF, moeda brasileira, minimização de CPF, CSV, mock de autenticação, agendamento, RLS/lock e limpeza. `MockSankhyaSession` suporta sucesso, login inválido, MFA, CAPTCHA, timeout, seletor ausente e arquivo inválido.

Antes da produção é obrigatório teste assistido contra o ambiente Sankhya do cliente. O mock comprova nosso contrato; não comprova que a versão de UI instalada pelo cliente usa os mesmos labels, frames e formato de exportação.
