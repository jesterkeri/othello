/**
 * Adversary test for the prebuilt release path (evm/ARB-FINDINGS.md F-14, Codex code review r2 MAJOR 2, ARB-DESIGN
 * r9 section 9.1): "the bytes CI's gate scans are the bytes Vercel serves". F-14 states that `vercel deploy
 * --prebuilt` "uploads exactly those files", that "every file of the artifact is scanned", that the release record
 * binds one sha256 over the artifact to the commit it was built from, and that CI scans the same kind of artifact
 * "on every push".
 *
 * What vercel@59.11.7 actually uploads for `deploy --prebuilt` is `.vercel/output` PLUS every file named in the
 * `filePathMap` of each function's `.vc-config.json`, read from the project directory (app/), not from
 * `.vercel/output` (vercel/dist/chunks/chunk-G3PXSXIB.js, buildFileTree2: `refs.add(join(path, v))` for each
 * filePathMap value). For this Next app `vercel build` leaves the Robinhood page's own server code
 * (`.next/server/app/robinhood/page.js`) and the rest of `.next/server` as filePathMap entries only. `scanTree` and
 * `artifactDigest` walk `.vercel/output` alone, so those uploaded bytes are neither scanned nor fingerprinted.
 *
 * The test copies the real app (pinned next.config.mjs and tsconfig.json) into a fresh git repo, runs the real
 * offline `vercel build` exactly as the CI job does, then checks:
 *   1. the gate, run as CI and ops/release-robinhood.sh run it, can pass on that unmodified build;
 *   2. an unreviewed address in an uploaded server file of the Robinhood page fails `scanTree`;
 *   3. the release digest moves when an uploaded byte changes (as a rerun of `next build` or `next dev` in app/
 *      between the release scan and `vercel deploy --prebuilt` changes them);
 *   4. with an untracked source page in app/src (a forgotten scratch file, which the build includes), `--record`
 *      does not write a record claiming the commit.
 *
 * Inputs are constructed here: the foreign address is derived from a label, not from any deployment. No network,
 * no Vercel login, no deploy.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  appendFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { getAddress, keccak256, toHex } from "viem";

import { installPinnedCli } from "../ops/release-deploy.ts";
import { USDG, VERCEL_CLI, artifactDigest, scanTree, uploadSet } from "../ops/trust-config.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FOREIGN = getAddress(`0x${keccak256(toHex("unreviewed factory in an uploaded server file")).slice(26)}`);

/** Every `.vc-config.json` filePathMap value that `vercel deploy --prebuilt` (59.11.7) adds to the upload. */
function prebuiltExtraUploads(appDir: string): string[] {
  const out = join(appDir, ".vercel/output");
  const refs = new Set<string>();
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(p);
      else if (n === ".vc-config.json") {
        const c = JSON.parse(readFileSync(p, "utf8")) as { filePathMap?: Record<string, string> };
        for (const v of Object.values(c.filePathMap ?? {})) {
          const rel = relative(appDir, join(appDir, v));
          if (rel.startsWith("..") || isAbsolute(rel)) continue; // the CLI ignores these
          refs.add(rel.split("\\").join("/"));
        }
      }
    }
  };
  walk(out);
  return [...refs].sort();
}

/**
 * The pinned CLI's own prebuilt file collector (`inspectDeploymentFiles`, behind `vercel deploy --dry`: local, no
 * network). CI installs vercel@VERCEL_CLI globally for it; any other version fails here rather than being skipped.
 */
async function pinnedCollector(): Promise<(o: object) => Promise<{ files: { path: string }[] }>> {
  const root = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
  const pkg = join(root, "vercel", "package.json");
  assert.ok(existsSync(pkg), `vercel@${VERCEL_CLI} must be installed globally (npm i -g vercel@${VERCEL_CLI})`);
  assert.equal((JSON.parse(readFileSync(pkg, "utf8")) as { version: string }).version, VERCEL_CLI, "the global vercel is the pinned CLI");
  const cli = (await import(join(root, "vercel", "dist", "chunks", "chunk-G3PXSXIB.js"))) as {
    require_dist(): { inspectDeploymentFiles(o: object): Promise<{ files: { path: string }[] }> };
  };
  return (o) => cli.require_dist().inspectDeploymentFiles(o);
}

/** The release's own CLI: installed by ops/release-deploy.ts from ops/vercel-cli's lockfile (npm ci, scripts off). */
function vercelBin(): { cmd: string; args: string[] } {
  const dir = mkdtempSync(join(tmpdir(), "prebuilt-cli-"));
  return { cmd: process.execPath, args: [installPinnedCli(dir)] };
}

describe("trust-config adversary: what `vercel deploy --prebuilt` uploads is what the gate scanned and fingerprinted", function () {
  this.timeout(900_000);

  let tree = "";
  let app = "";
  let out = "";
  let uploads: string[] = [];
  let gateOnCleanBuild: SpawnSyncReturns<string>;
  let scanWithForeign: string[] = [];
  let digestAtScan = "";
  let digestAfterChange = "";
  let release: SpawnSyncReturns<string>;
  let notCovered: string[] = [];
  let cliUploadCount = 0;
  const record = () => join(tree, "release-record.json");
  const pageServer = ".next/server/app/robinhood/page.js";
  const gate = (...args: string[]) => spawnSync(process.execPath, [
    "--import", "tsx", "ops/trust-config.ts", "--rpc", "http://127.0.0.1:9", ...args,
  ], { cwd: tree, encoding: "utf8" });

  before(async () => {
    tree = mkdtempSync(join(tmpdir(), "trust-config-prebuilt-"));
    app = join(tree, "app");
    out = join(app, ".vercel/output");
    mkdirSync(join(tree, "ops"));
    mkdirSync(app);
    cpSync(join(ROOT, "ops/trust-config.ts"), join(tree, "ops/trust-config.ts"));
    cpSync(join(ROOT, "app/src"), join(app, "src"), { recursive: true });
    for (const f of ["package.json", "next.config.mjs", "tsconfig.json"]) cpSync(join(ROOT, "app", f), join(app, f));
    symlinkSync(join(ROOT, "node_modules"), join(tree, "node_modules"));
    symlinkSync(join(ROOT, "app/node_modules"), join(app, "node_modules"));
    // Build output and scratch dirs are ignored, as the repo's .gitignore ignores app/.vercel/, .next and node_modules.
    writeFileSync(join(tree, ".gitignore"), [
      "node_modules", "app/node_modules", "app/.next/", "app/.vercel/", ".vercel/", "release-record.json", "vercel-built/", "mini-artifact/", "",
    ].join("\n"));

    const git = (...a: string[]) => execFileSync("git", ["-C", tree, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { encoding: "utf8" });
    git("init", "-q");
    git("add", "-A");
    git("commit", "-q", "-m", "reviewed commit");

    // A forgotten scratch page: untracked, not ignored, and a route the build includes.
    mkdirSync(join(app, "src/app/rh-scratch"));
    writeFileSync(join(app, "src/app/rh-scratch/page.tsx"), "export default function Page() {\n  return <p>scratch, not in any commit</p>;\n}\n");

    // Exactly the CI job's offline Vercel build (.github/workflows/evm.yml, trust-config job).
    mkdirSync(join(app, ".vercel"));
    writeFileSync(join(app, ".vercel/project.json"), JSON.stringify({ projectId: "ci-offline", orgId: "ci-offline", settings: { framework: "nextjs", installCommand: "true" } }));
    const vb = vercelBin();
    const build = spawnSync(vb.cmd, [...vb.args, "build", "--yes"], {
      cwd: app,
      encoding: "utf8",
      env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", VERCEL_TELEMETRY_DISABLED: "1" },
    });
    assert.equal(build.status, 0, `vercel build failed:\n${build.stdout}${build.stderr}`);

    // 1. The gate exactly as CI and ops/release-robinhood.sh run it, on the unmodified build.
    gateOnCleanBuild = gate("--vercel-output", "app/.vercel/output");

    // 5. Everything the pinned CLI would upload for `deploy --prebuilt`, by its own collector, against what the scan and
    // the digest cover: the output directory plus uploadSet's filePathMap files and package links.
    const collect = await pinnedCollector();
    const cliFiles = (await collect({ path: app, prebuilt: true, vercelOutputDir: out, debug: false })).files.map((f) => f.path);
    cliUploadCount = cliFiles.length;
    const up = uploadSet(out, app);
    const covered = new Set([...up.files.map((f) => f.path), ...up.dirs.map((d) => d.path)]);
    const outReal = realpathSync(out);
    notCovered = cliFiles.filter((p) => {
      let real: string;
      try { real = realpathSync(join(app, p)); } catch { return true; }
      return !(real.startsWith(outReal + sep) || covered.has(real));
    });

    // 2 and 3. The files the prebuilt deploy uploads besides .vercel/output, and what the scan and digest see of them.
    uploads = prebuiltExtraUploads(app);
    digestAtScan = artifactDigest(out).sha256;
    const page = join(app, pageServer);
    const original = readFileSync(page);
    appendFileSync(page, `\n/* factory: ${FOREIGN} */\n`);
    scanWithForeign = scanTree(out, null);
    digestAfterChange = artifactDigest(out).sha256;
    writeFileSync(page, original);

    // 4. --record with the untracked page still in app/src. The gate cannot run with app/.vercel in place (case 1),
    // so the build is moved aside and a minimal artifact (no functions, so nothing outside it to resolve) is
    // scanned; the working-tree check under test does not look at the artifact.
    renameSync(join(app, ".vercel"), join(tree, "vercel-built"));
    mkdirSync(join(tree, "mini-artifact/static"), { recursive: true });
    writeFileSync(join(tree, "mini-artifact/static/a.js"), `u="${USDG}"`);
    release = gate("--vercel-output", "mini-artifact", "--record", record());
  });

  it("the gate, as CI and the release script run it, passes on an unmodified offline vercel build", () => {
    assert.equal(gateOnCleanBuild.status, 0, `gate refused a clean vercel build:\n${gateOnCleanBuild.stderr.split("\n").slice(0, 6).join("\n")}`);
  });

  it("every file the pinned CLI's own collector would upload is covered by the scan and the digest", () => {
    assert.ok(cliUploadCount > 100, `the collector listed ${cliUploadCount} files`);
    assert.deepEqual(notCovered, [], `vercel@${VERCEL_CLI} would upload files the scan never read`);
  });

  it("an unreviewed address in a file vercel deploy --prebuilt uploads fails the scan", () => {
    assert.ok(uploads.includes(pageServer), `${pageServer} is a filePathMap upload`);
    assert.ok(!existsSync(join(out, pageServer)), "and it is not inside .vercel/output");
    assert.match(scanWithForeign.join("\n"), new RegExp(FOREIGN.slice(2), "i"),
      `scanTree(app/.vercel/output) returned [${scanWithForeign.join("; ")}] while the Robinhood page's uploaded server code holds ${FOREIGN}`);
  });

  it("the release digest changes when a byte vercel deploy --prebuilt uploads changes", () => {
    assert.notEqual(digestAfterChange, digestAtScan, `digest ${digestAtScan} is unchanged although ${pageServer}, which the deploy uploads, changed`);
  });

  it("no release record claims a clean commit while an untracked source page (which the build includes) is present", () => {
    const built = readdirSync(join(tree, "vercel-built/output/functions"));
    assert.ok(built.some((n) => n.startsWith("rh-scratch")) || existsSync(join(tree, "vercel-built/output/static/rh-scratch.html")),
      "the build includes the untracked page");
    const written = existsSync(record()) ? readFileSync(record(), "utf8") : "";
    assert.equal(written, "", `a release record was written for a tree with an untracked page:\n${written}${release.stdout}`);
    assert.match(`${release.stderr}`, /untracked|uncommitted|commit/i, "refused because of the working tree, not for another reason");
  });
});
