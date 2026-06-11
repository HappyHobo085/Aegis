// Type declarations for the plain-ESM extraLists.mjs (shared by engine.ts and
// scripts/generate-seed.mjs). Keeps a single runtime source of truth (.mjs)
// while giving TS the exported shape.
export const EXTRA_LIST_URLS: { listId: string; url: string }[];
