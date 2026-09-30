/**
 * EIP-6963 discovery (A2-SWITCH): each announced EVM wallet is listed by name, announcements are untrusted input, and
 * the legacy `window.ethereum` appears only when no wallet announced itself.
 *
 *   npx mocha --import=tsx tests/evm-discovery.spec.ts
 */
import assert from "node:assert/strict";

import { ANNOUNCE, LEGACY_UUID, REQUEST, discoverEvmWallets, parseAnnouncement } from "../app/src/lib/robinhood/eip6963.ts";

const provider = (tag: string) => ({ tag, request: async () => null, on() {}, removeListener() {} });
const info = (uuid: string, name: string, rdns = "io.metamask", icon: string | undefined = "data:image/svg+xml;base64,PHN2Zy8+") => ({ uuid, name, rdns, icon });
const announce = (host: EventTarget, detail: unknown) => host.dispatchEvent(new CustomEvent(ANNOUNCE, { detail }));

describe("EIP-6963 announcements are checked", () => {
  it("accepts the standard's shape", () => {
    const w = parseAnnouncement({ info: info("u1", "MetaMask"), provider: provider("mm") });
    assert.equal(w?.info.name, "MetaMask");
    assert.equal(w?.info.rdns, "io.metamask");
    assert.match(w?.info.icon ?? "", /^data:image\/svg\+xml/);
  });

  it("refuses anything else", () => {
    const good = { info: info("u1", "MetaMask"), provider: provider("mm") };
    const bad: unknown[] = [
      null, 1, "x", {}, { info: null, provider: provider("p") },
      { ...good, provider: {} }, { ...good, provider: { request: "no" } },
      { ...good, info: { ...good.info, uuid: "" } }, { ...good, info: { ...good.info, name: "   " } },
      { ...good, info: { ...good.info, name: "x".repeat(65) } }, { ...good, info: { ...good.info, rdns: "not dns" } },
      { ...good, info: { ...good.info, rdns: "metamask" } }, { ...good, info: { ...good.info, uuid: LEGACY_UUID } },
    ];
    for (const d of bad) assert.equal(parseAnnouncement(d), null, JSON.stringify(d));
  });

  it("keeps a name readable: control and bidi characters are removed", () => {
    const w = parseAnnouncement({ info: info("u1", "Meta\u202eksaM\u0007\u061c\ufeff\u200b\u2066"), provider: provider("p") });
    assert.equal(w?.info.name, "MetaksaM");
  });

  it("an icon is kept only as a data:image URI of bounded size", () => {
    for (const icon of ["https://evil.example/x.svg", "javascript:alert(1)", "data:text/html;base64,PHNjcmlwdD4=", `data:image/png;base64,${"A".repeat(100_001)}`, undefined, 7]) {
      const w = parseAnnouncement({ info: { ...info("u1", "W"), icon }, provider: provider("p") });
      assert.equal(w?.info.icon, null, String(icon).slice(0, 40));
    }
  });
});

describe("EIP-6963 discovery", () => {
  it("asks wallets to announce, lists each one, and follows later announcements", () => {
    const host = new EventTarget();
    let asked = 0;
    host.addEventListener(REQUEST, () => { asked++; announce(host, { info: info("u-mm", "MetaMask"), provider: provider("mm") }); });
    const d = discoverEvmWallets(host);
    assert.equal(asked, 1);
    assert.deepEqual(d.list().map((w) => w.info.name), ["MetaMask"]);
    let changes = 0;
    d.subscribe(() => changes++);
    announce(host, { info: info("u-ph", "Phantom", "app.phantom"), provider: provider("ph") });
    assert.deepEqual(d.list().map((w) => w.info.name), ["MetaMask", "Phantom"]);
    assert.equal(changes, 1);
  });

  it("the same uuid replaces its entry; a different uuid with the same name or rdns is listed separately", () => {
    const host = new EventTarget();
    const d = discoverEvmWallets(host);
    announce(host, { info: info("u1", "MetaMask"), provider: provider("a") });
    announce(host, { info: info("u1", "MetaMask"), provider: provider("b") });
    assert.equal(d.list().length, 1);
    assert.equal((d.list()[0]!.provider as unknown as { tag: string }).tag, "b");
    announce(host, { info: info("u2", "MetaMask"), provider: provider("c") });
    assert.equal(d.list().length, 2, "an impostor with MetaMask's name and rdns is shown, not merged");
  });

  it("a malformed announcement changes nothing", () => {
    const host = new EventTarget();
    const d = discoverEvmWallets(host);
    let changes = 0;
    d.subscribe(() => changes++);
    announce(host, { info: { uuid: "u1" }, provider: provider("p") });
    assert.equal(d.list().length, 0);
    assert.equal(changes, 0);
  });

  it("the legacy window.ethereum appears only while no wallet has announced", () => {
    const host = new EventTarget();
    const legacy = provider("legacy");
    const d = discoverEvmWallets(host, () => legacy as never);
    assert.deepEqual(d.list().map((w) => w.info.uuid), [LEGACY_UUID]);
    announce(host, { info: info("u1", "Rabby", "io.rabby"), provider: provider("rabby") });
    assert.deepEqual(d.list().map((w) => w.info.name), ["Rabby"]);
    assert.equal(discoverEvmWallets(new EventTarget(), () => undefined).list().length, 0);
  });

  it("stop removes the listener", () => {
    const host = new EventTarget();
    const d = discoverEvmWallets(host);
    d.stop();
    announce(host, { info: info("u1", "MetaMask"), provider: provider("mm") });
    assert.equal(d.list().length, 0);
  });
});
