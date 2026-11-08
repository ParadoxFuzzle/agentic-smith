import { describe, expect, it } from "vitest";
import { compactToolOutput } from "./tool-output-compact.js";

const MARKER = "[omitted output]";

describe("tool-output compaction", () => {
  it("strips ANSI, removes duplicate lines, and hoists errors and warnings", () => {
    const source = [
      "\u001b[31mERROR: build failed in package core\u001b[0m",
      ...Array.from({ length: 80 }, () => "same compiler line"),
      "\u001b[33mwarning: deprecated option\u001b[0m",
      "tail line kept for context",
    ].join("\n");

    const result = compactToolOutput(source, 600, MARKER);
    expect(result.text.length).toBeLessThanOrEqual(600);
    expect(result.text).not.toContain("\u001b");
    expect(result.text).toContain("duplicate lines removed");
    expect(result.text).toContain("key errors:");
    expect(result.text).toContain("ERROR: build failed in package core");
    expect(result.text).toContain("key warnings:");
    expect(result.text).toContain("warning: deprecated option");
    expect(result.text).toContain(MARKER);
    expect(result.duplicateLines).toBeGreaterThan(70);
  });

  it("stays within a tight budget and never splits a surrogate pair", () => {
    const source = `ERROR: ${"😀".repeat(400)}`;
    for (const budget of [80, 129, 200, 512]) {
      const result = compactToolOutput(source, budget, MARKER);
      expect(result.text.length).toBeLessThanOrEqual(budget);
      expect(result.text).not.toContain("\uFFFD");
    }
  });

  it("uses the marker inside the budget so the tail survives trimming", () => {
    const source = [
      "HEAD diagnostic",
      ...Array.from({ length: 200 }, (_, index) => `middle line ${index} ${"x".repeat(40)}`),
      "TAIL diagnostic",
    ].join("\n");
    const result = compactToolOutput(source, 320, MARKER);
    expect(result.text.length).toBeLessThanOrEqual(320);
    expect(result.text).toContain("middle output trimmed");
    expect(result.text.endsWith("TAIL diagnostic")).toBe(true);
  });

  it("trims an already compacted result without nesting another summary", () => {
    const source = [
      "HEAD diagnostic",
      ...Array.from({ length: 200 }, (_, index) => `middle line ${index} ${"x".repeat(40)}`),
      "TAIL diagnostic",
    ].join("\n");
    const first = compactToolOutput(source, 500, MARKER);
    const second = compactToolOutput(first.text, 240, MARKER);
    expect(second.text.length).toBeLessThanOrEqual(240);
    expect(second.text.match(/\[compacted tool output:/g)).toHaveLength(1);
    expect(second.text.endsWith("TAIL diagnostic")).toBe(true);
  });

  it("keeps small output untouched", () => {
    const source = "done\nexit 0";
    const result = compactToolOutput(source, 100, MARKER);
    expect(result.text).toBe(source);
    expect(result.duplicateLines).toBe(0);
  });
});
