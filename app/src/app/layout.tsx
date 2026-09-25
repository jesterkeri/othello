import type { Metadata, Viewport } from "next";
import { Archivo, Plus_Jakarta_Sans } from "next/font/google";

import { WalletModal } from "@/components/othello/WalletConnect";
import { PALETTES, themeVars } from "@/lib/theme";
import { WalletProviders } from "@/lib/wallet";

import "./globals.css";

/**
 * Archivo carries the wdth axis because the statement type sets font-stretch
 * (OTHELLO-STYLE.md, Type): 68-70% for tapes and tile headlines, 82% on the
 * logo and the ajo button.
 */
const archivo = Archivo({
  subsets: ["latin"],
  axes: ["wdth"],
  style: ["normal", "italic"],
  variable: "--font-archivo",
  display: "swap",
});

const jakarta = Plus_Jakarta_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  variable: "--font-jakarta",
  display: "swap",
});

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
const baseVars = Object.entries(themeVars(PALETTES[0]!, false))
  .map(([key, value]) => `${key}:${value}`)
  .join(";");

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${archivo.variable} ${jakarta.variable}`}>
      <head>
        <style dangerouslySetInnerHTML={{ __html: `:root{${baseVars}}` }} />
      </head>
      <body>
        {/* One wallet and one connect modal for every page, so connecting on
            Landing is still connected on Create. */}
        <WalletProviders>
          {children}
          <WalletModal />
        </WalletProviders>
      </body>
    </html>
  );
}
