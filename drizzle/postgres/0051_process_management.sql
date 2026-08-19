-- allow-destructive-migration: substitui atomicamente apenas as configurações de etapas da versão BPMN em rascunho durante o autosave; não exclui processos, versões ou execuções.
-- Gestão e Modelagem de Processos — Vinculato
ALTER TABLE "fdp_process_definitions" ADD COLUMN "description" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "fdp_process_definitions" ADD COLUMN "objective" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "fdp_process_definitions" ADD COLUMN "owner_department_id" text;--> statement-breakpoint
ALTER TABLE "fdp_process_definitions" ADD COLUMN "owner_user_id" text;--> statement-breakpoint
ALTER TABLE "fdp_process_definitions" ADD COLUMN "current_version_id" text;--> statement-breakpoint
ALTER TABLE "fdp_process_definitions" ADD COLUMN "lifecycle_status" text DEFAULT 'draft' NOT NULL;--> statement-breakpoint
ALTER TABLE "fdp_process_definitions" ADD COLUMN "is_corporate" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "fdp_process_definitions" ADD COLUMN "allow_manual_start" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "fdp_process_definitions" ADD COLUMN "allow_automatic_start" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "fdp_process_definitions" ADD COLUMN "require_publication_approval" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "fdp_process_definitions" ADD COLUMN "global_sla_value" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "fdp_process_definitions" ADD COLUMN "global_sla_unit" text DEFAULT 'hours' NOT NULL;--> statement-breakpoint
ALTER TABLE "fdp_process_definitions" ADD COLUMN "criticality" text DEFAULT 'medium' NOT NULL;--> statement-breakpoint
ALTER TABLE "fdp_process_definitions" ADD COLUMN "default_priority" text DEFAULT 'normal' NOT NULL;--> statement-breakpoint
ALTER TABLE "fdp_process_definitions" ADD COLUMN "tags_json" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "fdp_process_definitions" ADD COLUMN "notes" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "fdp_process_definitions" ADD COLUMN "created_by" text;--> statement-breakpoint
ALTER TABLE "fdp_process_definitions" ADD COLUMN "updated_by" text;--> statement-breakpoint
ALTER TABLE "fdp_process_definitions" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
UPDATE "fdp_process_definitions" p SET
 created_by=COALESCE((SELECT v.created_by FROM "fdp_process_versions" v WHERE v.workspace_id=p.workspace_id AND v.definition_id=p.id ORDER BY v.created_at LIMIT 1),(SELECT w.owner_user_id FROM "fdp_workspaces" w WHERE w.id=p.workspace_id)),
 updated_by=COALESCE((SELECT v.created_by FROM "fdp_process_versions" v WHERE v.workspace_id=p.workspace_id AND v.definition_id=p.id ORDER BY v.created_at DESC LIMIT 1),(SELECT w.owner_user_id FROM "fdp_workspaces" w WHERE w.id=p.workspace_id)),
 lifecycle_status=CASE WHEN p.status='inactive' THEN 'inactive' WHEN EXISTS(SELECT 1 FROM "fdp_process_versions" v WHERE v.workspace_id=p.workspace_id AND v.definition_id=p.id AND v.status='published') THEN 'published' ELSE 'draft' END;--> statement-breakpoint
ALTER TABLE "fdp_process_definitions" ADD CONSTRAINT "fdp_process_definitions_lifecycle_check" CHECK ("lifecycle_status" IN ('draft','in_review','published','inactive','archived'));--> statement-breakpoint
ALTER TABLE "fdp_process_definitions" ADD CONSTRAINT "fdp_process_definitions_flags_check" CHECK ("is_corporate" IN (0,1) AND "allow_manual_start" IN (0,1) AND "allow_automatic_start" IN (0,1) AND "require_publication_approval" IN (0,1));--> statement-breakpoint
ALTER TABLE "fdp_process_definitions" ADD CONSTRAINT "fdp_process_definitions_sla_check" CHECK ("global_sla_value">=0 AND "global_sla_value"<=525600 AND "global_sla_unit" IN ('minutes','hours','days'));--> statement-breakpoint
ALTER TABLE "fdp_process_definitions" ADD CONSTRAINT "fdp_process_definitions_criticality_check" CHECK ("criticality" IN ('low','medium','high','critical'));--> statement-breakpoint
ALTER TABLE "fdp_process_definitions" ADD CONSTRAINT "fdp_process_definitions_priority_check" CHECK ("default_priority" IN ('low','normal','high','urgent'));--> statement-breakpoint
ALTER TABLE "fdp_process_definitions" ADD CONSTRAINT "fdp_process_definitions_owner_department_fk" FOREIGN KEY ("workspace_id","owner_department_id") REFERENCES "public"."fdp_areas"("workspace_id","id");--> statement-breakpoint
ALTER TABLE "fdp_process_definitions" ADD CONSTRAINT "fdp_process_definitions_owner_user_fk" FOREIGN KEY ("workspace_id","owner_user_id") REFERENCES "public"."fdp_workspace_members"("workspace_id","user_id");--> statement-breakpoint
ALTER TABLE "fdp_process_definitions" ADD CONSTRAINT "fdp_process_definitions_created_by_fk" FOREIGN KEY ("workspace_id","created_by") REFERENCES "public"."fdp_workspace_members"("workspace_id","user_id");--> statement-breakpoint
ALTER TABLE "fdp_process_definitions" ADD CONSTRAINT "fdp_process_definitions_updated_by_fk" FOREIGN KEY ("workspace_id","updated_by") REFERENCES "public"."fdp_workspace_members"("workspace_id","user_id");--> statement-breakpoint
CREATE INDEX "fdp_process_definitions_workspace_lifecycle_idx" ON "fdp_process_definitions" ("workspace_id","lifecycle_status","updated_at");--> statement-breakpoint
CREATE INDEX "fdp_process_definitions_workspace_owner_department_idx" ON "fdp_process_definitions" ("workspace_id","owner_department_id","lifecycle_status");--> statement-breakpoint

ALTER TABLE "fdp_process_versions" ADD COLUMN "version_major" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "fdp_process_versions" ADD COLUMN "version_minor" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "fdp_process_versions" ADD COLUMN "bpmn_xml" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "fdp_process_versions" ADD COLUMN "svg_preview" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "fdp_process_versions" ADD COLUMN "revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "fdp_process_versions" ADD COLUMN "change_summary" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "fdp_process_versions" ADD COLUMN "updated_by" text;--> statement-breakpoint
ALTER TABLE "fdp_process_versions" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
UPDATE "fdp_process_versions" SET version_major=version,version_minor=0,updated_by=created_by,updated_at=created_at;--> statement-breakpoint
ALTER TABLE "fdp_process_versions" DROP CONSTRAINT IF EXISTS "fdp_process_versions_status_check";--> statement-breakpoint
ALTER TABLE "fdp_process_versions" ADD CONSTRAINT "fdp_process_versions_status_check" CHECK ("status" IN ('draft','in_review','published','retired'));--> statement-breakpoint
ALTER TABLE "fdp_process_versions" ADD CONSTRAINT "fdp_process_versions_semver_check" CHECK ("version_major">0 AND "version_minor">=0 AND "revision">=0);--> statement-breakpoint
ALTER TABLE "fdp_process_versions" ADD CONSTRAINT "fdp_process_versions_updated_by_fk" FOREIGN KEY ("workspace_id","updated_by") REFERENCES "public"."fdp_workspace_members"("workspace_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_process_versions_definition_semver_uq" ON "fdp_process_versions" ("workspace_id","definition_id","version_major","version_minor");--> statement-breakpoint
UPDATE "fdp_process_definitions" p SET current_version_id=(SELECT v.id FROM "fdp_process_versions" v WHERE v.workspace_id=p.workspace_id AND v.definition_id=p.id ORDER BY v.version_major DESC,v.version_minor DESC,v.version DESC LIMIT 1) WHERE current_version_id IS NULL;--> statement-breakpoint
ALTER TABLE "fdp_process_definitions" ADD CONSTRAINT "fdp_process_definitions_current_version_fk" FOREIGN KEY ("workspace_id","current_version_id") REFERENCES "public"."fdp_process_versions"("workspace_id","id");--> statement-breakpoint

CREATE TABLE "fdp_process_companies" (
 "workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
 "process_id" text NOT NULL,"company_id" text NOT NULL,"created_by" text NOT NULL,
 "created_at" timestamp with time zone DEFAULT now() NOT NULL,
 CONSTRAINT "fdp_process_companies_pk" PRIMARY KEY ("workspace_id","process_id","company_id")
);--> statement-breakpoint
ALTER TABLE "fdp_process_companies" ADD CONSTRAINT "fdp_process_companies_process_fk" FOREIGN KEY ("workspace_id","process_id") REFERENCES "public"."fdp_process_definitions"("workspace_id","id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "fdp_process_companies" ADD CONSTRAINT "fdp_process_companies_company_fk" FOREIGN KEY ("workspace_id","company_id") REFERENCES "public"."fdp_companies"("workspace_id","id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "fdp_process_companies" ADD CONSTRAINT "fdp_process_companies_creator_fk" FOREIGN KEY ("workspace_id","created_by") REFERENCES "public"."fdp_workspace_members"("workspace_id","user_id");--> statement-breakpoint
CREATE INDEX "fdp_process_companies_workspace_company_idx" ON "fdp_process_companies" ("workspace_id","company_id","process_id");--> statement-breakpoint

CREATE TABLE "fdp_process_step_configs" (
 "id" text PRIMARY KEY NOT NULL,"workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '') NOT NULL,
 "process_version_id" text NOT NULL,"bpmn_element_id" text NOT NULL,"step_type" text DEFAULT 'TASK' NOT NULL,
 "department_id" text,"responsible_user_id" text,"responsibility_mode" text DEFAULT 'DEPARTMENT' NOT NULL,
 "sla_value" integer DEFAULT 0 NOT NULL,"sla_unit" text DEFAULT 'hours' NOT NULL,"sla_business_days" integer DEFAULT 0 NOT NULL,
 "cutoff_time" text DEFAULT '' NOT NULL,"escalation_json" jsonb DEFAULT '{}'::jsonb NOT NULL,"create_demand" integer DEFAULT 0 NOT NULL,"demand_type" text DEFAULT '' NOT NULL,
 "requester_department_id" text,"responsible_department_id" text,"demand_priority" text DEFAULT 'normal' NOT NULL,
 "demand_sla_value" integer DEFAULT 0 NOT NULL,"demand_sla_unit" text DEFAULT 'hours' NOT NULL,
 "checklist_id" text,"checklist_json" jsonb DEFAULT '[]'::jsonb NOT NULL,"form_id" text,"required_documents_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
 "optional_documents_json" jsonb DEFAULT '[]'::jsonb NOT NULL,"evidence_required" integer DEFAULT 0 NOT NULL,
 "requires_approval" integer DEFAULT 0 NOT NULL,"approver_user_id" text,"approver_department_id" text,
 "approval_count" integer DEFAULT 1 NOT NULL,"approval_mode" text DEFAULT 'sequential' NOT NULL,"subprocess_process_id" text,
 "settings_json" jsonb DEFAULT '{}'::jsonb NOT NULL,"created_at" timestamp with time zone DEFAULT now() NOT NULL,"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
 CONSTRAINT "fdp_process_step_configs_type_check" CHECK ("step_type" IN ('TASK','USER_TASK','APPROVAL','SYSTEM_TASK','NOTIFICATION','FORM','DOCUMENT_REQUEST','DEMAND_CREATION','CONDITION','SUBPROCESS','LANE','START_EVENT','END_EVENT','GATEWAY')),
 CONSTRAINT "fdp_process_step_configs_responsibility_check" CHECK ("responsibility_mode" IN ('USER','DEPARTMENT','DEPARTMENT_MANAGER','REQUESTER','EMPLOYEE_MANAGER','PROCESS_OWNER','DYNAMIC')),
 CONSTRAINT "fdp_process_step_configs_sla_check" CHECK ("sla_value">=0 AND "sla_value"<=525600 AND "demand_sla_value">=0 AND "demand_sla_value"<=525600 AND "sla_unit" IN ('minutes','hours','days') AND "demand_sla_unit" IN ('minutes','hours','days') AND "sla_business_days" IN (0,1)),
 CONSTRAINT "fdp_process_step_configs_flags_check" CHECK ("create_demand" IN (0,1) AND "evidence_required" IN (0,1) AND "requires_approval" IN (0,1)),
 CONSTRAINT "fdp_process_step_configs_approval_check" CHECK ("approval_count">0 AND "approval_count"<=20 AND "approval_mode" IN ('sequential','parallel')),
 CONSTRAINT "fdp_process_step_configs_priority_check" CHECK ("demand_priority" IN ('low','normal','high','urgent'))
);--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_process_step_configs_version_element_uq" ON "fdp_process_step_configs" ("workspace_id","process_version_id","bpmn_element_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fdp_process_step_configs_workspace_id_uq" ON "fdp_process_step_configs" ("workspace_id","id");--> statement-breakpoint
ALTER TABLE "fdp_process_step_configs" ADD CONSTRAINT "fdp_process_step_configs_version_fk" FOREIGN KEY ("workspace_id","process_version_id") REFERENCES "public"."fdp_process_versions"("workspace_id","id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "fdp_process_step_configs" ADD CONSTRAINT "fdp_process_step_configs_department_fk" FOREIGN KEY ("workspace_id","department_id") REFERENCES "public"."fdp_areas"("workspace_id","id");--> statement-breakpoint
ALTER TABLE "fdp_process_step_configs" ADD CONSTRAINT "fdp_process_step_configs_requester_department_fk" FOREIGN KEY ("workspace_id","requester_department_id") REFERENCES "public"."fdp_areas"("workspace_id","id");--> statement-breakpoint
ALTER TABLE "fdp_process_step_configs" ADD CONSTRAINT "fdp_process_step_configs_responsible_department_fk" FOREIGN KEY ("workspace_id","responsible_department_id") REFERENCES "public"."fdp_areas"("workspace_id","id");--> statement-breakpoint
ALTER TABLE "fdp_process_step_configs" ADD CONSTRAINT "fdp_process_step_configs_approver_department_fk" FOREIGN KEY ("workspace_id","approver_department_id") REFERENCES "public"."fdp_areas"("workspace_id","id");--> statement-breakpoint
ALTER TABLE "fdp_process_step_configs" ADD CONSTRAINT "fdp_process_step_configs_responsible_user_fk" FOREIGN KEY ("workspace_id","responsible_user_id") REFERENCES "public"."fdp_workspace_members"("workspace_id","user_id");--> statement-breakpoint
ALTER TABLE "fdp_process_step_configs" ADD CONSTRAINT "fdp_process_step_configs_approver_user_fk" FOREIGN KEY ("workspace_id","approver_user_id") REFERENCES "public"."fdp_workspace_members"("workspace_id","user_id");--> statement-breakpoint
ALTER TABLE "fdp_process_step_configs" ADD CONSTRAINT "fdp_process_step_configs_subprocess_fk" FOREIGN KEY ("workspace_id","subprocess_process_id") REFERENCES "public"."fdp_process_definitions"("workspace_id","id");--> statement-breakpoint
ALTER TABLE "fdp_process_companies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "fdp_process_companies" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "fdp_process_companies_workspace_isolation" ON "fdp_process_companies" USING ("workspace_id"=NULLIF(current_setting('app.workspace_id',true),'')) WITH CHECK ("workspace_id"=NULLIF(current_setting('app.workspace_id',true),''));--> statement-breakpoint
ALTER TABLE "fdp_process_step_configs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "fdp_process_step_configs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "fdp_process_step_configs_workspace_isolation" ON "fdp_process_step_configs" USING ("workspace_id"=NULLIF(current_setting('app.workspace_id',true),'')) WITH CHECK ("workspace_id"=NULLIF(current_setting('app.workspace_id',true),''));--> statement-breakpoint

CREATE OR REPLACE FUNCTION "fdp_protect_published_process_version"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' AND OLD.status IN ('in_review','published','retired') THEN RAISE EXCEPTION 'reviewed or published process versions are immutable'; END IF;
 IF TG_OP='UPDATE' AND OLD.status IN ('in_review','published','retired') AND (NEW.configuration_json IS DISTINCT FROM OLD.configuration_json OR NEW.bpmn_xml IS DISTINCT FROM OLD.bpmn_xml OR NEW.svg_preview IS DISTINCT FROM OLD.svg_preview OR NEW.version IS DISTINCT FROM OLD.version OR NEW.version_major IS DISTINCT FROM OLD.version_major OR NEW.version_minor IS DISTINCT FROM OLD.version_minor OR NEW.definition_id IS DISTINCT FROM OLD.definition_id OR NEW.revision IS DISTINCT FROM OLD.revision) THEN RAISE EXCEPTION 'reviewed or published process versions are immutable'; END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END; $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "fdp_protect_process_step_config"() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE s text; w text; v text; BEGIN w:=CASE WHEN TG_OP='DELETE' THEN OLD.workspace_id ELSE NEW.workspace_id END; v:=CASE WHEN TG_OP='DELETE' THEN OLD.process_version_id ELSE NEW.process_version_id END; SELECT status INTO s FROM "fdp_process_versions" WHERE workspace_id=w AND id=v; IF s IN ('in_review','published','retired') THEN RAISE EXCEPTION 'reviewed or published process step configs are immutable'; END IF; RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END; $$;--> statement-breakpoint
CREATE TRIGGER "fdp_process_step_configs_immutable" BEFORE INSERT OR UPDATE OR DELETE ON "fdp_process_step_configs" FOR EACH ROW EXECUTE FUNCTION "fdp_protect_process_step_config"();--> statement-breakpoint

CREATE OR REPLACE FUNCTION "fdp_save_process_version_draft"(p_workspace_id text,p_version_id text,p_expected_revision integer,p_bpmn_xml text,p_svg_preview text,p_configuration_json jsonb,p_step_configs jsonb,p_actor_id text) RETURNS integer LANGUAGE plpgsql SECURITY INVOKER AS $$ DECLARE next_revision integer; BEGIN
 UPDATE "fdp_process_versions" SET bpmn_xml=p_bpmn_xml,svg_preview=p_svg_preview,configuration_json=COALESCE(p_configuration_json,'{}'::jsonb),revision=revision+1,updated_by=p_actor_id,updated_at=now() WHERE workspace_id=p_workspace_id AND id=p_version_id AND revision=p_expected_revision AND status='draft' RETURNING revision INTO next_revision;
 IF next_revision IS NULL THEN RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='process version revision conflict'; END IF;
 DELETE FROM "fdp_process_step_configs" WHERE workspace_id=p_workspace_id AND process_version_id=p_version_id;
 INSERT INTO "fdp_process_step_configs" (id,workspace_id,process_version_id,bpmn_element_id,step_type,department_id,responsible_user_id,responsibility_mode,sla_value,sla_unit,sla_business_days,cutoff_time,escalation_json,create_demand,demand_type,requester_department_id,responsible_department_id,demand_priority,demand_sla_value,demand_sla_unit,checklist_id,checklist_json,form_id,required_documents_json,optional_documents_json,evidence_required,requires_approval,approver_user_id,approver_department_id,approval_count,approval_mode,subprocess_process_id,settings_json)
 SELECT item->>'id',p_workspace_id,p_version_id,item->>'bpmnElementId',item->>'stepType',NULLIF(item->>'departmentId',''),NULLIF(item->>'responsibleUserId',''),item->>'responsibilityMode',COALESCE((item->>'slaValue')::integer,0),item->>'slaUnit',CASE WHEN COALESCE((item->>'slaBusinessDays')::boolean,false) THEN 1 ELSE 0 END,COALESCE(item->>'cutoffTime',''),COALESCE(item->'escalation','{}'::jsonb),CASE WHEN COALESCE((item->>'createDemand')::boolean,false) THEN 1 ELSE 0 END,COALESCE(item->>'demandType',''),NULLIF(item->>'requesterDepartmentId',''),NULLIF(item->>'responsibleDepartmentId',''),item->>'demandPriority',COALESCE((item->>'demandSlaValue')::integer,0),item->>'demandSlaUnit',NULLIF(item->>'checklistId',''),COALESCE(item->'checklistItems','[]'::jsonb),NULLIF(item->>'formId',''),COALESCE(item->'requiredDocuments','[]'::jsonb),COALESCE(item->'optionalDocuments','[]'::jsonb),CASE WHEN COALESCE((item->>'evidenceRequired')::boolean,false) THEN 1 ELSE 0 END,CASE WHEN COALESCE((item->>'requiresApproval')::boolean,false) THEN 1 ELSE 0 END,NULLIF(item->>'approverUserId',''),NULLIF(item->>'approverDepartmentId',''),COALESCE((item->>'approvalCount')::integer,1),item->>'approvalMode',NULLIF(item->>'subprocessProcessId',''),COALESCE(item->'settings','{}'::jsonb) FROM jsonb_array_elements(COALESCE(p_step_configs,'[]'::jsonb)) item;
 UPDATE "fdp_process_definitions" SET current_version_id=p_version_id,lifecycle_status='draft',updated_by=p_actor_id,updated_at=now() WHERE workspace_id=p_workspace_id AND id=(SELECT definition_id FROM "fdp_process_versions" WHERE workspace_id=p_workspace_id AND id=p_version_id);
 RETURN next_revision; END; $$;
--> statement-breakpoint
-- Compatibilidade com a Biblioteca antiga de Operação DP: versões criadas pelas rotas legadas
-- recebem semver determinístico e BPMN mínimo em vez de quebrar o novo modelador.
UPDATE "fdp_process_versions" SET "bpmn_xml" = '<?xml version="1.0" encoding="UTF-8"?><bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" xmlns:di="http://www.omg.org/spec/DD/20100524/DI" id="Definitions_Legacy" targetNamespace="http://bpmn.io/schema/bpmn"><bpmn:process id="Process_Legacy" isExecutable="false"><bpmn:startEvent id="StartEvent_1"><bpmn:outgoing>Flow_1</bpmn:outgoing></bpmn:startEvent><bpmn:userTask id="Activity_1" name="Fluxo legado"><bpmn:incoming>Flow_1</bpmn:incoming><bpmn:outgoing>Flow_2</bpmn:outgoing></bpmn:userTask><bpmn:endEvent id="EndEvent_1"><bpmn:incoming>Flow_2</bpmn:incoming></bpmn:endEvent><bpmn:sequenceFlow id="Flow_1" sourceRef="StartEvent_1" targetRef="Activity_1"/><bpmn:sequenceFlow id="Flow_2" sourceRef="Activity_1" targetRef="EndEvent_1"/></bpmn:process><bpmndi:BPMNDiagram id="BPMNDiagram_1"><bpmndi:BPMNPlane id="BPMNPlane_1" bpmnElement="Process_Legacy"><bpmndi:BPMNShape id="StartEvent_1_di" bpmnElement="StartEvent_1"><dc:Bounds x="180" y="160" width="36" height="36"/></bpmndi:BPMNShape><bpmndi:BPMNShape id="Activity_1_di" bpmnElement="Activity_1"><dc:Bounds x="290" y="138" width="120" height="80"/></bpmndi:BPMNShape><bpmndi:BPMNShape id="EndEvent_1_di" bpmnElement="EndEvent_1"><dc:Bounds x="490" y="160" width="36" height="36"/></bpmndi:BPMNShape><bpmndi:BPMNEdge id="Flow_1_di" bpmnElement="Flow_1"><di:waypoint x="216" y="178"/><di:waypoint x="290" y="178"/></bpmndi:BPMNEdge><bpmndi:BPMNEdge id="Flow_2_di" bpmnElement="Flow_2"><di:waypoint x="410" y="178"/><di:waypoint x="490" y="178"/></bpmndi:BPMNEdge></bpmndi:BPMNPlane></bpmndi:BPMNDiagram></bpmn:definitions>' WHERE "bpmn_xml" = '';--> statement-breakpoint
CREATE OR REPLACE FUNCTION "fdp_prepare_process_version_insert"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NEW.version > 1 AND NEW.version_major = 1 AND NEW.version_minor = 0 THEN NEW.version_major := NEW.version; END IF;
  IF NEW.updated_by IS NULL THEN NEW.updated_by := NEW.created_by; END IF;
  IF NEW.bpmn_xml = '' THEN NEW.bpmn_xml := '<?xml version="1.0" encoding="UTF-8"?><bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="Definitions_Legacy" targetNamespace="http://bpmn.io/schema/bpmn"><bpmn:process id="Process_Legacy" isExecutable="false"><bpmn:startEvent id="StartEvent_1"/><bpmn:endEvent id="EndEvent_1"/></bpmn:process></bpmn:definitions>'; END IF;
  RETURN NEW;
END; $$;--> statement-breakpoint
CREATE TRIGGER "fdp_process_versions_prepare_insert" BEFORE INSERT ON "fdp_process_versions" FOR EACH ROW EXECUTE FUNCTION "fdp_prepare_process_version_insert"();--> statement-breakpoint
CREATE OR REPLACE FUNCTION "fdp_sync_process_definition_version"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NEW.status IN ('draft','in_review','published') THEN
    UPDATE "fdp_process_definitions" SET current_version_id=NEW.id,lifecycle_status=NEW.status,status='active',updated_by=COALESCE(NEW.updated_by,NEW.created_by),updated_at=now()
    WHERE workspace_id=NEW.workspace_id AND id=NEW.definition_id;
  END IF;
  RETURN NEW;
END; $$;--> statement-breakpoint
CREATE TRIGGER "fdp_process_versions_sync_definition" AFTER INSERT OR UPDATE OF status ON "fdp_process_versions" FOR EACH ROW EXECUTE FUNCTION "fdp_sync_process_definition_version"();
