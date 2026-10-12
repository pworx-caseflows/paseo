// PW build: the Artifacts list in the sidebar. claude.ai offers no published way for an app to
// read a person's artifacts, so the list comes from a short Claude Code chat that calls its own
// Artifact tool and answers with the rows (card "Our own Paseo build" on the board).
import { execFile } from "node:child_process";
import os from "node:os";

export interface PwArtifactRow {
  title: string;
  url: string;
  updated: string;
}

export type PwArtifactsResult =
  | { ok: true; rows: PwArtifactRow[] }
  | { ok: false; error: string };

const LIST_PROMPT =
  'Call the Artifact tool with action "list", scope "all", limit 50. Then reply with ONLY a ' +
  'JSON array of objects {"title","url","updated"} taken from the result, newest first, where ' +
  '"updated" is the last-updated time exactly as the result gives it. Nothing else.';

const LIST_TIMEOUT_MS = 180_000;

/** The rows out of `claude -p --output-format json`; anything else is an error, never an empty list. */
export function parsePwArtifactsOutput(stdout: string): PwArtifactsResult {
  let reply: unknown;
  try {
    reply = (JSON.parse(stdout) as { result?: unknown }).result;
  } catch {
    return { ok: false, error: "Claude Code did not answer." };
  }
  if (typeof reply !== "string") return { ok: false, error: "Claude Code did not answer." };
  const start = reply.indexOf("[");
  const end = reply.lastIndexOf("]");
  if (start === -1 || end < start) return { ok: false, error: reply.trim().slice(0, 300) };
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply.slice(start, end + 1));
  } catch {
    return { ok: false, error: "The artifacts list could not be read." };
  }
  if (!Array.isArray(parsed)) return { ok: false, error: "The artifacts list could not be read." };
  const rows: PwArtifactRow[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue;
    const { title, url, updated } = item as Record<string, unknown>;
    if (typeof url !== "string" || !url.startsWith("https://claude.ai/")) continue;
    rows.push({
      title: typeof title === "string" && title.trim() ? title.trim() : url,
      url,
      updated: typeof updated === "string" ? updated : "",
    });
  }
  return { ok: true, rows };
}

export function listPwArtifacts(): Promise<PwArtifactsResult> {
  return new Promise((resolve) => {
    execFile(
      "claude",
      ["-p", LIST_PROMPT, "--allowedTools", "Artifact", "--output-format", "json"],
      { cwd: os.homedir(), timeout: LIST_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => {
        if (error && !stdout) {
          resolve({ ok: false, error: `Claude Code could not be run: ${error.message}` });
          return;
        }
        resolve(parsePwArtifactsOutput(stdout));
      },
    );
  });
}
