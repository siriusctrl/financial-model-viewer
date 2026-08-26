import { describe, expect, it } from "vitest";
import { evaluateExpression, validateExpression } from "../src/model-db/expressions";

describe("model-expression@0.1", () => {
  it("parses approved functions and derives dependencies", () => {
    const result = validateExpression(
      'when(ref("metric_revenue") == 0, null, round(ref("metric_profit") / ref("metric_revenue"), 4))',
    );

    expect(result.valid).toBe(true);
    expect(result.dependencies).toEqual(["metric_profit", "metric_revenue"]);
  });

  it("evaluates arithmetic without executing JavaScript", () => {
    const values: Record<string, number> = {
      metric_revenue: 125,
      metric_cost: 45,
    };

    expect(
      evaluateExpression(
        'round((ref("metric_revenue") - ref("metric_cost")) / ref("metric_revenue"), 3)',
        { ref: (metricId) => values[metricId] },
      ),
    ).toBe(0.64);
  });

  it("supports explicit lag and lead context", () => {
    expect(
      evaluateExpression('lag("metric_revenue", 1) + lead("metric_revenue", 1)', {
        ref: () => null,
        lag: () => 90,
        lead: () => 110,
      }),
    ).toBe(200);
  });

  it.each([
    'ref.constructor("return globalThis")()',
    'window.alert("hello")',
    'unknown("metric_revenue")',
    "[1, 2, 3]",
  ])("rejects forbidden syntax: %s", (expression) => {
    const result = validateExpression(expression);
    expect(result.valid).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
  });
});
