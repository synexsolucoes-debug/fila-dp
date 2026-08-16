import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

/**
 * §41: os três estados de tela, em toda tela.
 *
 * Carregando, vazio e erro. A medição feita depois da §16 mostrou que todos os
 * oito módulos do painel e as nove áreas do console já os têm — o trabalho de
 * unificar os componentes entregou isso de lado, porque passou a ser mais fácil
 * usar `LoadingState`/`EmptyState`/`ErrorBanner` do que escrever à mão.
 *
 * Este teste existe para que continue assim. Ele confere que a ramificação
 * existe no código, não que ela renderize certo — quem prova a renderização é a
 * conferência de acessibilidade, que percorre 59 telas contra o produto de pé.
 */

const PAINEL = new URL("../app/painel/features/", import.meta.url);
const CONSOLE = new URL("../app/plataforma/features/", import.meta.url);

/** A tela principal de cada módulo do painel. */
const telasDoPainel: Array<[string, string]> = [
  ["auxiliary", "AuxiliaryModulesView.tsx"],
  ["operations", "OperationsView.tsx"],
  ["registrations", "RegistrationsView.tsx"],
  ["integrations", "IntegrationsView.tsx"],
  ["payments", "PaymentsView.tsx"],
  ["time", "TimeTrackingView.tsx"],
];

// Aceita o componente compartilhado ou uma mensagem própria: o que importa é a
// pessoa não ficar diante de uma tela em branco sem saber se está carregando,
// se não há nada, ou se algo quebrou.
// `if (loading)` conta tanto quanto `loading && …`: a forma de escrever o
// desvio não muda o que a pessoa vê. Escrevi este detector estreito primeiro e
// ele acusou `AccessView`, que tem o estado — a correção seria trocar código
// que funciona por código que passa no teste, que é o avesso do objetivo.
const temCarregando = (fonte: string) => /<Loading(State)?\b|loading &&|\.loading \?|isLoading|if \(loading\)/u.test(fonte);
const temVazio = (fonte: string) => /<Empty(State)?\b|compactEmpty|noteLine|Nenhum[ao]?\s/u.test(fonte);
const temErro = (fonte: string) => /<Error(Banner|State)\b|role="alert"/u.test(fonte);

test("toda tela do painel tem carregando, vazio e erro", async () => {
  const faltando: string[] = [];
  for (const [module_, arquivo] of telasDoPainel) {
    const fonte = await readFile(new URL(`${module_}/${arquivo}`, PAINEL), "utf8");
    const ausentes = [
      temCarregando(fonte) ? "" : "carregando",
      temVazio(fonte) ? "" : "vazio",
      temErro(fonte) ? "" : "erro",
    ].filter(Boolean);
    if (ausentes.length) faltando.push(`${module_}: sem ${ausentes.join(", ")}`);
  }
  assert.deepEqual(faltando, []);
});

test("toda área do console tem os mesmos três estados", async () => {
  const arquivos = (await readdir(CONSOLE)).filter((nome) => nome.endsWith("Feature.tsx"));
  assert.ok(arquivos.length >= 9, `o console encolheu para ${arquivos.length} áreas — confira se foi de propósito`);
  const faltando: string[] = [];
  for (const arquivo of arquivos) {
    const fonte = await readFile(new URL(arquivo, CONSOLE), "utf8");
    const ausentes = [
      temCarregando(fonte) ? "" : "carregando",
      temVazio(fonte) ? "" : "vazio",
      temErro(fonte) ? "" : "erro",
    ].filter(Boolean);
    if (ausentes.length) faltando.push(`${arquivo}: sem ${ausentes.join(", ")}`);
  }
  assert.deepEqual(faltando, []);
});

test("o estado de carregamento se anuncia a quem não vê a tela", async () => {
  // Sem `role="status"`, quem usa leitor de tela ouve silêncio entre o clique e
  // a chegada dos dados, e não sabe se a ação foi registrada.
  const shared = await readFile(new URL("shared/panel-ui.tsx", PAINEL), "utf8");
  assert.match(shared, /role="status" aria-live="polite"/u);
});

test("o detector aceita mensagem própria, não só o componente", async () => {
  // Contraprova: a área de visão geral do console escreve o vazio à mão
  // ("Nenhum evento administrativo recente"). Um detector que só procurasse
  // `<Empty>` a acusaria de falta que não existe, e a correção seria trocar
  // código que funciona por código que passa no teste.
  const overview = await readFile(new URL("OverviewFeature.tsx", CONSOLE), "utf8");
  assert.doesNotMatch(overview, /<Empty\b/u);
  assert.ok(temVazio(overview), "o detector precisa reconhecer o vazio escrito à mão");
});

test("o contador da aba conta o que a aba contém (§20)", async () => {
  // A aba "Atividade" traz comentários **e** o histórico da demanda — quem
  // mudou prazo, quem moveu de coluna, quando saiu de análise. O selo contava
  // só os comentários: alguém via "Atividade 2" com quinze eventos dentro.
  //
  // O histórico já existia; foi o que fui conferir antes de propor construir
  // uma linha do tempo que o produto já tinha.
  const painel = await readFile(new URL("../app/painel/WorkspaceApp.tsx", import.meta.url), "utf8");
  assert.match(painel, /Atividade <b>\{selectedCard\.comments\.length \+ selectedCard\.activities\.length\}<\/b>/u);
  assert.match(painel, /HISTÓRICO DA DEMANDA/u);
  // O que importa é a ORIGEM do número, não a grafia: a asserção fixava
  // "evento(s)" e reprovou quando a concordância foi corrigida — reprovando
  // por melhoria de texto, não por defeito de contagem.
  assert.match(painel, /plural\(selectedCard\.activities\.length, "evento", "eventos"\)/u);
  // O histórico mostra ator, o que mudou e quando — não só que algo mudou.
  assert.match(painel, /activityDetails\(activity\)/u);
  assert.match(painel, /\{activity\.actorName\}<\/strong> \{activityLabel\(activity\)\}/u);
});
