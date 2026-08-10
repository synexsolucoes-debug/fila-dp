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
  /** Segredos ausentes desligam capacidades inteiras mesmo com o banco em dia. */
  configuration: "ok" | "incomplete";
  /** Quantas capacidades estão desligadas por falta de configuração. */
  missingCapabilities: number;
  /** Quais capacidades e quais variáveis — só para quem administra a plataforma. */
  missingConfiguration?: Array<{ capability: string; keys: string[] }>;
  detail: string;
};

/**
 * Segredos que, quando ausentes, desligam uma capacidade inteira em silêncio.
 *
 * O que motivou isso: sem `FDP_INTEGRATION_VAULT_KEY` o cofre recusa toda
 * gravação de credencial, mas o relatório de prontidão dizia "ok" porque só
 * olhava o banco. Quem opera via `Guardar credencial` só via a operação falhar,
 * sem saber que faltava configuração no deployment.
 *
 * Cada entrada é satisfeita por QUALQUER uma das chaves, o que preserva os
 * fallbacks já existentes no código (por exemplo, o CPF aceita o segredo de
 * sessão quando não há um HMAC dedicado).
 */
const REQUIRED_CONFIGURATION: ReadonlyArray<{ capability: string; keys: string[] }> = [
  { capability: "Sessões, recuperação de acesso e chaves de API", keys: ["FDP_AUTH_SECRET"] },
  { capability: "Cofre de credenciais das integrações", keys: ["FDP_INTEGRATION_VAULT_KEY", "FDP_INTEGRATION_VAULT_KEYS"] },
  { capability: "Executor assíncrono de integrações e webhooks", keys: ["FDP_INTEGRATION_WORKER_SECRET"] },
  { capability: "Anexos das demandas", keys: ["BLOB_READ_WRITE_TOKEN"] },
  { capability: "Proteção de CPF no cadastro de pessoas", keys: ["FDP_PII_HASH_SECRET", "FDP_AUTH_SECRET"] },
];

/** Capacidades desligadas por falta de segredo neste deployment. */
export function missingConfiguration() {
  return REQUIRED_CONFIGURATION.filter((entry) => !entry.keys.some((key) => String(process.env[key] ?? "").trim()));
}

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

type DatabaseVerdict = Omit<ReadinessReport, "configuration" | "missingCapabilities">;

async function probeReadAccess(): Promise<DatabaseVerdict | null> {
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
  const gaps = missingConfiguration();
  /**
   * O veredito do banco e o da configuração são independentes: um deployment
   * com o schema em dia continua degradado se não consegue selar credencial.
   */
  const withConfiguration = (report: DatabaseVerdict): ReadinessReport => {
    if (!gaps.length) return { ...report, configuration: "ok", missingCapabilities: 0 };
    const detail = report.status === "ok"
      ? `Banco em dia, mas ${gaps.length === 1 ? "uma capacidade está desligada" : `${gaps.length} capacidades estão desligadas`} por falta de configuração neste deployment.`
      : `${report.detail} Além disso, ${gaps.length === 1 ? "uma capacidade está desligada" : `${gaps.length} capacidades estão desligadas`} por falta de configuração.`;
    return {
      ...report,
      status: "degraded",
      configuration: "incomplete",
      missingCapabilities: gaps.length,
      ...(includeDetail ? { missingConfiguration: gaps.map((entry) => ({ capability: entry.capability, keys: [...entry.keys] })) } : {}),
      detail,
    };
  };
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
      if (access) return withConfiguration(access);
      return withConfiguration({ status: "ok", database: "ok", pendingMigrations: 0, detail: "Banco na mesma versão do aplicativo." });
    }
    return withConfiguration({
      status: "degraded",
      database: "outdated",
      pendingMigrations: pending.length,
      ...(includeDetail ? { pendingMigrationIds: [...pending] } : {}),
      detail: "O banco está atrás desta versão do aplicativo. Aplique as migrações pendentes com `npm run db:migrate`.",
    });
  } catch (error) {
    const fault = classifyInfrastructureFault(error);
    // Sem a tabela de histórico o banco não passou por nenhuma migração: isso é
    // desatualização, não indisponibilidade.
    if (fault?.code === "SCHEMA_OUTDATED") {
      return withConfiguration({
        status: "degraded",
        database: "outdated",
        pendingMigrations: expectedMigrations.length,
        ...(includeDetail ? { pendingMigrationIds: [...expectedMigrations] } : {}),
        detail: "O banco não possui histórico de migrações. Execute `npm run db:migrate` apontando para ele.",
      });
    }
    return withConfiguration({
      status: "degraded",
      database: "unreachable",
      pendingMigrations: -1,
      detail: "Não foi possível falar com o banco de dados a partir deste deployment.",
    });
  }
}
