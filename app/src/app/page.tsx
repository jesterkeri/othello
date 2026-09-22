import Link from "next/link";

/**
 * Landing.
 *
 * Every string below is the committed copy from SPEC §9's "Copy per place"
 * table, or a plain restatement of a mechanic SPEC and design/FLOWS.md already
 * define. Nothing here is invented, and no number appears that the program has
 * not been shown to produce.
 *
 * The three steps are FLOWS J1 and J2 (design/FLOWS.md:135-137) in the words a
 * person would use, per the vocabulary table's "Never say" column.
 */
export default function Landing() {
  return (
    <main>
      <h1>Savings circles where nobody has to trust anybody</h1>

      <p className="lede">
        Lock tokenized stock as a promise. You still own it. You get it back when the circle
        ends.
      </p>

      <div className="actions">
        <Link className="button button--primary" href="/circle">
          Open demo circle
        </Link>
        <Link className="button" href="/create">
          Create a circle
        </Link>
      </div>

      <hr className="rule" />

      <h2>How a circle runs</h2>

      <ol className="steps">
        <li>
          <b>1</b>
          <span>
            One person names the members and the order they get paid. Each member confirms by
            joining.
          </span>
        </li>
        <li>
          <b>2</b>
          <span>
            Every round, each member pays their contribution, and whoever&rsquo;s turn it is
            receives the pot.
          </span>
        </li>
        <li>
          <b>3</b>
          <span>
            A payout only happens while everyone still has enough locked stock and reserve to
            cover what they owe.
          </span>
        </li>
      </ol>

      <hr className="rule" />

      <h2>Why the stock stays yours</h2>

      <div className="card">
        <p>
          Your stock is held as cover, not sold. It is counted at the lower of its market price
          and its share price, minus a safety margin, so a good week never lets someone borrow
          more than the stock would really fetch.
        </p>
        <p style={{ marginBottom: 0 }}>
          When a company splits its stock, your holding is worth exactly what it was worth a
          second earlier. Othello reads the split. A system that does not would think most of
          your cover had vanished.
        </p>
      </div>

      <hr className="rule" />

      <p className="foot">
        A prototype on Solana devnet, for the Stocklana hackathon. The demo uses labelled mirror
        tokens, not real xStocks.
      </p>
    </main>
  );
}
