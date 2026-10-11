// Bristol CAD/CAM build: a project's open chats in the sidebar, as a tree.
//
//   Project
//     Topic            (optional, folds)
//       chat
//     chat             (no topic: straight under the project)
//
// A chat's topic is the agent label `bcc.topic`; an empty value means no topic, because label
// updates are merge patches and cannot delete a key. Open means not archived and not a worker
// another chat started. The list is live: it reads the session store the rest of the app reads.

import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronDown, ChevronRight, Tag } from "lucide-react-native";
import { useShallow } from "zustand/react/shallow";
import { AdaptiveRenameModal } from "@/components/rename-modal";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useSessionStore, type Agent } from "@/stores/session-store";
import type { Theme } from "@/styles/theme";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import type { SidebarProjectEntry } from "@/hooks/use-sidebar-workspaces-list";

export const BCC_TOPIC_LABEL = "bcc.topic";

const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedTag = withUnistyles(Tag);
const mutedColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const strongColor = (theme: Theme) => ({ color: theme.colors.foreground });

export interface BccChat {
  serverId: string;
  agentId: string;
  title: string;
  topic: string;
  lastActivityAt: number;
}

export interface BccChatTreeModel {
  topics: { name: string; chats: BccChat[] }[];
  loose: BccChat[];
}

export function readBccTopic(labels: Record<string, string> | undefined): string {
  return (labels?.[BCC_TOPIC_LABEL] ?? "").trim();
}

export function isOpenBccChat(agent: Agent): boolean {
  return !agent.archivedAt && !agent.parentAgentId;
}

/** Pure: the tree for the chats of the given workspaces. Newest activity first; topics A-Z. */
export function buildBccChatTree(
  agents: readonly Agent[],
  workspaceKeys: ReadonlySet<string>,
): BccChatTreeModel {
  const byTopic = new Map<string, BccChat[]>();
  const loose: BccChat[] = [];
  for (const agent of agents) {
    if (!isOpenBccChat(agent) || !agent.workspaceId) continue;
    if (!workspaceKeys.has(`${agent.serverId}:${agent.workspaceId}`)) continue;
    const chat: BccChat = {
      serverId: agent.serverId,
      agentId: agent.id,
      title: agent.title?.trim() || "New chat",
      topic: readBccTopic(agent.labels),
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
  const newest = (a: BccChat, b: BccChat) => b.lastActivityAt - a.lastActivityAt;
  const topics = [...byTopic.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, chats]) => ({ name, chats: chats.sort(newest) }));
  return { topics, loose: loose.sort(newest) };
}

function ChatRow({
  chat,
  indented,
  onSetTopic,
}: {
  chat: BccChat;
  indented: boolean;
  onSetTopic: (chat: BccChat) => void;
}) {
  const open = useCallback(() => {
    navigateToAgent({ serverId: chat.serverId, agentId: chat.agentId });
  }, [chat.serverId, chat.agentId]);
  const setTopic = useCallback(() => onSetTopic(chat), [chat, onSetTopic]);
  return (
    <Pressable
      testID={`bcc-chat-row-${chat.agentId}`}
      accessibilityRole="button"
      accessibilityLabel={chat.title}
      onPress={open}
      style={({ hovered, pressed }) => [
        styles.row,
        indented && styles.rowIndented,
        hovered && !pressed && styles.rowHovered,
        pressed && styles.rowPressed,
      ]}
    >
      {({ hovered }) => (
        <>
          <Text numberOfLines={1} style={styles.chatText}>
            {chat.title}
          </Text>
          {hovered ? (
            <Pressable
              testID={`bcc-chat-set-topic-${chat.agentId}`}
              accessibilityRole="button"
              accessibilityLabel="Set topic"
              onPress={setTopic}
              hitSlop={6}
              style={styles.topicButton}
            >
              {({ hovered: buttonHovered }) => (
                <ThemedTag size={14} uniProps={buttonHovered ? strongColor : mutedColor} />
              )}
            </Pressable>
          ) : null}
        </>
      )}
    </Pressable>
  );
}

function TopicRow({
  name,
  count,
  folded,
  onToggle,
}: {
  name: string;
  count: number;
  folded: boolean;
  onToggle: (name: string) => void;
}) {
  const toggle = useCallback(() => onToggle(name), [name, onToggle]);
  return (
    <Pressable
      testID={`bcc-topic-row-${name}`}
      accessibilityRole="button"
      accessibilityLabel={name}
      onPress={toggle}
      style={({ hovered, pressed }) => [
        styles.row,
        hovered && !pressed && styles.rowHovered,
        pressed && styles.rowPressed,
      ]}
    >
      {folded ? (
        <ThemedChevronRight size={14} uniProps={mutedColor} />
      ) : (
        <ThemedChevronDown size={14} uniProps={mutedColor} />
      )}
      <Text numberOfLines={1} style={styles.topicText}>
        {name}
      </Text>
      <Text style={styles.countText}>{count}</Text>
    </Pressable>
  );
}

export function BccChatTree({ project }: { project: SidebarProjectEntry }) {
  const serverIds = useMemo(
    () => [...new Set(project.workspaces.map((w) => w.serverId))],
    [project.workspaces],
  );
  const workspaceKeys = useMemo(
    () => new Set(project.workspaces.map((w) => `${w.serverId}:${w.workspaceId}`)),
    [project.workspaces],
  );
  const agentMaps = useSessionStore(
    useShallow((state) => serverIds.map((id) => state.sessions[id]?.agents)),
  );
  const tree = useMemo(() => {
    const agents: Agent[] = [];
    for (const map of agentMaps) {
      if (map) agents.push(...map.values());
    }
    return buildBccChatTree(agents, workspaceKeys);
  }, [agentMaps, workspaceKeys]);

  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const toggleTopic = useCallback((name: string) => {
    setFolded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  const [topicTarget, setTopicTarget] = useState<BccChat | null>(null);
  const closeTopic = useCallback(() => setTopicTarget(null), []);
  const submitTopic = useCallback(
    async (value: string) => {
      if (!topicTarget) return;
      const client = getHostRuntimeStore().getClient(topicTarget.serverId);
      if (!client) throw new Error("Host is not connected");
      // An empty value clears the topic: labels are merge patches, so the key stays, empty.
      await client.updateAgent(topicTarget.agentId, {
        labels: { [BCC_TOPIC_LABEL]: value.trim() },
      });
      setTopicTarget(null);
    },
    [topicTarget],
  );

  if (tree.topics.length === 0 && tree.loose.length === 0) {
    return null;
  }

  return (
    <View testID={`bcc-chat-tree-${project.viewKey}`} style={styles.tree}>
      {tree.topics.map((topic) => {
        const isFolded = folded.has(topic.name);
        return (
          <View key={`topic:${topic.name}`}>
            <TopicRow
              name={topic.name}
              count={topic.chats.length}
              folded={isFolded}
              onToggle={toggleTopic}
            />
            {isFolded
              ? null
              : topic.chats.map((chat) => (
                  <ChatRow key={chat.agentId} chat={chat} indented onSetTopic={setTopicTarget} />
                ))}
          </View>
        );
      })}
      {tree.loose.map((chat) => (
        <ChatRow key={chat.agentId} chat={chat} indented={false} onSetTopic={setTopicTarget} />
      ))}
      {topicTarget ? (
        <AdaptiveRenameModal
          visible
          title={`Topic for "${topicTarget.title}"`}
          initialValue={topicTarget.topic}
          placeholder="No topic - leave empty to keep it under the folder"
          submitLabel="Set topic"
          onClose={closeTopic}
          onSubmit={submitTopic}
          testID="bcc-chat-topic-modal"
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  tree: {
    paddingLeft: theme.spacing[2],
  },
  row: {
    minHeight: 32,
    marginBottom: theme.spacing[0.5],
    paddingVertical: theme.spacing[1.5],
    paddingLeft: theme.spacing[2],
    paddingRight: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    userSelect: "none",
  },
  rowIndented: {
    paddingLeft: theme.spacing[6],
  },
  rowHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  rowPressed: {
    backgroundColor: theme.colors.surface2,
  },
  chatText: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    lineHeight: 20,
  },
  topicText: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    lineHeight: 20,
  },
  countText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  topicButton: {
    paddingHorizontal: theme.spacing[1],
  },
}));
