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
  [fingerprint: string]: { file: string; status: string; ts: string };
}

export function readClaimsIndex(): ClaimsIndex {
  if (!existsSync(CLAIMS_INDEX_PATH)) return {};
  return JSON.parse(readFileSync(CLAIMS_INDEX_PATH, "utf8"));
}

export function recordClaim(fingerprint: string, file: string, status: string): void {
  const index = readClaimsIndex();
  index[fingerprint] = { file, status, ts: new Date().toISOString() };
  writeFileSync(CLAIMS_INDEX_PATH, JSON.stringify(index, null, 2) + "\n");
}

/**
 * Duplicate-proofing fingerprint: same patient + provider + service date +
 * amount is the same claim, whatever the filename says.
 */
export function claimFingerprint(patient: string, provider: string, dateOfService: string, amountCents: number): string {
  const norm = (s: string) => s.toLowerCase().normalize("NFKC").replace(/\s+/g, " ").trim();
  return createHash("sha256")
    .update([norm(patient), norm(provider), dateOfService, String(amountCents)].join("|"))
    .digest("hex");
}
