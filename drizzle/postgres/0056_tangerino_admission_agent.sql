-- Agente de consulta de admissão no Tangerino, por navegador.
--
-- A API oficial da Sólides DP não responde a pergunta que o DP faz todo dia:
-- "em que pé está a admissão desta pessoa?". O recurso que existe é
-- `employee/find-all` filtrado por `lastUpdate` — ele diz quem mudou, não em que
-- etapa o processo está. Tentar derivar andamento dali seria inventar dado.
--
-- Então o andamento passa a ser lido onde ele existe: na tela da Admissão
-- Digital, por um agente de navegador **somente leitura**. O conector de API
-- (`lib/tangerino.ts`) continua intacto e segue servindo à conciliação
-- cadastral; esta migration não encosta nele.
--
-- O que entra aqui é o histórico das consultas. Ele não é log: é o registro que
-- responde "desde quando está assim" e "o que mudou desde ontem", que é o
-- motivo de alguém consultar duas vezes.
SELECT pg_advisory_xact_lock(hashtext('0056_tangerino_admission_agent'));
--> statement-breakpoint

-- O vínculo externo já existia para o Sankhya e serve igual aqui: guardar o
-- identificador do processo no Tangerino é o que torna a segunda consulta
-- determinística, em vez de repetir a pesquisa por nome e correr o risco de
-- casar com o homônimo (§18, §47).
ALTER TABLE "fdp_employee_external_refs" DROP CONSTRAINT IF EXISTS "fdp_employee_external_refs_source_check";
--> statement-breakpoint
ALTER TABLE "fdp_employee_external_refs"
  ADD CONSTRAINT "fdp_employee_external_refs_source_check" CHECK ("source" IN ('sankhya', 'tangerino'));
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "fdp_tangerino_admission_consultations" (
  "id" text PRIMARY KEY NOT NULL,
  "workspace_id" text NOT NULL,
  "company_id" text NOT NULL,
  "employee_id" text NOT NULL,
  "integration_id" text NOT NULL,

  -- Quem pediu. `NULL` é consulta de rotina automática, que ainda não existe
  -- (§62) mas terá o mesmo histórico quando existir.
  "requested_by_user_id" text,

  -- O estado da consulta, não o do processo. São coisas diferentes e misturá-las
  -- foi o que fez a coluna `status` de outras integrações significar duas coisas.
  "state" text DEFAULT 'QUEUED' NOT NULL,
  "error_code" text DEFAULT '' NOT NULL,

  -- O texto exatamente como o Tangerino escreveu. Nunca é sobrescrito pela
  -- tradução: quando a tradução estiver errada, é por aqui que se descobre (§30).
  "raw_status" text DEFAULT '' NOT NULL,
  "normalized_status" text DEFAULT 'UNKNOWN' NOT NULL,
  "stage" text DEFAULT '' NOT NULL,
  "pending_reason" text DEFAULT '' NOT NULL,
  "admission_date" text DEFAULT '' NOT NULL,
  "source_updated_at" text DEFAULT '' NOT NULL,
  "external_admission_id" text DEFAULT '' NOT NULL,

  -- Quantos processos a pesquisa encontrou. Só faz sentido em MULTIPLE_MATCHES,
  -- e é o que a tela precisa para dizer "encontrei 3" em vez de "deu erro".
  "match_count" integer DEFAULT 0 NOT NULL,

  "requested_at" timestamptz DEFAULT now() NOT NULL,
  "started_at" timestamptz,
  "consulted_at" timestamptz,
  "duration_ms" integer DEFAULT 0 NOT NULL,
  "attempt" integer DEFAULT 0 NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,

  CONSTRAINT "fdp_tangerino_consultations_state_check" CHECK ("state" IN (
    'QUEUED', 'RUNNING', 'SUCCESS', 'NOT_FOUND', 'MULTIPLE_MATCHES', 'AUTHENTICATION_REQUIRED',
    'PERMISSION_DENIED', 'RATE_LIMITED', 'TANGERINO_UNAVAILABLE', 'UI_CHANGED', 'TIMEOUT', 'CONSULTATION_FAILED')),
  CONSTRAINT "fdp_tangerino_consultations_status_check" CHECK ("normalized_status" IN (
    'PENDING', 'IN_PROGRESS', 'WAITING_CANDIDATE', 'WAITING_DOCUMENTS', 'DOCUMENT_ANALYSIS',
    'WAITING_SIGNATURE', 'READY_FOR_ADMISSION', 'COMPLETED', 'CANCELLED', 'UNKNOWN')),
  -- Uma consulta que terminou com sucesso e sem texto de situação seria um
  -- registro que afirma ter lido algo sem ter lido nada. O banco recusa.
  CONSTRAINT "fdp_tangerino_consultations_success_has_status_check"
    CHECK ("state" <> 'SUCCESS' OR length("raw_status") > 0),
  CONSTRAINT "fdp_tangerino_consultations_workspace_fk"
    FOREIGN KEY ("workspace_id") REFERENCES "fdp_workspaces"("id") ON DELETE cascade,
  CONSTRAINT "fdp_tangerino_consultations_workspace_company_fk"
    FOREIGN KEY ("workspace_id", "company_id") REFERENCES "fdp_companies"("workspace_id", "id") ON DELETE cascade,
  CONSTRAINT "fdp_tangerino_consultations_workspace_employee_fk"
    FOREIGN KEY ("workspace_id", "employee_id") REFERENCES "fdp_employees"("workspace_id", "id") ON DELETE cascade,
  CONSTRAINT "fdp_tangerino_consultations_workspace_integration_fk"
    FOREIGN KEY ("workspace_id", "integration_id") REFERENCES "fdp_integrations"("workspace_id", "id") ON DELETE cascade
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "fdp_tangerino_consultations_workspace_id_uq"
  ON "fdp_tangerino_admission_consultations" ("workspace_id", "id");
--> statement-breakpoint

-- O trinco da §39, no banco e não na aplicação.
--
-- Dois cliques no mesmo botão, duas abas abertas, ou um clique e um retry
-- chegam como duas requisições simultâneas — e duas verificações "já existe uma
-- rodando?" em transações concorrentes respondem "não" as duas vezes. O índice
-- parcial é o único lugar onde essa corrida não acontece: a segunda inserção
-- falha, e a aplicação devolve a consulta que já está de pé.
CREATE UNIQUE INDEX IF NOT EXISTS "fdp_tangerino_consultations_active_uq"
  ON "fdp_tangerino_admission_consultations" ("workspace_id", "employee_id")
  WHERE "state" IN ('QUEUED', 'RUNNING');
--> statement-breakpoint

-- O histórico é sempre lido do mais novo para o mais velho, por colaborador.
CREATE INDEX IF NOT EXISTS "fdp_tangerino_consultations_employee_idx"
  ON "fdp_tangerino_admission_consultations" ("workspace_id", "employee_id", "requested_at" DESC);
--> statement-breakpoint

-- O limite por usuário (§40) conta as consultas do minuto anterior.
CREATE INDEX IF NOT EXISTS "fdp_tangerino_consultations_rate_idx"
  ON "fdp_tangerino_admission_consultations" ("workspace_id", "requested_by_user_id", "requested_at" DESC);
--> statement-breakpoint

ALTER TABLE "fdp_tangerino_admission_consultations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_tangerino_admission_consultations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "fdp_tangerino_consultations_workspace_isolation" ON "fdp_tangerino_admission_consultations"
  USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
--> statement-breakpoint

-- O módulo não entra em nenhum plano automaticamente. A plataforma o libera por
-- workspace, como o conector Sankhya: um agente que navega no Tangerino do
-- cliente com a credencial do cliente é decisão de implantação, não de catálogo.
INSERT INTO "fdp_modules" ("key", "name", "description", "category", "route", "required_capability", "depends_on", "position")
VALUES ('tangerino_browser', 'Agente Tangerino', 'Consulta o andamento de processos admissionais na Admissão Digital por navegador, somente leitura.', 'gestao', 'integrations', 'integrations.view', 'integrations', 1020)
ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint

INSERT INTO "fdp_integrations" ("id", "workspace_id", "channel", "display_name", "status")
SELECT workspace."id" || ':integration:tangerino_browser', workspace."id", 'tangerino_browser', 'Agente Tangerino', 'needs_credentials'
FROM "fdp_workspaces" workspace
ON CONFLICT ("workspace_id", "channel") DO NOTHING;
