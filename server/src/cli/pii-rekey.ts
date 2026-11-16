// Key rotation for encrypted applicant fields: re-encrypts every value that is not under PII_ACTIVE_KID.
// Steps: add a new key to PII_KEYS (keep the old one), set PII_ACTIVE_KID to it, restart, run this with --apply,
// check that it reports 0 remaining, take a backup, and only then remove the old key from PII_KEYS.
// Usage: pnpm --filter @pips/server pii:rekey [--apply]
import { PrismaClient } from "@prisma/client";
import { decryptField, encryptField, keyringFromEnv, valueAad } from "../lib/crypto.js";

const apply = process.argv.includes("--apply");
const ring = keyringFromEnv();
const db = new PrismaClient();
const stale = await db.submissionValue.findMany({ where: { valueEnc: { not: null }, encKid: { not: ring.activeKid } }, select: { id: true, submissionId: true, fieldId: true, valueEnc: true, encKid: true } });
const byKid: Record<string, number> = {};
stale.forEach(v => { byKid[v.encKid!] = (byKid[v.encKid!] ?? 0) + 1; });
console.log(`Active key: ${ring.activeKid}. Values under older keys: ${stale.length}`, byKid);
if (apply && stale.length) {
  let done = 0;
  for (const v of stale) {
    const aad = valueAad(v.submissionId, v.fieldId);
    const e = encryptField(ring, decryptField(ring, v.valueEnc!, v.encKid!, aad), aad);
    await db.submissionValue.update({ where: { id: v.id }, data: { valueEnc: new Uint8Array(e.enc), encKid: e.kid } });
    done++;
  }
  await db.auditLog.create({ data: { action: "pii.rekey", entityType: "SubmissionValue", meta: { reencrypted: done, to: ring.activeKid, from: byKid } } });
  console.log(`Re-encrypted ${done} values. Remaining under older keys: ${await db.submissionValue.count({ where: { valueEnc: { not: null }, encKid: { not: ring.activeKid } } })}`);
}
await db.$disconnect();
