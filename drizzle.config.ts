import { defineConfig } from "drizzle-kit";

export default defineConfig({
  out: "./drizzle/postgres",
  schema: "./db/schema.ts",
  dialect: "postgresql",
});
