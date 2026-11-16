// Prints fresh secrets for .env. Never commit the output.
import { randomBytes } from "node:crypto";

const b64 = (n: number) => randomBytes(n).toString("base64");
const kid = `k${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`;
console.log(`SESSION_SECRET=${randomBytes(48).toString("base64url")}`);
console.log(`PII_KEYS={"${kid}":"${b64(32)}"}`);
console.log(`PII_ACTIVE_KID=${kid}`);
console.log(`POSTGRES_PASSWORD=${randomBytes(18).toString("base64url")}`);
console.log(`LEGACY_SA_PASSWORD=Pp9!${randomBytes(18).toString("base64url")}`);
console.log(`LEGACY_READER_PASSWORD=Rr9!${randomBytes(18).toString("base64url")}`);
