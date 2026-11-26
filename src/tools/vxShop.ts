import { z } from "zod";
import { v8Request } from "../api/v8MemeApi.js";
import { VX_SHOP_MEDIA_CATEGORY } from "../api/verse8Web.js";
import { safeErrorHint } from "../util/redact.js";
import { apiFail, checkPlan, diff, isApproved, mediaPath, opFail, planGate, planIdField, PROBED, rereadWith, withRejectedTokenHint, type ConfirmHost, type OpFail, type Plan, type PlanProbe } from "./creatorOps.js";
import { uploadLocalMedia, validateLocalMedia } from "./uploadThumbnail.js";
import { projectDirField, resolveVerseContext, verseIdField, type VerseContext } from "./verseContext.js";

/**
 * `verse8_vxshop` — the creator page's VX Shop tab: seller status, item
 * list, create / edit items. Changing actions preview by default and run
 * only with the planId their preview returned (creatorOps plan gate).
 * Starting a sale — any change after which buyers can newly purchase the
 * item (on-sale flag, restore, stock from 0, sale dates) — and changing
 * the price of an item on sale or scheduled also need the user's own
 * confirmation in the host's prompt, and run only if the item read again
 * after that answer is still as the prompt showed it (creatorOps RUN_RULES).
 *
 * Backend traps this tool closes (g2-sync vxShop.service.ts):
 *  - an update without `purchaseConstraints` DELETES the item's purchase
 *    limits (:157-163, :675-679) — so every update re-sends the current
 *    constraints unless the caller changes or clears them;
 *  - `metadata` must be a JSON object string, anything else is dropped
 *    (:145-155) — the tool takes an object and serializes it;
 *  - `stock` defaults to 0 (= out of stock) — required on create;
 *  - the server does not check seller approval; the web hides the shop
 *    until `GET /v1/vx-wallet` says `isSeller` — the tool refuses the same.
 */

const ACTIONS = ["list", "upsert", "sales", "revenue", "archive", "dispute"] as const;

const purchaseConstraintsSchema = z
  .object({
    maxPurchasePerUser: z.number().int().min(1).optional().describe("Max units one user may buy in total."),
    maxPurchasePerPeriod: z.number().int().min(1).optional().describe("Max units per user within purchasePeriodDays."),
    purchasePeriodDays: z.number().int().min(1).optional().describe("Length of the period for maxPurchasePerPeriod."),
    purchaseStartDate: z.string().min(1).max(40).optional().describe("ISO 8601 date (-time) sales open."),
    purchaseEndDate: z.string().min(1).max(40).optional().describe("ISO 8601 date (-time) sales close."),
  })
  .strict();

export const vxShopInputSchema = z
  .object({
    action: z
      .enum(ACTIONS)
      .describe("list: seller status + items (with parsed purchase limits). upsert: create an item (no itemId) or edit one (itemId) — preview unless planId. sales: purchases (paged; by item; disputes only). revenue: VX totals and refunds for a period. archive: archive / restore an item (preview unless planId). dispute: answer a buyer's dispute (preview unless planId)."),
    projectDir: projectDirField,
    verseId: verseIdField,
    planId: planIdField,
    includeArchived: z.boolean().optional().describe("list: include archived items."),
    page: z.number().int().min(1).optional().describe("list: page (default 1)."),
    limit: z.number().int().min(1).max(100).optional().describe("list: page size (default 20)."),
    itemId: z.number().int().min(1).optional().describe("upsert: the item to edit (from list). Omit to create."),
    productId: z.string().min(1).max(100).optional().describe("upsert create: product id the game's code buys with (unique per verse, cannot be changed later)."),
    name: z.string().min(1).max(255).optional().describe("upsert: display name."),
    price: z.number().int().min(0).optional().describe("upsert: price in VX (integer)."),
    stock: z.number().int().min(0).optional().describe("upsert: units available; 0 = out of stock. Required on create."),
    description: z.string().max(5000).optional().describe("upsert: item description."),
    imagePath: z.string().min(1).optional().describe("upsert: local item image (png/jpg/gif/webp ≤4 MB), uploaded when it runs."),
    imageUrl: z.string().url().max(500).optional().describe("upsert: already-hosted image URL."),
    metadata: z
      .record(z.unknown())
      .optional()
      .describe("upsert: custom metadata object your game reads (replaces the current custom keys). Purchase limits go in purchaseConstraints, not here."),
    purchaseConstraints: purchaseConstraintsSchema.optional().describe("upsert: purchase limits (replaces the current ones). On edit, omitted = keep the current limits."),
    clearPurchaseConstraints: z.boolean().optional().describe("upsert edit: remove all purchase limits."),
    isActive: z.boolean().optional().describe("upsert: on sale. Create defaults to false (created hidden) unless set."),
    disputeOnly: z.boolean().optional().describe("sales: only purchases with a dispute."),
    disputeStatus: z
      .enum(["REQUEST", "IGNORE", "RESOLVED"])
      .optional()
      .describe("sales with disputeOnly: filter by dispute state. dispute: the new state (RESOLVED or IGNORE closes it)."),
    archived: z.boolean().optional().describe("archive: true archives (stops selling, hidden), false restores. Default true."),
    saleId: z.number().int().min(1).optional().describe("dispute: the sale (from sales with disputeOnly)."),
    responseMessage: z.string().min(1).max(2000).optional().describe("dispute: your reply, shown to the buyer."),
    startDate: z.string().min(1).max(40).optional().describe("revenue: ISO 8601 period start (default: all time)."),
    endDate: z.string().min(1).max(40).optional().describe("revenue: ISO 8601 period end."),
    stage: z.enum(["PROD", "PREVIEW"]).optional().describe("revenue: published game (PROD, default) or preview purchases."),
  })
  .strict();

export type VxShopInput = z.infer<typeof vxShopInputSchema>;
export type VxShopResult = { ok: true; action: VxShopInput["action"]; [k: string]: unknown } | OpFail;

export interface VxShopItem {
  id: number;
  verseId: string;
  productId: string;
  name: string;
  price: number;
  stock: number;
  soldCount: number;
  imageUrl: string | null;
  description: string | null;
  metadata: string | null;
  isActive: boolean;
  isArchived: boolean;
  createdAt?: string;
  updatedAt?: string;
}

/** Split the stored metadata string into custom keys and purchase limits. */
export function parseItemMetadata(raw: string | null): { metadata: Record<string, unknown> | null; purchaseConstraints: Record<string, unknown> | null } {
  if (!raw) return { metadata: null, purchaseConstraints: null };
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return { metadata: null, purchaseConstraints: null };
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { metadata: null, purchaseConstraints: null };
  const { purchaseConstraints, ...rest } = obj as Record<string, unknown>;
  return {
    metadata: Object.keys(rest).length > 0 ? rest : null,
    purchaseConstraints:
      purchaseConstraints && typeof purchaseConstraints === "object" ? (purchaseConstraints as Record<string, unknown>) : null,
  };
}

export function presentItem(item: VxShopItem): Record<string, unknown> {
  const { metadata, purchaseConstraints } = parseItemMetadata(item.metadata);
  return { ...item, metadata, purchaseConstraints };
}

async function getWallet(token: string): Promise<{ ok: true; isSeller: boolean; balance: number | null } | OpFail> {
  const r = await v8Request<{ isSeller?: boolean; balance?: number }>("GET", "/v1/vx-wallet", { token });
  if (!r.ok) return apiFail("GET /v1/vx-wallet", r);
  return { ok: true, isSeller: r.data?.isSeller === true, balance: r.data?.balance ?? null };
}

async function listItems(
  verseId: string,
  token: string,
  q: { page: number; limit: number; includeArchived: boolean },
): Promise<{ ok: true; items: VxShopItem[]; total: number } | OpFail> {
  const r = await v8Request<{ items: VxShopItem[]; total: number }>("GET", "/v1/vx-shop-items", {
    token,
    query: { verseId, page: q.page, limit: q.limit, includeArchived: q.includeArchived ? "true" : "false" },
  });
  if (!r.ok) return apiFail("GET /v1/vx-shop-items", r);
  return { ok: true, items: r.data?.items ?? [], total: Number(r.data?.total ?? 0) };
}

/** There is no owner GET for one item; page through the list (archived included). */
export async function findItem(verseId: string, token: string, itemId: number): Promise<{ ok: true; item: VxShopItem } | OpFail> {
  for (let page = 1; page <= 20; page++) {
    const r = await listItems(verseId, token, { page, limit: 100, includeArchived: true });
    if (!r.ok) return r;
    const hit = r.items.find((i) => i.id === itemId);
    if (hit) return { ok: true, item: hit };
    if (r.items.length < 100) break;
  }
  return opFail("not_found", `No VX Shop item ${itemId} in ${verseId} (see action list).`);
}

const NOT_SELLER =
  "This account is not an approved VX seller (GET /v1/vx-wallet isSeller=false). The web creator page hides the VX Shop until a Verse8 admin approves the seller; items would not be sold. Ask Verse8 for seller approval first.";

export async function runVxShop(input: VxShopInput, serverCwd: string = process.cwd(), host?: ConfirmHost): Promise<VxShopResult> {
  const ctx = resolveVerseContext(input, serverCwd);
  if (!ctx.ok) return ctx as OpFail;
  // The source of this call's token goes into any 401 hint.
  return withRejectedTokenHint(await runVxShopWith(input, ctx, host), ctx.tokenWhere);
}

async function runVxShopWith(input: VxShopInput, ctx: Extract<VerseContext, { ok: true }>, host: ConfirmHost | undefined): Promise<VxShopResult> {
  try {
    if (input.action === "list") {
      const wallet = await getWallet(ctx.token);
      if (!wallet.ok) return wallet;
      const r = await listItems(ctx.verseId, ctx.token, {
        page: input.page ?? 1,
        limit: input.limit ?? 20,
        includeArchived: input.includeArchived === true,
      });
      if (!r.ok) return r;
      return {
        ok: true,
        action: "list",
        verseId: ctx.verseId,
        seller: { isSeller: wallet.isSeller, balance: wallet.balance },
        ...(wallet.isSeller ? {} : { warning: NOT_SELLER }),
        total: r.total,
        items: r.items.map(presentItem),
      };
    }
    if (input.action === "sales") return await runSales(input, ctx.verseId, ctx.token);
    if (input.action === "revenue") return await runRevenue(input, ctx.verseId, ctx.token);
    if (input.action === "archive") return await runArchive(input, ctx.verseId, ctx.token, host);
    if (input.action === "dispute") return await runDispute(input, ctx.verseId, ctx.token);
    return await runUpsert(input, ctx.projectDir, ctx.verseId, ctx.token, host);
  } catch (e) {
    return opFail("upstream_unreachable", safeErrorHint(e));
  }
}

async function runUpsert(input: VxShopInput, projectDir: string, verseId: string, token: string, host: ConfirmHost | undefined, probe?: PlanProbe): Promise<VxShopResult> {
  if (input.imagePath && input.imageUrl) return opFail("invalid_input", "Pass either imagePath or imageUrl, not both.");
  if (input.purchaseConstraints && input.clearPurchaseConstraints) {
    return opFail("invalid_input", "Pass either purchaseConstraints or clearPurchaseConstraints, not both.");
  }
  if (input.metadata && "purchaseConstraints" in input.metadata) {
    return opFail("invalid_input", "Put purchase limits in purchaseConstraints, not in metadata.");
  }
  if (input.imagePath) {
    const check = validateLocalMedia(mediaPath(projectDir, input.imagePath), "image");
    if (!check.ok) return opFail(check.error, `imagePath: ${check.hint}`);
  }
  const wallet = await getWallet(token);
  if (!wallet.ok) return wallet;
  if (!wallet.isSeller) return opFail("not_seller", NOT_SELLER);

  const imageTo = input.imagePath ? `<upload:${input.imagePath}>` : input.imageUrl;
  const warnings: string[] = [];

  if (input.itemId === undefined) {
    // ── create ──
    if (input.clearPurchaseConstraints) return opFail("invalid_input", "clearPurchaseConstraints only applies when editing (itemId).");
    const missing = (["productId", "name", "price", "stock"] as const).filter((k) => input[k] === undefined);
    if (missing.length > 0) return opFail("invalid_input", `Creating an item needs: ${missing.join(", ")}. (stock 0 means out of stock.)`, { missing });
    const avail = await v8Request<{ available: boolean }>("GET", "/v1/vx-shop-items/check-product-id", {
      token,
      query: { verseId, productId: input.productId },
    });
    if (!avail.ok) return apiFail("check-product-id", avail);
    if (avail.data?.available === false) {
      return opFail("product_id_taken", `productId '${input.productId}' is already used in this verse (archived items keep theirs).`);
    }
    const isActive = input.isActive ?? false;
    const body: Record<string, unknown> = {
      verseId,
      productId: input.productId,
      name: input.name,
      price: input.price,
      stock: input.stock,
      isActive,
    };
    if (imageTo !== undefined) body.imageUrl = imageTo;
    if (input.description !== undefined) body.description = input.description;
    if (input.metadata) body.metadata = JSON.stringify(input.metadata);
    if (input.purchaseConstraints) body.purchaseConstraints = input.purchaseConstraints;
    if (isActive) warnings.push(`The item goes on sale immediately at ${input.price} VX.`);
    else warnings.push("Created hidden (isActive: false). Set isActive: true later to sell it.");
    if (input.stock === 0) warnings.push("stock 0: the item shows as out of stock.");
    // Nothing to read for an item that does not exist yet: the body (and image) is the plan.
    const plan: Plan = {
      op: "verse8_vxshop.upsert.create",
      target: { verseId, productId: input.productId },
      body,
      files: input.imagePath ? { imagePath: mediaPath(projectDir, input.imagePath) } : {},
    };
    if (probe) {
      probe.plan = plan;
      return PROBED;
    }
    const again = rereadWith((pr) => runUpsert(input, projectDir, verseId, token, undefined, pr));
    const gate = await planGate(plan, input.planId, { action: "upsert" as const, mode: "create", verseId, body, warnings }, host, again);
    if (!isApproved(gate)) return gate;
    if (input.imagePath) {
      const up = await uploadLocalMedia(mediaPath(projectDir, input.imagePath), token, "image", VX_SHOP_MEDIA_CATEGORY, gate.files.imagePath);
      if (!up.ok) return opFail(up.error, `imagePath: ${up.hint}`);
      body.imageUrl = up.url;
    }
    const r = await v8Request<VxShopItem>("POST", "/v1/vx-shop-items", { token, body });
    if (!r.ok) return apiFail("POST /v1/vx-shop-items", r);
    return { ok: true, action: "upsert", mode: "create", dryRun: false, verseId, item: r.data ? presentItem(r.data) : null, warnings };
  }

  // ── edit ──
  if (input.productId !== undefined) return opFail("invalid_input", "productId cannot be changed after create.");
  const found = await findItem(verseId, token, input.itemId);
  if (!found.ok) return found;
  const cur = found.item;
  const parsed = parseItemMetadata(cur.metadata);
  const constraintsTo = input.clearPurchaseConstraints ? null : input.purchaseConstraints;
  const changes = diff([
    ["name", cur.name, input.name],
    ["price", cur.price, input.price],
    ["stock", cur.stock, input.stock],
    ["imageUrl", cur.imageUrl, imageTo],
    ["description", cur.description, input.description],
    ["isActive", cur.isActive, input.isActive],
    ["metadata", parsed.metadata, input.metadata],
    ["purchaseConstraints", parsed.purchaseConstraints, constraintsTo],
  ]);
  if (changes.length === 0) return opFail("invalid_input", "Nothing to change on this item.");

  const body: Record<string, unknown> = {};
  for (const c of changes) if (c.field !== "metadata" && c.field !== "purchaseConstraints") body[c.field] = c.to;
  if (input.metadata && changes.some((c) => c.field === "metadata")) body.metadata = JSON.stringify(input.metadata);
  // The server deletes the limits whenever purchaseConstraints is absent:
  // send the new ones, or the current ones, unless they are being cleared.
  const keep = input.clearPurchaseConstraints ? null : input.purchaseConstraints ?? parsed.purchaseConstraints;
  if (keep) body.purchaseConstraints = keep;

  const price = changes.find((c) => c.field === "price");
  if (price) warnings.push(`Price changes from ${price.from} to ${price.to} VX for every buyer from now on.`);
  const active = changes.find((c) => c.field === "isActive");
  if (active) warnings.push(active.to ? "The item goes on sale." : "The item stops selling.");
  if (input.clearPurchaseConstraints && parsed.purchaseConstraints) warnings.push("All purchase limits are removed.");
  if (cur.isArchived) warnings.push("This item is archived; editing does not restore it.");
  // The current value of every field asked about; the limits and the
  // archived flag are always read (re-sent / warned about), and so are the
  // name, price, stock and on-sale flag: they decide whether the user is asked to
  // confirm and are what that prompt shows (creatorOps RUN_RULES).
  const state: Record<string, unknown> = {
    purchaseConstraints: parsed.purchaseConstraints,
    stock: cur.stock,
    isArchived: cur.isArchived,
    name: cur.name,
    price: cur.price,
    isActive: cur.isActive,
  };
  const asked: Array<[string, unknown, unknown]> = [
    ["name", input.name, cur.name],
    ["price", input.price, cur.price],
    ["stock", input.stock, cur.stock],
    ["imageUrl", imageTo, cur.imageUrl],
    ["description", input.description, cur.description],
    ["isActive", input.isActive, cur.isActive],
    ["metadata", input.metadata, parsed.metadata],
  ];
  for (const [field, given, now] of asked) if (given !== undefined) state[field] = now ?? null;
  const plan: Plan = {
    op: "verse8_vxshop.upsert.edit",
    target: { verseId, itemId: cur.id },
    body,
    state,
    files: input.imagePath ? { imagePath: mediaPath(projectDir, input.imagePath) } : {},
  };
  if (probe) {
    probe.plan = plan;
    return PROBED;
  }
  const again = rereadWith((pr) => runUpsert(input, projectDir, verseId, token, undefined, pr));
  const gate = await planGate(plan, input.planId, { action: "upsert" as const, mode: "edit", verseId, itemId: cur.id, changes, body, warnings }, host, again);
  if (!isApproved(gate)) return gate;
  if (input.imagePath) {
    const up = await uploadLocalMedia(mediaPath(projectDir, input.imagePath), token, "image", VX_SHOP_MEDIA_CATEGORY, gate.files.imagePath);
    if (!up.ok) return opFail(up.error, `imagePath: ${up.hint}`);
    body.imageUrl = up.url;
  }
  const r = await v8Request<VxShopItem>("PUT", `/v1/vx-shop-items/${cur.id}`, { token, body });
  if (!r.ok) return apiFail(`PUT /v1/vx-shop-items/${cur.id}`, r);
  return { ok: true, action: "upsert", mode: "edit", dryRun: false, verseId, item: r.data ? presentItem(r.data) : null, changes, warnings };
}

/**
 * A sale as the owner needs it: buyer reduced to uid / handle / display
 * name (the API also returns wallet and profile picture), claim payloads
 * left out (they can be large and are about delivery, not the sale).
 */
export function presentSale(s: Record<string, unknown>): Record<string, unknown> {
  const keep = [
    "id", "shopItemId", "quantity", "unitPrice", "totalPrice", "status", "stage", "createdAt", "refundedAt",
    "disputeStatus", "disputeMessage", "disputedAt", "disputeResponseMessage", "disputeResolvedAt", "claimStatus", "claimedAt",
  ];
  const out: Record<string, unknown> = {};
  for (const k of keep) if (s[k] !== undefined) out[k] = s[k];
  const item = s.item as Record<string, unknown> | undefined;
  if (item) out.item = { id: item.id, productId: item.productId, name: item.name };
  const buyer = s.buyer as Record<string, unknown> | undefined;
  if (buyer) out.buyer = { uid: buyer.uid, handle: buyer.handle ?? null, displayName: buyer.displayName ?? null };
  const ext = s.externalDelivery as Record<string, unknown> | undefined;
  if (ext) out.externalDelivery = { status: ext.status, attemptCount: ext.attemptCount, httpStatus: ext.httpStatus ?? null };
  return out;
}

async function runSales(input: VxShopInput, verseId: string, token: string): Promise<VxShopResult> {
  const r = await v8Request<{ sales: Record<string, unknown>[]; total: number; page: number; limit: number }>("GET", "/v1/vx-shop-items/sales", {
    token,
    query: {
      verseId,
      itemId: input.itemId,
      // Any non-empty value filters to disputes server-side, `false` included:
      // send it only when true.
      disputeOnly: input.disputeOnly ? "true" : undefined,
      disputeStatus: input.disputeOnly ? input.disputeStatus : undefined,
      page: input.page ?? 1,
      limit: input.limit ?? 20,
    },
  });
  if (!r.ok) return apiFail("GET /v1/vx-shop-items/sales", r);
  const d = r.data ?? { sales: [], total: 0, page: 1, limit: 20 };
  return { ok: true, action: "sales", verseId, total: Number(d.total), page: Number(d.page), limit: Number(d.limit), sales: (d.sales ?? []).map(presentSale) };
}

async function runRevenue(input: VxShopInput, verseId: string, token: string): Promise<VxShopResult> {
  for (const [k, v] of [["startDate", input.startDate], ["endDate", input.endDate]] as const) {
    if (v !== undefined && !Number.isFinite(Date.parse(v))) return opFail("invalid_input", `${k} must be an ISO 8601 date.`);
  }
  const r = await v8Request<Record<string, unknown>>("GET", "/v1/vx-shop-items/revenue-stats", {
    token,
    query: { verseId, startDate: input.startDate, endDate: input.endDate, stage: input.stage ?? "PROD" },
  });
  if (!r.ok) return apiFail("GET /v1/vx-shop-items/revenue-stats", r);
  return { ok: true, action: "revenue", verseId, stage: input.stage ?? "PROD", ...(r.data ?? {}) };
}

async function runArchive(input: VxShopInput, verseId: string, token: string, host: ConfirmHost | undefined, probe?: PlanProbe): Promise<VxShopResult> {
  if (input.itemId === undefined) return opFail("invalid_input", "archive needs itemId (see action list).");
  const found = await findItem(verseId, token, input.itemId);
  if (!found.ok) return found;
  const cur = found.item;
  const want = input.archived ?? true;
  // Same trap as upsert: without purchaseConstraints the server deletes them.
  const { purchaseConstraints } = parseItemMetadata(cur.metadata);
  const body: Record<string, unknown> = { isArchived: want };
  if (purchaseConstraints) body.purchaseConstraints = purchaseConstraints;
  const plan: Plan = {
    op: "verse8_vxshop.archive",
    target: { verseId, itemId: cur.id },
    body,
    // name and price are what the confirmation of a restore-to-sale shows.
    // name, price, stock and the limits are what the confirmation of a
    // restore-to-sale shows and what decides whether it is one.
    state: { isArchived: cur.isArchived, isActive: cur.isActive, name: cur.name, price: cur.price, stock: cur.stock, purchaseConstraints },
  };
  if (cur.isArchived === want) {
    // A preview never hands out a planId for this state, so a given one is stale.
    const stale = input.planId === undefined ? null : checkPlan(plan, input.planId);
    if (stale && !isApproved(stale)) return stale;
    return { ok: true, action: "archive", dryRun: input.planId === undefined, verseId, itemId: cur.id, archived: want, unchanged: true };
  }
  const warnings = want
    ? ["Archived items are not sold and are hidden from buyers; restore brings them back. Its productId stays reserved."]
    : [`Restored. It sells again only if isActive is true (now ${cur.isActive}).`];
  if (probe) {
    probe.plan = plan;
    return PROBED;
  }
  const again = rereadWith((pr) => runArchive(input, verseId, token, undefined, pr));
  const gate = await planGate(plan, input.planId, {
    action: "archive" as const,
    verseId,
    itemId: cur.id,
    changes: [{ field: "isArchived", from: cur.isArchived, to: want }],
    body,
    warnings,
  }, host, again);
  if (!isApproved(gate)) return gate;
  const r = await v8Request<VxShopItem>("PUT", `/v1/vx-shop-items/${cur.id}`, { token, body });
  if (!r.ok) return apiFail(`PUT /v1/vx-shop-items/${cur.id}`, r);
  return { ok: true, action: "archive", dryRun: false, verseId, item: r.data ? presentItem(r.data) : null, warnings };
}

async function findDisputedSale(verseId: string, token: string, saleId: number): Promise<{ ok: true; sale: Record<string, unknown> | null } | OpFail> {
  for (let page = 1; page <= 20; page++) {
    const r = await v8Request<{ sales: Record<string, unknown>[] }>("GET", "/v1/vx-shop-items/sales", {
      token,
      query: { verseId, disputeOnly: "true", page, limit: 100 },
    });
    if (!r.ok) return apiFail("GET /v1/vx-shop-items/sales", r);
    const sales = r.data?.sales ?? [];
    const hit = sales.find((s) => s.id === saleId);
    if (hit) return { ok: true, sale: hit };
    if (sales.length < 100) break;
  }
  return { ok: true, sale: null };
}

async function runDispute(input: VxShopInput, verseId: string, token: string): Promise<VxShopResult> {
  if (input.saleId === undefined || input.disputeStatus === undefined) {
    return opFail("invalid_input", "dispute needs saleId and disputeStatus (see action sales with disputeOnly).");
  }
  const found = await findDisputedSale(verseId, token, input.saleId);
  if (!found.ok) return found;
  if (!found.sale) return opFail("not_found", `Sale ${input.saleId} has no dispute in ${verseId}.`);
  const sale = presentSale(found.sale);
  const body: Record<string, unknown> = { status: input.disputeStatus };
  if (input.responseMessage) body.responseMessage = input.responseMessage;
  const warnings = [
    "The buyer gets an in-app notification of this answer.",
    "Resolving a dispute does not refund the VX (refunds are not available from this tool).",
  ];
  const plan: Plan = {
    op: "verse8_vxshop.dispute",
    target: { verseId, saleId: input.saleId },
    body,
    state: {
      disputeStatus: sale.disputeStatus ?? null,
      disputeMessage: sale.disputeMessage ?? null,
      disputeResponseMessage: sale.disputeResponseMessage ?? null,
    },
  };
  const gate = await planGate(plan, input.planId, {
    action: "dispute" as const,
    verseId,
    sale,
    changes: [{ field: "disputeStatus", from: sale.disputeStatus ?? null, to: input.disputeStatus }],
    body,
    warnings,
  });
  if (!isApproved(gate)) return gate;
  const r = await v8Request<{ success: boolean }>("PUT", `/v1/vx-shop-items/sales/${input.saleId}/dispute`, { token, body });
  if (!r.ok) return apiFail(`PUT sales/${input.saleId}/dispute`, r);
  return { ok: true, action: "dispute", dryRun: false, verseId, saleId: input.saleId, disputeStatus: input.disputeStatus, warnings };
}
