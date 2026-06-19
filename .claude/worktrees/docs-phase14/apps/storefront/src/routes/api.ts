/**
 * Versioned JSON API (`/api/v1`) — a JSON twin of the existing HTML catalog,
 * cart and checkout routes for the storefront's own client-side JS / a future
 * first-party SPA reusing the existing logged-in browser session. Reuses the
 * SAME crud and business logic as the HTML routes (no duplicated logic, no
 * raw SQL): catalog reads go through packages/db/src/crud/catalog.ts, cart
 * mutations reuse loadCartLines/clampQty-equivalent rules from ./cart, and
 * checkout reuses performCheckout from ./checkout.
 *
 * Auth is the existing cookie session — not a new token/API-key scheme.
 * Unmatched routes and unexpected exceptions fall through to server.ts's
 * global handlers; only the success and named expected-failure paths below
 * return JSON here.
 */
import type { FastifyPluginAsync } from "fastify";
import { Decimal } from "@app/core/money";
import { config } from "@app/core/config";
import { ValidationError } from "@app/core/errors";
import {
  prisma,
  getCategoryBySlug,
  listActiveCategories,
  listCatalogProducts,
  getCatalogProductBySlugWithDenominations,
  getDenomination,
  addToCart,
  countAvailableStock,
  type CatalogProduct,
} from "@app/db";
import type { Category, Denomination } from "@prisma/client";
import { optionalCustomer } from "../plugins/auth";
import { productImage } from "../images";
import { readGuestCart, writeGuestCart, CART_COOKIE, CART_COOKIE_VERSION, type GuestCartLine } from "../shop";
import { loadCartLines } from "./cart";
import { performCheckout } from "./checkout";

interface CategoryJson {
  id: number;
  slug: string;
  name: string;
  emoji: string | null;
  description: string | null;
  image: string | null;
}

interface DenominationJson {
  id: number;
  name: string;
  price: string;
  stock: number;
  status: "in_stock" | "low_stock" | "out_of_stock";
}

interface ProductJson {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  image: string | null;
  category: CategoryJson;
  denominations: DenominationJson[];
}

function categoryJson(category: Category): CategoryJson {
  return {
    id: category.id,
    slug: category.slug,
    name: category.name,
    emoji: category.emoji,
    description: category.description,
    image: category.image,
  };
}

async function denominationJson(d: Denomination): Promise<DenominationJson> {
  const stock = await countAvailableStock(prisma, d.id);
  const status: DenominationJson["status"] =
    stock <= 0 ? "out_of_stock" : stock <= config.LOW_STOCK_THRESHOLD ? "low_stock" : "in_stock";
  return {
    id: d.id,
    name: d.name,
    price: new Decimal(d.price).toString(),
    stock,
    status,
  };
}

async function productJson(product: CatalogProduct): Promise<ProductJson> {
  const denominations = await Promise.all(product.denominations.map(denominationJson));
  return {
    id: product.id,
    slug: product.slug,
    name: product.name,
    description: product.description,
    image: product.webImageUrl ?? productImage(product, product.category.name),
    category: categoryJson(product.category),
    denominations,
  };
}

/** clamp 1-99, default 1 — mirrors clampQty in ./cart, applied to a JSON qty. */
function clampJsonQty(raw: unknown): number {
  if (raw == null) return 1;
  const n = Number(raw);
  if (!Number.isInteger(n)) return 1;
  return Math.max(1, Math.min(n, 99));
}

const apiRoutes: FastifyPluginAsync = async (app) => {
  // ---- 1. GET /categories ----
  app.get("/categories", async (_req, reply) => {
    const categories = await listActiveCategories(prisma);
    return reply.send({ categories: categories.map(categoryJson) });
  });

  // ---- 2. GET /categories/:slug/products ----
  app.get<{ Params: { slug: string } }>("/categories/:slug/products", async (req, reply) => {
    const category = await getCategoryBySlug(prisma, req.params.slug);
    if (!category || !category.isActive) {
      return reply.code(404).send({ error: "not_found" });
    }
    const products = await listCatalogProducts(prisma, category.id);
    return reply.send({ products: await Promise.all(products.map(productJson)) });
  });

  // ---- 3. GET /products ----
  app.get("/products", async (_req, reply) => {
    const products = await listCatalogProducts(prisma);
    return reply.send({ products: await Promise.all(products.map(productJson)) });
  });

  // ---- 4. GET /products/:slug ----
  app.get<{ Params: { slug: string } }>("/products/:slug", async (req, reply) => {
    const product = await getCatalogProductBySlugWithDenominations(prisma, req.params.slug);
    if (!product || !product.isActive || product.denominations.length === 0) {
      return reply.code(404).send({ error: "not_found" });
    }
    return reply.send({ product: await productJson(product) });
  });

  // ---- 5. GET /products/:slug/denominations ----
  app.get<{ Params: { slug: string } }>("/products/:slug/denominations", async (req, reply) => {
    const product = await getCatalogProductBySlugWithDenominations(prisma, req.params.slug);
    if (!product || !product.isActive || product.denominations.length === 0) {
      return reply.code(404).send({ error: "not_found" });
    }
    return reply.send({ denominations: await Promise.all(product.denominations.map(denominationJson)) });
  });

  // ---- 6. POST /cart ----
  app.post<{ Body: { denomination_id?: number; qty?: number } }>("/cart", async (req, reply) => {
    const customer = await optionalCustomer(req);
    if (customer) {
      const token = req.headers["x-csrf-token"];
      if (!token || token !== customer.csrf) {
        return reply.code(403).send({ error: "csrf_failed" });
      }
    }

    const denominationId = Number(req.body?.denomination_id);
    if (!Number.isInteger(denominationId) || denominationId <= 0) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    const denom = await getDenomination(prisma, denominationId);
    if (!denom || !denom.isActive) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    const qty = clampJsonQty(req.body?.qty);

    if (customer) {
      await addToCart(prisma, customer.userId, denom.id, qty);
    } else {
      const lines = readGuestCart(req);
      const existing = lines.find((l) => l.p === denom.id);
      const next: GuestCartLine[] = existing
        ? lines.map((l) => (l.p === denom.id ? { p: l.p, q: Math.min(l.q + qty, 99) } : l))
        : [...lines, { p: denom.id, q: qty }];
      writeGuestCart(reply, next);
      // loadCartLines() re-reads the guest cookie from req.cookies — patch the
      // in-memory request cookie so it reflects the write we just made via
      // `reply`, instead of re-parsing the stale value from the incoming request.
      req.cookies[CART_COOKIE] = JSON.stringify({ v: CART_COOKIE_VERSION, items: next });
    }

    const items = await loadCartLines(req, customer);
    const subtotal = items.reduce((s, l) => s.plus(l.line_total), new Decimal(0));
    return reply.send({ items, subtotal: subtotal.toString() });
  });

  // ---- 7. POST /checkout ----
  app.post<{ Body: { method?: string; voucher_code?: string } }>("/checkout", async (req, reply) => {
    const customer = await optionalCustomer(req);
    if (!customer) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const token = req.headers["x-csrf-token"];
    if (!token || token !== customer.csrf) {
      return reply.code(403).send({ error: "csrf_failed" });
    }

    const method = (req.body?.method ?? "").toLowerCase();
    const voucherCode = (req.body?.voucher_code ?? "").trim().toUpperCase() || null;

    try {
      const { orderCode } = await performCheckout(customer, method, voucherCode);
      return reply.code(201).send({ order_code: orderCode, pay_url: `/checkout/${orderCode}/pay` });
    } catch (e) {
      if (e instanceof ValidationError) {
        return reply.code(400).send({ error: e.key });
      }
      throw e;
    }
  });
};

export default apiRoutes;
