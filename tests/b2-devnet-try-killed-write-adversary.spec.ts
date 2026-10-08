/**
 * Adversary r4, PR #30 (fed3d78): the try seed's files on this machine, ops/devnet-cli.ts tryRunFor and tryBinding.
 * The spec: "Safe to re-run: a rerun after a stop at ANY point (including a process killed mid-write of any file)
 * finishes it with the same wallet, from any checkout on the machine" and "once any run on the machine has sent
 * anything for wallet A, no run with another wallet B, from any checkout, may send anything".
 *
 * 1. A run killed while it writes a script key file (keysIn: writeFileSync opens member-N.json with O_TRUNC, then
 *    writes) leaves that file empty. Nothing was sent (the binding, written before the first send, comes after the
 *    keys). The rerun with the same wallet must finish; it must not be stuck on the empty file.
 * 2. Two runs at once, wallets A and B, both pass the pre-check (no binding yet). seedTryCircle's last no-send check
 *    is record.read() then record.write() (ops/demo.ts:456-463); between two processes nothing makes that pair
 *    exclusive, so both can read "no binding". The write that comes second must not replace the first: after it the
 *    second run sends (funding B) and the first run's rerun is refused.
 *
 * HOME is pointed at a fresh temp folder while ops/devnet-cli.ts is imported, so TRY_DIR is a throwaway folder and
 * the real ~/.config is never read. No chain, nothing is sent anywhere.
 */
import assert from "node:assert/strict";
import fs, { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import * as anchor from "@coral-xyz/anchor";

const N = 4;

describe("adversary r4: the try seed's files when a run is killed mid-write, or two run at once", () => {
  let cli: typeof import("../ops/devnet-cli.ts");
  let fakeHome: string;
  const realWrite = fs.writeFileSync;

  before(async () => {
    fakeHome = mkdtempSync(join(tmpdir(), "othello-try-home-"));
    const realHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      cli = await import("../ops/devnet-cli.ts");
    } finally {
      process.env.HOME = realHome;
    }
    assert.ok(cli.TRY_BINDING.startsWith(fakeHome + "/"), "the try folder is not under the temp HOME");
  });

  beforeEach(() => rmSync(dirname(cli.TRY_BINDING), { recursive: true, force: true }));

  afterEach(() => {
    fs.writeFileSync = realWrite;
    syncBuiltinESMExports();
  });

  after(() => {
    if (fakeHome) rmSync(fakeHome, { recursive: true, force: true });
  });

  it("a run killed while writing a key file: the rerun with the same wallet finishes", () => {
    const wallet = anchor.web3.Keypair.generate().publicKey;

    // The kill: member-2.json is opened (created, truncated) and the process dies before the bytes are written.
    fs.writeFileSync = ((path: fs.PathOrFileDescriptor, data: unknown, options?: unknown) => {
      // Any write aimed at member-2.json, or at a temp file for it (so an atomic write still meets the same kill).
      if (String(path).includes("/member-2.json")) {
        fs.closeSync(fs.openSync(path as fs.PathLike, "w", 0o600));
        throw new Error("killed");
      }
      return (realWrite as (...a: unknown[]) => void)(path, data, options);
    }) as typeof fs.writeFileSync;
    syncBuiltinESMExports();
    assert.throws(() => cli.tryRunFor(wallet, N), /killed/, "not vacuous: the run was killed inside a key write");
    fs.writeFileSync = realWrite;
    syncBuiltinESMExports();
    assert.ok(!existsSync(cli.TRY_BINDING), "not vacuous: no binding, so the killed run sent nothing");

    // The rerun, same wallet: must give the four keys (then seedTryCircle binds them and seeds).
    const rerun = cli.tryRunFor(wallet, N);
    assert.equal(rerun.keys.length, N);
  });

  it("two runs at once, wallets A and B: the second binding write does not replace the first", () => {
    const walletA = anchor.web3.Keypair.generate().publicKey;
    const walletB = anchor.web3.Keypair.generate().publicKey;

    // Both runs start before either has bound: both pass seed-try-circle.ts's pre-check, with the same keys. Then
    // seedTryCircle's last check and first write (ops/demo.ts:456-463), as two processes can interleave them. A
    // refusal anywhere in run B's steps counts (a fix may refuse in tryRunFor or in the write).
    const seats = (keys: anchor.web3.Keypair[], w: anchor.web3.PublicKey) => [...keys.map((k) => k.publicKey.toBase58()), w.toBase58()];
    const runA = cli.tryRunFor(walletA, N);
    let refused = false;
    try {
      const runB = cli.tryRunFor(walletB, N);
      assert.equal(runA.binding.read(), null);
      assert.equal(runB.binding.read(), null);
      runA.binding.write(seats(runA.keys, walletA)); // run A goes on to fund wallet A
      runB.binding.write(seats(runB.keys, walletB)); // returning normally, run B goes on to fund wallet B
    } catch {
      refused = true;
    }

    const bound = (JSON.parse(readFileSync(cli.TRY_BINDING, "utf8")) as { members: string[] }).members;
    assert.ok(refused, "run B's binding write succeeded after run A had bound wallet A: run B goes on to send");
    assert.equal(bound[N], walletA.toBase58(), "the binding now names wallet B: run A's rerun is refused after A was funded");
  });
});
