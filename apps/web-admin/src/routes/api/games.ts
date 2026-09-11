/**
 * Admin API for the multi-provider nickname-check catalog layer (Task 10):
 * Game CRUD plus per-game ProviderGameMapping upsert/delete. Thin Fastify
 * wrapper over packages/db/src/crud/games.ts (Task 7) — no raw SQL here,
 * every write goes through that crud module. Mirrors settings.ts/catalog.ts's
 * admin-auth + CSRF + logAdminAction conventions.
 */
import type { FastifyInstance } from "fastify";
import {
  prisma,
  listGames,
  getGame,
  getGameBySlug,
  createGame,
  updateGame,
  deleteGame,
  upsertProviderGameMapping,
  deleteProviderGameMapping,
  logAdminAction,
} from "@app/db";
import { currentAdmin, csrfProtect } from "../../plugins/auth";

/** The only providers the multi-provider nickname-check flow knows how to
 * call (packages/db/src/crud/games.ts's doc-comment on ProviderGameMapping). */
const VALID_PROVIDERS = new Set(["kokinpay", "vipreseller", "melostore"]);

/** Lowercase letters/digits separated by single hyphens, no leading/trailing
 * hyphen — the same shape slugify() (packages/db/src/migrate/slug.ts)
 * produces. Game.slug is admin-typed directly rather than derived from a
 * name, so it needs validating instead of generating. */
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Trim a possibly-missing string field to null-or-string, the same "blank
 * means null" convention catalog.ts's storefrontDetailFields/gameNavigationFields use. */
function text(value: unknown): string | null {
  return typeof value === "string" ? value.trim() || null : null;
}

/** True/false pass through unchanged; anything else (missing, wrong type)
 * becomes undefined so the crud layer's schema default/existing value wins. */
function optionalBool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function isUniqueConstraintError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "P2002";
}

export default async function gamesApiRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/games", { preHandler: currentAdmin }, async (_req, reply) => {
    const games = await listGames(prisma);
    return reply.send({ games });
  });

  app.get("/api/games/:id", { preHandler: currentAdmin }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: "Invalid game id." });
    const game = await getGame(prisma, id);
    if (!game) return reply.code(404).send({ error: "Game not found." });
    return reply.send({ game });
  });

  app.post("/api/games", { preHandler: csrfProtect }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const slug = (typeof body.slug === "string" ? body.slug : "").trim();
    const name = (typeof body.name === "string" ? body.name : "").trim();
    if (!name) return reply.code(400).send({ error: "Name is required." });
    if (!slug || !SLUG_RE.test(slug)) {
      return reply.code(400).send({ error: "Slug must contain only lowercase letters, numbers, and hyphens (e.g. \"mobile-legends\")." });
    }
    if (await getGameBySlug(prisma, slug)) {
      return reply.code(400).send({ error: `A game with the slug "${slug}" already exists.` });
    }

    let game;
    try {
      game = await createGame(prisma, {
        slug,
        name,
        category: text(body.category),
        nicknameSupported: optionalBool(body.nicknameSupported),
        requiresZone: optionalBool(body.requiresZone),
        requiresServer: optionalBool(body.requiresServer),
      });
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        return reply.code(400).send({ error: `A game with the slug "${slug}" already exists.` });
      }
      throw err;
    }

    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "game_create",
      targetType: "game",
      targetId: game.id,
      details: `Created game "${name}".`,
    });
    return reply.code(201).send({ game });
  });

  app.post("/api/games/:id/edit", { preHandler: csrfProtect }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: "Invalid game id." });
    const existing = await getGame(prisma, id);
    if (!existing) return reply.code(404).send({ error: "Game not found." });

    const body = (req.body ?? {}) as Record<string, unknown>;
    const fields: {
      slug?: string;
      name?: string;
      category?: string | null;
      nicknameSupported?: boolean;
      requiresZone?: boolean;
      requiresServer?: boolean;
      isActive?: boolean;
    } = {};

    if (body.name !== undefined) {
      const name = (typeof body.name === "string" ? body.name : "").trim();
      if (!name) return reply.code(400).send({ error: "Name is required." });
      fields.name = name;
    }
    if (body.slug !== undefined) {
      const slug = (typeof body.slug === "string" ? body.slug : "").trim();
      if (!slug || !SLUG_RE.test(slug)) {
        return reply.code(400).send({ error: "Slug must contain only lowercase letters, numbers, and hyphens (e.g. \"mobile-legends\")." });
      }
      if (slug !== existing.slug && (await getGameBySlug(prisma, slug))) {
        return reply.code(400).send({ error: `A game with the slug "${slug}" already exists.` });
      }
      fields.slug = slug;
    }
    if (body.category !== undefined) fields.category = text(body.category);
    if (typeof body.nicknameSupported === "boolean") fields.nicknameSupported = body.nicknameSupported;
    if (typeof body.requiresZone === "boolean") fields.requiresZone = body.requiresZone;
    if (typeof body.requiresServer === "boolean") fields.requiresServer = body.requiresServer;
    if (typeof body.isActive === "boolean") fields.isActive = body.isActive;

    let game;
    try {
      game = await updateGame(prisma, id, fields);
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        return reply.code(400).send({ error: `A game with the slug "${fields.slug ?? ""}" already exists.` });
      }
      throw err;
    }

    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "game_update",
      targetType: "game",
      targetId: id,
      details: `Updated game "${game.name}".`,
    });
    return reply.send({ game });
  });

  app.post("/api/games/:id/delete", { preHandler: csrfProtect }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: "Invalid game id." });
    const existing = await getGame(prisma, id);
    if (!existing) return reply.code(404).send({ error: "Game not found." });

    try {
      await deleteGame(prisma, id);
    } catch (err) {
      // deleteGame throws a plain Error (not a dedicated class) when a
      // Product still references this game — translate it to a clean 400
      // instead of letting it fall through to the app's generic 500 handler.
      if (err instanceof Error && err.message.includes("still referenced")) {
        return reply.code(400).send({
          error: `"${existing.name}" is still linked to one or more products — reassign or clear their game before deleting it.`,
        });
      }
      throw err;
    }

    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "game_delete",
      targetType: "game",
      targetId: id,
      details: `Deleted game "${existing.name}".`,
    });
    return reply.send({ ok: true });
  });

  app.post("/api/games/:id/mappings", { preHandler: csrfProtect }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: "Invalid game id." });
    const game = await getGame(prisma, id);
    if (!game) return reply.code(404).send({ error: "Game not found." });

    const body = (req.body ?? {}) as Record<string, unknown>;
    const provider = typeof body.provider === "string" ? body.provider : "";
    if (!VALID_PROVIDERS.has(provider)) {
      return reply.code(400).send({ error: 'Provider must be one of "kokinpay", "vipreseller", or "melostore".' });
    }
    const providerGameCode = (typeof body.providerGameCode === "string" ? body.providerGameCode : "").trim();
    if (!providerGameCode) return reply.code(400).send({ error: "Provider game code is required." });

    const mapping = await upsertProviderGameMapping(prisma, {
      gameId: id,
      provider,
      providerGameCode,
      enabled: optionalBool(body.enabled),
      priority: typeof body.priority === "number" && Number.isInteger(body.priority) ? body.priority : undefined,
    });

    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "game_mapping_upsert",
      targetType: "game",
      targetId: id,
      details: `Set the ${provider} mapping for "${game.name}" to code "${providerGameCode}".`,
    });
    return reply.send({ mapping });
  });

  app.post("/api/games/:id/mappings/:mappingId/delete", { preHandler: csrfProtect }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const mappingId = Number((req.params as { mappingId: string }).mappingId);
    if (!Number.isInteger(id) || !Number.isInteger(mappingId)) {
      return reply.code(400).send({ error: "Invalid id." });
    }
    const game = await getGame(prisma, id);
    if (!game) return reply.code(404).send({ error: "Game not found." });
    const mapping = game.providerMappings.find((m) => m.id === mappingId);
    if (!mapping) return reply.code(404).send({ error: "Mapping not found." });

    await deleteProviderGameMapping(prisma, mappingId);

    await logAdminAction(prisma, {
      adminId: req.admin!.userId,
      action: "game_mapping_delete",
      targetType: "game",
      targetId: id,
      details: `Removed the ${mapping.provider} mapping from "${game.name}".`,
    });
    return reply.send({ ok: true });
  });
}
