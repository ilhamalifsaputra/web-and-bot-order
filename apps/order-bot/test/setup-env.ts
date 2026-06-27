/**
 * Test env bootstrap — MUST be the first import in every order-bot test file.
 * Sets the env that `@app/core/config` + the `@app/db` Prisma singleton read at
 * import time. It has no `@app/*` imports, so ESM evaluates these side effects
 * before any `@app` module (or src/ module) is loaded.
 *
 * The wiring test never touches the DB (buildBot constructs only), so a dummy
 * DATABASE_URL_PRISMA is enough — no `prisma db push` needed.
 */
process.env.DATABASE_URL_PRISMA ??= "file:./.tmp/order-bot-test.db";
process.env.BOT_TOKEN ??= "123:ABCDEFGHIJKLMNOPQRSTUVWXYZ-test";
process.env.BOT_USERNAME ??= "TestBot";
process.env.BINANCE_PAY_ID ??= "111222333";
process.env.ADMIN_IDS ??= "999,1000";
process.env.USE_UNIQUE_CENTS ??= "0";
process.env.DEFAULT_LANGUAGE ??= "en";
