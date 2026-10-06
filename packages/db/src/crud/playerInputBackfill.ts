/** One-time migration helper. Name matching lives here only, never in checkout. */
import { GAME_CATALOG, matchGameKey } from "@app/core/nickname/gameCatalog";
import { parseInputFields, nicknameInputKeys } from "@app/core/playerInput";
import type { Db } from "./_types";

export async function backfillPlayerInputConfiguration(db: Db, opts: { apply?: boolean; productIds?: number[] } = {}) {
  const denoms = await db.denomination.findMany({ where: { ...(opts.productIds ? { productId: { in: opts.productIds } } : {}), OR: [{ autoDeliverySource: "digiflazz" }, { nicknameCheckGameCode: { not: null } }] }, select: { id: true, productId: true, additionalFields: true, providerInputMapping: true, nicknameCheckGameCode: true, autoDeliverySource: true, product: { select: { name: true, digiflazzBrand: true } } } });
  const changes: Array<{ denominationId: number; productId: number; product: string; before: string | null; after: string; gameCode: string | null }> = [];
  for (const denom of denoms) {
    const key = matchGameKey({ ...denom.product, autoDeliverySource: denom.autoDeliverySource });
    const entry = key ? GAME_CATALOG[key] : null;
    // Delta Force is explicitly reviewed in this task: provider brand identity,
    // not fuzzy name inference. Keep any hand-configured fields unchanged.
    const delta = denom.product.digiflazzBrand === "Delta Force";
    const fields = parseInputFields(denom.additionalFields);
    const generic = fields.length === 2 && fields[0]?.key === "user_id" && fields[0].label.en === "Game ID" && fields[0].type === "text" && fields[0].required && fields[1]?.key === "server_id" && fields[1].label.en === "Server / Zone" && fields[1].type === "text" && !fields[1].required && fields.every((f) => !f.placeholder && !f.helpText && !f.minLength && !f.maxLength && !f.pattern && f.options.length === 0);
    let next = fields;
    if (generic && !denom.providerInputMapping && (entry || delta)) {
      next = [{ ...fields[0]!, type: delta || ["mobileLegends", "freeFire", "freeFireMax", "pubgMobile"].includes(key ?? "") ? "number" : "text", label: { id: "Player ID", en: "Player ID" } }];
      if (entry?.requiresZone || entry?.requiresServer) next.push({ ...fields[1]!, required: true, type: key === "mobileLegends" ? "number" : "text", label: key === "mobileLegends" ? { id: "Zone ID", en: "Zone ID" } : { id: "Server", en: "Server" } });
    }
    const gameCode = denom.nicknameCheckGameCode ?? entry?.code ?? null;
    if (next.length === 0) continue;
    const mapping = denom.providerInputMapping ?? JSON.stringify({ ...(gameCode ? { nickname: nicknameInputKeys(next) } : {}), ...(denom.autoDeliverySource === "digiflazz" ? { digiflazz: { keys: next.map((f) => f.key), separator: " " } } : {}) });
    const after = JSON.stringify(next);
    if (after === denom.additionalFields && gameCode === denom.nicknameCheckGameCode && mapping === denom.providerInputMapping) continue;
    changes.push({ denominationId: denom.id, productId: denom.productId, product: denom.product.name, before: denom.additionalFields, after, gameCode });
    if (opts.apply) {
      // Keep already-created pending targets stable while changing catalog config.
      await db.order.updateMany({ where: { inputConfigSnapshot: null, status: { in: ["PENDING_PAYMENT", "PENDING_VERIFICATION", "PAYMENT_DETECTED", "CONFIRMING", "CONFIRMED", "PROCESSING"] }, items: { some: { productId: denom.id } } }, data: { inputConfigSnapshot: JSON.stringify({ fields, providerInputMapping: denom.providerInputMapping }) } });
      await db.denomination.updateMany({ where: { id: denom.id, additionalFields: denom.additionalFields, nicknameCheckGameCode: denom.nicknameCheckGameCode, providerInputMapping: denom.providerInputMapping }, data: { additionalFields: after, nicknameCheckGameCode: gameCode, providerInputMapping: mapping } });
    }
  }
  return changes;
}
