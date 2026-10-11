import type { NewChatDefaults } from "@getpaseo/protocol/messages";
import type { FormPreferences, ProviderPreferences } from "./preferences";

/**
 * PW: the host's "New chat defaults" (Settings) laid over this device's remembered last choice,
 * so a new chat starts on the defaults. Only what the defaults name is replaced; everything else
 * the device remembers (other providers, feature values, isolation) is kept. A value passed to the
 * form directly, a profile picked, or a control changed in the form still wins - those are applied
 * after preferences.
 */
export function applyNewChatDefaults(
  preferences: FormPreferences | null,
  defaults: NewChatDefaults | null | undefined,
): FormPreferences | null {
  const provider = defaults?.provider?.trim();
  if (!defaults || !provider) {
    return preferences;
  }
  const base: FormPreferences = preferences ?? {};
  const existing: ProviderPreferences = base.providerPreferences?.[provider] ?? {};
  const model = defaults.model?.trim();
  const mode = defaults.modeId?.trim();
  const thinking = defaults.thinkingOptionId?.trim();
  const next: ProviderPreferences = {
    ...existing,
    ...(model ? { model } : {}),
    ...(mode ? { mode } : {}),
    ...(model && thinking
      ? { thinkingByModel: { ...existing.thinkingByModel, [model]: thinking } }
      : {}),
  };
  return {
    ...base,
    provider,
    providerPreferences: { ...base.providerPreferences, [provider]: next },
  };
}
