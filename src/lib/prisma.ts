import { PrismaClient } from "@prisma/client";

// Reads DATABASE_URL itself (validated in env.ts). Connects lazily; server.ts
// connects up front so a bad URL fails at startup, not on the first event.
export const prisma = new PrismaClient();
