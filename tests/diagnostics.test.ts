import { describe, expect, it } from "vitest";
import { groupDiagnostics } from "../src/components/diagnostics";

describe("diagnostic presentation", () => {
  it("counts all 500 failures but retains at most three examples", () => {
    const input = Array.from({ length: 500 }, (_, i) => ({ code: "pair-sum", message: `Outcome ${i}: YES and NO sum to 98` }));
    const group = groupDiagnostics(input).get("pair-sum")!;
    expect(group.count).toBe(500);
    expect(group.examples).toHaveLength(3);
    expect(input).toHaveLength(500);
  });
  it("deduplicates and bounds examples without losing counts or issue codes", () => {
    const groups = groupDiagnostics([{ code: "pair-sum", message: "Repeated" }, { code: "pair-sum", message: "Repeated" }, { code: "schema", message: "x".repeat(1000) }]);
    expect(groups.get("pair-sum")).toEqual({ count: 2, examples: ["Repeated"] });
    expect(groups.get("schema")?.examples[0]).toHaveLength(243);
    expect(groupDiagnostics([]).size).toBe(0);
  });
});
