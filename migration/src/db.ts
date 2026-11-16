// Target database (PIPS PostgreSQL). The migration never imports the mailer: no email can be sent from here.
import { PrismaClient } from "@prisma/client";

// Errors are not logged by Prisma itself: the steps handle expected ones (e.g. two workers storing the same file at
// once) and every unexpected one fails the step with its full message.
export const db = new PrismaClient({ log: ["warn"] });
