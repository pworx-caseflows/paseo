import { describe, expect, test } from "vitest";
import type { Agent } from "@/stores/session-store";
import type { WorkspaceLayout } from "@/stores/workspace-layout-actions";
import { buildPwChatTree, pickFocusedAgentId } from "./pw-chat-tree-model";

// The chat marked in the sidebar is the one whose tab is in front.
function layoutWith(
  panes: { id: string; focused: string | null; tabs: { id: string; agent?: string }[] }[],
  focusedPaneId: string | null,
): WorkspaceLayout {
  const toPane = (p: (typeof panes)[number]) => ({
    kind: "pane" as const,
    pane: {
      id: p.id,
      tabIds: p.tabs.map((t) => t.id),
      focusedTabId: p.focused,
      tabs: p.tabs.map((t) => ({
        tabId: t.id,
        createdAt: 0,
        target: t.agent ? { kind: "agent", agentId: t.agent } : { kind: "terminal", terminalId: t.id },
      })),
    },
  });
  const root =
    panes.length === 1
      ? toPane(panes[0]!)
      : {
          kind: "group" as const,
          group: { id: "g", direction: "horizontal", sizes: [], children: panes.map(toPane) },
        };
  return { root, focusedPaneId } as unknown as WorkspaceLayout;
}

describe("pickFocusedAgentId", () => {
  test("the focused tab of the focused pane", () => {
    const layout = layoutWith(
      [
        { id: "p1", focused: "t1", tabs: [{ id: "t1", agent: "a1" }] },
        { id: "p2", focused: "t3", tabs: [{ id: "t2", agent: "a2" }, { id: "t3", agent: "a3" }] },
      ],
      "p2",
    );
    expect(pickFocusedAgentId(layout)).toBe("a3");
  });

  test("with no pane focused, the first pane's front tab", () => {
    const layout = layoutWith([{ id: "p1", focused: "t1", tabs: [{ id: "t1", agent: "a1" }] }], null);
    expect(pickFocusedAgentId(layout)).toBe("a1");
  });

  test("a terminal in front marks no chat", () => {
    const layout = layoutWith([{ id: "p1", focused: "t1", tabs: [{ id: "t1" }] }], "p1");
    expect(pickFocusedAgentId(layout)).toBeNull();
  });

  test("no layout, nothing marked", () => {
    expect(pickFocusedAgentId(undefined)).toBeNull();
  });
});

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
