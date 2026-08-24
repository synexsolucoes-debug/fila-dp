import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { adoptionMetrics, currentPeriod, readAdoption, recordAdoption } from "../lib/adoption-metrics.ts";
import { epiCatalogStatuses, epiUnitStatuses } from "../lib/epi.ts";

/* A telemetria de adoção responde a única pergunta que decide se a consolidação
   valeu: ela está sendo usada? E ela mora numa tabela que estava morta (§50). */

test("as métricas cobrem o que a consolidação precisa provar", () => {
  for (const expected of [
    "demands_from_process", "events_received", "events_deduplicated", "triage_opened",
    "agent_actions_automatic", "agent_actions_refused", "work_center_opened", "deep_links_opened",
  ]) {
    assert.ok((adoptionMetrics as readonly string[]).includes(expected), `métrica ausente: ${expected}`);
  }
});

test("nenhuma métrica identifica pessoa", () => {
  for (const metric of adoptionMetrics) {
    assert.ok(!/user|employee|email|cpf|name/iu.test(metric), `métrica com cheiro de PII: ${metric}`);
  }
});

test("a granularidade é o mês, no formato do resto do produto", () => {
  assert.match(currentPeriod(new Date("2026-08-22T10:00:00Z")), /^\d{4}-(0[1-9]|1[0-2])$/u);
  assert.equal(currentPeriod(new Date("2026-01-31T23:00:00Z")), "2026-01");
});

test("a métrica usa a tabela que já existia, e não uma nova", async () => {
  const source = await readFile(new URL("../lib/adoption-metrics.ts", import.meta.url), "utf8");
  assert.match(source, /fdp_workspace_usage_counters/u,
    "criar uma tabela ao lado seria repetir o padrão que este trabalho corrige");
  assert.match(source, /ON CONFLICT \(workspace_id, metric, period\)/u,
    "o incremento precisa ser seguro sob concorrência");
});

test("falha de telemetria não derruba a operação", async () => {
  const quebrado = {
    prepare() {
      return { bind() { return { async run() { throw new Error("banco fora"); } }; } };
    },
  } as never;
  // Uma exceção aqui derrubaria a criação de uma demanda por causa de um
  // contador. A ordem de importância é essa e não a inversa.
  await recordAdoption(quebrado, "w1", "demands_from_process");
});

test("a leitura devolve todas as métricas, inclusive as zeradas", async () => {
  const fake = {
    prepare() {
      return {
        bind() {
          return {
            async all() {
              return { results: [{ period: "2026-08", metric: "demands_from_process", quantity: 3 }] };
            },
          };
        },
      };
    },
  } as never;
  const snapshot = await readAdoption(fake, "w1");
  assert.equal(snapshot.length, 1);
  assert.equal(snapshot[0].period, "2026-08");
  assert.equal(snapshot[0].metrics.demands_from_process, 3);
  // Indicador ausente é lido como "não medimos"; zero é outra informação.
  assert.equal(snapshot[0].metrics.triage_opened, 0);
});

/* -------------------------------------------------------------------------- */

test("o catálogo de EPI não fala o vocabulário da unidade", () => {
  assert.deepEqual([...epiCatalogStatuses], ["active", "inactive"]);
  for (const unitOnly of ["in_stock", "delivered", "returned", "sanitizing", "discarded", "damaged", "lost"]) {
    assert.ok(!(epiCatalogStatuses as readonly string[]).includes(unitOnly),
      `${unitOnly} é estado de peça física, não de modelo de equipamento`);
    assert.ok((epiUnitStatuses as readonly string[]).includes(unitOnly));
  }
});

test("o CHECK do banco acompanha a separação", async () => {
  const schema = await readFile(new URL("../db/schema.ts", import.meta.url), "utf8");
  const constraint = schema.slice(schema.indexOf("fdp_epi_products_status_check"));
  const line = constraint.slice(0, constraint.indexOf("\n"));
  assert.ok(!/delivered|in_stock|lost/u.test(line),
    "o CHECK do catálogo voltou a aceitar estado de unidade");
});
