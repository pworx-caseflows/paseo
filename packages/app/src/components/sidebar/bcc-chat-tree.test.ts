import { describe, expect, test } from "vitest";
import type { Agent } from "@/stores/session-store";
import { buildBccChatTree } from "./bcc-chat-tree";

// What this is about, in one sentence: a project's OPEN chats show under it, inside their topic
// when they have one and straight under the project when they do not.

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

const keys = new Set(["srv:ws1"]);

describe("buildBccChatTree", () => {
  test("chats with a topic group under it, chats without one sit under the project", () => {
    const tree = buildBccChatTree(
      [
        agent({ id: "a", title: "NC 12 root cause", labels: { "bcc.topic": "Nonconformance" } }),
        agent({ id: "b", title: "Supplier survey", labels: { "bcc.topic": "Suppliers" } }),
        agent({ id: "c", title: "Paseo project management" }),
      ],
      keys,
    );
    expect(tree.topics.map((t) => t.name)).toEqual(["Nonconformance", "Suppliers"]);
    expect(tree.topics[0]!.chats.map((c) => c.title)).toEqual(["NC 12 root cause"]);
    expect(tree.loose.map((c) => c.title)).toEqual(["Paseo project management"]);
  });

  test("an empty topic means no topic", () => {
    const tree = buildBccChatTree([agent({ id: "a", labels: { "bcc.topic": "  " } })], keys);
    expect(tree.topics).toEqual([]);
    expect(tree.loose.map((c) => c.agentId)).toEqual(["a"]);
  });

  test("archived chats, workers and other projects' chats are left out", () => {
    const tree = buildBccChatTree(
      [
        agent({ id: "closed", archivedAt: new Date() }),
        agent({ id: "worker", parentAgentId: "a" }),
        agent({ id: "elsewhere", workspaceId: "ws2" }),
        agent({ id: "open" }),
      ],
      keys,
    );
    expect(tree.loose.map((c) => c.agentId)).toEqual(["open"]);
  });

  test("newest activity first inside a group", () => {
    const tree = buildBccChatTree(
      [
        agent({ id: "old", lastActivityAt: new Date("2026-10-01T00:00:00Z") }),
        agent({ id: "new", lastActivityAt: new Date("2026-10-11T00:00:00Z") }),
      ],
      keys,
    );
    expect(tree.loose.map((c) => c.agentId)).toEqual(["new", "old"]);
  });
});
