import type { Metadata } from "next";
import { Archivo, Inter_Tight, JetBrains_Mono } from "next/font/google"; // unslop-ignore: see note below
import SiteNav from "./components/SiteNav";
import "./globals.css";

// this display face carries the same "one of three functionally distinct roles" brief the
// serif it replaces did (headings + manuscript prose only, never UI chrome or mono content) --
// only the face itself changed, from a high-contrast serif (an AI-design tell the owner flagged
// by name) to Archivo: a grotesque built for sturdy, squarish display use at heavy weights, not
// a "safe" pick like Inter/Space Grotesk/Poppins. Renamed --font-serif -> --font-display since
// it is no longer a serif; every reference to the old variable in globals.css was grepped and
// updated in the same change so nothing silently falls back to a system font.
//   - the display face carries headings and resume-like manuscript prose (the job-description
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

// weights actually referenced in globals.css: 600 on every heading selector (na-heading,
// rc-heading, dv-heading, tr-title, settings-dialog-title), 400 as the unset default on
// na-done-summary and the landing page's quoted resume bullet -- nothing else is loaded
const archivo = Archivo({ // unslop-ignore: the display face -- see note above
  variable: "--font-display",
  subsets: ["latin"],
  weight: ["400", "600"],
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
      className={`${interTight.variable} ${jetBrainsMono.variable} ${archivo.variable}`} // unslop-ignore
    >
      <body>
        <SiteNav />
        {children}
      </body>
    </html>
  );
}
