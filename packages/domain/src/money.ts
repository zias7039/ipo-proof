/**
 * Money is represented as a non-negative integer number of KRW, using `bigint`.
 * Floating point numbers are never used for money anywhere in this package.
 */
export type Krw = bigint;

export class InvalidKrwError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidKrwError";
  }
}

/** True only for `bigint` values that are >= 0. JS numbers are rejected on purpose. */
export function isKrw(value: unknown): value is Krw {
  return typeof value === "bigint" && value >= 0n;
}

/** Asserts `value` is a non-negative bigint; throws InvalidKrwError otherwise. */
export function assertKrw(value: unknown, label = "amount"): asserts value is Krw {
  if (typeof value !== "bigint") {
    throw new InvalidKrwError(`${label} must be a bigint KRW integer, got ${typeof value}`);
  }
  if (value < 0n) {
    throw new InvalidKrwError(`${label} must not be negative`);
  }
}

/** Parses a base-10 integer string such as "30000000000" into KRW. No decimals, no separators. */
export function parseKrw(text: string, label = "amount"): Krw {
  if (!/^(0|[1-9][0-9]*)$/.test(text)) {
    throw new InvalidKrwError(`${label} must be a base-10 non-negative integer string`);
  }
  return BigInt(text);
}

/** Sums KRW amounts exactly. */
export function sumKrw(values: readonly Krw[]): Krw {
  let total = 0n;
  for (const v of values) {
    total += v;
  }
  return total;
}
