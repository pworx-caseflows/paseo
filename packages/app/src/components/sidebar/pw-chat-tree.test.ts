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

// Build 8: order by dragging, finished chats last, state in words, topic rename, tabs in view.
import {
  findMovedRowKey,
  flattenPwChatTree,
  mergeReorderedTabs,
  pickTabsInView,
  planPwDrag,
  planPwTopicRename,
  readPwChatState,
} from "./pw-chat-tree-model";

describe("order", () => {
  test("a chat named (Finished) sits at the bottom of its list, main or topic", () => {
    const tree = buildPwChatTree(
      [
        agent({ id: "done", title: "(Finished) Old work", lastActivityAt: new Date("2026-10-11T12:00:00Z") }),
        agent({ id: "live", title: "Live work", lastActivityAt: new Date("2026-10-01T00:00:00Z") }),
        agent({ id: "t-done", title: "(Finished) NC 1", labels: { "pw.topic": "NC" } }),
        agent({ id: "t-live", title: "NC 2", labels: { "pw.topic": "NC" }, lastActivityAt: new Date("2026-09-01T00:00:00Z") }),
      ],
      "srv",
      "ws1",
    );
    expect(tree.loose.map((c) => c.agentId)).toEqual(["live", "done"]);
    expect(tree.topics[0]!.chats.map((c) => c.agentId)).toEqual(["t-live", "t-done"]);
  });

  test("dragged order wins over activity; topics follow their dragged order", () => {
    const tree = buildPwChatTree(
      [
        agent({ id: "x", labels: { "pw.order": "1" }, lastActivityAt: new Date("2026-10-11T00:00:00Z") }),
        agent({ id: "y", labels: { "pw.order": "0" }, lastActivityAt: new Date("2026-10-01T00:00:00Z") }),
        agent({ id: "a1", labels: { "pw.topic": "Alpha", "pw.topicOrder": "1" } }),
        agent({ id: "z1", labels: { "pw.topic": "Zulu", "pw.topicOrder": "0" } }),
      ],
      "srv",
      "ws1",
    );
    expect(tree.loose.map((c) => c.agentId)).toEqual(["y", "x"]);
    expect(tree.topics.map((t) => t.name)).toEqual(["Zulu", "Alpha"]);
  });
});

describe("dragging", () => {
  const tree = buildPwChatTree(
    [
      agent({ id: "m1", labels: { "pw.order": "0" } }),
      agent({ id: "m2", labels: { "pw.order": "1" } }),
      agent({ id: "n1", labels: { "pw.topic": "NC", "pw.order": "0", "pw.topicOrder": "0" } }),
      agent({ id: "s1", labels: { "pw.topic": "Sup", "pw.order": "0", "pw.topicOrder": "1" } }),
    ],
    "srv",
    "ws1",
  );
  const rows = flattenPwChatTree(tree, new Set());
  const move = (key: string, to: number) => {
    const next = rows.filter((r) => r.key !== key);
    next.splice(to, 0, rows.find((r) => r.key === key)!);
    return next;
  };

  test("the rows: main list first, then each topic with its chats", () => {
    expect(rows.map((r) => r.key)).toEqual([
      "chat:m1",
      "chat:m2",
      "topic:NC",
      "chat:n1",
      "topic:Sup",
      "chat:s1",
    ]);
  });

  test("A CHAT DROPPED UNDER A TOPIC MOVES INTO IT", () => {
    const writes = planPwDrag(tree, move("chat:m1", 3), "chat:m1");
    const m1 = writes.find((w) => w.agentId === "m1")!;
    expect(m1.labels["pw.topic"]).toBe("NC");
    expect(m1.labels["pw.topicOrder"]).toBe("0");
  });

  test("a chat dropped above every topic moves out of its topic", () => {
    const writes = planPwDrag(tree, move("chat:s1", 0), "chat:s1");
    const s1 = writes.find((w) => w.agentId === "s1")!;
    expect(s1.labels["pw.topic"]).toBe("");
    expect(s1.labels["pw.topicOrder"]).toBe("");
    expect(writes.find((w) => w.agentId === "m1")!.labels["pw.order"]).toBe("1");
  });

  test("reordering inside the main list renumbers it", () => {
    const writes = planPwDrag(tree, move("chat:m2", 0), "chat:m2");
    expect(writes).toEqual([
      { serverId: "srv", agentId: "m2", labels: { "pw.order": "0" } },
      { serverId: "srv", agentId: "m1", labels: { "pw.order": "1" } },
    ]);
  });

  test("dragging a topic moves the topic, not the chats", () => {
    const writes = planPwDrag(tree, move("topic:Sup", 2), "topic:Sup");
    expect(writes).toEqual([
      { serverId: "srv", agentId: "s1", labels: { "pw.topicOrder": "0" } },
      { serverId: "srv", agentId: "n1", labels: { "pw.topicOrder": "1" } },
    ]);
  });

  test("the moved row is found from before and after", () => {
    expect(findMovedRowKey(rows, move("chat:s1", 0))).toBe("chat:s1");
    expect(findMovedRowKey(rows, rows)).toBeNull();
  });
});

describe("topic rename", () => {
  test("every chat in the topic moves to the new name", () => {
    const tree = buildPwChatTree(
      [
        agent({ id: "a", labels: { "pw.topic": "NC" } }),
        agent({ id: "b", labels: { "pw.topic": "NC" } }),
        agent({ id: "c", labels: { "pw.topic": "Other" } }),
      ],
      "srv",
      "ws1",
    );
    expect(planPwTopicRename(tree, "NC", " Nonconformance ").map((w) => [w.agentId, w.labels])).toEqual([
      ["a", { "pw.topic": "Nonconformance" }],
      ["b", { "pw.topic": "Nonconformance" }],
    ]);
    expect(planPwTopicRename(tree, "NC", "NC")).toEqual([]);
  });
});

describe("state in words", () => {
  const base = { requiresAttention: false, attentionReason: null, pendingPermissions: [] };
  test("the states a tab shows", () => {
    expect(readPwChatState({ ...base, status: "running" } as never)).toBe("working");
    expect(readPwChatState({ ...base, status: "idle", requiresAttention: true, attentionReason: "finished" } as never)).toBe("finished");
    expect(readPwChatState({ ...base, status: "idle", requiresAttention: true, attentionReason: "permission" } as never)).toBe("waiting for you");
    expect(readPwChatState({ ...base, status: "error" } as never)).toBe("failed");
    expect(readPwChatState({ ...base, status: "idle" } as never)).toBeNull();
  });
});

describe("tabs in view", () => {
  const topicOf = (id: string) => ({ m1: "", m2: "", n1: "NC", n2: "NC" })[id] ?? null;
  const tab = (id: string, active = false, kind = "agent") => ({
    tab: { tabId: `t-${id}`, target: kind === "agent" ? { kind, agentId: id } : { kind } },
    isActive: active,
  });

  test("IN THE MAIN LIST YOU SEE THE MAIN LIST'S CHATS", () => {
    const shown = pickTabsInView([tab("m1", true), tab("m2"), tab("n1"), tab("n2")], topicOf);
    expect(shown.map((t) => t.tab.tabId)).toEqual(["t-m1", "t-m2"]);
  });

  test("IN A TOPIC YOU SEE THAT TOPIC'S CHATS", () => {
    const shown = pickTabsInView([tab("m1"), tab("m2"), tab("n1"), tab("n2", true)], topicOf);
    expect(shown.map((t) => t.tab.tabId)).toEqual(["t-n1", "t-n2"]);
  });

  test("a terminal tab always shows; a terminal in front shows every tab", () => {
    const shown = pickTabsInView([tab("m1", true), tab("n1"), tab("term", false, "terminal")], topicOf);
    expect(shown.map((t) => t.tab.tabId)).toEqual(["t-m1", "t-term"]);
    const all = pickTabsInView([tab("m1"), tab("n1"), tab("term", true, "terminal")], topicOf);
    expect(all).toHaveLength(3);
  });

  test("a reorder among the shown tabs keeps the hidden ones where they were", () => {
    const all = ["m1", "n1", "m2", "n2"].map((id) => ({ tabId: id }));
    const merged = mergeReorderedTabs(all, [{ tabId: "m2" }, { tabId: "m1" }]);
    expect(merged.map((t) => t.tabId)).toEqual(["m2", "n1", "m1", "n2"]);
  });
});
