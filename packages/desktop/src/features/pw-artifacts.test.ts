import { describe, expect, it } from "vitest";
import { parsePwArtifactsOutput } from "./pw-artifacts";

function claudeOutput(result: unknown): string {
  return JSON.stringify({ type: "result", is_error: false, result });
}

describe("parsePwArtifactsOutput", () => {
  it("reads the artifact rows from the chat's answer", () => {
    const result = parsePwArtifactsOutput(
      claudeOutput(
        '[{"title":"Quality system chains","url":"https://claude.ai/artifact/HY8i","updated":"2026-10-10"}]',
      ),
    );
    expect(result).toEqual({
      ok: true,
      rows: [
        {
          title: "Quality system chains",
          url: "https://claude.ai/artifact/HY8i",
          updated: "2026-10-10",
        },
      ],
    });
  });

  it("reads rows wrapped in a code fence", () => {
    const result = parsePwArtifactsOutput(
      claudeOutput('```json\n[{"title":"A","url":"https://claude.ai/artifact/x","updated":""}]\n```'),
    );
    expect(result.ok && result.rows.map((row) => row.title)).toEqual(["A"]);
  });

  it("reports an answer with no list as an error, never as an empty list", () => {
    const result = parsePwArtifactsOutput(claudeOutput("Not logged in to claude.ai"));
    expect(result).toEqual({ ok: false, error: "Not logged in to claude.ai" });
  });

  it("drops a row whose link is not a claude.ai link", () => {
    const result = parsePwArtifactsOutput(
      claudeOutput('[{"title":"B","url":"https://example.com/x","updated":""}]'),
    );
    expect(result).toEqual({ ok: true, rows: [] });
  });
});
