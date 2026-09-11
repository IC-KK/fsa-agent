// All money in this codebase is integer cents. Floats never touch a balance.
export function toCents(dollars: number): number {
  return Math.round(dollars * 100);
}

export function fromCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function assertCents(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer cent amount, got ${value}`);
  }
}
