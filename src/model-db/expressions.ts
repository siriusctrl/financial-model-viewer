import jsep from "jsep";
import type { ScalarValue } from "./types";

const ALLOWED_BINARY_OPERATORS = new Set([
  "+",
  "-",
  "*",
  "/",
  "==",
  "!=",
  "===",
  "!==",
  ">",
  ">=",
  "<",
  "<=",
]);

const ALLOWED_UNARY_OPERATORS = new Set(["+", "-", "!"]);
const ALLOWED_FUNCTIONS = new Set([
  "ref",
  "sum",
  "average",
  "min",
  "max",
  "when",
  "lag",
  "lead",
  "coalesce",
  "abs",
  "round",
]);

type ExpressionValue = ScalarValue | ExpressionValue[];

export type ExpressionIssue = {
  path: string;
  reason: string;
  suggestion: string;
};

export type ExpressionValidation = {
  valid: boolean;
  dependencies: string[];
  issues: ExpressionIssue[];
};

export type EvaluationContext = {
  ref(metricId: string): ScalarValue;
  lag?(metricId: string, periods: number): ScalarValue;
  lead?(metricId: string, periods: number): ScalarValue;
};

function asNode<T extends jsep.Expression>(node: jsep.Expression): T {
  return node as T;
}

function literalString(node: jsep.Expression): string | undefined {
  if (node.type !== "Literal") return undefined;
  const value = asNode<jsep.Literal>(node).value;
  return typeof value === "string" ? value : undefined;
}

function inspectNode(
  node: jsep.Expression,
  path: string,
  issues: ExpressionIssue[],
  dependencies: Set<string>,
): void {
  switch (node.type) {
    case "Literal": {
      const value = asNode<jsep.Literal>(node).value;
      if (value instanceof RegExp) {
        issues.push({
          path,
          reason: "Regular expression literals are not allowed",
          suggestion: "Use a number, boolean, null, or function argument string",
        });
      }
      return;
    }
    case "UnaryExpression": {
      const unary = asNode<jsep.UnaryExpression>(node);
      if (!ALLOWED_UNARY_OPERATORS.has(unary.operator)) {
        issues.push({
          path,
          reason: `Unary operator ${unary.operator} is not allowed`,
          suggestion: "Use +, -, or !",
        });
      }
      inspectNode(unary.argument, `${path}.argument`, issues, dependencies);
      return;
    }
    case "BinaryExpression": {
      const binary = asNode<jsep.BinaryExpression>(node);
      if (!ALLOWED_BINARY_OPERATORS.has(binary.operator)) {
        issues.push({
          path,
          reason: `Binary operator ${binary.operator} is not allowed`,
          suggestion: "Use arithmetic or comparison operators from the P0 language",
        });
      }
      inspectNode(binary.left, `${path}.left`, issues, dependencies);
      inspectNode(binary.right, `${path}.right`, issues, dependencies);
      return;
    }
    case "ConditionalExpression": {
      const conditional = asNode<jsep.ConditionalExpression>(node);
      inspectNode(conditional.test, `${path}.test`, issues, dependencies);
      inspectNode(
        conditional.consequent,
        `${path}.consequent`,
        issues,
        dependencies,
      );
      inspectNode(
        conditional.alternate,
        `${path}.alternate`,
        issues,
        dependencies,
      );
      return;
    }
    case "CallExpression": {
      const call = asNode<jsep.CallExpression>(node);
      if (call.callee.type !== "Identifier") {
        issues.push({
          path: `${path}.callee`,
          reason: "Only direct calls to approved functions are allowed",
          suggestion: "Use ref(), sum(), average(), min(), max(), when(), lag(), lead(), coalesce(), abs(), or round()",
        });
      } else {
        const functionName = asNode<jsep.Identifier>(call.callee).name;
        if (!ALLOWED_FUNCTIONS.has(functionName)) {
          issues.push({
            path: `${path}.callee`,
            reason: `Function ${functionName} is not allowed`,
            suggestion: "Use one of the approved model-expression functions",
          });
        }
        if (["ref", "lag", "lead"].includes(functionName)) {
          const metricId = call.arguments[0]
            ? literalString(call.arguments[0])
            : undefined;
          if (!metricId) {
            issues.push({
              path: `${path}.arguments[0]`,
              reason: `${functionName}() requires a literal metric ID as its first argument`,
              suggestion: `Pass a stable metric ID, for example ${functionName}("metric_revenue")`,
            });
          } else {
            dependencies.add(metricId);
          }
        }
      }
      call.arguments.forEach((argument, index) =>
        inspectNode(argument, `${path}.arguments[${index}]`, issues, dependencies),
      );
      return;
    }
    case "Identifier":
      issues.push({
        path,
        reason: `Bare identifier ${asNode<jsep.Identifier>(node).name} is not allowed`,
        suggestion: "Use literals and approved function calls only",
      });
      return;
    default:
      issues.push({
        path,
        reason: `Syntax node ${node.type} is not allowed`,
        suggestion: "Remove assignment, member access, arrays, sequences, or other unsupported syntax",
      });
  }
}

export function validateExpression(expression: string): ExpressionValidation {
  const issues: ExpressionIssue[] = [];
  const dependencies = new Set<string>();

  try {
    const ast = jsep(expression);
    inspectNode(ast, "$", issues, dependencies);
  } catch (error) {
    issues.push({
      path: "$",
      reason: error instanceof Error ? error.message : "Expression could not be parsed",
      suggestion: "Rewrite the formula using model-expression@0.1 syntax",
    });
  }

  return {
    valid: issues.length === 0,
    dependencies: [...dependencies].sort(),
    issues,
  };
}

function numberValue(value: ExpressionValue, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} requires a finite number`);
  }
  return value;
}

function booleanValue(value: ExpressionValue, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${label} requires a boolean condition`);
  }
  return value;
}

function scalarValue(value: ExpressionValue, label: string): ScalarValue {
  if (Array.isArray(value)) {
    throw new Error(`${label} requires a scalar value`);
  }
  return value;
}

function flattenNumbers(values: ExpressionValue[], label: string): number[] {
  const flattened = values.flatMap((value) =>
    Array.isArray(value) ? value : [value],
  );
  return flattened.map((value) => numberValue(value, label));
}

function evaluateCall(
  call: jsep.CallExpression,
  context: EvaluationContext,
  evaluate: (node: jsep.Expression) => ExpressionValue,
): ExpressionValue {
  const functionName = asNode<jsep.Identifier>(call.callee).name;
  const args = call.arguments.map(evaluate);

  switch (functionName) {
    case "ref":
      return context.ref(String(args[0]));
    case "lag": {
      if (!context.lag) throw new Error("lag() is not available in this context");
      const periods = args[1] === undefined ? 1 : numberValue(args[1], "lag()");
      return context.lag(String(args[0]), periods);
    }
    case "lead": {
      if (!context.lead) throw new Error("lead() is not available in this context");
      const periods = args[1] === undefined ? 1 : numberValue(args[1], "lead()");
      return context.lead(String(args[0]), periods);
    }
    case "sum":
      return flattenNumbers(args, "sum()").reduce((total, value) => total + value, 0);
    case "average": {
      const values = flattenNumbers(args, "average()");
      if (values.length === 0) throw new Error("average() requires a value");
      return values.reduce((total, value) => total + value, 0) / values.length;
    }
    case "min":
      return Math.min(...flattenNumbers(args, "min()"));
    case "max":
      return Math.max(...flattenNumbers(args, "max()"));
    case "when":
      return booleanValue(args[0], "when()") ? args[1] : args[2];
    case "coalesce": {
      const found = args.find((value) => value !== null);
      return found === undefined ? null : found;
    }
    case "abs":
      return Math.abs(numberValue(args[0], "abs()"));
    case "round": {
      const value = numberValue(args[0], "round()");
      const digits = args[1] === undefined ? 0 : numberValue(args[1], "round()");
      const scale = 10 ** digits;
      return Math.round(value * scale) / scale;
    }
    default:
      throw new Error(`Function ${functionName} is not allowed`);
  }
}

function evaluateAst(
  node: jsep.Expression,
  context: EvaluationContext,
): ExpressionValue {
  const evaluate = (child: jsep.Expression) => evaluateAst(child, context);

  switch (node.type) {
    case "Literal": {
      const value = asNode<jsep.Literal>(node).value;
      if (value instanceof RegExp) throw new Error("Regular expressions are not allowed");
      return value;
    }
    case "UnaryExpression": {
      const unary = asNode<jsep.UnaryExpression>(node);
      const value = evaluate(unary.argument);
      if (unary.operator === "+") return numberValue(value, "Unary +");
      if (unary.operator === "-") return -numberValue(value, "Unary -");
      if (unary.operator === "!") return !booleanValue(value, "Unary !");
      throw new Error(`Unary operator ${unary.operator} is not allowed`);
    }
    case "BinaryExpression": {
      const binary = asNode<jsep.BinaryExpression>(node);
      const left = evaluate(binary.left);
      const right = evaluate(binary.right);
      switch (binary.operator) {
        case "+":
          return numberValue(left, "+") + numberValue(right, "+");
        case "-":
          return numberValue(left, "-") - numberValue(right, "-");
        case "*":
          return numberValue(left, "*") * numberValue(right, "*");
        case "/":
          return numberValue(left, "/") / numberValue(right, "/");
        case "==":
        case "===":
          return scalarValue(left, binary.operator) === scalarValue(right, binary.operator);
        case "!=":
        case "!==":
          return scalarValue(left, binary.operator) !== scalarValue(right, binary.operator);
        case ">":
          return numberValue(left, ">") > numberValue(right, ">");
        case ">=":
          return numberValue(left, ">=") >= numberValue(right, ">=");
        case "<":
          return numberValue(left, "<") < numberValue(right, "<");
        case "<=":
          return numberValue(left, "<=") <= numberValue(right, "<=");
        default:
          throw new Error(`Binary operator ${binary.operator} is not allowed`);
      }
    }
    case "ConditionalExpression": {
      const conditional = asNode<jsep.ConditionalExpression>(node);
      return booleanValue(evaluate(conditional.test), "Conditional expression")
        ? evaluate(conditional.consequent)
        : evaluate(conditional.alternate);
    }
    case "CallExpression":
      return evaluateCall(asNode<jsep.CallExpression>(node), context, evaluate);
    default:
      throw new Error(`Syntax node ${node.type} is not allowed`);
  }
}

export function evaluateExpression(
  expression: string,
  context: EvaluationContext,
): ScalarValue {
  const validation = validateExpression(expression);
  if (!validation.valid) {
    throw new Error(validation.issues.map((issue) => issue.reason).join("; "));
  }
  return scalarValue(evaluateAst(jsep(expression), context), "Expression result");
}
