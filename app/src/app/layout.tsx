import type { Metadata, Viewport } from "next";

import { WalletModal } from "@/components/othello/WalletConnect";
import { EvmWalletProvider } from "@/lib/robinhood/wallet";
import { PALETTES, themeVars } from "@/lib/theme";
import { cssVars, paintStoredTheme, screenDefaults } from "@/lib/theme-boot";
import { WalletProviders } from "@/lib/wallet";

import "./fonts.css";
import "./globals.css";

/**
 * The two typefaces come from app/src/app/fonts.css and app/public/fonts, not next/font/google (see fonts.css for
 * why). Archivo carries the wdth axis because the statement type sets font-stretch (OTHELLO-STYLE.md, Type): 68-70%
 * for tapes and tile headlines, 82% on the logo and the ajo button. The three latin files are preloaded, as
 * next/font/google preloaded them.
 */
const PRELOADED_FONTS = ["archivo-latin.4c98b9d490.woff2", "archivo-latin-italic.d2a3a083e9.woff2", "plus-jakarta-sans-latin.cd8db90cd9.woff2"];

export const metadata: Metadata = {
  title: "Othello",
  description: "Savings circles where nobody has to trust anybody.",
};

export const viewport: Viewport = { themeColor: "#E4E8FF" };

/**
 * Landing writes the live theme onto its own root element, so it owns every
 * colour inside the page. This base only reaches what sits behind it: the body
 * itself, and the overscroll area above and below the frame. Signal in light is
 * the first-visit default in theme.ts, so the two agree on first paint.
 */
const baseVars = cssVars(themeVars(PALETTES[0]!, false));

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // suppressHydrationWarning: the head script sets data-mode and color-scheme on <html> before React hydrates
    <html lang="en" suppressHydrationWarning>
      <head>
        {PRELOADED_FONTS.map((f) => (
          <link key={f} rel="preload" href={`/fonts/${f}`} as="font" type="font/woff2" crossOrigin="" />
        ))}
        <style dangerouslySetInnerHTML={{ __html: `:root{${baseVars}}${screenDefaults}` }} />
        <script dangerouslySetInnerHTML={{ __html: paintStoredTheme }} />
      </head>
      <body>
        {/* One wallet of each kind and one connect modal for every page, so
            connecting on Landing is still connected on Create. The EVM session
            (Robinhood Chain) sits outside because the modal lists its wallets. */}
        <EvmWalletProvider>
          <WalletProviders>
            {children}
            <WalletModal />
          </WalletProviders>
        </EvmWalletProvider>
      </body>
    </html>
  );
}
