# ClaimSniff architecture

```
                         ┌─────────────────────────────────────────────┐
   receipts-inbox/       │  Strands Agent loop (Claude Sonnet 4.5      │
   (PDF/PNG/JPG lands) ──▶  on Amazon Bedrock)                         │
                         │                                             │
   npm run watch         │  hooks: tool allowlist · shared 40-call     │
   polls every 5s        │  model budget (extraction included)         │
   polls every 5s        │  system prompt: packer-not-payer,           │
                         │  untrusted documents, fail closed           │
                         └──────────────────┬──────────────────────────┘
                                            │ calls typed tools (zod schemas,
                                            │ 4-folder path sandbox)
        ┌───────────────────────────────────┼───────────────────────────────┐
        ▼                    ▼              ▼                 ▼             ▼
  list_new_documents   extract_receipt   classify_       match_account   build_packet
  (inbox diff vs       (vision sub-call; eligibility     (plan-year      (form.json +
  processed index)     UNTRUSTED_DOC     (keyword rules  window, dedup   attachments +
                       output + suspici- table decides;  fingerprint,    SYNTHETIC
                       ousContent quote  integer cents;  balance cap —   banner)
                       of injections)    fail closed)    all in code)
        │
        ▼
  notify_decision ──▶ claims-outbox/cards/latest-card.json   ← the ONE ping the human sees
        │
        ▼
  submit_packet  ──▶ human-in-the-loop INTERRUPT (agent path) or `npm run approve` (CLI path)
   the only code     │ approved → debit data/fsa-account.json + record claims-index fingerprint
   that debits       │ declined → nothing changes
        │
        ▼
  data/audit.jsonl  (append-only decision diary for every tool call)
```

**Model:** Claude Sonnet 4.5 via the Strands Agents SDK — Amazon Bedrock (global inference
profile) or the Anthropic API; `src/model.ts` picks by env var, so the provider is a one-line
switch. Everything else is local files by design — the agent is a claim **packer**, not a
payer; there is no administrator API to call.

**Trust split:** the model reads documents and writes sentences; deterministic code owns
categories (keyword table), arithmetic (integer cents), the plan-year clock, duplicate
detection, the balance, and the submit gate. Document text is data, never instructions —
see `docs/THREAT_MODEL.md` and red-team fixture 09.
