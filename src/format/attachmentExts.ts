/**
 * Local copy of agent8-backend's ATTACHMENT_EXTS allowlist. Kept in sync
 * manually with planetarium/agent8-backend/src/config/constants.ts — invariant
 * MCP-UP-3 requires both to stay equal.
 */

export const ATTACHMENT_EXTS = [
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".svg",
  ".webp",
  ".glb",
  ".gltf",
  ".vrm",
  ".mp3",
  ".wav",
  ".ogg",
  ".m4a",
  ".mp4",
  ".webm",
  ".mov",
  ".ttf",
  ".otf",
  ".woff",
  ".woff2",
  ".txt",
  ".md",
  ".json",
  ".csv",
  ".xml",
] as const;

export type AttachmentExt = (typeof ATTACHMENT_EXTS)[number];

export function extractExt(filename: string): string {
  const lower = filename.toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot < 0 || dot === lower.length - 1) return "";
  return lower.slice(dot);
}

export function isAllowedAttachmentExt(filename: string): boolean {
  const ext = extractExt(filename);
  return (ATTACHMENT_EXTS as readonly string[]).includes(ext);
}

const CONTENT_TYPES: Readonly<Record<string, string>> = Object.freeze({
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".vrm": "model/gltf-binary",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".csv": "text/csv",
  ".xml": "application/xml",
});

export function detectContentType(filename: string): string {
  const ext = extractExt(filename);
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}
