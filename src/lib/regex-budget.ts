/**
 * The budget a regex may spend, shared by everything that hands a user
 * pattern to the engine.
 *
 * A native `RegExp` cannot be interrupted, so a pattern has to be judged
 * *before* the engine sees the text: {@link estimatedRegexSteps} estimates
 * the backtracking work a pattern needs for a given text, and a pattern whose
 * estimate does not fit into {@link MAX_REGEX_EVALUATION_MS} is refused.
 *
 * Two callers run untrusted patterns — the formula engine (`@/lib/formula`)
 * and the stored property pattern (`@/lib/cell-validation`) — so both take
 * their estimate and their budget from here: one source, one rule.
 */

/**
 * Wall-clock budget for one regex evaluation, in milliseconds.
 *
 * The budget is enforced from both sides: {@link estimatedRegexSteps}
 * rejects a pattern whose expected work does not fit into the budget
 * *before* the engine ever sees the text, and the formula engine measures
 * its own elapsed time afterwards, so one that overran the budget comes back
 * as an error value instead of a result.
 */
export const MAX_REGEX_EVALUATION_MS = 50;

/** The longest text a regex is applied to; a longer text is cut off. */
export const MAX_REGEX_TEXT_LENGTH = 5_000;

/**
 * Backtracking steps the engine retires per millisecond, measured in Node:
 * `a*a*b` against a text without a `b` spends 6.4e7 estimated steps in
 * 27 ms. The estimate only has to keep a pathological pattern away from the
 * engine, so it stays coarse on purpose.
 */
const REGEX_STEPS_PER_MS = 1_000_000;

/** The number of steps that fit into the budget. */
const MAX_REGEX_BUDGET_STEPS = MAX_REGEX_EVALUATION_MS * REGEX_STEPS_PER_MS;

/**
 * Whether a group body holds an alternation (`|`). Escapes and character
 * classes are skipped, so `([a|b])` is not an alternation.
 */
function containsAlternation(body: string): boolean {
  let inClass = false;
  let i = 0;
  while (i < body.length) {
    const char = body[i];
    if (char === "\\") {
      i += 2;
      continue;
    }
    if (inClass) {
      if (char === "]") inClass = false;
      i += 1;
      continue;
    }
    if (char === "[") {
      inClass = true;
      i += 1;
      continue;
    }
    if (char === "|") return true;
    i += 1;
  }
  return false;
}

/**
 * Where the content of the group that opens at `open` starts. A group may
 * carry a prefix — `(?:`, `(?=`, `(?!`, `(?<=`, `(?<!`, `(?<name>` — and that
 * prefix is group syntax, not a quantifier on the content.
 */
function groupBodyStart(pattern: string, open: number): number {
  if (pattern[open + 1] !== "?") return open + 1;
  const marker = open + 2;
  if (pattern[marker] === "<") {
    if (pattern[marker + 1] === "=" || pattern[marker + 1] === "!") {
      return marker + 2;
    }
    const close = pattern.indexOf(">", marker);
    return close === -1 ? open + 1 : close + 1;
  }
  if (
    pattern[marker] === ":" ||
    pattern[marker] === "=" ||
    pattern[marker] === "!"
  ) {
    return marker + 1;
  }
  return open + 1; // unknown group syntax: the prefix stays part of the body
}

/**
 * Best-effort guard against catastrophic backtracking: refuses a quantified
 * group whose body can match the same text in more than one way — a nested
 * quantifier (`(a+)+`) or an alternation (`(a|aa)+`). Both are the classic
 * exponential blow-ups, and the alternation carries no inner quantifier, so a
 * quantifier-only check lets it through. Escapes and character classes are
 * skipped. Conservative on purpose: a pattern it refuses is not applied.
 *
 * The guard sees only the groups — a pattern of consecutive quantifiers
 * (`a*a*a*…*b`) holds no group at all and passes it; the step budget is what
 * stops that one.
 */
export function hasRiskyQuantifiedGroup(pattern: string): boolean {
  const groupStarts: number[] = [];
  let inClass = false;
  let i = 0;
  while (i < pattern.length) {
    const char = pattern[i];
    if (char === "\\") {
      i += 2;
      continue;
    }
    if (inClass) {
      if (char === "]") inClass = false;
      i += 1;
      continue;
    }
    if (char === "[") {
      inClass = true;
      i += 1;
      continue;
    }
    if (char === "(") {
      groupStarts.push(groupBodyStart(pattern, i));
      i += 1;
      continue;
    }
    if (char === ")") {
      const start = groupStarts.pop();
      const quantifier = pattern[i + 1];
      if (
        start !== undefined &&
        (quantifier === "+" || quantifier === "*" || quantifier === "{")
      ) {
        const body = pattern.slice(start, i);
        if (/[+*?{]/.test(body) || containsAlternation(body)) return true;
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  return false;
}

/**
 * The element a quantifier at `index` applies to, as source text: the
 * character before it, the escape, the character class or the group.
 */
function repetitionElement(pattern: string, index: number): { start: number; source: string } {
  const end = index - 1;
  if (end < 0) return { start: 0, source: "" };
  const last = pattern[end];
  if (last === "]") {
    let open = end;
    while (open > 0 && pattern[open] !== "[") open -= 1;
    return { start: open, source: pattern.slice(open, end + 1) };
  }
  if (last === ")") {
    let open = end;
    let depth = 0;
    while (open >= 0) {
      if (pattern[open] === ")") depth += 1;
      if (pattern[open] === "(") {
        depth -= 1;
        if (depth === 0) break;
      }
      open -= 1;
    }
    return { start: open, source: pattern.slice(open, end + 1) };
  }
  if (last === "\\" && end > 0) return { start: end - 1, source: pattern.slice(end - 1, end + 1) };
  return { start: end, source: last };
}

/** A repetition in a pattern: the element a quantifier applies to. */
type RegexRepetition = {
  /** The source of the repeated element. */
  source: string;
  /** Where the element starts in the pattern. */
  start: number;
  /** Where the quantifier ends in the pattern. */
  end: number;
};

/**
 * The repetitions of a pattern: the elements a quantifier (`*`, `+`, `?`,
 * `{n,m}`) applies to. A chain of optional elements is the same exponential
 * split as a chain of stars, so it is counted too. A `?` that only makes the
 * preceding quantifier lazy (`a*?`, `a{2,3}?`) or opens a group construct
 * (`(?:`, `(?=`, `(?<`) is not a repetition of its own.
 */
function findRepetitions(pattern: string): RegexRepetition[] {
  const repetitions: RegexRepetition[] = [];
  let inClass = false;
  let i = 0;
  while (i < pattern.length) {
    const char = pattern[i];
    if (char === "\\") {
      i += 2;
      continue;
    }
    if (inClass) {
      if (char === "]") inClass = false;
      i += 1;
      continue;
    }
    if (char === "[") {
      inClass = true;
      i += 1;
      continue;
    }
    if (char === "*" || char === "+" || char === "{" || char === "?") {
      const previous = i > 0 ? pattern[i - 1] : "";
      const isLazyModifier =
        char === "?" &&
        (previous === "*" ||
          previous === "+" ||
          previous === "}" ||
          previous === "?" ||
          previous === "(");
      if (!isLazyModifier) {
        const element = repetitionElement(pattern, i);
        if (element.source !== "") {
          repetitions.push({ source: element.source, start: element.start, end: i + 1 });
        }
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  return repetitions;
}

/**
 * Whether the element a repetition applies to can match a character. The
 * element is described by its own source, so a group is described by what it
 * starts with; an element that does not compile is taken to match anything.
 */
function elementMatcher(source: string): (char: string) => boolean {
  try {
    const matcher = new RegExp(`^(?:${source})`);
    return (char: string) => matcher.test(char);
  } catch {
    return () => true;
  }
}

/** How often every character of a text occurs. */
function characterCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1);
  return counts;
}

/**
 * How often the element of a repetition can match the text: every such
 * character is a place where the engine may split the text.
 */
function splitCount(
  counts: Map<string, number>,
  matcher: (char: string) => boolean,
): number {
  let total = 0;
  for (const [char, count] of counts) {
    if (matcher(char)) total += count;
  }
  return total;
}

/**
 * Whether a literal between two repetitions pins them apart: the first
 * repetition has to give characters back before the literal can match, so
 * the literal decides how it splits (`(\d+)-(\d+)` splits the text once,
 * `(\w+)\s*(\w+)` splits it twice).
 */
function pinnedApart(separator: string, matcher: (char: string) => boolean): boolean {
  let inClass = false;
  let i = 0;
  while (i < separator.length) {
    const char = separator[i];
    if (char === "\\") {
      i += 2;
      continue;
    }
    if (inClass) {
      if (char === "]") inClass = false;
      i += 1;
      continue;
    }
    if (char === "[") {
      inClass = true;
      i += 1;
      continue;
    }
    if (!"*+?{}".includes(char) && !matcher(char)) return true;
    i += 1;
  }
  return false;
}

/**
 * The engine's expected work for one evaluation, in backtracking steps.
 *
 * The engine tries every start position and, at every start position, every
 * split of every repeated element — but only for elements that can match the
 * text at all, and only while no literal in between pins them apart. The
 * result is a product of the split counts, which is what the budget is
 * checked against.
 */
export function estimatedRegexSteps(text: string, pattern: string): number {
  const counts = characterCounts(text);
  let steps = text.length;
  let previous: RegexRepetition | null = null;
  for (const repetition of findRepetitions(pattern)) {
    const splits = splitCount(counts, elementMatcher(repetition.source));
    if (splits === 0) continue;
    if (
      previous !== null &&
      pinnedApart(pattern.slice(previous.end, repetition.start), elementMatcher(previous.source))
    ) {
      continue;
    }
    steps *= splits;
    previous = repetition;
  }
  return steps;
}

/**
 * Whether a pattern can be applied to a text within the budget. The estimate
 * is a heuristic, so it is deliberately coarse: a pattern it refuses is not
 * applied at all, a pattern it accepts is the caller's risk.
 */
export function fitsRegexBudget(text: string, pattern: string): boolean {
  const steps = estimatedRegexSteps(text, pattern);
  return Number.isFinite(steps) && steps <= MAX_REGEX_BUDGET_STEPS;
}
