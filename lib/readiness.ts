import { getD1 } from "../db/index.ts";
import { expectedMigrations } from "./schema-manifest.ts";
import { classifyInfrastructureFault } from "./infrastructure-errors.ts";

export type ReadinessReport = {
  status: "ok" | "degraded";
  database: "ok" | "outdated" | "unreachable" | "no_access";
  /** Quantas migrations desta versão ainda não foram aplicadas no banco. */
  pendingMigrations: number;
  /** Nomes das migrations pendentes — só para quem administra a plataforma. */
  pendingMigrationIds?: string[];
  detail: string;
};

/**
 * Diz se este deployment consegue operar contra o banco que ele enxerga.
 *
 * O que motivou isso: com o banco atrás da versão do aplicativo, toda a
 * operação falhava com uma frase genérica, e não havia como distinguir "o
 * sistema quebrou" de "falta aplicar migração" sem ler o log do servidor.
 *
 * O relatório não expõe host, credencial, versão do PostgreSQL nem SQL. O
 * nome das migrations pendentes só aparece para quem administra a plataforma.
 */
/**
 * Tabelas que toda requisição do painel toca. Se o papel da aplicação não
 * conseguir ler uma delas, o produto está fora do ar mesmo com o schema em dia.
 */
const CORE_TABLES = ["fdp_workspaces", "fdp_modules", "fdp_saas_plans"] as const;

async function probeReadAccess(): Promise<ReadinessReport | null> {
  const d1 = getD1();
  for (const table of CORE_TABLES) {
    try {
      // `LIMIT 0`: confere permissão e existência sem trazer dado de cliente.
      await d1.prepare(`SELECT 1 FROM ${table} LIMIT 0`).all();
    } catch (error) {
      const fault = classifyInfrastructureFault(error);
      if (fault?.code === "DATABASE_PERMISSION_DENIED") {
        return {
          status: "degraded",
          database: "no_access",
          pendingMigrations: 0,
          detail: "O papel usado pela aplicação não tem privilégio sobre parte do schema. Regularize as permissões desse papel no banco.",
        };
      }
      if (fault?.code === "SCHEMA_OUTDATED") {
        return {
          status: "degraded",
          database: "outdated",
          pendingMigrations: 0,
          detail: "O histórico de migrações está completo, mas parte do schema não existe. Verifique se o banco apontado é o mesmo em que as migrações foram aplicadas.",
        };
      }
      return {
        status: "degraded",
        database: "unreachable",
        pendingMigrations: 0,
        detail: "Não foi possível confirmar o acesso do aplicativo ao banco de dados.",
      };
    }
  }
  return null;
}

export async function checkReadiness(includeDetail: boolean): Promise<ReadinessReport> {
  try {
    const d1 = getD1();
    const applied = await d1.prepare("SELECT id FROM fdp_schema_migrations").all<{ id: string }>();
    const appliedIds = new Set(applied.results.map((row) => String(row.id)));
    const pending = expectedMigrations.filter((migration) => !appliedIds.has(migration));

    if (pending.length === 0) {
      // Histórico completo não garante que o papel da aplicação consegue ler o
      // que foi criado: uma versão nova pode ter adicionado objetos sem
      // privilégio para ele. Sem esta sondagem o relatório diria "ok" enquanto
      // toda a operação falhava.
      const access = await probeReadAccess();
      if (access) return access;
      return { status: "ok", database: "ok", pendingMigrations: 0, detail: "Banco na mesma versão do aplicativo." };
    }
    return {
      status: "degraded",
      database: "outdated",
      pendingMigrations: pending.length,
      ...(includeDetail ? { pendingMigrationIds: [...pending] } : {}),
      detail: "O banco está atrás desta versão do aplicativo. Aplique as migrações pendentes com `npm run db:migrate`.",
    };
  } catch (error) {
    const fault = classifyInfrastructureFault(error);
    // Sem a tabela de histórico o banco não passou por nenhuma migração: isso é
    // desatualização, não indisponibilidade.
    if (fault?.code === "SCHEMA_OUTDATED") {
      return {
        status: "degraded",
        database: "outdated",
        pendingMigrations: expectedMigrations.length,
        ...(includeDetail ? { pendingMigrationIds: [...expectedMigrations] } : {}),
        detail: "O banco não possui histórico de migrações. Execute `npm run db:migrate` apontando para ele.",
      };
    }
    return {
      status: "degraded",
      database: "unreachable",
      pendingMigrations: -1,
      detail: "Não foi possível falar com o banco de dados a partir deste deployment.",
    };
  }
}
