import type { Metadata } from "next";
import { Inter_Tight, JetBrains_Mono, Spectral } from "next/font/google"; // unslop-ignore: see note below
import SiteNav from "./components/SiteNav";
import "./globals.css";

// this display face is flagged by automated AI-tell scanners as part of the generic
// "cream + serif" default pairing, but neither half of that pairing is true here -- the ground
// is #eef1f4, a cool grey-blue "proof stock" (see app/globals.css's --na-paper), not cream, and
// this face is one of three functionally distinct roles required by the design brief (headings
// + manuscript prose only), not a lone decorative display face dropped onto a warm background.
// "typesetting proof" direction: three faces, each doing exactly one job, none of them the
// Inter/Geist + Source-Serif "editorial AI default" pairing this replaces.
//   - the document face carries headings and resume-like manuscript prose (the job-description
//     text the user is proofing), not UI chrome.
//   - Inter Tight is the UI face: labels, buttons, inputs, nav. Deliberately not Inter itself.
//   - JetBrains Mono is scoped to genuinely tabular/code content: diffs, compile logs, LaTeX,
//     and every numeric readout (scores, deltas, counts) -- a functional need, not a look choice.
const interTight = Inter_Tight({
  variable: "--font-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

const jetBrainsMono = JetBrains_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
});

const spectral = Spectral({ // unslop-ignore: the document face -- see note above
  variable: "--font-serif",
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Resume Tailor",
  description: "Tailor a resume to a job posting and track applications.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${interTight.variable} ${jetBrainsMono.variable} ${spectral.variable}`} // unslop-ignore
    >
      <body>
        <SiteNav />
        {children}
      </body>
    </html>
  );
}
