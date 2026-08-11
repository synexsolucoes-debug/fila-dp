-- A primeira instalação nunca completava contra um banco vazio.
--
-- O `fdp_bootstrap_guard` existe para serializar a criação do primeiro grupo:
-- duas requisições simultâneas disputam a mesma linha e só uma vence. A ordem
-- da transação é reivindicar o guard e depois inserir o workspace — é o guard
-- que decide o vencedor, então ele precisa vir primeiro.
--
-- Só que a chave estrangeira era verificada na hora: o UPDATE apontava para um
-- workspace que ainda não existia e o PostgreSQL recusava com 23503. Resultado:
-- em banco novo o bootstrap falhava sempre, e como o usuário era gravado fora
-- da transação, sobrava uma conta órfã que bloqueava qualquer nova tentativa.
--
-- Tornar a verificação adiável mantém a garantia (no COMMIT o workspace precisa
-- existir) sem exigir que ele exista antes da disputa ser resolvida.
ALTER TABLE "fdp_bootstrap_guard" DROP CONSTRAINT IF EXISTS "fdp_bootstrap_guard_workspace_fk";
--> statement-breakpoint
ALTER TABLE "fdp_bootstrap_guard" ADD CONSTRAINT "fdp_bootstrap_guard_workspace_fk"
  FOREIGN KEY ("workspace_id") REFERENCES "public"."fdp_workspaces"("id")
  ON DELETE RESTRICT ON UPDATE NO ACTION
  DEFERRABLE INITIALLY DEFERRED;
