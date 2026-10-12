import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";
import type { StreamItem, ThoughtItem, ToolCallItem } from "@/types/stream";

/**
 * PW build: a run's steps are its tool calls plus the thinking between them, so a Summary row
 * covers everything between two written messages instead of breaking at every Thinking step
 * (card "Our own Paseo build" on the board). Thinking that no tool call follows stays its own row.
 */
export type ToolCallRunStep = ToolCallItem | ThoughtItem;

export interface ToolCallDescriptor {
  detail: ToolCallDetail;
  name: string;
  status: "executing" | "running" | "completed" | "failed" | "canceled";
  error: unknown;
  metadata?: Record<string, unknown>;
}

export interface ToolCallRun {
  id: string;
  calls: readonly ToolCallItem[];
  steps: readonly ToolCallRunStep[];
  latest: ToolCallItem;
  isSealed: boolean;
}

export interface GroupedHistory<TGroup> {
  tail: StreamItem[];
  groupsByHostId: Map<string, TGroup>;
  pendingSteps: readonly ToolCallRunStep[];
}

export interface GroupedToolCalls<TGroup> {
  tail: StreamItem[];
  head: StreamItem[];
  groupsByHostId: ToolCallGroupLookup<TGroup>;
  historyGroupUpdatesByHostId: ToolCallGroupLookup<TGroup>;
}

export interface ToolCallGroupLookup<TGroup> {
  readonly size: number;
  get(id: string): TGroup | undefined;
  has(id: string): boolean;
}

const EMPTY_GROUPS = new Map<string, never>();

export function describeToolCall(item: ToolCallItem): ToolCallDescriptor {
  if (item.payload.source === "agent") {
    const { data } = item.payload;
    return {
      detail: data.detail,
      name: data.name,
      status: data.status,
      error: data.error,
      metadata: data.metadata,
    };
  }

  const { data } = item.payload;
  return {
    detail: {
      type: "unknown",
      input: data.arguments ?? null,
      output: data.result ?? null,
    },
    name: data.toolName,
    status: data.status,
    error: data.error,
  };
}

export function isGroupableToolCall(item: StreamItem): item is ToolCallItem {
  if (item.kind !== "tool_call") {
    return false;
  }
  const descriptor = describeToolCall(item);
  return descriptor.detail.type !== "plan" && descriptor.name.trim().toLowerCase() !== "speak";
}

function isToolCallStep(step: ToolCallRunStep): step is ToolCallItem {
  return step.kind === "tool_call";
}

function createRun(steps: readonly ToolCallRunStep[], isSealed: boolean): ToolCallRun {
  const calls = steps.filter(isToolCallStep);
  const first = calls[0];
  const latest = calls.at(-1);
  if (!first || !latest) {
    throw new Error("Cannot group an empty tool call run");
  }
  return { id: first.id, calls, steps, latest, isSealed };
}

function createHost(run: ToolCallRun): ToolCallItem {
  if (run.steps.length === 1) {
    return run.latest;
  }
  return { ...run.latest, id: run.id };
}

function isRunning(call: ToolCallItem): boolean {
  const status = describeToolCall(call).status;
  return status === "running" || status === "executing";
}

function appendRun<TGroup>(input: {
  steps: readonly ToolCallRunStep[];
  isSealed: boolean;
  output: StreamItem[];
  groups: Map<string, TGroup>;
  buildGroup: (run: ToolCallRun) => TGroup;
}): void {
  if (input.steps.length === 0) {
    return;
  }
  const run = createRun(input.steps, input.isSealed);
  const host = createHost(run);
  input.output.push(host);
  input.groups.set(host.id, input.buildGroup(run));
}

export function prepareGroupedHistory<TGroup>(input: {
  tail: StreamItem[];
  buildGroup: (run: ToolCallRun) => TGroup;
}): GroupedHistory<TGroup> {
  const output: StreamItem[] = [];
  const groups = new Map<string, TGroup>();
  let pending: ToolCallRunStep[] = [];
  // Thinking waits here until we know whether a tool call follows it.
  let held: ThoughtItem[] = [];

  const flushRun = () => {
    appendRun({
      steps: pending,
      isSealed: true,
      output,
      groups,
      buildGroup: input.buildGroup,
    });
    pending = [];
  };

  for (const item of input.tail) {
    if (isGroupableToolCall(item)) {
      pending.push(...held, item);
      held = [];
      continue;
    }
    if (item.kind === "thought") {
      held.push(item);
      continue;
    }
    flushRun();
    output.push(...held, item);
    held = [];
  }

  const trailingRun = pending;
  flushRun();
  output.push(...held);

  return {
    tail: groups.size > 0 ? output : input.tail,
    groupsByHostId: groups,
    // Thinking after the trailing run already sits below its row, so the live head starts anew.
    pendingSteps: held.length > 0 ? [] : trailingRun,
  };
}

export function groupLiveToolCalls<TGroup>(input: {
  history: GroupedHistory<TGroup>;
  head: StreamItem[];
  isTurnActive: boolean;
  buildGroup: (run: ToolCallRun) => TGroup;
}): GroupedToolCalls<TGroup> {
  const head: StreamItem[] = [];
  const liveGroups = new Map<string, TGroup>();
  let pending: ToolCallRunStep[] = [...input.history.pendingSteps];
  let held: ThoughtItem[] = [];
  let hostPlacement: "history" | "head" | null = pending.length > 0 ? "history" : null;
  let pendingIncludesHead = false;

  const flush = (isSealed: boolean) => {
    if (pending.length === 0) {
      return;
    }
    const run = createRun(pending, isSealed);
    if (hostPlacement === "head") {
      head.push(createHost(run));
    }
    if (hostPlacement === "head" || pendingIncludesHead || !isSealed) {
      liveGroups.set(run.id, input.buildGroup(run));
    }
    pending = [];
    hostPlacement = null;
    pendingIncludesHead = false;
  };

  for (const item of input.head) {
    if (isGroupableToolCall(item)) {
      if (pending.length === 0) {
        hostPlacement = "head";
      }
      pending.push(...held, item);
      held = [];
      pendingIncludesHead = true;
      continue;
    }
    if (item.kind === "thought") {
      held.push(item);
      continue;
    }
    flush(true);
    head.push(...held, item);
    held = [];
  }
  // Tool calls live in retained tail rather than the streaming head. The agent
  // lifecycle snapshot can still be idle while a newly received tool call is
  // already running, so its direct timeline status is the authoritative start
  // signal. The lifecycle state continues to keep completed calls live between
  // sequential tool updates.
  const trailingRunIsActive =
    input.isTurnActive || pending.filter(isToolCallStep).some(isRunning);
  flush(!trailingRunIsActive);
  head.push(...held);

  if (liveGroups.size === 0) {
    return {
      tail: input.history.tail,
      head: input.head,
      groupsByHostId: input.history.groupsByHostId,
      historyGroupUpdatesByHostId: EMPTY_GROUPS,
    };
  }
  if (input.history.groupsByHostId.size === 0) {
    return {
      tail: input.history.tail,
      head,
      groupsByHostId: liveGroups,
      historyGroupUpdatesByHostId: EMPTY_GROUPS,
    };
  }
  const groupsByHostId = new Map(input.history.groupsByHostId);
  let historyGroupUpdatesByHostId: Map<string, TGroup> | null = null;
  for (const [id, group] of liveGroups) {
    groupsByHostId.set(id, group);
    if (input.history.groupsByHostId.has(id)) {
      historyGroupUpdatesByHostId ??= new Map();
      historyGroupUpdatesByHostId.set(id, group);
    }
  }
  return {
    tail: input.history.tail,
    head,
    groupsByHostId,
    historyGroupUpdatesByHostId: historyGroupUpdatesByHostId ?? EMPTY_GROUPS,
  };
}
