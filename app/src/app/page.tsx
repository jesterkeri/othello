import Link from "next/link";

import styles from "./landing.module.css";

/** SPEC §5 demo circle: five seats, and seat 3 is this round's recipient. */
const SEATS = [1, 2, 3, 4, 5] as const;
const RECIPIENT = 3;

const BLOCKS = [
  { bg: "var(--clay)", rotate: -12 },
  { bg: "var(--acid)", rotate: 8 },
  { bg: "var(--sky)", rotate: -5 },
] as const;

export default function Landing() {
  return (
    <div className={styles.desk}>
      <div className={styles.card}>
        <header className={styles.header}>
          <span className={styles.logo} aria-label="Othello">
            {BLOCKS.map((b, i) => (
              <span
                key={b.bg}
                className={styles.logoBlock}
                style={{ background: b.bg, transform: `rotate(${b.rotate}deg)`, marginLeft: i ? -6 : 0 }}
              />
            ))}
          </span>

          <span className={styles.wordmark}>Othello</span>

          <button type="button" className={styles.connect}>
            Connect wallet
          </button>
        </header>

        <p className={styles.provenance}>
          <span className={styles.chip}>Devnet demo</span>
          The demo trades labelled mirrors of these shares, not the real xStocks.
        </p>

        <section className={styles.hero}>
          <span className={styles.eyebrow}>Tokenised stock as a promise</span>

          <h1 className={styles.title}>Savings circles where nobody has to trust anybody</h1>

          <p className={styles.lede}>
            Lock tokenized stock as a promise. You still own it. You get it back when the circle
            ends.
          </p>

          <div className={styles.actions}>
            <Link className={`${styles.button} ${styles.buttonPrimary}`} href="/circle">
              Open demo circle
            </Link>
            <Link className={styles.button} href="/create">
              Create a circle
            </Link>
          </div>

          <p className={styles.actionNote}>One click, no wallet, nothing to sign</p>
        </section>

        <section className={styles.panel}>
          <h2 className={styles.kicker}>The problem</h2>
          <p className={styles.panelLead}>
            Today the only protection is <em className={styles.mark}>reputation</em>
          </p>
          <p className={styles.panelBody}>
            Circles break when an early recipient takes the pot and stops paying. Othello makes
            the promise checkable instead.
          </p>
        </section>

        <section className={styles.panel}>
          <h2 className={styles.kicker}>This round</h2>

          <ol className={styles.seats} aria-label="Five seats, seat three receives this round">
            {SEATS.map((n) => (
              <li
                key={n}
                className={n === RECIPIENT ? `${styles.seat} ${styles.seatPaid}` : styles.seat}
                aria-current={n === RECIPIENT ? "step" : undefined}
              >
                {n}
              </li>
            ))}
          </ol>

          <p className={styles.panelLead}>Seat {RECIPIENT} gets the whole pot</p>
          <p className={styles.panelBody}>
            Everyone else pays in. Each seat gets the pot once, then the order comes back around.
            Three to eight seats.
          </p>
        </section>

        <section className={styles.panel}>
          <p className={styles.panelBody}>
            It&rsquo;s an ajo where everyone locks some stock as a promise, so if someone takes the
            pot and disappears, their stock pays for it. Every member can check at any moment that
            each obligation is covered.
          </p>
        </section>
      </div>
    </div>
  );
}
