"use client";

/**
 * Robinhood Chain's read-only portfolio, drawn like the Solana portfolio (Joshua, 2026-10-06: he prefers its style):
 * the big tile, the "Your circle" card, the asset rows, the dashed test-token strip, the header and footer all come
 * from components/portfolio/parts.tsx and Portfolio.module.css, which the Solana page uses too.
 *
 * Testnet balances stay separate from the Solana portfolio: USDG, testnet ETH and the five faucet Stock Tokens have no
 * price or real-world value here, so the page never shows a dollar total. Every figure is a read from Robinhood Chain
 * testnet, or the section says it could not be read (in a fixed sentence: viem's own error carries the RPC URL).
 */
import Link from "next/link";
import { useEffect, useState } from "react";
import { erc20Abi, formatUnits } from "viem";

import Shell from "@/components/othello/Shell";
import { TokenChip, TokenChips } from "@/components/assets/TokenChip";
import { ARROW_RIGHT, Arrow, AssetRow, CircleSummary, PortfolioFooter, PortfolioHeader, RingsDecor, TestTokenStrip, TotalDecor } from "@/components/portfolio/parts";
import portfolio from "@/components/portfolio/Portfolio.module.css";
import { checkFactory, listMyCircles, MY_CIRCLES_PAGE, readCircleInTurn, type CircleSummary as Summary, type RhCircleView } from "@/lib/robinhood/adapter";
import { USDG } from "@/lib/robinhood/chain";
import { fmtUsdg } from "@/lib/robinhood/copy";
import { circleCard, pickCircle } from "@/lib/robinhood/portfolio-circle";
import { TESTNET_FAUCET, TESTNET_STOCK_DECIMALS, TESTNET_STOCK_TOKENS } from "@/lib/robinhood/testnet-stocks";
import { robinhoodPublicClient, useEvmWallet } from "@/lib/robinhood/wallet";
import { exactTokens } from "@/lib/format";
import { useWalletUi } from "@/lib/wallet";

const NETWORK = { chip: "Robinhood Chain testnet", note: "Test tokens only. They have no value." };
const SLOTS = ["acid", "sky", "cobalt", "clay", "teal"] as const;

type TokenRead = bigint | "failed" | null;
/** The circle card's read: the factory not open, a failed read, or the chosen circle (null: none running). */
type CircleRead = { kind: "reading" } | { kind: "closed" } | { kind: "failed" } | { kind: "ready"; view: RhCircleView | null; count: number; more: boolean };

function fmtStock(amount: bigint): string {
  const [whole, fraction = ""] = formatUnits(amount, TESTNET_STOCK_DECIMALS).split(".");
  const shown = fraction.slice(0, 4).replace(/0+$/, "");
  // a balance below the fourth decimal is still held: never print it as 0 (adversary on a1496e6)
  if (amount > 0n && whole === "0" && !shown) return "<0.0001";
  return shown ? `${whole}.${shown}` : whole!;
}
/** Exact digits, trailing zeros dropped (nothing rounded). */
const trimZeros = (x: string) => (x.includes(".") ? x.replace(/0+$/, "").replace(/\.$/, "") : x);
/** fmtUsdg without its unit, for places that print the unit on their own. */
const usdgNumber = (v: bigint) => fmtUsdg(v).replace(/ USDG$/, "");
const shown = (r: TokenRead, f: (v: bigint) => string) => (r === null ? "Reading…" : r === "failed" ? "Unavailable" : f(r));

/**
 * The wallet's newest circles, at most MAX_PAGES pages of listMyCircles (newest first), then a read of each running one.
 * The reads are bounded by the page cap, never by how many circles the wallet has ever had (adversary on d82d67e: a
 * wallet with 240 circles cost 2000 reads before the card drew). A running circle is usually among the newest (a
 * member is meant to be in at most three at a time, Joshua 2026-10-06), but nothing on chain enforces that yet, so
 * when older circles were not read the empty card says so instead of "no running circle". `count` is every circle in
 * the factory's index for this wallet (its own creates and joins), from the first page; `more` says older ones exist
 * that were not read. A page whose factory check fails throws (lib/robinhood/adapter-core.ts listCirclesPageWith), so
 * the card says the read failed instead of counting no circles (adversary on c2b6549).
 */
const MAX_PAGES = 3;
const READ_LIMIT = MAX_PAGES * MY_CIRCLES_PAGE;
async function readRunningCircles(account: `0x${string}`, stale: () => boolean): Promise<{ views: RhCircleView[]; count: number; more: boolean }> {
  const all: Summary[] = [];
  let before: number | undefined;
  let count = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const next = await listMyCircles(robinhoodPublicClient, account, before);
    if (page === 0) count = next.total;
    all.push(...next.circles);
    before = next.before ?? undefined;
    if (before === undefined) break;
  }
  // reads still waiting are skipped once the card has moved on (a wallet switch, Try again) or one has failed, so
  // they do not hold up the next wallet's reads (adversary on afa5aaa)
  let gaveUp = false;
  const skip = () => gaveUp || stale();
  // each read marks the give-up itself, so it is set before the next waiting read's turn comes (adversary on eea3f01)
  const views = await Promise.all(all.filter((c) => c.status === "Active").map((c) =>
    readCircleInTurn(robinhoodPublicClient, c.address, skip).catch((e: unknown) => { gaveUp = true; throw e; })));
  return { views, count, more: before !== undefined };
}

export default function RobinhoodPortfolio() {
  const wallet = useEvmWallet();
  const walletUi = useWalletUi();
  const [usdgRead, setUsdg] = useState<TokenRead>(null);
  const [ethRead, setEth] = useState<TokenRead>(null);
  const [stocksState, setStocks] = useState<Record<string, TokenRead>>({});
  const [circlesRead, setCircles] = useState<CircleRead>({ kind: "reading" });
  // the wallet the reads above were started for: after a switch, nothing read for the last wallet is drawn, not even
  // for the one render before the reset below runs (adversary on 08285a1)
  const [readFor, setReadFor] = useState<string | null>(null);

  useEffect(() => {
    setUsdg(null);
    setEth(null);
    setStocks({});
    setReadFor(wallet.address ?? null);
    if (!wallet.address) return;
    const account = wallet.address as `0x${string}`;
    let live = true;
    void robinhoodPublicClient
      .readContract({ address: USDG, abi: erc20Abi, functionName: "balanceOf", args: [account] })
      .then((amount) => { if (live) setUsdg(amount); })
      .catch(() => { if (live) setUsdg("failed"); });
    void robinhoodPublicClient
      .getBalance({ address: account })
      .then((amount) => { if (live) setEth(amount); })
      .catch(() => { if (live) setEth("failed"); });
    for (const token of TESTNET_STOCK_TOKENS) {
      void robinhoodPublicClient
        .readContract({ address: token.address, abi: erc20Abi, functionName: "balanceOf", args: [account] })
        .then((amount) => { if (live) setStocks((current) => ({ ...current, [token.symbol]: amount })); })
        .catch(() => { if (live) setStocks((current) => ({ ...current, [token.symbol]: "failed" })); });
    }
    return () => { live = false; };
  }, [wallet.address]);

  // The circle card's read has its own effect, so "Try again" re-runs only it (adversary on 432dfb5: a failed read
  // left the card on "Live data unavailable" with no way back but a page reload).
  const [circlesTry, setCirclesTry] = useState(0);
  useEffect(() => {
    setCircles({ kind: "reading" });
    if (!wallet.address) return;
    const account = wallet.address as `0x${string}`;
    let live = true;
    void checkFactory(robinhoodPublicClient)
      .then(async (factory) => {
        // "closed" only when no factory is configured; a configured factory whose code read fails or does not match
        // is a failed read, never "not open yet" (adversary on 12fdfe9)
        if (!factory.ok) { if (live) setCircles(factory.reason === "not-deployed" ? { kind: "closed" } : { kind: "failed" }); return; }
        const { views, count, more } = await readRunningCircles(account, () => !live);
        if (live) setCircles({ kind: "ready", view: pickCircle(views, account), count, more });
      })
      .catch(() => { if (live) setCircles({ kind: "failed" }); });
    return () => { live = false; };
  }, [wallet.address, circlesTry]);

  const fresh = readFor === (wallet.address ?? null);
  const usdg = fresh ? usdgRead : null;
  const eth = fresh ? ethRead : null;
  const stocks = fresh ? stocksState : {};
  const circles: CircleRead = fresh ? circlesRead : { kind: "reading" };

  const stockReads = TESTNET_STOCK_TOKENS.map((token) => stocks[token.symbol] ?? null);
  const anyDown = usdg === "failed" || eth === "failed" || stockReads.includes("failed") || circles.kind === "failed";
  const held = stockReads.filter((r): r is bigint => typeof r === "bigint" && r > 0n).length;
  const stocksRead = stockReads.every((r) => typeof r === "bigint");
  const card = circles.kind === "ready" && circles.view ? circleCard(circles.view, wallet.address) : null;

  return (
    <Shell active="Portfolio" side="robinhood" network={NETWORK}>
      <PortfolioHeader status={wallet.address ? { failed: anyDown, live: "Live · Robinhood Chain testnet" } : null} />

      {!wallet.address ? (
        <section className={portfolio.connect}>
          <span className={portfolio.tagLine}>Read only</span>
          <h2>See your Robinhood Chain testnet tokens and circle in one place.</h2>
          <p>Connect an EVM wallet to read its test USDG, its testnet ETH, the Stock Tokens from Robinhood&apos;s testnet faucet and the circles it is in. No transaction is requested.</p>
          <button type="button" className={portfolio.btnInk} onClick={walletUi.openConnect}>Connect wallet<Arrow d={ARROW_RIGHT} /></button>
        </section>
      ) : (
        <>
          {!wallet.onRobinhood && (
            <section aria-label="Network" className={portfolio.notice}>
              <span>Your wallet is on another network. The balances below are read from Robinhood Chain testnet for this address. Switch before joining or managing a circle; reading does not request a transaction.</span>
              <button type="button" className={portfolio.btnLine} onClick={() => void wallet.switchToRobinhood()}>Switch network</button>
            </section>
          )}

          <div className={portfolio.top}>
            <section aria-label="Your testnet wallet" className={portfolio.total}>
              <TotalDecor />
              <div className={portfolio.pills}>
                <span className={portfolio.pillLine}>Your wallet · Robinhood Chain testnet</span>
                <span className={portfolio.pillCream}>Test tokens · no value</span>
              </div>
              {typeof usdg === "bigint" ? (
                <b className={portfolio.big}>{usdgNumber(usdg)}<span className={portfolio.bigUnit}>USDG</span></b>
              ) : usdg === "failed" ? (
                <b className={portfolio.bigMuted}>Balance unavailable</b>
              ) : (
                <div className={portfolio.skel} />
              )}
              <span className={portfolio.holdLabel}>
                {usdg === "failed"
                  ? "We could not read this wallet's USDG on Robinhood Chain testnet, so no amount is shown."
                  : "Test USDG in this wallet, the stablecoin circles are paid and locked in. It has no value, so this is a token count, not a dollar balance. What a circle holds for you is in Your circle."}
              </span>
              <TokenChips label="In your wallet" note={usdg === null && eth === null ? "Reading your balance…" : null}>
                <TokenChip badge="$" slot="teal" amount={shown(usdg, usdgNumber)} unit="test USDG" />
                <TokenChip badge="E" slot="sky" amount={shown(eth, (v) => trimZeros(exactTokens(v.toString(), 18)))} unit="testnet ETH for gas" />
              </TokenChips>

              <section aria-label="Your Stock Tokens" className={portfolio.xsub}>
                <span className={portfolio.pillLine}>Your Stock Tokens · testnet</span>
                <span className={portfolio.xsubNote}>
                  {stocksRead ? `${held} of ${TESTNET_STOCK_TOKENS.length} held` : stockReads.includes("failed") ? "Some balances could not be read." : "Reading…"}{" "}
                  · from Robinhood&apos;s faucet, not used by circles
                </span>
                <div className={portfolio.legend}>
                  {TESTNET_STOCK_TOKENS.map((token, index) => (
                    <span key={token.symbol}><span style={{ background: `var(--${SLOTS[index % SLOTS.length]})` }} />{shown(stockReads[index] ?? null, fmtStock)} {token.symbol}</span>
                  ))}
                </div>
              </section>
            </section>

            <section aria-label="Your circle" className={portfolio.circle}>
              <RingsDecor />
              <div className={portfolio.pillsSpread}>
                <span className={portfolio.pillLine}>Your circle</span>
                <span className={portfolio.pillCream}>Test USDG only</span>
              </div>
              {circles.kind === "reading" ? (
                <div className={portfolio.skel} />
              ) : circles.kind === "failed" ? (
                <div className={portfolio.down}>
                  <b>Live data unavailable</b>
                  <span>We could not read your circles on Robinhood Chain testnet, so no numbers are shown.</span>
                  <button type="button" className={portfolio.btnCream} onClick={() => setCirclesTry((n) => n + 1)}>Try again</button>
                </div>
              ) : circles.kind === "closed" ? (
                <div className={portfolio.down}><b>Circles aren&apos;t open yet</b><span>Othello&apos;s contracts on Robinhood Chain testnet are waiting for their final review.</span></div>
              ) : card ? (
                <CircleSummary
                  href={card.href}
                  headline={card.headline}
                  sub={card.mustAct ? `${card.sub} · your payment is ${card.late ? "late" : "due"}` : card.sub}
                  pips={card.pips}
                  facts={card.facts}
                />
              ) : (
                <div className={portfolio.down}>
                  {/* with older circles unread, the card says only what it read (adversary on b1b1c30: an older circle can
                      still be running, since nothing on chain enforces three at a time yet) */}
                  <b>{circles.more ? `Nothing running in your ${READ_LIMIT} newest` : "No running circle"}</b>
                  <span>
                    {circles.count === 0
                      ? "This wallet hasn't started or joined a circle yet. Start one, or open the link someone sent you."
                      : circles.more
                        ? `This wallet has created or joined ${circles.count} circles. This card reads the ${READ_LIMIT} newest, and none of them is running right now; older ones are on your circles page.`
                        : `This wallet has created or joined ${circles.count === 1 ? "1 circle" : `${circles.count} circles`}, and none is running right now.`}
                  </span>
                  <Link href={circles.count === 0 ? "/robinhood/new" : "/robinhood"} className={portfolio.btnCream}>
                    {circles.count === 0 ? "Start a circle" : "Open your circles"}<Arrow d={ARROW_RIGHT} />
                  </Link>
                </div>
              )}
              <Link href="/robinhood" className={portfolio.allLink}>All your circles<Arrow d={ARROW_RIGHT} /></Link>
            </section>
          </div>

          <section aria-label="Robinhood Chain testnet assets" className={portfolio.holdings}>
            <div className={portfolio.holdHead}>
              <span className={portfolio.holdTitle}><span>Assets on Robinhood Chain testnet</span></span>
              <Link href="/robinhood/assets" className={portfolio.allStocks}>All assets<Arrow d={ARROW_RIGHT} /></Link>
            </div>
            <AssetRow href="/robinhood/assets" slot="teal" symbol="USDG" name="Paxos Global Dollar · testnet" short>
              <span className={portfolio.value}><b>{shown(usdg, fmtUsdg)}</b><span>Used by circles</span></span>
            </AssetRow>
            {TESTNET_STOCK_TOKENS.map((token, index) => (
              <AssetRow key={token.symbol} href={`/robinhood/assets/${token.symbol}`} slot={SLOTS[index % SLOTS.length]!} symbol={token.symbol} name={`${token.name} · testnet faucet`} short>
                <span className={portfolio.value}><b>{shown(stockReads[index] ?? null, (v) => `${fmtStock(v)} ${token.symbol}`)}</b><span>Not used by circles</span></span>
              </AssetRow>
            ))}
          </section>

          <TestTokenStrip label="Test tokens" title="Test tokens" tag="Robinhood Chain testnet · no value">
            <span className={portfolio.demoPills}>
              <span><b>{shown(usdg, fmtUsdg)}</b> test USDG (not real USDG)</span>
              <span><b>{shown(eth, (v) => trimZeros(exactTokens(v.toString(), 18)))}</b> testnet ETH for gas (not real ETH)</span>
              {/* a failed read says so, never the "…" of a read still running (adversary on 783fec7) */}
              {stockReads.includes("failed") ? (
                <span><b>Unavailable:</b> some faucet Stock Token balances could not be read (not real shares)</span>
              ) : (
                <span><b>{stocksRead ? held : "…"}</b> of {TESTNET_STOCK_TOKENS.length} faucet Stock Tokens held (not real shares)</span>
              )}
            </span>
            <a href={TESTNET_FAUCET} target="_blank" rel="noreferrer" className={portfolio.inlineLink}>Robinhood&apos;s testnet faucet</a>
          </TestTokenStrip>
        </>
      )}

      <PortfolioFooter href="/robinhood/assets" link="About these assets">
        Everything here is on Robinhood Chain testnet: test USDG, testnet ETH and faucet Stock Tokens, none with value. Not financial advice.
      </PortfolioFooter>
    </Shell>
  );
}
