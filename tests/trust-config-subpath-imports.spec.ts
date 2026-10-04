/**
 * Adversary test for CI job `trust-config` (ops/trust-config.ts), ARB-DESIGN r9 sections A, 7.1 and 9.1. The gate
 * states (header, "Always"): "in app/src only lib/robinhood/adapter.ts may import ./config or ./adapter-core (the
 * only modules that take or hold a factory)".
 *
 * importBoundary() resolves only `@/…` and relative specifiers; any other specifier is treated as a package and
 * ignored. Node-style package subpath imports (`"imports"` in app/package.json, `#name` specifiers) are resolved by
 * both Next.js's webpack (enhanced-resolve importsFields) and tsc (moduleResolution "bundler"), and app/package.json
 * is not a pinned build file. So a page can import adapter-core as `#rh/adapter-core` and trust any factory it
 * likes, and the gate still says "only adapter.ts imports it". This test builds a minimal Next app from a copy of the
 * real app/src/lib with the real Next.js; the probe page runs the real checkTrustedAgainst against a factory that
 * is not the configured one (config.ts is null) and prints the verdict.
 *
 * Inputs are constructed here: the address below is derived from a label, and the "chain" is an in-page stub
 * client, because the point is which factory the page may trust, not what is deployed.
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

/** app/package.json plus one ordinary subpath-import alias. */
function withImports(pkgJson: string): string {
  const pkg = JSON.parse(pkgJson) as Record<string, unknown>;
  pkg.imports = { "#rh/*": "./src/lib/robinhood/*.ts" };
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

/** A page outside lib/robinhood that imports the factory-injectable core and trusts its own factory. */
const PROBE_PAGE = [
  'import { keccak256 } from "viem";',
  'import { checkTrustedAgainst } from "#rh/adapter-core";',
  "",
  `const FACTORY = "${UNREVIEWED}" as const;`,
  "const CODE = \"0x60\" as const;",
  "const stub = {",
  "  getCode: async () => CODE,",
  '  readContract: async ({ functionName }: { functionName: string }) => (functionName === "isCircle" ? true : FACTORY),',
  "} as never;",
  "",
  "export default async function Page() {",
  "  const t = await checkTrustedAgainst(stub, \"0x0000000000000000000000000000000000000001\",",
  "    { address: FACTORY, codeHash: keccak256(CODE) });",
  '  return <p id="probe">{t.ok ? `trusted ${FACTORY}` : `refused ${t.reason}`}</p>;',
  "}",
  "",
].join("\n");

const LAYOUT = [
  "export default function RootLayout({ children }: { children: React.ReactNode }) {",
  '  return <html lang="en"><body>{children}</body></html>;',
  "}",
  "",
].join("\n");

describe("trust-config adversary: a page imports adapter-core through package.json subpath imports", function () {
  this.timeout(600_000);

  it("the gate does not pass while a page other than adapter.ts imports adapter-core and trusts its own factory", () => {
    const pkg = withImports(readFileSync(join(ROOT, "app/package.json"), "utf8"));

    // 1. The gate, run as CI runs it, on a tree that is app/src plus the probe page and the imports alias.
    const tree = mkdtempSync(join(tmpdir(), "trust-config-imports-"));
    mkdirSync(join(tree, "ops"));
    mkdirSync(join(tree, "app"));
    cpSync(join(ROOT, "ops/trust-config.ts"), join(tree, "ops/trust-config.ts"));
    cpSync(join(ROOT, "app/src"), join(tree, "app/src"), { recursive: true });
    writeFileSync(join(tree, "app/package.json"), pkg);
    cpSync(join(ROOT, "app/next.config.mjs"), join(tree, "app/next.config.mjs"));
    cpSync(join(ROOT, "app/tsconfig.json"), join(tree, "app/tsconfig.json"));
    symlinkSync(join(ROOT, "node_modules"), join(tree, "node_modules"));
    mkdirSync(join(tree, "app/src/app/rh-probe"));
    writeFileSync(join(tree, "app/src/app/rh-probe/page.tsx"), PROBE_PAGE);
    const gate = spawnSync(process.execPath, ["--import", "tsx", "ops/trust-config.ts", "--rpc", "http://127.0.0.1:9"], {
      cwd: tree,
      encoding: "utf8",
    });

    // 2. The page, built by the real Next.js (type check included) from the same lib/ and alias.
    const app = mkdtempSync(join(tmpdir(), "trust-config-imports-app-"));
    for (const d of ["lib", "idl", "fixtures"]) cpSync(join(ROOT, "app/src", d), join(app, "src", d), { recursive: true });
    writeFileSync(join(app, "package.json"), pkg);
    cpSync(join(ROOT, "app/tsconfig.json"), join(app, "tsconfig.json"));
    symlinkSync(join(ROOT, "app/node_modules"), join(app, "node_modules"));
    writeFileSync(join(app, "next.config.mjs"), 'export default { outputFileTracingRoot: new URL(".", import.meta.url).pathname };\n');
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
    assert.equal(page, `trusted ${UNREVIEWED}`, "the built page ran adapter-core's trust check against its own factory");

    // The gate read config.ts (null) and said only adapter.ts imports the core; a page imports it and trusts UNREVIEWED.
    assert.notEqual(gate.status, 0, `gate passed while a page imports adapter-core:\n${gate.stdout}${gate.stderr}`);
    // either fix names the cause: the importing page, or the alias in app/package.json
    assert.match(`${gate.stderr}`, /rh-probe\/page\.tsx|package\.json/, "the gate names the importing page or the alias");
  });
});
