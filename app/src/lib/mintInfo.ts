/**
 * Everything a Token-2022 mint says about itself that the asset page shows:
 * its authorities, its extensions, the issuer powers they grant, and the name
 * and symbol in its own on-chain metadata. Read from raw bytes, display only.
 *
 * Layout: the 82-byte mint (mint authority COption at 0, supply u64 at 36,
 * decimals at 44, freeze authority COption at 46), padding to 165, account
 * type at 165, TLV entries from 166. Extension numbers are Token-2022's
 * ExtensionType; tests/app-mint-info.spec.ts checks this decoder against the
 * four real xStock mints.
 *
 * No "@/" imports: the test runs it from the repo root.
 */
import { PublicKey } from "@solana/web3.js";

import { readScaledUi, type ScaledUi } from "./scaledUi";

const EXTENSION_NAMES: Record<number, string> = {
  1: "Transfer fee",
  3: "Mint close authority",
  4: "Confidential transfers",
  6: "Default account state",
  9: "Non-transferable",
  10: "Interest bearing",
  12: "Permanent delegate",
  14: "Transfer hook",
  16: "Confidential transfer fee",
  18: "Metadata pointer",
  19: "Token metadata",
  20: "Group pointer",
  21: "Token group",
  22: "Group member pointer",
  23: "Token group member",
  24: "Confidential mint and burn",
  25: "Scaled UI amount",
  26: "Pausable",
};

export type MintInfo = {
  decimals: number;
  /** Raw supply, u64, as a string. */
  supply: string;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  /** Every extension present, in the order the mint lists them. */
  extensions: { type: number; name: string }[];
  metadata: { name: string; symbol: string; uri: string } | null;
  scaledUi: ScaledUi | null;
  /** Who may change the multiplier (UpdateMultiplier); null means nobody can. */
  scaledUiAuthority: string | null;
  permanentDelegate: string | null;
  pausable: { authority: string | null; paused: boolean } | null;
  /** New token accounts start usable ("initialized") or frozen. */
  defaultAccountState: "initialized" | "frozen" | null;
  transferHook: { authority: string | null; program: string | null } | null;
  confidentialTransfers: { authority: string | null; autoApprove: boolean } | null;
};

/** OptionalNonZeroPubkey: 32 zero bytes mean "none". */
function optionalKey(bytes: Uint8Array): string | null {
  return bytes.some((b) => b !== 0) ? new PublicKey(bytes).toBase58() : null;
}

/** COption<Pubkey>: a u32 tag (1 = Some), then 32 bytes. */
function cOptionKey(data: Uint8Array, at: number): string | null {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return v.getUint32(at, true) === 1 ? new PublicKey(data.subarray(at + 4, at + 36)).toBase58() : null;
}

/** Token metadata (spl-token-metadata-interface): update authority 32, mint 32, then name, symbol, uri as u32-length strings. */
function readMetadata(value: Uint8Array): MintInfo["metadata"] {
  const v = new DataView(value.buffer, value.byteOffset, value.byteLength);
  const text = new TextDecoder();
  let p = 64;
  const next = () => {
    if (p + 4 > value.length) throw new Error("truncated token metadata");
    const n = v.getUint32(p, true);
    if (p + 4 + n > value.length) throw new Error("truncated token metadata");
    const s = text.decode(value.subarray(p + 4, p + 4 + n));
    p += 4 + n;
    return s;
  };
  return { name: next(), symbol: next(), uri: next() };
}

/** Throws on anything that is not an initialized Token-2022 mint, rather than guessing. */
export function readMintInfo(data: Uint8Array): MintInfo {
  if (data.length < 82 || data[45] !== 1) throw new Error("not an initialized mint");
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const info: MintInfo = {
    decimals: data[44]!,
    supply: v.getBigUint64(36, true).toString(),
    mintAuthority: cOptionKey(data, 0),
    freezeAuthority: cOptionKey(data, 46),
    extensions: [],
    metadata: null,
    scaledUi: readScaledUi(data),
    scaledUiAuthority: null,
    permanentDelegate: null,
    pausable: null,
    defaultAccountState: null,
    transferHook: null,
    confidentialTransfers: null,
  };
  if (data.length <= 166) return info;
  if (data[165] !== 1) throw new Error("not a Token-2022 mint account");

  let off = 166;
  while (off + 4 <= data.length) {
    const type = v.getUint16(off, true);
    const len = v.getUint16(off + 2, true);
    if (type === 0) break;
    if (off + 4 + len > data.length) throw new Error("truncated extension list");
    const value = data.subarray(off + 4, off + 4 + len);
    info.extensions.push({ type, name: EXTENSION_NAMES[type] ?? `Extension ${type}` });
    if (type === 12 && len >= 32) info.permanentDelegate = optionalKey(value.subarray(0, 32));
    // T18 adversary: the extension's authority is optional; revoked (all zeros), nobody can change it.
    if (type === 25 && len >= 32) info.scaledUiAuthority = optionalKey(value.subarray(0, 32));
    if (type === 26 && len >= 33) info.pausable = { authority: optionalKey(value.subarray(0, 32)), paused: value[32] === 1 };
    if (type === 6 && len >= 1) info.defaultAccountState = value[0] === 2 ? "frozen" : "initialized";
    if (type === 14 && len >= 64) info.transferHook = { authority: optionalKey(value.subarray(0, 32)), program: optionalKey(value.subarray(32, 64)) };
    if (type === 4 && len >= 33) info.confidentialTransfers = { authority: optionalKey(value.subarray(0, 32)), autoApprove: value[32] === 1 };
    if (type === 19) info.metadata = readMetadata(value);
    off += 4 + len;
  }
  return info;
}
