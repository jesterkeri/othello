/**
 * PR #22, Codex r1 (U5): the adapter's optional onSent(hash) had no direct test of when it runs or of a callback that
 * throws. Rules pinned (app/src/lib/robinhood/adapter-core.ts send): onSent runs once, with the wallet's own hash,
 * after writeContract and before the wait for the receipt; it never runs when nothing was sent (a refusal in
 * simulation, a wallet rejection); a throw inside it changes nothing about what is sent or what the action returns.
 *
 * The real createRobinhoodAdapterWith, against recorded stand-ins for viem's public and wallet clients (no chain, no
 * transaction). The trust check runs for real over the stand-ins' code and registry answers.
 *
 *   npx mocha --import=tsx --timeout 60000 tests/a5-adapter-onsent.spec.ts
 */
import assert from "node:assert/strict";

import { keccak256, type Hex } from "viem";

import { createRobinhoodAdapterWith, type RobinhoodDeps } from "../app/src/lib/robinhood/adapter-core.ts";

const CIRCLE = "0x9999999999999999999999999999999999999999" as const;
const FACTORY = "0x8888888888888888888888888888888888888888" as const;
const ME = "0x1111111111111111111111111111111111111111" as const;
const CODE = "0x6001600101" as Hex;
const HASH = `0x${"ab".repeat(32)}` as Hex;

type Opts = { simulate?: "ok" | "revert"; wallet?: "sends" | "rejects"; onSent?: (h: Hex) => void };

function rig(o: Opts = {}) {
  const log: string[] = [];
  const written: unknown[] = [];
  const publicClient = {
    getChainId: async () => 46630,
    getCode: async () => CODE,
    readContract: async ({ functionName }: { functionName: string }) => (functionName === "isCircle" ? true : FACTORY),
    simulateContract: async (call: Record<string, unknown>) => {
      log.push("simulate");
      if (o.simulate === "revert") throw Object.assign(new Error("RoundNotFunded"), { name: "ContractFunctionRevertedError", data: { errorName: "RoundNotFunded", args: [] } });
      return { request: { address: call.address, functionName: call.functionName, args: call.args, account: call.account } };
    },
    estimateContractGas: async () => { log.push("estimate"); return 100_000n; },
    waitForTransactionReceipt: async ({ hash }: { hash: Hex }) => { log.push("receipt"); return { transactionHash: hash, status: "success" }; },
  };
  const walletClient = {
    chain: null,
    getChainId: async () => 46630,
    writeContract: async (req: unknown) => {
      log.push("write");
      written.push(req);
      if (o.wallet === "rejects") throw Object.assign(new Error("User rejected the request."), { name: "UserRejectedRequestError" });
      return HASH;
    },
  };
  const deps = {
    publicClient, walletClient, account: ME, circle: CIRCLE, factory: { address: FACTORY, codeHash: keccak256(CODE) },
    onSent: o.onSent ? (h: Hex) => { log.push("onSent"); o.onSent!(h); } : undefined,
  } as unknown as RobinhoodDeps;
  return { adapter: createRobinhoodAdapterWith(deps), log, written };
}

describe("PR #22: the adapter's onSent view callback", () => {
  it("runs once with the wallet's hash, after the wallet sends and before the receipt", async () => {
    const seen: Hex[] = [];
    const { adapter, log } = rig({ onSent: (h) => seen.push(h) });
    const out = await adapter.releasePot({});
    assert.deepEqual(out, { ok: true, txHash: HASH });
    assert.deepEqual(seen, [HASH]);
    assert.deepEqual(log.slice(log.indexOf("write")), ["write", "onSent", "receipt"]);
  });

  it("a callback that throws changes nothing: same transaction sent, same result", async () => {
    const plain = rig();
    const throwing = rig({ onSent: () => { throw new Error("view crashed"); } });
    const a = await plain.adapter.releasePot({});
    const b = await throwing.adapter.releasePot({});
    assert.deepEqual(b, a);
    assert.deepEqual(throwing.written, plain.written, "the transaction asked of the wallet is the same");
    assert.ok(throwing.log.includes("receipt"), "the receipt is still awaited");
  });

  it("never runs when the contract refuses in simulation (nothing sent)", async () => {
    const { adapter, log } = rig({ simulate: "revert", onSent: () => {} });
    const out = await adapter.releasePot({});
    assert.equal(out.ok, false);
    assert.ok(!log.includes("write") && !log.includes("onSent"), log.join(" "));
  });

  it("never runs when the wallet rejects (nothing sent)", async () => {
    const { adapter, log } = rig({ wallet: "rejects", onSent: () => {} });
    const out = await adapter.releasePot({});
    assert.equal(out.ok, false);
    assert.ok(log.includes("write") && !log.includes("onSent"), log.join(" "));
  });
});
