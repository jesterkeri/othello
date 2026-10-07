"use client";

/**
 * The circles page as one bento (with two or three running circles it fits the screen on tablet and desktop; with
 * fewer it keeps a set height, Joshua 2026-10-06: "just dont fill the entire page") (Joshua, 2026-10-06, from the Nexus/Metly
 * references): a title row, the first running circle as the largest tile across the top with the "Needs you" pill in
 * its notched corner (the bubble counts every circle waiting on this wallet: pay, claim, start, join, collect, and
 * opens them in a pop-up), the others beneath it, and the finished ones as one stacked card in the bottom-right corner (one opens that
 * circle, more open a pop-up list).
 *
 * The layout is drawn for up to three running circles: a member is in at most three at a time (Joshua 2026-10-06; the
 * join/create limit that enforces it is its own change). The board shows the first three. Until that limit exists
 * nothing stops a fourth, so any past three are listed behind an "N more running" button in the title row, drawn only
 * then (adversary on 5c308b7: a fourth was nowhere on the page).
 */
import { useLayoutEffect, useRef, type ReactNode } from "react";

import type { ChainSide } from "@/lib/chains";
import { CHAIN_PAGE, isCreator, mySeat, type ListCircle } from "@/lib/core/circle-list";
import type { CircleCard as Card } from "@/lib/core/circle-card";

import CircleCard, { Arrow, Fit, MiniRing, PillShape, Trim, short, type Design } from "./CircleCard";
import c from "./CircleCard.module.css";
import CirclesPhone from "./CirclesPhone";

type Item = { v: ListCircle; card: Card };

const live = (v: ListCircle) => v.status === "Active" || v.status === "Forming";
const SHOWN = 3;
const DESIGNS: Design[] = ["hero", "pot", "members"];
const AREAS = ["a", "b", "c"];
// the hero takes the accent itself (CircleCard.module.css .dHero); the others the palette's sky and cobalt
const TONES: Record<Design, string | undefined> = { hero: undefined, pot: c.toneSky, members: c.toneCobalt };

/** The Needs-you pill: the bubble counts every circle waiting on this wallet and opens them in a pop-up. */
function NeedsPill({ count, waiting, onOpen }: { count: number; waiting: number; onOpen: () => void }) {
  const label = count === 0 ? "Nothing waiting on you" : count === 1 ? "1 circle needs you" : `${count} circles need you`;
  return (
    <button type="button" className={c.pill} onClick={onOpen} disabled={waiting === 0} aria-label={label} aria-haspopup="dialog">
      <PillShape text={count === 0 ? "All caught up" : "Needs you"} bubble={count === 0 ? "✓" : count} hot={count > 0} />
    </button>
  );
}

/** A pop-up list of circles, each with its next step and the button that does it. */
function ListDialog({ dialog, title, items, me }: { dialog: React.RefObject<HTMLDialogElement | null>; title: string; items: Item[]; me: string }) {
  return (
    <dialog ref={dialog} className={c.dialog} aria-label={title}
      onClick={(e) => e.target === e.currentTarget && e.currentTarget.close()}>
      <div className={c.dialogHead}>
        <h2 className={c.dialogTitle}>{title}</h2>
        <button type="button" className={c.close} onClick={() => dialog.current?.close()} aria-label="Close">×</button>
      </div>
      <ul className={c.dialogList}>
        {items.map(({ v, card }) => (
          <li key={v.address} className={c.row}>
            <MiniRing v={v} me={me} className={c.ringRow} />
            <span className={c.rowText}>
              <b>{card.headline}</b>
              <span className={c.detail}>Circle {short(v.address)} · {card.detail}</span>
            </span>
            <a className={`${c.rowAction} ${card.group === "needs" ? c.rowHot : ""}`} href={v.href}
              aria-label={`${card.action}: circle ${short(v.address)}`}>
              {card.action} <span aria-hidden>→</span>
            </a>
          </li>
        ))}
      </ul>
    </dialog>
  );
}

/**
 * The finished circles as one card with the layers of a pile under it. One circle opens it; more open the list. It
 * shows in every state (Joshua 2026-10-06): with none yet, it says where finished circles will go.
 */
function FinishedStack({ items, me, onOpen }: { items: Item[]; me: string; onOpen: () => void }) {
  if (items.length === 0) {
    return (
      <div className={c.stackWrap} style={{ gridArea: "f" }}>
        {/* the pile's layers stay, empty or not (Joshua 2026-10-06) */}
        <span className={`${c.layer} ${c.layer1}`} aria-hidden />
        <span className={`${c.layer} ${c.layer2}`} aria-hidden />
        <div className={`${c.tile} ${c.plain} ${c.finished} ${c.toneGrey}`}>
          <span className={c.shape}>
            <span className={c.fill}>
              <Trim deco="stripes" />
              <span className={c.cardTop}><span className={c.stage}>Finished</span></span>
              <span className={c.cardBody}>
                <b className={c.headline}>Your completed circles come here.</b>
                <span className={c.detail}>When a circle pays out its last round, it moves here, and you collect what you locked from it.</span>
              </span>
            </span>
          </span>
        </div>
      </div>
    );
  }
  const toCollect = items.filter((x) => x.card.group === "needs").length;
  const inner = (
    <>
      <span className={c.shape}>
        <span className={c.fill}>
          <Trim deco="stripes" />
          <Fit as="span">
            <span className={c.cardTop}>
              <span className={c.stage}>Finished</span>
              {toCollect > 0 && <span className={c.sticker}>{toCollect} to collect</span>}
            </span>
            <span className={c.cardBody}>
              <span className={c.membersHead}>
                <span className={c.bigNum}>{items.length}</span>
                <span className={c.potLabel}>{items.length === 1 ? "circle paid out or cancelled" : "circles paid out or cancelled"}</span>
              </span>
              <span className={c.tokens}>
                {items.slice(0, 4).map(({ v }) => <MiniRing key={v.address} v={v} me={me} className={c.token} />)}
                {items.length > 4 && <span className={c.more}>+{items.length - 4}</span>}
              </span>
              <span className={c.detail}>{items.length === 1 ? `Circle ${short(items[0]!.v.address)}` : "Open the list"}</span>
            </span>
          </Fit>
        </span>
      </span>
      <span className={c.notchBtn} aria-hidden><Arrow /></span>
    </>
  );
  const cls = `${c.tile} ${c.notched} ${c.finished} ${c.toneGrey}`;
  return (
    <div className={c.stackWrap} style={{ gridArea: "f" }}>
      {/* the pile's layers always show, whatever the count, so its bottom lines up with the tiles beside it (Joshua
          2026-10-06) */}
      <span className={`${c.layer} ${c.layer1}`} aria-hidden />
      <span className={`${c.layer} ${c.layer2}`} aria-hidden />
      {items.length === 1
        ? <a className={cls} href={items[0]!.v.href}>{inner}</a>
        : <button type="button" className={cls} onClick={onOpen} aria-haspopup="dialog">{inner}</button>}
    </div>
  );
}

export default function CirclesBoard({ items, me, side }: { items: Item[]; me: string; side: ChainSide }) {
  const needsDialog = useRef<HTMLDialogElement>(null);
  const doneDialog = useRef<HTMLDialogElement>(null);
  const moreDialog = useRef<HTMLDialogElement>(null);
  // the screen fills the viewport below wherever it starts (the shell's bar, a banner above it)
  const screen = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = screen.current;
    if (!el) return;
    const measure = () => el.style.setProperty("--top", `${Math.round(el.getBoundingClientRect().top + window.scrollY)}px`);
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);
  // circles waiting on this wallet first, so the largest tile is the one to act on
  // An invitation (Forming, a seat in the wallet's name it has not joined, a circle it did not create) is anyone's to
  // send (adversary on f3be27c): it waits in the Needs-you list as a Join, and never takes a tile from a circle the
  // wallet chose to be in.
  const invite = (v: ListCircle) => v.status === "Forming" && !isCreator(v, me) && !mySeat(v, me)?.joined;
  const running = items.filter((x) => live(x.v) && !invite(x.v)).sort((x, y) => Number(y.card.group === "needs") - Number(x.card.group === "needs"));
  const shown = running.slice(0, SHOWN);
  const extra = running.slice(SHOWN);
  const done = items.filter((x) => !live(x.v));
  const needs = items.filter((x) => x.card.group === "needs");
  // the Waiting-on-you list also holds invitations the chain cannot take a join for yet: they never take a tile, so
  // this is where they are on the page; the pill counts only what the wallet can do now
  const waiting = items.filter((x) => x.card.group === "needs" || invite(x.v));
  const layout = c[`n${shown.length}`];
  // the Needs-you pill sits in the largest tile's notched corner; with no running circle, in the title row
  const pill = <NeedsPill count={needs.length} waiting={waiting.length} onOpen={() => needsDialog.current?.showModal()} />;
  return (
    <div ref={screen} className={`${c.screen} ${shown.length >= 2 ? c.screenFit : ""}`}>
      <CirclesTitle side={side} action={shown.length === 0 ? <span className={c.deskOnly}>{pill}</span> : extra.length > 0 ? (
        <button type="button" className={c.start} onClick={() => moreDialog.current?.showModal()} aria-haspopup="dialog">
          {extra.length} more running
        </button>
      ) : null} />
      {/* a phone gets its own layout (CirclesPhone), not this bento squeezed (Joshua 2026-10-06) */}
      <CirclesPhone side={side} running={shown} done={done} needsCount={needs.length} waitingCount={waiting.length}
        onNeeds={() => needsDialog.current?.showModal()} onDone={() => doneDialog.current?.showModal()} />
      <div className={`${c.board} ${layout} ${c.deskOnly}`}>
        {shown.length === 0 && (
          <div className={c.empty} style={{ gridArea: "e" }}>
            <b className={c.headline}>No circles running right now.</b>
            <span className={c.detail}>Start one and invite the people you save with, or open a link someone sent you.</span>
            <a className={c.heroAction} href={CHAIN_PAGE[side].startHref}>Start a circle <span aria-hidden>→</span></a>
          </div>
        )}
        {shown.map(({ v, card }, i) => (
          <CircleCard key={v.address} v={v} me={me} card={card} design={DESIGNS[i]!} area={AREAS[i]!} tone={TONES[DESIGNS[i]!] ?? ""} corner={i === 0 ? pill : null} index={i} />
        ))}
        {shown.length === 1 && (
          // one running circle: the free slot invites another (up to three at once)
          <div className={c.empty} style={{ gridArea: "s" }}>
            <b className={c.headline}>Room for another circle.</b>
            <span className={c.detail}>You can be in up to three circles at once.</span>
            <a className={c.heroAction} href={CHAIN_PAGE[side].startHref}>Start a circle <span aria-hidden>→</span></a>
          </div>
        )}
        <FinishedStack items={done} me={me} onOpen={() => doneDialog.current?.showModal()} />
      </div>
      <ListDialog dialog={needsDialog} title="Waiting on you" items={waiting} me={me} />
      <ListDialog dialog={doneDialog} title="Finished circles" items={done} me={me} />
      <ListDialog dialog={moreDialog} title="Also running" items={extra} me={me} />
    </div>
  );
}

/** The page's title row: what this page is, the way to start a circle, and (with circles) the Needs-you pill. */
export function CirclesTitle({ side, action = null }: { side: ChainSide; action?: ReactNode }) {
  return (
    <header className={c.titleRow}>
      <div className={c.headText}>
        <h1 className={c.title}>{CHAIN_PAGE[side].title}</h1>
      </div>
      <div className={c.headActions}>
        {action}
        <a className={c.start} href={CHAIN_PAGE[side].startHref}>Start a circle <span aria-hidden>→</span></a>
      </div>
    </header>
  );
}
