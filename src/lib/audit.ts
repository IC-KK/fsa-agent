import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ROOTS } from "./paths.ts";

// Append-only diary of every decision. One JSON line per event.
const AUDIT_PATH = join(ROOTS.data, "audit.jsonl");

export function audit(event: string, detail: Record<string, unknown>): void {
  mkdirSync(ROOTS.data, { recursive: true });
  const line = JSON.stringify({ ts: new Date().toISOString(), event, ...detail });
  appendFileSync(AUDIT_PATH, line + "\n");
}
