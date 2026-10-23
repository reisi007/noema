import { describe, expect, it } from "vitest";
import {
  estimatedRegexSteps,
  fitsRegexBudget,
  hasRiskyQuantifiedGroup,
} from "@/lib/regex-budget";

/**
 * The regex budget shared by the formula engine and the stored property
 * pattern.
 *
 * The contract under test:
 *
 *  - the group guard refuses the two exponential blow-ups (a nested quantifier
 *    and an alternation inside a quantified group) and leaves everything
 *    else alone — a pattern of consecutive quantifiers holds no group, so it
 *    passes the guard; the budget is what stops that one;
 *  - the estimate grows with the number of repetitions that can split the
 *    text, and a literal between two repetitions pins them apart;
 *  - the budget refuses the estimate of a pattern whose work does not fit
 *    into the wall-clock budget.
 */

describe("hasRiskyQuantifiedGroup", () => {
  it("refuses a quantified group with a nested quantifier", () => {
    expect(hasRiskyQuantifiedGroup("(a+)+$")).toBe(true);
  });

  it("refuses a quantified group with an alternation", () => {
    expect(hasRiskyQuantifiedGroup("(a|aa)+$")).toBe(true);
  });

  it("accepts a quantified group whose body is a character class", () => {
    expect(hasRiskyQuantifiedGroup("^([a|b])+$")).toBe(false);
  });

  it("accepts a quantified group that a literal pins apart", () => {
    expect(hasRiskyQuantifiedGroup("^(\\d+)-(\\d+)$")).toBe(false);
  });

  it("accepts a pattern of consecutive quantifiers: it holds no group", () => {
    // The guard cannot see this pattern — the budget is what stops it.
    expect(hasRiskyQuantifiedGroup("a*a*a*a*a*a*a*a*a*b")).toBe(false);
  });
});

describe("estimatedRegexSteps", () => {
  it("counts a repetition per possible split of the text", () => {
    // One repetition over a text of 20 characters: 20 start positions times
    // 20 ways to split it.
    expect(estimatedRegexSteps("a".repeat(20), "a*")).toBe(400);
  });

  it("grows with every further quantifier", () => {
    const text = "a".repeat(20);
    expect(estimatedRegexSteps(text, "a*a*a*")).toBeGreaterThan(
      estimatedRegexSteps(text, "a*a"),
    );
  });

  it("keeps a literal between two repetitions cheap", () => {
    // The literal pins the repetitions apart, so the estimate stays at the
    // work of a single repetition.
    expect(estimatedRegexSteps("a".repeat(20), "a+-a")).toBe(
      estimatedRegexSteps("a".repeat(20), "a+"),
    );
  });

  it("ignores a repetition that cannot match the text at all", () => {
    expect(estimatedRegexSteps("aaa", "\\d+")).toBe(3);
  });
});

describe("fitsRegexBudget", () => {
  it("accepts a cheap pattern", () => {
    expect(fitsRegexBudget("AB-123", "^[A-Z]{2}-\\d{3}$")).toBe(true);
  });

  it("refuses nine quantifiers against twenty-six characters", () => {
    // The pattern of the finding: it froze the server for seconds, and its
    // estimate is far beyond the budget.
    expect(fitsRegexBudget("a".repeat(26), "a*a*a*a*a*a*a*a*a*b")).toBe(false);
  });

  it("refuses a repetition over a long text", () => {
    expect(fitsRegexBudget("a".repeat(1_000_000), "a*")).toBe(false);
  });
});
