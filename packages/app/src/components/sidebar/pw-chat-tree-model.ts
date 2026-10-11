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

export const PW_TOPIC_LABEL = "pw.topic";

export interface PwChat {
  serverId: string;
  agentId: string;
  title: string;
  topic: string;
  lastActivityAt: number;
}

export interface PwChatTreeModel {
  topics: { name: string; chats: PwChat[] }[];
  loose: PwChat[];
}

/** A chat's topic; empty means none (label updates are merge patches and cannot delete a key). */
export function readPwTopic(labels: Record<string, string> | undefined): string {
  return (labels?.[PW_TOPIC_LABEL] ?? "").trim();
}

/** Open: not archived, and not a worker another chat started. */
export function isOpenPwChat(agent: Agent): boolean {
  return !agent.archivedAt && !agent.parentAgentId;
}

/** The tree for one workspace's chats. Newest activity first; topics A-Z. */
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
    const chat: PwChat = {
      serverId: agent.serverId,
      agentId: agent.id,
      title: agent.title?.trim() || "New chat",
      topic: readPwTopic(agent.labels),
      lastActivityAt: new Date(agent.lastActivityAt).getTime() || 0,
    };
    if (chat.topic) {
      const list = byTopic.get(chat.topic) ?? [];
      list.push(chat);
      byTopic.set(chat.topic, list);
    } else {
      loose.push(chat);
    }
  }
  const newest = (a: PwChat, b: PwChat) => b.lastActivityAt - a.lastActivityAt;
  const topics = [...byTopic.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, chats]) => ({ name, chats: chats.sort(newest) }));
  return { topics, loose: loose.sort(newest) };
}
