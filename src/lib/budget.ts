/**
 * Shared model-call budget for one run: covers BOTH the orchestrator's calls
 * and every per-document extraction call. run.ts / watch.ts reset it at the
 * start of each batch; any call past the cap stops the run.
 */
const MAX_MODEL_CALLS_PER_RUN = 40;
let used = 0;

export function resetModelBudget(): void {
  used = 0;
}

export function consumeModelCall(source: string): void {
  used += 1;
  if (used > MAX_MODEL_CALLS_PER_RUN) {
    throw new Error(`Shared model-call budget (${MAX_MODEL_CALLS_PER_RUN}/run) exceeded at ${source} — stopping run.`);
  }
}

export function modelCallsUsed(): number {
  return used;
}
