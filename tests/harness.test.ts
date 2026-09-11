import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, rmSync, existsSync, readFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolContext } from "@strands-agents/sdk";
import { classifyEligibility, matchAccount, submitPacket, buildPacket } from "../src/tools.ts";
import { safeResolve, PathViolationError, ROOTS } from "../src/lib/paths.ts";
import { claimFingerprint, recordClaim } from "../src/lib/store.ts";

// Every test here runs with ZERO model calls. This is the quality gate.

const ACCOUNT_PATH = join(ROOTS.data, "fsa-account.json");
const FRESH_ACCOUNT = {
  accountHolder: "Sample User",
  planYear: 2026,
  annualElection: 2000.0,
  remainingBalance: 280.0,
  spendDeadline: "2026-12-31",
  claimFilingDeadline: "2027-03-31",
};

function resetState(): void {
  writeFileSync(ACCOUNT_PATH, JSON.stringify(FRESH_ACCOUNT, null, 2) + "\n");
  for (const f of ["claims-index.json", "processed-files.json"]) {
    if (existsSync(join(ROOTS.data, f))) rmSync(join(ROOTS.data, f));
  }
}
before(resetState);
after(resetState);

const gold = JSON.parse(readFileSync(join(ROOTS.fixtures, "expected.json"), "utf8"));

test("mixed cart: splits eligible from ineligible to the cent (gold: 02)", async () => {
  const r = await classifyEligibility.invoke({
    file: "02_maple_pharmacy_mixed_cart.png", docType: "receipt", confidence: 0.95, patientResponsibilityCents: null,
    lineItems: [
      { description: "RX #7742210 CETIRIZINE 10MG", amountCents: 2400, category: "prescriptions" },
      { description: "SUNSCREEN SPF50 6OZ", amountCents: 1050, category: "medical-equipment" },
      { description: "CHOC CARAMEL BAG 11OZ", amountCents: 1125, category: "food-grocery" },
    ],
  });
  assert.equal(r.status, "mixed");
  assert.equal(r.claimableCents, Math.round(gold["02_maple_pharmacy_mixed_cart.png"].claimable * 100));
});

test("EOB: claims patient responsibility, never the billed total (gold: 03)", async () => {
  const r = await classifyEligibility.invoke({
    file: "03_meridian_labs_eob.pdf", docType: "eob", confidence: 0.95, patientResponsibilityCents: 6500,
    lineItems: [
      { description: "Comprehensive metabolic panel (80053)", amountCents: 21200, category: "lab-diagnostics" },
      { description: "Lipid panel (80061)", amountCents: 19800, category: "lab-diagnostics" },
    ],
  });
  assert.equal(r.claimableCents, 6500);
});

test("laundering attack: model-claimed category cannot make candy a prescription", async () => {
  const r = await classifyEligibility.invoke({
    file: "attack.png", docType: "receipt", confidence: 0.99, patientResponsibilityCents: null,
    // The model (fooled by an injection footer) swears these are prescriptions.
    lineItems: [
      { description: "CHOC CARAMEL BAG 11OZ", amountCents: 1125, category: "prescriptions" },
      { description: "MEGA PROTEIN POWDER 2LB", amountCents: 4500, category: "prescriptions" },
    ],
  });
  assert.equal(r.claimableCents, 0);
  assert.ok(r.lines.every((l: { ruling: string }) => l.ruling === "ineligible"));
});

test("unknown item name fails closed to needs_review, whatever the model says", async () => {
  const r = await classifyEligibility.invoke({
    file: "mystery.png", docType: "receipt", confidence: 0.99, patientResponsibilityCents: null,
    lineItems: [{ description: "XQ-9 QUANTUM DEVICE", amountCents: 99900, category: "prescriptions" }],
  });
  assert.equal(r.status, "needs_review");
  assert.equal(r.claimableCents, 0);
});

test("low extraction confidence fails closed (gold: 08)", async () => {
  const r = await classifyEligibility.invoke({
    file: "08_blurry_grocery.jpg", docType: "unknown", confidence: 0.2, patientResponsibilityCents: null, lineItems: [],
  });
  assert.equal(r.status, "needs_review");
});

test("prior-year receipt never files (gold: 06)", async () => {
  const r = await matchAccount.invoke({
    file: "06_clearview_prior_year_vision.pdf", fileHash: "h6", patient: "Jordan Sample",
    provider: "ClearView Optical Studio", dateOfService: "2025-11-08", claimableCents: 14500, status: "eligible",
  });
  assert.equal(r.fileable, false);
  assert.equal(r.status, "rejected_prior_year");
});

test("duplicate fingerprint never files twice (gold: 07)", async () => {
  const fp = claimFingerprint("Jordan Sample", "Bright Smile Dental Group", "2026-06-12", 18000);
  recordClaim(fp, "01_bright_smile_dental_jun12.pdf", "submitted");
  const r = await matchAccount.invoke({
    file: "07_dental_scan_copy.pdf", fileHash: "h7", patient: "Jordan Sample",
    provider: "Bright Smile Dental Group", dateOfService: "2026-06-12", claimableCents: 18000, status: "eligible",
  });
  assert.equal(r.fileable, false);
  assert.equal(r.status, "duplicate");
});

test("fingerprint survives filename, case, and unicode-spacing tricks", () => {
  const a = claimFingerprint("Jordan Sample", "Bright Smile Dental Group", "2026-06-12", 18000);
  const b = claimFingerprint("jordan  sample", "BRIGHT SMILE　DENTAL GROUP", "2026-06-12", 18000);
  assert.equal(a, b);
});

test("submit without human approval does not debit the balance", async () => {
  resetState();
  // Stage the receipt in the inbox, then build a real packet so submit has something to mark.
  copyFileSync(
    join(ROOTS.fixtures, "01_bright_smile_dental_jun12.pdf"),
    join(ROOTS.inbox, "01_bright_smile_dental_jun12.pdf"),
  );
  await buildPacket.invoke({
    file: "01_bright_smile_dental_jun12.pdf",
    fingerprint: "f".repeat(64), patient: "Jordan Sample", provider: "Bright Smile Dental Group",
    dateOfService: "2026-06-12", description: "Dental filling", fileCents: 18000,
    lines: [{ description: "Composite filling", amountCents: 18000, ruling: "eligible", reason: "Dental." }],
  });
  const denyingContext = { interrupt: () => false } as unknown as ToolContext;
  const r = await submitPacket.invoke(
    { packetId: "packet-ffffffffff", fingerprint: "f".repeat(64), file: "01_bright_smile_dental_jun12.pdf", fileCents: 18000 },
    denyingContext,
  );
  assert.equal(r.submitted, false);
  const account = JSON.parse(readFileSync(ACCOUNT_PATH, "utf8"));
  assert.equal(account.remainingBalance, 280.0);
});

test("balance cap: cannot file more than remaining balance (injection's $9,999 is impossible)", async () => {
  resetState();
  const r = await matchAccount.invoke({
    file: "big.pdf", fileHash: "hb", patient: "Jordan Sample", provider: "Somewhere",
    dateOfService: "2026-05-01", claimableCents: 999900, status: "eligible",
  });
  assert.equal(r.fileable, true);
  assert.equal(r.fileCents, 28000); // capped at $280.00 — never the attacker's number
});

test("paths outside the four allowed folders are refused", () => {
  assert.throws(() => safeResolve("../../.aws/credentials"), PathViolationError);
  assert.throws(() => safeResolve("/etc/passwd"), PathViolationError);
  assert.throws(() => safeResolve("src/agent.ts"), PathViolationError);
  assert.ok(safeResolve("receipts-inbox/receipt.pdf", ["inbox"]));
});
