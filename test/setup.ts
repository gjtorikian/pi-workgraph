/**
 * Global test setup: point Pi's agent dir at an empty temp dir so no suite
 * reads the developer's real ~/.pi/agent/settings.json — a `workgraph`
 * block there would silently change plan-approval and tier behavior under
 * test. Suites that need settings write their own files (src/settings.test.ts).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-workgraph-agent-"));
