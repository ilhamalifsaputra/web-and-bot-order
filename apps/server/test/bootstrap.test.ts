import "./setup-env"; // MUST be first: sets env + builds the temp DB schema.

import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { EventEmitter } from "node:events";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { prisma, setSetting } from "@app/db";
import { buildServer, dispatchByHost, registerCrashHandlers } from "../src/index";

/** Fastify instance type without a direct `fastify` dependency. */
type App = Awaited<ReturnType<typeof buildServer>>["app"];

/**
 * Bootstrap tests for the combined single-process server. They drive the
 * Fastify instance with `app.inject()` (no real network, no Telegram). The
 * webhook 401 path is checked before any update reaches the bot, so no
 * `bot.init()` / Telegram call is needed.
 */
const SECRET = "test-webhook-secret-123";

beforeAll(async () => {
  // Combined-server suite models a configured deploy; open the setup gate so
  // /bootstrap and the host-dispatch login redirect behave as before.
  await setSetting(prisma, "setup_completed", "true");
});

describe("combined server bootstrap", () => {
  describe("webhook mode", () => {
    let app: App;
    beforeAll(async () => {
      const built = await buildServer({ mode: "webhook", webhookSecret: SECRET });
      app = built.app;
      // Seed botInfo so grammY's webhookCallback skips its `getMe` init call
      // (no network in tests); the secret-token check then runs offline.
      built.bot!.botInfo = {
        id: 1,
        is_bot: true,
        first_name: "Test",
        username: "TestBot",
        can_join_groups: false,
        can_read_all_group_messages: false,
        supports_inline_queries: false,
      } as unknown as NonNullable<typeof built.bot>["botInfo"];
      await app.ready();
    });
    afterAll(async () => {
      await app.close();
    });

    it("serves the existing /healthz liveness probe", async () => {
      const res = await app.inject({ method: "GET", url: "/healthz" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: "ok" });
    });

    it("mounts the existing web-admin routes (GET /bootstrap renders)", async () => {
      const res = await app.inject({ method: "GET", url: "/bootstrap" });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain("password");
    });

    it("registers the webhook route and 401s on a bad secret token", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/tg/${SECRET}`,
        headers: { "x-telegram-bot-api-secret-token": "WRONG" },
        payload: { update_id: 1 },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe("polling mode", () => {
    let app: App;
    let shop: Awaited<ReturnType<typeof buildServer>>["shop"];
    beforeAll(async () => {
      ({ app, shop } = await buildServer({ mode: "polling" }));
      await app.ready();
      await shop.ready();
    });
    afterAll(async () => {
      await app.close();
      await shop.close();
      await prisma.$disconnect();
    });

    it("still serves /healthz", async () => {
      const res = await app.inject({ method: "GET", url: "/healthz" });
      expect(res.statusCode).toBe(200);
    });

    it("does NOT mount a webhook route", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/tg/${SECRET}`,
        payload: { update_id: 1 },
      });
      expect(res.statusCode).toBe(404);
    });

    it("builds the storefront app alongside the admin (own /healthz + home)", async () => {
      const health = await shop.inject({ method: "GET", url: "/healthz" });
      expect(health.statusCode).toBe(200);
      const home = await shop.inject({ method: "GET", url: "/" });
      expect(home.statusCode).toBe(200);
    });
  });

  describe("host dispatch (single public listener — plan.md §2 F)", () => {
    it("routes the shop hostname to the storefront and everything else to admin", () => {
      expect(dispatchByHost("shop.example.com", "shop.example.com")).toBe("shop");
      expect(dispatchByHost("SHOP.example.com:443", "shop.example.com")).toBe("shop");
      expect(dispatchByHost("www.shop.example.com", "shop.example.com")).toBe("shop");
      expect(dispatchByHost("WWW.shop.example.com:443", "shop.example.com")).toBe("shop");
      expect(dispatchByHost("admin.example.com", "shop.example.com")).toBe("admin");
      expect(dispatchByHost("203.0.113.7", "shop.example.com")).toBe("admin");
      expect(dispatchByHost(undefined, "shop.example.com")).toBe("admin");
    });

    it("serves both apps from one real socket, split by Host header", async () => {
      const { app, shop } = await buildServer({ mode: "polling" });
      await app.ready();
      await shop.ready();
      const shopHost = "shop.example.com";
      // Same dispatcher the composition root's start() builds.
      const front: Server = createServer((req, res) => {
        const target = dispatchByHost(req.headers.host, shopHost) === "shop" ? shop : app;
        target.server.emit("request", req, res);
      });
      await new Promise<void>((resolve) => front.listen(0, "127.0.0.1", resolve));
      const port = (front.address() as AddressInfo).port;
      // fetch/undici forbids overriding the Host header — go down to http.request.
      const get = (host?: string) =>
        new Promise<{ status: number; location: string | undefined }>((resolve, reject) => {
          const req = httpRequest(
            { host: "127.0.0.1", port, path: "/", headers: host ? { host } : {} },
            (res) => {
              res.resume();
              res.on("end", () =>
                resolve({ status: res.statusCode ?? 0, location: res.headers.location }),
              );
            },
          );
          req.on("error", reject);
          req.end();
        });
      try {
        // Shop host → storefront home (no admin login redirect on /).
        const shopRes = await get(shopHost);
        expect(shopRes.status).toBe(200);
        // Any other host → web-admin (/ redirects to its login).
        const adminRes = await get();
        expect([301, 302, 303]).toContain(adminRes.status);
        expect(adminRes.location).toContain("login");
      } finally {
        await new Promise<void>((resolve) => front.close(() => resolve()));
        await app.close();
        await shop.close();
      }
    });
  });

  // Infra-6 fix (security audit, 2026-06-23): a fake event-emitter stands in
  // for the real `process` so this test never installs a REAL
  // unhandledRejection/uncaughtException handler on the test runner's own
  // process (which would leak across unrelated test files and could call the
  // real process.exit).
  describe("registerCrashHandlers (Infra-6 fix)", () => {
    it("runs the controlled shutdown with exit code 1 on an unhandled rejection", () => {
      const fakeProc = new EventEmitter();
      const shutdown = vi.fn().mockResolvedValue(undefined);
      registerCrashHandlers(shutdown, fakeProc);

      const reason = new Error("boom from a stray poller");
      fakeProc.emit("unhandledRejection", reason);

      expect(shutdown).toHaveBeenCalledWith("unhandledRejection", 1);
    });

    it("runs the controlled shutdown with exit code 1 on an uncaught exception", () => {
      const fakeProc = new EventEmitter();
      const shutdown = vi.fn().mockResolvedValue(undefined);
      registerCrashHandlers(shutdown, fakeProc);

      fakeProc.emit("uncaughtException", new Error("boom"));

      expect(shutdown).toHaveBeenCalledWith("uncaughtException", 1);
    });
  });
});
