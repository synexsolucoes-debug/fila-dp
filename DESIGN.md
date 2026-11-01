# DESIGN.md — site comercial do Vinculato

Vale para as páginas públicas (início, solução, planos, contato e afins).
O painel tem regras próprias em `app/vinculato-shell.css`.

A direção não veio de sites de referência: a sessão em que ela foi escrita não
tinha acesso à internet. Ela parte da marca que já existia (logo, cores e fontes
do produto) e de uma regra: **mostrar o produto real em vez de ilustrar.**

## Ideia

O DP vive de prazos dentro do mês. A página abre com a régua do mês (salário até
o 5º dia útil, eSocial no dia 15, FGTS no dia 20, conferência e fechamento) e
logo abaixo mostra a tela de verdade em que esse trabalho acontece. Todo o resto
fica quieto.

## Cor

Cada cor tem um papel só. Valores em `app/home.module.css`, bloco `.page`.

| Token | Valor | Papel |
| --- | --- | --- |
| `--ink` | `#18223A` | Superfícies escuras (topo, segurança, rodapé) e títulos |
| `--paper` | `#F6F8FC` | Fundo da página |
| `--surface` | `#FFFFFF` | Blocos e tabelas sobre o fundo |
| `--text` | `#172033` | Texto principal |
| `--soft` | `#55627A` | Texto secundário (5,8:1 sobre o fundo) |
| `--line` | `#E2E8F0` | Bordas e divisórias |
| `--blue` | `#365CF5` | Botões e links. Nada mais |
| `--teal` / `--teal-on-ink` | `#16A394` / `#4FD1BF` | Só "feito" ou "disponível" |
| `--amber` | `#F2B356` | Só "próximo prazo", e só sobre `--ink` |
| `--on-ink` / `--on-ink-soft` | `#F4F7FB` / `#B9C4D6` | Texto sobre `--ink` |

Sem gradiente decorativo. O único degradê é a barra de progresso da régua, que
vai do feito (turquesa) ao próximo prazo (âmbar) e por isso diz algo.

Modo escuro: a página é clara por decisão. As superfícies escuras são trechos
dela, não um tema.

## Tipografia

| Papel | Família | Uso |
| --- | --- | --- |
| Títulos | Manrope 700 | `h1` e `h2`, entreletra −0,02em a −0,03em |
| Texto | Inter 400/600 | Tudo que se lê; corpo de 16px ou mais |
| Dados | IBM Plex Mono 500 | Dias, datas, prazos e situação. Nunca em rótulo de seção |

Escala: 13 · 14 · 16 · 18 · 22 · 32 · 48 · 72 px (o `h1` varia entre 44 e 80).
Linhas de texto com até 68 caracteres.

## Espaço

Base de 8px. Seções com 96px de respiro no computador e 64px no celular.
Conteúdo até 1200px, margem lateral de `clamp(16px, 5vw, 72px)`.

## Forma e profundidade

- Cantos: 8px em botões e campos, 12px em blocos, 14px no quadro das telas.
- Sombra: uma só, e só nas telas do produto.

## Componentes

- **Botão principal:** azul cheio, 48px de altura. Ao pressionar, `scale(.97)`.
- **Botão secundário:** contorno, mesma altura.
- **Link de texto:** azul, sublinhado no hover (só com mouse).
- **Tabela:** linhas com divisória, cabeçalho em `--soft`, sem zebra.
- **Selo de situação:** fonte de dados, fundo leve na cor do estado.
- **Foco:** contorno azul de 2px com 3px de afastamento, em todo item clicável.

## Imagens

- Telas reais do painel, com dados fictícios, em `public/site/`.
- Nenhuma ilustração, foto de banco de imagem ou emoji.
- Ícones `lucide-react` só onde informam (seta de link, check de "feito").

## Texto

- Títulos dizem o assunto ("Para quem é", "Planos"), sem frase de efeito.
- Sem rótulo acima de cada título.
- Nada de número, depoimento ou logo de cliente que não seja real.
