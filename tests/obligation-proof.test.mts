import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { validEvidenceUrl } from "../lib/operations.ts";

/**
 * §24 pede protocolo e evidência na obrigação. Nenhum dos dois existia: os dez
 * campos pedidos eram sete, e o protocolo cabia em `notes`, texto livre.
 *
 * Isso importa mais aqui do que pareceria. O Vinculato controla a obrigação e
 * **não transmite** ao portal — decisão do produto, dita por escrito nos Termos.
 * A consequência é que o protocolo devolvido pelo portal é a única prova de que
 * a obrigação foi cumprida: sem campo estruturado, "concluída" é a palavra de
 * alguém, e não há como perguntar quais obrigações da competência fecharam sem
 * comprovante.
 */

const migration = await readFile(new URL("../drizzle/postgres/0041_obligation_protocol_evidence.sql", import.meta.url), "utf8");
const criar = await readFile(new URL("../app/api/operations/obligations/route.ts", import.meta.url), "utf8");
const editar = await readFile(new URL("../app/api/operations/obligations/[id]/route.ts", import.meta.url), "utf8");

test("evidência aceita link http(s) e recusa esquema executável", () => {
  // `javascript:` gravado aqui viraria execução no clique de quem abrisse a
  // evidência a partir da lista.
  assert.equal(validEvidenceUrl("https://portal.gov.br/recibo/9912"), "https://portal.gov.br/recibo/9912");
  assert.equal(validEvidenceUrl("http://intranet.cliente/comprovante.pdf"), "http://intranet.cliente/comprovante.pdf");
  // Evidência é opcional: nem toda obrigação gera comprovante com link.
  assert.equal(validEvidenceUrl(""), "");

  for (const perigoso of ["javascript:alert(1)", "data:text/html,<script>x</script>", "file:///etc/passwd", "nao-e-url"]) {
    assert.throws(() => validEvidenceUrl(perigoso), /INVALID_EVIDENCE_URL|evidência/iu, `${perigoso} precisa ser recusado`);
  }
});

test("credencial na URL da evidência é recusada", () => {
  // Ela acabaria no corpo da resposta e no registro de auditoria da alteração.
  // O regex de `assert.throws` casa com a mensagem, não com o código — por isso
  // a conferência do código é explícita.
  assert.throws(() => validEvidenceUrl("https://user:senha@portal.gov.br/r"), (error: unknown) => {
    assert.equal((error as { code?: string }).code, "INVALID_EVIDENCE_URL");
    assert.match((error as Error).message, /usuário e senha/u);
    return true;
  });
});

test("o banco também recusa esquema executável", () => {
  // A validação da aplicação dá a frase que ajuda; o CHECK impede que outro
  // caminho de escrita — importação, correção manual — contorne.
  assert.match(migration, /CHECK \("evidence_url" = '' OR "evidence_url" ~\* '\^https\?:\/\/\[\^\\s\]\+\$'\)/u);
});

test("criar e editar persistem protocolo e evidência", () => {
  assert.match(criar, /protocol: cleanText\(body\.protocol, 120\), evidenceUrl: validEvidenceUrl\(body\.evidenceUrl\)/u);
  assert.match(criar, /notes, protocol, evidence_url\)/u);
  assert.match(editar, /protocol = \?, evidence_url = \?/u);
  // Na edição os campos são opcionais: um PATCH de status não pode apagar o
  // protocolo que já estava lá.
  assert.match(editar, /Object\.hasOwn\(body, "protocol"\) \? cleanText\(body\.protocol, 120\) : String\(current\.protocol \?\? ""\)/u);
  assert.match(editar, /Object\.hasOwn\(body, "evidenceUrl"\) \? validEvidenceUrl\(body\.evidenceUrl\) : String\(current\.evidence_url \?\? ""\)/u);
});

test("a alteração de protocolo entra na auditoria", () => {
  // Trocar o comprovante de uma obrigação é exatamente o tipo de ação que a
  // §40 quer rastreável: o `after` do evento carrega os campos novos.
  assert.match(editar, /action: "obligation\.updated"/u);
  assert.match(editar, /before: current, after: next/u);
});

test("a lista mostra o protocolo e denuncia conclusão sem prova", async () => {
  const view = await readFile(new URL("../app/painel/features/operations/OperationsView.tsx", import.meta.url), "utf8");
  assert.match(view, /Protocolo \$\{item\.protocol\}/u);
  // O sinal que a conferência de fechamento precisa ver.
  assert.match(view, /Concluída sem protocolo/u);
  // O link abre em aba nova sem entregar a sessão à página de destino.
  assert.match(view, /rel="noopener noreferrer"/u);
});

test("o formulário oferece os dois campos", async () => {
  const dialogs = await readFile(new URL("../app/painel/features/operations/OperationDialogs.tsx", import.meta.url), "utf8");
  assert.match(dialogs, /name="protocol"/u);
  assert.match(dialogs, /name="evidenceUrl" type="url"/u);
});

test("o índice responde 'o que fechou sem prova' sem varrer a tabela", () => {
  // A pergunta da conferência é sobre poucas linhas por competência; o índice
  // parcial cobre exatamente essas.
  assert.match(migration, /CREATE INDEX IF NOT EXISTS "fdp_obligations_completed_without_proof_idx"/u);
  assert.match(migration, /WHERE "status" = 'completed' AND "protocol" = '' AND "evidence_url" = ''/u);
});

test("o produto continua sem prometer transmissão a portal oficial", async () => {
  // O protocolo vem de fora justamente porque o Vinculato não transmite. Se um
  // dia aparecer botão de transmitir, esta premissa muda e o texto dos Termos
  // deixa de ser verdade.
  const termos = await readFile(new URL("../app/termos/page.tsx", import.meta.url), "utf8");
  assert.match(termos, /não transmite obrigações a órgãos públicos|nem transmite obrigações a órgãos públicos/iu);
});
