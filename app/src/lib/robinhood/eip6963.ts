/**
 * EIP-6963 wallet discovery: every installed EVM wallet announces itself on `eip6963:announceProvider` when the page
 * dispatches `eip6963:requestProvider`, so MetaMask, Rabby, Phantom's EVM side and others each appear by name and the
 * one the person picks is the one that signs. Reading only `window.ethereum` let whichever wallet claimed it last stand
 * in for the one the person meant (A2-SWITCH).
 *
 * An announcement is untrusted input from any extension. It is accepted only in the shape the standard defines; the
 * icon only as a `data:image/...` URI (rendered in an <img>, where it cannot run script); anything else is dropped.
 */
import type { EIP1193Provider } from "viem";

export type EvmWalletInfo = { uuid: string; name: string; icon: string | null; rdns: string };
export type EvmWallet = { info: EvmWalletInfo; provider: EIP1193Provider };

type EventHost = {
  addEventListener(type: string, listener: (e: Event) => void): void;
  removeEventListener(type: string, listener: (e: Event) => void): void;
  dispatchEvent(e: Event): boolean;
};

export const ANNOUNCE = "eip6963:announceProvider";
export const REQUEST = "eip6963:requestProvider";

/** A wallet that predates EIP-6963 and only sets `window.ethereum`; listed only when no wallet announced itself. */
export const LEGACY_UUID = "legacy-window-ethereum";

const ICON = /^data:image\/(png|jpeg|gif|webp|svg\+xml)[;,]/i;
/** The uuid is the list's key, so it is taken exactly as announced and never cleaned: plain characters only. */
const UUID = /^[0-9A-Za-z-]{1,128}$/;
const RDNS = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i;
const MAX_ICON = 100_000;

function text(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  // control characters and bidi overrides out: a name is shown to the person choosing a wallet
  const t = v.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g, "").trim();
  return t.length > 0 && t.length <= max ? t : null;
}

/** The announcement's detail, if it has the standard's shape; null otherwise. */
export function parseAnnouncement(detail: unknown): EvmWallet | null {
  if (typeof detail !== "object" || detail === null) return null;
  const { info, provider } = detail as { info?: unknown; provider?: unknown };
  if (typeof info !== "object" || info === null) return null;
  if (typeof provider !== "object" || provider === null) return null;
  if (typeof (provider as { request?: unknown }).request !== "function") return null;
  const i = info as Record<string, unknown>;
  const uuid = typeof i.uuid === "string" && UUID.test(i.uuid) ? i.uuid : null;
  const name = text(i.name, 64);
  const rdns = typeof i.rdns === "string" && i.rdns.length <= 253 && RDNS.test(i.rdns) ? i.rdns : null;
  if (!uuid || !name || !rdns || uuid === LEGACY_UUID) return null;
  const icon = typeof i.icon === "string" && i.icon.length <= MAX_ICON && ICON.test(i.icon) ? i.icon : null;
  return { info: { uuid, name, icon, rdns }, provider: provider as EIP1193Provider };
}

export type Discovery = {
  /** The wallets found so far, in the order they announced; the legacy injected wallet only if none announced. */
  list(): EvmWallet[];
  subscribe(listener: () => void): () => void;
  stop(): void;
};

/**
 * Listens for announcements on `host` (the window) and asks every wallet to announce. A wallet announcing again under
 * the same uuid replaces its entry; a different uuid is a different wallet, even with the same name or rdns (the
 * person sees both and chooses).
 */
export function discoverEvmWallets(host: EventHost, legacy: () => EIP1193Provider | undefined = () => undefined): Discovery {
  const found = new Map<string, EvmWallet>();
  const listeners = new Set<() => void>();
  let snapshot: EvmWallet[] = [];
  const rebuild = () => {
    if (found.size) snapshot = [...found.values()];
    else {
      const p = legacy();
      snapshot = p && typeof p.request === "function"
        ? [{ info: { uuid: LEGACY_UUID, name: "Browser wallet", icon: null, rdns: "injected.window-ethereum" }, provider: p }]
        : [];
    }
    for (const l of listeners) l();
  };
  const onAnnounce = (e: Event) => {
    const w = parseAnnouncement((e as CustomEvent).detail);
    if (!w) return;
    found.set(w.info.uuid, w);
    rebuild();
  };
  host.addEventListener(ANNOUNCE, onAnnounce);
  rebuild();
  host.dispatchEvent(new Event(REQUEST));
  return {
    list: () => snapshot,
    subscribe: (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
    stop: () => { host.removeEventListener(ANNOUNCE, onAnnounce); listeners.clear(); },
  };
}
