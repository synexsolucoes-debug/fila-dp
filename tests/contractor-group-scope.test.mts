import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * O prestador PJ é do grupo, e não de uma empresa.
 *
 * Até a migração 0054 o contrato do PJ carregava uma empresa obrigatória, e era
 * ela que decidia em qual apuração o prestador entrava. Só que quem presta
 * serviço é o PJ: ele atende as empresas do grupo, e não o contrário. Um PJ que
 * atendia duas empresas precisava existir duas vezes, com dois códigos e duas
 * apurações, e ninguém conseguia dizer quanto aquela pessoa recebeu no mês sem
 * somar à mão.
 *
 * A empresa não sumiu — mudou de lugar. Ela é informada onde de fato importa:
 * na apuração, que é quem paga; na nota, que é quem recebe; e nos relatórios.
 *
 * O que este arquivo tranca é o caminho de volta. Cada uma destas conferências
 * corresponde a uma forma de o prestador voltar a pertencer a uma empresa sem
 * que ninguém perceba — e o sintoma seria sempre o mesmo: uma lista menor, uma
 * apuração com menos gente, um arquivo com menos mensagens. Coisas que parecem
 * tão corretas quanto as certas.
 *
 * A garantia de banco (um fechamento por prestador por competência no grupo
 * inteiro, e o CHECK do departamento) é ensaiada contra PostgreSQL de verdade
 * em `scripts/payments-db-rehearsal.sql`.
 */

const ler = (caminho: string) => readFile(new URL(`../${caminho}`, import.meta.url), "utf8");

test("a migração solta o contrato da empresa e tranca o pagamento em dobro", async () => {
  const migracao = await ler("drizzle/postgres/0054_contractor_belongs_to_group.sql");
  assert.match(migracao, /ALTER TABLE "fdp_contractor_profiles"\s*\n\s*ALTER COLUMN "company_id" DROP NOT NULL/u);

  /* O índice é parcial de propósito: o fechamento excluído continua no banco
     como trilha de que aquele pagamento existiu e foi retirado. Sem o WHERE,
     um pagamento excluído impediria de apurar o mês de novo — e a mensagem de
     erro falaria de um índice, não do que aconteceu. */
  assert.match(migracao, /CREATE UNIQUE INDEX "fdp_contractor_closings_workspace_provider_competence_uq"/u);
  assert.match(migracao, /\("workspace_id", "provider_id", "competence"\)\s*\n\s*WHERE "excluded_at" IS NULL/u);

  // Departamento pertence à empresa: a chave composta para de conferir quando
  // uma das colunas é nula, então a regra passa a ser cobrada em voz alta.
  assert.match(migracao, /fdp_contractor_profiles_department_needs_company_check/u);
});

test("a apuração varre o grupo, e não os prestadores de uma empresa", async () => {
  const rota = await ler("app/api/payments/contractors/closings/route.ts");
  const consulta = rota.slice(rota.indexOf("SELECT provider_id FROM fdp_contractor_profiles"));
  const ateOFecho = consulta.slice(0, consulta.indexOf("`"));
  assert.doesNotMatch(ateOFecho, /company_id/u, "a apuração voltou a recortar os prestadores por empresa");
  // O inativo continua elegível apenas nas competências cobertas pela data de
  // encerramento: é isso que permite recalcular o mês final proporcional sem
  // ressuscitar pagamento nos meses seguintes.
  assert.match(ateOFecho, /status IN \('active', 'inactive'\)/u);
  assert.match(ateOFecho, /contract_end IS NULL OR contract_end >= \?/u);

  /* Varrer o grupo inteiro só é seguro com a outra metade da regra: quem já foi
     apurado no mês por outra empresa fica de fora. Sem isso, apurar agosto na
     Empresa A e depois na Empresa B pagaria a mesma pessoa duas vezes. */
  assert.match(rota, /c\.company_id <> \?/u);
  assert.match(rota, /já apurado nesta competência por/u);
  // E o motivo chega na tela: uma linha explicada vale mais que um silêncio.
  assert.match(rota, /blockedReason: `já apurado/u);
});

test("a empresa da gravação é a que apura, não a do cadastro", async () => {
  const servico = await ler("lib/payment-service.ts");
  /* O fechamento, o componente da competência e o componente materializado a
     partir do item fixo: os três gravam a empresa do ciclo. Gravar a do
     cadastro faria o pagamento nascer no CNPJ errado — e a conferência de
     empresa nenhuma bateria, porque o número estaria certo. */
  assert.equal(
    servico.split("input.cycle.company_id").length - 1, 3,
    "alguma gravação voltou a usar a empresa do cadastro",
  );
  assert.doesNotMatch(servico, /input\.profile\.company_id/u);

  // O limite de nota é regra de quem paga, então é resolvido contra o ciclo.
  assert.match(servico, /invoiceLimitCandidates\(d1, workspaceId, profile, cycle\.competence, cycle\.company_id\)/u);

  /* E a competência passa a ser encontrada pelo próprio id: não existe mais uma
     "empresa do prestador" para procurá-la. O acesso é conferido contra a
     empresa que a competência revela. */
  assert.match(servico, /export async function requireOpenCycleById/u);
});

test("o lançamento confere o acesso pela empresa da competência", async () => {
  const componentes = await ler("app/api/payments/contractors/components/route.ts");
  for (const trecho of componentes.matchAll(/requireOpenCycleById\(d1, workspace\.id, cycleId\);\s*\n\s*(.*)/gu)) {
    assert.match(trecho[1], /requireCompanyAccess\(d1, workspace\.id, user\.id, workspace\.role, cycle\.company_id\)/u,
      "a competência foi resolvida sem conferir o acesso à empresa dela");
  }
  assert.doesNotMatch(componentes, /profile\.company_id/u);
});

test("a lista de prestadores é do grupo", async () => {
  const rota = await ler("app/api/payments/contractors/route.ts");
  const get = rota.slice(0, rota.indexOf("export async function POST"));
  /* O recorte por acesso saiu daqui junto com a empresa do cadastro: filtrar
     por `p.company_id` esconderia quem atende mais de uma empresa, e a falta
     não teria sintoma — uma lista menor parece igualmente correta. */
  assert.doesNotMatch(get, /access\.companyIds/u, "a lista voltou a recortar prestadores por empresa");
  // O filtro explícito continua, porque olhar uma frente só é um pedido legítimo.
  assert.match(get, /if \(companyId\) \{ where\.push\("p\.company_id = \?"\)/u);

  // E o cadastro deixou de exigir empresa: exigi-la obrigaria a inventar uma
  // resposta para quem atende várias.
  assert.match(rota, /if \(!legalName\) throw ApiError\.badRequest/u);
  assert.match(rota, /if \(companyId\) await requireCompanyAccess/u);
});

test("o extrato liga contrato e prestador sem passar pela empresa", async () => {
  const relatorios = await ler("lib/payment-reports.ts");
  /* Casar o contrato também por empresa faria contrato e função sumirem do
     extrato justamente quando a apuração corresse por outra empresa do grupo —
     duas colunas em branco, sem erro nenhum. */
  assert.doesNotMatch(relatorios, /fdp_contractor_profiles p ON[^\n]*p\.company_id/u);
  assert.equal(
    relatorios.split("LEFT JOIN fdp_contractor_profiles p ON").length - 1, 2,
    "o extrato analítico precisa dos dois lados da união ligados ao contrato",
  );
});
