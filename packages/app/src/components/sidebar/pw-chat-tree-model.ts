// PW build: the pure half of the sidebar chat tree (pw-chat-tree.tsx), kept free of UI imports
// so it is tested on its own.

import type { Agent } from "@/stores/session-store";
import {
  collectAllTabs,
  findPaneById,
  type SplitNode,
  type SplitPane,
  type WorkspaceLayout,
} from "@/stores/workspace-layout-actions";
import { deriveSidebarStateBucket } from "@/utils/sidebar-agent-state";

function firstPane(node: SplitNode): SplitPane | null {
  if (node.kind === "pane") return node.pane;
  for (const child of node.group.children) {
    const pane = firstPane(child);
    if (pane) return pane;
  }
  return null;
}

/**
 * The chat whose tab is in front in a workspace: the focused tab of the focused pane, or of the
 * first pane when no pane holds focus. Null when that tab is not a chat.
 */
export function pickFocusedAgentId(layout: WorkspaceLayout | undefined): string | null {
  if (!layout) return null;
  const pane = findPaneById(layout.root, layout.focusedPaneId) ?? firstPane(layout.root);
  if (!pane?.focusedTabId) return null;
  const tab = collectAllTabs(layout.root).find((t) => t.tabId === pane.focusedTabId);
  return tab?.target.kind === "agent" ? tab.target.agentId : null;
}

/** The chat's topic. Empty means none (label updates are merge patches and cannot delete a key). */
export const PW_TOPIC_LABEL = "pw.topic";
/** The chat's place in its list, set by dragging. Empty means never placed: it sits at the top. */
export const PW_ORDER_LABEL = "pw.order";
/** Its topic's place among the topics, carried by every chat in the topic. */
export const PW_TOPIC_ORDER_LABEL = "pw.topicOrder";
/** The wrap-up marks a finished chat by starting its name with this. */
export const PW_FINISHED_PREFIX = "(Finished)";

/** What a chat is doing, in words: the states a chat's tab shows. Null when there is nothing to say. */
export type PwChatState = "waiting for you" | "failed" | "working" | "finished" | null;

export interface PwChat {
  serverId: string;
  agentId: string;
  title: string;
  topic: string;
  /** Its place from dragging; null when never placed. */
  order: number | null;
  topicOrder: number | null;
  finished: boolean;
  state: PwChatState;
  lastActivityAt: number;
}

export interface PwChatTreeModel {
  topics: { name: string; chats: PwChat[] }[];
  loose: PwChat[];
}

export function readPwTopic(labels: Record<string, string> | undefined): string {
  return (labels?.[PW_TOPIC_LABEL] ?? "").trim();
}

function readNumber(labels: Record<string, string> | undefined, key: string): number | null {
  const raw = (labels?.[key] ?? "").trim();
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/** Open: not archived, and not a worker another chat started. */
export function isOpenPwChat(agent: Agent): boolean {
  return !agent.archivedAt && !agent.parentAgentId;
}

export function isFinishedTitle(title: string): boolean {
  return title.trim().toLowerCase().startsWith(PW_FINISHED_PREFIX.toLowerCase());
}

export function readPwChatState(
  agent: Pick<Agent, "status" | "requiresAttention" | "attentionReason" | "pendingPermissions">,
): PwChatState {
  const bucket = deriveSidebarStateBucket({
    status: agent.status,
    requiresAttention: Boolean(agent.requiresAttention),
    attentionReason: agent.attentionReason ?? null,
    pendingPermissionCount: agent.pendingPermissions?.length ?? 0,
  });
  switch (bucket) {
    case "needs_input":
      return "waiting for you";
    case "failed":
      return "failed";
    case "running":
      return "working";
    case "attention":
      return "finished";
    default:
      return null;
  }
}

export function toPwChat(agent: Agent): PwChat {
  const title = agent.title?.trim() || "New chat";
  return {
    serverId: agent.serverId,
    agentId: agent.id,
    title,
    topic: readPwTopic(agent.labels),
    order: readNumber(agent.labels, PW_ORDER_LABEL),
    topicOrder: readNumber(agent.labels, PW_TOPIC_ORDER_LABEL),
    finished: isFinishedTitle(title),
    state: readPwChatState(agent),
    lastActivityAt: new Date(agent.lastActivityAt).getTime() || 0,
  };
}

/**
 * The order inside one list. Finished chats always go last. Before them: chats never placed by
 * dragging, newest first, then placed chats in their dragged order.
 */
export function comparePwChats(a: PwChat, b: PwChat): number {
  if (a.finished !== b.finished) return a.finished ? 1 : -1;
  if ((a.order === null) !== (b.order === null)) return a.order === null ? -1 : 1;
  if (a.order !== null && b.order !== null && a.order !== b.order) return a.order - b.order;
  return b.lastActivityAt - a.lastActivityAt;
}

/** A topic's place: the smallest order any of its chats carries; unplaced topics after, A-Z. */
function topicPlace(chats: readonly PwChat[]): number | null {
  let place: number | null = null;
  for (const chat of chats) {
    if (chat.topicOrder !== null && (place === null || chat.topicOrder < place)) {
      place = chat.topicOrder;
    }
  }
  return place;
}

/** The tree for one workspace's chats: the main list, then the topics. */
export function buildPwChatTree(
  agents: readonly Agent[],
  serverId: string,
  workspaceId: string,
): PwChatTreeModel {
  const byTopic = new Map<string, PwChat[]>();
  const loose: PwChat[] = [];
  for (const agent of agents) {
    if (!isOpenPwChat(agent)) continue;
    if (agent.serverId !== serverId || agent.workspaceId !== workspaceId) continue;
    const chat = toPwChat(agent);
    if (chat.topic) {
      const list = byTopic.get(chat.topic) ?? [];
      list.push(chat);
      byTopic.set(chat.topic, list);
    } else {
      loose.push(chat);
    }
  }
  const topics = [...byTopic.entries()]
    .map(([name, chats]) => ({ name, chats: chats.sort(comparePwChats), place: topicPlace(chats) }))
    .sort((a, b) => {
      if ((a.place === null) !== (b.place === null)) return a.place === null ? 1 : -1;
      if (a.place !== null && b.place !== null && a.place !== b.place) return a.place - b.place;
      return a.name.localeCompare(b.name);
    })
    .map(({ name, chats }) => ({ name, chats }));
  return { topics, loose: loose.sort(comparePwChats) };
}

/** One row of the sidebar list, in the order drawn: the main list's chats, then each topic. */
export type PwTreeRow =
  | { kind: "chat"; key: string; chat: PwChat }
  | { kind: "topic"; key: string; name: string; count: number; folded: boolean };

export function flattenPwChatTree(
  tree: PwChatTreeModel,
  folded: ReadonlySet<string>,
): PwTreeRow[] {
  const rows: PwTreeRow[] = tree.loose.map((chat) => ({
    kind: "chat" as const,
    key: `chat:${chat.agentId}`,
    chat,
  }));
  for (const topic of tree.topics) {
    const isFolded = folded.has(topic.name);
    rows.push({
      kind: "topic",
      key: `topic:${topic.name}`,
      name: topic.name,
      count: topic.chats.length,
      folded: isFolded,
    });
    if (isFolded) continue;
    for (const chat of topic.chats) {
      rows.push({ kind: "chat", key: `chat:${chat.agentId}`, chat });
    }
  }
  return rows;
}

/** A label write for one chat. Only labels that change are listed. */
export interface PwLabelWrite {
  serverId: string;
  agentId: string;
  labels: Record<string, string>;
}

function pushWrite(
  writes: PwLabelWrite[],
  chat: PwChat,
  labels: Record<string, string>,
): void {
  const changed: Record<string, string> = {};
  if (labels[PW_TOPIC_LABEL] !== undefined && labels[PW_TOPIC_LABEL] !== chat.topic) {
    changed[PW_TOPIC_LABEL] = labels[PW_TOPIC_LABEL];
  }
  if (labels[PW_ORDER_LABEL] !== undefined && labels[PW_ORDER_LABEL] !== String(chat.order ?? "")) {
    changed[PW_ORDER_LABEL] = labels[PW_ORDER_LABEL];
  }
  if (
    labels[PW_TOPIC_ORDER_LABEL] !== undefined &&
    labels[PW_TOPIC_ORDER_LABEL] !== String(chat.topicOrder ?? "")
  ) {
    changed[PW_TOPIC_ORDER_LABEL] = labels[PW_TOPIC_ORDER_LABEL];
  }
  if (Object.keys(changed).length === 0) return;
  writes.push({ serverId: chat.serverId, agentId: chat.agentId, labels: changed });
}

/**
 * What a drag changes, from the rows as they are after the drop.
 *
 * A dragged chat belongs to the topic whose row is above it, or to the main list when no topic
 * row is above it - so dragging moves a chat into a topic, between topics, or out of one. Every
 * chat in a list it touched is numbered in its new order. A dragged topic moves with all its
 * chats, folded ones included: every topic is numbered in its new order on every one of its chats.
 */
export function planPwDrag(
  tree: PwChatTreeModel,
  rowsAfterDrop: readonly PwTreeRow[],
  draggedKey: string,
): PwLabelWrite[] {
  const writes: PwLabelWrite[] = [];
  const dragged = rowsAfterDrop.find((row) => row.key === draggedKey);
  if (!dragged) return writes;

  if (dragged.kind === "topic") {
    const order = rowsAfterDrop.flatMap((row) => (row.kind === "topic" ? [row.name] : []));
    order.forEach((name, index) => {
      const topic = tree.topics.find((entry) => entry.name === name);
      for (const chat of topic?.chats ?? []) {
        pushWrite(writes, chat, { [PW_TOPIC_ORDER_LABEL]: String(index) });
      }
    });
    return writes;
  }

  // Which list each visible chat sits in after the drop.
  const listOf = new Map<string, string>();
  const visibleOrder = new Map<string, string[]>();
  let current = "";
  for (const row of rowsAfterDrop) {
    if (row.kind === "topic") {
      current = row.name;
      continue;
    }
    listOf.set(row.chat.agentId, current);
    const list = visibleOrder.get(current) ?? [];
    list.push(row.chat.agentId);
    visibleOrder.set(current, list);
  }
  const from = dragged.chat.topic;
  const to = listOf.get(dragged.chat.agentId) ?? from;
  const touched = new Set([from, to]);
  const all = [...tree.loose, ...tree.topics.flatMap((topic) => topic.chats)];
  const topicOrderOf = (name: string): string | undefined => {
    if (!name) return undefined;
    const place = topicPlace(tree.topics.find((entry) => entry.name === name)?.chats ?? []);
    return place === null ? undefined : String(place);
  };

  for (const list of touched) {
    const ids = visibleOrder.get(list) ?? [];
    ids.forEach((agentId, index) => {
      const chat = all.find((entry) => entry.agentId === agentId);
      if (!chat) return;
      const labels: Record<string, string> = {
        [PW_TOPIC_LABEL]: list,
        [PW_ORDER_LABEL]: String(index),
      };
      // A chat joining a topic takes that topic's place among the topics; leaving one, it drops it.
      if (chat.topic !== list) {
        labels[PW_TOPIC_ORDER_LABEL] = topicOrderOf(list) ?? "";
      }
      pushWrite(writes, chat, labels);
    });
  }
  return writes;
}

/**
 * The row a drag moved, from the rows before and after: the one row whose removal leaves both in
 * the same order. Null when nothing moved.
 */
export function findMovedRowKey(
  before: readonly { key: string }[],
  after: readonly { key: string }[],
): string | null {
  const same = (a: readonly string[], b: readonly string[]) =>
    a.length === b.length && a.every((key, index) => key === b[index]);
  const b = before.map((row) => row.key);
  const a = after.map((row) => row.key);
  if (same(a, b)) return null;
  for (const key of b) {
    if (b.indexOf(key) === a.indexOf(key)) continue;
    const without = (list: string[]) => list.filter((entry) => entry !== key);
    if (same(without(a), without(b))) return key;
  }
  return null;
}

/** Rename a topic: every chat in it, folded or not, moves to the new name. */
export function planPwTopicRename(
  tree: PwChatTreeModel,
  from: string,
  to: string,
): PwLabelWrite[] {
  const name = to.trim();
  const topic = tree.topics.find((entry) => entry.name === from);
  if (!topic || !name || name === from) return [];
  const writes: PwLabelWrite[] = [];
  for (const chat of topic.chats) {
    pushWrite(writes, chat, { [PW_TOPIC_LABEL]: name });
  }
  return writes;
}

/** The fields of a tab this needs; the tab row's own items carry more. */
export interface PwTabItem {
  tab: { tabId: string; target: { kind: string; agentId?: string } };
  isActive: boolean;
}

/**
 * The tabs for the list you are in. When the tab in front is a chat, the chat tabs shown are the
 * chats in the same list - the main list, or the same topic. Tabs that are not chats (terminals,
 * files) always show. When the tab in front is not a chat, every tab shows.
 */
export function pickTabsInView<T extends PwTabItem>(
  items: readonly T[],
  topicOf: (agentId: string) => string | null,
): T[] {
  const active = items.find((item) => item.isActive);
  const activeId = active?.tab.target.kind === "agent" ? active.tab.target.agentId : undefined;
  if (!activeId) return [...items];
  const list = topicOf(activeId) ?? "";
  return items.filter((item) => {
    if (item.tab.target.kind !== "agent" || !item.tab.target.agentId) return true;
    return (topicOf(item.tab.target.agentId) ?? "") === list;
  });
}

/**
 * A reorder made among the tabs shown, put back into the whole tab list: the shown tabs take the
 * new order in the places they held; the hidden ones stay exactly where they were.
 */
export function mergeReorderedTabs<T extends { tabId: string }>(
  all: readonly T[],
  reorderedShown: readonly T[],
): T[] {
  const shown = new Set(reorderedShown.map((tab) => tab.tabId));
  const queue = [...reorderedShown];
  return all.map((tab) => (shown.has(tab.tabId) ? (queue.shift() ?? tab) : tab));
}
