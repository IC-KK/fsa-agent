import { createInterface } from "node:readline/promises";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { InterruptResponseContent, type AgentResult } from "@strands-agents/sdk";
import { createAgent } from "./agent.ts";
import { resetModelBudget } from "./lib/budget.ts";
import { ROOTS } from "./lib/paths.ts";
import { fromCents } from "./lib/money.ts";

/**
 * One pass over the inbox: process every new document, write the decision
 * card, and — only if the human approves at the pause — submit packets.
 *
 * Usage:
 *   npm run process            # process inbox, build packets + card, ask nothing
 *   npm run process -- --submit  # after the card, attempt submits (each one pauses for approval)
 */
const wantSubmit = process.argv.includes("--submit");

const TASK = wantSubmit
  ? "Process all new documents in the inbox, write the decision card, then submit every fileable packet (each submit will pause for human approval)."
  : "Process all new documents in the inbox, build packets for fileable claims, record skips, and write the decision card. Do not submit anything.";

function printCard(): void {
  const cardPath = join(ROOTS.outbox, "cards", "latest-card.json");
  if (!existsSync(cardPath)) return;
  const card = JSON.parse(readFileSync(cardPath, "utf8"));
  console.log("\n" + "═".repeat(64));
  console.log("  DECISION CARD —", card.headline);
  console.log("  DEMO ACCOUNT (synthetic) · Balance:", `$${card.remainingBalance.toFixed(2)}`, "· spend by", card.spendDeadline);
  console.log("═".repeat(64));
  for (const item of card.items) {
    console.log(`  [${item.status}] ${item.file} — ${item.summary}`);
    if (item.suspiciousContent) {
      console.log(`      ⚠ document contained instruction-like text: "${item.suspiciousContent.slice(0, 120)}..."`);
    }
  }
  console.log("═".repeat(64) + "\n");
}

async function main(): Promise<void> {
  const agent = createAgent();
  const readline = createInterface({ input: process.stdin, output: process.stdout });

  resetModelBudget();
  let result: AgentResult = await agent.invoke(TASK);

  // Human-in-the-loop: every submit pauses here until a person answers.
  while (result.stopReason === "interrupt" && result.interrupts?.length) {
    const responses: InterruptResponseContent[] = [];
    for (const interrupt of result.interrupts) {
      const reason = interrupt.reason as { packetId?: string; amount?: string } | undefined;
      const answer = await readline.question(
        `\n>>> APPROVE PACKET (recorded locally, nothing sent to an administrator)? packet=${reason?.packetId ?? interrupt.name} amount=${reason?.amount ?? "?"} [y/N] `,
      );
      responses.push(
        new InterruptResponseContent({ interruptId: interrupt.id, response: answer.trim().toLowerCase() === "y" }),
      );
    }
    result = await agent.invoke(responses);
  }

  readline.close();
  printCard();

  const account = JSON.parse(readFileSync(join(ROOTS.data, "fsa-account.json"), "utf8"));
  console.log(`Account balance now: $${account.remainingBalance.toFixed(2)} (from data/fsa-account.json — code-owned, not model prose)`);
  console.log(`Stop reason: ${result.stopReason}`);
}

main().catch((err) => {
  console.error("Run failed:", err.message);
  process.exit(1);
});
