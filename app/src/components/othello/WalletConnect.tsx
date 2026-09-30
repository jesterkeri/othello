'use client';

// Wallet connection: the header control (connect button, or address pill and
// menu) and the connect modal. Ported from the design session's "Wallet
// Screen", rows 1a to 1f. Row 1g, wrong network, is deliberately absent; see
// the note on WalletModal.
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { usePathname } from 'next/navigation';
import s from './WalletConnect.module.css';
import { useTheme } from './Shell';
import { sideOf, type ChainSide } from '@/lib/chains';
import { explorerAddress } from '@/lib/robinhood/chain';
import { useEvmWallet } from '@/lib/robinhood/wallet';
import { shortAddress, useWalletUi } from '@/lib/wallet';

/** The design's three named wallets, each on its own accent. */
const KNOWN: Record<string, { slot: string; href: string }> = {
  Phantom: { slot: 'sky', href: 'https://phantom.com' },
  Solflare: { slot: 'clay', href: 'https://solflare.com' },
  Backpack: { slot: 'acid', href: 'https://backpack.app' },
  MetaMask: { slot: 'teal', href: 'https://metamask.io' },
};
const INSTALLS = ['Phantom', 'Solflare', 'Backpack'] as const;
/** For Robinhood Chain: an EVM wallet. MetaMask is named because it is the one the demo was rehearsed with. */
const EVM_INSTALLS = ['MetaMask'] as const;
/** A detected wallet the design did not name still gets an accent, in turn. */
const FALLBACK = ['teal', 'cobalt', 'sky', 'clay', 'acid'];
const TILTS = ['-1.2deg', '1deg', '-.6deg'];

function slotFor(name: string, i: number): string {
  return KNOWN[name]?.slot ?? FALLBACK[i % FALLBACK.length]!;
}
const fill = (slot: string): CSSProperties => ({ background: `var(--${slot})`, color: `var(--${slot}Ink)` });

const WALLET_ICON = 'M4 7.5A2.5 2.5 0 0 1 6.5 5H18v3M4 7.5V17a2 2 0 0 0 2 2h13a1 1 0 0 0 1-1v-9a1 1 0 0 0-1-1H6.5A2.5 2.5 0 0 1 4 7.5ZM16 13.5h.5';
const COPY = 'M9 9h10v10H9zM5 15V5h10', CHECK = 'M5 12.5 10 17.5 19 7';
const OUT = 'M14 4h6v6M20 4l-9 9M18 14v5H5V6h5';

function Icon({ d, size = 19, width = 2.3 }: { d: string; size?: number; width?: number }) {
  return <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d={d} /></svg>;
}

/**
 * The header control. Shell renders it in its top bar; it reads the wallets
 * from context, so no page has to pass an address down. Which wallet it shows
 * follows the page's chain (lib/chains.ts): the Solana wallet on Solana pages,
 * the EVM wallet on Robinhood Chain pages. Either way, "Connect wallet" opens
 * the one modal, where the wallet picked decides the chain.
 */
export function WalletControl({ side }: { side?: ChainSide } = {}) {
  const pathname = usePathname();
  return (side ?? sideOf(pathname)) === 'robinhood' ? <EvmControl /> : <SolanaControl />;
}

function ConnectButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className={s.connect} onClick={onClick}>
      <span className={s.connectIcon}><Icon d={WALLET_ICON} size={15} width={2.6} /></span>Connect wallet
    </button>
  );
}

function SolanaControl() {
  const w = useWalletUi();
  if (!w.address) return <ConnectButton onClick={w.openConnect} />;
  const name = w.walletName ?? 'your wallet';
  return (
    <AddressPill name={name} address={w.address} short={shortAddress(w.address)} chip="Devnet"
      explorerHref={`https://explorer.solana.com/address/${w.address}?cluster=devnet`} onDisconnect={w.disconnect} />
  );
}

function EvmControl() {
  const ui = useWalletUi();
  const evm = useEvmWallet();
  if (!evm.address) return <ConnectButton onClick={ui.openConnect} />;
  if (!evm.onRobinhood) {
    return (
      <button type="button" className={s.connect} onClick={() => void evm.switchToRobinhood()} title={evm.error ?? undefined}>
        <span className={s.connectIcon}><Icon d={WALLET_ICON} size={15} width={2.6} /></span>Switch network
      </button>
    );
  }
  const name = evm.walletName ?? 'your wallet';
  return (
    <AddressPill name={name} address={evm.address} short={`${evm.address.slice(0, 6)}…${evm.address.slice(-4)}`} chip="Robinhood testnet"
      explorerHref={explorerAddress(evm.address)} onDisconnect={evm.disconnect} />
  );
}

/** The connected wallet: address pill and its menu (copy, explorer, disconnect). */
function AddressPill({ name, address, short, chip, explorerHref, onDisconnect }: {
  name: string; address: string; short: string; chip: string; explorerHref: string; onDisconnect: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open]);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(t);
  }, [copied]);

  const copy = async () => {
    try { await navigator.clipboard.writeText(address); setCopied(true); } catch { /* clipboard blocked: the label stays "Copy address" */ }
  };

  return (
    <span className={s.wrap} ref={ref}>
      <button type="button" className={s.pill} onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open} aria-label={`Wallet ${short}`}>
        <span className={s.letter}>{name[0]}</span>
        <span className={s.short}>{short}</span>
        <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" className={`${s.chevron} ${open ? s.chevronOpen : ''}`} aria-hidden><path d="M6 9l6 6 6-6" /></svg>
      </button>
      {open && (
        <div role="menu" aria-label="Wallet" className={s.menu}>
          <div className={s.menuHead}>
            <span className={s.menuLetter}>{name[0]}</span>
            <span className={s.menuWho}>
              <span className={s.menuWith}>Connected with {name}</span>
              <span className={s.menuAddr}>{short}</span>
            </span>
            <span className={s.devnetChip}>{chip}</span>
          </div>
          <button type="button" role="menuitem" className={s.item} onClick={copy}><Icon d={copied ? CHECK : COPY} />{copied ? 'Copied' : 'Copy address'}</button>
          <a role="menuitem" className={s.item} href={explorerHref} target="_blank" rel="noopener noreferrer"><Icon d={OUT} />View on explorer</a>
          <button type="button" role="menuitem" className={s.item} onClick={() => { setOpen(false); onDisconnect(); }}><Icon d="M12 3.5v8M7 6.5a7 7 0 1 0 10 0" />Disconnect</button>
          <p className={s.menuNote}>Othello never holds your keys. Every transaction opens in {name} for you to approve.</p>
        </div>
      )}
    </span>
  );
}

/** A link to install a wallet, with an optional line saying why it is offered. */
function InstallRow({ name, note }: { name: keyof typeof KNOWN & string; note?: string }) {
  const k = KNOWN[name]!;
  return (
    <a className={s.install} href={k.href} target="_blank" rel="noopener noreferrer">
      <span className={s.installBadge} style={fill(k.slot)}>{name[0]}</span>
      <span className={s.installName}>{note ? `${note}. Get ${name}` : `Get ${name}`}</span>
      <Icon d={OUT} size={17} width={2.8} />
    </a>
  );
}

const HEAD: Record<string, string> = { list: 'acid', empty: 'sky', connecting: 'cobalt', failed: 'clay' };

/**
 * The connect modal, mounted once for the whole app by the root layout, so the
 * same modal opens from Landing, every Shell page and the 404.
 *
 * Row 1g of the design, "Wrong network" ("Your wallet is on Mainnet"), is not
 * built. No Solana wallet tells a site which network it is set to, so that
 * sentence could never be based on anything. It also does not decide where a
 * transaction lands: the app reads and sends through its own devnet
 * connection. Showing it would be showing a guess.
 */
export function WalletModal() {
  const w = useWalletUi();
  if (w.stage === 'closed') return null;
  return <ModalBody />;
}

function ModalBody() {
  const w = useWalletUi();
  const t = useTheme();
  const closeRef = useRef<HTMLButtonElement>(null);
  const stage = w.stage;
  const wallet = w.pending ?? 'your wallet';

  useEffect(() => { closeRef.current?.focus(); }, []);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') w.close(); };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [w]);

  const titles: Record<string, [string, string]> = {
    list: ['Connect a wallet', 'Choose your wallet'],
    empty: ['Connect a wallet', 'No wallet found'],
    connecting: [`Waiting for ${wallet}`, `Approve in ${wallet}`],
    rejected: ['Not connected', 'Request cancelled'],
    failed: ['Not connected', `${wallet} did not answer`],
  };
  const [kicker, title] = titles[stage] ?? ['', ''];
  const head: CSSProperties = stage === 'rejected' ? { background: 'var(--raised)', color: 'var(--onPanel)' } : fill(HEAD[stage] ?? 'acid');
  const waiting = stage === 'connecting';
  const bad = stage === 'rejected' || stage === 'failed';
  const status = {
    connecting: { chip: 'Waiting for approval', style: fill('cobalt'), line: w.pendingKind === 'robinhood'
      ? `${wallet} is asking you to share your address with Othello, then to use Robinhood Chain testnet. Nothing is signed and nothing moves.`
      : `${wallet} is asking you to share your address with Othello. Nothing is signed and nothing moves.`, hint: `No window? Open ${wallet} from your browser toolbar.` },
    rejected: { chip: 'Cancelled', style: { background: 'var(--raised)', color: 'var(--onPanel)' }, line: 'You cancelled in your wallet. Nothing was sent.', hint: 'Try again when you are ready, or pick a different wallet.' },
    failed: { chip: 'Wallet error', style: fill('clay'), line: `${wallet} closed the request before it finished. Nothing was sent.`, hint: `Unlock ${wallet}, then try again.` },
  }[stage as 'connecting' | 'rejected' | 'failed'];

  return (
    <div className={s.overlay} style={t.vars} onMouseDown={(e) => { if (e.target === e.currentTarget) w.close(); }}>
      <div role="dialog" aria-modal="true" aria-labelledby="wc-title" className={s.dialog}>
        <div className={s.head} style={head}>
          <span aria-hidden className={s.ring1} />
          <span aria-hidden className={s.ring2} />
          <span className={s.headText}>
            <span className={s.kicker}><span className={s.kickerDot} />{kicker}</span>
            <span id="wc-title" className={s.title}>{title}</span>
          </span>
          <button ref={closeRef} type="button" className={s.close} onClick={w.close} aria-label="Close">
            <svg viewBox="0 0 24 24" width={18} height={18} fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" aria-hidden><path d="M6 6l12 12M18 6 6 18" /></svg>
          </button>
        </div>

        {stage === 'list' && (
          <>
            <div className={s.list}>
              <span className={s.label}>Solana devnet</span>
              {w.address && w.walletName && (
                <>
                  <button type="button" className={s.walletRow} style={{ ...fill(slotFor(w.walletName, 0)), transform: `rotate(${TILTS[0]})` }} onClick={() => w.pick(w.walletName!)}>
                    <span className={s.walletBadge} style={{ color: `var(--${slotFor(w.walletName, 0)})` }}>{w.walletName[0]}</span>
                    <span className={s.walletText}>
                      <span className={s.walletName}>{w.walletName}</span>
                      <span className={s.walletSub}>Connected. Go to the Solana side</span>
                    </span>
                    <span className={s.walletGo}><Icon d="M6.5 17.5 17.5 6.5M9 6.5h8.5V15" size={17} width={3} /></span>
                  </button>
                  <p className={s.groupNote}>To use another Solana wallet, disconnect {w.walletName} from its menu on the Solana side first.</p>
                </>
              )}
              {!w.address && w.solanaBusy && (
                <p className={s.groupNote}>{w.walletName ?? 'A Solana wallet'} is still asking in its own window. Answer or close it there, then pick a Solana wallet again.</p>
              )}
              {!w.address && w.detected.length === 0 && <InstallRow name="Phantom" note="No Solana wallet in this browser" />}
              {!w.address && w.detected.map((x, i) => {
                const slot = slotFor(x.name, i);
                return (
                  <button key={x.name} type="button" className={s.walletRow} disabled={w.solanaBusy} style={{ ...fill(slot), transform: `rotate(${TILTS[i % TILTS.length]})` }} onClick={() => w.pick(x.name)}>
                    <span className={s.walletBadge} style={{ color: `var(--${slot})` }}>{x.name[0]}</span>
                    <span className={s.walletText}>
                      <span className={s.walletName}>{x.name}</span>
                      <span className={s.walletSub}>Detected in this browser</span>
                    </span>
                    <span className={s.walletGo}><Icon d="M6.5 17.5 17.5 6.5M9 6.5h8.5V15" size={17} width={3} /></span>
                  </button>
                );
              })}
              <span className={s.label}>Robinhood Chain testnet</span>
              {w.evmDetected.length === 0 && <InstallRow name="MetaMask" note="No EVM wallet in this browser" />}
              {w.evmDetected.map((x, j) => {
                const i = j + w.detected.length;
                const slot = slotFor(x.name, i);
                return (
                  <button key={x.uuid} type="button" className={s.walletRow} style={{ ...fill(slot), transform: `rotate(${TILTS[i % TILTS.length]})` }} onClick={() => w.pickEvm(x.uuid)}>
                    <span className={s.walletBadge} style={{ color: `var(--${slot})` }}>
                      {x.icon ? <img className={s.walletIcon} src={x.icon} alt="" width={30} height={30} /> : x.name[0]}
                    </span>
                    <span className={s.walletText}>
                      <span className={s.walletName}>{x.name}</span>
                      <span className={s.walletSub}>EVM wallet, detected in this browser</span>
                    </span>
                    <span className={s.walletGo}><Icon d="M6.5 17.5 17.5 6.5M9 6.5h8.5V15" size={17} width={3} /></span>
                  </button>
                );
              })}
            </div>
            <div className={s.keys}>
              <svg viewBox="0 0 24 24" width={22} height={22} fill="none" stroke="var(--acid)" strokeWidth={2.3} strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 3.5 19 6v5.5c0 4.3-3 7.7-7 9-4-1.3-7-4.7-7-9V6l7-2.5ZM8.8 12l2.2 2.2 4.4-4.4" /></svg>
              <p>Othello never holds your keys. Connecting shares your address, nothing else. You approve every transaction in your own wallet.</p>
            </div>
          </>
        )}

        {stage === 'empty' && (
          <>
            <div className={s.empty}>
              <p className={s.emptyLead}>A wallet is an app you install that holds your keys and asks you before anything is sent.</p>
              <span className={s.label}>Install one for Solana devnet</span>
              <div className={s.installs}>
                {INSTALLS.map((name) => <InstallRow key={name} name={name} />)}
              </div>
              <span className={s.label}>Or one for Robinhood Chain testnet</span>
              <div className={s.installs}>
                {EVM_INSTALLS.map((name) => <InstallRow key={name} name={name} />)}
              </div>
            </div>
            <div className={s.emptyFoot}>
              <button type="button" className={`${s.btnGhost} ${s.btnCheck}`} onClick={w.recheck}>I installed one, check again</button>
              <p>You can read circles without a wallet. Creating or joining one needs a wallet, because you sign each step yourself.</p>
            </div>
          </>
        )}

        {status && (
          <>
            <div className={s.status}>
              <span className={s.orb}>
                <span className={`${s.orbRing} ${waiting ? s.orbRingWaiting : ''}`} />
                <span className={s.orbLetter}>{wallet[0]}</span>
                {bad && <span className={s.orbBad}><svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth={3.2} strokeLinecap="round" aria-hidden><path d="M7 7l10 10M17 7 7 17" /></svg></span>}
              </span>
              <span className={s.chip} style={status.style}><span className={`${s.chipDot} ${waiting ? s.chipDotWaiting : ''}`} />{status.chip}</span>
              <p className={s.statusLine}>{status.line}</p>
              <p className={s.statusHint}>{status.hint}</p>
            </div>
            <div className={s.actions}>
              {waiting && <button type="button" className={s.btnGhost} style={{ padding: '0 26px' }} onClick={w.cancel}>Cancel</button>}
              {bad && (
                <>
                  <button type="button" className={s.btnPrimary} onClick={w.retry}>Try again</button>
                  <button type="button" className={s.btnGhost} onClick={w.another}>Choose another wallet</button>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
