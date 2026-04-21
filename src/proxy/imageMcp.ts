/**
 * BACK-COMPAT SHIM (M1b-4) — `imageMcp.ts` was the original filename when the
 * proxy only handled the image service. The module is now a generic
 * multi-service forwarder, so the canonical home is `proxy/forward.ts`.
 *
 * This shim keeps the historic import path working for ONE release. To be
 * removed in 0.5.0 — every internal caller in this repo has already been
 * migrated to `../proxy/forward.js`.
 */
export * from "./forward.js";
