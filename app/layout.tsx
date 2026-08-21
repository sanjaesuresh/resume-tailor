import type { Metadata } from "next";
import { Geist, Geist_Mono, Source_Serif_4 } from "next/font/google";
import SiteNav from "./components/SiteNav";
import "./globals.css";

// unslop-ignore: Geist kept deliberately, not as an unexamined default -- it's the existing UI
// face for labels/buttons/inputs across a working app, paired below with an editorial serif
// (Source Serif 4) that carries every heading, so the type decision isn't "Geist everywhere."
// Geist Mono is scoped to genuinely monospace content (code/diff/log), a functional need, not a
// look choice.
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

// headline face for the "ink & paper" direction: résumés are typeset documents, so an editorial
// serif on headings (not body copy, not buttons) reads as a deliberate document-tool choice
// rather than a generic UI font. Weights cover the regular/semibold/bold used across headings.
const sourceSerif = Source_Serif_4({
  variable: "--font-serif",
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Resume Tailor",
  description: "Tailor a résumé to a job posting and track applications.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${sourceSerif.variable}`}
    >
      <body>
        <SiteNav />
        {children}
      </body>
    </html>
  );
}
