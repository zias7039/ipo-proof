import { describe, expect, it } from "vitest";
import { canonicalJson, sha256CanonicalHex } from "../src/hash.js";

describe("canonicalJson", () => {
  it("sorts keys and removes whitespace", () => {
    expect(canonicalJson({ b: 1, a: [true, null, "x"], c: { z: 1, y: 2 } })).toBe(
      '{"a":[true,null,"x"],"b":1,"c":{"y":2,"z":1}}',
    );
  });

  it("is independent of key insertion order", () => {
    expect(sha256CanonicalHex({ a: 1, b: 2 })).toBe(sha256CanonicalHex({ b: 2, a: 1 }));
  });

  it("rejects floats, bigint and undefined", () => {
    expect(() => canonicalJson({ a: 1.5 })).toThrow(TypeError);
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(TypeError);
    expect(() => canonicalJson({ a: 1n })).toThrow(TypeError);
    expect(() => canonicalJson({ a: undefined })).toThrow(TypeError);
  });

  it("produces the known SHA-256 of a fixed value", () => {
    // sha256 of the UTF-8 bytes of {"a":1}
    expect(sha256CanonicalHex({ a: 1 })).toBe("015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862");
  });
});
