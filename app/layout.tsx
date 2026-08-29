import type { Metadata } from "next";
import { IBM_Plex_Mono, Space_Grotesk } from "next/font/google";
import type { ReactNode } from "react";
import "./globals.css";

const spaceGrotesk = Space_Grotesk({
  variable: "--font-space-grotesk",
  subsets: ["latin"],
  display: "swap",
});

const plexMono = IBM_Plex_Mono({
  variable: "--font-plex-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Market Lab · Luban",
  description:
    "A local paper-trading prototype for shared student team portfolios.",
};

const DIRECTION_CONTRACT = `
THESIS: Shared team state is the interface's spine; the room refuses isolated brokerage cards and decorative market spectacle.
OWN-WORLD: Luban purple canvas, white paper regions, ink rules, flat four-pixel controls, mono data labels, lime confirmation, and pink simulation warnings.
STORY: A student identifies their session and team, reads the shared portfolio, records a simulated order, and sees who changed the account and where the team stands.
FIRST VIEWPORT: A compact header and simulation strip sit above a three-column trading room: portfolio left, quote and order workbench center, team activity and standings right.
FORM: Team Trading Room, fifth-ranked grounded structure, seed bb9a5bdf.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance.
`.trim();

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${spaceGrotesk.variable} ${plexMono.variable}`}>
      <body suppressHydrationWarning>
        <script
          data-direction-seed="bb9a5bdf"
          dangerouslySetInnerHTML={{
            __html: `document.currentScript?.before(document.createComment(${JSON.stringify(
              DIRECTION_CONTRACT,
            )}));`,
          }}
        />
        {children}
      </body>
    </html>
  );
}
