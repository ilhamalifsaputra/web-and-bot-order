/**
 * Break-glass admin password / 2FA reset — the recovery path that depends on
 * NOTHING (no running bot, no notifier, no working login). Run it on the box
 * that holds the SQLite DB (e.g. over SSH on Hostinger):
 *
 *   pnpm reset-admin-password <telegram_id>              # clear pw + 2FA
 *   pnpm reset-admin-password <telegram_id> --set <pw>   # set a new password
 *   pnpm reset-admin-password <telegram_id> --keep-2fa   # leave 2FA in place
 *
 * Default (no --set): clears `web_admin_password_hash:<tg>` AND the 2FA secret,
 * then rotates the session jti so any live cookie dies. With the hash cleared,
 * a sole admin can re-run /bootstrap; in a team a super-admin can re-invite.
 * With --set, a fresh bcrypt hash is written so the admin can log in straight
 * away (then change it in /settings).
 *
 * NEVER prints the password hash. The action is audited with adminId=null so
 * it's distinguishable from an in-app change in /audit.
 */
import { config } from "@app/core/config";
import { isAdmin } from "@app/core/runtime";
import {
  prisma,
  initDb,
  setSetting,
  deleteSetting,
  getUserByTelegramId,
  logAdminAction,
} from "@app/db";
import {
  hashPassword,
  passwordHashKey,
  twoFaSecretKey,
  twoFaPendingKey,
  sessionJtiKey,
  newJti,
} from "@app/web-admin/auth";

const USAGE = `Reset a web-admin's password / 2FA (break-glass, DB-direct).

Usage:
  pnpm reset-admin-password <telegram_id> [--set <password>] [--keep-2fa]

Options:
  --set <password>   Set this as the new password (min 8 chars) instead of
                     clearing it. The admin can log in immediately afterwards.
  --keep-2fa         Keep the existing 2FA secret (default: clear it too, so a
                     lost-authenticator lockout is also recovered).
  --help, -h         Show this help.

Examples:
  pnpm reset-admin-password 123456789
  pnpm reset-admin-password 123456789 --set "s0me-strong-pass"
`;

function parseArgs(argv: string[]): {
  telegramId: number;
  newPassword: string | null;
  keep2fa: boolean;
} | null {
  if (argv.includes("--help") || argv.includes("-h") || argv.length === 0) return null;

  const positional: string[] = [];
  let newPassword: string | null = null;
  let keep2fa = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--set") {
      newPassword = argv[++i] ?? "";
    } else if (a === "--keep-2fa") {
      keep2fa = true;
    } else if (a.startsWith("--")) {
      console.error(`Unknown option: ${a}\n`);
      return null;
    } else {
      positional.push(a);
    }
  }

  const telegramId = Number(positional[0]);
  if (!Number.isInteger(telegramId)) {
    console.error("First argument must be a numeric Telegram ID.\n");
    return null;
  }
  return { telegramId, newPassword, keep2fa };
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  const args = parseArgs(rawArgs);
  if (!args) {
    console.log(USAGE);
    // --help is a success; a bad/missing invocation is an error.
    process.exit(rawArgs.some((a) => a === "--help" || a === "-h") ? 0 : 1);
  }
  const { telegramId, newPassword, keep2fa } = args;

  // Only Telegram IDs in the bot's allow-list can be web admins — guard against
  // typos that would write orphaned settings rows.
  if (!isAdmin(telegramId)) {
    console.error(
      `Telegram ID ${telegramId} is not in ADMIN_IDS (${config.ADMIN_IDS.join(", ") || "empty"}).`,
    );
    process.exit(1);
  }
  if (newPassword !== null && newPassword.length < 8) {
    console.error("--set password must be at least 8 characters.");
    process.exit(1);
  }

  await initDb(); // WAL + busy_timeout PRAGMAs, same as the app

  const user = await getUserByTelegramId(prisma, telegramId);
  const label = user?.fullName ?? user?.username ?? "(unknown user)";

  // 1) Password: set a fresh hash, or clear it to re-open the bootstrap path.
  if (newPassword !== null) {
    await setSetting(prisma, passwordHashKey(telegramId), hashPassword(newPassword));
  } else {
    await deleteSetting(prisma, passwordHashKey(telegramId));
  }

  // 2) 2FA: clear unless explicitly kept (recovers a lost-authenticator lockout).
  if (!keep2fa) {
    await deleteSetting(prisma, twoFaSecretKey(telegramId));
    await deleteSetting(prisma, twoFaPendingKey(telegramId));
  }

  // 3) Kill any session cookie still in the wild.
  await setSetting(prisma, sessionJtiKey(telegramId), newJti());

  // 4) Audit — adminId=null marks it as a CLI/break-glass action. Never log the
  //    password or its hash.
  await logAdminAction(prisma, {
    adminId: null,
    action: "web_admin_password_reset_cli",
    targetType: "web_admin",
    targetId: null,
    details: `Reset web-admin login for Telegram ID ${telegramId} via CLI: password ${newPassword !== null ? "set to a new value" : "cleared"}, 2FA ${keep2fa ? "kept" : "cleared"}.`,
  });

  console.log(`\n✓ Reset done for ${telegramId} (${label}).`);
  if (newPassword !== null) {
    console.log("  • Password: SET — log in with the new password, then change it in /settings.");
  } else {
    console.log("  • Password: CLEARED — open /bootstrap to set one (sole admin), or have a");
    console.log("    super-admin re-invite you from /admins.");
  }
  console.log(`  • 2FA: ${keep2fa ? "kept as-is." : "cleared — re-enroll in /settings if you want it."}`);
  console.log("  • All existing web sessions for this admin have been invalidated.\n");

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("Reset failed:", e instanceof Error ? e.message : e);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
