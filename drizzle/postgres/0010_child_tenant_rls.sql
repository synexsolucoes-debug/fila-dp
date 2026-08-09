ALTER TABLE "fdp_companies" DISABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_labels" DISABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_custom_fields" DISABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_workspace_inbox_items" DISABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_activity_events" DISABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_lists" ADD COLUMN "workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '');
--> statement-breakpoint
ALTER TABLE "fdp_cards" ADD COLUMN "workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '');
--> statement-breakpoint
ALTER TABLE "fdp_checklist_items" ADD COLUMN "workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '');
--> statement-breakpoint
ALTER TABLE "fdp_card_comments" ADD COLUMN "workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '');
--> statement-breakpoint
ALTER TABLE "fdp_card_labels" ADD COLUMN "workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '');
--> statement-breakpoint
ALTER TABLE "fdp_card_assignees" ADD COLUMN "workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '');
--> statement-breakpoint
ALTER TABLE "fdp_custom_field_values" ADD COLUMN "workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '');
--> statement-breakpoint
ALTER TABLE "fdp_card_attachments" ADD COLUMN "workspace_id" text DEFAULT NULLIF(current_setting('app.workspace_id', true), '');
--> statement-breakpoint
UPDATE "fdp_lists" child SET "workspace_id" = parent."workspace_id"
FROM "fdp_boards" parent WHERE parent."id" = child."board_id";
--> statement-breakpoint
UPDATE "fdp_cards" child SET "workspace_id" = parent."workspace_id"
FROM "fdp_boards" parent WHERE parent."id" = child."board_id";
--> statement-breakpoint
UPDATE "fdp_checklist_items" child SET "workspace_id" = parent."workspace_id"
FROM "fdp_cards" parent WHERE parent."id" = child."card_id";
--> statement-breakpoint
UPDATE "fdp_card_comments" child SET "workspace_id" = parent."workspace_id"
FROM "fdp_cards" parent WHERE parent."id" = child."card_id";
--> statement-breakpoint
UPDATE "fdp_card_labels" child SET "workspace_id" = parent."workspace_id"
FROM "fdp_cards" parent WHERE parent."id" = child."card_id";
--> statement-breakpoint
UPDATE "fdp_card_assignees" child SET "workspace_id" = parent."workspace_id"
FROM "fdp_cards" parent WHERE parent."id" = child."card_id";
--> statement-breakpoint
UPDATE "fdp_custom_field_values" child SET "workspace_id" = parent."workspace_id"
FROM "fdp_cards" parent WHERE parent."id" = child."card_id";
--> statement-breakpoint
UPDATE "fdp_card_attachments" child SET "workspace_id" = parent."workspace_id"
FROM "fdp_cards" parent WHERE parent."id" = child."card_id";
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "fdp_lists" WHERE "workspace_id" IS NULL) THEN
    RAISE EXCEPTION 'tenant integrity preflight failed: fdp_lists.workspace_id';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "fdp_cards" card
    LEFT JOIN "fdp_boards" board ON board."id" = card."board_id"
    LEFT JOIN "fdp_lists" list ON list."id" = card."list_id"
    LEFT JOIN "fdp_companies" company ON company."id" = card."company_id"
    WHERE card."workspace_id" IS NULL
       OR list."id" IS NULL
       OR list."workspace_id" <> card."workspace_id"
       OR list."board_id" <> card."board_id"
       OR (card."company_id" IS NOT NULL AND (company."id" IS NULL OR company."workspace_id" <> card."workspace_id"))
  ) THEN
    RAISE EXCEPTION 'tenant integrity preflight failed: fdp_cards relationships';
  END IF;
  IF EXISTS (SELECT 1 FROM "fdp_checklist_items" child LEFT JOIN "fdp_cards" card ON card."id" = child."card_id" AND card."workspace_id" = child."workspace_id" WHERE child."workspace_id" IS NULL OR card."id" IS NULL) THEN
    RAISE EXCEPTION 'tenant integrity preflight failed: fdp_checklist_items';
  END IF;
  IF EXISTS (SELECT 1 FROM "fdp_card_comments" child LEFT JOIN "fdp_cards" card ON card."id" = child."card_id" AND card."workspace_id" = child."workspace_id" WHERE child."workspace_id" IS NULL OR card."id" IS NULL) THEN
    RAISE EXCEPTION 'tenant integrity preflight failed: fdp_card_comments';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "fdp_card_labels" child
    LEFT JOIN "fdp_cards" card ON card."id" = child."card_id" AND card."workspace_id" = child."workspace_id"
    LEFT JOIN "fdp_labels" label ON label."id" = child."label_id" AND label."workspace_id" = child."workspace_id"
    WHERE child."workspace_id" IS NULL OR card."id" IS NULL OR label."id" IS NULL
  ) THEN
    RAISE EXCEPTION 'tenant integrity preflight failed: fdp_card_labels';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "fdp_card_assignees" child
    LEFT JOIN "fdp_cards" card ON card."id" = child."card_id" AND card."workspace_id" = child."workspace_id"
    LEFT JOIN "fdp_workspace_members" member ON member."workspace_id" = child."workspace_id" AND member."user_id" = child."user_id"
    WHERE child."workspace_id" IS NULL OR card."id" IS NULL OR member."user_id" IS NULL
  ) THEN
    RAISE EXCEPTION 'tenant integrity preflight failed: fdp_card_assignees';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "fdp_custom_field_values" child
    LEFT JOIN "fdp_cards" card ON card."id" = child."card_id" AND card."workspace_id" = child."workspace_id"
    LEFT JOIN "fdp_custom_fields" field ON field."id" = child."field_id" AND field."workspace_id" = child."workspace_id"
    WHERE child."workspace_id" IS NULL OR card."id" IS NULL OR field."id" IS NULL
  ) THEN
    RAISE EXCEPTION 'tenant integrity preflight failed: fdp_custom_field_values';
  END IF;
  IF EXISTS (SELECT 1 FROM "fdp_card_attachments" child LEFT JOIN "fdp_cards" card ON card."id" = child."card_id" AND card."workspace_id" = child."workspace_id" WHERE child."workspace_id" IS NULL OR card."id" IS NULL) THEN
    RAISE EXCEPTION 'tenant integrity preflight failed: fdp_card_attachments';
  END IF;
  IF EXISTS (SELECT 1 FROM "fdp_notifications" child LEFT JOIN "fdp_workspace_members" member ON member."workspace_id" = child."workspace_id" AND member."user_id" = child."user_id" LEFT JOIN "fdp_cards" card ON card."workspace_id" = child."workspace_id" AND card."id" = child."card_id" WHERE member."user_id" IS NULL OR (child."card_id" IS NOT NULL AND card."id" IS NULL)) THEN
    RAISE EXCEPTION 'tenant integrity preflight failed: fdp_notifications';
  END IF;
  IF EXISTS (SELECT 1 FROM "fdp_planner_blocks" child LEFT JOIN "fdp_workspace_members" member ON member."workspace_id" = child."workspace_id" AND member."user_id" = child."user_id" LEFT JOIN "fdp_cards" card ON card."workspace_id" = child."workspace_id" AND card."id" = child."card_id" WHERE member."user_id" IS NULL OR (child."card_id" IS NOT NULL AND card."id" IS NULL)) THEN
    RAISE EXCEPTION 'tenant integrity preflight failed: fdp_planner_blocks';
  END IF;
  IF EXISTS (SELECT 1 FROM "fdp_calendar_connections" child LEFT JOIN "fdp_workspace_members" member ON member."workspace_id" = child."workspace_id" AND member."user_id" = child."user_id" WHERE member."user_id" IS NULL) THEN
    RAISE EXCEPTION 'tenant integrity preflight failed: fdp_calendar_connections';
  END IF;
  IF EXISTS (SELECT 1 FROM "fdp_card_sla_pauses" child LEFT JOIN "fdp_cards" card ON card."workspace_id" = child."workspace_id" AND card."id" = child."card_id" WHERE card."id" IS NULL) THEN
    RAISE EXCEPTION 'tenant integrity preflight failed: fdp_card_sla_pauses';
  END IF;
  IF EXISTS (SELECT 1 FROM "fdp_workspace_inbox_items" child LEFT JOIN "fdp_cards" card ON card."workspace_id" = child."workspace_id" AND card."id" = child."converted_card_id" WHERE child."converted_card_id" IS NOT NULL AND card."id" IS NULL) THEN
    RAISE EXCEPTION 'tenant integrity preflight failed: fdp_workspace_inbox_items.converted_card_id';
  END IF;
  IF EXISTS (SELECT 1 FROM "fdp_activity_events" child LEFT JOIN "fdp_cards" card ON card."workspace_id" = child."workspace_id" AND card."id" = child."card_id" WHERE child."card_id" IS NOT NULL AND card."id" IS NULL) THEN
    RAISE EXCEPTION 'tenant integrity preflight failed: fdp_activity_events.card_id';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "fdp_lists" ALTER COLUMN "workspace_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "fdp_cards" ALTER COLUMN "workspace_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "fdp_checklist_items" ALTER COLUMN "workspace_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "fdp_card_comments" ALTER COLUMN "workspace_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "fdp_card_labels" ALTER COLUMN "workspace_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "fdp_card_assignees" ALTER COLUMN "workspace_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "fdp_custom_field_values" ALTER COLUMN "workspace_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "fdp_card_attachments" ALTER COLUMN "workspace_id" SET NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "fdp_lists_workspace_id_uq" ON "fdp_lists" ("workspace_id", "id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "fdp_lists_workspace_board_id_uq" ON "fdp_lists" ("workspace_id", "board_id", "id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "fdp_cards_workspace_id_uq" ON "fdp_cards" ("workspace_id", "id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "fdp_labels_workspace_id_uq" ON "fdp_labels" ("workspace_id", "id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "fdp_custom_fields_workspace_id_uq" ON "fdp_custom_fields" ("workspace_id", "id");
--> statement-breakpoint
ALTER TABLE "fdp_lists" ADD CONSTRAINT "fdp_lists_workspace_board_fk" FOREIGN KEY ("workspace_id", "board_id") REFERENCES "public"."fdp_boards"("workspace_id", "id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "fdp_cards" ADD CONSTRAINT "fdp_cards_workspace_board_list_fk" FOREIGN KEY ("workspace_id", "board_id", "list_id") REFERENCES "public"."fdp_lists"("workspace_id", "board_id", "id") NOT VALID;
--> statement-breakpoint
ALTER TABLE "fdp_cards" ADD CONSTRAINT "fdp_cards_workspace_company_fk" FOREIGN KEY ("workspace_id", "company_id") REFERENCES "public"."fdp_companies"("workspace_id", "id") NOT VALID;
--> statement-breakpoint
ALTER TABLE "fdp_checklist_items" ADD CONSTRAINT "fdp_checklist_items_workspace_card_fk" FOREIGN KEY ("workspace_id", "card_id") REFERENCES "public"."fdp_cards"("workspace_id", "id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "fdp_card_comments" ADD CONSTRAINT "fdp_card_comments_workspace_card_fk" FOREIGN KEY ("workspace_id", "card_id") REFERENCES "public"."fdp_cards"("workspace_id", "id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "fdp_card_labels" ADD CONSTRAINT "fdp_card_labels_workspace_card_fk" FOREIGN KEY ("workspace_id", "card_id") REFERENCES "public"."fdp_cards"("workspace_id", "id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "fdp_card_labels" ADD CONSTRAINT "fdp_card_labels_workspace_label_fk" FOREIGN KEY ("workspace_id", "label_id") REFERENCES "public"."fdp_labels"("workspace_id", "id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "fdp_card_assignees" ADD CONSTRAINT "fdp_card_assignees_workspace_card_fk" FOREIGN KEY ("workspace_id", "card_id") REFERENCES "public"."fdp_cards"("workspace_id", "id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "fdp_card_assignees" ADD CONSTRAINT "fdp_card_assignees_workspace_member_fk" FOREIGN KEY ("workspace_id", "user_id") REFERENCES "public"."fdp_workspace_members"("workspace_id", "user_id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "fdp_custom_field_values" ADD CONSTRAINT "fdp_custom_field_values_workspace_card_fk" FOREIGN KEY ("workspace_id", "card_id") REFERENCES "public"."fdp_cards"("workspace_id", "id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "fdp_custom_field_values" ADD CONSTRAINT "fdp_custom_field_values_workspace_field_fk" FOREIGN KEY ("workspace_id", "field_id") REFERENCES "public"."fdp_custom_fields"("workspace_id", "id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "fdp_card_attachments" ADD CONSTRAINT "fdp_card_attachments_workspace_card_fk" FOREIGN KEY ("workspace_id", "card_id") REFERENCES "public"."fdp_cards"("workspace_id", "id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "fdp_notifications" ADD CONSTRAINT "fdp_notifications_workspace_member_fk" FOREIGN KEY ("workspace_id", "user_id") REFERENCES "public"."fdp_workspace_members"("workspace_id", "user_id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "fdp_notifications" ADD CONSTRAINT "fdp_notifications_workspace_card_fk" FOREIGN KEY ("workspace_id", "card_id") REFERENCES "public"."fdp_cards"("workspace_id", "id") NOT VALID;
--> statement-breakpoint
ALTER TABLE "fdp_planner_blocks" ADD CONSTRAINT "fdp_planner_blocks_workspace_member_fk" FOREIGN KEY ("workspace_id", "user_id") REFERENCES "public"."fdp_workspace_members"("workspace_id", "user_id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "fdp_planner_blocks" ADD CONSTRAINT "fdp_planner_blocks_workspace_card_fk" FOREIGN KEY ("workspace_id", "card_id") REFERENCES "public"."fdp_cards"("workspace_id", "id") NOT VALID;
--> statement-breakpoint
ALTER TABLE "fdp_calendar_connections" ADD CONSTRAINT "fdp_calendar_connections_workspace_member_fk" FOREIGN KEY ("workspace_id", "user_id") REFERENCES "public"."fdp_workspace_members"("workspace_id", "user_id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "fdp_card_sla_pauses" ADD CONSTRAINT "fdp_card_sla_pauses_workspace_card_fk" FOREIGN KEY ("workspace_id", "card_id") REFERENCES "public"."fdp_cards"("workspace_id", "id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "fdp_workspace_inbox_items" ADD CONSTRAINT "fdp_workspace_inbox_items_workspace_card_fk" FOREIGN KEY ("workspace_id", "converted_card_id") REFERENCES "public"."fdp_cards"("workspace_id", "id") NOT VALID;
--> statement-breakpoint
ALTER TABLE "fdp_activity_events" ADD CONSTRAINT "fdp_activity_events_workspace_card_fk" FOREIGN KEY ("workspace_id", "card_id") REFERENCES "public"."fdp_cards"("workspace_id", "id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
DO $$
DECLARE constraint_name text;
BEGIN
  FOREACH constraint_name IN ARRAY ARRAY[
    'fdp_lists_workspace_board_fk', 'fdp_cards_workspace_board_list_fk', 'fdp_cards_workspace_company_fk',
    'fdp_checklist_items_workspace_card_fk', 'fdp_card_comments_workspace_card_fk',
    'fdp_card_labels_workspace_card_fk', 'fdp_card_labels_workspace_label_fk',
    'fdp_card_assignees_workspace_card_fk', 'fdp_card_assignees_workspace_member_fk',
    'fdp_custom_field_values_workspace_card_fk', 'fdp_custom_field_values_workspace_field_fk',
    'fdp_card_attachments_workspace_card_fk', 'fdp_notifications_workspace_member_fk',
    'fdp_notifications_workspace_card_fk', 'fdp_planner_blocks_workspace_member_fk',
    'fdp_planner_blocks_workspace_card_fk', 'fdp_calendar_connections_workspace_member_fk',
    'fdp_card_sla_pauses_workspace_card_fk', 'fdp_workspace_inbox_items_workspace_card_fk',
    'fdp_activity_events_workspace_card_fk'
  ] LOOP
    EXECUTE format('ALTER TABLE %I VALIDATE CONSTRAINT %I',
      CASE
        WHEN constraint_name LIKE 'fdp_lists_%' THEN 'fdp_lists'
        WHEN constraint_name LIKE 'fdp_cards_%' THEN 'fdp_cards'
        WHEN constraint_name LIKE 'fdp_checklist_items_%' THEN 'fdp_checklist_items'
        WHEN constraint_name LIKE 'fdp_card_comments_%' THEN 'fdp_card_comments'
        WHEN constraint_name LIKE 'fdp_card_labels_%' THEN 'fdp_card_labels'
        WHEN constraint_name LIKE 'fdp_card_assignees_%' THEN 'fdp_card_assignees'
        WHEN constraint_name LIKE 'fdp_custom_field_values_%' THEN 'fdp_custom_field_values'
        WHEN constraint_name LIKE 'fdp_card_attachments_%' THEN 'fdp_card_attachments'
        WHEN constraint_name LIKE 'fdp_notifications_%' THEN 'fdp_notifications'
        WHEN constraint_name LIKE 'fdp_planner_blocks_%' THEN 'fdp_planner_blocks'
        WHEN constraint_name LIKE 'fdp_calendar_connections_%' THEN 'fdp_calendar_connections'
        WHEN constraint_name LIKE 'fdp_card_sla_pauses_%' THEN 'fdp_card_sla_pauses'
        WHEN constraint_name LIKE 'fdp_workspace_inbox_items_%' THEN 'fdp_workspace_inbox_items'
        ELSE 'fdp_activity_events'
      END,
      constraint_name);
  END LOOP;
END $$;
--> statement-breakpoint
ALTER TABLE "fdp_companies" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_companies" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_labels" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_labels" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_custom_fields" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_custom_fields" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_workspace_inbox_items" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_workspace_inbox_items" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_activity_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_activity_events" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_boards" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_boards" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "fdp_boards_workspace_isolation" ON "fdp_boards" USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), '')) WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
--> statement-breakpoint
ALTER TABLE "fdp_lists" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_lists" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "fdp_lists_workspace_isolation" ON "fdp_lists" USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), '')) WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
--> statement-breakpoint
ALTER TABLE "fdp_cards" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_cards" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "fdp_cards_workspace_isolation" ON "fdp_cards" USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), '')) WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
--> statement-breakpoint
ALTER TABLE "fdp_checklist_items" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_checklist_items" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "fdp_checklist_items_workspace_isolation" ON "fdp_checklist_items" USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), '')) WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
--> statement-breakpoint
ALTER TABLE "fdp_card_comments" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_card_comments" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "fdp_card_comments_workspace_isolation" ON "fdp_card_comments" USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), '')) WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
--> statement-breakpoint
ALTER TABLE "fdp_card_labels" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_card_labels" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "fdp_card_labels_workspace_isolation" ON "fdp_card_labels" USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), '')) WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
--> statement-breakpoint
ALTER TABLE "fdp_card_assignees" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_card_assignees" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "fdp_card_assignees_workspace_isolation" ON "fdp_card_assignees" USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), '')) WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
--> statement-breakpoint
ALTER TABLE "fdp_custom_field_values" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_custom_field_values" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "fdp_custom_field_values_workspace_isolation" ON "fdp_custom_field_values" USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), '')) WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
--> statement-breakpoint
ALTER TABLE "fdp_card_attachments" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_card_attachments" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "fdp_card_attachments_workspace_isolation" ON "fdp_card_attachments" USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), '')) WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
--> statement-breakpoint
ALTER TABLE "fdp_notifications" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_notifications" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "fdp_notifications_workspace_isolation" ON "fdp_notifications" USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), '')) WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
--> statement-breakpoint
ALTER TABLE "fdp_planner_blocks" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_planner_blocks" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "fdp_planner_blocks_workspace_isolation" ON "fdp_planner_blocks" USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), '')) WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
--> statement-breakpoint
ALTER TABLE "fdp_calendar_connections" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_calendar_connections" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "fdp_calendar_connections_workspace_isolation" ON "fdp_calendar_connections" USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), '')) WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
--> statement-breakpoint
ALTER TABLE "fdp_card_sla_pauses" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fdp_card_sla_pauses" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "fdp_card_sla_pauses_workspace_isolation" ON "fdp_card_sla_pauses" USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), '')) WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), ''));
