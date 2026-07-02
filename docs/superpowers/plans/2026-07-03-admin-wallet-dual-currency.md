# Admin Wallet IDR/USDT Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the admin panel's customer detail page show and manage the user's IDR and USDT wallet balances as two separate values, matching what the backend already fully supports.

**Architecture:** The backend (`User.walletBalance` / `User.walletBalanceUsdt`, `WalletTransaction.currency`, `adjustWallet({ currency })`) already models two independent balances — no schema or core CRUD changes are needed. This plan (1) adds currency validation/pass-through to the one admin API route that doesn't yet expose it, and (2) fixes the admin React page, which still has a stale single-currency model (a `walletCurrency` field that doesn't exist on the backend response, no USDT display, no currency selector on the adjust form, and a ledger table type that doesn't match the real API shape).

**Tech Stack:** Fastify (`apps/web-admin/src/routes/api/users.ts`), React + TanStack Query (`apps/web-admin/client/src/pages/UserDetailPage.tsx`), Vitest + Testing Library for both the API and the React component, `decimal.js`-backed `Decimal` for all money.

## Global Constraints

- **Decimal for all money** — the backend already uses `@app/core/money`'s `Decimal`; no floats anywhere in this change.
- **Audit every state change with the acting admin id** — `logAdminAction` is already called on wallet adjust; keep it, and fold the currency into its natural-language `details` sentence per `docs/LOGGING.md` (no `key=value` shorthand).
- **CSRF** — the route already uses the `csrfProtect` preHandler; don't remove it.
- **`apps/web-admin`'s dashboard is a built React SPA** — after any change under `apps/web-admin/client/`, run `pnpm --filter @app/web-admin-client build` before `pnpm test`/`pnpm typecheck` will see a consistent picture, and before manually verifying in a browser.
- **`pnpm typecheck` and `pnpm test` must stay green** after every task.
- Scope is the admin panel only — the bot and storefront already handle both currencies correctly and are not touched by this plan.

---

### Task 1: Backend — accept and validate `currency` on wallet adjustment

**Files:**
- Modify: `apps/web-admin/src/routes/api/users.ts:85-117` (the `POST /api/users/:userId/wallet` handler)
- Test: `apps/web-admin/test/web.test.ts` (new `describe` block inserted after the existing `describe("users", ...)` block, which currently ends at line 2182, and before `describe("vouchers", ...)` at line 2186)

**Interfaces:**
- Consumes: `adjustWallet(db, userId, delta, opts)` from `@app/db` (`packages/db/src/crud/users.ts`), which already accepts `opts.currency?: "IDR" | "USDT"` (defaults to `"IDR"`) and independently debits/credits `walletBalance` or `walletBalanceUsdt`. No changes to this function.
- Produces: `POST /api/users/:userId/wallet` now reads an optional `currency` field from the JSON/form body (`"IDR"` or `"USDT"`, case-insensitive, defaults to `"IDR"`), rejects any other value with `400`, and passes it through to `adjustWallet`. Response shape (`{ ok: true, newBalance }`) is unchanged. This is what Task 3's frontend change will call.

- [ ] **Step 1: Write the failing tests**

Open `apps/web-admin/test/web.test.ts`. Find this exact text (the end of the `describe("users", ...)` block, right before the vouchers block):

```ts
  it("wallet rejects bad CSRF", async () => {
    const res = await post(`/users/${seed.customerId}/wallet`, seed.cookie, { csrf_token: "bad", delta: "1000" });
    expect(res.statusCode).toBe(403);
  });
});

// ---- vouchers (acceptance #5) ---------------------------------------------
```

Replace it with (adds a new describe block between the two, leaving both existing blocks untouched):

```ts
  it("wallet rejects bad CSRF", async () => {
    const res = await post(`/users/${seed.customerId}/wallet`, seed.cookie, { csrf_token: "bad", delta: "1000" });
    expect(res.statusCode).toBe(403);
  });
});

// ---- users API — wallet currency (dual IDR/USDT wallet, admin panel) ------

describe("users API — wallet currency", () => {
  function postJson(url: string, cookie: string | null, csrf: string | null, body: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url,
      headers: { "content-type": "application/json", ...(csrf ? { "x-csrf-token": csrf } : {}) },
      cookies: cookie ? { [COOKIE]: cookie } : {},
      payload: JSON.stringify(body),
    });
  }

  it("defaults to IDR when currency is omitted", async () => {
    const before = await getUser(prisma, seed.customerId);
    const res = await postJson(`/api/users/${seed.customerId}/wallet`, seed.cookie, seed.csrf, { delta: "5.00", note: "goodwill" });
    expect(res.statusCode).toBe(200);
    const after = await getUser(prisma, seed.customerId);
    expect(Number(after!.walletBalance) - Number(before!.walletBalance)).toBeCloseTo(5);
    expect(Number(after!.walletBalanceUsdt)).toBe(Number(before!.walletBalanceUsdt));
  });

  it("adjusts the USDT balance when currency is USDT, leaving IDR untouched", async () => {
    const before = await getUser(prisma, seed.customerId);
    const res = await postJson(`/api/users/${seed.customerId}/wallet`, seed.cookie, seed.csrf, { delta: "2.50", note: "usdt credit", currency: "USDT" });
    expect(res.statusCode).toBe(200);
    const after = await getUser(prisma, seed.customerId);
    expect(Number(after!.walletBalanceUsdt) - Number(before!.walletBalanceUsdt)).toBeCloseTo(2.5);
    expect(Number(after!.walletBalance)).toBe(Number(before!.walletBalance));

    const ledgerRow = await prisma.walletTransaction.findFirst({
      where: { userId: seed.customerId, currency: "USDT" },
      orderBy: { id: "desc" },
    });
    expect(ledgerRow).not.toBeNull();
    expect(ledgerRow!.note).toBe("usdt credit");
  });

  it("rejects an invalid currency value with 400 and makes no balance change", async () => {
    const before = await getUser(prisma, seed.customerId);
    const res = await postJson(`/api/users/${seed.customerId}/wallet`, seed.cookie, seed.csrf, { delta: "1.00", note: "x", currency: "EUR" });
    expect(res.statusCode).toBe(400);
    const after = await getUser(prisma, seed.customerId);
    expect(Number(after!.walletBalance)).toBe(Number(before!.walletBalance));
    expect(Number(after!.walletBalanceUsdt)).toBe(Number(before!.walletBalanceUsdt));
  });
});

// ---- vouchers (acceptance #5) ---------------------------------------------
```

- [ ] **Step 2: Run the tests to verify the new ones fail**

Run: `pnpm --filter @app/web-admin test -- -t "wallet currency"`

Expected: the "defaults to IDR" test passes (that's already today's behavior), but "adjusts the USDT balance when currency is USDT" FAILS (today, sending `currency: "USDT"` is silently ignored and IDR gets debited instead), and "rejects an invalid currency value" FAILS (today, an invalid currency is silently accepted and treated as IDR, returning 200 not 400).

- [ ] **Step 3: Implement the currency validation and pass-through**

In `apps/web-admin/src/routes/api/users.ts`, replace the `POST /api/users/:userId/wallet` handler:

```ts
  app.post("/api/users/:userId/wallet", { preHandler: csrfProtect }, async (req, reply) => {
    const userId = Number((req.params as { userId: string }).userId);
    const body = (req.body ?? {}) as Record<string, string>;
    const note = (body.note ?? "").trim();
    if (!note) return reply.code(400).send({ error: "A reason is required for every wallet move." });
    let deltaDec: Decimal;
    try {
      deltaDec = new Decimal((body.delta ?? "").trim());
    } catch {
      return reply.code(400).send({ error: "Amount must be a number." });
    }
    if (deltaDec.isZero()) return reply.code(400).send({ error: "Amount cannot be zero." });
    const currencyRaw = (body.currency ?? "IDR").toUpperCase();
    if (currencyRaw !== "IDR" && currencyRaw !== "USDT") {
      return reply.code(400).send({ error: "Currency must be IDR or USDT." });
    }
    const currency = currencyRaw as "IDR" | "USDT";
    if (!(await getUser(prisma, userId))) return reply.code(404).send({ error: "User not found." });
    let newBalance: Decimal;
    try {
      newBalance = await adjustWallet(prisma, userId, deltaDec, {
        reason: "admin_adjust",
        note: note || null,
        adminId: req.admin!.userId,
        currency,
      });
    } catch (e) {
      if (e instanceof ValidationError) return reply.code(422).send({ error: e.message });
      throw e;
    }
    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "wallet_adjust",
      targetType: "user",
      targetId: userId,
      details: `Adjusted ${currency} wallet by ${deltaDec.toString()}. Note: "${note.slice(0, 160)}".`,
    });
    return reply.send({ ok: true, newBalance: newBalance.toString() });
  });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @app/web-admin test -- -t "wallet"`

Expected: all tests matching "wallet" pass, including the 3 new ones and the pre-existing legacy-route wallet tests (which are unaffected, since they hit `/users/:userId/wallet`, not `/api/users/:userId/wallet`).

- [ ] **Step 5: Commit**

```bash
git add apps/web-admin/src/routes/api/users.ts apps/web-admin/test/web.test.ts
git commit -m "feat(web-admin): validate and apply currency on wallet adjust API"
```

---

### Task 2: Frontend — fix wallet types and show both balances on the Profile card

**Files:**
- Modify: `apps/web-admin/client/src/pages/UserDetailPage.tsx:24-31` (the `UserDetail` interface), `:114` (the Profile card's Wallet line), `:183` and `:189` (the ledger table's `balance` column and `keyExtractor`, which must be fixed here to keep the file compiling once the `ledger` type below drops `id`/`balance`)
- Test: `apps/web-admin/client/src/pages/UserDetailPage.test.tsx:27-34` (the `USER_DETAIL` fixture), plus a new test appended after line 100

**Interfaces:**
- Consumes: `CurrencyStack` from `apps/web-admin/client/src/components/shared/CurrencyAmount.tsx` (already imported on this page, already used for "Total spent"): `CurrencyStack({ amounts: { currency: "IDR" | "USDT" | "USD"; value: string }[] })`.
- Produces: `UserDetail.user` now has `walletBalanceUsdt: string` (no more `walletCurrency`); `UserDetail.ledger[number]` now has `balanceAfter: string` and `currency: string` (no more `id`/`balance`) — matching `WalletLedgerEntry` in `packages/db/src/crud/users.ts` exactly. Task 3 and Task 4 build on these same types.

- [ ] **Step 1: Update the test fixture**

In `apps/web-admin/client/src/pages/UserDetailPage.test.tsx`, find:

```ts
const USER_DETAIL = {
  user: { id: 7, username: "andi", fullName: "Andi Santoso", telegramId: "111", role: "CUSTOMER", banned: false, banReason: null, walletBalance: "0", walletCurrency: "IDR" },
  totalSpent: { idr: "150000", usdt: "0" },
  orders: [],
  tickets: [],
  ledger: [],
  roles: ["CUSTOMER", "RESELLER"],
};
```

Replace with:

```ts
const USER_DETAIL = {
  user: { id: 7, username: "andi", fullName: "Andi Santoso", telegramId: "111", role: "CUSTOMER", banned: false, banReason: null, walletBalance: "500000", walletBalanceUsdt: "12.5" },
  totalSpent: { idr: "150000", usdt: "0" },
  orders: [],
  tickets: [],
  ledger: [],
  roles: ["CUSTOMER", "RESELLER"],
};
```

- [ ] **Step 2: Write the failing test**

At the end of `UserDetailPage.test.tsx` (after the closing `});` of the `describe("UserDetailPage — role change", ...)` block), append:

```ts

describe("UserDetailPage — wallet display", () => {
  it("renders both IDR and USDT wallet balances on the Profile card", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(USER_DETAIL), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    render(<UserDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Andi Santoso")).toBeInTheDocument());
    expect(screen.getByText("Rp500.000")).toBeInTheDocument();
    expect(screen.getByText("12.50 USDT")).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @app/web-admin-client test -- UserDetailPage`

Expected: FAIL — the current code renders the literal text `500000 undefined` (there is no `Rp500.000` or `12.50 USDT` text in the DOM), and separately, `apps/web-admin/client` will fail to typecheck once the fixture's shape changes are matched by the interface change in the next step (the fixture itself isn't statically typed, so this failure shows up as the assertion failing, not a compile error, until Step 4 changes the interface — do this step first as specified so the reviewer sees the red test before the fix).

- [ ] **Step 4: Fix the interface and the Profile card display**

In `apps/web-admin/client/src/pages/UserDetailPage.tsx`, find:

```ts
interface UserDetail {
  user: { id: number; username: string | null; fullName: string | null; telegramId: string; role: string; banned: boolean; banReason: string | null; walletBalance: string; walletCurrency: string };
  totalSpent: { idr: string; usdt: string };
  orders: { id: number; orderCode: string; status: string; totalIdr: string; createdAt: string }[];
  tickets: { id: number; subject: string; status: string; createdAt: string }[];
  ledger: { id: number; delta: string; balance: string; reason: string; note: string | null; createdAt: string }[];
  roles: string[];
}
```

Replace with:

```ts
interface UserDetail {
  user: { id: number; username: string | null; fullName: string | null; telegramId: string; role: string; banned: boolean; banReason: string | null; walletBalance: string; walletBalanceUsdt: string };
  totalSpent: { idr: string; usdt: string };
  orders: { id: number; orderCode: string; status: string; totalIdr: string; createdAt: string }[];
  tickets: { id: number; subject: string; status: string; createdAt: string }[];
  ledger: { delta: string; balanceAfter: string; currency: string; reason: string; note: string | null; createdAt: string }[];
  roles: string[];
}
```

Then find:

```tsx
            <div className="flex justify-between"><span className="text-ink-soft">Wallet</span><span className="font-mono">{user.walletBalance} {user.walletCurrency}</span></div>
```

Replace with:

```tsx
            <div className="flex justify-between"><span className="text-ink-soft">Wallet</span><CurrencyStack amounts={[{ currency: "IDR", value: user.walletBalance }, { currency: "USDT", value: user.walletBalanceUsdt }]} /></div>
```

- [ ] **Step 5: Fix the ledger table's now-stale field references so the file keeps compiling**

Still in `UserDetailPage.tsx`, find the Wallet Ledger `DataTable`:

```tsx
      {/* Wallet ledger */}
      <h2 className="text-sm font-semibold text-ink mb-3 mt-6">Wallet Ledger ({data.ledger.length})</h2>
      <DataTable
        columns={[
          { key: "delta", header: "Delta", render: l => <span className={`font-mono text-sm ${l.delta.startsWith("-") ? "text-rust" : "text-grass"}`}>{l.delta}</span> },
          { key: "balance", header: "Balance", render: l => <span className="font-mono text-sm">{l.balance}</span> },
          { key: "reason", header: "Reason", render: l => <span className="text-sm">{l.reason}</span> },
          { key: "note", header: "Note", render: l => <span className="text-xs text-ink-soft">{l.note ?? "—"}</span> },
          { key: "date", header: "Date", render: l => <span className="text-xs text-ink-soft">{new Date(l.createdAt).toLocaleDateString()}</span> },
        ]}
        data={data.ledger}
        keyExtractor={l => l.id}
        empty={<EmptyState title="No ledger entries" />}
      />
```

Replace with (fixes `l.balance` → `l.balanceAfter` and replaces the now-nonexistent `l.id` key with a positional key, since `WalletLedgerEntry` has no `id`; the Currency column is added in Task 4, not here):

```tsx
      {/* Wallet ledger */}
      <h2 className="text-sm font-semibold text-ink mb-3 mt-6">Wallet Ledger ({data.ledger.length})</h2>
      <DataTable
        columns={[
          { key: "delta", header: "Delta", render: l => <span className={`font-mono text-sm ${l.delta.startsWith("-") ? "text-rust" : "text-grass"}`}>{l.delta}</span> },
          { key: "balance", header: "Balance", render: l => <span className="font-mono text-sm">{l.balanceAfter}</span> },
          { key: "reason", header: "Reason", render: l => <span className="text-sm">{l.reason}</span> },
          { key: "note", header: "Note", render: l => <span className="text-xs text-ink-soft">{l.note ?? "—"}</span> },
          { key: "date", header: "Date", render: l => <span className="text-xs text-ink-soft">{new Date(l.createdAt).toLocaleDateString()}</span> },
        ]}
        data={data.ledger.map((l, i) => ({ ...l, _key: i }))}
        keyExtractor={l => l._key}
        empty={<EmptyState title="No ledger entries" />}
      />
```

- [ ] **Step 6: Run the test and typecheck to verify they pass**

Run: `pnpm --filter @app/web-admin-client test -- UserDetailPage`
Expected: PASS, including the new wallet-display test and all pre-existing role-change tests.

Run: `pnpm --filter @app/web-admin-client typecheck`
Expected: PASS with no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/web-admin/client/src/pages/UserDetailPage.tsx apps/web-admin/client/src/pages/UserDetailPage.test.tsx
git commit -m "fix(web-admin): show IDR and USDT wallet balances on customer detail page"
```

---

### Task 3: Frontend — currency toggle on the Wallet Adjustment form

**Files:**
- Modify: `apps/web-admin/client/src/pages/UserDetailPage.tsx` (the `walletForm` state and the `wallet` mutation near lines 49/53-61, and the Wallet Adjustment `Card` near lines 121-131)
- Test: `apps/web-admin/client/src/pages/UserDetailPage.test.tsx` (new tests, appended)

**Interfaces:**
- Consumes: `apiPost` from `../api/client` (already imported), `Button` from `@/components/ui/button` (already imported, supports `size="sm"` and `variant="default" | "outline"`, both already used elsewhere on this page).
- Produces: `POST /api/users/:userId/wallet` is now called with `{ delta, note, currency: "IDR" | "USDT" }` — the `currency` field Task 1's backend route now reads.

- [ ] **Step 1: Write the failing tests**

Append to `UserDetailPage.test.tsx` (after the `describe("UserDetailPage — wallet display", ...)` block added in Task 2):

```ts

describe("UserDetailPage — wallet adjustment currency", () => {
  it("defaults to IDR when no currency toggle is clicked", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(USER_DETAIL), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    vi.mocked(apiPost).mockResolvedValueOnce({ ok: true });
    render(<UserDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Andi Santoso")).toBeInTheDocument());

    await user.type(screen.getByPlaceholderText("Amount (+ or −)"), "5");
    await user.type(screen.getByPlaceholderText("Reason (required)"), "goodwill");
    await user.click(screen.getByRole("button", { name: "Adjust" }));

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith("/api/users/7/wallet", { delta: "5", note: "goodwill", currency: "IDR" }),
    );
  });

  it("adjusts the USDT balance when the USDT toggle is selected", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(USER_DETAIL), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    vi.mocked(apiPost).mockResolvedValueOnce({ ok: true });
    render(<UserDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Andi Santoso")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "USDT" }));
    await user.type(screen.getByPlaceholderText("Amount (+ or −)"), "5");
    await user.type(screen.getByPlaceholderText("Reason (required)"), "top up");
    await user.click(screen.getByRole("button", { name: "Adjust" }));

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith("/api/users/7/wallet", { delta: "5", note: "top up", currency: "USDT" }),
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @app/web-admin-client test -- UserDetailPage`

Expected: the "defaults to IDR" test currently passes by coincidence (today's code always sends `{ delta, note }` with no `currency` key, which does NOT deep-equal `{ delta, note, currency: "IDR" }`) — so it FAILS too. The "USDT toggle" test also FAILS (there is no button named "USDT" yet, so `getByRole("button", { name: "USDT" })` throws).

- [ ] **Step 3: Implement the currency toggle**

In `UserDetailPage.tsx`, find:

```ts
  const [walletForm, setWalletForm] = useState({ delta: "", note: "" });
  const [walletError, setWalletError] = useState<string | null>(null);
```

Replace with:

```ts
  const [walletForm, setWalletForm] = useState({ delta: "", note: "" });
  const [walletCurrency, setWalletCurrency] = useState<"IDR" | "USDT">("IDR");
  const [walletError, setWalletError] = useState<string | null>(null);
```

Find:

```ts
  const wallet = useMutation({
    mutationFn: () => apiPost(`/api/users/${userId}/wallet`, walletForm),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["user", userId] });
      setWalletForm({ delta: "", note: "" });
      setWalletError(null);
    },
    onError: (e: Error) => setWalletError(e.message),
  });
```

Replace with:

```ts
  const wallet = useMutation({
    mutationFn: () => apiPost(`/api/users/${userId}/wallet`, { ...walletForm, currency: walletCurrency }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["user", userId] });
      setWalletForm({ delta: "", note: "" });
      setWalletCurrency("IDR");
      setWalletError(null);
    },
    onError: (e: Error) => setWalletError(e.message),
  });
```

Find:

```tsx
          <Card>
            <CardHeader><CardTitle>Wallet Adjustment</CardTitle></CardHeader>
            <CardContent className="flex flex-col gap-3">
              {walletError && <p className="text-xs text-rust">{walletError}</p>}
              <div className="flex gap-2">
                <Input placeholder="Amount (+ or −)" value={walletForm.delta} onChange={e => setWalletForm(f => ({ ...f, delta: e.target.value }))} className="w-32" />
                <Input placeholder="Reason (required)" value={walletForm.note} onChange={e => setWalletForm(f => ({ ...f, note: e.target.value }))} className="flex-1" />
                <Button onClick={() => wallet.mutate()} disabled={wallet.isPending}>Adjust</Button>
              </div>
            </CardContent>
          </Card>
```

Replace with:

```tsx
          <Card>
            <CardHeader><CardTitle>Wallet Adjustment</CardTitle></CardHeader>
            <CardContent className="flex flex-col gap-3">
              {walletError && <p className="text-xs text-rust">{walletError}</p>}
              <div className="flex gap-2">
                <Button type="button" size="sm" variant={walletCurrency === "IDR" ? "default" : "outline"} onClick={() => setWalletCurrency("IDR")}>IDR</Button>
                <Button type="button" size="sm" variant={walletCurrency === "USDT" ? "default" : "outline"} onClick={() => setWalletCurrency("USDT")}>USDT</Button>
              </div>
              <div className="flex gap-2">
                <Input placeholder="Amount (+ or −)" value={walletForm.delta} onChange={e => setWalletForm(f => ({ ...f, delta: e.target.value }))} className="w-32" />
                <Input placeholder="Reason (required)" value={walletForm.note} onChange={e => setWalletForm(f => ({ ...f, note: e.target.value }))} className="flex-1" />
                <Button onClick={() => wallet.mutate()} disabled={wallet.isPending}>Adjust</Button>
              </div>
            </CardContent>
          </Card>
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @app/web-admin-client test -- UserDetailPage`
Expected: PASS, including both new tests and all previously-passing tests on this page.

- [ ] **Step 5: Commit**

```bash
git add apps/web-admin/client/src/pages/UserDetailPage.tsx apps/web-admin/client/src/pages/UserDetailPage.test.tsx
git commit -m "feat(web-admin): add IDR/USDT toggle to the wallet adjustment form"
```

---

### Task 4: Frontend — Currency column on the Wallet Ledger table

**Files:**
- Modify: `apps/web-admin/client/src/pages/UserDetailPage.tsx` (the Wallet Ledger `DataTable` columns, fixed in Task 2 to use `l.balanceAfter`/positional keys)
- Test: `apps/web-admin/client/src/pages/UserDetailPage.test.tsx` (new test, appended)

**Interfaces:**
- Consumes: `Badge` from `@/components/ui/badge` (already imported on this page, `variant="outline"` already used for the Role badge).
- Produces: no new exports — this is a display-only addition to the existing ledger table.

- [ ] **Step 1: Write the failing test**

Append to `UserDetailPage.test.tsx` (after the `describe("UserDetailPage — wallet adjustment currency", ...)` block added in Task 3):

```ts

describe("UserDetailPage — wallet ledger currency column", () => {
  it("shows each ledger row's currency and its post-adjustment balance", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ...USER_DETAIL,
          ledger: [
            { delta: "5.0000", balanceAfter: "505000.0000", currency: "IDR", reason: "admin_adjust", note: "goodwill", createdAt: "2026-07-01T00:00:00.000Z" },
            { delta: "2.5000", balanceAfter: "15.0000", currency: "USDT", reason: "admin_adjust", note: "usdt credit", createdAt: "2026-07-02T00:00:00.000Z" },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    render(<UserDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Andi Santoso")).toBeInTheDocument());

    expect(screen.getByText("505000.0000")).toBeInTheDocument();
    expect(screen.getByText("15.0000")).toBeInTheDocument();
    expect(screen.getByText("usdt credit")).toBeInTheDocument();
  });
});
```

Note: this test does not assert on the literal "IDR"/"USDT" currency badge text directly, because those strings already appear elsewhere on the page (the wallet and total-spent `CurrencyStack`s); asserting the ledger's distinctive `balanceAfter` values (`505000.0000`, `15.0000`) is what actually proves the Currency column and the `balanceAfter` field are wired correctly for two different rows.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @app/web-admin-client test -- UserDetailPage`

Expected: FAIL — `screen.getByText("505000.0000")` is not found (today's Balance column reads the now-removed `l.balance` field, which is `undefined` on these fixture rows since they only have `balanceAfter`).

- [ ] **Step 3: Add the Currency column**

In `UserDetailPage.tsx`, find the Wallet Ledger `DataTable` columns array (as left by Task 2):

```tsx
        columns={[
          { key: "delta", header: "Delta", render: l => <span className={`font-mono text-sm ${l.delta.startsWith("-") ? "text-rust" : "text-grass"}`}>{l.delta}</span> },
          { key: "balance", header: "Balance", render: l => <span className="font-mono text-sm">{l.balanceAfter}</span> },
          { key: "reason", header: "Reason", render: l => <span className="text-sm">{l.reason}</span> },
          { key: "note", header: "Note", render: l => <span className="text-xs text-ink-soft">{l.note ?? "—"}</span> },
          { key: "date", header: "Date", render: l => <span className="text-xs text-ink-soft">{new Date(l.createdAt).toLocaleDateString()}</span> },
        ]}
```

Replace with (inserts a Currency column between Delta and Balance):

```tsx
        columns={[
          { key: "delta", header: "Delta", render: l => <span className={`font-mono text-sm ${l.delta.startsWith("-") ? "text-rust" : "text-grass"}`}>{l.delta}</span> },
          { key: "currency", header: "Currency", render: l => <Badge variant="outline">{l.currency}</Badge> },
          { key: "balance", header: "Balance", render: l => <span className="font-mono text-sm">{l.balanceAfter}</span> },
          { key: "reason", header: "Reason", render: l => <span className="text-sm">{l.reason}</span> },
          { key: "note", header: "Note", render: l => <span className="text-xs text-ink-soft">{l.note ?? "—"}</span> },
          { key: "date", header: "Date", render: l => <span className="text-xs text-ink-soft">{new Date(l.createdAt).toLocaleDateString()}</span> },
        ]}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @app/web-admin-client test -- UserDetailPage`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web-admin/client/src/pages/UserDetailPage.tsx apps/web-admin/client/src/pages/UserDetailPage.test.tsx
git commit -m "feat(web-admin): show currency per row in the wallet ledger table"
```

---

### Task 5: Full verification

**Files:** none (verification only)

**Interfaces:** none

- [ ] **Step 1: Rebuild the admin client bundle**

Run: `pnpm --filter @app/web-admin-client build`
Expected: builds successfully (this regenerates `apps/web-admin/static/dashboard-app/`, which `pnpm test`/`pnpm dev:web` serve from).

- [ ] **Step 2: Full typecheck**

Run: `pnpm typecheck`
Expected: all workspaces pass, including `apps/web-admin/client` and `apps/web-admin`.

- [ ] **Step 3: Full test suite**

Run: `pnpm test`
Expected: all test files pass, including the new/updated ones in `apps/web-admin/test/web.test.ts` and `apps/web-admin/client/src/pages/UserDetailPage.test.tsx`.

- [ ] **Step 4: Manual smoke check against the real dev DB**

Start the admin dev server (`pnpm dev:web`), log in, open a customer detail page, and confirm:
- The Profile card's Wallet row shows both an IDR line and a USDT line.
- Clicking the USDT toggle and submitting a wallet adjustment changes only `walletBalanceUsdt` (visible immediately in the Profile card after the query refetches) and adds a row to the ledger table tagged `USDT` in the new Currency column, with the IDR balance and its ledger rows unchanged.
- Submitting without touching the toggle still adjusts IDR only (unchanged prior behavior).
