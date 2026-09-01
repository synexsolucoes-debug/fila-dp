import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { allProcessViews, isKnownView, processGroups, workspaceHomeView } from "../lib/process-navigation.ts";

/**
 * Favoritos e recentes por pessoa (§67).
 *
 * O menu ficou fundo quando passou a agrupar por processo: sete processos e
 * mais de vinte destinos, dois níveis para alcançar qualquer um. Quem trabalha
 * em três destinos o dia inteiro paga esse preço dezenas de vezes por dia.
 *
 * Três coisas não podem depender de disciplina de quem escrever a próxima
 * rota, e são elas que estes testes prendem:
 *
 *  1. **o atalho é da pessoa.** A identidade de quem escreve vem da sessão, e
 *     o isolamento por grupo é o mesmo do resto do banco.
 *  2. **atalho não fura permissão.** Um destino favoritado antes de o plano
 *     mudar não pode continuar aparecendo no menu (§30).
 *  3. **chave inventada não entra.** Sem isso a tabela guarda texto qualquer e
 *     o menu mostra um atalho para lugar nenhum.
 */

const migration = await readFile(new URL("../drizzle/postgres/0052_user_module_shortcuts.sql", import.meta.url), "utf8");
const route = await readFile(new URL("../app/api/shortcuts/route.ts", import.meta.url), "utf8");
const hook = await readFile(new URL("../app/painel/features/shared/use-shortcuts.ts", import.meta.url), "utf8");
const shell = await readFile(new URL("../app/painel/WorkspaceApp.tsx", import.meta.url), "utf8");

test("a tabela isola por grupo com RLS forçada, como todas as outras", () => {
  assert.match(migration, /CREATE TABLE "fdp_user_module_shortcuts"/u);
  assert.match(migration, /ALTER TABLE "fdp_user_module_shortcuts" ENABLE ROW LEVEL SECURITY/u);
  // FORCE é o que faz a política valer também para o dono da tabela. Sem ela, a
  // conexão da aplicação passa por cima do isolamento sem erro nenhum.
  assert.match(migration, /ALTER TABLE "fdp_user_module_shortcuts" FORCE ROW LEVEL SECURITY/u);
  assert.match(migration, /CREATE POLICY "fdp_user_module_shortcuts_workspace_isolation"/u);
  // Uma linha por pessoa e destino: sem a chave composta, visitar duas vezes
  // criaria duas linhas e os recentes repetiriam o mesmo destino.
  assert.match(migration, /PRIMARY KEY \("workspace_id","user_id","view_key"\)/u);
  // A pessoa precisa ser membro do grupo — e sair do grupo leva os atalhos.
  assert.match(migration, /REFERENCES "public"\."fdp_workspace_members"\("workspace_id","user_id"\) ON DELETE cascade/u);
});

test("a rota escreve com a identidade da sessão e recusa tela que não existe", () => {
  assert.match(route, /const \{ d1, workspace, user \} = await getWorkspaceContext\(auth\.user\)/u);
  assert.match(route, /if \(!isKnownView\(view\)\) throw ApiError\.badRequest/u);
  // Nenhuma escrita aceita grupo ou pessoa vindos do corpo do pedido.
  assert.doesNotMatch(route, /body\.userId|body\.workspaceId/u);
  for (const escrita of route.matchAll(/INSERT INTO fdp_user_module_shortcuts|UPDATE fdp_user_module_shortcuts/gu)) {
    assert.ok(escrita, "escrita encontrada");
  }
  assert.match(route, /\.bind\(workspace\.id, user\.id, view/u);
});

test("o teto de favoritos existe e é dito em vez de ignorado", () => {
  // Uma lista de favoritos sem limite deixa de ser lista de favoritos e vira o
  // menu de novo. E um teto que recusa em silêncio faz o botão parecer quebrado.
  assert.match(route, /MAXIMO_DE_FAVORITOS = \d+/u);
  assert.match(route, /SHORTCUT_LIMIT/u);
  assert.match(route, /Remova um para adicionar outro/u);
  assert.match(hook, /setNotice\(String\(payload\.error/u);
  assert.match(shell, /shortcuts\.notice && <div className="workspace-toast error" role="alert">/u);
});

test("desmarcar um favorito não apaga a passagem por ali", () => {
  /* Apagar a linha faria o destino sumir também dos recentes — uma segunda
     coisa que a pessoa não pediu ao clicar na estrela. */
  assert.match(route, /UPDATE fdp_user_module_shortcuts SET favorite = 0/u);
  assert.doesNotMatch(route, /DELETE FROM fdp_user_module_shortcuts/u);
});

test("o atalho não fura permissão: o recorte é o mesmo do menu (§30)", () => {
  /* A rota devolve chaves sem recortar por plano ou papel — de propósito, para
     a decisão de acesso continuar sendo uma só. Quem aplica é o painel, com o
     mesmo `visibleViews` que monta o menu. Se este filtro sumir, um destino
     favoritado antes de o plano mudar continua aparecendo. */
  assert.match(shell, /const visible = new Set\(visibleViews\);/u);
  assert.match(shell, /shortcuts\.favorites\.filter\(\(id\): id is View => visible\.has\(id as View\)\)/u);
  assert.match(shell, /visible\.has\(id as View\) && !fixed\.has\(id\)/u);
});

test("a lista de telas conhecidas cobre o menu inteiro, e só ele", () => {
  const todas = allProcessViews();
  assert.ok(todas.includes(workspaceHomeView), "a home é destino válido");
  for (const group of processGroups) {
    for (const view of group.views) {
      assert.ok(isKnownView(view), `${view} está no menu e a rota recusaria`);
    }
  }
  assert.equal(isKnownView("naoExiste"), false);
  assert.equal(isKnownView(""), false);
  assert.equal(isKnownView(42), false);
  // Sem repetição: uma tela em dois processos seria ambiguidade de navegação, e
  // aqui ela apareceria como chave duplicada.
  assert.equal(new Set(todas).size, todas.length, "há tela repetida entre processos");
});

test("os atalhos têm porta, e ela não aparece vazia", () => {
  /* Um rótulo "ATALHOS" sobre nada anuncia uma seção que não existe — e no
     primeiro dia de uso é exatamente isso que haveria.

     A faixa de atalhos da home saiu com a maquete, que refez a Visão geral com
     quatro blocos. Sobrou a da barra lateral, que é onde ela sempre esteve à
     mão em qualquer tela — a da home só valia enquanto a pessoa estivesse na
     home. A guarda continua: se o grupo da barra lateral também sumir, os
     favoritos viram um recurso sem porta. */
  assert.match(shell, /\{\(shortcutViews\.favorites\.length > 0 \|\| shortcutViews\.recents\.length > 0\) && \(/u);
  assert.match(shell, /className="sidebar-nav-group sidebar-shortcuts"/u);
  assert.doesNotMatch(shell, /className="workspace-shortcuts"/u,
    "a faixa da home voltou: ou ela some, ou a maquete não é mais a referência");
  // E há onde fixar: sem o botão, favorito seria um recurso sem porta.
  assert.match(shell, /className="process-context-pin"/u);
  assert.match(shell, /aria-pressed=\{shortcuts\.isFavorite\(view\)\}/u);
});

test("a visita entra com atraso, para passagem não virar recente", () => {
  /* Quem passa por uma tela a caminho de outra não esteve nela. Sem o atraso,
     os recentes enchem de passagens e param de apontar para onde a pessoa
     estava trabalhando. */
  assert.match(hook, /DEMORA_ATE_CONTAR_COMO_VISITA = \d+/u);
  assert.match(hook, /window\.setTimeout\(/u);
  assert.match(hook, /return \(\) => window\.clearTimeout\(timer\);/u);
  // E fica no banco, não no navegador: a mesma pessoa em dois computadores é
  // uma pessoa só.
  // O padrão olha para uso, não para a palavra: o comentário do próprio módulo
  // explica por que `localStorage` foi recusado, e explicar não é usar.
  assert.doesNotMatch(hook, /\b(localStorage|sessionStorage)\s*\./u);
});
