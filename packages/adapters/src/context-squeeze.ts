import { textBoundary, truncatePlainText } from "@agentic-smith/core";

/**
 * Deterministic cold-history compression, in the spirit of context-squeeze.
 *
 * Recent turns stay byte-verbatim. Older text-only user/assistant messages are
 * reduced with priority-weighted sentence extraction, while exact facts such as
 * paths, commands, URLs, ticket ids, hashes and identifiers are kept as anchors.
 * Tool calls, tool results, images, system messages and protected messages are
 * never changed. No model call is made.
 */
export interface SqueezableMessage {
  role: string;
  content?: unknown;
  toolCallId?: string;
  toolName?: string;
}

export interface ContextSqueezeOptions {
  /** Most recent messages kept verbatim. */
  keepRecentMessages?: number;
  /** Histories shorter than this many messages are left untouched. */
  minMessagesBeforeCompression?: number;
  /** Target size of a compressed message as a fraction of its original size. */
  compressionRatio?: number;
  /** Cold messages shorter than this stay verbatim. */
  minMessageChars?: number;
  /** Preserve exact paths, commands, addresses, ids and similar facts. */
  anchorPreserve?: boolean;
  /** Indexes that must never be rewritten, such as the live request or constraints. */
  protectedIndexes?: ReadonlySet<number>;
}

export interface ContextSqueezeResult<T> {
  messages: T[];
  compressedMessages: number;
  charsBefore: number;
  charsAfter: number;
  anchorsKept: number;
}

const DEFAULT_KEEP_RECENT_MESSAGES = 6;
const DEFAULT_MIN_MESSAGES = 10;
const DEFAULT_COMPRESSION_RATIO = 0.3;
const DEFAULT_MIN_MESSAGE_CHARS = 400;
const MIN_COMPRESSED_BODY_CHARS = 48;
const TAG = "[earlier message, compressed] ";

export function squeezeColdMessages<T extends SqueezableMessage>(
  messages: readonly T[],
  options: ContextSqueezeOptions = {},
): ContextSqueezeResult<T> {
  const keepRecentMessages = clampInt(
    options.keepRecentMessages ?? DEFAULT_KEEP_RECENT_MESSAGES,
    1,
    200,
  );
  const minMessagesBeforeCompression = clampInt(
    options.minMessagesBeforeCompression ?? DEFAULT_MIN_MESSAGES,
    2,
    1_000,
  );
  const compressionRatio = clamp(options.compressionRatio ?? DEFAULT_COMPRESSION_RATIO, 0.05, 0.95);
  const minMessageChars = clampInt(options.minMessageChars ?? DEFAULT_MIN_MESSAGE_CHARS, 0, 8_000);
  const anchorPreserve = options.anchorPreserve !== false;
  const protectedIndexes = options.protectedIndexes;
  // Read each message's text once; long histories would otherwise be walked twice.
  const texts = messages.map(textOnly);
  const charsBefore = texts.reduce((sum, text) => sum + text.length, 0);

  if (messages.length < minMessagesBeforeCompression) {
    return {
      messages: [...messages],
      compressedMessages: 0,
      charsBefore,
      charsAfter: charsBefore,
      anchorsKept: 0,
    };
  }

  const coldEnd = Math.max(0, messages.length - keepRecentMessages);
  let compressedMessages = 0;
  let charsAfter = 0;
  let anchorsKept = 0;
  const out = messages.map((message, index) => {
    const text = texts[index]!;
    if (
      index >= coldEnd ||
      protectedIndexes?.has(index) ||
      text.length < Math.max(MIN_COMPRESSED_BODY_CHARS, minMessageChars) ||
      isAlreadyCompacted(text)
    ) {
      charsAfter += text.length;
      return message;
    }

    const allocation = Math.max(
      TAG.length + MIN_COMPRESSED_BODY_CHARS,
      Math.min(text.length - 1, Math.round(text.length * compressionRatio)),
    );
    const compressed = compressText(text, allocation, anchorPreserve);
    if (compressed.text.length >= text.length - 1) {
      charsAfter += text.length;
      return message;
    }

    compressedMessages += 1;
    charsAfter += compressed.text.length;
    anchorsKept += compressed.anchors;
    return replaceText(message, compressed.text);
  });

  return { messages: out, compressedMessages, charsBefore, charsAfter, anchorsKept };
}

function textOnly(message: SqueezableMessage): string {
  if (message.toolCallId || message.toolName) return "";
  if (message.role !== "user" && message.role !== "assistant") return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content) || message.content.length !== 1) return "";
  const parts: string[] = [];
  for (const part of message.content) {
    if (
      !part ||
      typeof part !== "object" ||
      (part as { type?: unknown }).type !== "text" ||
      typeof (part as { text?: unknown }).text !== "string"
    ) {
      return "";
    }
    parts.push((part as { text: string }).text);
  }
  return parts.join("\n");
}

function replaceText<T extends SqueezableMessage>(message: T, text: string): T {
  if (typeof message.content === "string") return { ...message, content: text };
  const parts = message.content as Array<{ type: string; text: string }>;
  const first = parts.find((part) => part.type === "text");
  return {
    ...message,
    content: [{ ...(first ?? { type: "text" }), text }],
  };
}

const SENSITIVE_ANCHOR_RE =
  /\b(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|key|auth|authorization|session|cookie|credential|signature|sig)\b\s*[=:]/i;
const BEARER_RE = /\bBearer\s+\S+/i;
const KEY_PREFIX_RE =
  /\b(?:sk[-_](?:or-v1-|live_|test_)?[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{20,}|AKIA[0-9A-Z]{16})\b/;
const JWT_RE = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/;

function isAlreadyCompacted(text: string): boolean {
  return (
    text.startsWith(TAG) ||
    text.includes("<compacted_thread_summary>") ||
    text.startsWith("Agentic Smith-owned compacted context through message sequence ") ||
    text.startsWith(
      "Memory recalled from earlier conversations that fell outside the visible history.",
    )
  );
}

interface CompressedText {
  text: string;
  anchors: number;
}

function compressText(text: string, budgetChars: number, anchorPreserve: boolean): CompressedText {
  const budget = Math.max(TAG.length + 1, Math.floor(budgetChars));
  if (budget <= TAG.length + MIN_COMPRESSED_BODY_CHARS) {
    return { text: `${TAG}${clip(text, Math.max(1, budget - TAG.length))}`, anchors: 0 };
  }

  const anchors = anchorPreserve ? extractAnchors(text) : [];
  const anchorCap = Math.min(Math.floor(budget * 0.4), Math.max(0, budget - TAG.length - 64));
  const anchorBlock = buildAnchorBlock(anchors, anchorCap);
  const anchorsKept = anchorBlock ? countAnchorItems(anchorBlock) : 0;
  const bodyBudget = Math.max(
    MIN_COMPRESSED_BODY_CHARS,
    budget - TAG.length - (anchorBlock ? anchorBlock.length + 1 : 0),
  );

  const body = isCodeLike(text)
    ? keepHeadAndTail(text, bodyBudget)
    : extractSentences(text, bodyBudget);
  const joined = anchorBlock ? `${anchorBlock} ${body}` : body;
  const clipped = clip(joined, Math.max(1, budget - TAG.length));
  return { text: `${TAG}${clipped}`, anchors: anchorsKept };
}

function extractSentences(text: string, budget: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= budget) return normalized;
  const sentences = splitSentences(normalized);
  if (sentences.length <= 1) return keepHeadAndTail(text, budget);

  const scored = sentences
    .map((sentence, index) => ({
      sentence,
      index,
      score: scoreSentence(sentence, index, sentences.length),
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index);

  const keep = new Set<number>();
  let used = 0;
  for (const candidate of scored) {
    const cost = candidate.sentence.length + (keep.size > 0 ? 1 : 0);
    if (used + cost <= budget) {
      keep.add(candidate.index);
      used += cost;
    }
    if (used >= budget) break;
  }
  if (keep.size === 0) return keepHeadAndTail(normalized, budget);
  return clip(sentences.filter((_, index) => keep.has(index)).join(" "), budget);
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z0-9`"'\w])/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

const DECISION_RE =
  /\b(decided|decision|agree|chose|chosen|will use|should use|must|requirement|requires|rule|constraint|remember|important|critical|bug|fix|broke|error|failed|root cause|conclusion|conclude|prefer|instead of|because|deadline|approved|do not|don't|never|must not|not allowed|avoid|without|unless)\b/i;
const PRONOUN_HEAVY_RE =
  /^(?:it|that|this|they|them|then|so|and|also|anyway|yeah|okay|ok|lol|haha)\b/i;

function scoreSentence(sentence: string, position: number, total: number): number {
  let score = 0;
  if (DECISION_RE.test(sentence)) score += 3;
  if (sentence.includes("?")) score += 2;
  if (sentence.length > 40 && sentence.length < 320) score += 1;
  score += Math.min(3, extractAnchors(sentence, 6).length * 0.75);
  if (position === 0) score += 1.5;
  else if (position / Math.max(1, total) > 0.8) score += 0.5;
  if (PRONOUN_HEAVY_RE.test(sentence) && score < 2) score -= 1.5;
  return score;
}

function isCodeLike(text: string): boolean {
  if (text.includes("```")) return true;
  const codeLines = text
    .split("\n")
    .filter((line) =>
      /^\s*(?:import|export|function|class|const|let|var|def|public|private)\b/.test(line),
    );
  return codeLines.length >= 2;
}

function keepHeadAndTail(text: string, budget: number): string {
  if (text.length <= budget) return text;
  if (budget <= 1) return "…";
  const headBudget = Math.floor(budget * 0.62);
  const tailBudget = Math.max(1, budget - headBudget - 3);
  const head = truncatePlainText(text, headBudget);
  const tailStart = textBoundary(text, text.length - tailBudget);
  return `${head.trimEnd()} … ${text.slice(tailStart)}`;
}

function clip(text: string, limit: number): string {
  if (text.length <= limit) return text;
  if (limit <= 0) return "";
  if (limit === 1) return "…";
  return `${truncatePlainText(text, limit - 1).trimEnd()}…`;
}

// ---- Anchor extraction ------------------------------------------------------

const ANCHOR_PATTERNS: Array<{ re: RegExp; kind: string }> = [
  { re: /(?:^|\s)(?:\/(?:[\w.@+-]+\/)*[\w.@+-]+\.[a-z]{1,8})(?=\s|$|[,)\]])/gi, kind: "path" },
  { re: /(?:^|\s)(?:\/(?:[\w.@+-]+\/)+[\w.@+-]+)(?=\s|$|[,)\]])/g, kind: "path" },
  { re: /(?:^|\s)(?:~\/[\w.@+-/]+)/gi, kind: "path" },
  {
    re: /\b[a-z][\w-]*\.(?:js|ts|tsx|jsx|py|json|md|sh|yaml|yml|html|css|scss|php|toml|conf|go|rs|java|rb)\b/gi,
    kind: "file",
  },
  { re: /(?:https?:\/\/|www\.)[^\s)>\\\]]+/gi, kind: "url" },
  {
    re: /\b(?:localhost:\d+|127\.0\.0\.1:\d+|192\.168\.\d+\.\d+(?::\d+)?|10\.\d+\.\d+\.\d+(?::\d+)?)\b/g,
    kind: "addr",
  },
  { re: /`[^`\n]{3,90}`/g, kind: "code" },
  {
    re: /\b(?:npm|yarn|pnpm|pip|apt|systemctl|docker|git|curl|ssh|sudo|make|cargo|python3?|node)\s+[^\n;]{4,90}/gi,
    kind: "cmd",
  },
  { re: /\b\d+(?:\.\d+)?\s?(?:GB|MB|KB|tb|ms|s\b|min|tokens?|tok\/s|%)/gi, kind: "metric" },
  { re: /\b[A-Z]{2,8}-\d{1,6}\b/g, kind: "ticket" },
  { re: /\b(?:port|pin|key|token|id|version|v)\s*[=:]\s*"?\S{1,40}/gi, kind: "kv" },
  { re: /\b[a-f0-9]{7,64}\b/g, kind: "hash" },
  { re: /\b[A-Z][A-Z0-9_]{2,28}\b/g, kind: "const" },
];

export function extractAnchors(text: string, cap = 24): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const { re } of ANCHOR_PATTERNS) {
    re.lastIndex = 0;
    for (let match = re.exec(text); match !== null; match = re.exec(text)) {
      const raw = match[0].trim().replace(/^[`"'(]+|[`"')]+$/g, "");
      if (!raw || raw.length < 3 || raw.length > 110) continue;
      if (isSensitiveAnchor(raw)) continue;
      const dedup = raw.toLowerCase();
      if (seen.has(dedup)) continue;
      seen.add(dedup);
      out.push(raw);
      if (out.length >= cap) return out;
    }
  }
  return out;
}

function isSensitiveAnchor(raw: string): boolean {
  return (
    SENSITIVE_ANCHOR_RE.test(raw) ||
    BEARER_RE.test(raw) ||
    KEY_PREFIX_RE.test(raw) ||
    JWT_RE.test(raw)
  );
}

function buildAnchorBlock(anchors: string[], cap: number): string {
  if (anchors.length === 0 || cap < 16) return "";
  const prefix = "[anchors: ";
  const suffix = "]";
  const chosen: string[] = [];
  for (const anchor of anchors) {
    const formatted = anchor.includes("`") ? anchor : `\`${anchor}\``;
    const candidate = `${prefix}${[...chosen, formatted].join(" · ")}${suffix}`;
    if (candidate.length > cap) break;
    chosen.push(formatted);
  }
  return chosen.length > 0 ? `${prefix}${chosen.join(" · ")}${suffix}` : "";
}

function countAnchorItems(block: string): number {
  return block.slice("[anchors: ".length, -1).split(" · ").filter(Boolean).length;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
}

function clampInt(value: number, min: number, max: number): number {
  return Math.round(clamp(value, min, max));
}
