import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { supervisorQuestion } from "../src/adapters/subagent-decision.ts";

it("recovers the latest explicit question without exposing reasoning or tool replies", () => {
  const dir = mkdtempSync(join(tmpdir(), "decision-"));
  const path = join(dir, "worker_0_transcript.jsonl");
  try {
    writeFileSync(
      path,
      [
        {
          recordType: "tool_start",
          toolName: "contact_supervisor",
          argsPayload: JSON.stringify({
            reason: "need_decision",
            message: "Keep compatibility?",
          }),
        },
        {
          message: {
            content: [
              { type: "thinking", thinking: "private reasoning" },
              {
                type: "toolCall",
                name: "contact_supervisor",
                arguments: {
                  reason: "need_decision",
                  message: "Allow a breaking change?",
                },
              },
            ],
          },
        },
        {
          role: "toolResult",
          toolName: "contact_supervisor",
          text: "unrelated reply",
        },
        {
          toolName: "contact_supervisor",
          argsPayload: JSON.stringify({
            reason: "progress_update",
            message: "No decision here",
          }),
        },
      ]
        .map((r) => JSON.stringify(r))
        .join("\n") + '\n{"partial":',
    );
    expect(supervisorQuestion({ transcriptPath: path })).toBe(
      "Allow a breaking change?",
    );
    expect(
      supervisorQuestion({
        transcriptPath: "/missing/worker_0_transcript.jsonl",
      }),
    ).toContain("paused");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
