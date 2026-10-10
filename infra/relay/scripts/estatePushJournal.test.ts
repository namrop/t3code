// @effect-diagnostics nodeBuiltinImport:off - A real isolated HTTP receiver is the test fixture.
import { afterEach, describe, expect, it } from "vite-plus/test";
import * as NodeHttp from "node:http";
import { EventJournal } from "./estatePushJournal.ts";
import type { AgentAwarenessState } from "@t3tools/shared/agentAwareness";
const now = Date.parse("2026-10-07T01:00:00Z");
const state = (phase: AgentAwarenessState["phase"]) =>
  ({
    environmentId: "env",
    threadId: "thread",
    phase,
    updatedAt: "2026-10-07T01:00:00Z",
    projectTitle: "Example project",
    threadTitle: "Release notes thread",
    headline: "Agent failed",
    detail: "The agent run failed.",
    deepLink: "/threads/env/thread",
  }) as AgentAwarenessState;
const journals: EventJournal[] = [];
const journal = () => {
  const j = new EventJournal(":memory:", () => now);
  journals.push(j);
  return j;
};
afterEach(() => {
  for (const j of journals.splice(0)) j.db.close();
});
const pending = (j: EventJournal) => j.db.prepare("SELECT * FROM pending").all();

describe("durable read-only T3 source journal", () => {
  it("does not alert for a fresh terminal snapshot", () => {
    const j = journal();
    j.observe(state("completed"), "thread", true);
    expect(pending(j)).toHaveLength(0);
  });
  it("catches a recent transition after reconnect with an existing baseline", () => {
    const j = journal();
    j.observe(state("running"), "thread", true);
    j.observe(state("completed"), "thread", true);
    expect(pending(j)).toHaveLength(1);
  });
  it("deduplicates replay and text-only shell updates", () => {
    const j = journal();
    j.observe(state("running"), "thread", true);
    j.observe(state("failed"), "thread", false);
    j.observe(state("failed"), "thread", false);
    expect(pending(j)).toHaveLength(1);
  });
  it("does not queue stale transitions", () => {
    const j = journal();
    j.observe({ ...state("failed"), updatedAt: "2026-10-07T00:49:59Z" }, "thread", false);
    expect(pending(j)).toHaveLength(0);
  });
  it("expires pending ingestion rather than sending an old event", async () => {
    const j = journal();
    j.observe(state("failed"), "thread", false);
    j.db.prepare("UPDATE pending SET expires=?").run(now / 1000 - 1);
    await j.flush("http://127.0.0.1:1/v1/events", "test-token");
    expect(pending(j)).toHaveLength(0);
  });
  it("keeps pending ingestion on HTTP failure then reconciles accepted retry", async () => {
    const j = journal();
    j.observe(state("failed"), "thread", false);
    let status = 503;
    let received = "";
    const server = NodeHttp.createServer((req, res) => {
      req.on("data", (chunk) => {
        received += chunk.toString();
      });
      req.on("end", () => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ queued: 1 }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test receiver failed");
    try {
      const url = `http://127.0.0.1:${address.port}/v1/events`;
      await expect(j.flush(url, "test-token")).rejects.toBeDefined();
      expect(pending(j)).toHaveLength(1);
      status = 200;
      received = "";
      await j.flush(url, "test-token");
      expect(pending(j)).toHaveLength(0);
      expect(JSON.parse(received)).toMatchObject({
        title: "Release notes thread",
        body: "Example project · Agent failed — The agent run failed.",
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
