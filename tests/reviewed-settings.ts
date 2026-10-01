/**
 * The reviewed Vercel build settings and project variable names (ops/release-target.json `vercelSettings`, Codex r5 F1,
 * and `vercelEnvNames`, adversary pass on ce04cd9). A link the release accepts after its pull carries exactly these
 * settings, so the specs' links and test targets use the committed document.
 */
import { readFileSync } from "node:fs";

const committed = JSON.parse(readFileSync(new URL("../ops/release-target.json", import.meta.url), "utf8"));
export const REVIEWED_SETTINGS: Record<string, unknown> = committed.vercelSettings;
export const REVIEWED_ENV_NAMES: string[] = committed.vercelEnvNames;
/** The app manifest's engines line the release requires (app/package.json pins the reviewed Node.js version). */
export const REVIEWED_ENGINES = { node: REVIEWED_SETTINGS.nodeVersion as string };
