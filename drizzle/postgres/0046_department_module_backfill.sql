-- O papel operacional do SESMT já era representado por `epi.owner`. A nova
-- associação de módulos do departamento usa a chave real do catálogo. Manter
-- as duas linhas separa propriedade do módulo de roteamento SESMT -> DP.
INSERT INTO "fdp_area_module_assignments" ("workspace_id", "module_key", "area_id", "created_by")
SELECT "workspace_id", 'epi', "area_id", "created_by"
FROM "fdp_area_module_assignments"
WHERE "module_key" = 'epi.owner'
ON CONFLICT ("workspace_id", "module_key") DO NOTHING;
