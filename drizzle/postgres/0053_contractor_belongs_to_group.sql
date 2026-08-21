-- O prestador PJ passa a ser do grupo, e não de uma empresa.
--
-- Até aqui o contrato do PJ carregava uma empresa obrigatória, e era ela que
-- decidia em qual apuração o prestador entrava. Só que quem presta serviço é o
-- PJ: ele atende as empresas do grupo, e não o contrário. Um PJ que atendia
-- duas empresas precisava existir duas vezes, com dois códigos e duas
-- apurações — e ninguém conseguia responder quanto aquela pessoa recebeu no mês
-- sem somar à mão.
--
-- A empresa não desaparece: ela passa a ser informada onde de fato importa —
-- na apuração, que é quem paga; na nota, que é quem recebe; e nos relatórios.
-- A coluna do contrato continua existindo como sugestão de qual empresa
-- costuma apurar aquele prestador, mas deixa de ser obrigatória e deixa de
-- definir a quem ele pertence.
ALTER TABLE "fdp_contractor_profiles"
  ALTER COLUMN "company_id" DROP NOT NULL;
--> statement-breakpoint
COMMENT ON COLUMN "fdp_contractor_profiles"."company_id" IS
  'Empresa sugerida na apuração. Não define a quem o prestador pertence: o prestador é do grupo.';
--> statement-breakpoint
-- Departamento é da empresa. Sem empresa no contrato, não há departamento a
-- apontar — e a chave estrangeira composta deixaria de conferir sozinha,
-- porque uma coluna nula faz a referência inteira parar de valer. O CHECK
-- devolve em voz alta a regra que a chave não consegue mais garantir.
ALTER TABLE "fdp_contractor_profiles"
  ADD CONSTRAINT "fdp_contractor_profiles_department_needs_company_check"
  CHECK ("company_id" IS NOT NULL OR "department_id" IS NULL);
--> statement-breakpoint
-- O que nasce do contrato acompanha o contrato.
--
-- Item fixo e movimentação pertencem ao prestador, não a uma empresa: a
-- aplicação do item fixo na competência já é feita por prestador, sem olhar a
-- empresa. A coluna fica como registro de onde o lançamento nasceu.
ALTER TABLE "fdp_contractor_fixed_items"
  ALTER COLUMN "company_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "fdp_contractor_movements"
  ALTER COLUMN "company_id" DROP NOT NULL;
--> statement-breakpoint
-- Um prestador, um fechamento por competência, no grupo inteiro.
--
-- Sem isto, apurar a competência de agosto na Empresa A e depois na Empresa B
-- criaria dois fechamentos para o mesmo PJ no mesmo mês — o índice antigo é
-- por ciclo de folha, e cada empresa tem o seu. Seriam dois pagamentos, dois
-- valores de NF e dois complementos para a mesma pessoa, e o segundo pareceria
-- tão correto quanto o primeiro.
--
-- O índice é parcial porque o fechamento excluído continua no banco: ele é a
-- trilha de que aquele pagamento existiu e foi retirado, e não pode disputar a
-- unicidade com o fechamento que vale.
CREATE UNIQUE INDEX "fdp_contractor_closings_workspace_provider_competence_uq"
  ON "fdp_contractor_closings" USING btree ("workspace_id", "provider_id", "competence")
  WHERE "excluded_at" IS NULL;
