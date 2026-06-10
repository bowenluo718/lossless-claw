import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLcmMigrations } from "../src/db/migration.js";
import { getLcmDbFeatures } from "../src/db/features.js";
import { ConversationStore } from "../src/store/conversation-store.js";
import { SummaryStore } from "../src/store/summary-store.js";

function createStores() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const { fts5Available } = getLcmDbFeatures(db);
  runLcmMigrations(db, { fts5Available });
  return {
    db,
    conversationStore: new ConversationStore(db, { fts5Available }),
    summaryStore: new SummaryStore(db, { fts5Available }),
  };
}

describe("SummaryStore shallow-tree helpers", () => {
  it("returns conversation max depth and leaf links for message hits", async () => {
    const { conversationStore, summaryStore } = createStores();
    const conversation = await conversationStore.createConversation({
      sessionId: "summary-store-links",
      title: "Summary store links",
    });
    const [firstMessage, secondMessage, tailMessage] = await conversationStore.createMessagesBulk([
      {
        conversationId: conversation.conversationId,
        seq: 1,
        role: "user",
        content: "first raw fact",
        tokenCount: 4,
      },
      {
        conversationId: conversation.conversationId,
        seq: 2,
        role: "assistant",
        content: "second raw fact",
        tokenCount: 4,
      },
      {
        conversationId: conversation.conversationId,
        seq: 3,
        role: "user",
        content: "fresh tail fact",
        tokenCount: 4,
      },
    ]);

    await summaryStore.insertSummary({
      summaryId: "sum_leaf_a",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: "leaf A",
      tokenCount: 5,
    });
    await summaryStore.insertSummary({
      summaryId: "sum_leaf_b",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: "leaf B",
      tokenCount: 5,
    });
    await summaryStore.insertSummary({
      summaryId: "sum_root",
      conversationId: conversation.conversationId,
      kind: "condensed",
      depth: 2,
      content: "root summary",
      tokenCount: 6,
    });

    await summaryStore.linkSummaryToMessages("sum_leaf_a", [firstMessage.messageId]);
    await summaryStore.linkSummaryToMessages("sum_leaf_b", [secondMessage.messageId]);

    await expect(
      summaryStore.getConversationMaxSummaryDepth(conversation.conversationId),
    ).resolves.toBe(2);

    await expect(
      summaryStore.getLeafSummaryLinksForMessageIds(conversation.conversationId, [
        tailMessage.messageId,
        secondMessage.messageId,
        firstMessage.messageId,
      ]),
    ).resolves.toEqual([
      {
        messageId: secondMessage.messageId,
        summaryId: "sum_leaf_b",
      },
      {
        messageId: firstMessage.messageId,
        summaryId: "sum_leaf_a",
      },
    ]);
  });

  it("uses content recency for fallback summary search ordering and time filters", async () => {
    const { db, conversationStore, summaryStore } = createStores();
    const conversation = await conversationStore.createConversation({
      sessionId: "summary-store-search-time",
      title: "Summary search time",
    });

    await summaryStore.insertSummary({
      summaryId: "sum_regex_old_content_recent_compaction",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: "pagedrop regression historical request",
      tokenCount: 5,
      latestAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    await summaryStore.insertSummary({
      summaryId: "sum_regex_recent_content_older_compaction",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: "pagedrop regression recent request",
      tokenCount: 5,
      latestAt: new Date("2026-01-09T00:00:00.000Z"),
    });

    db.prepare("UPDATE summaries SET created_at = ? WHERE summary_id = ?").run(
      "2026-01-10T00:00:00.000Z",
      "sum_regex_old_content_recent_compaction",
    );
    db.prepare("UPDATE summaries SET created_at = ? WHERE summary_id = ?").run(
      "2026-01-05T00:00:00.000Z",
      "sum_regex_recent_content_older_compaction",
    );

    await expect(
      summaryStore.searchSummaries({
        conversationId: conversation.conversationId,
        query: "pagedrop regression",
        mode: "regex",
        limit: 10,
      }),
    ).resolves.toMatchObject([
      {
        summaryId: "sum_regex_recent_content_older_compaction",
        createdAt: new Date("2026-01-09T00:00:00.000Z"),
      },
      {
        summaryId: "sum_regex_old_content_recent_compaction",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    ]);

    await expect(
      summaryStore.searchSummaries({
        conversationId: conversation.conversationId,
        query: "pagedrop regression",
        mode: "regex",
        since: new Date("2026-01-05T00:00:00.000Z"),
        limit: 10,
      }),
    ).resolves.toMatchObject([
      {
        summaryId: "sum_regex_recent_content_older_compaction",
      },
    ]);
  });

  it("rejects large-file dedup reads outside the configured root", async () => {
    const { conversationStore, summaryStore } = createStores();
    const safeRoot = mkdtempSync(join(tmpdir(), "lcm-safe-root-"));
    const outsideRoot = mkdtempSync(join(tmpdir(), "lcm-outside-root-"));
    try {
      const conversation = await conversationStore.createConversation({
        sessionId: "summary-store-safe-large-file-read",
        title: "Summary store safe large file read",
      });
      const outsideFile = join(outsideRoot, "payload.txt");
      writeFileSync(outsideFile, "outside payload", "utf8");

      await summaryStore.insertLargeFile({
        fileId: "file_1234567890abcdef",
        conversationId: conversation.conversationId,
        fileName: "payload.txt",
        mimeType: "text/plain",
        byteSize: Buffer.byteLength("outside payload", "utf8"),
        storageUri: outsideFile,
        explorationSummary: "outside payload",
      });

      await expect(
        summaryStore.largeFileContentEquals("file_1234567890abcdef", "outside payload", {
          largeFilesDir: safeRoot,
        }),
      ).resolves.toBe(false);
      await expect(
        summaryStore.getLargeFileContent("file_1234567890abcdef", {
          largeFilesDir: safeRoot,
        }),
      ).resolves.toBeNull();
    } finally {
      rmSync(safeRoot, { recursive: true, force: true });
      rmSync(outsideRoot, { recursive: true, force: true });
    }
  });

  it("compares large-file dedup content above the describe read cap", async () => {
    const { conversationStore, summaryStore } = createStores();
    const safeRoot = mkdtempSync(join(tmpdir(), "lcm-safe-large-root-"));
    try {
      const conversation = await conversationStore.createConversation({
        sessionId: "summary-store-large-dedup-read",
        title: "Summary store large dedup read",
      });
      const payload = `${"large payload line\n".repeat(36_000)}done`;
      const payloadPath = join(safeRoot, "large-payload.txt");
      writeFileSync(payloadPath, payload, "utf8");

      await summaryStore.insertLargeFile({
        fileId: "file_abcdef1234567890",
        conversationId: conversation.conversationId,
        fileName: "large-payload.txt",
        mimeType: "text/plain",
        byteSize: Buffer.byteLength(payload, "utf8"),
        storageUri: payloadPath,
        explorationSummary: "large payload",
      });

      await expect(
        summaryStore.largeFileContentEquals("file_abcdef1234567890", payload, {
          largeFilesDir: safeRoot,
        }),
      ).resolves.toBe(true);
    } finally {
      rmSync(safeRoot, { recursive: true, force: true });
    }
  });
});
