import type { Metadata } from "next";
import localFont from "next/font/local";
import { Header } from "../components/header";
import { Footer } from "../components/footer";
import "./globals.css";

const tiny = localFont({
  src: "./fonts/Tiny5-Regular.ttf",
  variable: "--font-tiny",
  display: "swap",
});

const mono = localFont({
  src: "./fonts/JetBrainsMono[wght].ttf",
  variable: "--font-mono",
  weight: "100 800",
  display: "swap",
});

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? "https://xray-terminal.com";

export const metadata: Metadata = {
  // Without this every og:image resolves against localhost, so a link
  // shared anywhere shows a broken card - the preview points at a host
  // only this machine can reach.
  metadataBase: new URL(SITE),
  title: "Xray-terminal - see the bones of any token",
  description:
    "Holder PnL terminal for Pons V2 tokens on Robinhood Chain. Who is in profit, who is underwater and whether those wallets can trade at all. Read-only.",
  icons: { icon: "/assets/cage.png" },
  openGraph: { siteName: "Xray-terminal", type: "website", url: SITE },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${tiny.variable} ${mono.variable}`}>
      <body>
        <div style={{ position: "relative", minHeight: "100vh", background: "var(--bg-deep)", overflow: "hidden" }}>
          <div
            style={{
              position: "absolute",
              left: "50%",
              top: -360,
              width: 1400,
              height: 800,
              transform: "translateX(-50%)",
              pointerEvents: "none",
              background:
                "radial-gradient(ellipse at center, rgba(120,220,255,.14) 0%, rgba(120,220,255,.04) 35%, transparent 70%)",
            }}
          />
          <div className="scanlines" />
          <div
            style={{
              position: "relative",
              maxWidth: 1180,
              margin: "0 auto",
              padding: "0 24px 96px",
              display: "flex",
              flexDirection: "column",
              gap: 24,
            }}
          >
            <Header />
            {children}
            <Footer />
          </div>
        </div>
      </body>
    </html>
  );
}
