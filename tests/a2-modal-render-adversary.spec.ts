/**
 * Adversary, A2-SWITCH (othello-design/arb/A2-SWITCH.md), pass on 1768597. Two places the earlier searches did not look:
 *
 *   1. The markup. The real app/src/components/othello/WalletConnect.tsx is rendered with react-dom/server (React
 *      19.1.1, the app's own) over stubbed contexts: the busy note and disabled Solana rows while a Solana request is
 *      open, EVM rows and the connected Solana row still usable then, and nothing from an EIP-6963 announcement
 *      reaching the markup unescaped (a hostile name and icon go through the real parseAnnouncement first).
 *   2. EIP-6963 re-announcements against the real createEvmSession: the same uuid announcing a new provider object
 *      while a connect is pending and after it connected, and a second uuid announcing the remembered rdns after the
 *      session restored the first.
 *
 *   npx mocha --import=tsx tests/a2-modal-render-adversary.spec.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { REPO } from "./artifacts.ts";
import { ANNOUNCE, discoverEvmWallets, parseAnnouncement, type Discovery, type EvmWallet } from "../app/src/lib/robinhood/eip6963.ts";
import { createEvmSession } from "../app/src/lib/robinhood/evm-session.ts";

const SRC = resolve(REPO, "app/src");
const WALLET_CONNECT = resolve(SRC, "components/othello/WalletConnect.tsx");
const appRequire = createRequire(resolve(SRC, "lib/chains.ts"));

type Ctx = { ui: Record<string, unknown>; evm: Record<string, unknown>; path: string };
const g = globalThis as { __a2r?: Ctx; React?: unknown };

registerHooks({
  resolve(specifier, context, next) {
    const fromWc = context.parentURL?.endsWith("/components/othello/WalletConnect.tsx") ?? false;
    const stub = (src: string) => ({ url: `data:text/javascript,${encodeURIComponent(src)}`, shortCircuit: true });
    if (fromWc && specifier === "./WalletConnect.module.css") return stub("export default new Proxy({}, { get: (_, k) => String(k) });");
    if (fromWc && specifier === "./Shell") return stub("export const useTheme = () => ({ vars: {} });");
    if (fromWc && specifier === "next/navigation") return stub("export const usePathname = () => globalThis.__a2r.path;");
    if (fromWc && specifier === "@/lib/wallet") {
      return stub("export const useWalletUi = () => globalThis.__a2r.ui; export const shortAddress = (a) => `${a.slice(0, 4)}…${a.slice(-4)}`;");
    }
    if (fromWc && specifier === "@/lib/robinhood/wallet") return stub("export const useEvmWallet = () => globalThis.__a2r.evm;");
    if (specifier.startsWith("@/")) {
      const base = resolve(SRC, specifier.slice(2));
      for (const ext of [".ts", ".tsx", "/index.ts", ""]) {
        try {
          readFileSync(base + ext);
          return next(pathToFileURL(base + ext).href, context);
        } catch {
          /* try the next extension */
        }
      }
    }
    return next(specifier, context);
  },
});

const noop = () => {};
function baseUi(over: Record<string, unknown>): Record<string, unknown> {
  return {
    address: null, walletName: null, stage: "list", detected: [], evmDetected: [], pending: null, pendingKind: null, solanaBusy: false,
    openConnect: noop, close: noop, pick: noop, pickEvm: noop, cancel: noop, retry: noop, another: noop, recheck: noop, disconnect: noop,
    ...over,
  };
}
const baseEvm = (over: Record<string, unknown> = {}) => ({ address: null, onRobinhood: false, walletName: null, error: null, switchToRobinhood: async () => false, disconnect: noop, ...over });

async function render(ctx: Ctx, which: "modal" | "control"): Promise<string> {
  const React = appRequire("react");
  g.React = React;
  const { renderToStaticMarkup } = appRequire("react-dom/server");
  const mod = await import(pathToFileURL(WALLET_CONNECT).href);
  g.__a2r = ctx;
  return renderToStaticMarkup(React.createElement(which === "modal" ? mod.WalletModal : mod.WalletControl, {}));
}

/** The <button> elements of the list, as their opening tag and their text. */
function buttons(html: string): { tag: string; text: string }[] {
  return [...html.matchAll(/(<button[^>]*>)([\s\S]*?)<\/button>/g)].map((m) => ({ tag: m[1]!, text: m[2]!.replace(/<[^>]+>/g, "") }));
}

const PHANTOM = { name: "Phantom", icon: "data:image/png;base64,AA==" };
const SOLFLARE = { name: "Solflare", icon: "data:image/png;base64,AA==" };

describe("A2 adversary (1768597): the rendered connect modal", () => {
  it("while a Solana request is open: the note is shown, every Solana row is disabled, EVM rows are not", async () => {
    const html = await render({
      path: "/",
      ui: baseUi({ walletName: "Phantom", solanaBusy: true, detected: [PHANTOM, SOLFLARE], evmDetected: [{ uuid: "u1", name: "Rabby", icon: null }] }),
      evm: baseEvm(),
    }, "modal");
    assert.match(html, /Phantom is still asking in its own window\. Answer or close it there, then pick a Solana wallet again\./);
    const rows = buttons(html).filter((b) => /Detected in this browser|EVM wallet, detected/.test(b.text));
    assert.equal(rows.length, 3);
    for (const r of rows) {
      const evm = r.text.includes("EVM wallet");
      assert.equal(/\sdisabled=""/.test(r.tag), !evm, `row "${r.text}" disabled=${!evm ? "missing" : "present"}`);
    }
    // The Close control stays usable (a way out of the modal).
    assert.ok(buttons(html).some((b) => /aria-label="Close"/.test(b.tag) && !/disabled/.test(b.tag)));
  });

  it("with a Solana wallet connected: only its row, enabled, with the spec's copy; no busy note", async () => {
    const html = await render({
      path: "/robinhood",
      ui: baseUi({ address: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU", walletName: "Phantom", detected: [PHANTOM, SOLFLARE] }),
      evm: baseEvm(),
    }, "modal");
    const rows = buttons(html).filter((b) => b.text.includes("Phantom") || b.text.includes("Solflare"));
    assert.equal(rows.length, 1);
    assert.match(rows[0]!.text, /Connected\. Go to the Solana side/);
    assert.ok(!/disabled/.test(rows[0]!.tag));
    assert.ok(!/still asking/.test(html));
    assert.match(html, /disconnect Phantom from its menu on the Solana side first/);
  });

  it("no Solana wallet and no EVM wallet listed: install rows for both groups; the EVM group's is MetaMask", async () => {
    const html = await render({ path: "/", ui: baseUi({ detected: [], evmDetected: [] }), evm: baseEvm() }, "modal");
    assert.match(html, /No Solana wallet in this browser\. Get Phantom/);
    assert.match(html, /No EVM wallet in this browser\. Get MetaMask/);
    assert.match(html, /href="https:\/\/metamask\.io"[^>]*target="_blank"[^>]*rel="noopener noreferrer"/);
  });

  it("a hostile announcement reaches the markup only escaped, and only a checked data:image icon becomes an <img>", async () => {
    const hostile = [
      { uuid: "u-x", name: "<img src=x onerror=alert(1)>‮Mask", rdns: "io.evil", icon: "data:image/svg+xml,<svg onload=alert(1)>\"><script>alert(2)</script>" },
      { uuid: "u-y", name: "Plain", rdns: "io.plain", icon: "javascript:alert(3)" },
      { uuid: "u-z", name: "Quote\" onmouseover=\"x", rdns: "io.quote", icon: "data:text/html,<script>alert(4)</script>" },
    ].map((info) => parseAnnouncement({ info, provider: { request: async () => null } }));
    assert.ok(hostile.every((w) => w !== null), "all three have the standard's shape");
    const evmDetected = hostile.map((w) => ({ uuid: w!.info.uuid, name: w!.info.name, icon: w!.info.icon }));
    const html = await render({ path: "/", ui: baseUi({ evmDetected }), evm: baseEvm() }, "modal");
    assert.ok(!/<script/i.test(html), "a <script> reached the markup");
    assert.ok(!/<img src=x/i.test(html), "the name's markup reached the markup");
    // Attribute names of every tag, with quoted values blanked first (React quotes and escapes every value).
    const attrs = [...html.matchAll(/<[a-z]+[^>]*>/g)].flatMap((m) => [...m[0].replace(/"[^"]*"/g, '""').matchAll(/\s([a-zA-Z-]+)=/g)].map((x) => x[1]!));
    assert.ok(!attrs.some((n) => /^on/i.test(n)), `an event handler attribute reached the markup: ${attrs.filter((n) => /^on/i.test(n))}`);
    assert.ok(!html.includes("‮"), "a bidi override reached the markup");
    const imgs = [...html.matchAll(/<img[^>]*src="([^"]*)"/g)].map((m) => m[1]!);
    assert.equal(imgs.length, 1, "only the data:image/svg+xml icon is rendered");
    assert.ok(imgs[0]!.startsWith("data:image/svg+xml,"));
  });

  it("top bar on the Robinhood side: Connect, Switch network, then the pill, following the EVM wallet only", async () => {
    const ui = baseUi({ address: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU", walletName: "Phantom" });
    const a = "0x1111111111111111111111111111111111111111";
    assert.match(await render({ path: "/robinhood", ui, evm: baseEvm() }, "control"), />Connect wallet</);
    assert.match(await render({ path: "/robinhood", ui, evm: baseEvm({ address: a }) }, "control"), />Switch network</);
    const pill = await render({ path: "/robinhood", ui, evm: baseEvm({ address: a, onRobinhood: true, walletName: "Rabby" }) }, "control");
    assert.match(pill, /0x1111…1111/);
    assert.ok(!pill.includes("7xKX"), "the Solana address leaked into the Robinhood top bar");
    // And the Solana side shows the Solana wallet, not the EVM one.
    const sol = await render({ path: "/", ui, evm: baseEvm({ address: a, onRobinhood: true }) }, "control");
    assert.match(sol, /7xKX…gAsU/);
    assert.ok(!sol.includes("0x1111"));
  });
});

/* --------------------------------------------------------- EIP-6963 re-announcements --------------------------------------------------------- */

type Req = { method: string; params?: unknown };
class Prov {
  calls: string[] = [];
  waiting: ((a: string[]) => void)[] = [];
  handlers = new Map<string, Set<(x: unknown) => void>>();
  constructor(public account: string | null, public chain = "0xb626") {}
  request = async ({ method }: Req): Promise<unknown> => {
    this.calls.push(method);
    if (method === "eth_requestAccounts") return new Promise<string[]>((ok) => this.waiting.push(ok));
    if (method === "eth_accounts") return this.account ? [this.account] : [];
    if (method === "eth_chainId") return this.chain;
    return null;
  };
  approve(a: string) { this.account = a; for (const ok of this.waiting.splice(0)) ok([a]); }
  on(ev: string, f: (x: unknown) => void) { (this.handlers.get(ev) ?? this.handlers.set(ev, new Set()).get(ev)!).add(f); }
  removeListener(ev: string, f: (x: unknown) => void) { this.handlers.get(ev)?.delete(f); }
  emit(ev: string, x: unknown) { for (const f of this.handlers.get(ev) ?? []) f(x); }
}

function fakeDiscovery() {
  const found = new Map<string, EvmWallet>();
  const ls = new Set<() => void>();
  let snap: EvmWallet[] = [];
  const d: Discovery = { list: () => snap, subscribe: (l) => { ls.add(l); return () => { ls.delete(l); }; }, stop: noop };
  const announce = (uuid: string, name: string, rdns: string, p: Prov) => {
    found.set(uuid, { info: { uuid, name, rdns, icon: null }, provider: p as never });
    snap = [...found.values()];
    for (const l of ls) l();
  };
  return { d, announce };
}
const settle = async () => { for (let k = 0; k < 6; k++) await new Promise((r) => setImmediate(r)); };
const A1 = "0x1111111111111111111111111111111111111111";
const A2 = "0x2222222222222222222222222222222222222222";

describe("A2 adversary (1768597): EIP-6963 re-announcements against the session", () => {
  it("a re-announcement under the chosen uuid during a pending connect: only the picked wallet is asked, and the answer lands", async () => {
    const { d, announce } = fakeDiscovery();
    const p1 = new Prov(null);
    const p2 = new Prov(null);
    announce("u-a", "Rabby", "io.rabby", p1);
    const remembered = { v: null as string | null, get: () => remembered.v, set: (x: string) => { remembered.v = x; }, clear: () => { remembered.v = null; } };
    const s = createEvmSession({ discovery: d, remembered });
    const done = s.connectWith("u-a");
    await settle();
    announce("u-a", "Rabby", "io.rabby", p2);
    await settle();
    assert.equal(p2.calls.filter((c) => c === "eth_requestAccounts").length, 0, "the re-announced provider was asked without a click");
    p1.approve(A1);
    await done;
    await settle();
    assert.equal(s.getSnapshot().address?.toLowerCase(), A1.toLowerCase());
    assert.equal(remembered.v, "io.rabby");
  });

  it("a second uuid announcing the remembered rdns after the restore neither replaces the restored wallet nor asks anything", async () => {
    const { d, announce } = fakeDiscovery();
    const real = new Prov(A1);
    const other = new Prov(A2);
    announce("u-real", "MetaMask", "io.metamask", real);
    const remembered = { v: "io.metamask" as string | null, get: () => remembered.v, set: (x: string) => { remembered.v = x; }, clear: () => { remembered.v = null; } };
    const s = createEvmSession({ discovery: d, remembered });
    await settle();
    announce("u-other", "MetaMask", "io.metamask", other);
    await settle();
    assert.equal(s.getSnapshot().chosen?.info.uuid, "u-real");
    assert.equal(s.getSnapshot().address?.toLowerCase(), A1.toLowerCase());
    assert.deepEqual(other.calls, [], "the second announcer was asked something on load");
    assert.equal(s.getSnapshot().wallets.length, 2, "both are listed (the person sees both)");
  });

  it("after Disconnect, a re-announcement of the remembered wallet does not restore it", async () => {
    const { d, announce } = fakeDiscovery();
    const p = new Prov(A1);
    announce("u-a", "Rabby", "io.rabby", p);
    const remembered = { v: "io.rabby" as string | null, get: () => remembered.v, set: (x: string) => { remembered.v = x; }, clear: () => { remembered.v = null; } };
    const s = createEvmSession({ discovery: d, remembered });
    await settle();
    assert.ok(s.getSnapshot().address);
    s.disconnect();
    announce("u-a", "Rabby", "io.rabby", new Prov(A1));
    await settle();
    assert.equal(s.getSnapshot().chosen, null);
    assert.equal(s.getSnapshot().address, null);
  });
});

describe("A2 adversary (1768597): two different uuids are two wallets", () => {
  it("an announcement whose uuid differs from a listed wallet's only by an invisible character is shown beside it, not in its place", () => {
    // EIP-6963: info.uuid is a UUIDv4. A2-SWITCH: "accepted only in the standard's shape ... same uuid replaces, a
    // different uuid with the same name is shown separately (the person sees both)".
    const host = new EventTarget();
    const real = { request: async () => null, tag: "real" };
    const other = { request: async () => null, tag: "other" };
    const uuid = "350670db-19fa-4704-a166-e52e178b59d2";
    const d = discoverEvmWallets(host);
    host.dispatchEvent(new CustomEvent(ANNOUNCE, { detail: { info: { uuid, name: "MetaMask", icon: "data:image/png;base64,AA==", rdns: "io.metamask" }, provider: real } }));
    host.dispatchEvent(new CustomEvent(ANNOUNCE, { detail: { info: { uuid: `${uuid}​`, name: "MetaMask", icon: "data:image/png;base64,AA==", rdns: "io.metamask" }, provider: other } }));
    const listed = d.list().map((w) => (w.provider as unknown as { tag: string }).tag);
    d.stop();
    // Either both are listed (a different uuid is a different wallet) or the malformed uuid is refused; never a merge.
    assert.ok(
      listed.includes("real"),
      `the listed wallets are [${listed.join(", ")}]: the second announcement, under a different uuid, replaced the first`,
    );
  });
});
