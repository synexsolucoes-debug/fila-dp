import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * O histórico completo da operação (spec: "Ver histórico completo").
 *
 * O registro existia em `fdp_activity_events` desde sempre, sem lugar onde ser
 * lido — o mesmo padrão da ficha do processo em rascunho: o produto guardava o
 * que não mostrava.
 *
 * Estes testes protegem as decisões que separam uma trilha útil de um vazamento:
 * o recorte por empresa, a paginação que não repete nem pula, e o fim de página
 * que não mente.
 */

const rota = await readFile(new URL("../app/api/history/route.ts", import.meta.url), "utf8");
/* Sem comentários: os comentários da rota citam justamente o que ela evita
   ("OFFSET", "deslocamento"), e a asserção casaria com a explicação em vez do
   código. Foi assim que este teste falhou da primeira vez. */
const rotaCodigo = rota.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*\/\/.*$/gmu, "");
const tela = await readFile(
  new URL("../app/painel/features/history/HistoryView.tsx", import.meta.url), "utf8");

test("a trilha herda o recorte por empresa da demanda", async () => {
  /* Sem isto o histórico vira caminho lateral para o que o recorte esconde:
     quem não pode ver a demanda leria, na trilha, o título dela e quem mexeu. */
  assert.match(rota, /getCompanyAccessScope\(d1, workspace\.id, user\.id, workspace\.role\)/u);
  assert.match(rota, /escopo\.unrestricted \|\| escopo\.companyIds\.has\(companyId\)/u);
  assert.match(rota, /requireCapability\(workspace, "cards\.read"\)/u);
});

test("o recorte vem da mesma função que o quadro usa", async () => {
  /* Duas listas de empresas visíveis seriam duas respostas para a mesma
     pergunta, e a segunda a ser esquecida vira o furo. */
  const db = await readFile(new URL("../lib/fila-dp-db.ts", import.meta.url), "utf8");
  assert.match(db, /export async function getCompanyAccessScope/u);
  assert.ok(!/SELECT company_id FROM fdp_member_company_access/u.test(rota),
    "a rota do histórico não pode montar o próprio recorte por empresa");
});

test("a paginação é por cursor de data, não por deslocamento", async () => {
  /* A trilha cresce enquanto alguém a lê: `OFFSET` faria a segunda página
     repetir ou pular linhas conforme eventos novos entrassem no topo. */
  assert.match(rota, /ae\.created_at < NULLIF\(\?, ''\)::timestamptz/u);
  assert.ok(!/OFFSET/u.test(rotaCodigo), "deslocamento repete ou pula linha em lista que cresce");
  assert.match(rota, /ORDER BY ae\.created_at DESC, ae\.id DESC/u,
    "sem desempate por id, duas linhas no mesmo instante podem repetir entre páginas");
});

test("cursor vazio não vira conversão de texto em instante", async () => {
  /* Um `?::timestamptz` sobre parâmetro possivelmente vazio estoura em tempo de
     execução. O guard do repositório pega essa assinatura; `NULLIF` é a forma
     correta, e foi assim que este defeito foi encontrado aqui. */
  assert.match(rota, /NULLIF\(\?, ''\) IS NULL OR/u);
});

test("o fim da trilha é decidido pela consulta, não pelo que sobrou do filtro", async () => {
  /* Se o recorte removeu tudo desta página, ainda pode haver eventos visíveis
     mais atrás. Dizer "acabou" ali esconderia o resto da trilha. */
  assert.match(rota, /const temMais = todas\.length > limite;/u);
  assert.ok(!/permitidas\.length > limite/u.test(rota),
    "medir o fim pelo resultado filtrado interrompe a leitura cedo demais");
});

test("o limite por página tem teto", async () => {
  assert.match(rota, /Math\.min\(Math\.max\(Number\(url\.searchParams\.get\("limite"\)/u);
  assert.match(rota, /const MAXIMO = 200;/u);
});

test("a tela carrega sob demanda, e não junto do snapshot de abertura", async () => {
  /* A trilha cresce sem limite; trazê-la na abertura faria todo mundo pagar por
     uma tela que quase ninguém abre. */
  const db = await readFile(new URL("../lib/fila-dp-db.ts", import.meta.url), "utf8");
  assert.ok(!/\/api\/history/u.test(db));
  assert.match(tela, /fetch\(url, \{ cache: "no-store" \}\)/u);
});

test("carregar mais acrescenta, e não substitui a lista", async () => {
  /* Trocar a lista faz a pessoa perder o lugar onde estava lendo. */
  assert.match(tela, /setEvents\(\(atual\) => \(antesDe \? \[\.\.\.atual, \.\.\.body\.events\] : body\.events\)\)/u);
});

test("o botão de carregar mais só existe quando há mais", async () => {
  assert.match(tela, /\{cursor && !loading && <button type="button" className="history-more"/u);
});

test("evento sem demanda mostra ausência, não célula vazia", async () => {
  /* Célula vazia parece dado que faltou carregar; o traço diz que não há
     demanda associada — é evento do workspace. */
  assert.match(tela, /<span className="history-none">—<\/span>/u);
});

test("a tela não dispara setState síncrono dentro do efeito", async () => {
  /* Chamada síncrona no corpo do efeito dispara re-render em cascata. O padrão
     do repositório é deferir por requestAnimationFrame e cancelar ao desmontar. */
  assert.match(tela, /window\.requestAnimationFrame\(\(\) => \{ void load\(null\); \}\)/u);
  assert.match(tela, /return \(\) => window\.cancelAnimationFrame\(frame\)/u);
});
