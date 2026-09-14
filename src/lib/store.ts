import { readFileSync, writeFileSync, existsSync, appendFileSync, renameSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { ROOTS } from "./paths.ts";
import { assertCents } from "./money.ts";

const ACCOUNT_PATH = join(ROOTS.data, "fsa-account.json");
const CLAIMS_INDEX_PATH = join(ROOTS.data, "claims-index.json");
const LEDGER_PATH = join(ROOTS.data, "ledger.jsonl");

export interface Account {
  accountHolder: string;
  planYear: number;
  annualElection: number;
  remainingBalance: number; // dollars — derived cache; the ledger is authoritative
  startingBalance?: number; // dollars at demo reset; remaining = starting - sum(ledger)
  spendDeadline: string;
  claimFilingDeadline: string;
  note?: string;
}

export function readAccount(): Account {
  return JSON.parse(readFileSync(ACCOUNT_PATH, "utf8"));
}

interface LedgerEntry { txnId: string; cents: number; ts: string }

export function readLedger(): LedgerEntry[] {
  if (!existsSync(LEDGER_PATH)) return [];
  return readFileSync(LEDGER_PATH, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

export function ledgerHas(txnId: string): boolean {
  return readLedger().some((e) => e.txnId === txnId);
}

// Test-only injection point for write-failure recovery tests.
let injectedFailure: "ledger" | "balance" | null = null;
export function __injectWriteFailure(kind: "ledger" | "balance" | null): void {
  injectedFailure = kind;
}

/**
 * Exactly-once debit. The append-only ledger is the source of truth; the
 * account's remainingBalance is recomputed from starting - sum(ledger) and
 * written atomically. Calling again with the same txnId never appends twice,
 * and a crash between append and balance write is healed on retry because
 * the balance is derived, not incremented.
 */
export function debitAccount(cents: number, txnId: string): Account {
  assertCents(cents, "debit");
  if (!ledgerHas(txnId)) {
    if (injectedFailure === "ledger") { injectedFailure = null; throw new Error("injected ledger write failure"); }
    appendFileSync(LEDGER_PATH, JSON.stringify({ txnId, cents, ts: new Date().toISOString() }) + "\n");
  }
  if (injectedFailure === "balance") { injectedFailure = null; throw new Error("injected balance write failure"); }
  const account = readAccount();
  const startingCents = Math.round((account.startingBalance ?? account.remainingBalance) * 100);
  const spentCents = readLedger().reduce((s, e) => s + e.cents, 0);
  const remainingCents = startingCents - spentCents;
  if (remainingCents < 0) throw new Error("Ledger exceeds starting balance");
  account.startingBalance = startingCents / 100;
  account.remainingBalance = remainingCents / 100;
  const tmp = ACCOUNT_PATH + ".tmp";
  writeFileSync(tmp, JSON.stringify(account, null, 2) + "\n");
  renameSync(tmp, ACCOUNT_PATH);
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
