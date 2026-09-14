import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, rmSync, existsSync, readFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolContext } from "@strands-agents/sdk";
import { classifyEligibility, matchAccount, submitPacket, buildPacket } from "../src/tools.ts";
import { safeResolve, PathViolationError, ROOTS } from "../src/lib/paths.ts";
import { claimFingerprint, recordClaim } from "../src/lib/store.ts";
import { saveRecord, loadRecord, type DocRecord } from "../src/lib/records.ts";
import type { Extraction } from "../src/lib/schemas.ts";

// Every test here runs with ZERO model calls. This is the quality gate.
// Extraction records are seeded directly: extraction is the trust boundary,
// and these tests prove integrity AFTER extraction — not that the model read
// the receipt correctly.

const ACCOUNT_PATH = join(ROOTS.data, "fsa-account.json");
const FRESH_ACCOUNT = {
  accountHolder: "Sample User",
  planYear: 2026,
  annualElection: 2000.0,
  remainingBalance: 280.0,
  startingBalance: 280.0,
  spendDeadline: "2026-12-31",
  claimFilingDeadline: "2027-03-31",
};

function resetState(): void {
  writeFileSync(ACCOUNT_PATH, JSON.stringify(FRESH_ACCOUNT, null, 2) + "\n");
  for (const f of ["claims-index.json", "processed-files.json", "ledger.jsonl"]) {
    if (existsSync(join(ROOTS.data, f))) rmSync(join(ROOTS.data, f));
  }
  rmSync(join(ROOTS.data, "records"), { recursive: true, force: true });
  rmSync(join(ROOTS.data, ".approval-lock"), { recursive: true, force: true });
  rmSync(join(ROOTS.outbox, "packets"), { recursive: true, force: true });
  rmSync(join(ROOTS.outbox, "cards"), { recursive: true, force: true });
}
before(resetState);
beforeEach(resetState);
after(resetState);

function balance(): number {
  return JSON.parse(readFileSync(ACCOUNT_PATH, "utf8")).remainingBalance;
}

const baseExtraction = (over: Partial<Extraction>): Extraction & { storedAt: string } => {
  const merged = {
    readable: true, docType: "receipt" as const, patient: "Jordan Sample", provider: "Test Provider",
    dateOfService: "2026-06-12", lineItems: [] as Extraction["lineItems"], totalCents: null as number | null,
    taxCents: null, shippingCents: null, discountCents: null,
    patientResponsibilityCents: null, confidence: 0.95, suspiciousContent: null,
    storedAt: new Date().toISOString(), ...over,
  };
  // Unless a test says otherwise, seeds reconcile: total = net lines + tax + shipping.
  if (merged.totalCents === null && !("totalCents" in over) && merged.docType !== "eob") {
    merged.totalCents =
      merged.lineItems.reduce((s, l) => s + l.amountCents, 0) + (merged.taxCents ?? 0) + (merged.shippingCents ?? 0);
  }
  return merged;
};

function seed(docId: string, file: string, extraction: Partial<Extraction>): DocRecord {
  const record: DocRecord = { docId, file, extraction: baseExtraction(extraction) };
  saveRecord(record);
  return record;
}

const approving = { interrupt: () => true } as unknown as ToolContext;
const denying = { interrupt: () => false } as unknown as ToolContext;

/** Seed + run the full deterministic pipeline for a fileable dental claim. */
async function seededDentalPacket(docId = "aaaaaaaaaaaaaaaa") {
  seed(docId, "01_bright_smile_dental_jun12.pdf", {
    docType: "invoice", provider: "Bright Smile Dental Group",
    lineItems: [{ description: "Composite filling, one surface", amountCents: 18000, category: "dental" }],
  });
  copyFileSync(join(ROOTS.fixtures, "01_bright_smile_dental_jun12.pdf"), join(ROOTS.inbox, "01_bright_smile_dental_jun12.pdf"));
  await classifyEligibility.invoke({ docId });
  const m = await matchAccount.invoke({ docId });
  assert.equal(m.fileable, true);
  return buildPacket.invoke({ docId });
}

// ---------------- original coverage, record-flow ----------------

test("mixed cart: splits eligible from ineligible to the cent", async () => {
  seed("b000000000000002", "02.png", {
    provider: "Maple Pharmacy #218", dateOfService: "2026-08-03",
    lineItems: [
      { description: "RX #7742210 CETIRIZINE 10MG", amountCents: 2400, category: "prescriptions" },
      { description: "SUNSCREEN SPF50 6OZ", amountCents: 1050, category: "medical-equipment" },
      { description: "CHOC CARAMEL BAG 11OZ", amountCents: 1125, category: "food-grocery" },
    ],
  });
  const r = await classifyEligibility.invoke({ docId: "b000000000000002" });
  assert.equal(r.status, "mixed");
  assert.equal(r.claimableCents, 3450);
});

test("EOB: claims patient responsibility, never the billed total", async () => {
  seed("b000000000000003", "03.pdf", {
    docType: "eob", patientResponsibilityCents: 6500, dateOfService: "2026-07-09",
    lineItems: [
      { description: "Comprehensive metabolic panel (80053)", amountCents: 21200, category: "lab-diagnostics" },
      { description: "Lipid panel (80061)", amountCents: 19800, category: "lab-diagnostics" },
    ],
  });
  const r = await classifyEligibility.invoke({ docId: "b000000000000003" });
  assert.equal(r.claimableCents, 6500);
});

test("laundering attack: model-claimed category cannot make candy a prescription", async () => {
  seed("b000000000000009", "attack.png", {
    lineItems: [
      { description: "CHOC CARAMEL BAG 11OZ", amountCents: 1125, category: "prescriptions" },
      { description: "MEGA PROTEIN POWDER 2LB", amountCents: 4500, category: "prescriptions" },
    ],
  });
  const r = await classifyEligibility.invoke({ docId: "b000000000000009" });
  assert.equal(r.claimableCents, 0);
  assert.ok(r.lines.every((l) => l.ruling === "ineligible"));
});

test("unknown item fails closed to needs_review, whatever the model says", async () => {
  seed("b00000000000000a", "mystery.png", {
    lineItems: [{ description: "XQ-9 QUANTUM DEVICE", amountCents: 99900, category: "prescriptions" }],
  });
  const r = await classifyEligibility.invoke({ docId: "b00000000000000a" });
  assert.equal(r.status, "needs_review");
  assert.equal(r.claimableCents, 0);
});

test("low extraction confidence fails closed", async () => {
  seed("b00000000000000b", "blurry.jpg", { readable: false, confidence: 0.2 });
  const r = await classifyEligibility.invoke({ docId: "b00000000000000b" });
  assert.equal(r.status, "needs_review");
});

test("prior-year receipt never files", async () => {
  seed("b00000000000000c", "vision.pdf", {
    dateOfService: "2025-11-08",
    lineItems: [{ description: "Prescription lenses, single vision", amountCents: 14500, category: "vision" }],
  });
  await classifyEligibility.invoke({ docId: "b00000000000000c" });
  const r = await matchAccount.invoke({ docId: "b00000000000000c" });
  assert.equal(r.fileable, false);
  assert.equal(r.status, "rejected_prior_year");
});

test("duplicate fingerprint never files twice", async () => {
  const fp = claimFingerprint("Jordan Sample", "Bright Smile Dental Group", "2026-06-12", 18000);
  recordClaim(fp, "original.pdf", "submitted");
  seed("b00000000000000d", "copy.pdf", {
    provider: "Bright Smile Dental Group",
    lineItems: [{ description: "Composite filling, one surface", amountCents: 18000, category: "dental" }],
  });
  await classifyEligibility.invoke({ docId: "b00000000000000d" });
  const r = await matchAccount.invoke({ docId: "b00000000000000d" });
  assert.equal(r.fileable, false);
  assert.equal(r.status, "possible_duplicate");
  assert.match(String(r.reason), /does not prove/);
});

test("fingerprint survives filename, case, and unicode-spacing tricks", () => {
  const a = claimFingerprint("Jordan Sample", "Bright Smile Dental Group", "2026-06-12", 18000);
  const b = claimFingerprint("jordan  sample", "BRIGHT SMILE　DENTAL GROUP", "2026-06-12", 18000);
  assert.equal(a, b);
});

test("balance cap: cannot file more than remaining balance", async () => {
  seed("b00000000000000e", "big.pdf", {
    lineItems: [{ description: "Orthodontics treatment", amountCents: 999900, category: "dental" }],
  });
  await classifyEligibility.invoke({ docId: "b00000000000000e" });
  const r = await matchAccount.invoke({ docId: "b00000000000000e" });
  assert.equal(r.fileable, true);
  assert.equal(r.fileCents, 28000);
});

test("paths outside the four allowed folders are refused", () => {
  assert.throws(() => safeResolve("../../.aws/credentials"), PathViolationError);
  assert.throws(() => safeResolve("/etc/passwd"), PathViolationError);
  assert.throws(() => safeResolve("src/agent.ts"), PathViolationError);
  assert.ok(safeResolve("receipts-inbox/receipt.pdf", ["inbox"]));
});

// ---------------- EOB + reconciliation regressions ----------------

test("EOB with only unknown lines yields zero, not the responsibility amount", async () => {
  seed("d000000000000001", "eob1.pdf", {
    docType: "eob", patientResponsibilityCents: 6500,
    lineItems: [{ description: "MISC SVC CODE 99999", amountCents: 21200, category: "lab-diagnostics" }],
  });
  const r = await classifyEligibility.invoke({ docId: "d000000000000001" });
  assert.equal(r.claimableCents, 0);
  assert.equal(r.status, "needs_review");
});

test("EOB with only ineligible lines yields zero, not the responsibility amount", async () => {
  seed("d000000000000002", "eob2.pdf", {
    docType: "eob", patientResponsibilityCents: 6500,
    lineItems: [{ description: "Teeth whitening, cosmetic", amountCents: 21200, category: "cosmetic" }],
  });
  const r = await classifyEligibility.invoke({ docId: "d000000000000002" });
  assert.equal(r.claimableCents, 0);
  assert.equal(r.status, "ineligible");
});

test("eligible EOB is capped at patient responsibility; missing responsibility requires review", async () => {
  seed("d000000000000003", "eob3.pdf", {
    docType: "eob", patientResponsibilityCents: 6500,
    lineItems: [{ description: "Comprehensive metabolic panel lab test", amountCents: 41000, category: "lab-diagnostics" }],
  });
  const capped = await classifyEligibility.invoke({ docId: "d000000000000003" });
  assert.equal(capped.claimableCents, 6500);
  seed("d000000000000004", "eob4.pdf", {
    docType: "eob", patientResponsibilityCents: null,
    lineItems: [{ description: "Lipid panel lab test", amountCents: 19800, category: "lab-diagnostics" }],
  });
  const missing = await classifyEligibility.invoke({ docId: "d000000000000004" });
  assert.equal(missing.status, "needs_review");
  assert.equal(missing.claimableCents, 0);
});

test("CVS paper receipt arithmetic reconciles: 649+169+100 net lines + 52 tax = 970 total", async () => {
  seed("d000000000000005", "cvs.jpg", {
    provider: "CVS Pharmacy", dateOfService: "2026-09-14",
    lineItems: [
      { description: "AQUA LIP SPF30 .35Z", amountCents: 649, category: "medical-equipment" },
      { description: "TRDNT SNGL MNTB 14CT", amountCents: 169, category: "food-grocery" },
      { description: "TRDNT SNGL ORIG 14CT", amountCents: 100, category: "food-grocery" },
    ],
    taxCents: 52, discountCents: 69, totalCents: 970,
  });
  const r = await classifyEligibility.invoke({ docId: "d000000000000005" });
  assert.notEqual(r.status, "needs_review");
  assert.equal(r.claimableCents, 649);
});

test("the observed wrong gum extraction ($1.63) fails reconciliation and requires review", async () => {
  seed("d000000000000006", "cvs-bad.jpg", {
    provider: "CVS Pharmacy", dateOfService: "2026-09-14",
    lineItems: [
      { description: "AQUA LIP SPF30 .35Z", amountCents: 649, category: "medical-equipment" },
      { description: "TRDNT GUM", amountCents: 163, category: "food-grocery" },
      { description: "TRDNT GUM 2", amountCents: 100, category: "food-grocery" },
    ],
    taxCents: 52, totalCents: 970,
  });
  const r = await classifyEligibility.invoke({ docId: "d000000000000006" });
  assert.equal(r.status, "needs_review");
  assert.equal(r.claimableCents, 0);
  assert.match(String(r.reason), /reconcile/);
});

// ---------------- dedup + path-gap regressions ----------------

test("renamed identical receipt produces one draft and is never re-listed", async () => {
  const { listNewDocuments, bytesAlreadyHandled } = await import("../src/tools.ts");
  const { docIdForBytes } = await import("../src/lib/records.ts");
  const bytes = readFileSync(join(ROOTS.fixtures, "01_bright_smile_dental_jun12.pdf"));
  const docId = docIdForBytes(bytes);
  await seededDentalPacket(docId);
  // Same bytes under a new name land in the inbox.
  copyFileSync(join(ROOTS.fixtures, "01_bright_smile_dental_jun12.pdf"), join(ROOTS.inbox, "totally_new_receipt.pdf"));
  const listing = await listNewDocuments.invoke({});
  assert.ok(!listing.files.includes("totally_new_receipt.pdf"), "renamed copy must not be listed as new");
  assert.ok(bytesAlreadyHandled(docId), "byte-hash guard must recognize the copy");
  const packets = (await import("node:fs")).readdirSync(join(ROOTS.outbox, "packets")).filter((p) => p.startsWith("packet-"));
  assert.equal(packets.length, 1, "exactly one draft packet exists");
  rmSync(join(ROOTS.inbox, "totally_new_receipt.pdf"), { force: true });
});

test("missing-patient representation changes cannot alter the fingerprint or bypass byte dedup", async () => {
  const a = claimFingerprint(null, "CVS Pharmacy", "2026-09-14", 649);
  const b = claimFingerprint("Unknown", "CVS Pharmacy", "2026-09-14", 649);
  const c = claimFingerprint("  n/a ", "CVS Pharmacy", "2026-09-14", 649);
  assert.equal(a, b);
  assert.equal(b, c);
  assert.notEqual(a, claimFingerprint("Jordan Sample", "CVS Pharmacy", "2026-09-14", 649));
});

test("draft registration blocks a second image of the same purchase before any approval", async () => {
  await seededDentalPacket("e000000000000001"); // draft registered at build, nothing approved
  seed("e000000000000002", "second_photo_same_purchase.pdf", {
    docType: "invoice", provider: "Bright Smile Dental Group",
    lineItems: [{ description: "Composite filling, one surface", amountCents: 18000, category: "dental" }],
  });
  await classifyEligibility.invoke({ docId: "e000000000000002" });
  const r = await matchAccount.invoke({ docId: "e000000000000002" });
  assert.equal(r.fileable, false);
  assert.equal(r.status, "possible_duplicate");
});

test("traversal through packet IDs is rejected without changing state", async () => {
  const before = balance();
  for (const evil of ["packet-../../../etc/passwd", "packet-....//....//x", "../../data/fsa-account.json", "packet-AAAAAAAAAAAAAAAA"]) {
    const r = await submitPacket.invoke({ packetId: evil }, approving);
    assert.equal(r.submitted, false);
  }
  assert.equal(balance(), before);
  assert.ok(!existsSync(join(ROOTS.outbox, "packets", "packet-..")), "no traversal artifacts created");
});

// ---------------- audit-fix regressions (terminal states, gross discounts, atomic debit) ----------------

test("build → approve → rebuild → approve: total debit occurs exactly once", async () => {
  await seededDentalPacket("a100000000000001");
  const first = await submitPacket.invoke({ packetId: "packet-a100000000000001" }, approving);
  assert.equal(first.submitted, true);
  assert.equal(balance(), 100.0);
  // Rebuild must not reopen an approved packet.
  await assert.rejects(() => Promise.resolve(buildPacket.invoke({ docId: "a100000000000001" })), /already approved/);
  assert.equal(loadRecord("a100000000000001")?.packet?.status, "approved");
  const again = await submitPacket.invoke({ packetId: "packet-a100000000000001" }, approving);
  assert.equal(again.submitted, false);
  assert.equal(balance(), 100.0);
});

test("rebuilding a declined packet cannot silently reopen it", async () => {
  await seededDentalPacket("a100000000000002");
  const declinedResult = await submitPacket.invoke({ packetId: "packet-a100000000000002" }, denying);
  assert.equal(declinedResult.submitted, false);
  assert.equal(loadRecord("a100000000000002")?.packet?.status, "declined");
  await assert.rejects(() => Promise.resolve(buildPacket.invoke({ docId: "a100000000000002" })), /declined.*cannot silently reopen/);
  assert.equal(loadRecord("a100000000000002")?.packet?.status, "declined");
});

test("rebuilding an awaiting packet is idempotent (same packet, still one draft)", async () => {
  await seededDentalPacket("a100000000000003");
  const again = await buildPacket.invoke({ docId: "a100000000000003" });
  assert.equal(again.packetId, "packet-a100000000000003");
  assert.equal(loadRecord("a100000000000003")?.packet?.status, "awaiting_approval");
});

test("gross-only discount reconciliation claims nothing: $10 item discounted to $8 requires review", async () => {
  seed("a100000000000004", "discounted.png", {
    lineItems: [{ description: "SUNSCREEN SPF50 6OZ", amountCents: 1000, category: "medical-equipment" }],
    discountCents: 200, taxCents: 0, totalCents: 800,
  });
  const r = await classifyEligibility.invoke({ docId: "a100000000000004" });
  assert.equal(r.status, "needs_review");
  assert.equal(r.claimableCents, 0);
  assert.match(String(r.reason), /before discounts/);
});

test("injected balance-write failure: no lost debit, retry completes exactly once, no duplicate", async () => {
  const { __injectWriteFailure, readLedger } = await import("../src/lib/store.ts");
  await seededDentalPacket("a100000000000005");
  __injectWriteFailure("balance");
  const failed = await submitPacket.invoke({ packetId: "packet-a100000000000005" }, approving);
  assert.equal(failed.submitted, false);
  assert.match(String(failed.reason), /run approval again to recover/);
  assert.equal(loadRecord("a100000000000005")?.packet?.status, "approving", "state preserved for recovery");
  assert.equal(readLedger().filter((e) => e.txnId === "packet-a100000000000005").length, 1, "debit committed to ledger");
  // Retry: recovery finalizes using the existing ledger entry — exactly once.
  const retried = await submitPacket.invoke({ packetId: "packet-a100000000000005" }, approving);
  assert.equal(retried.submitted, true);
  assert.equal(balance(), 100.0);
  assert.equal(readLedger().filter((e) => e.txnId === "packet-a100000000000005").length, 1, "no duplicate ledger entry");
  // And a further approval is terminally refused.
  const third = await submitPacket.invoke({ packetId: "packet-a100000000000005" }, approving);
  assert.equal(third.submitted, false);
  assert.equal(balance(), 100.0);
});

test("consent that does not bind to the exact packet and amount neither approves nor declines", async () => {
  await seededDentalPacket("a100000000000006");
  const mismatching = { interrupt: () => "consent-mismatch" } as unknown as ToolContext;
  const r = await submitPacket.invoke({ packetId: "packet-a100000000000006" }, mismatching);
  assert.equal(r.submitted, false);
  assert.match(String(r.reason), /did not bind/);
  assert.equal(loadRecord("a100000000000006")?.packet?.status, "awaiting_approval");
  assert.equal(balance(), 280.0);
});

// ---------------- required integrity regressions ----------------

test("forged amount cannot change the packet: submit takes only packetId; debit equals stored cents", async () => {
  await seededDentalPacket("c000000000000001");
  // The schema is strict — an amount argument is rejected outright.
  await assert.rejects(
    () => submitPacket.invoke({ packetId: "packet-c000000000000001", amountCents: 1 } as never, approving),
  );
  // A legitimate approval debits exactly the stored amount.
  const r = await submitPacket.invoke({ packetId: "packet-c000000000000001" }, approving);
  assert.equal(r.submitted, true);
  assert.equal(balance(), 280.0 - 180.0);
  const form = JSON.parse(readFileSync(join(ROOTS.outbox, "packets", "packet-c000000000000001", "form.json"), "utf8"));
  assert.equal(form.amountRequestedCents, 18000);
  // Printable claim preparation summary ships alongside the JSON.
  const html = readFileSync(join(ROOTS.outbox, "packets", "packet-c000000000000001", "summary.html"), "utf8");
  assert.match(html, /Claim Preparation Summary/);
  assert.match(html, /DEMO \/ SYNTHETIC/);
  assert.match(html, /NOT an administrator-approved form/);
  assert.match(html, /Tax treatment/);
  assert.match(html, /administrator's own reimbursement process/);
});

test("bypassing classification cannot build a packet", async () => {
  seed("c000000000000002", "01_bright_smile_dental_jun12.pdf", {
    lineItems: [{ description: "Composite filling", amountCents: 18000, category: "dental" }],
  });
  await assert.rejects(() => Promise.resolve(buildPacket.invoke({ docId: "c000000000000002" })), /no successful account match/);
  // Even with classification but no match:
  await classifyEligibility.invoke({ docId: "c000000000000002" });
  await assert.rejects(() => Promise.resolve(buildPacket.invoke({ docId: "c000000000000002" })), /no successful account match/);
});

test("nonexistent packet cannot debit", async () => {
  const r = await submitPacket.invoke({ packetId: "packet-ffffffffffffffff" }, approving);
  assert.equal(r.submitted, false);
  assert.equal(balance(), 280.0);
});

test("declined approval changes nothing in the ledger", async () => {
  await seededDentalPacket("c000000000000003");
  const r = await submitPacket.invoke({ packetId: "packet-c000000000000003" }, denying);
  assert.equal(r.submitted, false);
  assert.equal(balance(), 280.0);
  assert.equal(loadRecord("c000000000000003")?.packet?.status, "declined");
});

test("repeated approval debits exactly once", async () => {
  await seededDentalPacket("c000000000000004");
  const first = await submitPacket.invoke({ packetId: "packet-c000000000000004" }, approving);
  assert.equal(first.submitted, true);
  const second = await submitPacket.invoke({ packetId: "packet-c000000000000004" }, approving);
  assert.equal(second.submitted, false);
  assert.match(String(second.reason), /never debits twice|already|awaiting_approval/);
  assert.equal(balance(), 280.0 - 180.0);
});

test("insufficient balance causes no partial state change", async () => {
  await seededDentalPacket("c000000000000005"); // packet for $180
  // Balance drops to $100 after the packet was built but before approval.
  writeFileSync(ACCOUNT_PATH, JSON.stringify({ ...FRESH_ACCOUNT, remainingBalance: 100.0, startingBalance: 100.0 }, null, 2) + "\n");
  const r = await submitPacket.invoke({ packetId: "packet-c000000000000005" }, approving);
  assert.equal(r.submitted, false);
  assert.match(String(r.reason), /Insufficient balance/);
  assert.equal(balance(), 100.0);
  assert.equal(loadRecord("c000000000000005")?.packet?.status, "awaiting_approval");
});
