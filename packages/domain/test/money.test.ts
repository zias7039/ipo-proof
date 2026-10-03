import { describe, expect, it } from "vitest";
import { InvalidKrwError, assertKrw, isKrw, parseKrw, sumKrw } from "../src/money.js";

describe("money", () => {
  it("accepts only non-negative bigint", () => {
    expect(isKrw(0n)).toBe(true);
    expect(isKrw(30_000_000_000n)).toBe(true);
    expect(isKrw(-1n)).toBe(false);
    expect(isKrw(10)).toBe(false);
    expect(isKrw(1.5)).toBe(false);
    expect(isKrw("10")).toBe(false);
  });

  it("assertKrw throws on numbers and negatives", () => {
    expect(() => assertKrw(5)).toThrow(InvalidKrwError);
    expect(() => assertKrw(-5n)).toThrow(InvalidKrwError);
    expect(() => assertKrw(5n)).not.toThrow();
  });

  it("parseKrw accepts plain integer strings only", () => {
    expect(parseKrw("30000000000")).toBe(30_000_000_000n);
    expect(() => parseKrw("1.5")).toThrow(InvalidKrwError);
    expect(() => parseKrw("1,000")).toThrow(InvalidKrwError);
    expect(() => parseKrw("-1")).toThrow(InvalidKrwError);
    expect(() => parseKrw("01")).toThrow(InvalidKrwError);
    expect(() => parseKrw("")).toThrow(InvalidKrwError);
  });

  it("sums exactly beyond Number.MAX_SAFE_INTEGER", () => {
    const big = 9_007_199_254_740_993n; // 2^53 + 1, not representable as a float
    expect(sumKrw([big, 1n])).toBe(9_007_199_254_740_994n);
    expect(sumKrw([])).toBe(0n);
  });
});
