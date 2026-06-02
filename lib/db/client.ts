import { PrismaClient } from "@prisma/client";

// Prisma client singleton.
// In development, Next.js hot-reload can repeatedly re-instantiate modules,
// which would otherwise create a new PrismaClient (and a new connection pool)
// on every reload and exhaust database connections. We cache the instance on
// the global object to reuse it across reloads.
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["query", "error", "warn"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
