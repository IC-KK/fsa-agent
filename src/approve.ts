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
  const actionable = listRecords().filter(
    (r) => r.packet?.status === "awaiting_approval" || r.packet?.status === "approving",
  );
  if (actionable.length === 0) {
    console.log("No draft packets awaiting approval.");
    return;
  }
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  for (const record of actionable) {
    const packet = record.packet!;
    const isRecovery = packet.status === "approving";
    console.log(`\nDEMO / SYNTHETIC DATA — demo account, not a real FSA`);
    console.log(
      `Packet ${packet.packetId}: ${record.extraction?.provider ?? "unknown"} · ${record.extraction?.dateOfService ?? "no date"} · ${record.file}`,
    );
    const amount = `$${(packet.amountCents / 100).toFixed(2)}`;
    if (isRecovery) {
      console.log("⚠ RECOVERY: a previous approval of this packet was interrupted mid-write. Confirming completes that transaction — it is not a new approval and can never debit twice.");
    }
    const answer = await readline.question(
      isRecovery ? `Complete interrupted approval of ${amount}? [y/N] ` : `Approve packet for ${amount}? [y/N] `,
    );
    const approved = answer.trim().toLowerCase() === "y";
    // Consent is bound to the exact packet id and amount that were displayed.
    // If the tool's freshly loaded packet differs, this returns a mismatch
    // sentinel and the tool refuses without approving OR declining.
    const shownPacketId = packet.packetId;
    const approvingContext = {
      interrupt: (params: { reason?: { packetId?: string; amount?: string } }) => {
        const r = params?.reason;
        if (r?.packetId !== shownPacketId || r?.amount !== amount) return "consent-mismatch";
        return approved;
      },
    } as unknown as ToolContext;
    const result = await submitPacket.invoke({ packetId: packet.packetId }, approvingContext);
    console.log(
      result.submitted && "remainingBalance" in result
        ? `✅ Approved locally — ${result.amount} recorded; demo balance now $${result.remainingBalance.toFixed(2)}.\n   The local balance tracks the demo workflow only — no administrator received anything and no reimbursement occurred. File via your administrator using the packet's summary.html.`
        : `⏭  Not approved: ${"reason" in result ? result.reason : "unknown"}`,
    );
  }
  readline.close();
}

main();
