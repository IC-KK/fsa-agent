import { createInterface } from "node:readline/promises";
import type { ToolContext } from "@strands-agents/sdk";
import { submitPacket } from "./tools.ts";
import { listRecords } from "./lib/records.ts";

/**
 * The human's "tap Submit". Lists packets awaiting approval from the
 * code-owned records, asks per packet, and on a yes runs the same
 * submit_packet tool the agent uses — deterministic code, zero model calls.
 * The CLI answer IS the human approval, so the tool's interrupt is satisfied
 * by construction; amounts come from the stored packet, never from input.
 */
async function main(): Promise<void> {
  const awaiting = listRecords().filter((r) => r.packet?.status === "awaiting_approval");
  if (awaiting.length === 0) {
    console.log("No draft packets awaiting approval.");
    return;
  }
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  for (const record of awaiting) {
    const packet = record.packet!;
    console.log(`\nDEMO / SYNTHETIC DATA — demo account, not a real FSA`);
    console.log(
      `Packet ${packet.packetId}: ${record.extraction?.provider ?? "unknown"} · ${record.extraction?.dateOfService ?? "no date"} · ${record.file}`,
    );
    const amount = `$${(packet.amountCents / 100).toFixed(2)}`;
    const answer = await readline.question(`Submit ${amount}? [y/N] `);
    const approved = answer.trim().toLowerCase() === "y";
    const approvingContext = { interrupt: () => approved } as unknown as ToolContext;
    const result = await submitPacket.invoke({ packetId: packet.packetId }, approvingContext);
    console.log(
      result.submitted && "remainingBalance" in result
        ? `✅ Submitted ${result.amount} — demo balance now $${result.remainingBalance.toFixed(2)}`
        : `⏭  Not submitted: ${"reason" in result ? result.reason : "unknown"}`,
    );
  }
  readline.close();
}

main();
