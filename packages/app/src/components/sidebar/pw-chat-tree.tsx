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
// resume command, copy agent id, reload, archive, delete - plus Move to topic: an existing topic,
// a new one, or none. Right-click on a topic renames it.
//
// The main list comes first, then the topics. Dragging a chat changes its place, and moves it into
// the topic it is dropped under, or out to the main list; dragging a topic moves it with its
// chats. The order is kept in labels (pw.order, pw.topicOrder). A chat whose name starts with
// "(Finished)" always sits at the bottom of its list. Each chat carries its tab's icon and status
// mark - the moving ring while it works, the dot or alert sign when it finished, failed or waits.

import { useCallback, useMemo, useRef, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
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
  Archive,
  Trash2,
} from "lucide-react-native";
import { useShallow } from "zustand/react/shallow";
import { DraggableList, type DraggableRenderItemInfo } from "@/components/draggable-list";
import { isNative } from "@/constants/platform";
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
import { selectAgentTurnPresentation, useSessionStore } from "@/stores/session-store";
import { useProviderIcon } from "@/components/provider-icons";
import {
  WorkspaceTabIcon,
  type WorkspaceTabPresentation,
} from "@/screens/workspace/workspace-tab-presentation";
import { deriveSidebarStateBucket } from "@/utils/sidebar-agent-state";
import type { Theme } from "@/styles/theme";
import { confirmDialog } from "@/utils/confirm-dialog";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { generateDraftId } from "@/stores/draft-keys";
import { rememberPwDraftTopic } from "@/components/sidebar/pw-draft-topics";
import { buildProviderCommand } from "@/utils/provider-command-templates";

import {
  buildPwChatTree,
  findMovedRowKey,
  flattenPwChatTree,
  pickFocusedAgentId,
  planPwDrag,
  planPwTopicRename,
  PW_TOPIC_LABEL,
  type PwChat,
  type PwLabelWrite,
  type PwTreeRow,
} from "@/components/sidebar/pw-chat-tree-model";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";

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
const ThemedArchive = withUnistyles(Archive);
const ThemedTrash2 = withUnistyles(Trash2);
const mutedColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

async function applyWrites(writes: readonly PwLabelWrite[]): Promise<void> {
  for (const write of writes) {
    const client = getHostRuntimeStore().getClient(write.serverId);
    if (!client) throw new Error("Host is not connected");
    await client.updateAgent(write.agentId, { labels: write.labels });
  }
}

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

/**
 * The chat's tab icon, status and all: the moving ring while it works, the dot or alert sign when
 * it finished, failed or waits for you - worked out exactly as the chat's tab works it out.
 */
function PwChatStatusIcon({ chat, selected }: { chat: PwChat; selected: boolean }) {
  const state = useSessionStore(
    useShallow((s) => {
      const session = s.sessions[chat.serverId];
      const agent = session?.agents?.get(chat.agentId) ?? null;
      return {
        provider: agent?.provider ?? "claude",
        status: agent?.status ?? null,
        pendingPermissionCount: agent?.pendingPermissions.length ?? 0,
        requiresAttention: agent?.requiresAttention ?? false,
        attentionReason: agent?.attentionReason ?? null,
        isTurnActive: selectAgentTurnPresentation(session, chat.agentId).isActive,
      };
    }),
  );
  const icon = useProviderIcon(state.provider, chat.serverId);
  const presentation = useMemo<WorkspaceTabPresentation>(
    () => ({
      key: chat.agentId,
      kind: "agent",
      label: chat.title,
      subtitle: "",
      tooltip: chat.title,
      modified: false,
      showCloseButton: false,
      titleState: "ready",
      icon,
      statusBucket: state.status
        ? deriveSidebarStateBucket({
            status: state.isTurnActive ? "running" : state.status,
            pendingPermissionCount: state.pendingPermissionCount,
            requiresAttention: state.requiresAttention,
            attentionReason: state.attentionReason,
          })
        : null,
    }),
    [chat.agentId, chat.title, icon, state],
  );
  return (
    <WorkspaceTabIcon
      presentation={presentation}
      backdrop={selected ? "surfaceSidebarSelected" : "surfaceSidebar"}
    />
  );
}

function ChatRow({
  chat,
  indented,
  selected,
  topics,
  onRename,
}: {
  chat: PwChat;
  indented: boolean;
  /** The chat whose tab is in front in the workspace on screen. */
  selected: boolean;
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

  // Archive: what closing a chat's tab does - out of the list, kept in Paseo's history. Asks first
  // when the chat is running, as the tab does.
  const archive = useCallback(async () => {
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

  // Delete: out of Paseo altogether, history included - Paseo's own hard delete. Always asks,
  // since it cannot be undone in Paseo. Claude's chat file on disk is not touched by it.
  const remove = useCallback(async () => {
    const client = getHostRuntimeStore().getClient(chat.serverId);
    if (!client) {
      toast.error(t("common.errors.daemonClientUnavailable"));
      return;
    }
    const confirmed = await confirmDialog({
      title: `Delete "${chat.title}"?`,
      message:
        "The chat is removed from Paseo, its history included, and this cannot be undone in Paseo. " +
        "Claude's own copy of the conversation stays on disk.",
      confirmLabel: "Delete",
      cancelLabel: t("workspace.tabs.confirmations.cancel"),
      destructive: true,
    });
    if (!confirmed) return;
    try {
      await client.deleteAgent(chat.agentId);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not delete the chat");
    }
  }, [chat.agentId, chat.serverId, chat.title, t, toast]);

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
        accessibilityState={{ selected }}
        onPress={open}
        style={({ hovered, pressed }) => [
          styles.row,
          indented && styles.rowIndented,
          selected && styles.rowSelected,
          hovered && !pressed && !selected && styles.rowHovered,
          pressed && styles.rowPressed,
        ]}
      >
        <PwChatStatusIcon chat={chat} selected={selected} />
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
          leading={<ThemedArchive size={ICON} uniProps={mutedColor} />}
          onSelect={() => void archive()}
          testID="pw-chat-menu-archive"
        >
          {t("workspace.tabs.confirmations.archive")}
        </MenuItem>
        <MenuItem
          leading={<ThemedTrash2 size={ICON} uniProps={mutedColor} />}
          destructive
          onSelect={() => void remove()}
          testID="pw-chat-menu-delete"
        >
          Delete
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
  onRename,
  onNewChat,
}: {
  name: string;
  count: number;
  folded: boolean;
  onToggle: (name: string) => void;
  onRename: (name: string) => void;
  onNewChat: (name: string) => void;
}) {
  const toggle = useCallback(() => onToggle(name), [name, onToggle]);
  return (
    <ContextMenu>
      <ContextMenuTrigger
        testID={`pw-topic-row-${name}`}
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
      </ContextMenuTrigger>
      <ContextMenuContent
        align="start"
        width={MENU_WIDTH}
        sheetTitle={name}
        testID={`pw-topic-menu-${name}`}
      >
        <MenuItem
          leading={<ThemedPlus size={ICON} uniProps={mutedColor} />}
          onSelect={() => onNewChat(name)}
          testID="pw-topic-menu-new-chat"
        >
          New chat in this topic
        </MenuItem>
        <MenuItem
          leading={<ThemedPencil size={ICON} uniProps={mutedColor} />}
          onSelect={() => onRename(name)}
          testID="pw-topic-menu-rename"
        >
          Rename topic
        </MenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

const rowKey = (row: PwTreeRow): string => row.key;

/** The open chats of one workspace, rendered under that workspace's sidebar row. */
export function PwWorkspaceChatTree({
  serverId,
  workspaceId,
  workspaceSelected,
}: {
  serverId: string;
  workspaceId: string;
  /** This workspace is the one on screen, so its front chat is the one you are in. */
  workspaceSelected: boolean;
}) {
  const { t } = useTranslation();
  const agentMap = useSessionStore(useShallow((state) => state.sessions[serverId]?.agents));
  const focusedAgentId = useWorkspaceLayoutStore((state) =>
    workspaceSelected
      ? pickFocusedAgentId(state.layoutByWorkspace[`${serverId}:${workspaceId}`])
      : null,
  );
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

  const toast = useToast();
  const [topicRenameTarget, setTopicRenameTarget] = useState<string | null>(null);
  const closeTopicRename = useCallback(() => setTopicRenameTarget(null), []);
  const submitTopicRename = useCallback(
    async (value: string) => {
      if (!topicRenameTarget) return;
      await applyWrites(planPwTopicRename(tree, topicRenameTarget, value));
      setFolded((prev) => {
        if (!prev.has(topicRenameTarget)) return prev;
        const next = new Set(prev);
        next.delete(topicRenameTarget);
        next.add(value.trim());
        return next;
      });
      setTopicRenameTarget(null);
    },
    [topicRenameTarget, tree],
  );

  // A new chat draft in this workspace, put in the topic once it becomes a chat.
  const newChatInTopic = useCallback(
    (topic: string) => {
      const draftId = generateDraftId();
      rememberPwDraftTopic(draftId, topic);
      navigateToWorkspace({ serverId, workspaceId, target: { kind: "draft", draftId } });
    },
    [serverId, workspaceId],
  );

  const rows = useMemo(() => flattenPwChatTree(tree, folded), [tree, folded]);
  // The row the pointer went down on, so a drag knows which row it moved.
  const grabbedKeyRef = useRef<string | null>(null);
  const handleDragEnd = useCallback(
    (next: PwTreeRow[]) => {
      const moved = grabbedKeyRef.current ?? findMovedRowKey(rows, next);
      grabbedKeyRef.current = null;
      if (!moved) return;
      void applyWrites(planPwDrag(tree, next, moved)).catch((error: unknown) =>
        toast.error(error instanceof Error ? error.message : "Could not move the chat"),
      );
    },
    [rows, toast, tree],
  );

  const renderRow = useCallback(
    (row: PwTreeRow): ReactElement =>
      row.kind === "topic" ? (
        <TopicRow
          name={row.name}
          count={row.count}
          folded={row.folded}
          onToggle={toggleTopic}
          onRename={setTopicRenameTarget}
          onNewChat={newChatInTopic}
        />
      ) : (
        <ChatRow
          chat={row.chat}
          indented={Boolean(row.chat.topic)}
          selected={row.chat.agentId === focusedAgentId}
          topics={topicNames}
          onRename={setRenameTarget}
        />
      ),
    [focusedAgentId, newChatInTopic, toggleTopic, topicNames],
  );

  const renderDraggable = useCallback(
    ({ item, dragHandleProps }: DraggableRenderItemInfo<PwTreeRow>): ReactElement => (
      <View
        {...(dragHandleProps?.attributes ?? {})}
        {...(dragHandleProps?.listeners ?? {})}
        ref={dragHandleProps?.setActivatorNodeRef as never}
      >
        <View
          onPointerDown={() => {
            grabbedKeyRef.current = item.key;
          }}
        >
          {renderRow(item)}
        </View>
      </View>
    ),
    [renderRow],
  );

  if (tree.topics.length === 0 && tree.loose.length === 0) {
    return null;
  }

  return (
    <View testID={`pw-chat-tree-${workspaceId}`} style={styles.tree}>
      {isNative ? (
        rows.map((row) => <View key={row.key}>{renderRow(row)}</View>)
      ) : (
        <DraggableList
          testID={`pw-chat-tree-list-${workspaceId}`}
          data={rows}
          keyExtractor={rowKey}
          renderItem={renderDraggable}
          onDragEnd={handleDragEnd}
          extraData={focusedAgentId}
          scrollEnabled={false}
          useDragHandle
        />
      )}
      {topicRenameTarget ? (
        <AdaptiveRenameModal
          visible
          title="Rename topic"
          initialValue={topicRenameTarget}
          placeholder={topicRenameTarget}
          submitLabel={t("workspace.tabs.menu.rename")}
          onClose={closeTopicRename}
          onSubmit={submitTopicRename}
          testID="pw-topic-rename-modal"
        />
      ) : null}
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
  // The same fill Paseo gives the selected workspace row.
  rowSelected: {
    backgroundColor: theme.colors.surfaceSidebarSelected,
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
