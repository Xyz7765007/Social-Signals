import type { Metadata, Viewport } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Pulse — Signal intelligence for outbound",
  description:
    "Surface real conversations across Reddit (and soon X, news, Instagram) that match your ICP. Built for B2B outbound teams.",
};

export const viewport: Viewport = {
  themeColor: "#0c0b08",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Header />
        <main className="min-h-[calc(100vh-160px)]">{children}</main>
        <Footer />
      </body>
    </html>
  );
}

function Header() {
  return (
    <header className="border-b hairline">
      <div className="max-w-6xl mx-auto px-6 py-5 flex items-center justify-between">
        <Link href="/" className="flex items-center gap-3 group">
          <span className="dot-live animate-pulse-slow" aria-hidden />
          <span className="font-display text-2xl tracking-tightest leading-none">
            Pulse
          </span>
          <span className="hidden sm:inline text-[10px] uppercase tracking-[0.18em] text-[var(--text-faint)] font-mono pl-3 border-l hairline">
            Signal&nbsp;Intelligence
          </span>
        </Link>
        <nav className="flex items-center gap-1 text-sm">
          <Link href="/" className="btn btn-ghost">
            New&nbsp;scan
          </Link>
          <Link href="/history" className="btn btn-ghost">
            History
          </Link>
        </nav>
      </div>
    </header>
  );
}

function Footer() {
  return (
    <footer className="border-t hairline mt-24">
      <div className="max-w-6xl mx-auto px-6 py-6 flex flex-col sm:flex-row justify-between gap-3 text-xs text-[var(--text-faint)] font-mono">
        <div>
          PULSE&nbsp;·&nbsp;v0.1&nbsp;·&nbsp;Reddit&nbsp;online&nbsp;·&nbsp;X&nbsp;/&nbsp;News&nbsp;/&nbsp;Instagram&nbsp;queued
        </div>
        <div>Built for outbound teams who don&apos;t scrape.</div>
      </div>
    </footer>
  );
}
