import { z } from "zod";
import { v8Request } from "../api/v8MemeApi.js";
import { VX_SHOP_MEDIA_CATEGORY } from "../api/verse8Web.js";
import { safeErrorHint } from "../util/redact.js";
import { CONFIRM_NEXT, apiFail, diff, mediaPath, opFail, type OpFail } from "./creatorOps.js";
import { uploadLocalMedia, validateLocalMedia } from "./uploadThumbnail.js";
import { projectDirField, resolveVerseContext, verseIdField } from "./verseContext.js";

/**
 * `verse8_vxshop` — the creator page's VX Shop tab: seller status, item
 * list, create / edit items. Changing actions preview by default and run
 * only with `confirm: true`.
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

const ACTIONS = ["list", "upsert"] as const;

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
      .describe("list: seller status + items (with parsed purchase limits). upsert: create an item (no itemId) or edit one (itemId) — preview unless confirm."),
    projectDir: projectDirField,
    verseId: verseIdField,
    confirm: z
      .boolean()
      .default(false)
      .describe("upsert only runs with true. Without it, it returns the planned body / `changes` and changes nothing — show them to the user first."),
    includeArchived: z.boolean().optional().describe("list: include archived items."),
    page: z.number().int().min(1).optional().describe("list: page (default 1)."),
    limit: z.number().int().min(1).max(100).optional().describe("list: page size (default 20)."),
    itemId: z.number().int().min(1).optional().describe("upsert: the item to edit (from list). Omit to create."),
    productId: z.string().min(1).max(100).optional().describe("upsert create: product id the game's code buys with (unique per verse, cannot be changed later)."),
    name: z.string().min(1).max(255).optional().describe("upsert: display name."),
    price: z.number().int().min(0).optional().describe("upsert: price in VX (integer)."),
    stock: z.number().int().min(0).optional().describe("upsert: units available; 0 = out of stock. Required on create."),
    description: z.string().max(5000).optional().describe("upsert: item description."),
    imagePath: z.string().min(1).optional().describe("upsert: local item image (png/jpg/gif/webp ≤4 MB), uploaded on confirm."),
    imageUrl: z.string().url().max(500).optional().describe("upsert: already-hosted image URL."),
    metadata: z
      .record(z.unknown())
      .optional()
      .describe("upsert: custom metadata object your game reads (replaces the current custom keys). Purchase limits go in purchaseConstraints, not here."),
    purchaseConstraints: purchaseConstraintsSchema.optional().describe("upsert: purchase limits (replaces the current ones). On edit, omitted = keep the current limits."),
    clearPurchaseConstraints: z.boolean().optional().describe("upsert edit: remove all purchase limits."),
    isActive: z.boolean().optional().describe("upsert: on sale. Create defaults to false (created hidden) unless set."),
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

export async function runVxShop(input: VxShopInput, serverCwd: string = process.cwd()): Promise<VxShopResult> {
  const ctx = resolveVerseContext(input, serverCwd);
  if (!ctx.ok) return ctx as OpFail;
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
    return await runUpsert(input, ctx.projectDir, ctx.verseId, ctx.token);
  } catch (e) {
    return opFail("upstream_unreachable", safeErrorHint(e));
  }
}

async function runUpsert(input: VxShopInput, projectDir: string, verseId: string, token: string): Promise<VxShopResult> {
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
    if (!input.confirm) return { ok: true, action: "upsert", mode: "create", dryRun: true, verseId, body, warnings, next: CONFIRM_NEXT };
    if (input.imagePath) {
      const up = await uploadLocalMedia(mediaPath(projectDir, input.imagePath), token, "image", VX_SHOP_MEDIA_CATEGORY);
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
  if (!input.confirm) {
    return { ok: true, action: "upsert", mode: "edit", dryRun: true, verseId, itemId: cur.id, changes, body, warnings, next: CONFIRM_NEXT };
  }
  if (input.imagePath) {
    const up = await uploadLocalMedia(mediaPath(projectDir, input.imagePath), token, "image", VX_SHOP_MEDIA_CATEGORY);
    if (!up.ok) return opFail(up.error, `imagePath: ${up.hint}`);
    body.imageUrl = up.url;
  }
  const r = await v8Request<VxShopItem>("PUT", `/v1/vx-shop-items/${cur.id}`, { token, body });
  if (!r.ok) return apiFail(`PUT /v1/vx-shop-items/${cur.id}`, r);
  return { ok: true, action: "upsert", mode: "edit", dryRun: false, verseId, item: r.data ? presentItem(r.data) : null, changes, warnings };
}
