/**
 * Adversary test for CI job `trust-config` (ops/trust-config.ts) rule 2: since the receipt's commit nothing in the
 * contract bundle may change (CONTRACT_BUNDLE: evm/src, evm/script, evm/test, core/, ...; ARB-DESIGN r11 §8).
 *
 * changedSince() lists paths with `git diff --name-only`, whose output follows core.quotePath (on by default): a path
 * with a byte above 0x7f, a tab, a quote or a backslash is printed in C-style quotes, "evm/src/Fa\303\247ade.sol".
 * CONTRACT_BUNDLE anchors on ^evm/(src|...)/, so the quoted line never matches and a new or edited file of the
 * contract bundle passes as page bundle.
 *
 * The git history is constructed here in a temporary repository holding a copy of ops/trust-config.ts (its ROOT
 * is the directory above ops/), as in trust-config-rename-hides-delete.spec.ts.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

describe("trust-config adversary: a quoted path escapes CONTRACT_BUNDLE (ops/trust-config.ts rule 2)", function () {
  this.timeout(60_000);

  for (const name of ["evm/src/Façade.sol", "evm/test/a\tb.t.sol", "core/réf.py"]) {
    it(`adding ${JSON.stringify(name)} after the deployed commit is reported as a contract bundle change`, async () => {
      const repo = mkdtempSync(join(tmpdir(), "trust-config-quoted-"));
      mkdirSync(join(repo, "ops"));
      mkdirSync(join(repo, "evm/src"), { recursive: true });
      mkdirSync(join(repo, "evm/test"), { recursive: true });
      mkdirSync(join(repo, "core"));
      cpSync(join(ROOT, "ops/trust-config.ts"), join(repo, "ops/trust-config.ts"));
      cpSync(join(ROOT, "evm/foundry.toml"), join(repo, "evm/foundry.toml"));
      symlinkSync(join(ROOT, "node_modules"), join(repo, "node_modules"));
      const git = (...a: string[]) =>
        execFileSync("git", ["-C", repo, "-c", "user.email=adversary@test", "-c", "user.name=adversary", ...a], { encoding: "utf8" });
      git("init", "-q");
      git("add", "ops", "evm");
      git("commit", "-qm", "stands in for the reviewed, deployed commit");
      const deployed = git("rev-parse", "HEAD").trim();
      writeFileSync(join(repo, name), "// SPDX-License-Identifier: MIT\npragma solidity 0.8.30;\n");
      git("add", "--", name);
      git("commit", "-qm", "after the deploy");
      const tracked = git("ls-tree", "-r", "-z", "--name-only", "HEAD").split("\0");
      assert.ok(tracked.includes(name), `${JSON.stringify(name)} is committed at HEAD`);

      const gate = (await import(pathToFileURL(join(repo, "ops/trust-config.ts")).href)) as typeof import("../ops/trust-config.ts");
      const changed = gate.changedSince(deployed);
      assert.ok(changed, "the deployed commit is an ancestor of HEAD");
      assert.ok(changed.length > 0, "git reported the added file");
      const refused = changed.filter(gate.CONTRACT_BUNDLE);
      assert.ok(refused.length > 0, `rule 2 saw ${JSON.stringify(changed)} and refused none: a contract bundle file passed as page bundle`);
    });
  }
});
