/**
 * Adversary test for ops/trust-config.ts artifactDigest and ops/release-deploy.ts deployRecorded (Codex code review
 * r3 M1: "rehash the exact upload set immediately before `vercel deploy --prebuilt`, and refuse on any difference").
 *
 * The digest joins `path<TAB>...` lines with "\n". cliExtraUploads refuses a tab or line break in a NAME in the project
 * (node_modules skipped) and uploadSet refuses one in a filePathMap key or value, but the text of a linked filePathMap
 * source is written into its line unchecked (`\t-> ${u.link}`). A link whose text reaches a file in node_modules whose
 * name holds "\n<a whole digest line>" makes one recorded line read as two. After the record, pointing the link at the
 * plain name and adding that second line's file to the output gives the same digest and the same file list, so the
 * deploy runs although the upload set gained a file.
 *
 * Inputs are built here with the repo's own artifactDigest, scanTree and writeRecord. No network; vercel is a spy.
 *
 *   npx mocha --import=tsx tests/release-deploy-link-text-newline-adversary.spec.ts
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { deployRecorded, type Git, type Run } from "../ops/release-deploy.ts";
import { fakePinnedCli, reviewedTarget } from "./fake-pinned-cli.ts";
import { USDG, artifactDigest, cliExtraUploads, scanTree, writeRecord } from "../ops/trust-config.ts";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

describe("release deploy adversary: a line break in a filePathMap source's link text", () => {
  it("a file added to the output after the record, hidden by a recorded link text, is refused", async () => {
    const root = mkdtempSync(join(tmpdir(), "release-deploy-linknl-"));
    const app = join(root, "app");
    const out = join(app, ".vercel", "output");
    mkdirSync(join(out, "static"), { recursive: true });
    mkdirSync(join(out, "functions", "robinhood.func"), { recursive: true });
    mkdirSync(join(app, "node_modules"), { recursive: true });
    writeFileSync(join(out, "config.json"), JSON.stringify({ version: 3 }));
    writeFileSync(join(out, "static", "chunk.js"), `const usdg = "${USDG}";`);
    writeFileSync(
      join(out, "functions", "robinhood.func", ".vc-config.json"),
      JSON.stringify({ runtime: "nodejs22.x", handler: "index.js", filePathMap: { "lib.js": "src-link.js" } }),
    );
    writeFileSync(join(app, "node_modules", "p"), "module.exports = 1");

    // the line the late file will produce, learned from the repo's own digest of the late state
    const late = join(out, "zzz-late.js");
    symlinkSync("node_modules/p", join(app, "src-link.js"));
    writeFileSync(late, "unreviewed");
    const lateLine = artifactDigest(out, app).lines.find((l) => l.startsWith("zzz-late.js\t"))!;
    rmSync(late);
    rmSync(join(app, "src-link.js"));

    // recorded state: the link names a node_modules file whose name carries that line after a line break
    writeFileSync(join(app, "node_modules", `p\n${lateLine}`), "module.exports = 1");
    symlinkSync(`node_modules/p\n${lateLine}`, join(app, "src-link.js"));
    // a release scan that refuses this state is a fix too: the record is never written
    if (scanTree(out, null, app).length) return;
    mkdirSync(join(root, "release"));
    const record = join(root, "release", "robinhood-prebuilt.json");
    const recorded = artifactDigest(out, app);
    reviewedTarget(root); // a reviewed link before the record (Codex r4 F1)
    writeRecord(record, recorded, COMMIT, null, root);

    // after the record: the link names the plain file, and a new file is added to the uploaded output
    rmSync(join(app, "src-link.js"));
    symlinkSync("node_modules/p", join(app, "src-link.js"));
    writeFileSync(late, "unreviewed");
    assert.deepEqual(cliExtraUploads(app), [], "precondition: nothing else is refused");
    const now = artifactDigest(out, app);
    assert.ok(now.lines.includes(lateLine), "precondition: the output now holds a file the record never had");

    const calls: string[][] = [];
    const run: Run = async (_c, args) => { calls.push(args); return { code: 0, stdout: "https://othello-adv-test.vercel.app\n" }; };
    const git: Git = { head: () => COMMIT, changed: () => ["release/robinhood-prebuilt.json", "release/robinhood-prebuilt.files.txt"] };
    const r = await deployRecorded({ cli: fakePinnedCli(), target: reviewedTarget(root), root, recordFile: record, prod: false, run, git });
    assert.equal(r.ok, false, `deployRecorded deployed (${JSON.stringify(r)}) an output with an added file zzz-late.js`);
    assert.equal(calls.length, 0, "vercel was never run");
  });
});
