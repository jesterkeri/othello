/**
 * T00 adversarial test: only a mint that proves its own identity, from an endpoint
 * that proves it is mainnet, may become a fixture.
 *
 * Invariant under test, from ops/xstock-mints.ts and ADR-012: collateral is
 * identified by mint ADDRESS, never by symbol, because five Solana tokens are named
 * "NFLXx" and one is real. A fixture whose mint was never identified is not one of
 * the four T00 requires.
 *
 * Fixture provenance: every byte comes from tests/fixtures/*.json, the real mainnet
 * accounts read with getAccountInfo base64 from api.mainnet-beta.solana.com on
 * 2026-09-21. Each case derives an account from those real bytes by editing exactly
 * one thing, and serves it at the NVDAx allowlist address, modelling the ADR-012
 * threat: an address sourced from a web page turns out not to be the token claimed.
 *
 * Every case asserts the SPECIFIC failure it expects, so a case cannot pass because
 * some earlier unrelated check happened to fail first, and the control case proves
 * the harness can still produce fixtures at all.
 *
 * Run: pnpm tsx tests/t00-mint-symbol-verification.ts
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { VERIFIED_XSTOCK_MINTS } from "../ops/xstock-mints.ts";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const FIXTURES = join(REPO, "tests", "fixtures");
const ACCOUNT_TYPE_OFFSET = 165;
const EXT_TOKEN_METADATA = 19;
const EXT_SCALED_UI_AMOUNT = 25;
const TARGET_SYMBOL = "NVDAx";
const MAINNET_GENESIS_HASH = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

type Tlv = { type: number; value: Buffer };

function readTlv(data: Buffer): Tlv[] {
  const out: Tlv[] = [];
  let off = ACCOUNT_TYPE_OFFSET + 1;
  while (off + 4 <= data.length) {
    const type = data.readUInt16LE(off);
    const len = data.readUInt16LE(off + 2);
    out.push({ type, value: data.subarray(off + 4, off + 4 + len) });
    off = off + 4 + len;
  }
  return out;
}

function writeTlv(data: Buffer, entries: Tlv[], trailing?: Buffer): Buffer {
  const parts: Buffer[] = [data.subarray(0, ACCOUNT_TYPE_OFFSET + 1)];
  for (const e of entries) {
    const header = Buffer.alloc(4);
    header.writeUInt16LE(e.type, 0);
    header.writeUInt16LE(e.value.length, 2);
    parts.push(header, e.value);
  }
  if (trailing) parts.push(trailing);
  return Buffer.concat(parts);
}

const mapExt = (data: Buffer, type: number, f: (v: Buffer) => Buffer) =>
  writeTlv(
    data,
    readTlv(data).map((e) => (e.type === type ? { type: e.type, value: f(Buffer.from(e.value)) } : e)),
  );

const fixture = (symbol: string) =>
  JSON.parse(readFileSync(join(FIXTURES, `${symbol}.json`), "utf8"));

const bytesOf = (symbol: string) => Buffer.from(fixture(symbol).dataBase64, "base64");

/** The metadata symbol sits after update_authority(32) + mint(32) + a u32 name length. */
function symbolOffset(meta: Buffer): number {
  const nameLen = meta.readUInt32LE(64);
  return 64 + 4 + nameLen + 4;
}

type Case = {
  name: string;
  account?: Buffer;
  genesisHash?: string;
  expectExit: number;
  expectText: string;
  expectFixture: boolean;
};

async function runFetcher(account: Buffer | undefined, genesisHash: string) {
  const accounts = new Map<string, { data: string; owner: string }>();
  for (const mint of VERIFIED_XSTOCK_MINTS) {
    const f = fixture(mint.symbol);
    accounts.set(mint.address, {
      data: account && mint.symbol === TARGET_SYMBOL ? account.toString("base64") : f.dataBase64,
      owner: f.owner,
    });
  }

  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const rpc = JSON.parse(body);
      res.setHeader("content-type", "application/json");
      if (rpc.method === "getGenesisHash") {
        res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: genesisHash }));
        return;
      }
      const acct = accounts.get(rpc.params[0] as string);
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: rpc.id,
          result: {
            context: { slot: 449121483 },
            value: acct
              ? { data: [acct.data, "base64"], executable: false, lamports: 1, owner: acct.owner, space: 0 }
              : null,
          },
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;

  const runDir = mkdtempSync(join(tmpdir(), "othello-t00-"));
  const child = spawn(join(REPO, "node_modules", ".bin", "tsx"), [join(REPO, "ops", "fetch-fixtures.ts")], {
    cwd: runDir, // fixtures land here, never over the committed ones
    env: { ...process.env, SOLANA_RPC_URL: `http://127.0.0.1:${port}` },
  });
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (out += c));
  const status = await new Promise<number | null>((r) => child.on("close", r));
  await new Promise<void>((r) => server.close(() => r()));
  return { status, out, runDir };
}

async function main() {
  const aaplx = bytesOf("AAPLx");
  // NVDAx's own real bytes are the base for every case that must reach a check
  // beyond identity: doctoring one thing then isolates that check. AAPLx bytes are
  // used where the case IS a mismatch with the address they are served at.
  const nvdax = bytesOf(TARGET_SYMBOL);
  const aaplxMeta = readTlv(aaplx).find((e) => e.type === EXT_TOKEN_METADATA)!.value;

  // AAPLx bytes relabelled NVDAx and pointed at NVDAx's address: symbol, embedded
  // mint and both issuer authorities all check out, because they are genuinely
  // Backed's. Only the metadata URI still names AAPLx.
  const relabelled = mapExt(aaplx, EXT_TOKEN_METADATA, (v) => {
    v.write(TARGET_SYMBOL, symbolOffset(v), "utf8");
    readTlv(nvdax)
      .find((e) => e.type === EXT_TOKEN_METADATA)!
      .value.copy(v, 32, 32, 64);
    return v;
  });

  const cases: Case[] = [
    {
      name: "control (untouched real bytes)",
      expectExit: 0,
      expectText: "NFLXx acceptance OK",
      expectFixture: true,
    },
    {
      name: "endpoint is not mainnet",
      genesisHash: "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY",
      expectExit: 1,
      expectText: "not mainnet-beta's",
      expectFixture: false,
    },
    {
      name: "mint carries no TokenMetadata",
      account: writeTlv(nvdax, readTlv(nvdax).filter((e) => e.type !== EXT_TOKEN_METADATA)),
      expectExit: 1,
      expectText: "carries no TokenMetadata extension",
      expectFixture: false,
    },
    {
      name: "TokenMetadata is unreadable",
      account: mapExt(nvdax, EXT_TOKEN_METADATA, (v) => {
        v.writeUInt32LE(0xffffffff, 64);
        return v;
      }),
      expectExit: 1,
      expectText: "past the end of the extension",
      expectFixture: false,
    },
    {
      name: "mint reports a different symbol",
      account: aaplx,
      expectExit: 1,
      expectText: 'mint metadata says symbol "AAPLx"',
      expectFixture: false,
    },
    {
      name: "TokenMetadata names a different mint",
      account: mapExt(nvdax, EXT_TOKEN_METADATA, (v) => {
        aaplxMeta.copy(v, 32, 32, 64); // embedded mint pubkey now AAPLx's
        return v;
      }),
      expectExit: 1,
      expectText: "do not belong to the address they are saved under",
      expectFixture: false,
    },
    {
      name: "scaled-UI authority is not the issuer's",
      account: mapExt(nvdax, EXT_SCALED_UI_AMOUNT, (v) => {
        Buffer.alloc(32, 7).copy(v, 0);
        return v;
      }),
      expectExit: 1,
      expectText: "not the xStock issuer",
      expectFixture: false,
    },
    {
      name: "a required extension appears twice",
      account: (() => {
        const entries = readTlv(nvdax);
        const scaled = entries.find((e) => e.type === EXT_SCALED_UI_AMOUNT)!;
        return writeTlv(nvdax, [...entries, { type: scaled.type, value: scaled.value }]);
      })(),
      expectExit: 1,
      expectText: "appears more than once",
      expectFixture: false,
    },
    {
      name: "a genuine Backed mint relabelled as another xStock",
      account: relabelled,
      expectExit: 1,
      expectText: "is not a xstocks-metadata.backed.fi document naming NVDAx",
      expectFixture: false,
    },
    {
      name: "account has trailing bytes after the TLV region",
      account: writeTlv(nvdax, readTlv(nvdax), Buffer.alloc(2, 0xab)),
      expectExit: 1,
      expectText: "trailing bytes",
      expectFixture: false,
    },
  ];

  const failures: string[] = [];
  for (const c of cases) {
    const run = await runFetcher(c.account, c.genesisHash ?? MAINNET_GENESIS_HASH);
    const target = join(run.runDir, "tests", "fixtures", `${TARGET_SYMBOL}.json`);
    const wrote = existsSync(target);

    if (run.status !== c.expectExit) {
      failures.push(`${c.name}: exited ${run.status}, expected ${c.expectExit}`);
    }
    if (!run.out.includes(c.expectText)) {
      failures.push(
        `${c.name}: output did not contain "${c.expectText}", so this case may have failed for ` +
          `an unrelated reason. Got:\n${run.out.trim().split("\n").slice(0, 4).join("\n")}`,
      );
    }
    if (wrote !== c.expectFixture) {
      failures.push(
        `${c.name}: ${wrote ? "wrote" : "did not write"} ${TARGET_SYMBOL}.json, expected ` +
          `${c.expectFixture ? "it to be written" : "no fixture for an unverified mint"}`,
      );
    }
    // Nothing is written until every mint passes, so a failing run leaves none.
    if (c.expectExit !== 0) {
      const any = VERIFIED_XSTOCK_MINTS.filter((m) =>
        existsSync(join(run.runDir, "tests", "fixtures", `${m.symbol}.json`)),
      );
      if (any.length > 0) {
        failures.push(
          `${c.name}: a failed run left ${any.map((m) => m.symbol).join(", ")} on disk, ` +
            `so T03/T06 could load a mixed snapshot`,
        );
      }
    }
    rmSync(run.runDir, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    console.error("FAILURES:");
    for (const f of failures) console.error(`  ${f}`);
    process.exit(1);
  }
  console.log(`OK: ${cases.length} cases, only a mint that proves its identity becomes a fixture`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
