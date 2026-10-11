import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Pencil } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { AgentProfile, NewChatDefaults } from "@getpaseo/protocol/messages";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { type FieldControlSize } from "@/components/ui/control-geometry";
import {
  SelectField,
  type SelectFieldDisplay,
  type SelectFieldOption,
} from "@/components/ui/select-field";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { settingsStyles } from "@/styles/settings";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { toErrorMessage } from "@/utils/error-messages";
import type { AgentProfileFormOption } from "../internal/profile-form-model";
import { buildAgentProfileTags } from "../internal/profile-summary";
import { useAgentProfileFormCatalog } from "../internal/use-profile-form-inputs";
import {
  useAgentProfileFormModel,
  useAgentProfileFormState,
} from "../internal/use-profile-form-model";

/**
 * PW: "New chat defaults" - the model, effort and mode every new chat starts on, saved host-wide
 * in daemon config (`daemon.newChatDefaults`). The pickers are the agent-profile form's own, so
 * the choices offered are exactly the ones a profile offers.
 */

const ThemedPencil = withUnistyles(Pencil);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const editIcon = <ThemedPencil size={ICON_SIZE.sm} uniProps={mutedColorMapping} />;

const SECTION_TITLE = "New chat defaults";
const DEFAULTS_ID = "new-chat-defaults";
const UNSET_VALUE = "";

/** The profile form needs a name to submit; this one is never shown or saved. */
function asProfile(defaults: NewChatDefaults | undefined): AgentProfile | undefined {
  if (!defaults) {
    return undefined;
  }
  return {
    id: DEFAULTS_ID,
    name: SECTION_TITLE,
    provider: defaults.provider,
    ...(defaults.model ? { model: defaults.model } : {}),
    ...(defaults.modeId ? { modeId: defaults.modeId } : {}),
    ...(defaults.thinkingOptionId ? { thinkingOptionId: defaults.thinkingOptionId } : {}),
  };
}

export function NewChatDefaultsSection({ serverId }: { serverId: string }): ReactElement | null {
  const { t } = useTranslation();
  const isConnected = useHostRuntimeIsConnected(serverId);
  const { config, patchConfig } = useDaemonConfig(serverId);
  const { entries } = useProvidersSnapshot(serverId, { cwd: null });
  const [editing, setEditing] = useState(false);

  const defaults = config?.newChatDefaults;
  const profile = useMemo(() => asProfile(defaults), [defaults]);

  const formatFeatureCount = useCallback(
    (count: number) =>
      count === 1
        ? t("settings.host.agentProfiles.featureCountOne", { count })
        : t("settings.host.agentProfiles.featureCount", { count }),
    [t],
  );
  const summary = useMemo(() => {
    if (!profile) {
      return "Not set - a new chat starts on the last choice made in the new-chat form";
    }
    return buildAgentProfileTags({ profile, entries, formatFeatureCount })
      .map((tag) => tag.label)
      .join(" · ");
  }, [entries, formatFeatureCount, profile]);

  const handleOpen = useCallback(() => setEditing(true), []);
  const handleClose = useCallback(() => setEditing(false), []);
  const handleSave = useCallback(
    async (next: NewChatDefaults) => {
      await patchConfig({ newChatDefaults: next });
    },
    [patchConfig],
  );

  if (!isConnected || !config) {
    return null;
  }

  return (
    <>
      <SettingsSection title={SECTION_TITLE} testID="new-chat-defaults-section">
        <View style={settingsStyles.card}>
          <View style={[settingsStyles.row, styles.row]}>
            <View style={settingsStyles.rowContent}>
              <Text style={settingsStyles.rowTitle}>Every new chat starts on</Text>
              <Text style={styles.summary} testID="new-chat-defaults-summary">
                {summary}
              </Text>
            </View>
            <Button
              variant="ghost"
              size="sm"
              leftIcon={editIcon}
              onPress={handleOpen}
              accessibilityLabel="Change new chat defaults"
              testID="new-chat-defaults-edit"
            />
          </View>
        </View>
      </SettingsSection>
      {editing ? (
        <NewChatDefaultsModal
          serverId={serverId}
          {...(profile ? { profile } : {})}
          onClose={handleClose}
          onSave={handleSave}
        />
      ) : null}
    </>
  );
}

function toSelectOptions(options: AgentProfileFormOption[]): SelectFieldOption<string>[] {
  return options.map((option) => ({
    id: option.id,
    value: option.value,
    label: option.label,
    ...(option.description ? { description: option.description } : {}),
    testID: option.testID,
  }));
}

function NewChatDefaultsModal({
  serverId,
  profile,
  onClose,
  onSave,
}: {
  serverId: string;
  profile?: AgentProfile;
  onClose: () => void;
  onSave: (next: NewChatDefaults) => Promise<void>;
}): ReactElement {
  const { t } = useTranslation();
  const controlSize: FieldControlSize = useIsCompactFormFactor() ? "md" : "sm";
  const snapshot = useMemo(
    () =>
      profile
        ? { mode: "edit" as const, profile }
        : { mode: "create" as const, seed: { name: SECTION_TITLE, provider: "claude" } },
    [profile],
  );
  const model = useAgentProfileFormModel(snapshot);
  const state = useAgentProfileFormState(model);
  useAgentProfileFormCatalog({ serverId, model });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const sheetHeader = useMemo<SheetHeader>(() => ({ title: SECTION_TITLE }), []);
  const providerOptions = useMemo(
    () => toSelectOptions(state.providerOptions),
    [state.providerOptions],
  );
  const modelOptions = useMemo(() => toSelectOptions(state.modelOptions), [state.modelOptions]);
  const modeOptions = useMemo(() => toSelectOptions(state.modeOptions), [state.modeOptions]);
  const thinkingOptions = useMemo(
    () => toSelectOptions(state.thinkingOptions),
    [state.thinkingOptions],
  );

  const handleProviderChange = useCallback(
    (value: string, display: SelectFieldDisplay) => model.setProvider(value, display),
    [model],
  );
  const handleModelChange = useCallback(
    (value: string, display: SelectFieldDisplay) => model.setModel(value, value ? display : null),
    [model],
  );
  const handleModeChange = useCallback(
    (value: string, display: SelectFieldDisplay) => model.setMode(value, value ? display : null),
    [model],
  );
  const handleThinkingChange = useCallback(
    (value: string, display: SelectFieldDisplay) =>
      model.setThinking(value, value ? display : null),
    [model],
  );

  const handleSave = useCallback(async () => {
    const value = model.getState().submitValue;
    if (!value) {
      return;
    }
    setError(null);
    setSaving(true);
    try {
      await onSave({
        provider: value.provider,
        ...(value.model ? { model: value.model } : {}),
        ...(value.modeId ? { modeId: value.modeId } : {}),
        ...(value.thinkingOptionId ? { thinkingOptionId: value.thinkingOptionId } : {}),
      });
      onClose();
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }, [model, onClose, onSave]);
  const handleSavePress = useCallback(() => void handleSave(), [handleSave]);
  const handleCancel = useCallback(() => {
    if (!saving) {
      onClose();
    }
  }, [onClose, saving]);

  return (
    <AdaptiveModalSheet
      visible
      header={sheetHeader}
      onClose={handleCancel}
      desktopMaxWidth={520}
      testID="new-chat-defaults-modal"
    >
      <View style={styles.body}>
        <SelectField
          label={t("settings.host.agentProfiles.providerLabel")}
          value={state.provider || null}
          selectedDisplay={state.providerDisplay}
          options={providerOptions}
          onChange={handleProviderChange}
          placeholder={t("settings.host.agentProfiles.providerPlaceholder")}
          emptyText={t("settings.host.agentProfiles.noProviders")}
          loading={state.catalogResolution !== "complete"}
          disabled={saving}
          searchable={providerOptions.length > 6}
          title={t("settings.host.agentProfiles.providerLabel")}
          size={controlSize}
          testID="new-chat-defaults-provider-field"
        />
        {state.disclosure.showModelField ? (
          <SelectField
            label={t("settings.host.agentProfiles.modelLabel")}
            value={state.modelId || UNSET_VALUE}
            selectedDisplay={state.modelDisplay}
            options={modelOptions}
            onChange={handleModelChange}
            placeholder={t("settings.host.agentProfiles.modelLabel")}
            emptyText={t("settings.host.agentProfiles.noModels")}
            disabled={saving}
            searchable={modelOptions.length > 6}
            title={t("settings.host.agentProfiles.modelLabel")}
            size={controlSize}
            testID="new-chat-defaults-model-field"
          />
        ) : null}
        {state.disclosure.showThinkingField ? (
          <SelectField
            label={t("settings.host.agentProfiles.thinkingLabel")}
            value={state.thinkingOptionId || UNSET_VALUE}
            selectedDisplay={state.thinkingDisplay}
            options={thinkingOptions}
            onChange={handleThinkingChange}
            placeholder={t("settings.host.agentProfiles.thinkingLabel")}
            emptyText={t("settings.host.agentProfiles.noThinkingOptions")}
            disabled={saving}
            searchable={thinkingOptions.length > 6}
            title={t("settings.host.agentProfiles.thinkingLabel")}
            size={controlSize}
            testID="new-chat-defaults-thinking-field"
          />
        ) : null}
        {state.disclosure.showModeField ? (
          <SelectField
            label={t("settings.host.agentProfiles.modeLabel")}
            value={state.modeId || UNSET_VALUE}
            selectedDisplay={state.modeDisplay}
            options={modeOptions}
            onChange={handleModeChange}
            placeholder={t("settings.host.agentProfiles.modeLabel")}
            emptyText={t("settings.host.agentProfiles.noModes")}
            disabled={saving}
            searchable={modeOptions.length > 6}
            title={t("settings.host.agentProfiles.modeLabel")}
            size={controlSize}
            testID="new-chat-defaults-mode-field"
          />
        ) : null}
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <View style={styles.actions}>
          <Button
            variant="secondary"
            style={styles.actionButton}
            onPress={handleCancel}
            disabled={saving}
            testID="new-chat-defaults-cancel"
          >
            {t("common.actions.cancel")}
          </Button>
          <Button
            variant="default"
            style={styles.actionButton}
            onPress={handleSavePress}
            disabled={!state.canSubmit || saving}
            testID="new-chat-defaults-save"
          >
            {saving
              ? t("settings.host.agentProfiles.saving")
              : t("settings.host.agentProfiles.save")}
          </Button>
        </View>
      </View>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    gap: theme.spacing[2],
    minHeight: 56,
    alignItems: "center",
    paddingVertical: theme.spacing[3],
  },
  summary: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    marginTop: theme.spacing[1],
  },
  body: {
    gap: theme.spacing[4],
    paddingBottom: theme.spacing[2],
  },
  error: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.base,
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    marginTop: theme.spacing[2],
  },
  actionButton: {
    flex: 1,
  },
}));
