import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createAgent } from "./agent.ts";
import { resetModelBudget } from "./lib/budget.ts";
import { ROOTS } from "./lib/paths.ts";

/**
 * The silent loop. Watches the inbox; when a document lands, runs the
 * pipeline and writes the decision card. Never submits — submission is a
 * human act (`npm run approve`, or a `process -- --submit` run).
 *
 * Usage: npm run watch
 */
const POLL_MS = 5000;
const HEARTBEAT_MS = 60_000;

const WATCH_TASK =
  "Process all new documents in the inbox: extract, classify, match, build packets " +
  "for fileable claims, record skips for everything else, and call mark_done for EVERY " +
  "file you processed (including ones with packets) so it is not processed again. " +
  "Finish by writing the decision card with notify_decision. Never call submit_packet.";

function processedFiles(): Set<string> {
  const p = join(ROOTS.data, "processed-files.json");
  return existsSync(p) ? new Set(Object.values(JSON.parse(readFileSync(p, "utf8")) as Record<string, string>)) : new Set();
}

function pendingFiles(): string[] {
  const done = processedFiles();
  return readdirSync(ROOTS.inbox).filter((f) => /\.(pdf|png|jpe?g)$/i.test(f) && !done.has(f));
}

async function main(): Promise<void> {
  console.log(`ClaimSniff watching ${ROOTS.inbox} (poll every ${POLL_MS / 1000}s). Ctrl+C to stop.`);
  let lastHeartbeat = Date.now();
  let busy = false;

  setInterval(async () => {
    if (busy) return;
    const pending = pendingFiles();
    if (pending.length === 0) {
      if (Date.now() - lastHeartbeat >= HEARTBEAT_MS) {
        console.log(`[${new Date().toLocaleTimeString()}] inbox quiet — watching`);
        lastHeartbeat = Date.now();
      }
      return;
    }
    busy = true;
    console.log(`\n[${new Date().toLocaleTimeString()}] ${pending.length} new document(s): ${pending.join(", ")}`);
    try {
      // Fresh agent per batch: no stale conversation state between batches.
      resetModelBudget();
      const agent = createAgent();
      await agent.invoke(WATCH_TASK);
      const cardPath = join(ROOTS.outbox, "cards", "latest-card.json");
      if (existsSync(cardPath)) {
        const card = JSON.parse(readFileSync(cardPath, "utf8"));
        console.log(`\n📋 ${card.headline}  [demo account — synthetic]`);
        for (const item of card.items) console.log(`   [${item.status}] ${item.file} — ${item.summary}`);
        console.log(`   → review packets in claims-outbox/, then: npm run approve\n`);
      }
    } catch (err) {
      console.error("Processing failed:", (err as Error).message);
    } finally {
      busy = false;
      lastHeartbeat = Date.now();
    }
  }, POLL_MS);
}

main();
