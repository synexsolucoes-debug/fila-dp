# Vinculato — diagnóstico, correções e checklist de liberação

Data: 2026-08-10
Branch: `claude/fila-dp-saas-transformation-b0morx`

Este documento registra o que foi diagnosticado, o que foi corrigido de fato no
código e o que **permanece pendente**. Ele existe para que a decisão de liberar
ou não o produto seja tomada sobre fatos verificados, não sobre impressão.

## 1. Como o diagnóstico foi feito

A aplicação foi executada de verdade: PostgreSQL 16.13 local, todas as migrations
aplicadas, servidor Next.js rodando e requisições reais contra as rotas.

**Detalhe decisivo:** o ensaio foi refeito com um papel de banco
`NOSUPERUSER NOBYPASSRLS`. Conectado como superusuário, o PostgreSQL **ignora
Row Level Security** e o problema mais grave do produto simplesmente não aparece.
Todo teste de isolamento feito como superusuário passa sem provar nada.

Para conseguir rodar localmente foi preciso adicionar um driver PostgreSQL direto
(`db/local-postgres.ts`), usado só em banco local ou com `FDP_DB_DRIVER=pg`.
Produção continua no Neon por HTTP, sem alteração.

## 2. Causa raiz principal — isolamento de tenant perdido em toda rota

### O que acontecia

`setTenantContext` usa `AsyncLocalStorage.enterWith`. Chamado dentro de uma
função `async`, o contexto vale para o restante daquela função mas **não retorna
para quem a chamou**: a continuação do `await` volta ao contexto anterior.

Como `getWorkspaceContext` é sempre chamada com `await` a partir da rota, toda
consulta feita depois rodava **sem** `set_config('app.workspace_id')`.

76 das 88 tabelas têm RLS. Sem o setting, a política resolve para NULL:

- leitura devolve **zero linhas**, sempre;
- escrita é recusada pela política;
- gravação de auditoria reprovava com `TENANT_CONTEXT_MISMATCH`.

### Medições

| Medição | Antes | Depois |
| --- | --- | --- |
| `GET /api/companies` com 1 empresa cadastrada | `{"companies":[]}` | devolve a empresa |
| `POST /api/operations/competences` | 403 `TENANT_CONTEXT_MISMATCH` | 201 |
| `GET /api/operations/competences?companyId=…` | lista vazia | lista a competência |

Isto explica, de uma vez, boa parte dos sintomas relatados: competências que não
abrem, listas vazias, ações que "não persistem" e o erro genérico
"Não foi possível concluir a operação".

### Correção

A conexão devolvida por `getWorkspaceContext` passou a **carregar o tenant na
própria instância** (`getScopedD1`), enviando `app.workspace_id` na mesma
transação de cada consulta. Não depende mais de propagação assíncrona e não
exigiu reescrever as 120 rotas.

Auditoria e atividade gravam pela mesma conexão. A guarda passou a comparar o
workspace pedido, em vez de reprovar toda gravação quando o contexto assíncrono
está ausente — que era o estado normal dentro de uma rota.

## 3. Demais correções implementadas

| Problema | Causa | Correção |
| --- | --- | --- |
| Abrir competência respondia 405 | A rota `GET /api/operations/competences/[id]` não existia | Rota criada, devolvendo itens de fechamento, movimentações, obrigações, pendências e a **lista nomeada de bloqueadores** do fechamento |
| "Limite de usuários atingido" sem contexto | Mensagem genérica | Passa a dizer o plano, o limite e o uso atual, e sugere a ação. Grupo sem assinatura recebe `SUBSCRIPTION_INACTIVE` |
| Criar workspace pelo console falhava (500) | Contexto de plataforma não define `app.workspace_id`; tabelas do cliente recusam | `getPlatformScopedD1` emite tenant **e** marca de plataforma na mesma transação; nenhuma política foi afrouxada |
| Planos sem preço e três em rascunho | Catálogo nunca publicado | Quatro planos ativos com preço em centavos e histórico de preço versionado |
| Suspender workspace / bloquear usuário | Não havia coluna para isso | `status`, motivo e data em workspaces e usuários, com CHECK exigindo motivo |

### Sobre "Não foi possível concluir a operação"

A mensagem tem duas origens, e só uma era defeito:

1. **Servidor** (`apiErrorResponse`): usada apenas para erro **não previsto**
   (500). Ela já registra o erro real no log com `requestId` e devolve só o
   identificador ao cliente — comportamento correto, que foi mantido.
2. **Cliente**: fallback quando a resposta não traz `error` nem `message`.

O que a produzia em massa era a causa raiz da seção 2: as rotas quebravam com
violação de RLS, viravam 500 e caíam no texto genérico. Corrigida a causa, os
erros legítimos voltam a chegar com código e texto próprios (`COMPETENCE_BLOCKED`,
`PLAN_SEAT_LIMIT`, `WORKSPACE_SUSPENDED`, `USER_BLOCKED`, `COMPETENCE_CONFLICT`).

## 4. Renomeação e identidade

- 46 arquivos: todo texto de interface, metadata, Open Graph e documentação
  passam a dizer **Vinculato**. Zero ocorrências do nome antigo em `.ts/.tsx/.css`.
- **Preservados de propósito**: tabelas `fdp_*`, variáveis `FDP_*`, o cabeçalho
  `x-fila-dp-request-id` e os módulos `lib/fila-dp-*.ts`. Renomeá-los quebraria
  bancos e integrações já instalados.
- Paleta da marca em tokens (`--vin-*`) e tokens semânticos (`--brand`,
  `--ui-surface`, `--ui-text`…) em bloco único.
- `VinculatoMark` e `VinculatoLogo` desenhados sobre os tokens.

Os **arquivos oficiais** da marca substituíram o desenho provisório. Eles vivem
em `public/brand/` e passaram por três tratamentos necessários para uso em tela:

1. **recorte** da margem branca do arquivo original;
2. **remoção do fundo branco** desfazendo a mistura com o fundo (em vez de
   recortar por limiar), o que evita a franja clara nas bordas suavizadas — sem
   isso a marca virava uma etiqueta branca sobre o painel escuro do login;
3. **variante clara** do logotipo, com o azul-marinho convertido em branco: o
   logotipo original é ilegível sobre fundo escuro.

Favicon e ícone de aplicativo são gerados do símbolo oficial, com transparência.

As cores dos tokens foram **extraídas dos pixels** do símbolo — `#062B60` e
`#168CFD` —, não estimadas a olho.

## 5. Planos publicados

| Plano | Preço | Assentos | Situação |
| --- | --- | --- | --- |
| Starter | R$ 0 | 3 | ativo |
| Standard | R$ 97/mês | 10 | ativo |
| Premium | R$ 297/mês | 30 | ativo |
| Enterprise | R$ 797/mês | 100 | ativo |

Preços em centavos, nunca em ponto flutuante. Alterar preço cria **nova versão**
(`fdp_saas_plan_prices`, append-only por trigger); a assinatura guarda em qual
versão foi contratada, então mexer na tabela não altera contratos antigos.

Plano pago pode ficar ativo sem preço no provedor: nesse caso é vendido por
contato comercial e o checkout aparece indisponível — em vez de o plano sumir
do site.

## 6. Validação executada

- `npm run lint`: aprovado.
- `npm test`: **196 testes**, 0 falhas.
- `npm run db:check`: 27 migrations validadas.
- `npm run build`: build de produção aprovado.
- `npm run db:rehearse`: PostgreSQL 16 real, papel sem superusuário — constraints
  de pagamento, regra do §22 do ponto, outbox/webhooks/API e isolamento
  multi-tenant aprovados.
- `npm run browser-check`: **30 verificações em Chromium real** — site público,
  login pela interface, console global, criação de workspace **pela tela**, aba
  de usuários sem material de senha, ausência de erro de JavaScript e ausência
  de rolagem horizontal em **390, 768, 1280 e 1440 px** — e a prova de que o
  menu do painel reflete o plano: no Starter aparecem 5 módulos e os 8 restantes
  vêm marcados `not_in_plan`.
- `npm run smoke`: **35 verificações HTTP** contra a aplicação em execução,
  incluindo cadastro, empresa, ciclo completo de competência (criar, listar,
  abrir, avançar, fechar, reabrir com justificativa), colaborador, central de
  ação, busca, separação plataforma/workspace, isolamento entre dois workspaces
  e o bloco de administração da plataforma.

Um teste que afirmava textualmente o mecanismo quebrado (`setTenantContext(...)`)
foi **reescrito**, não removido: ele agora exige a garantia real. Esse teste é a
prova de que asserção sobre texto-fonte não substitui execução.

## 7. O que NÃO foi feito

Estes itens do pedido continuam pendentes. Nenhum deles foi simulado.

### Não implementado

1. **RBAC granular e funções personalizadas.** O produto continua com quatro
   papéis fixos (`admin`, `member`, `observer`, `guest`) e ~70 capabilities
   mapeadas por papel. Não há criação de função pelo assinante, nem matriz de
   permissões por módulo/ação, nem cópia de permissões entre usuários.
3. **Tela de usuários e permissões do workspace.** Convite, suspensão,
   reenvio/cancelamento de convite, limite por empresa e permissões efetivas não
   têm interface; parte existe só via API.
5. **Site público reconstruído.** As páginas existentes foram renomeadas, mas o
   hero, as seções e o layout pedidos não foram refeitos.
6. **Redesign integral.** Os tokens de identidade existem; a aplicação das telas
   ao novo sistema visual não foi feita.
7. **Onboarding em etapas.** O registro de onboarding existe no banco; o fluxo
   guiado não.
8. **Navegação reorganizada** nos grupos pedidos (Operação, Folha e competências,
   Pessoas, Gestão).

### Bloqueios externos

10. **Cobrança**: sem `STRIPE_SECRET_KEY` real não há checkout homologado.
    `GET /api/platform/billing-readiness` responde exatamente o que falta.
11. **E-mail**: não há provedor de envio, então convite e recuperação de acesso
    dependem de link gerado manualmente.
12. **Anexos**: sem `BLOB_READ_WRITE_TOKEN`, upload e recuperação não foram
    exercitados.

## 8. Riscos conhecidos

- **A correção da seção 2 foi validada contra PostgreSQL local com RLS ativo.**
  Ela precisa ser reexecutada contra o Neon antes da liberação — o driver é
  outro, ainda que a semântica de `set_config` seja a mesma.
- O `browser-check` cobre o console global e o site público. Os fluxos do
  workspace (competência, ponto, pagamentos) continuam validados só por HTTP.
- Não houve auditoria de acessibilidade (contraste, leitor de tela, navegação
  por teclado ponta a ponta) — só a checagem de rolagem horizontal.
- A allowlist de administradores da plataforma continua em variável de ambiente,
  exigindo redeploy para mudar quem tem acesso global, e sem segundo fator.

## 9. Checklist de liberação

| # | Critério | Resultado |
| --- | --- | --- |
| 1 | Sistema renomeado para Vinculato | APROVADO |
| 2 | Identidade visual aplicada | PARCIAL — tokens e marca prontos; telas não redesenhadas |
| 3 | Site público reconstruído | **BLOQUEADO** |
| 4 | Cadastro Starter funciona | APROVADO |
| 5 | Painel global separado do workspace | APROVADO |
| 6 | Administrador global cria e administra workspaces | APROVADO — API e interface, verificado em navegador |
| 7 | Assinante administra seu workspace | PARCIAL |
| 8 | Área de usuários e permissões completa | **BLOQUEADO** |
| 9 | Liberação por módulo | APROVADO — catálogo global, inclusão por plano, liberação/revogação especial e menu filtrado, verificado em navegador |
| 10 | Permissões validadas no servidor | APROVADO |
| 11 | Limite de assentos funciona | APROVADO |
| 12 | Quatro planos cadastrados | APROVADO |
| 13 | Competências abrem corretamente | APROVADO |
| 14 | Mensagens genéricas com causa corrigida | APROVADO |
| 15 | Sem vazamento entre workspaces | APROVADO (verificado sob RLS com papel sem superusuário) |
| 16 | Sem botões falsos ou rotas quebradas | PARCIAL — as rotas do console têm interface; demais módulos não auditados um a um |
| 17 | Interface responsiva e acessível | PARCIAL — console e site sem rolagem horizontal em 390/768/1280/1440; auditoria de acessibilidade não feita |
| 18 | Migrations preservam dados | APROVADO — 0022 e 0023 são aditivas |
| 19 | Lint, testes, tipos e build passam | APROVADO |
| 20 | Fluxos críticos validados no navegador | PARCIAL — login, console global e criação de workspace validados em Chromium; fluxos do workspace só por HTTP |

## 10. Veredito

**BLOQUEADO para liberação a clientes pagantes.**

O que impedia o produto de funcionar foi corrigido: o isolamento de tenant, as
competências e a administração da plataforma. Um cliente hoje consegue se
cadastrar, criar empresa, abrir e fechar competência, e não enxerga dados de
outro cliente — isso está verificado, não presumido.

O que ainda impede a venda é diferente em natureza: falta **superfície de
produto** (permissões granulares, liberação por módulo, tela de usuários, site
público, redesign) e falta **homologação de cobrança e e-mail**, que dependem de
credenciais externas.

Recomendação de sequência: (1) tela de usuários e permissões do workspace;
(2) catálogo de módulos com liberação por plano; (3) site público e redesign;
(4) homologação de cobrança e provedor de e-mail.

## 11. Liberação de módulos (§8)

A ordem é fixa e cada etapa recusa com motivo próprio:

1. módulo ativo no catálogo global (`fdp_modules`);
2. workspace e assinatura ativos;
3. módulo incluído no plano **ou** com liberação especial (`fdp_workspace_module_grants`);
4. plataforma não revogou o módulo para aquele workspace;
5. dependência declarada liberada;
6. papel do usuário com a capability do módulo.

O administrador do workspace **nunca** libera um módulo fora do plano: a etapa 3
acontece antes da 6, e ele não controla nenhuma das duas primeiras.

Módulos bloqueados continuam na resposta com o motivo — `not_in_plan` (pede
upgrade) é diferente de `missing_capability` (pede acesso ao administrador do
grupo). Esconder sem explicar é o que faz o cliente achar que o produto quebrou.

Escada de planos semeada: Starter 5 módulos, Standard 8, Premium 11,
Enterprise 13 (catálogo inteiro).

## 12. Achados do ensaio de navegador

Dois defeitos que só apareceram olhando a tela renderizada:

A renomeação textual não pegou a marca **partida entre elementos**
(`<span>Fila <strong>DP</strong></span>`), presente no cabeçalho do site, do
painel, do login e da recuperação de acesso. Só apareceu quando o texto foi lido
do DOM renderizado, no navegador — busca por texto-fonte não encontraria.
Corrigido nos cinco arquivos, e o teste de renomeação passou a cobrir também o
padrão partido.

**Sobreposição no login.** O cartão de acesso era centralizado por
`justify-content: center` e passava por cima do link "Voltar para o site" em
**1280×800** — altura comum de notebook. A centralização passou a ser por margem
automática, que zera quando falta espaço em vez de transbordar para cima. O
`browser-check` mede a colisão em cinco proporções e reprova se ela voltar.

## 13. Página inicial reconstruída (§21)

O relato do cliente foi direto: *"a página inicial só mudou a logo"*. Estava
certo. A home continuava sendo a página do posicionamento anterior — título
"Toda demanda do DP na fila certa.", herói centrado em quadro kanban, tabela
comparativa contra "kanban genérico", FAQ duplicada em texto fixo — com o
logotipo novo por cima. Trocar a marca não é reposicionar o produto.

**O que a página passou a ser.** Herói com o posicionamento atual ("Sua
operação, conectada."), problema que o produto resolve, fluxo real do trabalho
(demanda → competência → conferência → fechamento), recursos entregues,
fronteiras declaradas, integrações com estado real, segurança e rastreabilidade,
planos, perguntas frequentes e chamada final.

**Conteúdo com fonte única.** Recursos, fronteiras, integrações, FAQ e navegação
vêm de `lib/marketing.ts` — os mesmos objetos que as outras páginas comerciais
consomem. A home não pode mais divergir do resto do site por esquecimento.

**Planos lidos do catálogo.** A seção de planos consulta `fdp_saas_plans` na
renderização. Nenhum preço, nome ou limite está escrito no código da página: o
valor exibido é o `monthly_price_cents` persistido, convertido na hora. O
`browser-check` compara o que a página mostra com o que `GET /api/site/plans`
devolve e reprova qualquer divergência.

**Preço publicado e contratação são coisas diferentes.** A regra anterior
escondia o preço quando faltava configuração no provedor de pagamento, e um
plano de R$ 97 aparecia como "sob consulta" — subentregando o catálogo. Agora o
preço publicado é sempre exibido, e o que depende do provedor é o botão: sem
preço configurado lá, o plano existe com o valor à vista e a contratação é
assistida pela equipe. Nenhuma tela simula checkout inexistente.

**Oferta grátis condicionada a duas verdades.** "Começar grátis" só aparece se
existir plano de preço zero ativo no catálogo **e** o autocadastro estiver
habilitado. O destino (`/login?modo=criar`) abre o formulário de criação apenas
quando o próprio servidor confirma que a criação pública está ligada.

**Identidade aplicada, não só o logotipo.** O site inteiro ainda usava a paleta
verde-menta anterior. As cores passaram a ser consumidas por tokens: a home, as
páginas comerciais (`site.module.css`) e as telas de acesso (`access.css`) leem
`--brand*`, `--ui-*` e `--on-brand-*`. Também saíram do CSS global três seletores
de elemento (`footer`, `table`, `th/td`) que vazavam para todas as páginas — o
`min-width: 860px` em `table` era risco de rolagem horizontal em telas estreitas.

**Sem prova social inventada.** A página não publica cliente, depoimento,
número, certificação nem integração inexistente; o `browser-check` procura por
esses padrões no texto renderizado e reprova se aparecerem.

Validação desta fatia: `lint` limpo, 198 testes, 41 verificações de navegador
(390/768/1280/1440, sem rolagem horizontal e sem erro de console), 23
verificações de fumaça e 7 de isolamento, todas pelo driver que a aplicação usa
em produção.

## 14. "Não foi possível concluir a operação." — a falha que não dizia nada

O cliente relatou a tela: **"Não foi possível abrir o Vinculato. / Não foi
possível concluir a operação. / Tentar novamente"**.

**Reproduzido antes de corrigir.** Simulei um banco atrás da versão do
aplicativo — apaguei o registro da migração 0024 e o objeto que ela cria — e
carreguei o painel pelo navegador. A tela saiu palavra por palavra igual à
relatada, com `GET /api/workspace` respondendo `500 INTERNAL_ERROR`.

**Causa.** Toda falha não prevista caía no mesmo caminho genérico. Isso é
correto para um defeito de programação — não vaza SQL nem stack trace —, mas
estava sendo usado também para falhas **operacionais**: banco atrás da versão,
banco inacessível, papel da aplicação sem privilégio. Nesses casos a frase
genérica esconde justamente a informação que resolveria o problema. O cliente
não sabe que não é culpa dele; quem opera não sabe o que corrigir.

**Correções.**

1. `lib/infrastructure-errors.ts` classifica a falha pelo estado do PostgreSQL:
   `SCHEMA_OUTDATED` (42P01, 42703, 42883, 42704, 3F000),
   `DATABASE_PERMISSION_DENIED` (42501) e `DATABASE_UNAVAILABLE` (classe 08,
   57Pxx, 53300, 28xxx, falha de rede). Cada uma responde **503** com uma
   mensagem que diz o que aconteceu e o que resolve — sem nome de tabela, sem
   comando, sem credencial. Defeito inesperado continua no caminho genérico.
2. A tela do painel deixou de descartar o `code` e o `requestId` que a resposta
   já trazia. Agora mostra "Informe ao suporte: código … · chamado …", e uma
   falha de infraestrutura é apresentada como indisponibilidade da plataforma,
   não como problema da conta do cliente.
3. `GET /api/health` responde a pergunta que antes só o log do servidor
   respondia: schema aplicado, acessível, e quantas migrações faltam. O nome das
   migrações pendentes só aparece para quem administra a plataforma.
4. `lib/schema-manifest.ts` é gerado (`npm run schema:manifest`) porque em
   produção não existe diretório de migrations para ler em execução. Um teste
   reprova se o manifesto divergir de `drizzle/postgres`.
5. O ensaio de fumaça passou a checar prontidão **na primeira linha** e a parar
   ali quando o deployment não está pronto — em vez de acumular falhas cuja
   causa real ficaria escondida no meio da saída.

**Um achado do próprio ensaio.** Depois de reaplicar a migração, o painel voltou
a falhar — agora com `42501, permission denied`. Os objetos recriados não tinham
privilégio para o papel da aplicação. O relatório de prontidão dizia "ok",
porque só contava migrações. Foi por isso que a verificação passou a **sondar
leitura** em tabelas centrais com `LIMIT 0`: histórico completo não prova que o
aplicativo consegue ler o que foi criado.

**Se a tela aparecer em produção**, o caminho agora é direto:

```
GET /api/health          → diz se o banco está atrás, inacessível ou sem permissão
npm run db:migrate       → aplica as migrações pendentes (DATABASE_URL do ambiente)
```
