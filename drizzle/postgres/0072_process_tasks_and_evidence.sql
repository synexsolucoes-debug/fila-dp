-- allow-destructive-migration: o único DELETE aqui está dentro do corpo de
-- `fdp_save_process_version_draft`, republicado no fim do arquivo com dois
-- campos a mais. Ele é o mesmo `DELETE` que 0051 já autorizou pelo mesmo
-- motivo: o autosave substitui atomicamente as configurações de etapa da versão
-- **em rascunho** que está sendo salva. Nenhuma tabela é apagada, nenhuma
-- versão publicada é tocada e nenhuma execução é afetada.
--
-- Tarefa vira entidade de primeira classe (§24, §41), anexo passa a saber a
-- que etapa e a que tarefa pertence (§43), e a etapa ganha automações
-- declaradas (§27).
--
-- ## O que existia
--
-- `fdp_checklist_items` guardava `title`, `completed` e `position`. No modelo do
-- processo, "tarefa" era uma string dentro de `checklist_json` na etapa. Isso
-- basta para uma lista de conferência e não basta para nada que o briefing pede
-- de uma tarefa: quem responde, de que área, até quando, quem concluiu, com que
-- prova, dependendo de qual outra.
--
-- A consequência prática não era estética. `evaluateStepRequirements` só sabia
-- contar itens em aberto, então *todo* item bloqueava o avanço igualmente — não
-- havia como marcar uma tarefa como opcional, nem como dizer que uma delas é a
-- que trava e as outras não. Quem precisava disso criava a etapa a mais.
--
-- ## Por que colunas, e não uma tabela nova
--
-- `fdp_demand_tasks` paralela obrigaria a reescrever os nove pontos que hoje
-- inserem, leem e contam checklist — quadro, cartão, agentes, Sólides,
-- Tangerino, Teams, integrações, inbox e o próprio motor —, e a migrar o
-- histórico. Cada um desses é um caminho de escrita que hoje funciona.
--
-- Estendendo a tabela que já existe, tudo que grava hoje continua gravando, e
-- os defaults reproduzem exatamente o comportamento anterior: `required = 1` e
-- `blocks_advance = 1` em toda linha existente é a regra "todo item pendente
-- bloqueia" que o motor já aplicava. Demanda antiga não muda de comportamento
-- por causa desta migration (§48, §108) — é o teste `tarefa legada` que cobra.
--
-- ## Sobre `template_key`
--
-- Dependência entre tarefas precisa de um identificador estável *dentro da
-- etapa*, não do `id` da linha: o desenho da versão é escrito antes de a demanda
-- existir, e a tarefa "Conferir CPF" da v3 precisa poder dizer que depende de
-- "Receber documentos" sem conhecer o UUID que só vai existir na instanciação.

SELECT pg_advisory_xact_lock(hashtext('0072_process_tasks_and_evidence'));
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- §24 e §41 — a tarefa da demanda
-- ---------------------------------------------------------------------------

ALTER TABLE "fdp_checklist_items" ADD COLUMN IF NOT EXISTS "description" text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE "fdp_checklist_items" ADD COLUMN IF NOT EXISTS "instructions" text NOT NULL DEFAULT '';
--> statement-breakpoint
-- Chave estável da tarefa dentro da etapa; é sobre ela que a dependência fala.
ALTER TABLE "fdp_checklist_items" ADD COLUMN IF NOT EXISTS "template_key" text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE "fdp_checklist_items" ADD COLUMN IF NOT EXISTS "area_id" text;
--> statement-breakpoint
ALTER TABLE "fdp_checklist_items" ADD COLUMN IF NOT EXISTS "assignee_user_id" text;
--> statement-breakpoint
-- §24 pede "perfil responsável" além da pessoa: a tarefa que é sempre de quem
-- ocupa um papel não pode depender de alguém lembrar de reatribuir.
ALTER TABLE "fdp_checklist_items" ADD COLUMN IF NOT EXISTS "assignee_role" text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE "fdp_checklist_items" ADD COLUMN IF NOT EXISTS "sla_value" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "fdp_checklist_items" ADD COLUMN IF NOT EXISTS "sla_unit" text NOT NULL DEFAULT 'hours';
--> statement-breakpoint
ALTER TABLE "fdp_checklist_items" ADD COLUMN IF NOT EXISTS "started_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "fdp_checklist_items" ADD COLUMN IF NOT EXISTS "due_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "fdp_checklist_items" ADD COLUMN IF NOT EXISTS "completed_by" text NOT NULL DEFAULT '';
--> statement-breakpoint
-- Obrigatória por padrão: é o que toda linha existente já era na prática.
ALTER TABLE "fdp_checklist_items" ADD COLUMN IF NOT EXISTS "required" integer NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE "fdp_checklist_items" ADD COLUMN IF NOT EXISTS "blocks_advance" integer NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE "fdp_checklist_items" ADD COLUMN IF NOT EXISTS "evidence_required" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "fdp_checklist_items" ADD COLUMN IF NOT EXISTS "document_required" text NOT NULL DEFAULT '';
--> statement-breakpoint
-- Regra de conclusão (§24). `manual` é o que existe hoje: alguém marca e pronto.
-- As outras duas exigem prova anexada *na própria tarefa* antes de aceitar a
-- marcação — é a diferença entre "declarei que fiz" e "mostrei o que fiz".
ALTER TABLE "fdp_checklist_items" ADD COLUMN IF NOT EXISTS "completion_rule" text NOT NULL DEFAULT 'manual';
--> statement-breakpoint
ALTER TABLE "fdp_checklist_items" ADD COLUMN IF NOT EXISTS "depends_on_json" jsonb NOT NULL DEFAULT '[]'::jsonb;
--> statement-breakpoint

ALTER TABLE "fdp_checklist_items" DROP CONSTRAINT IF EXISTS "fdp_checklist_items_completion_rule_check";
--> statement-breakpoint
ALTER TABLE "fdp_checklist_items"
  ADD CONSTRAINT "fdp_checklist_items_completion_rule_check"
  CHECK ("completion_rule" IN ('manual', 'evidence', 'document'));
--> statement-breakpoint

ALTER TABLE "fdp_checklist_items" DROP CONSTRAINT IF EXISTS "fdp_checklist_items_sla_unit_check";
--> statement-breakpoint
ALTER TABLE "fdp_checklist_items"
  ADD CONSTRAINT "fdp_checklist_items_sla_unit_check"
  CHECK ("sla_unit" IN ('minutes', 'hours', 'days'));
--> statement-breakpoint

-- Marcada como concluída sem a hora em que foi é o registro que falta
-- justamente quando alguém pergunta, meses depois, quando aquilo foi dado por
-- feito.
--
-- `NOT VALID` é deliberado, e é a diferença entre esta migration subir e esta
-- migration derrubar o deploy. A regra vale para toda escrita daqui para a
-- frente; as linhas já gravadas não são varridas. Só existe um caminho que
-- marca item como concluído (`PATCH /api/checklist/[id]`) e ele sempre gravou
-- `completed_at` junto — mas "sempre gravou" é o que se acredita sobre o
-- código de hoje, não sobre todas as versões que passaram por esta tabela.
-- Validar retroativamente apostaria a migration nessa crença; preencher a hora
-- que falta com `now()` seria pior, porque inventaria um fato de auditoria.
ALTER TABLE "fdp_checklist_items" DROP CONSTRAINT IF EXISTS "fdp_checklist_items_completed_at_check";
--> statement-breakpoint
ALTER TABLE "fdp_checklist_items"
  ADD CONSTRAINT "fdp_checklist_items_completed_at_check"
  CHECK ("completed" = 0 OR "completed_at" IS NOT NULL) NOT VALID;
--> statement-breakpoint

-- Alvo das chaves estrangeiras compostas abaixo: o par (workspace, id) é o que
-- impede um comentário de um tenant apontar para a tarefa de outro.
CREATE UNIQUE INDEX IF NOT EXISTS "fdp_checklist_items_workspace_id_uq"
  ON "fdp_checklist_items" ("workspace_id", "id");
--> statement-breakpoint

ALTER TABLE "fdp_checklist_items" DROP CONSTRAINT IF EXISTS "fdp_checklist_items_area_fk";
--> statement-breakpoint
ALTER TABLE "fdp_checklist_items"
  ADD CONSTRAINT "fdp_checklist_items_area_fk"
  FOREIGN KEY ("workspace_id", "area_id") REFERENCES "fdp_areas" ("workspace_id", "id");
--> statement-breakpoint

-- A fila "o que é meu e vence quando" é a consulta que a tela da pessoa faz.
CREATE INDEX IF NOT EXISTS "fdp_checklist_items_assignee_due_idx"
  ON "fdp_checklist_items" ("workspace_id", "assignee_user_id", "due_at")
  WHERE "completed" = 0 AND "assignee_user_id" IS NOT NULL;
--> statement-breakpoint
-- A varredura de tarefa vencida (§27) filtra exatamente por isto.
CREATE INDEX IF NOT EXISTS "fdp_checklist_items_open_due_idx"
  ON "fdp_checklist_items" ("workspace_id", "due_at")
  WHERE "completed" = 0 AND "due_at" IS NOT NULL;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- §41 — comentário por tarefa
-- ---------------------------------------------------------------------------
--
-- Reaproveita `fdp_card_comments` em vez de criar uma tabela de comentário de
-- tarefa: o comentário continua sendo da demanda (é lá que ele é lido em ordem),
-- e a coluna apenas diz a qual tarefa ele se refere quando se refere a alguma.
-- Nulo é o comentário de demanda, que é tudo que existe hoje.
ALTER TABLE "fdp_card_comments" ADD COLUMN IF NOT EXISTS "checklist_item_id" text;
--> statement-breakpoint
ALTER TABLE "fdp_card_comments" DROP CONSTRAINT IF EXISTS "fdp_card_comments_checklist_item_fk";
--> statement-breakpoint
ALTER TABLE "fdp_card_comments"
  ADD CONSTRAINT "fdp_card_comments_checklist_item_fk"
  FOREIGN KEY ("workspace_id", "checklist_item_id")
  REFERENCES "fdp_checklist_items" ("workspace_id", "id") ON DELETE CASCADE;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_card_comments_checklist_item_idx"
  ON "fdp_card_comments" ("workspace_id", "checklist_item_id", "created_at")
  WHERE "checklist_item_id" IS NOT NULL;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- §43 — o anexo sabe onde nasceu
-- ---------------------------------------------------------------------------
--
-- Hoje todo arquivo pertence à demanda inteira. Numa admissão de cinco etapas e
-- dezoito tarefas, "a evidência foi anexada" era verdade para a demanda e
-- indeterminada para a etapa que a exigia: a conferência de documento comparava
-- o nome do arquivo contra a lista da etapa, e um comprovante enviado na etapa
-- de Registro satisfazia a exigência da etapa de Documentação.
--
-- Vazio e nulo continuam significando "anexo da demanda", que é o que todos os
-- arquivos existentes são.
ALTER TABLE "fdp_card_attachments" ADD COLUMN IF NOT EXISTS "process_step_id" text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE "fdp_card_attachments" ADD COLUMN IF NOT EXISTS "checklist_item_id" text;
--> statement-breakpoint
ALTER TABLE "fdp_card_attachments" DROP CONSTRAINT IF EXISTS "fdp_card_attachments_checklist_item_fk";
--> statement-breakpoint
ALTER TABLE "fdp_card_attachments"
  ADD CONSTRAINT "fdp_card_attachments_checklist_item_fk"
  FOREIGN KEY ("workspace_id", "checklist_item_id")
  REFERENCES "fdp_checklist_items" ("workspace_id", "id") ON DELETE CASCADE;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_card_attachments_step_idx"
  ON "fdp_card_attachments" ("workspace_id", "card_id", "process_step_id")
  WHERE "process_step_id" <> '';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fdp_card_attachments_checklist_item_idx"
  ON "fdp_card_attachments" ("workspace_id", "checklist_item_id")
  WHERE "checklist_item_id" IS NOT NULL;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- §24 e §27 — o desenho: tarefas-modelo e automações da etapa
-- ---------------------------------------------------------------------------
--
-- `checklist_json` continua existindo e continua valendo: é o que as versões já
-- publicadas usam, e uma versão publicada não muda (§28). `tasks_json` é o
-- desenho novo, e quando ele está preenchido é ele que manda — a instanciação
-- lê os dois na ordem "tarefa-modelo primeiro, checklist para o que sobrar".
ALTER TABLE "fdp_process_step_configs" ADD COLUMN IF NOT EXISTS "tasks_json" jsonb NOT NULL DEFAULT '[]'::jsonb;
--> statement-breakpoint
ALTER TABLE "fdp_process_step_configs" ADD COLUMN IF NOT EXISTS "automations_json" jsonb NOT NULL DEFAULT '[]'::jsonb;
--> statement-breakpoint

-- Os dois precisam ser lista, não objeto: o resto do código itera sobre eles, e
-- um objeto solto aqui viraria `undefined.map` em produção.
ALTER TABLE "fdp_process_step_configs" DROP CONSTRAINT IF EXISTS "fdp_process_step_configs_tasks_json_check";
--> statement-breakpoint
ALTER TABLE "fdp_process_step_configs"
  ADD CONSTRAINT "fdp_process_step_configs_tasks_json_check"
  CHECK (jsonb_typeof("tasks_json") = 'array' AND jsonb_typeof("automations_json") = 'array');
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- O gravador do rascunho precisa saber gravar as duas colunas novas
-- ---------------------------------------------------------------------------
--
-- `fdp_save_process_version_draft` apaga e regrava todas as configurações de
-- etapa a cada salvamento. Sem esta substituição, desenhar tarefas no modelador
-- e salvar apagaria as tarefas em silêncio: as colunas existiriam, o `INSERT`
-- não as citaria, e o default `'[]'` venceria. É o pior modo de falhar — a tela
-- confirma "salvo" e o dado não está lá.
--
-- O corpo abaixo é o de 0051 com dois campos a mais no `INSERT` e no `SELECT`.
CREATE OR REPLACE FUNCTION "fdp_save_process_version_draft"(p_workspace_id text,p_version_id text,p_expected_revision integer,p_bpmn_xml text,p_svg_preview text,p_configuration_json jsonb,p_step_configs jsonb,p_actor_id text) RETURNS integer LANGUAGE plpgsql SECURITY INVOKER AS $$ DECLARE next_revision integer; BEGIN
 UPDATE "fdp_process_versions" SET bpmn_xml=p_bpmn_xml,svg_preview=p_svg_preview,configuration_json=COALESCE(p_configuration_json,'{}'::jsonb),revision=revision+1,updated_by=p_actor_id,updated_at=now() WHERE workspace_id=p_workspace_id AND id=p_version_id AND revision=p_expected_revision AND status='draft' RETURNING revision INTO next_revision;
 IF next_revision IS NULL THEN RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='process version revision conflict'; END IF;
 DELETE FROM "fdp_process_step_configs" WHERE workspace_id=p_workspace_id AND process_version_id=p_version_id;
 INSERT INTO "fdp_process_step_configs" (id,workspace_id,process_version_id,bpmn_element_id,step_type,department_id,responsible_user_id,responsibility_mode,sla_value,sla_unit,sla_business_days,cutoff_time,escalation_json,create_demand,demand_type,requester_department_id,responsible_department_id,demand_priority,demand_sla_value,demand_sla_unit,checklist_id,checklist_json,form_id,required_documents_json,optional_documents_json,evidence_required,requires_approval,approver_user_id,approver_department_id,approval_count,approval_mode,subprocess_process_id,tasks_json,automations_json,settings_json)
 SELECT item->>'id',p_workspace_id,p_version_id,item->>'bpmnElementId',item->>'stepType',NULLIF(item->>'departmentId',''),NULLIF(item->>'responsibleUserId',''),item->>'responsibilityMode',COALESCE((item->>'slaValue')::integer,0),item->>'slaUnit',CASE WHEN COALESCE((item->>'slaBusinessDays')::boolean,false) THEN 1 ELSE 0 END,COALESCE(item->>'cutoffTime',''),COALESCE(item->'escalation','{}'::jsonb),CASE WHEN COALESCE((item->>'createDemand')::boolean,false) THEN 1 ELSE 0 END,COALESCE(item->>'demandType',''),NULLIF(item->>'requesterDepartmentId',''),NULLIF(item->>'responsibleDepartmentId',''),item->>'demandPriority',COALESCE((item->>'demandSlaValue')::integer,0),item->>'demandSlaUnit',NULLIF(item->>'checklistId',''),COALESCE(item->'checklistItems','[]'::jsonb),NULLIF(item->>'formId',''),COALESCE(item->'requiredDocuments','[]'::jsonb),COALESCE(item->'optionalDocuments','[]'::jsonb),CASE WHEN COALESCE((item->>'evidenceRequired')::boolean,false) THEN 1 ELSE 0 END,CASE WHEN COALESCE((item->>'requiresApproval')::boolean,false) THEN 1 ELSE 0 END,NULLIF(item->>'approverUserId',''),NULLIF(item->>'approverDepartmentId',''),COALESCE((item->>'approvalCount')::integer,1),item->>'approvalMode',NULLIF(item->>'subprocessProcessId',''),COALESCE(item->'tasks','[]'::jsonb),COALESCE(item->'automations','[]'::jsonb),COALESCE(item->'settings','{}'::jsonb) FROM jsonb_array_elements(COALESCE(p_step_configs,'[]'::jsonb)) item;
 UPDATE "fdp_process_definitions" SET current_version_id=p_version_id,lifecycle_status='draft',updated_by=p_actor_id,updated_at=now() WHERE workspace_id=p_workspace_id AND id=(SELECT definition_id FROM "fdp_process_versions" WHERE workspace_id=p_workspace_id AND id=p_version_id);
 RETURN next_revision; END; $$;
