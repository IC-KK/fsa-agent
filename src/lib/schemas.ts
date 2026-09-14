import { z } from "zod";

// Categories are a closed list tied to data/eligibility-table.json.
// The extractor may only choose from these; eligibility itself is decided in code.
export const CATEGORIES = [
  "dental",
  "vision",
  "prescriptions",
  "otc-medical",
  "lab-diagnostics",
  "copays-deductibles",
  "medical-equipment",
  "therapy-mental-health",
  "massage-bodywork",
  "gym-fitness",
  "cosmetic",
  "general-wellness",
  "food-grocery",
  "other-nonmedical",
] as const;

export const LineItemSchema = z.object({
  description: z.string().min(1),
  amountCents: z.number().int().nonnegative(),
  category: z.enum(CATEGORIES),
});

export const ExtractionSchema = z.object({
  readable: z.boolean(),
  docType: z.enum(["receipt", "invoice", "eob", "order", "unknown"]),
  patient: z.string().nullable(),
  provider: z.string().nullable(),
  dateOfService: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  lineItems: z.array(LineItemSchema),
  totalCents: z.number().int().nonnegative().nullable(),
  taxCents: z.number().int().nonnegative().nullable().default(null),
  shippingCents: z.number().int().nonnegative().nullable().default(null),
  discountCents: z.number().int().nonnegative().nullable().default(null),
  // EOBs only: the slice of the bill that is actually the patient's to pay.
  patientResponsibilityCents: z.number().int().nonnegative().nullable(),
  confidence: z.number().min(0).max(1),
  suspiciousContent: z.string().nullable(),
});

export type Extraction = z.infer<typeof ExtractionSchema>;

/**
 * Deterministic reconciliation check shared by classification and the
 * extraction reread gate: net lines + tax + shipping must equal the printed
 * total. Returns a human-readable discrepancy note when it fails.
 */
export function checkReconciliation(e: Extraction): { ok: boolean; note: string | null } {
  if (e.docType === "eob" || e.lineItems.length === 0) return { ok: true, note: null };
  const lineSum = e.lineItems.reduce((s, l) => s + l.amountCents, 0);
  if (e.totalCents == null) return { ok: false, note: "No printed total was captured — look again for a TOTAL line." };
  const adj = (e.taxCents ?? 0) + (e.shippingCents ?? 0);
  if (lineSum + adj === e.totalCents) return { ok: true, note: null };
  return {
    ok: false,
    note: `Captured line amounts (${(lineSum / 100).toFixed(2)}) + tax/shipping (${(adj / 100).toFixed(2)}) = ${((lineSum + adj) / 100).toFixed(2)}, but the printed total is ${(e.totalCents / 100).toFixed(2)}.`,
  };
}
