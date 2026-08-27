import { describe, expect, it } from "vitest";
import { evaluateExpression, validateExpression } from "../src/model-db/expressions";

describe("model-expression@0.1", () => {
  it("parses approved functions and derives dependencies", () => {
    const result = validateExpression(
      'when(ref("metric_revenue") == 0, null, round(ref("metric_profit") / ref("metric_revenue"), 4))',
    );

    expect(result.valid).toBe(true);
    expect(result.dependencies).toEqual(["metric_profit", "metric_revenue"]);
    expect(result.references).toEqual([
      { metricId: "metric_revenue", periodOffset: 0 },
      { metricId: "metric_profit", periodOffset: 0 },
    ]);
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
      validateExpression('lag("metric_revenue", 1) + lead("metric_revenue", 2)').references,
    ).toEqual([
      { metricId: "metric_revenue", periodOffset: -1 },
      { metricId: "metric_revenue", periodOffset: 2 },
    ]);
    expect(
      evaluateExpression('lag("metric_revenue", 1) + lead("metric_revenue", 1)', {
        ref: () => null,
        lag: () => 90,
        lead: () => 110,
      }),
    ).toBe(200);
  });

  it("supports exact cross-period references", () => {
    const expression =
      'sum(period_ref("metric_revenue", "period_q1_2025"), period_ref("metric_revenue", "period_q2_2025"))';

    expect(validateExpression(expression)).toMatchObject({
      valid: true,
      dependencies: ["metric_revenue"],
      references: [
        { metricId: "metric_revenue", periodOffset: 0, periodId: "period_q1_2025" },
        { metricId: "metric_revenue", periodOffset: 0, periodId: "period_q2_2025" },
      ],
    });
    expect(
      evaluateExpression(expression, {
        ref: () => null,
        periodRef: (_metricId, periodId) =>
          periodId === "period_q1_2025" ? 40 : 60,
      }),
    ).toBe(100);
  });

  it("supports replay-safe Excel-style modulo and conditions", () => {
    const expression = "when(mod(2024, 4) != 0, 365, 366)";

    expect(validateExpression(expression).valid).toBe(true);
    expect(evaluateExpression(expression, { ref: () => null })).toBe(366);
    expect(evaluateExpression("mod(-3, 2)", { ref: () => null })).toBe(1);
    expect(() => evaluateExpression("mod(3, 0)", { ref: () => null })).toThrow(
      "mod() divisor must not be zero",
    );
  });

  it.each([
    'ref("metric_revenue", 1)',
    "when(true, 1)",
    "mod(1)",
    "sum()",
    'lag("metric_revenue", 0)',
    'lead("metric_revenue", 1 + 1)',
    'period_ref("metric_revenue")',
    'period_ref("metric_revenue", period_q1_2025)',
  ])("rejects formulas that cannot compile to deterministic cell lineage: %s", (expression) => {
    expect(validateExpression(expression).valid).toBe(false);
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
