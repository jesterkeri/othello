/**
 * Adversary test for CI job `trust-config` (ops/trust-config.ts), ARB-DESIGN r9 sections A, 7.1 and 9.1: the value
 * the gate verifies must be the value the running page trusts ("The config as the app sees it", loadConfig).
 *
 * The gate reads app/src/lib/robinhood/config.ts by its fixed path. The page does not import that path: adapter.ts
 * imports "./config", and Next.js (15.5.26, node_modules/next/dist/build/webpack-config.js resolveConfig) tries
 * the extensions in the order .js, .mjs, .tsx, .ts, so a plain config.js beside config.ts is what the page bundles.
 * tsc (allowJs false) and the gate still see config.ts. This test builds a minimal Next app from a copy of the
 * real app/src/lib with the real Next.js and reads the factory the prerendered page shows.
 *
 * Inputs are constructed here: the address and hash below are derived from labels, not from any deployment,
 * because the point is which value the gate looks at, not whether that value is on chain.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { getAddress, keccak256, toHex } from "viem";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const UNREVIEWED = getAddress(`0x${keccak256(toHex("not the reviewed factory")).slice(26)}`);
const UNREVIEWED_HASH = keccak256(toHex("not the reviewed runtime"));

/** A plain JavaScript sibling of config.ts: two string literals, no computation, no import. */
const SHADOW_CONFIG_JS =
  `export const TRUSTED_FACTORY = Object.freeze({ address: "${UNREVIEWED}", codeHash: "${UNREVIEWED_HASH}" });\n`;

/** A server page that shows the factory the page's adapter module is bound to, imported as RobinhoodCircle does. */
const PROBE_PAGE = [
  'import { trustedFactory } from "@/lib/robinhood/adapter";',
  "",
  "export default function Page() {",
  '  return <p id="probe">{trustedFactory ? trustedFactory.address : "null"}</p>;',
  "}",
  "",
].join("\n");

const LAYOUT = [
  "export default function RootLayout({ children }: { children: React.ReactNode }) {",
  '  return <html lang="en"><body>{children}</body></html>;',
  "}",
  "",
].join("\n");

describe("trust-config adversary: a sibling module the bundler resolves before config.ts", function () {
  this.timeout(600_000);

  it("the gate does not pass while the built page trusts a factory other than the one it read", () => {
    // 1. The gate, run as CI runs it, on a tree that is app/src plus config.js.
    const tree = mkdtempSync(join(tmpdir(), "trust-config-shadow-"));
    mkdirSync(join(tree, "ops"));
    mkdirSync(join(tree, "app"));
    cpSync(join(ROOT, "ops/trust-config.ts"), join(tree, "ops/trust-config.ts"));
    cpSync(join(ROOT, "app/src"), join(tree, "app/src"), { recursive: true });
    cpSync(join(ROOT, "app/package.json"), join(tree, "app/package.json"));
    // the pinned build files too, so the gate can fail only for the shadow module itself
    cpSync(join(ROOT, "app/next.config.mjs"), join(tree, "app/next.config.mjs"));
    cpSync(join(ROOT, "app/tsconfig.json"), join(tree, "app/tsconfig.json"));
    symlinkSync(join(ROOT, "node_modules"), join(tree, "node_modules"));
    writeFileSync(join(tree, "app/src/lib/robinhood/config.js"), SHADOW_CONFIG_JS);
    const gate = spawnSync(process.execPath, ["--import", "tsx", "ops/trust-config.ts", "--rpc", "http://127.0.0.1:9"], {
      cwd: tree,
      encoding: "utf8",
    });

    // 2. The page, built by the real Next.js from the same lib/ and config.js.
    const app = mkdtempSync(join(tmpdir(), "trust-config-shadow-app-"));
    for (const d of ["lib", "idl", "fixtures"]) cpSync(join(ROOT, "app/src", d), join(app, "src", d), { recursive: true });
    cpSync(join(ROOT, "app/package.json"), join(app, "package.json"));
    cpSync(join(ROOT, "app/tsconfig.json"), join(app, "tsconfig.json"));
    symlinkSync(join(ROOT, "app/node_modules"), join(app, "node_modules"));
    writeFileSync(join(app, "next.config.mjs"), 'export default { outputFileTracingRoot: new URL(".", import.meta.url).pathname };\n');
    writeFileSync(join(app, "src/lib/robinhood/config.js"), SHADOW_CONFIG_JS);
    mkdirSync(join(app, "src/app"));
    writeFileSync(join(app, "src/app/layout.tsx"), LAYOUT);
    writeFileSync(join(app, "src/app/page.tsx"), PROBE_PAGE);
    const build = spawnSync(process.execPath, [join(app, "node_modules/next/dist/bin/next"), "build"], {
      cwd: app,
      encoding: "utf8",
      env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
    });
    assert.equal(build.status, 0, `next build failed:\n${build.stdout}${build.stderr}`);
    const html = readFileSync(join(app, ".next/server/app/index.html"), "utf8");
    const page = /id="probe">([^<]*)</.exec(html)?.[1];
    assert.equal(page, UNREVIEWED, "the built page is bound to config.js, not config.ts");

    // The gate read config.ts (null) and said the page offers no action; the page trusts UNREVIEWED.
    assert.notEqual(
      gate.status,
      0,
      `gate passed while the built page trusts ${page}:\n${gate.stdout}${gate.stderr}`,
    );
    assert.match(`${gate.stderr}`, /config\.js/, "the gate refuses because of the shadow module itself");
  });
});
