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

## 15. Usuários e permissões (critério 8)

Administrar acesso estava espremido numa aba do modal de configurações: dava
para trocar o papel e marcar empresas, mas não para **revisar acesso**. Faltava
o que a pergunta "quem ainda precisa disso?" exige — quantos assentos o plano
concede, quantos estão em uso, quem nunca entrou, quem está com ativação
pendente — e, principalmente, faltava dizer o que cada papel permite.

**Tela própria.** `Usuários e permissões` virou uma visão do painel, liberada
pelo catálogo de módulos (migração 0025) em **todos os planos**, inclusive o
Starter: administrar o próprio grupo não é recurso pago. O que varia por plano é
o limite de assentos, aplicado na criação.

**Revisão de acesso.** A tela abre com o consumo de assentos (`2 / 3 · Plano
Starter`), quantas pessoas nunca acessaram e quantas seguem sem ativar. A lista
mostra papel, escopo por empresa e último acesso real, lido das sessões — não um
campo decorativo.

**Matriz de permissões.** As 62 capacidades do sistema aparecem traduzidas para
linguagem de cliente, agrupadas por área, com uma coluna por papel. A matriz é
gerada a partir de `capabilitiesForRole`, a mesma função que a autorização usa:
se a permissão mudar no código, a tela muda junto — não existe descrição
paralela para desatualizar.

**Um achado ao escrever o teste.** Eu havia assumido que os papéis formavam uma
escada (admin ⊃ member ⊃ observer ⊃ guest). O teste reprovou: **convidado não é
um observador reduzido**. Ele enxerga menos, mas *pode comentar*; observador é
consulta pura. O produto está certo e minha suposição estava errada — o teste
passou a fixar a relação real, e os resumos na tela dizem isso com todas as
letras, porque confundir os dois levaria o administrador a liberar escrita
achando que libera leitura.

**Senha continua fora.** A tela cria a pessoa e entrega um link único de
ativação com validade e uso único. Nenhuma senha é gerada, exibida ou enviada
por aqui, e há teste que reprova se o hash aparecer na resposta ou na interface.

**Identidade aplicada ao painel.** Ao revisar a tela ficou evidente que o painel
inteiro ainda usava a paleta verde-teal anterior. A causa era um segundo bloco
de tokens `.dashboard-shell`, mais abaixo no arquivo, que sobrescrevia o
primeiro — trocar o de cima não mudava nada na tela. Os dois passaram a consumir
os tokens da marca, e os verdes remanescentes de `access.css` viraram
`color-mix` sobre `--brand-accent`.

**Uma rolagem horizontal que o olho não via.** A matriz cabia num contêiner com
`overflow-x: auto`, e visualmente estava tudo certo — mas o documento crescia
138px em 390px de largura. A correção não foi espremer a tabela: em tela
estreita a matriz passa a ser uma lista, com os quatro papéis como etiquetas por
permissão. Mais legível no celular e sem rolagem lateral.

Validação: 214 testes, 50 verificações de navegador (incluindo criar usuário
pela interface e as quatro larguras), 24 de fumaça e 7 de isolamento — estas
últimas com o papel `vinculato_app`, **sem** superusuário, para que o RLS
realmente valesse durante o ensaio.

## 16. Bloqueio por workspace arquivado e "Entrar em outra conta"

Dois defeitos reproduzidos no navegador antes de qualquer alteração.

### Causa raiz 1 — arquivar um grupo trancava o usuário para fora de todos

`getWorkspaceContext` resolvia o contexto em três passos: lia a *preferência*
do usuário (`active_workspace_id`) **sem olhar o ciclo de vida do workspace**;
só caía para outra associação quando a preferência não existia; e então, se o
workspace resolvido não estivesse ativo, lançava `WORKSPACE_SUSPENDED`.

O resultado: com o grupo preferido arquivado, o primeiro passo achava o grupo
parado, o fallback nunca rodava, e a requisição inteira era recusada — mesmo com
associação ativa em outro grupo. Reprodução: usuário em A (arquivado, preferido)
e B (ativo) recebia *"Não foi possível abrir o Vinculato — Este grupo está
arquivado"* e `GET /api/workspace → 403`.

**Correção.** `lib/workspace-access.ts` passa a ser o cálculo único de
workspaces acessíveis, usado pela resolução de contexto e pelo seletor:

1. a preferência só vale se o workspace continuar associado **e** operacional;
2. caindo fora, escolhe o melhor candidato operacional de forma determinística
   (proprietário primeiro, depois associação mais antiga) e anuncia a troca em
   `switchedFrom`, para a interface não mudar o contexto em silêncio;
3. sem nenhum operacional, devolve `NO_ACTIVE_WORKSPACE` **com a lista dos
   grupos e o estado de cada um**, em vez de uma recusa genérica.

Só `active` é contexto operacional; suspenso, cancelado e arquivado não operam.
Arquivar um grupo deixou de ter qualquer efeito sobre as outras associações.

Verificado no navegador: o mesmo usuário que antes via a tela de erro agora
entra direto no grupo ativo, com `GET /api/workspace → 200`.

O snapshot passou a expor `availableWorkspaces` com status, motivo e papel — a
lista sai do serviço central, e a consulta paralela que existia só para isso foi
removida (uma ida ao banco a menos por carregamento do painel).

### Causa raiz 2 — a troca de conta era um link GET para uma rota só-POST

Na tela de login, "Entrar com outra conta" era
`<a href="/api/auth/logout?return_to=/">`. A rota exportava apenas `POST`.
O navegador recebia **HTTP 405**, a sessão nunca era encerrada e o usuário
voltava para a mesma conta — exatamente o sintoma relatado.

**Correção, e por que não foi só adicionar um GET.** A primeira versão desta
correção adicionou `export async function GET`. Um teste existente reprovou, com
razão: logout por GET é disparado por prefetch, por `<img src=…>` ou por
qualquer scanner de link, derrubando a sessão sem o usuário pedir. A solução
final mantém a proibição e resolve por **formulário POST**:

- o painel e a tela de login enviam `POST /api/auth/logout` com `trocar=1`;
- envio de formulário recebe **303** e o navegador segue sozinho; o `fetch` do
  botão "Sair" continua recebendo JSON;
- o destino da troca é a constante `/login?trocar=1` — não passa pelo
  `return_to` do usuário, então não vira redirecionamento aberto;
- com `trocar=1`, a tela de login não oferece "continuar" com a identidade
  encerrada: mostra o formulário vazio.

"Sair" e "Entrar em outra conta" viraram dois comandos distintos e visíveis no
rodapé da barra lateral.

Verificado no navegador, em sequência: sessão ativa (200) → troca → destino
`/login?trocar=1`, sessão encerrada (401), formulário vazio, sem oferta de
continuar → autenticação de uma segunda identidade concluída com sucesso.

### Um caso-limite que a correção tornou visível

Ao entrar com uma conta cujo único grupo estava arquivado, a resposta passou a
ser: *"Nenhum dos seus grupos está operando no momento: Synex (arquivado)."* —
em vez da recusa genérica anterior. Nega o acesso do mesmo jeito, mas diz qual
grupo e em que estado.

## 17. Console da plataforma: administrar de verdade

**Causa raiz.** A API já fazia mais do que a interface deixava fazer.
`PATCH /api/platform/workspaces/[id]` sempre soube trocar plano e assentos,
transferir propriedade e mudar situação — com validação de downgrade, exigência
de motivo e auditoria. `PATCH /api/platform/users/[id]` já bloqueava (derrubando
sessões e protegendo proprietários) e vinculava/desvinculava de workspaces. O
console expunha apenas suspender, arquivar, bloquear e criar workspace. A queixa
"só dá para arquivar" era da interface, não do backend.

**O que faltava mesmo no backend:** abrir um cliente ou uma identidade. Não
existia rota de detalhe, então não havia como ver membros, empresas, módulos,
assinatura ou histórico antes de decidir.

**Entregue.**

- `GET /api/platform/workspaces/[id]/detail` — ficha, assinatura, plano e
  limites, membros com último acesso, empresas, módulos (no plano × liberação
  manual) e os últimos 50 eventos de auditoria do workspace. Não devolve dado
  operacional do cliente: administrar contrato não é motivo para ler demandas,
  documentos ou competências alheias.
- `GET /api/platform/users/[id]/detail` — identidade global **separada** de cada
  associação de workspace, com sessões ativas e histórico administrativo. A
  sessão aparece sem token e sem endereço completo: dá para revogar sem expor o
  que identificaria o dispositivo.
- `PATCH /api/platform/users/[id]` ganhou editar nome e revogar sessão (uma ou
  todas). O **e-mail continua não editável**: é a chave de login e de convite, e
  trocá-lo sem fluxo de verificação deixaria a pessoa sem acesso e sem aviso.
- Console: botão "Abrir" nas duas tabelas e dois drawers. No workspace, abas de
  visão geral, membros, empresas, módulos e auditoria, com troca de plano e as
  transições de ciclo de vida exigindo motivo. No usuário, papel por associação
  (alterar em um grupo não toca nos outros), vincular/desvincular, revogar
  sessões e bloquear/desbloquear.

**Um defeito encontrado pelo próprio ensaio.** A primeira versão da rota de
detalhe consultava `s.current_period_end`; a coluna real é
`current_period_ends_at`. O erro apareceu como **503 `SCHEMA_OUTDATED`** no
console do navegador — a classificação de falhas de infraestrutura entregue
antes fez o defeito se identificar sozinho, em vez de virar tela vazia.

Validação: 225 testes, 50 verificações de navegador, 24 de fumaça, `npm run ci`
completo. O detalhe foi percorrido no Chromium: ficha com proprietário, plano,
assentos, empresas e valor contratado; as quatro abas com conteúdo; edição de
nome, vínculo e revogação de sessão disponíveis; nenhum hash de senha na tela;
zero rolagem horizontal em 390/768/1280/1440 e nenhum erro de console.

## 18. PJ → Caju: o que dá para fazer sem o modelo oficial

**O cálculo já estava certo.** `calculateContractorClosing` (lib/payments.ts)
resolve, nesta ordem e em centavos: líquido = max(base + créditos − descontos, 0)
→ nota = min(líquido, limite configurado) → complemento = max(líquido − nota, 0)
→ Caju = complemento quando o meio complementar é Saldo Livre. O teto **não é
fixo em código**: vem de política por prestador, contrato, empresa ou workspace,
nessa ordem de prioridade — R$ 6.000 é exemplo da especificação, não constante.
Há teste que reprova se alguém chumbar o valor.

**O que faltava.** Selecionar o que entra no arquivo, conferir antes de gerar, e
recusar quando não dá para gerar direito.

- `lib/caju-export.ts` monta a prévia: exclui quem tem Caju zero (regra de
  negócio, não erro) e **bloqueia** cálculo não aprovado, CPF ausente ou
  inválido e CPF repetido na mesma empresa e competência. O mesmo CPF em
  empresas diferentes não é duplicidade. O total da prévia é a soma inteira em
  centavos do que iria no arquivo — a tela e o arquivo não podem divergir.
- Códigos de recusa específicos: `CAJU_TEMPLATE_MISSING`, `CAJU_EXPORT_INVALID`
  e `CAJU_EXPORT_EMPTY`, cada um dizendo o que resolve.
- Migração `0026_caju_templates.sql`: catálogo do arquivo oficial da Caju,
  versionado, com checksum, mapeamento de colunas, RLS por workspace e índice
  parcial garantindo **um modelo ativo por vez**.
- Capacidade `contractors.export_caju`, concedida só ao administrador: exportar
  dinheiro para um meio de pagamento externo não é ação de operação diária.

**Por que a exportação ainda não gera arquivo.** A Central de Ajuda da Caju
orienta baixar o modelo dentro do próprio portal, e cabeçalhos, abas e
validações mudam sem aviso. Gerar um XLSX "parecido" seria prometer uma
compatibilidade que ninguém verificou — e o arquivo seria recusado na
importação, ou pior, aceito errado. O produto guarda o arquivo oficial que o
administrador subir; enquanto não houver um ativo, a exportação recusa com
`CAJU_TEMPLATE_MISSING` e diz onde configurá-lo.

**Pendência do proprietário:** subir o `.xlsx` oficial de importação de Saldo
Livre, baixado do portal da Caju. Com ele entram a leitura/validação do layout,
o mapeamento de colunas e a escrita do arquivo (que exigirá uma biblioteca de
planilha — o projeto ainda não tem nenhuma, e adicionar uma antes de conhecer o
formato seria adivinhação).

Validação: 237 testes, `npm run ci` completo, 29 migrações validadas.

### 18.1 O modelo oficial chegou — e ele não é XLSX

O cliente enviou `pedidosexemplo.csv`, o modelo de pedidos da Caju. Duas
descobertas que mudam a implementação para melhor:

**Não é planilha binária.** É texto separado por `;`, ASCII, sem BOM, sem aspas,
com `\n`. Isso dispensa a biblioteca de planilha que eu havia previsto — o
produto gera o arquivo com o que já tem.

```
CPF;Matricula (opcional);Valor Fixo em Auxilio Alimentacao
12345678901;;0
```

**O exemplo é de outra categoria.** A coluna de valor é
`Valor Fixo em Auxilio Alimentacao`, não Saldo Livre. A Caju publica um modelo
por categoria de benefício, e exportar Saldo Livre usando o modelo de Auxílio
Alimentação creditaria o benefício errado — a Caju não tem como adivinhar a
intenção a partir do arquivo.

Por isso `templateCategory` deduz a categoria do rótulo da coluna de valor e a
guarda junto do modelo (migração 0027). A tela pode avisar quando o modelo
cadastrado é de categoria diferente da exportação pedida, em vez de gerar um
crédito silenciosamente errado.

**O que ficou pronto.** `lib/caju-template.ts` lê o modelo (detecta delimitador,
extrai cabeçalhos, localiza CPF e valor) e escreve o arquivo com os **mesmos
cabeçalhos, na mesma ordem e com o mesmo delimitador** — nenhum rótulo da Caju
está escrito no código, porque eles mudam sem aviso. Há teste que reprova se
alguém chumbar um.

Garantias cobertas por teste, usando o arquivo real como fixture:

- CPF sai só com dígitos e **preserva zero à esquerda** (`01234567890`) — perder
  o primeiro dígito troca a pessoa;
- valor sai decimal com duas casas, a partir de centavos inteiros, sem `R$` e
  sem separador de milhar;
- colunas opcionais saem vazias, como no exemplo oficial;
- nenhuma coluna extra de auditoria entra no arquivo de importação;
- a linha de exemplo do modelo (CPF fictício `12345678901`) **nunca** vira
  pedido real;
- modelo vazio, editado, sem CPF ou sem coluna de valor é recusado com código
  próprio (`CAJU_TEMPLATE_EMPTY`, `_INVALID`, `_NO_TAX_ID`, `_NO_AMOUNT`).

O nome do arquivo passou a acompanhar a extensão do modelo (`.csv`), e nem o
nome da empresa nem a extensão aceitam texto que escape do diretório.

**Ainda pendente do proprietário:** o modelo de **Saldo Livre** propriamente
dito, se a intenção for creditar essa categoria. O mecanismo já funciona com ele
— basta cadastrá-lo — mas o arquivo recebido é de Auxílio Alimentação.

Validação: 243 testes, `npm run ci` completo, 50 verificações de navegador, 24
de fumaça, 30 migrações validadas.

## 19. Seletor de grupo no shell e aviso de troca de contexto

A correção do bug de arquivamento (§16) deixou o dado pronto — `availableWorkspaces`
com status e `switchedFrom` — mas a interface não usava nenhum dos dois. Duas
lacunas fechadas:

**O seletor estava enterrado no modal de configurações.** Trocar de grupo é ação
de shell, não de configuração. Agora ele fica na barra lateral, em `<details>`
nativo (teclado e leitor de tela funcionam sem estado extra), listando cada grupo
com papel e — quando não operacional — o motivo pelo qual não abre.

**Uma regra de CSS o teria escondido de novo.** `.sidebar-workspace { display: none }`
dentro de `@media (min-width: 761px) and (max-width: 1499px)` apagava o bloco
inteiro na faixa que cobre a maioria dos notebooks. Para o atalho de estrutura
empresarial isso é aceitável; para o seletor de grupo, não — é ação essencial. O
seletor passou a ser visível em toda largura, reduzido ao símbolo quando falta
espaço, com a lista flutuando ao lado. O `browser-check` mede isso nas quatro
larguras e reprova se sumir.

**Troca automática deixou de ser silenciosa.** Quando o grupo ativo sai do ar, o
painel abre o próximo elegível **e avisa**: "Grupo X está arquivado e não pode
ser aberto. Você está trabalhando em Y." Trocar o contexto sem dizer faria a
pessoa achar que perdeu dados.

Percorrido no navegador com um usuário de dois grupos: seletor visível, os dois
listados com papel, troca pela interface mudando o cabeçalho, e o aviso correto
ao arquivar o grupo em uso.

**Um defeito de processo corrigido junto.** `npm run ci` não rodava typecheck —
rodava lint, migrations, testes e build. Como o build do Next não cobre os
arquivos de teste, um erro de tipo que eu havia introduzido em
`tests/caju-export.test.mts` passou despercebido: os testes passavam (o runtime
apenas remove tipos) e o build também. `npm run typecheck` entrou no pipeline.

Validação: 243 testes, `npm run ci` completo **agora com typecheck**, 51
verificações de navegador.

## 20. Acessibilidade WCAG 2.2 AA: medida, não declarada

Esta é a parte da Fase 6 que tem critério objetivo, então comecei por ela — e
comecei medindo, antes de mexer em cor.

**A primeira medição estava errada, e errada para o lado ruim.** O auditor que
escrevi pulava qualquer elemento sobre superfície com `background-image`,
contando-o como "não avaliável". A justificativa era razoável (gradiente não tem
cor única, medir contra o `backgroundColor` produz número inventado), mas o
efeito prático era um passe livre: 13 textos ficavam fora da conta. Ao medir
esses 13 à mão, três reprovavam de verdade — o selo do CTA final em 3.20:1, o
texto de apoio do mesmo bloco em 4.09:1 e o kicker da tela de login em 3.09:1.
Um critério que só avalia o que é fácil não é um critério.

A conferência virou `scripts/a11y-check.mjs`, parte do repositório e não uma
rodada avulsa. Ela extrai as paradas de cor do gradiente, compõe as camadas
translúcidas sobre as opacas e mede o texto **contra a pior parada**. É
conservador de propósito: uma aprovação precisa valer para o gradiente inteiro,
não para o ponto médio. Só sobra como "não mensurável" o que é imagem de verdade
(`url(...)`), e isso aparece no relatório em vez de sumir.

**O que a varredura encontrou depois de ficar honesta.** Home 14 falhas de
contraste e 2 alvos pequenos; Login 8 e 1; Painel 7 e 2; Console 0 e 1. Corrigi
por token, não espalhando valores:

- `--vin-text-soft` 4.48:1 → `#55627A`; `--ui-text-muted` 2.76:1 → `#626C7A`.
- `--brand-accent-on-dark: #6FB4FF` para o azul da marca sobre navy — o
  `--brand-accent` puro fica em 4.08:1 ali.
- No painel, `--ui-mint` era usado como preenchimento **e** como cor de texto.
  Sobre branco ele dá 3.39:1. Em vez de trocar o token (o que mudaria as barras,
  bordas e ícones que dependem dele), separei os papéis: `--ui-mint-text` para
  rótulo em superfície clara e `--ui-on-mint` para texto sobre o preenchimento.
- A seção `.final-cta` redefine os próprios tokens de apoio, porque o gradiente
  dela termina em `--brand`, bem mais claro que o navy do rodapé. Uma exceção
  declarada no lugar certo, não exceções espalhadas pelas regras filhas.

**Auditar uma tela do painel não é auditar o painel.** O painel troca de visão
por estado, não por rota: `/painel` mostrava a visão geral e mais nada. Passei a
percorrer a navegação lateral de verdade, clicando item a item, nas larguras
1440 e 390. Isso mudou o resultado — apareceram falhas que a varredura de uma
tela só não via, entre elas um defeito real de produção: o bloco "Calendários
externos" do Planner foi escrito com os tokens de superfície clara mas mora
dentro de um cartão navy. O título estava em **1.06:1**. Não é "contraste baixo";
é texto invisível, e estava assim na tela.

**Verde-menta da marca anterior.** Encontrei acentos remanescentes
(`#45dcb0`, `#8ae0c5`, `#0E3B3B`, e os fallbacks do módulo de cadastros) em
superfícies escuras da marca. Foram para a paleta azul. **Não** mexi no verde
semântico de sucesso: o levantamento achou 154 ocorrências de cores
esverdeadas no CSS, e a maioria é estado positivo, não identidade. Recolorir por
matiz quebraria o significado — essa varredura fica para o passo de direção
visual, com leitura de contexto, não com `sed`.

**Guardas para não voltar.** Três testes novos em
`tests/vinculato-identity.test.mts`: o menta antigo não pode reaparecer no CSS,
o par legível de `--ui-mint` precisa existir, e a conferência WCAG precisa
continuar medindo gradiente, rodando nas duas larguras e reprovando com código
de saída diferente de zero. O primeiro deles já pegou uma ocorrência que eu
tinha deixado passar em `registrations.module.css`.

**Resultado medido.** 0 violação de contraste, 0 controle sem nome acessível e
0 alvo abaixo de 24x24 nas 12 telas percorridas, em 1440 e 390 px.

**Limite honesto desta rodada.** A conta de ensaio está no plano Starter, então
a navegação lateral só expõe os módulos desse plano. Operação DP, Pagamentos PJ,
Ponto, Integrações, Módulos auxiliares, Folha e Relatórios **não foram
auditados** — não porque passaram, mas porque não apareceram. Fica para a rodada
com uma conta em plano Enterprise.

Validação: 246 testes, `npm run ci` completo, 51 verificações de navegador,
`npm run a11y-check` em 12 telas × 2 larguras.

## 21. O segundo modelo da Caju, e o que ele derrubou

O cliente enviou o modelo oficial de **Premiação** — o de Saldo Livre, que
faltava. Ele recusou de cara: `CAJU_TEMPLATE_NO_AMOUNT`.

**Eu tinha generalizado de uma amostra só.** Com o modelo de Auxílio
Alimentação em mãos, escrevi a detecção da coluna de crédito procurando a
palavra "valor" no cabeçalho. O modelo de Premiação chama a coluna apenas de
`Saldo` — dois arquivos oficiais da mesma empresa, sem nenhuma palavra em comum
na coluna que importa. A regra que eu tinha chamado de flexível era só uma
suposição com uma amostra.

A detecção agora usa dois sinais independentes e exige que não se contradigam:
o vocabulário do cabeçalho (`valor`, `saldo`, `credito`, `premiacao`) e a linha
de exemplo que a Caju inclui no modelo — a coluna que traz número e não é o CPF.
Quando os dois discordam, ou quando nenhum resolve sozinho, a leitura **recusa
dizendo quais colunas encontrou**. Escolher errado aqui credita dinheiro no
campo errado; não é lugar para desempate por palpite.

### O caminho até o arquivo não existia

`lib/caju-export.ts` e `lib/caju-template.ts` tinham testes, e a tabela
`fdp_caju_templates` existia — mas nenhuma rota cadastrava modelo nem gerava
arquivo. Biblioteca com teste não é funcionalidade entregue. Entraram
`POST/GET /api/payments/caju/templates`, `GET/POST /api/payments/caju/export` e
o painel de exportação dentro de Pagamentos PJ.

### Três defeitos que só apareceram ao rodar

O banco local tinha se perdido no reciclo do contêiner. Reconstruí do zero — e
foi essa reconstrução que expôs o que teste nenhum tinha pegado.

**A primeira instalação nunca completava (P0).** Contra um banco vazio, o
bootstrap falhava com 23503. O `fdp_bootstrap_guard` serializa a criação do
primeiro grupo, então ele precisa ser reivindicado antes do workspace existir —
mas a chave estrangeira era verificada na hora. Pior: o usuário era gravado
**fora** da transação, então a falha deixava uma conta órfã. O app continuava em
modo de primeira instalação e, ao mesmo tempo, recusava o e-mail por já existir.
Instalação travada, sem saída pela interface. Migração 0028 torna a verificação
adiável; a conta passou para dentro do mesmo `batch`.

**Erro de 100× em dinheiro.** A prévia mostrava R$ 300.000,00 onde o fechamento
era R$ 3.000,00. `toCents` interpreta valor digitado em pt-BR e trata o ponto
como separador de milhar; o `numeric` do PostgreSQL volta como `"3000.00"`, que
virava `300000` e depois `30000000` centavos. São duas origens diferentes e cada
uma precisa do seu conversor — `centsFromDatabase` agora existe, com o teste que
prova que os dois discordam de propósito.

**Cadastrar modelo dependia do Vercel Blob.** Sem `BLOB_READ_WRITE_TOKEN` o
helper lançava `Error` genérico e a tela dizia "Não foi possível concluir a
operação" — exatamente a queixa que originou este trabalho. O modelo é um CSV de
algumas dezenas de bytes e tudo que a geração precisa já ia para o banco;
migração 0029 guarda o texto original em coluna própria e a dependência externa
saiu do caminho de dinheiro.

### Ensaio no navegador, com os três casos

Banco vazio → primeira instalação pela tela → plano Enterprise → uma empresa,
três prestadores: CPF válido, CPF inválido e diferença zero.

- Prévia: 1 no arquivo, 1 bloqueado (*"Bruno Servicos — CPF ausente ou
  inválido"*), 1 sem diferença. Botão de gerar **desabilitado**, com o motivo no
  título.
- Modelo de Premiação cadastrado: *"Modelo oficial v1 — Saldo Livre. Colunas:
  CPF · Saldo."* — categoria deduzida do arquivo real.
- CPF corrigido, arquivo gerado:
  `caju_saldo_livre_ensaio-servicos_2026-08_2026-08-11.csv`, 49 bytes:

      CPF;Saldo
      52998224725;3000.00
      11144477735;1000.00

  Total na tela R$ 4.000,00; soma do arquivo, a mesma. O CPF de exemplo do
  modelo não vazou.

### A cobertura de acessibilidade que faltava

Com a conta em Enterprise, os sete módulos que a rodada anterior **não** tinha
auditado apareceram — e traziam defeito. Três, todos do mesmo tipo: contêiner
escuro reusando token de superfície clara.

- `.cycleRail` (Operação DP): kicker em 2.42:1.
- `.moduleLenses` (Auxiliares): a regra escura `.activeLens > b small` perdia por
  **especificidade** para `.moduleLenses button > b small`. Deixar a exceção
  menos específica que a regra geral é um jeito silencioso de não corrigir nada.
- `.moduleLenses button:hover` alcançava a lente selecionada e trocava o fundo
  navy por claro mantendo o texto branco: passar o mouse sobre o item ativo o
  apagava. Alcançável com o mouse, no desktop.

E `.sidebar-toggle` encolhia de 34px para 20px de altura — `flex-shrink` no eixo
principal da barra em coluna — ficando abaixo do alvo mínimo em todas as telas.

Resultado: **0 violações em 19 telas × 2 larguras**, agora com o catálogo
inteiro de módulos.

Validação: 257 testes, `npm run ci` completo, 51 verificações de navegador,
`npm run a11y-check` limpo, e a exportação percorrida ponta a ponta contra
PostgreSQL real.
