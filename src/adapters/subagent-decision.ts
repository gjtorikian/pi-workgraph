import { closeSync, fstatSync, openSync, readSync } from "node:fs";

/** Read only visible supervisor tool arguments, never assistant reasoning. */
export function supervisorQuestion(artifactPaths: unknown): string {
  const fallback =
    "The worker paused for a supervisor decision. Review its Activity and describe how it should proceed.";
  if (!artifactPaths || typeof artifactPaths !== "object") return fallback;
  const path = Object.values(artifactPaths).find(
    (p) => typeof p === "string" && p.endsWith("_transcript.jsonl"),
  );
  if (typeof path !== "string") return fallback;
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const stat = fstatSync(fd);
    if (!stat.isFile()) return fallback;
    const start = Math.max(0, stat.size - 1_048_576);
    const buffer = Buffer.alloc(stat.size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    const lines = buffer.toString("utf8").split("\n");
    if (start) lines.shift();
    let question = fallback;
    for (const line of lines) {
      try {
        const record = JSON.parse(line);
        const args =
          record.toolName === "contact_supervisor"
            ? record.argsPayload
            : undefined;
        const calls = Array.isArray(record.message?.content)
          ? record.message.content
              .filter(
                (c: { type?: string; name?: string }) =>
                  c.type === "toolCall" && c.name === "contact_supervisor",
              )
              .map((c: { arguments?: unknown }) => c.arguments)
          : [];
        for (const raw of [args, ...calls]) {
          const value = typeof raw === "string" ? JSON.parse(raw) : raw;
          if (
            value?.reason === "need_decision" &&
            typeof value.message === "string" &&
            value.message.trim()
          )
            question = value.message.trim().slice(0, 20_000);
        }
      } catch {
        /* An incomplete or malformed transcript line is not a request. */
      }
    }
    return question;
  } catch {
    return fallback;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
