// Prisma CLI configuration.
// Loads environment variables from `.env.local` so the Prisma CLI (migrate,
// generate, studio) resolves DATABASE_URL / DIRECT_URL the same way the
// Next.js app does. The datasource URL itself is read from the schema via
// env("DATABASE_URL") / env("DIRECT_URL").
import { config } from "dotenv";
config({ path: ".env.local" });

import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
});
