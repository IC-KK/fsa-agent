# Threat model — ClaimSniff (FSA claim-packing agent)

The model **reasons**; deterministic code owns **money, eligibility, persistence, and side
effects**. Prompts are not a security boundary. Every defense below is enforced in code.
Where a row says **Proven**, the named test in `tests/harness.test.ts` exercises exactly
that behavior with zero model calls. Where it says **Untested** or **Design measure**, we
say so — an unlabeled claim would itself be a defect.

Documents are **untrusted input**. Text inside a document is data, never an instruction.

## Threats, mitigations, and their tests

| # | Threat | Mitigation | Evidence |
|---|--------|------------|----------|
| 1 | Category laundering: model returns a false category so ineligible items become claimable | `classify_eligibility` matches item names against `data/eligibility-rules.json` keywords; model category is a logged cross-check that can never raise trust; unknown names fail closed | **Proven:** "laundering attack: model-claimed category cannot make candy a prescription"; "unknown item fails closed to needs_review" |
| 2 | Model alters amounts between pipeline stages | Persisted per-document records keyed by sha256 of file bytes; classify/match/build/submit accept only IDs (strict schemas); values load from disk | **Proven:** "forged amount cannot change the packet"; "bypassing classification cannot build a packet" |
| 3 | Over-claim on mixed baskets | Per-line rulings; only eligible lines sum into integer-cent `claimableCents` | **Proven:** "mixed cart: splits eligible from ineligible to the cent" |
| 4 | EOB abuse: claiming billed totals, or responsibility creating a claim from nothing | Claim = min(eligible lines, patient responsibility); zero eligible → zero; missing responsibility → review | **Proven:** "EOB: claims patient responsibility, never the billed total"; "EOB with only unknown lines yields zero"; "EOB with only ineligible lines yields zero"; "eligible EOB is capped… missing responsibility requires review" |
| 5 | Fabricated or misread arithmetic | Reconciliation: net lines + tax + shipping must equal the printed total (gross-lines alternate applies discounts once); mismatch or missing total → review | **Proven:** "CVS paper receipt arithmetic reconciles"; "the observed wrong gum extraction ($1.63) fails reconciliation" |
| 6 | Duplicate claims: renamed files, re-photographed receipts, representation tricks | Byte-hash dedup (no re-listing, no re-extraction); draft fingerprints registered at build time; canonicalized missing identities; cross-image metadata match flags `possible_duplicate` for review without claiming proof | **Proven:** "renamed identical receipt produces one draft"; "draft registration blocks a second image"; "missing-patient representation changes cannot alter the fingerprint"; "duplicate fingerprint never files twice"; "fingerprint survives … unicode-spacing tricks" |
| 7 | Plan-year bypass | Date-window check in `match_account` on the stored date | **Proven:** "prior-year receipt never files" |
| 8 | Unauthorized or repeated spending | `submit_packet` takes only a packetId; human interrupt names exact packet+amount; status must be `awaiting_approval`; balance re-checked; approval-lock serializes; atomic record write | **Proven:** "declined approval changes nothing"; "repeated approval debits exactly once"; "nonexistent packet cannot debit"; "insufficient balance causes no partial state change" |
| 9 | Balance inflation (e.g. a document claiming "$9,999 balance") | Balance is code-owned in `data/fsa-account.json`; claims capped at remaining balance | **Proven:** "balance cap: cannot file more than remaining balance" |
| 10 | Path traversal / data exfiltration via file paths or packet IDs | `safeResolve` allowlist (4 folders, symlinks resolved) on sources AND packet destinations; packet IDs regex-validated before any path use | **Proven:** "paths outside the four allowed folders are refused"; "traversal through packet IDs is rejected without changing state" |
| 11 | Prompt injection quoted, not obeyed (`suspiciousContent` surfacing on the card) | Extractor contract quotes instruction-like text into a field instead of acting on it | **Design measure, exercised in live runs (fixture 09), not unit-tested** — the money-path consequences of an injection are what rows 1, 2 and 9 prove |
| 12 | Rogue/unknown tool calls | `BeforeToolCall` hook cancels tools not on the allowlist | **Untested** (hook exists in `src/agent.ts`; no unit test drives the agent loop) |
| 13 | Cost runaway / loops | Shared per-run model-call budget (40) covering BOTH orchestrator calls and per-document extraction calls, reset at batch start; 8 MB document cap; temperature 0 | **Untested as a unit; enforced in `src/lib/budget.ts`** and wired in agent hook + extractor |
| 14 | Unreadable input leading to invented claims | Confidence < 0.70 or unreadable → `needs_review` | **Proven:** "low extraction confidence fails closed" |
| 15 | PII/PHI exposure | Synthetic fixtures only; demo-account labels on card, CLI, and summary; audit log records decisions, not document bodies | **Design measure, not tested.** Note: receipt content IS sent to the configured model (Bedrock/Anthropic) to be read — stated in the README and on the site |

## Remaining limitations (explicit)

- **Extraction is the trust boundary.** These defenses prove integrity *after* extraction.
  A model misreading an item's identity (not its arithmetic) can survive reconciliation;
  the keyword fence and fail-closed rules bound the damage but do not eliminate it.
- **Tax is excluded from requested amounts** — a deliberate conservative under-claim; many
  administrators allow tax on eligible items.
- **Register abbreviations** ("TRDNT SNGL ORIG") often land in `needs_review` rather than a
  confident ruling. That is fail-closed working, and also a real usability cost.
- **The approve CLI trusts the local user** — anyone at the keyboard is "the human."
- **The approval lock** (atomic mkdir) serializes processes on one machine; it is not a
  distributed lock.
- **The watcher processes new receipts only while `npm run watch` is running and the Mac is
  awake**, and displays the deadline configured in `data/fsa-account.json`. There are no
  independent expiration alerts today; that is roadmap, not product.
- **No administrator integration exists** — deliberate: the agent prepares packets; the
  human files them.
