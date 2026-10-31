# Engenharia reversa do design: Centi (gestão pública) e SAP Fiori, aplicada ao Vinculato

> **O que é este documento.** Uma leitura do *desenho de interface* de dois
> ERPs que o público do Vinculato conhece — o sistema de gestão pública
> municipal da Centi e o SAP (Fiori) — para decidir o que o Vinculato adota, o
> que não adota e por quê. A engenharia reversa *funcional* do SAP está em
> `docs/engenharia-reversa-sap-hcm.md`; esta é a parte visual e de interação.
>
> **Método e limites.**
>
> - **SAP Fiori:** o sistema de design é público (SAP Fiori Design Guidelines,
>   experience.sap.com / sap.com/design-system). Os padrões descritos aqui
>   — shell bar, dynamic page, list report, object page, densidades, cores
>   semânticas — vêm dessa documentação. Nenhum código ou arte da SAP foi
>   copiado.
> - **Centi:** a Centi Soluções (Goiânia/GO) publica só material comercial. O
>   que ela afirma do próprio sistema: é **web**, "acessível a qualquer hora e
>   de qualquer lugar, através da internet no computador, tablet ou
>   smartphone", "um sistema único que abrange toda a gestão municipal em uma
>   única plataforma", "totalmente integrado entre os módulos", com folha,
>   contabilidade, compras, licitação, patrimônio, protocolo, frotas,
>   tributos, portais (cidadão, professor, saúde) e exportações para órgãos de
>   controle (SIOPE, SIOPS, SICONFI). Nenhuma tela, CSS ou paleta é publicada.
>   Por isso os padrões atribuídos à Centi abaixo são os **da família de ERPs
>   de gestão pública** a que ela pertence (o que o servidor de DP de prefeitura
>   reconhece de qualquer um deles), e estão marcados como tal. Onde houver
>   acesso a uma instalação, vale conferir e corrigir este texto.
>
> **Primeiro resultado em código:** densidade compacta, barra de status e
> cabeçalho dinâmico — `app/design-centi-sap.css`, `lib/density.ts` e a casca
> em `app/painel/WorkspaceApp.tsx` (§5).

## Sumário

1. [Por que esses dois](#1-por-que-esses-dois)
2. [SAP Fiori: anatomia](#2-sap-fiori-anatomia)
3. [ERP de gestão pública (Centi): anatomia](#3-erp-de-gestão-pública-centi-anatomia)
4. [Comparativo com o Vinculato](#4-comparativo-com-o-vinculato)
5. [O que foi aplicado](#5-o-que-foi-aplicado)
6. [O que não copiar](#6-o-que-não-copiar)
7. [Próximos passos](#7-próximos-passos)

---

## 1. Por que esses dois

Quem opera DP chega ao Vinculato vindo de um destes mundos:

- **Empresa privada de médio/grande porte** → SAP (HCM ou SuccessFactors),
  hoje vestido de Fiori.
- **Prefeitura, câmara, autarquia** → um ERP de gestão pública (Centi, e os
  equivalentes regionais), onde folha é um módulo ao lado de contabilidade,
  tributos e compras.

Os dois resolvem o mesmo problema de interface — muita informação densa, lida
linha a linha, com contexto (empresa/entidade, período) que muda o sentido de
todo número — e chegaram a respostas parecidas por caminhos diferentes. O
Fiori formalizou; o ERP público sedimentou pelo uso. Onde os dois concordam,
o Vinculato tem um bom motivo para concordar também.

---

## 2. SAP Fiori: anatomia

### 2.1 Shell bar

Faixa fixa no topo de **todo** aplicativo: logotipo, título do app, busca
corporativa, notificações, assistente (Joule), avatar. Sempre visível; é o que
faz dezenas de aplicativos parecerem um produto só.

**Vinculato:** já tem o equivalente em `.dashboard-header` — local, busca
global (⌘K), notificações, ajuda/assistente, perfil e troca de módulo. Nada a
mudar de estrutura.

### 2.2 Launchpad (tiles por papel)

A entrada é uma grade de *tiles* agrupados por papel: cada tile é um
aplicativo, e pode carregar um número vivo (KPI tile). O que a pessoa vê
depende do papel dela.

**Vinculato:** a janela de módulos (`ModuleLauncher`) depois da entrada e o
menu lateral filtrado por capacidade (`lib/authorization.ts`) cumprem esse
papel. O que falta do Fiori é o número vivo no tile — anotado em §7.

### 2.3 Floorplans

O Fiori não desenha telas: escolhe uma planta.

| Planta | Para quê | Estrutura |
| --- | --- | --- |
| **List report** | Achar e selecionar objetos | Barra de filtros (com *variantes* salvas) + tabela + ações na barra da tabela |
| **Object page** | Ver/editar um objeto | Cabeçalho com título, status e KPIs; barra de âncoras; seções; rodapé com ações |
| **Worklist** | Trabalhar uma fila | Tabela com abas de status e contagem |
| **Overview page** | Visão de cartões | Cartões analíticos e de lista |
| **Wizard** | Criação guiada | Etapas numeradas, revisão no fim |

Todas, menos o wizard, assentam sobre a **dynamic page** (§2.4).

**Vinculato:** o quadro de demandas é uma worklist; Cadastros é um list
report (inclusive com recortes salvos — o "variant management" do Fiori,
`vinculato-quadro-recortes`); o Histórico funcional é uma object page; a
admissão guiada é um wizard. A tradução já existe; o que faltava era o
comportamento comum da dynamic page.

### 2.4 Dynamic page

Cabeçalho em duas partes: **título** (sempre visível) e **conteúdo do
cabeçalho** (filtros, KPIs, descrição), que **recolhe quando a pessoa rola** e
volta quando ela sobe. Rodapé opcional com as ações finais (salvar,
cancelar), sempre à vista.

O efeito prático: em qualquer ponto de uma tabela longa a pessoa sabe em que
tela está e tem a ação principal a um clique, sem pagar a altura do cabeçalho
inteiro o tempo todo.

### 2.5 Densidade: *cozy* × *compact*

Toda tela existe em duas densidades com o mesmo desenho. Controles com
2,75rem (44px) na confortável — alvo de toque — e 2rem (32px) na compacta,
para desktop com mouse. A escolha é do usuário (ou do dispositivo), não da
tela.

### 2.6 Cor semântica

Quatro estados com significado fixo em todo o produto — *positive* (verde),
*critical* (âmbar), *negative* (vermelho), *information* (azul) — e a cor da
marca nunca é usada para dizer estado.

**Vinculato:** a mesma regra já está nos tokens (`--ui-success`,
`--ui-warning`, `--ui-danger`, e `--ui-status-doing` separado do azul da marca
em `app/globals.css`). Confirmado, nada a mudar.

### 2.7 Message strip e mensagens

Aviso em faixa no topo da área de conteúdo, com tom semântico, em vez de
modal. Erros de formulário presos ao campo.

**Vinculato:** `workspace-switched-notice` e os avisos de tela já seguem a
faixa; o padrão está coerente.

---

## 3. ERP de gestão pública (Centi): anatomia

> Os itens 3.1 e 3.2 são o que a própria Centi publica. De 3.3 em diante são
> padrões da família de ERPs de gestão pública (ver *Método e limites*).

### 3.1 Sistema único, módulos lado a lado

A promessa central: "um sistema único que abrange toda a gestão municipal em
uma única plataforma", "totalmente integrado entre os módulos". Folha não é um
produto: é um módulo ao lado de contabilidade, compras e tributos, e a folha
calculada vira lançamento contábil sem exportação manual.

**Vinculato:** é o mesmo desenho que levou ao modo ERP DP e ao Sistema PJ — o
mesmo painel recortado por módulo, com a janela de módulos para trocar.

### 3.2 Web em qualquer dispositivo

"Computador, tablet ou smartphone, em diversos navegadores." O Vinculato já é
assim, e ainda tem o app de mesa (`desktop/`) para quem quer ícone na área de
trabalho.

### 3.3 Contexto de exercício, entidade e competência

Num ERP público, **nenhuma tela se abre sem contexto**: entidade (prefeitura,
fundo, câmara), exercício (o ano orçamentário) e, na folha, competência. O
contexto é escolhido na entrada e fica visível o tempo inteiro, porque o mesmo
cadastro lido no exercício errado é outro dado.

### 3.4 Barra de status

Rodapé fixo, herança dos sistemas de mesa, com o que o topo não comporta:
entidade, exercício, usuário logado, data do sistema, às vezes a base de dados
e a versão. Ninguém olha para ela até precisar — e quando precisa (*"estou
no exercício certo?"*, *"com qual usuário estou?"*), é o único lugar que
responde sem clique.

### 3.5 Densidade alta como padrão

Grade compacta, linhas baixas, muitos campos por tela. É uma tela feita para
quem passa o dia nela conferindo valores, não para quem a visita.

### 3.6 Barra de ações padronizada

Novo, Alterar, Excluir, Gravar, Cancelar, Pesquisar, Imprimir — sempre na
mesma ordem e no mesmo lugar, frequentemente com tecla de função. O usuário
aprende a barra uma vez e opera qualquer módulo.

### 3.7 Relatórios pré-definidos e exportações legais

Tela de relatório com parâmetros (período, entidade, filtro) e saída em PDF;
exportações com nome de órgão (SIOPE, SIOPS, SICONFI). O relatório é um
módulo, não um botão escondido.

---

## 4. Comparativo com o Vinculato

| Padrão | Fiori | Gestão pública | Vinculato antes | Decisão |
| --- | --- | --- | --- | --- |
| Faixa superior fixa | Shell bar | Menu + barra de título | `.dashboard-header` | Mantém |
| Entrada por módulos | Launchpad | Menu de módulos | Janela de módulos | Mantém; número vivo no tile em §7 |
| Contexto sempre visível | Contexto no título | Entidade/exercício/competência na barra de status | Só empresa no topo; competência só no quadro | **Aplicado:** barra de status (§5.2) |
| Título preso, cabeçalho recolhe | Dynamic page | — | Título rola junto | **Aplicado:** cabeçalho dinâmico (§5.3) |
| Densidade | Cozy/compact | Sempre compacta | Só confortável | **Aplicado:** preferência de densidade (§5.1) |
| Cor de estado ≠ cor da marca | Semantic colors | Variável | Já separado nos tokens | Mantém |
| Recortes salvos | Variant management | Raro | Recortes do quadro | Mantém; levar a Cadastros em §7 |
| Ações finais sempre à vista | Footer toolbar | Barra de ações fixa | Botões no fim do formulário | §7 |
| Teclas de atalho | Poucas | Teclas de função | ⌘K, atalhos de módulo | Mantém |
| Relatório como módulo | Analytical list page | Tela de relatórios | Relatório do DP Operacional | Mantém |

---

## 5. O que foi aplicado

Tudo em uma camada própria, `app/design-centi-sap.css`, carregada depois de
`interface-refresh.css`. Nenhuma cor nova — só tokens `--ui-*`, que o tema
escuro já redefine e a auditoria de contraste já mede. Cada bloco se desfaz
apagando-o.

### 5.1 Densidade compacta (Fiori *compact*; padrão dos ERPs públicos)

- Botão na barra lateral, ao lado do tema: **Confortável ↔ Compacta**.
- `data-density="compact"` na casca aperta altura de faixa superior, recuo da
  coluna, células de tabela (5px × 10px), controles (32px), itens do menu e
  cartões do quadro. Fonte, cor e desenho não mudam.
- Na compacta, a linha da tabela sob o ponteiro ganha um realce leve (tinta do
  azul da casca), para o olho não trocar de linha numa grade apertada.
- 32px fica acima dos 24px da WCAG 2.5.8 (alvo mínimo).
- Preferência por navegador em `localStorage` (`vinculato-densidade`), lida
  sem confiar no valor guardado (`lib/density.ts`). Não vai a cookie como o
  tema porque não muda cor: não há lampejo a evitar.

### 5.2 Barra de status (ERP público §3.4)

Rodapé fixo da coluna principal, de 761px para cima:

**Sistema · Entidade · Empresa · Exercício · Competência · Usuário (papel) ·
Data · sincronização**

- *Entidade* é o grupo/workspace; *Empresa* é o recorte do seletor do topo;
  *Competência* é a primeira competência não fechada (a mesma que o quadro já
  usa); *Exercício* é o ano dela.
- Exercício, competência e data em fonte de dados (monoespaçada, tabular).
- Até 1440px saem Sistema e Exercício; até 1100px saem também Entidade e
  Usuário (já estão na barra lateral); abaixo de 761px a barra some (o rodapé
  ali é a navegação inferior). No modo foco do quadro ela também some.
- Contraste medido: rótulo 6,15:1 no claro e 8,96:1 no escuro; valor
  16,27:1 e 14,22:1.

### 5.3 Cabeçalho dinâmico (Fiori *dynamic page*)

- O cabeçalho padrão das telas (`.dashboard-heading`) fica preso no topo da
  coluna de conteúdo: título e ação principal sempre à vista.
- A descrição recolhe nos primeiros 64px de rolagem e volta ao subir, com
  `animation-timeline: scroll()` — sem JavaScript. Navegador sem suporte
  recebe só o título preso.
- `prefers-reduced-motion` desliga o recolhimento animado.
- Telas que desenham o próprio cabeçalho (`header.ownHeader`) não são
  afetadas.

### 5.4 Launchpad na janela de módulos (Fiori §2.2, próximo passo 2)

- Tiles agrupados pelo tipo de trabalho — **Processos, Áreas, Sistemas,
  Apoio** —, que é o `kind` de `lib/process-navigation.ts` mais o ERP DP como
  sistema.
- Número vivo no rodapé do tile, calculado do snapshot já carregado (nenhuma
  consulta a mais): demandas abertas na Operação DP, competências em andamento
  em Pagamentos, obrigações vencidas no ERP DP (em vermelho quando há). Módulo
  sem número honesto fica sem número.
- Campo **Buscar módulo** (sem acento e sem caixa); Enter abre o primeiro
  resultado. Recebe o foco só com ponteiro fino — no celular abriria o teclado
  por cima dos tiles.
- A entrada no sistema não tem mais abertura animada do logotipo: o login vai
  direto para esta janela.

### 5.5 Cálculos como object page (próximo passo 1)

- Cabeçalho de objeto com nome inteiro, matrícula e empresa, no lugar de
  "matrícula · nome".
- Tipo de cálculo em controle segmentado; a rescisão separa **Desligamento**
  de **Saldos e médias** (opcionais).
- **Rodapé de ações** preso à área visível (footer toolbar) com Calcular; no
  celular volta ao fluxo para não disputar a base da tela com a navegação.
- O líquido é a resposta da tela: número grande, sozinho, com proventos,
  descontos e FGTS ao lado. A tela rola até o resultado depois do cálculo.

### 5.6 Abas de módulos (ERP de mesa) e faixa única

O pedido do cliente foi "sistematização de janelas": o modelo escolhido é o
dos ERPs de mesa (Centi, SAP GUI), com uma aba por módulo aberto.

- **Sem barra lateral.** Com a janela de módulos (§5.4) e as abas, ela
  repetia a mesma navegação pela terceira vez. A faixa superior é única:
  marca, **Módulos**, abas abertas e, à direita, empresa, busca, avisos,
  ajuda e conta.
- **Cada módulo aberto vira aba** e guarda a última tela; a tela continua
  montada enquanto a aba existir, então trocar de aba não perde filtro,
  rolagem nem o que estava preenchido (`keepAlive` em `WorkspaceApp.tsx`).
  ERP DP e Administração também são abas. Até 8, por grupo, no navegador.
- **Dentro do módulo**, as telas são as abas do cabeçalho do processo.
- **Seletor de empresa** próprio (nome curto, razão social e CNPJ, busca) no
  lugar do `<select>` nativo com "★" e "↳".
- **Menu da conta** com opções nomeadas — tema, densidade, grupo,
  Administração, perfil, trocar de conta, sair — no lugar dos cinco ícones
  sem rótulo do pé da barra lateral.
- Padrão visual comum em `app/vinculato-shell.css`: uma família tipográfica,
  títulos de 20px, superfícies chapadas, raio 6–8px, caixa normal (sem
  rótulos em caixa alta), texto mínimo de 11–12px e um acento só.

### 5.7 Travas

`tests/density-preference.test.mts`: vocabulário da densidade, ordem de carga
da folha, ausência de cor crua na camada e os seis rótulos da barra de status.

---

## 6. O que não copiar

- **Ícones e cores do Fiori (Horizon).** O Vinculato tem identidade própria
  (§88, `app/globals.css`); copiar a paleta faria o produto parecer um SAP genérico.
  Copia-se o *comportamento*, não a pele.
- **Transações e códigos** (PA30, F-keys como única via). Atalho é bom;
  depender dele é a curva de aprendizado que o Vinculato existe para evitar.
- **Seleção de contexto em tela de entrada bloqueante** (escolher exercício
  antes de ver qualquer coisa). No Vinculato o contexto tem padrão razoável
  (competência aberta, todas as empresas) e se troca a qualquer momento.
- **Barra de ações CRUD genérica** em toda tela. As telas do Vinculato têm uma
  ação principal nomeada ("Novo colaborador", "Lançar movimento"), que diz
  mais que "Novo".
- **Janelas sobrepostas (MDI).** Herança de desktop que não sobrevive à web nem
  ao celular.

---

## 7. Próximos passos

1. **Rodapé de ações (footer toolbar)** nos formulários longos — feito em
   Cálculos (§5.5); faltam cadastro de colaborador e ficha de admissão:
   Gravar/Cancelar presos ao rodapé enquanto houver alteração não gravada.
2. ~~**Número vivo nos tiles** da janela de módulos~~ — feito (§5.4). Falta
   número nos módulos de área (EPI, Segurança), que hoje não vêm no snapshot.
3. **Variantes em Cadastros e Folha**, reaproveitando os recortes salvos do
   quadro.
4. **Seletor de competência na barra de status** (clicar na competência abre a
   troca), quando o painel passar a aceitar competência diferente da aberta.

## Fontes

- SAP Fiori Design Guidelines — best practices, floorplans e dynamic page:
  <https://www.sap.com/design-system/fiori-design-web/v1-142/discover/sap-products/sap-s4hana-only/best-practices-for-designing-sap-fiori-apps>
- SAP Learning — *Working with SAP Fiori Design Guidelines*:
  <https://learning.sap.com/courses/ui-development-with-sap-fiori/working-with-sap-fiori-design-guidelines_ab11c169-54de-4f51-87b9-f61c8a5198be>
- Centi — portal: <https://www.centi.com.br/portal/>
- Centi — *Quais os diferenciais do sistema de gestão pública da Centi?*:
  <https://www.centi.com.br/portal/2019/09/quais-os-diferenciais-do-sistema-de-gestao-publica-da-centi/>
- Centi — página comercial do sistema: <https://marketing.centi.com.br/sistema/sistema-geral.html>
