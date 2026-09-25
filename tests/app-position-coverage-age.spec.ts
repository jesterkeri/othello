/**
 * T18d: the seat page's "Last checked". last_coverage_at is 0 on chain until the first
 * update_coverage or release_pot (the live demo circle, read 2026-09-25, has 0). The page
 * said "20721d 14h ago", arithmetic against 1970. The circle page already says "not yet
 * computed" for 0 (Circle.tsx); the seat page must not state a false age either.
 *
 * Rendered with react-dom/server from the repo's own "active" fixture; the only substitutions
 * are CSS modules as class-name stubs and the Shell's WalletControl as an empty component.
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
    // The Shell imports it as ./WalletConnect, other components by the @/ alias.
    if (specifier === "@/components/othello/WalletConnect" || specifier === "./WalletConnect") {
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

async function lastChecked(lastCoverageAt: number, now: number): Promise<string> {
  const React = appRequire("react");
  const { renderToStaticMarkup } = appRequire("react-dom/server");
  (globalThis as { React?: unknown }).React = React;
  const { default: Position } = await import(pathToFileURL(resolve(SRC, "components/position/Position.tsx")).href);
  const circle = { ...CIRCLE_STATES.active, lastCoverageAt };
  const html: string = renderToStaticMarkup(React.createElement(Position, { circle, seat: 2, now, stateKey: "demo", usdcWord: "test USDC" }));
  const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  const at = text.indexOf("Last checked");
  assert.ok(at >= 0, "the page has a Last checked row");
  return text.slice(at, at + 120);
}

describe("T18d: seat page coverage age", () => {
  const now = 1_790_000_000;

  it("control: a real recompute 46 seconds ago reads as 46s ago", async () => {
    assert.match(await lastChecked(now - 46, now), /Last checked 46s ago/);
  });

  it("never computed (last_coverage_at 0) says so, with no age", async () => {
    const row = await lastChecked(0, now);
    assert.match(row, /Last checked Not yet First computed when a pot is released or coverage is updated/);
    assert.doesNotMatch(row, /\d+d/);
  });
});
