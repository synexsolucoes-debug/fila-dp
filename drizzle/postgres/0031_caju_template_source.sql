-- O modelo de pedidos da Caju passa a morar no banco, não no armazenamento de objetos.
--
-- O arquivo é uma planilha de texto de poucas centenas de bytes, e tudo que a
-- geração precisa (cabeçalhos, índices, delimitador) já é gravado aqui. Manter
-- o original no Blob criava uma dependência externa num caminho que mexe com
-- dinheiro: sem `BLOB_READ_WRITE_TOKEN` configurado, cadastrar o modelo falhava
-- — e falhava com erro genérico, sem dizer o que faltava.
--
-- Guardar o texto original preserva o que importava do armazenamento: conferir
-- depois, byte a byte, com qual planilha um pedido antigo foi gerado.
ALTER TABLE "fdp_caju_templates" ADD COLUMN IF NOT EXISTS "source_text" text DEFAULT '' NOT NULL;
--> statement-breakpoint
-- `storage_key` continua para os modelos já cadastrados no Blob; novos registros
-- não a preenchem.
ALTER TABLE "fdp_caju_templates" ALTER COLUMN "storage_key" SET DEFAULT '';
--> statement-breakpoint
ALTER TABLE "fdp_caju_templates" ADD CONSTRAINT "fdp_caju_templates_source_check"
  CHECK ("source_text" <> '' OR "storage_key" <> '');
