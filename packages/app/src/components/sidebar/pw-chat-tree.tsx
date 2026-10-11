// PW build: a workspace's open chats in the sidebar, under its workspace row, as a tree.
//
//   Project
//     Workspace
//       Topic            (optional, folds)
//         chat
//       chat             (no topic: straight under the workspace)
//
// A chat's topic is the agent label `pw.topic`; an empty value means no topic, because label
// updates are merge patches and cannot delete a key. Open means not archived and not a worker
// another chat started. The list is live: it reads the session store the rest of the app reads.
//
// Right-click (long press on touch) on a chat gives the chat tab's own actions - rename, copy
// resume command, copy agent id, reload, close - plus Move to topic: an existing topic, a new
// one, or none.

import { useCallback, useMemo, useState, type ReactElement, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import * as Clipboard from "expo-clipboard";
import {
  ChevronDown,
  ChevronRight,
  Copy,
  FolderInput,
  Pencil,
  Plus,
  RotateCw,
  X,
} from "lucide-react-native";
import { useShallow } from "zustand/react/shallow";
import { AdaptiveRenameModal } from "@/components/rename-modal";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  MenuItem,
  MenuSeparator,
  MenuSubTrigger,
  MenuTextField,
  useMenuContext,
  type MenuPageDefinition,
} from "@/components/ui/menu";
import { useToast } from "@/contexts/toast-context";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import type { Theme } from "@/styles/theme";
import { confirmDialog } from "@/utils/confirm-dialog";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { buildProviderCommand } from "@/utils/provider-command-templates";

import {
  buildPwChatTree,
  PW_TOPIC_LABEL,
  type PwChat,
} from "@/components/sidebar/pw-chat-tree-model";

const TOPIC_PAGE_ID = "pwTopic";
const NEW_TOPIC_PAGE_ID = "pwTopicNew";
const MENU_WIDTH = 240;
const ICON = 16;

const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedCopy = withUnistyles(Copy);
const ThemedFolderInput = withUnistyles(FolderInput);
const ThemedPencil = withUnistyles(Pencil);
const ThemedPlus = withUnistyles(Plus);
const ThemedRotateCw = withUnistyles(RotateCw);
const ThemedX = withUnistyles(X);
const mutedColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

async function setTopic(chat: PwChat, topic: string): Promise<void> {
  const client = getHostRuntimeStore().getClient(chat.serverId);
  if (!client) throw new Error("Host is not connected");
  // An empty value clears the topic: labels are merge patches, so the key stays, empty.
  await client.updateAgent(chat.agentId, { labels: { [PW_TOPIC_LABEL]: topic.trim() } });
}

/** Move to topic: every topic in this workspace, a new one, or none. */
function TopicPage({ chat, topics }: { chat: PwChat; topics: readonly string[] }): ReactElement {
  const toast = useToast();
  const choose = useCallback(
    (topic: string) => {
      void setTopic(chat, topic).catch((error: unknown) =>
        toast.error(error instanceof Error ? error.message : "Could not set the topic"),
      );
    },
    [chat, toast],
  );
  const newTopicLeading = useMemo(() => <ThemedPlus size={ICON} uniProps={mutedColor} />, []);
  return (
    <>
      {topics.map((topic) => (
        <MenuItem
          key={topic}
          selected={topic === chat.topic}
          onSelect={() => choose(topic)}
          testID={`pw-chat-topic-${topic}`}
        >
          {topic}
        </MenuItem>
      ))}
      {topics.length > 0 ? <MenuSeparator /> : null}
      <MenuSubTrigger id={NEW_TOPIC_PAGE_ID} leading={newTopicLeading} testID="pw-chat-topic-new">
        New topic...
      </MenuSubTrigger>
      <MenuItem
        selected={!chat.topic}
        onSelect={() => choose("")}
        testID="pw-chat-topic-none"
      >
        No topic
      </MenuItem>
    </>
  );
}

function NewTopicPage({ chat }: { chat: PwChat }): ReactElement {
  const menu = useMenuContext("PwNewTopicPage");
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = useCallback(() => {
    const trimmed = name.trim();
    if (!trimmed || pending) return;
    setPending(true);
    setError(null);
    setTopic(chat, trimmed)
      .then(() => menu.setOpen(false))
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : "Could not set the topic"),
      )
      .finally(() => setPending(false));
  }, [chat, menu, name, pending]);
  return (
    <>
      <MenuTextField
        onChangeText={setName}
        placeholder="Topic name"
        autoFocus
        editable={!pending}
        onSubmitEditing={submit}
        testID="pw-chat-topic-new-name"
      />
      <MenuSeparator />
      <MenuItem
        disabled={!name.trim()}
        status={pending ? "pending" : "idle"}
        closeOnSelect={false}
        onSelect={submit}
        testID="pw-chat-topic-new-submit"
      >
        Move to new topic
      </MenuItem>
      {error ? <Text style={styles.errorText}>{error}</Text> : null}
    </>
  );
}

function ChatRow({
  chat,
  indented,
  topics,
  onRename,
}: {
  chat: PwChat;
  indented: boolean;
  topics: readonly string[];
  onRename: (chat: PwChat) => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();

  const open = useCallback(() => {
    navigateToAgent({ serverId: chat.serverId, agentId: chat.agentId });
  }, [chat.serverId, chat.agentId]);

  const agent = useCallback(
    () => useSessionStore.getState().sessions[chat.serverId]?.agents?.get(chat.agentId) ?? null,
    [chat.serverId, chat.agentId],
  );

  // The same five actions a chat's tab offers, done the same way (screens/workspace).
  const copyResumeCommand = useCallback(async () => {
    const a = agent();
    const sessionId = a?.runtimeInfo?.sessionId ?? a?.persistence?.sessionId ?? null;
    if (!a || !sessionId) {
      toast.error(t("workspace.tabs.toasts.resumeIdUnavailable"));
      return;
    }
    const command = buildProviderCommand({ provider: a.provider, id: "resume", sessionId }) ?? null;
    if (!command) {
      toast.error(t("workspace.tabs.toasts.resumeCommandUnavailable"));
      return;
    }
    try {
      await Clipboard.setStringAsync(command);
      toast.copied(t("workspace.tabs.toasts.resumeCommandCopiedLabel"));
    } catch {
      toast.error(t("workspace.tabs.toasts.copyFailed"));
    }
  }, [agent, t, toast]);

  const copyAgentId = useCallback(async () => {
    try {
      await Clipboard.setStringAsync(chat.agentId);
      toast.copied(t("workspace.tabs.toasts.agentIdCopiedLabel"));
    } catch {
      toast.error(t("workspace.tabs.toasts.copyFailed"));
    }
  }, [chat.agentId, t, toast]);

  const reload = useCallback(async () => {
    const client = getHostRuntimeStore().getClient(chat.serverId);
    if (!client) {
      toast.error(t("workspace.terminal.hostDisconnected"));
      return;
    }
    toast.show(t("workspace.tabs.toasts.reloadingAgent"), { durationMs: null });
    try {
      await client.refreshAgent(chat.agentId);
      const session = useSessionStore.getState().sessions[chat.serverId];
      const cursor = session?.agentTimelineCursor.get(chat.agentId);
      await getHostRuntimeStore().fetchAgentTimeline(chat.serverId, chat.agentId, {
        direction: "tail",
        projection: "projected",
        ...(cursor ? { cursor: { epoch: cursor.epoch, seq: cursor.endSeq } } : {}),
      });
      toast.show(t("workspace.tabs.toasts.reloadedAgent"), { variant: "success" });
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t("workspace.tabs.toasts.failedToReloadAgent"),
      );
    }
  }, [chat.agentId, chat.serverId, t, toast]);

  // Closing a chat's tab archives it; so does closing it here, asking first when it is running.
  const close = useCallback(async () => {
    const client = getHostRuntimeStore().getClient(chat.serverId);
    if (!client) {
      toast.error(t("common.errors.daemonClientUnavailable"));
      return;
    }
    if (agent()?.status === "running") {
      const confirmed = await confirmDialog({
        title: t("workspace.tabs.confirmations.archiveRunningAgentTitle"),
        message: t("workspace.tabs.confirmations.archiveRunningAgentMessage"),
        confirmLabel: t("workspace.tabs.confirmations.archive"),
        cancelLabel: t("workspace.tabs.confirmations.cancel"),
        destructive: true,
      });
      if (!confirmed) return;
    }
    try {
      await client.archiveAgent(chat.agentId);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t("workspace.tabs.toasts.failedToCloseAgent"),
      );
    }
  }, [agent, chat.agentId, chat.serverId, t, toast]);

  const pages = useMemo<readonly MenuPageDefinition[]>(
    () => [
      { id: TOPIC_PAGE_ID, title: "Move to topic", content: <TopicPage chat={chat} topics={topics} /> },
      {
        id: NEW_TOPIC_PAGE_ID,
        title: "New topic",
        // A page you type into is not one the pointer opens or dismisses on its own.
        hoverIntent: false,
        content: <NewTopicPage chat={chat} />,
      },
    ],
    [chat, topics],
  );

  return (
    <ContextMenu>
      <ContextMenuTrigger
        testID={`pw-chat-row-${chat.agentId}`}
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
        <Text numberOfLines={1} style={styles.chatText}>
          {chat.title}
        </Text>
      </ContextMenuTrigger>
      <ContextMenuContent
        align="start"
        width={MENU_WIDTH}
        pages={pages}
        sheetTitle={chat.title}
        testID={`pw-chat-menu-${chat.agentId}`}
      >
        <MenuItem
          leading={<ThemedPencil size={ICON} uniProps={mutedColor} />}
          onSelect={() => onRename(chat)}
          testID="pw-chat-menu-rename"
        >
          {t("workspace.tabs.menu.rename")}
        </MenuItem>
        <MenuItem
          leading={<ThemedCopy size={ICON} uniProps={mutedColor} />}
          onSelect={() => void copyResumeCommand()}
          testID="pw-chat-menu-copy-resume"
        >
          {t("workspace.tabs.menu.copyResumeCommand")}
        </MenuItem>
        <MenuItem
          leading={<ThemedCopy size={ICON} uniProps={mutedColor} />}
          onSelect={() => void copyAgentId()}
          testID="pw-chat-menu-copy-id"
        >
          {t("workspace.tabs.menu.copyAgentId")}
        </MenuItem>
        <MenuItem
          leading={<ThemedRotateCw size={ICON} uniProps={mutedColor} />}
          tooltip={t("workspace.tabs.menu.reloadAgentTooltip")}
          onSelect={() => void reload()}
          testID="pw-chat-menu-reload"
        >
          {t("workspace.tabs.menu.reloadAgent")}
        </MenuItem>
        <MenuSeparator />
        <MenuSubTrigger
          id={TOPIC_PAGE_ID}
          leading={<ThemedFolderInput size={ICON} uniProps={mutedColor} />}
          value={chat.topic || undefined}
          testID="pw-chat-menu-topic"
        >
          Move to topic
        </MenuSubTrigger>
        <MenuSeparator />
        <MenuItem
          leading={<ThemedX size={ICON} uniProps={mutedColor} />}
          onSelect={() => void close()}
          testID="pw-chat-menu-close"
        >
          {t("workspace.tabs.menu.close")}
        </MenuItem>
      </ContextMenuContent>
    </ContextMenu>
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
    <PlainRow onPress={toggle} testID={`pw-topic-row-${name}`} label={name}>
      {folded ? (
        <ThemedChevronRight size={14} uniProps={mutedColor} />
      ) : (
        <ThemedChevronDown size={14} uniProps={mutedColor} />
      )}
      <Text numberOfLines={1} style={styles.topicText}>
        {name}
      </Text>
      <Text style={styles.countText}>{count}</Text>
    </PlainRow>
  );
}

/** A pressable row in the same geometry as a chat row, with no menu. */
function PlainRow({
  onPress,
  testID,
  label,
  children,
}: {
  onPress: () => void;
  testID: string;
  label: string;
  children: ReactNode;
}) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ hovered, pressed }) => [
        styles.row,
        hovered && !pressed && styles.rowHovered,
        pressed && styles.rowPressed,
      ]}
    >
      {children}
    </Pressable>
  );
}

/** The open chats of one workspace, rendered under that workspace's sidebar row. */
export function PwWorkspaceChatTree({
  serverId,
  workspaceId,
}: {
  serverId: string;
  workspaceId: string;
}) {
  const { t } = useTranslation();
  const agentMap = useSessionStore(useShallow((state) => state.sessions[serverId]?.agents));
  const tree = useMemo(
    () => buildPwChatTree(agentMap ? [...agentMap.values()] : [], serverId, workspaceId),
    [agentMap, serverId, workspaceId],
  );
  const topicNames = useMemo(() => tree.topics.map((topic) => topic.name), [tree.topics]);

  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const toggleTopic = useCallback((name: string) => {
    setFolded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  const [renameTarget, setRenameTarget] = useState<PwChat | null>(null);
  const closeRename = useCallback(() => setRenameTarget(null), []);
  const submitRename = useCallback(
    async (value: string) => {
      if (!renameTarget) return;
      const client = getHostRuntimeStore().getClient(renameTarget.serverId);
      if (!client) throw new Error("Host is not connected");
      await client.updateAgent(renameTarget.agentId, { name: value.trim() });
      setRenameTarget(null);
    },
    [renameTarget],
  );

  if (tree.topics.length === 0 && tree.loose.length === 0) {
    return null;
  }

  return (
    <View testID={`pw-chat-tree-${workspaceId}`} style={styles.tree}>
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
                  <ChatRow
                    key={chat.agentId}
                    chat={chat}
                    indented
                    topics={topicNames}
                    onRename={setRenameTarget}
                  />
                ))}
          </View>
        );
      })}
      {tree.loose.map((chat) => (
        <ChatRow
          key={chat.agentId}
          chat={chat}
          indented={false}
          topics={topicNames}
          onRename={setRenameTarget}
        />
      ))}
      {renameTarget ? (
        <AdaptiveRenameModal
          visible
          title={t("workspace.tabs.menu.rename")}
          initialValue={renameTarget.title}
          placeholder={renameTarget.title}
          submitLabel={t("workspace.tabs.menu.rename")}
          onClose={closeRename}
          onSubmit={submitRename}
          testID="pw-chat-rename-modal"
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  tree: {
    paddingLeft: theme.spacing[4],
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
  errorText: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
  },
}));
