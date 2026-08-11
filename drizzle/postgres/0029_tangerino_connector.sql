INSERT INTO "fdp_integrations" ("id", "workspace_id", "channel", "display_name", "status", "config_json")
SELECT workspace."id" || ':integration:tangerino', workspace."id", 'tangerino', 'Sólides DP (Tangerino)', 'needs_credentials', '{}'
FROM "fdp_workspaces" workspace
ON CONFLICT ("workspace_id", "channel") DO NOTHING;
