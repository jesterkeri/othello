/**
 * T18c adversary: the live round status's "Can be declared in default" at exactly
 * deadline + grace.
 *
 * Requirement under test (T18c brief): "Every statement ... in the live round status must be
 * true per SPEC.md §5". SPEC.md §5 declare_default: "now > deadline + grace"; INVARIANTS I7:
 * "declare_default only when clock.unix_timestamp > deadline + grace". The program refuses
 * at exactly deadline + grace (grace_not_elapsed), proven by tests/t15-declare-default.spec.ts
 * "I7: refuses at exactly deadline + grace and accepts one second later".
 *
 * Circle: the repo's own "active" fixture (app/src/fixtures/circles.ts) with one field
 * changed so the condition exists: Ada (seat 1, received in round 0) has not paid this
 * round, paidBitmap 0b11110. Rendered with react-dom/server in live mode; the only
 * substitutions are CSS modules as class-name stubs and the header's WalletControl, which
 * needs the wallet provider, as an empty span.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { REPO } from "./artifacts.ts";
import { CIRCLE_STATES } from "../app/src/fixtures/circles.ts";

const SRC = resolve(REPO, "app/src");
const appRequire = createRequire(resolve(SRC, "components/circle/index.ts"));

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith(".module.css")) {
      return { url: "data:text/javascript,export default new Proxy({}, { get: (_, k) => String(k) });", shortCircuit: true };
    }
    if (specifier === "@/components/othello/WalletConnect") {
      return { url: "data:text/javascript,export function WalletControl() { return null; }", shortCircuit: true };
    }
    if (specifier.startsWith("@/")) {
      const base = resolve(SRC, specifier.slice(2));
      for (const ext of [".ts", ".tsx", "/index.ts", "/index.tsx", ""]) {
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

const circle = { ...CIRCLE_STATES.active, paidBitmap: 0b11110 };
const graceEnd = circle.roundDeadline + circle.graceSecs;

async function statusAt(now: number): Promise<string> {
  const React = appRequire("react");
  const { renderToStaticMarkup } = appRequire("react-dom/server");
  (globalThis as { React?: unknown }).React = React;
  const { default: Circle } = await import(pathToFileURL(resolve(SRC, "components/circle/Circle.tsx")).href);
  const live = {
    circleAddress: "8uGgNmog9gbwDMFMB2EKHXBSQ43YcUaB8eAPhgGsXT3Q",
    readAt: now,
    error: null,
    mirrorLabel: "NFLXx devnet mirror",
    usdcWord: "test USDC",
    yourTurn: null,
    split: { multiplier: 1, newMultiplier: 1, effectiveAt: 0 },
    action: null,
    below: null,
  };
  const html: string = renderToStaticMarkup(React.createElement(Circle, { circle, startNow: now, stateKey: "demo", live }));
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
}

describe("T18c adversary: live round status against I7", () => {
  it("control: one second after deadline + grace it names Ada as defaultable", async () => {
    assert.match(await statusAt(graceEnd + 1), /Can be declared in default Ada/);
  });

  it("does not say a seat can be declared in default at exactly deadline + grace", async () => {
    const text = await statusAt(graceEnd);
    assert.doesNotMatch(
      text,
      /Can be declared in default/,
      "at now = deadline + grace the program refuses declare_default (grace_not_elapsed, I7), yet the status says it can be declared",
    );
  });
});
