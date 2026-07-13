// setup-db MUST be first — temp DB + push before any @app import.
import "./setup-db";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  prisma,
  createCategory,
  createCatalogProduct,
  createDenomination,
  updateDenomination,
  createOrderDirect,
  attachPaymentProof,
  settlePaidOrder,
  fulfillManualOrder,
  getOrder,
} from "@app/db";
import { DeliveryType } from "@app/core/enums";
import { AdditionalFieldType, type AdditionalField } from "@app/core/deliveryFields";
import { buildSampleData, resetDb, type SampleData } from "../../../tests/helpers/sampleData";
import { makeCtx, FakeConversation, sentIncludes, type SentCall } from "./helpers/ctx";
import type { MyContext, SessionData } from "../src/context";
import { editCustomerInfoConversation } from "../src/conversations/editCustomerInfo";

let sample: SampleData;
let adminId: number;

beforeEach(async () => {
  await resetDb(prisma);
  sample = await buildSampleData(prisma);
  const admin = await prisma.user.create({
    data: {
      telegramId: BigInt(900_000_000 + Math.floor(Math.random() * 1_000_000)),
      referralCode: `admin-${Math.random()}`,
      role: "ADMIN",
    },
  });
  adminId = admin.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

function userSession(): Partial<SessionData> {
  return {
    lang: "en",
    scratch: {},
    dbUser: {
      id: sample.user.id,
      telegramId: String(sample.user.telegramId),
      role: sample.user.role,
      language: sample.user.language,
      referralCode: sample.user.referralCode,
      walletBalance: String(sample.user.walletBalance),
    },
  };
}

function entryCtx(orderId: number, sink: SentCall[], sessionOverrides: Partial<SessionData> = {}) {
  return makeCtx({
    sink,
    from: { id: 42, username: "tester" },
    session: { ...userSession(), ...sessionOverrides, scratch: { editInfoOrderId: orderId } },
    callbackData: `v1:order:editinfo:${orderId}`,
  }).ctx;
}

async function makeManualWithInfoDenom(fields: AdditionalField[]) {
  const category = await createCategory(prisma, `edit-info-cat-${Math.random()}`);
  const product = await createCatalogProduct(prisma, { categoryId: category.id, name: `Edit Info Product ${Math.random()}` });
  const denom = await createDenomination(prisma, {
    productId: product.id,
    name: "Edit Info Denom",
    type: "SHARED",
    durationLabel: "1 Month",
    price: "10.00",
  });
  await updateDenomination(prisma, denom.id, {
    deliveryType: DeliveryType.MANUAL_WITH_INFO,
    additionalFields: JSON.stringify(fields),
  });
  return denom;
}

/** Drive an order to PROCESSING carrying `customerData` — the same
 * createOrderDirect -> attachPaymentProof -> settlePaidOrder path every real
 * manual_with_info order takes (see settlePaidOrder.test.ts). */
async function makeProcessingOrder(productId: number, quantity: number, customerData: string) {
  const order = await createOrderDirect(prisma, {
    user: { id: sample.user.id, role: sample.user.role },
    productId,
    quantity,
    customerData,
  });
  await attachPaymentProof(prisma, order!.id, { fileId: "file123", txid: `TX-${order!.id}` });
  await settlePaidOrder(prisma, order!.id, { adminId });
  return order!.id;
}

/** A FakeConversation that fires a caller-supplied side effect the first time
 * wait() is called — used to simulate a real admin-fulfils-it-concurrently
 * race landing exactly between the wizard's prompt and the buyer's answer
 * arriving (which a plain scripted queue can't otherwise reproduce, since
 * FakeConversation.wait() resolves synchronously with no real gap to race
 * into). */
class RacingConversation extends FakeConversation {
  private fired = false;
  constructor(
    queue: MyContext[],
    private readonly raceFn: () => Promise<void>,
  ) {
    super(queue);
  }
  override async wait(): Promise<MyContext> {
    const ctx = await super.wait();
    if (!this.fired) {
      this.fired = true;
      await this.raceFn();
    }
    return ctx;
  }
}

const GAME_ID_FIELD: AdditionalField = {
  key: "game_id",
  label: { id: "ID Game", en: "Game ID" },
  type: AdditionalFieldType.TEXT,
  required: true,
  options: [],
  placeholder: "",
};

const EMAIL_FIELD: AdditionalField = {
  key: "email",
  label: { id: "Email", en: "Email" },
  type: AdditionalFieldType.EMAIL,
  required: true,
  options: [],
  placeholder: "",
};

const OPTIONAL_NOTE_FIELD: AdditionalField = {
  key: "note",
  label: { id: "Catatan", en: "Note" },
  type: AdditionalFieldType.TEXT,
  required: false,
  options: [],
  placeholder: "",
};

describe("editCustomerInfoConversation — happy paths", () => {
  it("pre-seeds the field prompt with the current value, and /skip carries it forward unchanged", async () => {
    const denom = await makeManualWithInfoDenom([GAME_ID_FIELD]);
    const orderId = await makeProcessingOrder(denom.id, 1, JSON.stringify([{ game_id: "OLD-1" }]));
    const sink: SentCall[] = [];
    const entry = entryCtx(orderId, sink);
    const skipMsg = makeCtx({ sink, from: { id: 42, username: "tester" }, session: userSession(), text: "/skip" }).ctx;
    const conv = new FakeConversation([skipMsg]);

    await editCustomerInfoConversation(conv.asMyConversation(), entry);

    expect(sentIncludes(sink, "Current: OLD-1")).toBe(true);
    const fresh = await getOrder(prisma, orderId);
    expect(JSON.parse(fresh!.customerData!)).toEqual([{ game_id: "OLD-1" }]);
  });

  it("typing a new value overwrites the current answer and re-renders the order-detail screen", async () => {
    const denom = await makeManualWithInfoDenom([GAME_ID_FIELD]);
    const orderId = await makeProcessingOrder(denom.id, 1, JSON.stringify([{ game_id: "OLD-1" }]));
    const sink: SentCall[] = [];
    const entry = entryCtx(orderId, sink);
    const answerMsg = makeCtx({ sink, from: { id: 42, username: "tester" }, session: userSession(), text: "NEW-1" }).ctx;
    const conv = new FakeConversation([answerMsg]);

    await editCustomerInfoConversation(conv.asMyConversation(), entry);

    const fresh = await getOrder(prisma, orderId);
    expect(JSON.parse(fresh!.customerData!)).toEqual([{ game_id: "NEW-1" }]);
    expect(sentIncludes(sink, fresh!.orderCode)).toBe(true); // viewOrder re-rendered
  });

  it("re-prompts the SAME field on a validation error, then proceeds once the retry is valid", async () => {
    const denom = await makeManualWithInfoDenom([EMAIL_FIELD]);
    const orderId = await makeProcessingOrder(denom.id, 1, JSON.stringify([{ email: "old@example.com" }]));
    const sink: SentCall[] = [];
    const entry = entryCtx(orderId, sink);
    const bad = makeCtx({ sink, from: { id: 42, username: "tester" }, session: userSession(), text: "not-an-email" }).ctx;
    const good = makeCtx({ sink, from: { id: 42, username: "tester" }, session: userSession(), text: "new@example.com" }).ctx;
    const conv = new FakeConversation([bad, good]);

    await editCustomerInfoConversation(conv.asMyConversation(), entry);

    expect(sentIncludes(sink, "Please enter a valid email address.")).toBe(true);
    const fresh = await getOrder(prisma, orderId);
    expect(JSON.parse(fresh!.customerData!)).toEqual([{ email: "new@example.com" }]);
  });

  it("qty=2: prompts once per unit (pre-seeded per-unit) and persists 2 independently-edited answer maps", async () => {
    const denom = await makeManualWithInfoDenom([GAME_ID_FIELD]);
    const orderId = await makeProcessingOrder(
      denom.id,
      2,
      JSON.stringify([{ game_id: "OLD-1" }, { game_id: "OLD-2" }]),
    );
    const sink: SentCall[] = [];
    const entry = entryCtx(orderId, sink);
    const unit1 = makeCtx({ sink, from: { id: 42, username: "tester" }, session: userSession(), text: "/skip" }).ctx;
    const unit2 = makeCtx({ sink, from: { id: 42, username: "tester" }, session: userSession(), text: "NEW-2" }).ctx;
    const conv = new FakeConversation([unit1, unit2]);

    await editCustomerInfoConversation(conv.asMyConversation(), entry);

    const fresh = await getOrder(prisma, orderId);
    expect(JSON.parse(fresh!.customerData!)).toEqual([{ game_id: "OLD-1" }, { game_id: "NEW-2" }]);
  });
});

describe("editCustomerInfoConversation — /cancel", () => {
  it("/cancel discards in-progress edits — the original data survives untouched", async () => {
    const denom = await makeManualWithInfoDenom([GAME_ID_FIELD]);
    const orderId = await makeProcessingOrder(denom.id, 1, JSON.stringify([{ game_id: "OLD-1" }]));
    const sink: SentCall[] = [];
    const entry = entryCtx(orderId, sink);
    const cancelMsg = makeCtx({ sink, from: { id: 42, username: "tester" }, session: userSession(), text: "/cancel" }).ctx;
    const conv = new FakeConversation([cancelMsg]);

    await editCustomerInfoConversation(conv.asMyConversation(), entry);

    const fresh = await getOrder(prisma, orderId);
    expect(JSON.parse(fresh!.customerData!)).toEqual([{ game_id: "OLD-1" }]);
  });

  it("tapping the keyboard's Cancel button (routes to v1:order:view) has the same discard effect as /cancel", async () => {
    const denom = await makeManualWithInfoDenom([GAME_ID_FIELD]);
    const orderId = await makeProcessingOrder(denom.id, 1, JSON.stringify([{ game_id: "OLD-1" }]));
    const sink: SentCall[] = [];
    const entry = entryCtx(orderId, sink);
    const cancelTap = makeCtx({
      sink,
      from: { id: 42, username: "tester" },
      session: userSession(),
      callbackData: `v1:order:view:${orderId}`,
    }).ctx;
    const conv = new FakeConversation([cancelTap]);

    await editCustomerInfoConversation(conv.asMyConversation(), entry);

    const fresh = await getOrder(prisma, orderId);
    expect(JSON.parse(fresh!.customerData!)).toEqual([{ game_id: "OLD-1" }]);
  });
});

describe("editCustomerInfoConversation — mid-edit race (order leaves PROCESSING)", () => {
  it("already left PROCESSING before entry (e.g. already fulfilled) — shows the error and never prompts", async () => {
    const denom = await makeManualWithInfoDenom([GAME_ID_FIELD]);
    const orderId = await makeProcessingOrder(denom.id, 1, JSON.stringify([{ game_id: "OLD-1" }]));
    await fulfillManualOrder(prisma, orderId, { adminId, content: "already delivered" });

    const sink: SentCall[] = [];
    const entry = entryCtx(orderId, sink);
    const conv = new FakeConversation([]); // must never reach wait()

    await editCustomerInfoConversation(conv.asMyConversation(), entry);

    expect(sentIncludes(sink, "no longer awaiting fulfilment")).toBe(true);
    expect(sentIncludes(sink, "Game ID")).toBe(false); // no field prompt was ever shown
  });

  it("fulfilled by an admin mid-edit (after the prompt, before the buyer's answer lands) — the final write is rejected and the edit is not applied", async () => {
    const denom = await makeManualWithInfoDenom([GAME_ID_FIELD]);
    const orderId = await makeProcessingOrder(denom.id, 1, JSON.stringify([{ game_id: "OLD-1" }]));
    const sink: SentCall[] = [];
    const entry = entryCtx(orderId, sink);
    const answerMsg = makeCtx({ sink, from: { id: 42, username: "tester" }, session: userSession(), text: "RACED-VALUE" }).ctx;
    // Fires right as the buyer's answer is "received" — simulating an admin
    // fulfilling the order in the window between the wizard's prompt and the
    // buyer's reply reaching updateOrderCustomerData's own PROCESSING claim.
    const conv = new RacingConversation([answerMsg], async () => {
      await fulfillManualOrder(prisma, orderId, { adminId, content: "raced delivery" });
    });

    await editCustomerInfoConversation(conv.asMyConversation(), entry);

    expect(sentIncludes(sink, "no longer awaiting fulfilment")).toBe(true);
    const fresh = await getOrder(prisma, orderId);
    expect(fresh!.deliveredContent).toBe("raced delivery"); // untouched by the raced edit
    expect(JSON.parse(fresh!.customerData!)).toEqual([{ game_id: "OLD-1" }]); // customerData unchanged
  });
});

describe("editCustomerInfoConversation — current-value HTML escaping", () => {
  it("escapes HTML-special characters in the pre-seeded current-value prompt", async () => {
    const denom = await makeManualWithInfoDenom([GAME_ID_FIELD]);
    const raw = "<b>OLD</b> & more";
    const orderId = await makeProcessingOrder(denom.id, 1, JSON.stringify([{ game_id: raw }]));
    const sink: SentCall[] = [];
    const entry = entryCtx(orderId, sink);
    // /cancel immediately after the initial (pre-seeded) prompt — the escaping
    // under test happens on that very first render, before any wait() reply.
    const cancelMsg = makeCtx({ sink, from: { id: 42, username: "tester" }, session: userSession(), text: "/cancel" }).ctx;
    const conv = new FakeConversation([cancelMsg]);

    await editCustomerInfoConversation(conv.asMyConversation(), entry);

    const body = JSON.stringify(sink);
    expect(body).not.toContain("<b>OLD</b>");
    expect(sentIncludes(sink, "&lt;b&gt;OLD&lt;/b&gt; &amp; more")).toBe(true);
  });
});

describe("editCustomerInfoConversation — /skip on an optional field with no prior answer", () => {
  it("lets the buyer /skip an optional field they left blank at checkout, instead of showing 'This field is required'", async () => {
    const denom = await makeManualWithInfoDenom([OPTIONAL_NOTE_FIELD]);
    // The buyer left the optional field blank at checkout — no key for it in customerData.
    const orderId = await makeProcessingOrder(denom.id, 1, JSON.stringify([{}]));
    const sink: SentCall[] = [];
    const entry = entryCtx(orderId, sink);
    const skipMsg = makeCtx({ sink, from: { id: 42, username: "tester" }, session: userSession(), text: "/skip" }).ctx;
    const conv = new FakeConversation([skipMsg]);

    await editCustomerInfoConversation(conv.asMyConversation(), entry);

    expect(sentIncludes(sink, "This field is required")).toBe(false);
    const fresh = await getOrder(prisma, orderId);
    expect(JSON.parse(fresh!.customerData!)).toEqual([{ note: "" }]);
  });
});

describe("editCustomerInfoConversation — ownership guard", () => {
  it("an order not owned by this user shows error.order_not_found and never prompts", async () => {
    const denom = await makeManualWithInfoDenom([GAME_ID_FIELD]);
    const orderId = await makeProcessingOrder(denom.id, 1, JSON.stringify([{ game_id: "OLD-1" }]));
    const sink: SentCall[] = [];
    const stranger = makeCtx({
      sink,
      from: { id: 777 },
      session: {
        lang: "en",
        scratch: { editInfoOrderId: orderId },
        dbUser: { id: 99999, telegramId: "777", role: "CUSTOMER", language: "EN", referralCode: "X", walletBalance: "0" },
      },
      callbackData: `v1:order:editinfo:${orderId}`,
    }).ctx;
    const conv = new FakeConversation([]);

    await editCustomerInfoConversation(conv.asMyConversation(), stranger);

    expect(sentIncludes(sink, "Order not found")).toBe(true);
    expect(sentIncludes(sink, "Game ID")).toBe(false);
  });
});
