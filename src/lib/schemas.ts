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
