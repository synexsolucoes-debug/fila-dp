# Evolução estratégica do Vinculato — setembro de 2026

Análise de produto, crítica e propositiva, sobre para onde o Vinculato deve ir.
Ela cruza o estado real do código com uma pesquisa de dores de mercado (DP, RH,
SESMT/SST, EPI, gestores, colaboradores, Financeiro, Jurídico, TI, Compras e
Facilities) e com um benchmark nacional e internacional.

Este documento complementa, e não substitui:

- `docs/arquitetura-operacional.md` — como o trabalho anda hoje;
- `docs/auditoria-estrategica-saas-2026-08.md` — auditoria de SaaS
  (ativação, cobrança, painel admin);
- `docs/vinculato-diagnostico-e-execucao.md` — diagnóstico técnico.

## A conclusão em cinco linhas

1. O motor mais difícil já existe (eventos, processos versionados, Central de
   Trabalho, agentes que só propõem, auditoria, RLS).
2. Falta o que faz o trabalho circular sozinho: **Jornada** (evento de pessoa →
   trabalho em várias áreas), **Requisito** (o que um cargo/risco exige) e
   **Prazo** (tudo que vence).
3. Falta a **porta para quem não é analista**: gestor, colaborador, clínica e
   prestador, por link assinado e notificação externa.
4. **SESMT é o maior buraco e a maior oportunidade** — orquestrar prazos e a
   ponte com o DP, sem emitir documento técnico nem transmitir eSocial.
5. Profundidade em **DP + SST + EPI**; largura via **templates** do motor de
   processos. Nada de módulos para Compras, Facilities, Jurídico e TI.

## Como ler

| Parte | Seções | Conteúdo |
| --- | --- | --- |
| [1](01-resumo-diagnostico-e-dores.md) | 1–4 | Resumo executivo, diagnóstico do Vinculato, problemas empresariais, dores por departamento |
| [2](02-oportunidades-funcionalidades-e-processos.md) | 5–7 | Oportunidades (5 primitivas), funcionalidades sugeridas, 12 processos interdepartamentais |
| [3](03-central-motor-agentes-e-ia.md) | 8–11 | Central de Trabalho, Busca Global, Command Center, Motor de Processos, Agentes e integrações, Marketplace, IA do Vinculato |
| [4](04-documentos-indicadores-alertas-auditoria-ux-mobile.md) | 12–17 | Gestão documental, indicadores, alertas, auditoria, UX (jornadas por perfil, arquitetura funcional, nova navegação), mobile |
| [5](05-benchmark-lacunas-e-ideias.md) | 18–20 | Benchmark, lacunas do produto, o que **não** fazer, ideias novas (20 pequenas, 20 médias, 10 grandes, 10 de IA, 10 automações, 10 integrações, 10 indicadores, 10 de UX) |
| [6](06-matriz-prioridades-templates-roadmap-visao.md) | 21–25 | Matriz de impacto, P0–P3, 36 templates, roadmap em 4 fases, visão de 3 anos, **as 20 melhores oportunidades**, **se eu fosse o PM**, fontes |

Leitura rápida para decisão: Parte 1 §1, Parte 5 §19 e "o que não fazer",
Parte 6 §22 e "Se eu fosse o Product Manager".
