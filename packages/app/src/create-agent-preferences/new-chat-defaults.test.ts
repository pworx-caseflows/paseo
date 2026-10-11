import { describe, expect, it } from "vitest";
import { applyNewChatDefaults } from "./new-chat-defaults";

describe("applyNewChatDefaults", () => {
  it("starts a new chat on the defaults, not on the device's last choice", () => {
    const remembered = {
      provider: "codex",
      providerPreferences: {
        claude: { model: "claude-haiku-5", mode: "plan", thinkingByModel: { "claude-haiku-5": "low" } },
      },
    };
    const result = applyNewChatDefaults(remembered, {
      provider: "claude",
      model: "claude-opus-5-5",
      thinkingOptionId: "medium",
      modeId: "auto",
    });
    expect(result?.provider).toBe("claude");
    expect(result?.providerPreferences?.claude?.model).toBe("claude-opus-5-5");
    expect(result?.providerPreferences?.claude?.mode).toBe("auto");
    expect(result?.providerPreferences?.claude?.thinkingByModel).toEqual({
      "claude-haiku-5": "low",
      "claude-opus-5-5": "medium",
    });
  });

  it("works with nothing remembered on the device", () => {
    const result = applyNewChatDefaults(null, {
      provider: "claude",
      model: "claude-opus-5-5",
      thinkingOptionId: "medium",
    });
    expect(result?.providerPreferences?.claude).toEqual({
      model: "claude-opus-5-5",
      thinkingByModel: { "claude-opus-5-5": "medium" },
    });
  });

  it("keeps what the defaults do not name", () => {
    const remembered = {
      isolation: "worktree" as const,
      providerPreferences: { claude: { mode: "plan", featureValues: { fast_mode: true } } },
    };
    const result = applyNewChatDefaults(remembered, { provider: "claude", model: "claude-opus-5-5" });
    expect(result?.isolation).toBe("worktree");
    expect(result?.providerPreferences?.claude?.mode).toBe("plan");
    expect(result?.providerPreferences?.claude?.featureValues).toEqual({ fast_mode: true });
  });

  it("changes nothing when no defaults are set", () => {
    const remembered = { provider: "codex" };
    expect(applyNewChatDefaults(remembered, undefined)).toBe(remembered);
  });
});
