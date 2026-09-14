import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { ROOTS } from "./paths.ts";
import type { Extraction } from "./schemas.ts";

/**
 * Persisted pipeline records: the code-owned chain of custody for every
 * document. Each stage writes its result here and the next stage LOADS it —
 * monetary values, identities, and statuses never round-trip through the
 * model between stages.
 */
const RECORDS_DIR = join(ROOTS.data, "records");

export interface ClassifiedLine {
  description: string;
  amountCents: number;
  category: string;
  ruling: "eligible" | "ineligible" | "needs_lmn" | "needs_review";
  reason: string;
}

export interface DocRecord {
  docId: string; // sha256 of file bytes (first 16 hex), computed in code
  file: string;
  extraction?: Extraction & { storedAt: string };
  /** Prior extraction attempts that failed the reconciliation precheck. */
  extractionAttempts?: (Extraction & { storedAt: string; discrepancy: string })[];
  classification?: {
    status: "eligible" | "mixed" | "needs_lmn" | "ineligible" | "needs_review";
    claimableCents: number;
    lines: ClassifiedLine[];
    reason: string | null;
    storedAt: string;
  };
  match?: {
    fileable: boolean;
    status: string;
    fingerprint: string | null;
    fileCents: number;
    reason: string | null;
    storedAt: string;
  };
  packet?: {
    packetId: string;
    dir: string;
    amountCents: number;
    status: "awaiting_approval" | "approving" | "approved" | "declined";
    txnId?: string;
    storedAt: string;
    approvedAt?: string;
  };
}

export function docIdForBytes(bytes: Buffer | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 16);
}

function recordPath(docId: string): string {
  if (!/^[0-9a-f]{16}$/.test(docId)) throw new Error(`Invalid docId: ${docId}`);
  return join(RECORDS_DIR, `${docId}.json`);
}

export function loadRecord(docId: string): DocRecord | null {
  const p = recordPath(docId);
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as DocRecord) : null;
}

/** Atomic write: temp file + rename. */
export function saveRecord(record: DocRecord): void {
  mkdirSync(RECORDS_DIR, { recursive: true });
  const p = recordPath(record.docId);
  const tmp = p + ".tmp";
  writeFileSync(tmp, JSON.stringify(record, null, 2) + "\n");
  renameSync(tmp, p);
}

export function listRecords(): DocRecord[] {
  if (!existsSync(RECORDS_DIR)) return [];
  return readdirSync(RECORDS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(RECORDS_DIR, f), "utf8")) as DocRecord);
}

/**
 * Serialize competing approval processes. mkdir is atomic on POSIX: exactly
 * one caller can create the lock directory at a time.
 */
const LOCK_DIR = join(ROOTS.data, ".approval-lock");
export function withApprovalLock<T>(fn: () => T): T {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      mkdirSync(LOCK_DIR);
      break;
    } catch {
      if (Date.now() > deadline) throw new Error("Could not acquire approval lock");
      // busy-wait a beat; approvals are rare and human-paced
      const until = Date.now() + 50;
      while (Date.now() < until) {/* spin */}
    }
  }
  try {
    return fn();
  } finally {
    rmdirSync(LOCK_DIR);
  }
}
