import { textBoundary, truncatePlainText } from "@agentic-smith/core";

/**
 * Compact noisy tool output before it re-enters the model context.
 *
 * ANSI escapes are removed, exact duplicate lines are dropped, errors and
 * warnings are hoisted into the summary, and the remaining text keeps a head
 * and tail within the caller's character budget. The transformation is
 * deterministic and never changes the tool's exit status or other control
 * fields; those live in the surrounding result envelope.
 */
export interface CompactToolOutputResult {
  text: string;
  rawChars: number;
  compactedChars: number;
  duplicateLines: number;
  errorLines: number;
  warningLines: number;
}

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const ANSI_RE = new RegExp(
  `${ESC}\\[[0-9;?]*[a-zA-Z]|${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)|${ESC}[()][A-Z0-9]`,
  "g",
);
const ERROR_RE = /\b(?:error|fatal|failed|failure|exception|traceback)\b:?/i;
const WARNING_RE = /\bwarn(?:ing)?\b/i;
const MAX_KEY_LINES = 5;
const MAX_KEY_LINE_CHARS = 240;
const MIDDLE_MARKER = "\n[…middle output trimmed…]\n";
const COMPACTED_PREFIX = "[compacted tool output:";

export function compactToolOutput(
  source: string,
  budgetChars: number,
  marker: string,
): CompactToolOutputResult {
  const cleaned = stripAnsi(source).replace(/\r\n?/g, "\n").trimEnd();
  const budget = Number.isFinite(budgetChars) ? Math.max(1, Math.floor(budgetChars)) : 1;
  const rawChars = source.length;
  if (cleaned.length <= budget) {
    return {
      text: cleaned,
      rawChars,
      compactedChars: cleaned.length,
      duplicateLines: 0,
      errorLines: 0,
      warningLines: 0,
    };
  }
  if (cleaned.startsWith(COMPACTED_PREFIX)) {
    // A later turn can shorten an already compacted result; trim it instead of nesting
    // another summary and marker inside the first one.
    const text = splitHeadAndTail(cleaned, budget);
    return {
      text,
      rawChars,
      compactedChars: text.length,
      duplicateLines: 0,
      errorLines: 0,
      warningLines: 0,
    };
  }

  const rawLines = cleaned.split("\n");
  const lines = rawLines.filter((line) => line.trim().length > 0);
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const line of lines) {
    const key = line.trimEnd();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(key);
  }
  const duplicateLines = lines.length - unique.length;
  const errors = unique.filter((line) => ERROR_RE.test(line));
  const warnings = unique.filter((line) => !ERROR_RE.test(line) && WARNING_RE.test(line));
  const summary = buildSummary({
    rawChars,
    uniqueLines: unique.length,
    duplicateLines,
    errorCount: errors.length,
    warningCount: warnings.length,
    errors,
    warnings,
    budget,
  });
  if (!summary) return { ...emptyResult(rawChars), text: "…" };

  const markerBlock = marker ? `\n${marker}\n` : "\n";
  const bodyBudget = Math.max(0, budget - summary.length - markerBlock.length);
  if (bodyBudget <= 0) {
    return {
      ...emptyResult(rawChars),
      text: truncatePlainText(summary, budget),
      duplicateLines,
      errorLines: errors.length,
      warningLines: warnings.length,
    };
  }

  const joined = unique.join("\n");
  const body = splitHeadAndTail(joined, bodyBudget);
  let text = `${summary}${markerBlock}${body}`;
  if (text.length > budget) text = truncatePlainText(text, budget);
  return {
    text,
    rawChars,
    compactedChars: text.length,
    duplicateLines,
    errorLines: errors.length,
    warningLines: warnings.length,
  };
}

function buildSummary(options: {
  rawChars: number;
  uniqueLines: number;
  duplicateLines: number;
  errorCount: number;
  warningCount: number;
  errors: string[];
  warnings: string[];
  budget: number;
}): string {
  const parts = [
    `[compacted tool output: raw ${options.rawChars} chars; ${options.uniqueLines} unique lines`,
  ];
  if (options.duplicateLines > 0) parts.push(`; ${options.duplicateLines} duplicate lines removed`);
  if (options.errorCount > 0) parts.push(`; ${options.errorCount} errors`);
  if (options.warningCount > 0) parts.push(`; ${options.warningCount} warnings`);
  parts.push("]");
  const lines = [parts.join("")];

  // Key lines are the point of the compaction, but a tight budget still wins.
  const reserve = 96;
  if (options.budget >= reserve + 80) {
    if (options.errors.length > 0) {
      lines.push("key errors:");
      for (const line of options.errors.slice(0, MAX_KEY_LINES))
        lines.push(`  ${truncatePlainText(line.trim(), MAX_KEY_LINE_CHARS)}`);
    }
    if (options.warnings.length > 0) {
      lines.push("key warnings:");
      for (const line of options.warnings.slice(0, MAX_KEY_LINES))
        lines.push(`  ${truncatePlainText(line.trim(), MAX_KEY_LINE_CHARS)}`);
    }
  }
  return lines.join("\n");
}

function splitHeadAndTail(text: string, budget: number): string {
  if (text.length <= budget) return text;
  // The marker is part of the budget; otherwise the final clamp would cut the tail.
  if (budget <= MIDDLE_MARKER.length + 2) return truncatePlainText(text, budget);
  const contentBudget = budget - MIDDLE_MARKER.length;
  const headBudget = Math.max(1, Math.floor(contentBudget * 0.62));
  const tailBudget = Math.max(1, contentBudget - headBudget);
  const head = truncatePlainText(text, headBudget).trimEnd();
  const tailStart = textBoundary(text, text.length - tailBudget);
  return `${head}${MIDDLE_MARKER}${text.slice(tailStart)}`;
}

function stripAnsi(text: string): string {
  if (!text.includes(ESC)) return text;
  ANSI_RE.lastIndex = 0;
  return text.replace(ANSI_RE, "");
}

function emptyResult(rawChars: number): CompactToolOutputResult {
  return {
    text: "",
    rawChars,
    compactedChars: 0,
    duplicateLines: 0,
    errorLines: 0,
    warningLines: 0,
  };
}
