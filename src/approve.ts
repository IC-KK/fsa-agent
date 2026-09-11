import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import type { ToolContext } from "@strands-agents/sdk";
import { submitPacket } from "./tools.ts";
import { ROOTS } from "./lib/paths.ts";

/**
 * The human's "tap Submit". Lists draft packets, asks per packet, and on a
 * yes runs the same submit_packet tool the agent uses — deterministic code,
 * zero model calls. The CLI answer IS the human approval, so the tool's
 * interrupt is satisfied by construction.
 */
async function main(): Promise<void> {
  const packetsDir = join(ROOTS.outbox, "packets");
  if (!existsSync(packetsDir)) {
    console.log("No packets to review.");
    return;
  }
  const drafts = readdirSync(packetsDir)
    .map((id) => ({ id, form: join(packetsDir, id, "form.json") }))
    .filter(({ form }) => existsSync(form))
    .map(({ id, form }) => ({ id, form: JSON.parse(readFileSync(form, "utf8")) }))
    .filter(({ form }) => String(form.status).startsWith("DRAFT"));

  if (drafts.length === 0) {
    console.log("No draft packets awaiting approval.");
    return;
  }

  const readline = createInterface({ input: process.stdin, output: process.stdout });
  for (const { id, form } of drafts) {
    console.log(`\n${form.banner}`);
    console.log(`Packet ${id}: ${form.provider} · ${form.dateOfService} · ${form.descriptionOfService}`);
    const answer = await readline.question(`Submit ${form.amountRequested}? [y/N] `);
    const approved = answer.trim().toLowerCase() === "y";
    const approvingContext = { interrupt: () => approved } as unknown as ToolContext;
    const result = await submitPacket.invoke(
      { packetId: id, fingerprint: form.fingerprint, file: form.attachments[0], fileCents: form.amountRequestedCents },
      approvingContext,
    );
    console.log(
      result.submitted && result.remainingBalance !== undefined
        ? `✅ Submitted — balance now $${result.remainingBalance.toFixed(2)}`
        : "⏭  Skipped.",
    );
  }
  readline.close();
}

main();
