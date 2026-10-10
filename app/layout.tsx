import { Analytics } from "@vercel/analytics/next";
import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono, Space_Grotesk } from "next/font/google";
import type { ReactNode } from "react";

import { ServiceWorkerRegistration } from "@/components/service-worker-registration";
import { isManagedAuthMode } from "@/lib/server/auth-mode";
import { THEME_BOOT_SCRIPT, THEME_COLORS } from "@/lib/theme";

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
  applicationName: "Luban Market Lab",
  description:
    "A paper-trading simulator for student teams: shared portfolios, real market data, no real money.",
  // app/favicon.ico is added first by Next. Icons are drawn by
  // scripts/generate-icons.mjs; the manifest is app/manifest.ts.
  icons: {
    icon: [
      { url: "/icons/icon.svg", type: "image/svg+xml" },
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  appleWebApp: {
    capable: true,
    title: "Market Lab",
    statusBarStyle: "default",
  },
};

// viewport-fit=cover lets the installed app draw edge to edge; globals.css
// pads the page by the safe-area insets so nothing sits under a notch or
// the home indicator. The theme colour is the light canvas; the theme boot
// script and the toggle switch it when someone picks the dark theme.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: THEME_COLORS.light,
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Applies a saved light/dark choice before the first paint.
  const head = (
    <head>
      <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
    </head>
  );
  const body = (
    <body>
      {children}
      <ServiceWorkerRegistration />
      <Analytics />
    </body>
  );

  // ClerkProvider mounts only in managed mode: the Clerk SDK requires
  // provider keys, and demo mode must keep building and running without them.
  if (isManagedAuthMode()) {
    const { ClerkProvider } = await import("@clerk/nextjs");

    return (
      <html
        lang="en"
        className={`${spaceGrotesk.variable} ${plexMono.variable}`}
        suppressHydrationWarning
      >
        {head}
        <ClerkProvider
          appearance={{
            // The Luban logo heads the sign-in and sign-up cards, which stay
            // white in both themes.
            options: {
              logoImageUrl: "/brand/luban-logo.svg",
              logoPlacement: "inside",
            },
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
    <html
      lang="en"
      className={`${spaceGrotesk.variable} ${plexMono.variable}`}
      suppressHydrationWarning
    >
      {head}
      {body}
    </html>
  );
}
