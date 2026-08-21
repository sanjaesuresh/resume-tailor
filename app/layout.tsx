import type { Metadata } from "next";
import Link from "next/link";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
  display: "swap",
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Resume Tailor",
  description: "Tailor a résumé to a job posting and track applications.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`}>
      <body>
        {/* shared across both pages built in this batch of tasks -- kept intentionally minimal
            (two links, no active-state styling) since app/page.tsx is being built in parallel */}
        <header className="site-nav">
          <nav aria-label="Primary">
            <Link href="/new">New Application</Link>
            <Link href="/">Tracker</Link>
          </nav>
        </header>
        {children}
      </body>
    </html>
  );
}
