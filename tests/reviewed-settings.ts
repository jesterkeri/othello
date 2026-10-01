/**
 * The reviewed Vercel build settings (ops/release-target.json `vercelSettings`, Codex r5 F1). A link the release
 * accepts after its pull carries exactly these, so the specs' links and test targets use the committed document.
 */
import { readFileSync } from "node:fs";

export const REVIEWED_SETTINGS: Record<string, unknown> = JSON.parse(
  readFileSync(new URL("../ops/release-target.json", import.meta.url), "utf8"),
).vercelSettings;
