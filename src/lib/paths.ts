import { resolve, sep } from "node:path";
import { realpathSync, existsSync } from "node:fs";

// Tools may only touch these four folders. Anything else is refused.
const PROJECT_ROOT = resolve(import.meta.dirname, "..", "..");
export const ROOTS = {
  inbox: resolve(PROJECT_ROOT, "receipts-inbox"),
  fixtures: resolve(PROJECT_ROOT, "fixtures"),
  outbox: resolve(PROJECT_ROOT, "claims-outbox"),
  data: resolve(PROJECT_ROOT, "data"),
} as const;

export type RootName = keyof typeof ROOTS;

export class PathViolationError extends Error {}

/**
 * Resolve a caller-supplied path and verify it stays inside one of the
 * allowlisted roots. Follows symlinks so a link pointing outside is refused.
 */
export function safeResolve(candidate: string, allowed: RootName[] = ["inbox", "fixtures", "outbox", "data"]): string {
  const abs = resolve(PROJECT_ROOT, candidate);
  const real = existsSync(abs) ? realpathSync(abs) : abs;
  for (const name of allowed) {
    const root = ROOTS[name];
    if (real === root || real.startsWith(root + sep)) return real;
  }
  throw new PathViolationError(`Path outside allowed folders: ${candidate}`);
}
