import { describe, expect, test } from "vitest";
import type { Agent } from "@/stores/session-store";
import { buildPwChatTree } from "./pw-chat-tree-model";

// What this is about, in one sentence: a workspace's OPEN chats show under its row, inside their
// topic when they have one and straight under the workspace when they do not.

function agent(partial: Partial<Agent> & { id: string }): Agent {
  return {
    serverId: "srv",
    workspaceId: "ws1",
    title: partial.id,
    labels: {},
    archivedAt: null,
    parentAgentId: null,
    lastActivityAt: new Date("2026-10-11T10:00:00Z"),
    ...partial,
  } as Agent;
}

describe("buildPwChatTree", () => {
  test("chats with a topic group under it, chats without one sit under the workspace", () => {
    const tree = buildPwChatTree(
      [
        agent({ id: "a", title: "NC 12 root cause", labels: { "pw.topic": "Nonconformance" } }),
        agent({ id: "b", title: "Supplier survey", labels: { "pw.topic": "Suppliers" } }),
        agent({ id: "c", title: "Paseo project management" }),
      ],
      "srv",
      "ws1",
    );
    expect(tree.topics.map((t) => t.name)).toEqual(["Nonconformance", "Suppliers"]);
    expect(tree.topics[0]!.chats.map((c) => c.title)).toEqual(["NC 12 root cause"]);
    expect(tree.loose.map((c) => c.title)).toEqual(["Paseo project management"]);
  });

  test("an empty topic means no topic", () => {
    const tree = buildPwChatTree([agent({ id: "a", labels: { "pw.topic": "  " } })], "srv", "ws1");
    expect(tree.topics).toEqual([]);
    expect(tree.loose.map((c) => c.agentId)).toEqual(["a"]);
  });

  test("closed chats, workers and other workspaces' chats are left out", () => {
    const tree = buildPwChatTree(
      [
        agent({ id: "closed", archivedAt: new Date() }),
        agent({ id: "worker", parentAgentId: "a" }),
        agent({ id: "elsewhere", workspaceId: "ws2" }),
        agent({ id: "other-host", serverId: "srv2" }),
        agent({ id: "open" }),
      ],
      "srv",
      "ws1",
    );
    expect(tree.loose.map((c) => c.agentId)).toEqual(["open"]);
  });

  test("newest activity first inside a group", () => {
    const tree = buildPwChatTree(
      [
        agent({ id: "old", lastActivityAt: new Date("2026-10-01T00:00:00Z") }),
        agent({ id: "new", lastActivityAt: new Date("2026-10-11T00:00:00Z") }),
      ],
      "srv",
      "ws1",
    );
    expect(tree.loose.map((c) => c.agentId)).toEqual(["new", "old"]);
  });
});
