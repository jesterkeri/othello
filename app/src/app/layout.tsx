import type { Metadata, Viewport } from "next";
import { Archivo } from "next/font/google";

import { SIGNAL, themeCss } from "@/lib/theme";

import "./globals.css";

const archivo = Archivo({
  subsets: ["latin"],
  weight: ["400", "500", "800"],
  variable: "--font-archivo",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Othello",
  description: "Savings circles where nobody has to trust anybody.",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#EAE7F2" },
    { media: "(prefers-color-scheme: dark)", color: "#0D0F1C" },
  ],
};

/**
 * The palette is emitted as CSS rather than inline style, so the dark variant
 * can be chosen by the media query with no JavaScript and no flash.
 */
const themeStyles = `
:root { ${themeCss(SIGNAL, false)} }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) { ${themeCss(SIGNAL, true)} }
}
:root[data-theme="dark"] { ${themeCss(SIGNAL, true)} }
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={archivo.variable}>
      <head>
        <style dangerouslySetInnerHTML={{ __html: themeStyles }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
