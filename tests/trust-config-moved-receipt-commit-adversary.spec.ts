/**
 * Adversary test for CI job `trust-config` (ops/trust-config.ts) rule 2: "the receipt's commit (the reviewed commit
 * Joshua deployed from) is an ancestor of HEAD, and since it nothing in the contract bundle or what builds it changed"
 * (ops/trust-config.ts header, rule 2), so that the gate "catches ... any change to the contract bundle after the
 * deploy" (same header, "Limit").
 *
 * The deployed commit was read from the receipt's "commit" field (main(): changedSince(receipt?.commit)), and the
 * receipt (evm/broadcast/...) is not in CONTRACT_BUNDLE, so nothing stops a later commit from rewriting that field.
 * Point it at the commit that changed the bundle (here core/actions, the action profiles the page uses) and rule 2
 * diffs from there: the bundle change is behind the compared commit and is never listed. Rules 1, 3, 4 and 5 read
 * the receipt's address and transaction, the chain and the compiled factory, none of which a core/ (or evm/test,
 * evm/script, .gitmodules, foundry config) change touches.
 *
 * The git history is constructed here in a temporary repository holding a copy of ops/trust-config.ts (its ROOT
 * is the directory above ops/), as in trust-config-ref-named-commit-adversary.spec.ts. The receipt text is the
 * repository's own receipt with only its "commit" field replaced. Fixed by pinning the deployed commit in the gate
 * (DEPLOYED_COMMIT): the receipt must name it, and rule 2 measures from it.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const RECEIPT = "evm/broadcast/DeployFactory.s.sol/46630/run-latest.json";

describe("trust-config adversary: a receipt whose commit field is moved forward hides a contract-bundle change (ops/trust-config.ts rule 2)", function () {
  this.timeout(60_000);

  it("a core/ change after the deploy is still reported after the receipt's commit is rewritten to point past it", async () => {
    const repo = mkdtempSync(join(tmpdir(), "trust-config-moved-commit-"));
    mkdirSync(join(repo, "ops"));
    mkdirSync(join(repo, "core/actions"), { recursive: true });
    mkdirSync(join(repo, "evm/broadcast/DeployFactory.s.sol/46630"), { recursive: true });
    cpSync(join(ROOT, "ops/trust-config.ts"), join(repo, "ops/trust-config.ts"));
    symlinkSync(join(ROOT, "node_modules"), join(repo, "node_modules"));
    const git = (...a: string[]) =>
      execFileSync("git", ["-C", repo, "-c", "user.email=adversary@test", "-c", "user.name=adversary", ...a], { encoding: "utf8" });
    const receiptWith = (commit: string) => {
      const r = JSON.parse(readFileSync(join(ROOT, RECEIPT), "utf8")) as { commit: string };
      r.commit = commit;
      writeFileSync(join(repo, RECEIPT), JSON.stringify(r, null, 2) + "\n");
    };
    git("init", "-q");
    writeFileSync(join(repo, "core/actions/standard.json"), '{"rounds": 10}\n');
    git("add", "ops", "core");
    git("commit", "-qm", "stands in for the reviewed, deployed commit");
    const deployed = git("rev-parse", "--short=7", "HEAD").trim(); // as Foundry's receipt records it
    const deployedFull = git("rev-parse", "HEAD").trim();

    receiptWith(deployed);
    git("add", RECEIPT);
    git("commit", "-qm", "config: the deployed factory and its broadcast receipt");

    writeFileSync(join(repo, "core/actions/standard.json"), '{"rounds": 99}\n');
    git("commit", "-qam", "after the deploy: the contract bundle (core/) changes");
    const moved = git("rev-parse", "--short=7", "HEAD").trim();
    assert.ok(git("diff", "--name-only", deployed, "HEAD").split("\n").includes("core/actions/standard.json"), "precondition: git lists the change");

    receiptWith(moved); // only the receipt's commit field changes; evm/broadcast is not in CONTRACT_BUNDLE
    git("commit", "-qam", "receipt: commit field rewritten");

    // the gate copy pins this repository's deployed commit, as the real gate pins 3429255 (DEPLOYED_COMMIT)
    const gateFile = join(repo, "ops/trust-config.ts");
    const pinned = readFileSync(gateFile, "utf8").replace(/^export const DEPLOYED_COMMIT = "[0-9a-f]{40}";$/m,
      `export const DEPLOYED_COMMIT = "${deployedFull}";`);
    assert.ok(pinned.includes(`DEPLOYED_COMMIT = "${deployedFull}"`), "precondition: the gate pins a deployed commit");
    writeFileSync(gateFile, pinned);
    const gate = (await import(pathToFileURL(gateFile).href)) as typeof import("../ops/trust-config.ts");
    const receipt = JSON.parse(readFileSync(gate.PATHS.receipt, "utf8")) as { commit?: string };
    assert.equal(receipt.commit, moved, "precondition: the gate reads the rewritten receipt");
    // the rewritten receipt is refused, and the freeze is measured from the pinned commit, which still sees the change
    assert.equal(gate.receiptCommitIsDeployed(receipt.commit), false, "a receipt naming a later commit is accepted");
    assert.equal(gate.receiptCommitIsDeployed(deployed), true);
    const changed = gate.changedSince(gate.DEPLOYED_COMMIT); // exactly what main() passes to verify() as changedSinceReceipt
    assert.ok(changed === null || changed.filter(gate.CONTRACT_BUNDLE).includes("core/actions/standard.json"),
      `rule 2 saw ${JSON.stringify(changed)} (bundle part ${JSON.stringify(changed?.filter(gate.CONTRACT_BUNDLE))}): ` +
      `core/actions/standard.json changed after the deployed commit ${deployed} and passed`);
  });
});
