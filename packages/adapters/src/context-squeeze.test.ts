import { describe, expect, it } from "vitest";
import { extractAnchors, squeezeColdMessages } from "./context-squeeze.js";

const longMessage = (index: number) =>
  `Message ${index}. We decided to use the migration plan because it preserves existing data. ` +
  `The exact file is /workspace/important-${index}.ts and the ticket is TICKET-${1000 + index}. ` +
  `This paragraph contains routine background that should not consume the whole context window. `.repeat(
    8,
  );

describe("cold-history squeezing", () => {
  it("compresses cold prose, keeps recent messages byte-verbatim, and preserves anchors", () => {
    const history = Array.from({ length: 12 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: longMessage(index),
    }));

    const result = squeezeColdMessages(history, {
      keepRecentMessages: 6,
      minMessagesBeforeCompression: 10,
      compressionRatio: 0.2,
      minMessageChars: 100,
    });

    expect(result.compressedMessages).toBe(6);
    expect(result.charsAfter).toBeLessThan(result.charsBefore);
    expect(result.messages.slice(6)).toEqual(history.slice(6));
    expect(result.messages[0]!.content).toContain("[earlier message, compressed]");
    expect(result.messages[0]!.content).toContain("/workspace/important-0.ts");
    expect(result.messages[0]!.content).toContain("TICKET-1000");
    expect(result.anchorsKept).toBeGreaterThan(0);
  });

  it("never rewrites tool pairs, protected messages, or already-compacted summaries", () => {
    const toolCall = {
      role: "assistant",
      content: [{ type: "toolCall", id: "call", name: "read", arguments: {} }],
    };
    const toolResult = {
      role: "toolResult",
      toolCallId: "call",
      toolName: "read",
      content: longMessage(1),
    };
    const protectedMessage = { role: "user", content: longMessage(2) };
    const summary = {
      role: "user",
      content: `Agentic Smith-owned compacted context through message sequence 4.\n\n${longMessage(3)}`,
    };
    const history = [
      { role: "user", content: longMessage(0) },
      toolCall,
      toolResult,
      protectedMessage,
      summary,
      ...Array.from({ length: 5 }, (_, index) => ({
        role: "user" as const,
        content: longMessage(index + 4),
      })),
    ];

    const result = squeezeColdMessages(history, {
      keepRecentMessages: 2,
      minMessagesBeforeCompression: 2,
      compressionRatio: 0.2,
      minMessageChars: 100,
      protectedIndexes: new Set([3]),
    });

    expect(result.messages[1]).toBe(toolCall);
    expect(result.messages[2]).toBe(toolResult);
    expect(result.messages[3]).toBe(protectedMessage);
    expect(result.messages[4]).toBe(summary);
  });

  it("leaves short histories and short messages untouched", () => {
    const short = Array.from({ length: 20 }, (_, index) => ({
      role: "user",
      content: `short ${index}`,
    }));
    const result = squeezeColdMessages(short, {
      minMessagesBeforeCompression: 10,
      minMessageChars: 400,
    });
    expect(result.compressedMessages).toBe(0);
    expect(result.messages).toEqual(short);
  });

  it("leaves multi-part messages untouched so provider metadata is not dropped", () => {
    const multiPart = {
      role: "user",
      content: [
        { type: "text", text: longMessage(0) },
        { type: "text", text: longMessage(1), cache_control: { type: "ephemeral" } },
      ],
    };
    const history = [
      multiPart,
      ...Array.from({ length: 10 }, (_, index) => ({
        role: "user" as const,
        content: longMessage(index + 2),
      })),
    ];

    const result = squeezeColdMessages(history, {
      keepRecentMessages: 2,
      minMessagesBeforeCompression: 2,
      compressionRatio: 0.2,
      minMessageChars: 100,
    });

    expect(result.messages[0]).toBe(multiPart);
    expect(result.messages[0]!.content).toEqual(multiPart.content);
  });

  it("does not preserve credential-shaped anchors", () => {
    const anchors = extractAnchors(
      "Use token=super-secret-value, password=hunter2, auth=session-secret, Bearer abc123, " +
        "and sk_live_abcdefghijk at /workspace/app, while the real file is " +
        "https://example.test/file?token=also-secret.",
    );
    expect(anchors).toContain("/workspace/app");
    expect(anchors.join("\n")).not.toContain("super-secret-value");
    expect(anchors.join("\n")).not.toContain("hunter2");
    expect(anchors.join("\n")).not.toContain("abc123");
    expect(anchors.join("\n")).not.toContain("session-secret");
    expect(anchors.join("\n")).not.toContain("sk_live_abcdefghijk");
    expect(anchors.join("\n")).not.toContain("also-secret");
  });

  it("extracts exact paths, commands, URLs, tickets, and identifiers", () => {
    const anchors = extractAnchors(
      "Run pnpm test in /workspace/app, then open https://example.test/run/42 for TICKET-1234. " +
        "Use OPENAI_API_KEY and commit a5bb10eb6bdc95823faeb67d6545b23e.",
    );
    expect(anchors).toContain("/workspace/app");
    expect(anchors).toContain("https://example.test/run/42");
    expect(anchors).toContain("TICKET-1234");
    expect(anchors).toContain("OPENAI_API_KEY");
    expect(anchors).toContain("a5bb10eb6bdc95823faeb67d6545b23e");
  });
});
