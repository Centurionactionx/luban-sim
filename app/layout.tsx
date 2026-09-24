import type { Metadata } from "next";
import { IBM_Plex_Mono, Space_Grotesk } from "next/font/google";
import type { ReactNode } from "react";

import { isManagedAuthMode } from "@/lib/server/auth-mode";

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

export default async function RootLayout({ children }: { children: ReactNode }) {
  const body = (
    <body>
      {children}
    </body>
  );

  // ClerkProvider mounts only in managed mode: the Clerk SDK requires
  // provider keys, and demo mode must keep building and running without them.
  if (isManagedAuthMode()) {
    const { ClerkProvider } = await import("@clerk/nextjs");

    return (
      <html lang="en" className={`${spaceGrotesk.variable} ${plexMono.variable}`}>
        <ClerkProvider
          appearance={{
            variables: {
              colorPrimary: "#6757c3",
              colorForeground: "#00171f",
              colorBackground: "#ffffff",
              colorInput: "#ffffff",
              colorInputForeground: "#00171f",
              colorDanger: "#a92f40",
              colorSuccess: "#287337",
              colorWarning: "#e85d75",
              borderRadius: "0px",
              fontFamily:
                "var(--font-space-grotesk), 'Helvetica Neue', Arial, sans-serif",
            },
          }}
        >
          {body}
        </ClerkProvider>
      </html>
    );
  }

  return (
    <html lang="en" className={`${spaceGrotesk.variable} ${plexMono.variable}`}>
      {body}
    </html>
  );
}
