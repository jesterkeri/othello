/**
 * T00 adversarial test: a mint that does not itself report the claimed symbol
 * must not produce a fixture.
 *
 * Invariant under test, stated by the code itself in ops/xstock-mints.ts:4-10:
 *   "Collateral is identified by mint ADDRESS, never by symbol: Jupiter returns
 *    five tokens named "NFLXx" and only one is real (SPEC 9b.3). ... every entry
 *    is verified on-chain by ops/fetch-fixtures.ts before a fixture is written:
 *    the account must be owned by Token-2022, carry ScaledUiAmountConfig, and
 *    its own TokenMetadata extension must report the symbol claimed below."
 * ADR-012 and SPEC 9b.3 say the same: symbols are never trusted, and no invented
 * stock data may enter tests/fixtures. T00 requires four fixtures, and a fixture
 * whose mint was never identified is not one of them.
 *
 * Fixture provenance: every byte below comes from tests/fixtures/AAPLx.json as
 * committed in 7299282, i.e. the real mainnet account
 * XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp read with getAccountInfo base64
 * from https://api.mainnet-beta.solana.com at slot 449121483 on 2026-09-21.
 * Nothing is invented. Two accounts are derived from those real bytes by editing
 * only the TokenMetadata (TLV type 19) entry:
 *   case A: the entry is removed, modelling a Token-2022 mint that carries
 *           ScaledUiAmountConfig but no on-chain metadata at all;
 *   case B: the entry's name length prefix is set to 0xFFFFFFFF, modelling a
 *           mint whose metadata a hostile issuer made unreadable.
 * In both cases the account is served at the NVDAx allowlist address, modelling
 * the exact ADR-012 threat: an address sourced from a web page turns out not to
 * be the token claimed.
 *
 * Run: pnpm tsx tests/t00-mint-symbol-verification.ts
 * Exits non-zero if ops/fetch-fixtures.ts writes a fixture for an unidentified
 * mint, or reports success for a run that did.
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
const TARGET_SYMBOL = "NVDAx";

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

function writeTlv(data: Buffer, entries: Tlv[]): Buffer {
  const parts: Buffer[] = [data.subarray(0, ACCOUNT_TYPE_OFFSET + 1)];
  for (const e of entries) {
    const header = Buffer.alloc(4);
    header.writeUInt16LE(e.type, 0);
    header.writeUInt16LE(e.value.length, 2);
    parts.push(header, e.value);
  }
  return Buffer.concat(parts);
}

/** Real AAPLx mint bytes with the TokenMetadata entry removed. */
function withoutMetadata(data: Buffer): Buffer {
  return writeTlv(
    data,
    readTlv(data).filter((e) => e.type !== EXT_TOKEN_METADATA),
  );
}

/** Real AAPLx mint bytes whose TokenMetadata name length prefix cannot be read. */
function withUnreadableMetadata(data: Buffer): Buffer {
  const entries = readTlv(data).map((e) => {
    if (e.type !== EXT_TOKEN_METADATA) return e;
    const value = Buffer.from(e.value);
    value.writeUInt32LE(0xffffffff, 64); // update_authority(32) + mint(32), then name length
    return { type: e.type, value };
  });
  return writeTlv(data, entries);
}

function fixture(symbol: string) {
  return JSON.parse(readFileSync(join(FIXTURES, `${symbol}.json`), "utf8"));
}

/** A getAccountInfo stub that serves the committed real bytes, one address doctored. */
async function runFetcher(doctored: Buffer): Promise<{
  status: number | null;
  stdout: string;
  stderr: string;
  runDir: string;
}> {
  const accounts = new Map<string, { data: string; owner: string; lamports: number }>();
  for (const mint of VERIFIED_XSTOCK_MINTS) {
    const f = fixture(mint.symbol);
    accounts.set(mint.address, {
      data: mint.symbol === TARGET_SYMBOL ? doctored.toString("base64") : f.dataBase64,
      owner: f.owner,
      lamports: f.lamports,
    });
  }

  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const rpc = JSON.parse(body);
      const address = rpc.params[0] as string;
      const account = accounts.get(address);
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: rpc.id,
          result: account
            ? {
                context: { slot: 449121483 },
                value: {
                  data: [account.data, "base64"],
                  executable: false,
                  lamports: account.lamports,
                  owner: account.owner,
                  rentEpoch: 18446744073709551615n.toString(),
                  space: Buffer.from(account.data, "base64").length,
                },
              }
            : { context: { slot: 449121483 }, value: null },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;

  const runDir = mkdtempSync(join(tmpdir(), "othello-t00-"));
  const child = spawn(
    join(REPO, "node_modules", ".bin", "tsx"),
    [join(REPO, "ops", "fetch-fixtures.ts")],
    {
      cwd: runDir, // fixtures land here, never over the committed ones
      env: { ...process.env, SOLANA_RPC_URL: `http://127.0.0.1:${port}` },
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c) => (stdout += c));
  child.stderr.on("data", (c) => (stderr += c));
  const status = await new Promise<number | null>((resolve) =>
    child.on("close", (code) => resolve(code)),
  );
  await new Promise<void>((resolve) => server.close(() => resolve()));

  return { status, stdout, stderr, runDir };
}

function check(caseName: string, run: Awaited<ReturnType<typeof runFetcher>>): string[] {
  const failures: string[] = [];
  const written = join(run.runDir, "tests", "fixtures", `${TARGET_SYMBOL}.json`);
  if (existsSync(written)) {
    const f = JSON.parse(readFileSync(written, "utf8"));
    failures.push(
      `${caseName}: fetch-fixtures wrote ${TARGET_SYMBOL}.json for a mint that never ` +
        `reported the symbol ${TARGET_SYMBOL} (onChainMetadata=${JSON.stringify(f.onChainMetadata)}, ` +
        `multiplier=${f.decodedScaledUiAmountConfig.multiplier}, which is Apple's, not NVIDIA's)`,
    );
  }
  if (run.status === 0) {
    failures.push(
      `${caseName}: fetch-fixtures exited 0, so T00 reports four verified fixtures ` +
        `while one mint was never identified`,
    );
  }
  return failures;
}

async function main() {
  const aaplx = Buffer.from(fixture("AAPLx").dataBase64, "base64");
  const failures: string[] = [];

  const noMetadata = await runFetcher(withoutMetadata(aaplx));
  failures.push(...check("case A (mint carries no TokenMetadata)", noMetadata));
  rmSync(noMetadata.runDir, { recursive: true, force: true });

  const badMetadata = await runFetcher(withUnreadableMetadata(aaplx));
  failures.push(...check("case B (mint's TokenMetadata is unreadable)", badMetadata));
  rmSync(badMetadata.runDir, { recursive: true, force: true });

  if (failures.length > 0) {
    console.error("FAILURES:");
    for (const f of failures) console.error(`  ${f}`);
    console.error(
      "\nops/xstock-mints.ts:6-9 says every entry is verified on-chain before a " +
        "fixture is written, and that the mint's own TokenMetadata must report the " +
        "claimed symbol. ops/fetch-fixtures.ts:146 only compares when metadata " +
        "decoded, so a mint with absent or unreadable metadata is accepted unchecked.",
    );
    process.exit(1);
  }

  console.log("OK: an unidentified mint produces no fixture");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
