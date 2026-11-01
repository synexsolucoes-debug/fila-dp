# Auditoria completa: Vinculato (saúde do repositório)

**Data**: 2026-11-01
**Modo**: Saúde geral do repositório
**Fonte**: `main` em `4b80088` (PR #268)
**Visões aplicadas**: 9/10
**Visões puladas**: Backend Engineer — a visão é específica de Rust/Tauri; o Vinculato não tem Rust. O servidor (Node, rotas, Postgres) foi coberto pelas visões de Estrutura, Produção e Performance.

**Como foi feito**: o produto foi executado de verdade — Postgres 16 local, as 120 migrations aplicadas, conta de ensaio criada por `scripts/seed-ui-fixture.mjs`, `next build` + `next start`, e navegação com Playwright em desktop (1440×900) e celular (390×844), nos temas claro e escuro. Suíte local: lint (0 erros, 5 avisos), typecheck limpo, **2.420 testes passando**, `npm audit --omit=dev` sem vulnerabilidade alta.

---

## Veredito geral: APROVAR COM MUDANÇAS

A fundação é rara para um produto deste tamanho: isolamento por tenant provado com papel sem superusuário, ensaios de banco reais na CI, logs que descartam dado pessoal por construção, migrations com lock e só em produção, auditoria WCAG nos dois temas. Nenhuma visão encontrou defeito de segurança ou de integridade de dados. O que pede mudança é **escala e manutenção**: o painel recarrega o quadro inteiro a cada alteração de qualquer pessoa, o front-end está concentrado num arquivo de 5.360 linhas sobre 20 mil linhas de CSS em camadas, ninguém é avisado quando a produção quebra, e a gaveta de demanda deixa o foco do teclado escapar.

## Veredito por visão

| # | Visão | Veredito | Críticos | Recomendações |
|---|-------|----------|----------|---------------|
| 1 | Design Engineer | Aprovar com mudanças | 0 | 5 |
| 2 | UX Engineer | Aprovar com mudanças | 0 | 6 |
| 3 | Frontend Engineer | Aprovar com mudanças | 1 | 4 |
| 4 | Backend Engineer | Pulada | — | — |
| 5 | Structural Engineer | Aprovar com mudanças | 0 | 4 |
| 6 | Repo Maintainer | Aprovar com mudanças | 1 | 5 |
| 7 | Production Readiness | Aprovar com mudanças | 1 | 3 |
| 8 | DX Engineer | Aprovar com mudanças | 1 | 3 |
| 9 | Performance Engineer | Aprovar com mudanças | 1 | 3 |
| 10 | Accessibility Engineer | Aprovar com mudanças | 1 | 3 |

## Todos os críticos (corrigir)

| # | Problema | Visão(ões) | Arquivo(s) | Impacto | Correção |
|---|----------|-----------|------------|---------|----------|
| C1 | Qualquer alteração faz **todas as abas abertas** baixarem o snapshot inteiro, e o snapshot traz todas as demandas do quadro, **inclusive arquivadas**, sem limite | Performance, Frontend, Estrutura | `lib/fila-dp-db.ts` (`SELECT * FROM fdp_cards WHERE board_id = ?` em `getWorkspaceSnapshot`), `app/painel/WorkspaceApp.tsx:1566` | Custo cresce com (usuários conectados × alterações × tamanho do histórico). O arquivamento do PR #268 não reduz o payload. O ensaio `db:measure-work` mede a Central de Trabalho, não este caminho | Excluir arquivadas do snapshot (carregar sob demanda na aba Arquivadas); `/api/realtime` devolver o que mudou e o cliente buscar só esses cartões; incluir o snapshot no ensaio de volume com o mesmo teto de 500 ms |
| C2 | Ninguém é avisado quando a produção quebra | Produção, DX | `lib/observability.ts`, `app/api/health/route.ts`, `.github/workflows/*cron*.yml` | O log é bom, mas só é lido quando alguém procura. `/api/health` já separa "schema ok" de "operação parada" e nada o consulta. O incidente do `grant` (descrito na CI) ficou rodando quebrado a cada meia hora | Ligar um rastreador de erros (Sentry ou Vercel Observability) com alerta; um cron que chame `/api/health` e falhe quando o veredito não for `saudavel` |
| C3 | O foco do teclado **sai da gaveta de Nova demanda** e, ao fechar com Esc, **não volta** ao botão que a abriu | Acessibilidade, UX | `app/painel/features/shared/motion.tsx:242-272` | Medido: no 28º Tab o foco vai para o `<body>`, atrás de um diálogo `aria-modal="true"`; após Esc, o foco cai em "5 sem responsável". WCAG 2.4.3 (ordem do foco) | Calcular primeiro/último sem depender de `offsetParent` (ou usar `inert` no restante da página); capturar o gatilho **antes** do render que abre a gaveta e devolver o foco a ele |
| C4 | Testes listados à mão no `package.json` | Repo, DX | `package.json` (script `test`, 169 arquivos) | Teste novo que ninguém acrescenta à lista **não roda**, e a CI fica verde. Já aconteceu (PR #231) | `node --test "tests/**/*.test.m{ts,js}"` e apagar a lista |

## Problemas transversais

| Problema | Apontado por | Causa raiz | Correção unificada |
|----------|-------------|------------|--------------------|
| **Monólito do painel** | Frontend, Estrutura, Performance, Repo | `WorkspaceApp.tsx` (5.360 linhas, 64 `useState`, 28 `useEffect`) importa estaticamente as 20+ telas de módulo | Continuar a extração para `features/` e carregar cada módulo com `next/dynamic`; meta: abaixo de 1.500 linhas e JS da tela inicial < 1 MB |
| **CSS em camadas** | Design, Repo, Performance | Cada redesign foi colocado por cima do anterior: `dashboard-modern.css` (6.091), `interface-refresh.css`, `access.css`, `vinculato-shell.css`, `design-centi-sap.css` — 20.640 linhas, 37 `!important`, 123 tamanhos de fonte distintos, 20+ valores de raio fixos | Um único conjunto de tokens (`--ui-*` já é o dominante, com 3.295 usos); migrar e apagar uma camada por PR |
| **Navegação com nomes repetidos** | UX, Design | Módulos e abas cresceram sem revisão de nomenclatura | Revisão única dos rótulos (ver UX R1) |
| **Herança de nomes antigos** | Repo, DX | O produto nasceu em Cloudflare D1 / ChatGPT hosting | Renomear `app/chatgpt-auth.ts` / `ChatGPTUser`; apagar `.openai/hosting.json`, `examples/d1`, `drizzle/*.sql` antigos; `getD1` pode ficar (documentado) |
| **Sem guarda server/client** | Estrutura, Frontend | Nenhum módulo usa `import "server-only"` | Marcar `db/`, `lib/fila-dp-db.ts` e serviços com SQL; o build passa a recusar o vazamento |

## Todas as recomendações

| # | Recomendação | Visão | Arquivo(s) | Correção |
|---|--------------|-------|------------|----------|
| R1 | Portais públicos e módulos novos sem tema escuro | Design | `app/plataforma/platform.module.css` (250 cores fixas), `assistant`, `auxiliary`, `integrations`, `gestor`, `portal/*` | Trocar cores fixas por `--ui-*` |
| R2 | Indicadores da Visão geral desalinhados e dígitos com fonte diferente | Design | Visão geral | Mesma altura de bloco; `font-variant-numeric: tabular-nums` |
| R3 | Botão "Ver integrações" branco no tema escuro | Design | Visão geral | Usar o botão secundário do sistema |
| R4 | Datas cruas ("Utilização em 2026-11") e `input type=month` | Design/UX | `EpiControlView.tsx` | `Intl.DateTimeFormat('pt-BR', {month:'long', year:'numeric'})` |
| R5 | Nomes repetidos: aba "DP Operacional" e "Operação DP" dentro do módulo "Operação DP"; "Minha fila" duas vezes em Demandas; "Pagamento PJ" vs "Pagamentos e competências" | UX | `lib/panel-routes.ts`, `lib/modules.ts` | Um nome por destino |
| R6 | Demandas no celular: ~600 px de controles antes da primeira demanda; abas quebram em 3 linhas | UX | Demandas | No celular abrir em "Minha fila", recolher indicadores e modos num menu |
| R7 | Visão geral se contradiz: "1 sistema conectado" com 4 na lista e "1 com erro, de 5" | UX | Visão geral | Título derivado da mesma contagem da lista |
| R8 | Formulário de Nova demanda perde o que foi digitado ao fechar | UX | `WorkspaceApp.tsx` | Rascunho em `sessionStorage` por quadro, ou confirmação ao fechar com conteúdo |
| R9 | 44 pontos com "Não foi possível concluir a operação" como fallback | UX | `app/`, `lib/` | Fallback com o `requestId` e "tente de novo / fale com o administrador" |
| R10 | "Desfazer" só existe em 2 telas | UX | — | Desfazer em mover e atribuir demanda |
| R11 | 2,4 MB de JS (sem compressão) para abrir Demandas; nenhum `next/dynamic` | Frontend/Perf | `WorkspaceApp.tsx` | Ver transversal "Monólito" |
| R12 | 3 `eslint-disable react-hooks/exhaustive-deps` e 9 `key={index}` | Frontend | `app/` | Revisar cada um |
| R13 | 322 de 356 rotas com SQL escrito dentro da rota | Estrutura | `app/api/**/route.ts` | Rota nova chama serviço em `lib/`; migrar quando a rota for tocada |
| R14 | `lib/` importa `app/chatgpt-auth` (camada invertida) | Estrutura | `lib/fila-dp-api.ts`, `lib/fila-dp-db.ts`, `lib/platform-authorization.ts` | Mover o tipo/sessão para `lib/auth/` |
| R15 | Caractere NUL literal no código-fonte | Repo | `lib/domain-events.ts:313` | Escrever `"\u0000"`; hoje git/grep tratam o arquivo como binário e o diff some na revisão |
| R16 | Sem `CLAUDE.md`/`AGENTS.md` | Repo/DX | raiz | O repositório é construído por sessões de IA; um arquivo curto com comandos, convenções e "leia `docs/arquitetura-operacional.md` §11" evita redescoberta a cada sessão |
| R17 | Imports com e sem `.ts` misturados em `lib/` (356 vs 44) | Repo | `lib/` | Escolher um padrão e aplicar no lint |
| R18 | `/api/health` existe mas ninguém o consulta | Produção | `.github/workflows/` | Ver C2 |
| R19 | Crons dependem do agendador do GitHub Actions | Produção | `*-cron.yml` | O GitHub atrasa execuções agendadas em horário de pico; avaliar Vercel Cron para o de integrações (a cada 30 min) |
| R20 | 5 avisos de lint (`window.location` para rota interna, variáveis sem uso) | Repo | `WorkspaceApp.tsx:2553`, `EpiControlView.tsx:355`, `lib/contractor-batch-statement-pdf.ts:53`, `tests/erp-dp.test.mts:29-30` | `router.push`; apagar variáveis |
| R21 | README "Quick Start" não sobe o produto | DX | `README.md` | Documentar (ou um `npm run dev:local`): Postgres, `db:migrate`, `seed-ui-fixture`, variáveis `FDP_AUTH_SECRET`, `FDP_DB_DRIVER=pg`, `FDP_SANKHYA_VAULT_KEY` |
| R22 | Lint leva 65 s, typecheck 43 s, sem hook local | DX | — | Cache do ESLint (`--cache`) |
| R23 | Polling de 4 s no painel do Sankhya | Performance | `SankhyaConnectorPanel.tsx:61` | Pausar quando a aba não está visível |
| R24 | Sem link "pular para o conteúdo" | Acessibilidade | layout do painel | Link no topo para `<main>` |
| R25 | Cartão do quadro arrastável sem alternativa por teclado no próprio cartão | Acessibilidade | `features/board` | Confirmar que "Mover" no detalhe cobre o caso; anunciar movimentação em `aria-live` |
| R26 | `window.confirm` no app Campo | Acessibilidade/UX | `app/campo/FieldApp.tsx`, `SesmtFlows.tsx` | Usar o diálogo do próprio app (o nativo quebra o visual de app instalado) |

---

# Relatórios por visão

---

## 1. Design Engineer

**Veredito**: Aprovar com mudanças

**Resumo**: o painel tem um sistema de tokens dominante (`--ui-*`, 3.295 usos) e tema escuro bem resolvido nas telas principais. A fragmentação está nas bordas: camadas de CSS de redesigns antigos e módulos/portais novos com cores fixas.

### Arquivos revisados
| Arquivo | Papel visual | Risco |
|---|---|---|
| `app/dashboard-modern.css` (6.091) | Camada principal antiga do painel | Alto |
| `app/interface-refresh.css`, `app/access.css`, `app/vinculato-shell.css`, `app/design-centi-sap.css` | Camadas de redesign sobrepostas | Alto |
| `app/globals.css` | Tokens base | Médio |
| `app/plataforma/platform.module.css` | Console da plataforma | Médio |
| `app/portal/*/portal.module.css` | Portais públicos (colaborador, EPI, nota) | Médio |
| `app/painel/features/*/**.module.css` (26) | Módulos | Baixo/Médio |

### Críticos
Nenhum.

### Recomendações
| # | Problema | Arquivo(s) | Por quê | Correção |
|---|---|---|---|---|
| 1 | 13 folhas de módulo com cores fixas e **nenhuma** regra `.theme-dark` | `platform.module.css` (250), `assistant` (38), `portal/colaborador` (31), `portal/epi` (27), `panel-ui` (19), `site` (19), `auxiliary` (16), `gestor` (12), `integrations` (11) | Abrem claras dentro do painel escuro | Substituir por `--ui-*` |
| 2 | 20+ raios fixos (4–14 px, 99/999 px) ao lado de `--ui-radius-sm/md/lg` | todas as folhas | Cartões vizinhos com cantos diferentes | Mapear para os 3 tokens + `999px` para pílula |
| 3 | 123 valores distintos de `font-size` | todas as folhas | Hierarquia tipográfica imprevisível | Escala de 6–8 tokens |
| 4 | Indicadores da Visão geral desalinhados; "0" com glifo diferente de "5" | Visão geral | O olho lê os números como de tamanhos diferentes | Blocos de mesma altura, `tabular-nums` |
| 5 | "Ver integrações" é branco sólido no escuro; botões "Atualizar"/"Cadastrar EPI" maiores que os vizinhos | Visão geral, EPI | Quebram o padrão do botão secundário | Usar o componente de botão compartilhado |

### Desejáveis
| # | Sugestão | Razão |
|---|---|---|
| 1 | "Dashboard de EPI" solto entre o aviso e os indicadores | Título sem peso de seção |
| 2 | Plurais "conectada(s)", "troca(s)" | `Intl.PluralRules` deixa a interface mais humana |

### Aderência ao design system
Tokens `--ui-*` dominam; famílias por módulo (`--pay-`, `--int-`, `--reg-`, `--ops-`, `--aux-`, `--epi-`…) somam ~1.700 usos e duplicam papéis semânticos. 31 de 39 folhas tratam `prefers-reduced-motion`; 59 regras `:focus-visible`. O risco é a soma de camadas: uma correção visual precisa ser feita em vários lugares e uma das camadas sempre "ganha" por especificidade ou `!important` (37).

### Cobertura de estados visuais (amostra navegada)
| Elemento | Hover | Foco | Ativo | Desabilitado | Carregando | Vazio | Erro | Escuro |
|---|---|---|---|---|---|---|---|---|
| Visão geral | ok | ok | ok | — | ok | ok | ok (Tangerino) | parcial (botão branco) |
| Meu trabalho | ok | ok | ok | — | ok | **ótimo** | — | ok |
| Demandas (quadro) | ok | ok | ok | — | ok | ok | — | ok |
| Gestão de EPI | ok | ok | ok | — | ok | ok | — | ok |
| Portais públicos | ? | ? | ? | ? | ? | ? | ? | **ausente** |
| Console da plataforma | ? | ? | ? | ? | ? | ? | ? | **ausente** |

### Detalhes
- Fidelidade aos tokens: RESSALVAS
- Cobertura de estados: APROVADO
- Paridade do tema escuro: RESSALVAS
- Animação: APROVADO
- Consistência visual: RESSALVAS

---

## 2. UX Engineer

**Veredito**: Aprovar com mudanças

**Resumo**: estados vazios excelentes, login claro, seletor de módulos limpo. A carga cognitiva está em nomes repetidos, densidade de controles no celular e perda de trabalho digitado.

### Mapa da jornada
1. Login → erro de senha: validação nativa do navegador (mínimo de 8 caracteres) — **OK**
2. Login → seletor de módulos ("Qual módulo você quer abrir?") — **OK**; descrições cortadas com "…" — **ATENÇÃO**
3. Módulo "Operação DP" → abas "Meu trabalho · DP Operacional · Operação DP · Demandas · Carteira · Inbox · Planner" — **ATENÇÃO** (nome do módulo repetido numa aba, e "DP Operacional" vs "Operação DP")
4. Demandas → 6 indicadores, busca, 6 modos de visão, Focar, 5 atalhos de filtro, Salvar recorte, Filtros, Ordenar, Arquivadas — **ATENÇÃO** ("Minha fila" aparece como modo e como atalho)
5. Nova demanda → gaveta abre com "Próximo passo" **antes** do título — **ATENÇÃO**; fechar perde o que foi digitado — **FALHA**
6. Visão geral → "1 sistema conectado" ao lado de 4 sistemas listados — **ATENÇÃO**
7. Celular → Demandas: primeira demanda só depois de ~600 px de controles — **ATENÇÃO**
8. Campo (iPhone) → grade de ações grandes, tema escuro, claro — **OK**
9. Rota inexistente `/painel/xyz` → redireciona (307) para o painel — **OK**

### Críticos
Nenhum isolado (o foco da gaveta está no crítico C3, compartilhado com Acessibilidade).

### Recomendações
| # | Problema | Impacto | Correção |
|---|---|---|---|
| 1 | Nomes repetidos (passo 3 e 4; "Pagamento PJ" vs "Pagamentos e competências") | A pessoa não sabe qual abrir | Um nome por destino; revisar `lib/panel-routes.ts` e `lib/modules.ts` juntos |
| 2 | Nova demanda perde o rascunho | Retrabalho e frustração | Rascunho em `sessionStorage` ou confirmação ao fechar |
| 3 | Ordem do formulário: "Próximo passo" antes de título/tipo | Pede o detalhe antes do essencial | Título → tipo → processo → descrição → próximo passo |
| 4 | Densidade no celular | Precisa rolar para ver a primeira demanda | Abrir em "Minha fila"; recolher indicadores |
| 5 | Mensagem contraditória na Visão geral | Desconfiança nos números | Título derivado da lista |
| 6 | 44 fallbacks "Não foi possível concluir a operação" | Sem próximo passo | Incluir `requestId` e ação sugerida |

### Desejáveis
| # | Sugestão | Razão |
|---|---|---|
| 1 | "Desfazer" em mover/atribuir | Hoje só 2 telas têm |
| 2 | Descrições completas no seletor (tooltip ou 3 linhas) | "…" esconde o que diferencia módulos parecidos |

### Consistência de interação
Gavetas, Esc, estados vazios e busca global (⌘K) são consistentes. O app Campo usa `window.confirm`, diferente do diálogo do painel.

### Detalhes
- Descoberta: RESSALVAS
- Fluxo completo: APROVADO
- Recuperação de erro: RESSALVAS
- Feedback e status: APROVADO
- Consistência: RESSALVAS

---

## 3. Frontend Engineer

**Veredito**: Aprovar com mudanças

**Resumo**: TypeScript estrito sem nenhum `any`, só 5 `eslint-disable`, `bpmn-js` já carregado sob demanda. O problema é a forma: um componente-raiz de 5.360 linhas que importa todas as telas.

### Arquivos revisados
| Arquivo | Papel | Risco |
|---|---|---|
| `app/painel/WorkspaceApp.tsx` | Raiz do painel: estado, roteamento, polling, formulários | Alto |
| `app/painel/features/shared/motion.tsx` | Gaveta/diálogo, foco | Médio |
| `app/painel/features/processes/ProcessModeler.tsx` | BPMN (import dinâmico) | Baixo |
| `app/campo/FieldApp.tsx` (1.025) | App de campo | Médio |

### Críticos
| # | Problema | Arquivo(s) | Por que quebra | Correção |
|---|---|---|---|---|
| 1 | Recarga do snapshot inteiro a cada mudança detectada | `WorkspaceApp.tsx:1566` | `setSnapshot(next)` troca o objeto-raiz e re-renderiza a árvore toda, em todas as abas abertas | Ver C1: atualização parcial por cartão |

### Recomendações
| # | Problema | Arquivo(s) | Por quê | Correção |
|---|---|---|---|---|
| 1 | Zero `next/dynamic`; 2,4 MB de JS na tela de Demandas | `WorkspaceApp.tsx` | Quem só usa EPI baixa PJ, Folha, Processos… | `dynamic(() => import(...))` por módulo |
| 2 | 64 `useState` e 28 `useEffect` num componente | `WorkspaceApp.tsx` | Estados distantes re-renderizam juntos; efeitos difíceis de raciocinar | Extrair estado por módulo; `useReducer` para o formulário de demanda |
| 3 | 3 `exhaustive-deps` desligados | `WorkspaceApp.tsx:1510` e outros | Risco de closure velha | Revisar e documentar ou corrigir |
| 4 | 9 listas com `key={index}` | `app/` | Reordenação troca estado entre itens | Usar id |

### Desejáveis
| # | Sugestão | Razão |
|---|---|---|
| 1 | `import "server-only"` nos módulos com SQL | Impede vazamento para o bundle do cliente |

### Caminho de renderização
Login → `/painel` (componente cliente) → 1 chamada `/api/workspace` (bom: sem cascata) → `setSnapshot` → toda a árvore. Polling `/api/realtime` a cada N s; se `changed`, nova chamada completa e novo `setSnapshot`. Relógio do quadro re-renderiza a cada 60 s. Não há seletores por fatia: qualquer mudança no snapshot atinge todas as telas montadas.

### Tipos
`strict: true`, 0 `any`, 0 `as any`. Contratos do banco em `types/database-adapter.d.ts`. Lacuna: o JSON de `/api/workspace` é convertido com `as WorkspaceSnapshot` no cliente, sem validação; aceitável dentro do mesmo deploy.

### Detalhes
- Arquitetura de componentes: RESSALVAS
- Gestão de estado: RESSALVAS
- Tipos: APROVADO
- Performance de renderização: RESSALVAS
- Bundle: RESSALVAS

---

## 4. Backend Engineer

**Pulada** — a visão é específica de Rust/Tauri (crates, comandos Tauri, sidecars). O Vinculato não tem Rust; o app de mesa é Electron (`desktop/`) e só abre a produção. O servidor Node/Postgres foi coberto nas visões 5, 7 e 9.

---

## 5. Structural Engineer

**Veredito**: Aprovar com mudanças

### Mapa de dependências
```
app/painel (cliente) ──> lib/*-rules, lib/panel-routes, lib/work-items (só constantes)   ok
app/api/**/route.ts ──> lib/fila-dp-api (345 importações), lib/fila-dp-db (303), lib/authorization (290)
        └──> SQL escrito na própria rota (322 de 356 rotas)                              ⚠
lib/fila-dp-api, lib/fila-dp-db, lib/platform-authorization ──> app/chatgpt-auth        ⚠ camada invertida
worker/sankhya, worker/tangerino ──> lib/sankhya/*, lib/tangerino/*, lib/observability   ok
db/index.ts (Neon HTTP | pg local) ──> set_config(app.workspace_id) por transação        ok (RLS)
desktop/ (Electron) ──> URL de produção                                                  ok
```

### Travessias de fronteira
| Travessia | De → Para | Limpa? | Notas |
|---|---|---|---|
| Cliente → servidor | painel → `/api/*` | Sim | Uma chamada de snapshot + rotas por ação |
| Rota → banco | `route.ts` → SQL | **Não** | SQL na rota; regras às vezes em `lib/`, às vezes na rota |
| lib → app | `lib/*` → `app/chatgpt-auth` | **Não** | Tipo e sessão deveriam morar em `lib/` |
| Worker → lib | `worker/*` → `lib/*` | Sim | Imports relativos com `.ts`, explícitos |
| Cliente → lib com SQL | — | Sim hoje | Sem `server-only`, nada impede amanhã |

### Críticos
Nenhum.

### Recomendações
| # | Problema | Por quê | Correção |
|---|---|---|---|
| 1 | SQL dentro de 322 rotas | Mudar uma tabela exige caçar strings em centenas de arquivos (a CI `verify:sql` mitiga, não resolve) | Serviço em `lib/` para rota nova; migrar ao tocar |
| 2 | `lib` depende de `app/chatgpt-auth` | Dependência apontando do geral para o específico | Mover para `lib/auth/session.ts` |
| 3 | Módulos-deus: `process-instances.ts` (1.255), `fila-dp-db.ts` (1.157), `work-items.ts` (1.116) | Alta coesão acidental | Dividir por responsabilidade ao tocar |
| 4 | Sem `server-only` | Vazamento silencioso possível | Marcar `db/` e serviços |

### Detalhes
- Direção das dependências: RESSALVAS
- Acoplamento: APROVADO
- Coesão: RESSALVAS
- Fronteiras de camada: RESSALVAS
- Propagação de mudança: RESSALVAS

---

## 6. Repo Maintainer

**Veredito**: Aprovar com mudanças

### Críticos
| # | Problema | Arquivo(s) | Convenção violada | Correção |
|---|---|---|---|---|
| 1 | Testes listados à mão | `package.json` | "Todo teste roda" | Glob `tests/**/*.test.m{ts,js}` |

### Recomendações
| # | Problema | Por quê | Correção |
|---|---|---|---|
| 1 | NUL literal em `lib/domain-events.ts:313` | git/grep veem binário; diff some na revisão | `"\u0000"` |
| 2 | Restos de outra plataforma: `.openai/hosting.json` (D1/R2), `examples/d1`, `drizzle/*.sql` (9 migrations antigas fora de `drizzle/postgres`), `app/chatgpt-auth.ts` | Confundem quem chega | Apagar / renomear |
| 3 | Sem `CLAUDE.md`/`AGENTS.md` | Cada sessão de IA redescobre comandos e regras | Arquivo curto na raiz |
| 4 | Imports `./x.ts` (356) e `./x` (44) misturados em `lib/` | Duas convenções | Regra de lint |
| 5 | 5 avisos de lint, 8 `console.*` em `app/`/`lib/` | Existe `lib/observability.ts` | Corrigir / usar `log()` |

### Checklist de convenções
| Convenção | Situação | Notas |
|---|---|---|
| Localização de arquivos | ok | `features/<módulo>`, `lib/<domínio>` |
| Nomes | atenção | `fila-dp-*` e `chatgpt-auth` herdados (preservação documentada para tabelas/variáveis) |
| Barrel exports | n/a | O projeto importa direto do arquivo — coerente |
| Ordem de imports | ok | |
| `import type` separado | ok | |
| Alias `@/` | atenção | `lib/` usa relativo com `.ts`; `app/` usa `@/` |
| Sem código morto | atenção | Ver recomendação 2 |
| Log estruturado | ok | 8 exceções |
| Sem supressão de lint | ok | 5 no total, comentadas |
| CLAUDE.md | **ausente** | |

### Reaproveitamento
`lib/dp-calendar.ts` (dia útil) e as regras puras `*-rules.ts` já são o ponto único — a nova skill `dp-legislacao-brasil` aponta para eles.

### Detalhes
- Organização: APROVADO
- Nomes: RESSALVAS
- Imports: RESSALVAS
- Reaproveitamento: APROVADO
- Lint: APROVADO

---

## 7. Production Readiness

**Veredito**: Aprovar com mudanças

**Resumo**: o ponto mais forte do projeto. Falta a ponta final: avisar alguém.

### Críticos
| # | Problema | Arquivo(s) | Falha em produção | Correção |
|---|---|---|---|---|
| 1 | Sem alerta de erro nem monitor de saúde | `lib/observability.ts`, `app/api/health/route.ts` | Erro só é descoberto quando o cliente reclama | Rastreador de erros + cron que reprova quando `/api/health` ≠ `saudavel` |

### Recomendações
| # | Problema | Por quê | Correção |
|---|---|---|---|
| 1 | Crons no agendador do GitHub Actions (`17,47 * * * *` integrações) | Execuções agendadas atrasam em pico; falha só gera e-mail do GitHub | Vercel Cron para o de alta frequência, ou alerta explícito na falha |
| 2 | Sem marcação de versão nos logs | Difícil correlacionar erro com deploy | Incluir `VERCEL_GIT_COMMIT_SHA` no contexto do log (`/api/version` já existe) |
| 3 | Snapshot sem limite (ver C1) | Lentidão progressiva, não queda | Ver Performance |

### Análise de modos de falha
| Cenário | O que falha | Impacto | Recuperação | Tratado? |
|---|---|---|---|---|
| Migration quebrada no deploy | `build:deploy` | Deploy falha antes de servir | Deploy anterior continua | **Sim** (só em produção, com lock) |
| Preview com URL de produção | migrations | — | — | **Sim** (`VERCEL_ENV !== production` não migra) |
| SQL inválido em rota rara | rota | 500 com `requestId` | Correção | **Sim** (`verify:sql` na CI) |
| Neon lento | consultas | Telas lentas | — | Parcial (sem timeout explícito por consulta) |
| Integração externa fora | worker/cron | Fila para, dead-letter | Reprocessar | **Sim** (lease, backoff, dead-letter, timeouts em todos os `fetch`) |
| Cron parado | integrações/digest | Trabalho de fundo para | `/api/health` mostra | Parcial (ninguém consulta) |
| Erro inesperado em produção | qualquer | Usuário vê mensagem genérica | — | **Não** (sem alerta) |
| Restauração de backup | banco | — | Ensaio na CI | **Sim** (dump/restore/RLS provados) |

### Ambiente
| Ponto | Dev | Prod | Lacuna? |
|---|---|---|---|
| Banco | `pg` local (`FDP_DB_DRIVER=pg`) | Neon HTTP | Não — dois adaptadores com o mesmo contrato, ambos na CI |
| Anexos | — | Vercel Blob privado | Não |
| Segredos | `.env.example` (117 linhas) | Vercel | Não |
| Migrations | `npm run db:migrate` | `build:deploy` | Não |

### Detalhes
- Fluxo ponta a ponta: APROVADO
- Recuperação de erro: APROVADO
- Integridade de dados: APROVADO
- Paridade de ambiente: APROVADO
- Observabilidade: RESSALVAS

---

## 8. DX Engineer

**Veredito**: Aprovar com mudanças

**Resumo**: aplicada a dois públicos — quem desenvolve o Vinculato e quem integra pela API v1.

### Críticos
| # | Problema | Impacto | Correção |
|---|---|---|---|
| 1 | Testes listados à mão (ver C4) | Teste escrito, commitado e nunca executado | Glob |

### Recomendações
| # | Problema | Por quê | Correção |
|---|---|---|---|
| 1 | Quick Start do README não funciona | `npm run dev` sem banco e sem `FDP_AUTH_SECRET` não abre o painel; os 5 passos reais só aparecem no YAML da CI | Seção "Rodar localmente" ou `npm run dev:local` |
| 2 | Lint 65 s, typecheck 43 s | Ciclo lento antes de abrir PR | `eslint --cache` |
| 3 | Sem `CLAUDE.md` | Ver Repo | — |

### Mensagens de erro
| Cenário | Mensagem atual | Avaliação |
|---|---|---|
| API v1 sem chave | `{"error":"Envie a chave em Authorization: Bearer.","code":"API_KEY_REQUIRED"}` | **Ótima**: diz o que fazer, com código |
| Erro previsto do produto | `COMPETENCE_BLOCKED`, `PLAN_SEAT_LIMIT`… com texto próprio | Ótima |
| Erro inesperado | "Não foi possível concluir a operação" + `requestId` no log | Boa no servidor; no cliente falta mostrar o `requestId` |
| OpenAPI | `/api/v1/openapi.json` responde 200 | Ótimo |

### Jornada de quem desenvolve
- Primeiro uso: **atrito** (setup não documentado).
- Uso diário: testes em 12 s (2.420), CI com ensaios reais e comentários que explicam o porquê de cada passo — excelente.
- Uso avançado: scripts `db:rehearse-*`, `verify:*`, `smoke` — muito completos.

### Detalhes
- Qualidade dos erros: APROVADO
- Padrões e configuração: RESSALVAS
- Teclado: n/a
- Descoberta: RESSALVAS
- Integração com o fluxo: APROVADO

---

## 9. Performance Engineer

**Veredito**: Aprovar com mudanças

### Críticos
| # | Problema | Arquivo(s) | Impacto | Correção |
|---|---|---|---|---|
| 1 | Snapshot completo a cada mudança, com arquivadas sem limite | `lib/fila-dp-db.ts` (`getWorkspaceSnapshot`), `WorkspaceApp.tsx:1566` | Custo de banco e rede proporcional a usuários × alterações × histórico; cresce para sempre | Ver C1 |

### Recomendações
| # | Problema | Arquivo(s) | Por quê | Correção |
|---|---|---|---|---|
| 1 | 2,4 MB de JS sem compressão para Demandas | `WorkspaceApp.tsx` | Parse e execução em notebook/celular modesto | `next/dynamic` por módulo |
| 2 | Polling de 4 s do conector Sankhya sem pausa em aba oculta | `SankhyaConnectorPanel.tsx:61` | Chamadas inúteis | `document.visibilityState` |
| 3 | Snapshot fora do ensaio de volume | `scripts/measure-work-center.mjs` | O caminho mais chamado não tem teto medido | Incluir com 20 mil demandas |

### Orçamento de recursos
| Recurso | Hoje | Preocupação? |
|---|---|---|
| Chamadas na carga do painel | 1 (`/api/workspace`) | Não — ótimo |
| Chamadas por mudança de terceiros | 1 snapshot completo por aba aberta | **Sim** |
| Listeners | 30 `addEventListener` / 30 `removeEventListener` | Não |
| Timers | 4 `setInterval`, todos com limpeza | Não |
| JS na tela de Demandas | ~2,4 MB sem compressão (11 arquivos) | Sim |
| Tempo de navegação entre telas (local) | 1,1–1,6 s até `networkidle` | Aceitável |

### Caminho quente
`/api/realtime?since=` a cada N s por aba (barato) → em mudança, `getWorkspaceSnapshot` (~10 consultas em uma transação com `set_config` do tenant) → `setSnapshot` → re-render total. A consulta de cartões não filtra `archived` nem tem `LIMIT`; checklists e anexos filtram `archived = 0`. As consultas da Central de Trabalho têm teto medido de 500 ms com 20 mil demandas — o snapshot não.

### Detalhes
- Memória: APROVADO
- Rede/IPC: RESSALVAS
- I/O: RESSALVAS
- Inicialização: RESSALVAS
- Sessão longa: APROVADO

---

## 10. Accessibility Engineer

**Veredito**: Aprovar com mudanças

**Resumo**: a CI já audita WCAG 2.2 AA nos dois temas e quatro larguras; 0 botões sem nome acessível na tela de Demandas; `main`, `nav` e `h1` presentes; regiões `aria-live` existem. O defeito real está na gaveta.

### Críticos
| # | Problema | Critério WCAG | Arquivo(s) | Impacto | Correção |
|---|---|---|---|---|---|
| 1 | Foco sai da gaveta (`aria-modal="true"`) no 28º Tab e vai ao `<body>`; Esc devolve o foco a "5 sem responsável", não ao botão "Nova demanda" | 2.4.3 Ordem do foco; 2.1.2 (diálogo modal deve conter o foco) | `app/painel/features/shared/motion.tsx:242-272` | Usuário de teclado/leitor de tela se perde atrás do diálogo | A lista de focáveis filtra por `offsetParent`, então o "último" calculado não é o último real; aplicar `inert` ao restante da página e guardar o gatilho antes de abrir |

### Recomendações
| # | Problema | Critério | Correção |
|---|---|---|---|
| 1 | Sem link "pular para o conteúdo" | 2.4.1 | Link no topo para `<main>` |
| 2 | Cartão arrastável (`<article draggable>`) sem `tabindex`/papel | 2.1.1 | Confirmar caminho por teclado ("Mover" no detalhe) e anunciar a movimentação |
| 3 | `window.confirm` no Campo | — | Diálogo próprio, com foco gerenciado |

### Navegação por teclado (Demandas)
| Passo | Ação | Foco esperado | Resultado |
|---|---|---|---|
| 1 | Tab | Primeiro controle | "Operação DP" (aba) — ok, sem link de pular |
| 2–4 | Tab | Empresa, Busca, Notificações | ok |
| 5 | Enter em "Nova demanda" | Primeiro campo da gaveta | ok (campo de texto) |
| 6 | Tab ×27 | Permanece na gaveta | ok |
| 7 | Tab (28º) | Volta ao primeiro campo | **Falha**: vai para `<body>` |
| 8 | Esc | Gaveta fecha, foco no gatilho | Fecha; **foco errado** |

### Checklist ARIA
| Elemento | Papel | Nome | Estados | Teclado | Notas |
|---|---|---|---|---|---|
| Gaveta de demanda | `dialog` | `aria-labelledby` | `aria-modal=true` | Esc ok | Contenção falha |
| Botões de ícone | `button` | presente (0 sem nome) | — | ok | |
| Paleta de busca | `dialog` | — | — | Esc/Tab | Comentário afirma Tab preso — não medido aqui |
| Campo (iPhone) | — | — | — | — | Nenhum alvo < 44 px |

### Detalhes
- Leitor de tela: APROVADO
- Navegação por teclado: RESSALVAS
- Gestão de foco: RESSALVAS
- Contraste: APROVADO (auditado na CI, dois temas)
- Movimento: APROVADO (31/39 folhas com `prefers-reduced-motion`)
