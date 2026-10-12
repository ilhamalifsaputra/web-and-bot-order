/** Read-only reconciliation report. No resend, status mutation, or production delivery probe. */
import { prisma, emailDeliveryDiagnostics } from "@app/db";
async function main(): Promise<void> {
  try {
    const report = await emailDeliveryDiagnostics(prisma);
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } catch {
    process.stderr.write("Email diagnostics could not read the database. Check configuration and connectivity.\n");
    process.exitCode = 1;
  } finally { await prisma.$disconnect(); }
}

void main();
