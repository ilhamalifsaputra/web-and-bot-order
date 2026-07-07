/**
 * Shared helper for resolving the acting admin's `User.id` before writing an
 * audit-log row. Consolidates 4 previously-separate copies of the same
 * `admin ? admin.id : 0` fallback (Log-5-6, backend audit) — the `0` masked
 * the (currently unreachable) case where `getUserByTelegramId` can't find the
 * acting admin's own `User` row. The global `registeredUser` middleware
 * guarantees every admin update already has a `User` row, so this throws
 * instead of silently attributing the action to a nonexistent admin id 0.
 */
export function requireAdminId(admin: { id: number } | null): number {
  if (!admin) {
    throw new Error(
      "Acting admin's User row was not found for an admin action — registeredUser middleware should guarantee this never happens",
    );
  }
  return admin.id;
}
