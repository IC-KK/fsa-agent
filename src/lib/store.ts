import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { ROOTS } from "./paths.ts";
import { assertCents } from "./money.ts";

const ACCOUNT_PATH = join(ROOTS.data, "fsa-account.json");
const CLAIMS_INDEX_PATH = join(ROOTS.data, "claims-index.json");

export interface Account {
  accountHolder: string;
  planYear: number;
  annualElection: number;
  remainingBalance: number; // dollars in the human-readable file
  spendDeadline: string;
  claimFilingDeadline: string;
  note?: string;
}

export function readAccount(): Account {
  return JSON.parse(readFileSync(ACCOUNT_PATH, "utf8"));
}

export function debitAccount(cents: number): Account {
  assertCents(cents, "debit");
  const account = readAccount();
  const remainingCents = Math.round(account.remainingBalance * 100) - cents;
  if (remainingCents < 0) throw new Error("Debit exceeds remaining balance");
  account.remainingBalance = remainingCents / 100;
  writeFileSync(ACCOUNT_PATH, JSON.stringify(account, null, 2) + "\n");
  return account;
}

interface ClaimsIndex {
  // fingerprint -> record of the claim we already know about
  [fingerprint: string]: { file: string; status: string; ts: string; docId?: string };
}

export function readClaimsIndex(): ClaimsIndex {
  if (!existsSync(CLAIMS_INDEX_PATH)) return {};
  return JSON.parse(readFileSync(CLAIMS_INDEX_PATH, "utf8"));
}

export function recordClaim(fingerprint: string, file: string, status: string, docId?: string): void {
  const index = readClaimsIndex();
  index[fingerprint] = { file, status, ts: new Date().toISOString(), docId };
  writeFileSync(CLAIMS_INDEX_PATH, JSON.stringify(index, null, 2) + "\n");
}

/**
 * Canonicalize a party name for fingerprinting. Missing values in any
 * representation (null, "", "unknown", "n/a") collapse to one sentinel —
 * we never invent an identity, and representation changes cannot alter
 * the fingerprint.
 */
export function canonicalParty(value: string | null | undefined): string {
  const v = (value ?? "").toLowerCase().normalize("NFKC").replace(/\s+/g, " ").trim();
  return v === "" || v === "unknown" || v === "n/a" || v === "none" ? "(unknown)" : v;
}

/**
 * Duplicate-proofing fingerprint: same patient + provider + service date +
 * amount is the same claim, whatever the filename says. A match flags a
 * POSSIBLE duplicate — metadata equality does not prove two receipts are
 * the same physical document.
 */
export function claimFingerprint(patient: string | null, provider: string | null, dateOfService: string, amountCents: number): string {
  return createHash("sha256")
    .update([canonicalParty(patient), canonicalParty(provider), dateOfService, String(amountCents)].join("|"))
    .digest("hex");
}
