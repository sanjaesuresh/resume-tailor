import { formatCount, logger, startTimer } from "./log";

// minimum plain-text length before we trust an extraction; shorter results are usually
// nav-only skeletons or JS-rendered shells, so callers treat them as extraction failure
const MIN_DESCRIPTION_LENGTH = 200;

// tags whose entire contents (including nested markup) are noise for job text and must
// be dropped before we look for a content container, not just have their own tags stripped
const NOISE_TAGS = ["script", "style", "nav", "header", "footer", "noscript"];

// candidate containers to score by visible text length; ordered by how likely they are to
// be the actual job description, though we still pick the single densest one by length
const CONTAINER_TAGS = ["main", "article", "div", "section", "body"];

// common named entities plus numeric/hex refs; a full HTML entity table is overkill for
// job posting text, which realistically only uses a handful of these
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  hellip: "…",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, code: string) => {
    if (code[0] === "#") {
      const isHex = code[1] === "x" || code[1] === "X";
      const codePoint = parseInt(code.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      return Number.isNaN(codePoint) ? match : String.fromCodePoint(codePoint);
    }
    return NAMED_ENTITIES[code] ?? match;
  });
}

// strips all tags for a given element name, including their inner content — used for
// script/style/nav/header/footer where the content itself is unwanted, not just the wrapper
function stripTagAndContents(html: string, tag: string): string {
  const re = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi");
  return html.replace(re, " ");
}

// pulls the inner HTML of every top-level (non-nested) match of a tag, so we can measure
// each candidate container's own text density independent of siblings
function extractContainerContents(html: string, tag: string): string[] {
  const contents: string[] = [];
  const openRe = new RegExp(`<${tag}\\b[^>]*>`, "gi");
  let match: RegExpExecArray | null;
  while ((match = openRe.exec(html)) !== null) {
    const start = match.index + match[0].length;
    const closeTag = `</${tag}>`;
    // walk forward tracking nested opens of the same tag so we grab the matching close,
    // not just the first occurrence (containers commonly nest, e.g. div > div)
    let depth = 1;
    let cursor = start;
    const nestedOpenRe = new RegExp(`<${tag}\\b[^>]*>|<\\/${tag}>`, "gi");
    nestedOpenRe.lastIndex = start;
    let inner: RegExpExecArray | null;
    while ((inner = nestedOpenRe.exec(html)) !== null) {
      if (inner[0].toLowerCase() === closeTag) {
        depth--;
        if (depth === 0) {
          contents.push(html.slice(start, inner.index));
          cursor = inner.index + closeTag.length;
          break;
        }
      } else {
        depth++;
      }
    }
    openRe.lastIndex = Math.max(cursor, openRe.lastIndex);
  }
  return contents;
}

// removes remaining tags and collapses whitespace, producing plain visible text
function tagsToText(html: string): string {
  const withoutTags = html.replace(/<[^>]+>/g, " ");
  const decoded = decodeEntities(withoutTags);
  return decoded.replace(/\s+/g, " ").trim();
}

// boards that render their posting client-side (Ashby, Workday, most SPA career pages) still emit
// a schema.org JobPosting block server-side, because Google Jobs requires it. Reading that beats
// scoring containers -- it's the posting itself with none of the page chrome -- and it needs no
// JavaScript execution, which is the only reason those pages look empty to a plain fetch.
const JSON_LD_SCRIPT_RE = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

// linked data arrives in three shapes in the wild: a bare object, a top-level array, and an
// "@graph" wrapper holding several nodes -- and "@type" is itself sometimes an array
function collectJobPostings(value: unknown, found: Record<string, unknown>[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectJobPostings(item, found);
    return;
  }
  if (typeof value !== "object" || value === null) return;

  const node = value as Record<string, unknown>;
  if (node["@graph"] !== undefined) collectJobPostings(node["@graph"], found);

  const type = node["@type"];
  const isJobPosting = Array.isArray(type)
    ? type.includes("JobPosting")
    : type === "JobPosting";
  if (isJobPosting) found.push(node);
}

// the description is the posting body alone, but the tailoring step reads the company and role out
// of this same text -- so carry the sibling fields onto the front. Workday publishes an empty
// organization name, hence the emptiness checks rather than blind interpolation.
function jobPostingHeading(node: Record<string, unknown>): string {
  const title = typeof node.title === "string" ? node.title.trim() : "";
  const org = node.hiringOrganization;
  const rawName =
    typeof org === "object" && org !== null
      ? (org as Record<string, unknown>).name
      : undefined;
  const company = typeof rawName === "string" ? rawName.trim() : "";

  if (title && company) return `${title} at ${company}`;
  return title || company;
}

/**
 * Pulls the job text out of any schema.org JobPosting published in the page's linked data.
 * Returns "" when the page publishes none — callers fall through to container scoring.
 */
export function extractJobPostingJsonLd(html: string): string {
  const nodes: Record<string, unknown>[] = [];

  for (const match of html.matchAll(JSON_LD_SCRIPT_RE)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(match[1]);
    } catch {
      // one malformed block must never hide a valid one elsewhere on the page
      continue;
    }
    collectJobPostings(parsed, nodes);
  }

  let best = "";
  for (const node of nodes) {
    // the description is HTML markup, so it goes through the same stripping/decoding the
    // container path uses rather than being handed back raw
    const description = typeof node.description === "string" ? tagsToText(node.description) : "";
    if (!description) continue;

    const text = [jobPostingHeading(node), description].filter(Boolean).join("\n\n");
    if (text.length > best.length) best = text;
  }

  return best;
}

// which path produced the text -- reported in the dev-console progress output, since "json-ld vs
// container" is the single most useful fact when a given board extracts badly
export type ExtractionStrategy = "json-ld" | "container" | "none";

export interface Extraction {
  text: string;
  strategy: ExtractionStrategy;
}

/**
 * Given raw HTML, prefers a published schema.org JobPosting; failing that, strips known noise tags
 * (script/style/nav/header/footer/noscript), then finds the densest candidate container
 * (main/article/div/section/body) by visible text length, decodes entities, and collapses whitespace.
 *
 * Returns "" if the best candidate's text is under MIN_DESCRIPTION_LENGTH chars — callers
 * treat that as extraction failure and fall back to a manual paste box.
 */
export function extractDescription(html: string): string {
  return extractDescriptionWithStrategy(html).text;
}

export function extractDescriptionWithStrategy(html: string): Extraction {
  // structured data first, and against the raw html: the noise-tag pass below strips <script>
  // contents wholesale, which would take the linked data with it
  const fromJsonLd = extractJobPostingJsonLd(html);
  if (fromJsonLd.length >= MIN_DESCRIPTION_LENGTH) return { text: fromJsonLd, strategy: "json-ld" };

  // comments are invisible to a real reader but still just text to our tag-stripping regexes,
  // so drop them before anything else or commented-out markup gets scored as content
  let cleaned = html.replace(/<!--[\s\S]*?-->/g, " ");
  for (const tag of NOISE_TAGS) {
    cleaned = stripTagAndContents(cleaned, tag);
  }

  const candidates: string[] = [];
  for (const tag of CONTAINER_TAGS) {
    for (const inner of extractContainerContents(cleaned, tag)) {
      const text = tagsToText(inner);
      if (text) {
        candidates.push(text);
      }
    }
  }

  // an ancestor's text is always a superset of its descendants', so picking the single
  // longest candidate biases toward the outermost wrapper (often body) whenever any content
  // exists outside the real job-description container — breadcrumbs, apply buttons, cookie
  // banners, related-jobs lists. Instead pick the tightest (smallest) candidate that still
  // holds ~all of the longest candidate's content, so a true content container wins over an
  // ancestor that merely contains it plus some sibling noise
  let best = "";
  if (candidates.length > 0) {
    const maxLength = Math.max(...candidates.map((text) => text.length));
    const threshold = maxLength * 0.8;
    for (const text of candidates) {
      if (text.length < threshold) continue;
      if (!best || text.length < best.length) {
        best = text;
      }
    }
  }

  // fall back to whatever text remains in the whole document if no container tag matched
  // at all (e.g. bare fragments with no main/article/div wrapper)
  if (!best) {
    best = tagsToText(cleaned);
  }

  return best.length >= MIN_DESCRIPTION_LENGTH
    ? { text: best, strategy: "container" }
    : { text: "", strategy: "none" };
}

const FETCH_TIMEOUT_MS = 15_000;
const DESKTOP_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export type ScrapeResult =
  | { ok: true; description: string }
  | { ok: false; error: string };

// only http/https job-posting URLs are ever legitimate; anything else (file:, data:, gopher:, ...)
// has no business being fetched server-side on a caller's behalf
const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

// this is a server-side fetch of a client-supplied URL: without a host check, a caller can point
// it at cloud-metadata endpoints (169.254.169.254) or anything on localhost/the private network
// and have the response body handed straight back to them (SSRF). The WHATWG URL parser already
// canonicalizes obfuscated IPv4 forms (hex/octal/decimal, e.g. "0x7f.0.0.1" -> "127.0.0.1") into
// dotted-decimal, so checking `hostname` after `new URL()` catches those for free.
function isPrivateOrLoopbackIPv4(hostname: string): boolean {
  const match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return false;
  const octets = match.slice(1, 5).map(Number);
  if (octets.some((o) => o > 255)) return false; // not actually a valid IPv4 literal

  const [a, b] = octets;
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (covers cloud metadata)
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 carrier-grade NAT
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  return false;
}

function isPrivateOrLoopbackIPv6(hostname: string): boolean {
  // URL#hostname keeps IPv6 literals bracketed and lowercased, e.g. "[::1]"
  if (!hostname.startsWith("[") || !hostname.endsWith("]")) return false;
  const addr = hostname.slice(1, -1);
  if (addr === "::1" || addr === "::") return true; // loopback / unspecified
  if (addr.startsWith("fe80:")) return true; // fe80::/10 link-local
  if (addr.startsWith("fc") || addr.startsWith("fd")) return true; // fc00::/7 unique local
  return false;
}

function isBlockedHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (lower === "localhost" || lower.endsWith(".localhost")) return true;
  return isPrivateOrLoopbackIPv4(lower) || isPrivateOrLoopbackIPv6(lower);
}

/**
 * Fetches a job posting URL with a desktop User-Agent and a 15s timeout, then runs
 * extractDescription on the response body. Invalid/non-http(s) URLs, private/loopback/link-local
 * hosts, network errors, non-2xx responses, and too-short extractions all surface as
 * `{ ok: false, error }` with a human-readable reason so the API route (and eventually the UI)
 * can fall back to a manual paste box.
 */
export async function scrapeJob(url: string): Promise<ScrapeResult> {
  const log = logger("scrape");

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    log(`✗ invalid URL`);
    return { ok: false, error: "Invalid URL" };
  }

  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    log(`✗ refused scheme ${parsed.protocol}`);
    return { ok: false, error: `Unsupported URL scheme "${parsed.protocol}" -- only http/https URLs can be fetched` };
  }
  if (isBlockedHost(parsed.hostname)) {
    log(`✗ refused private/loopback host ${parsed.hostname}`);
    return { ok: false, error: "This URL points to a private, loopback, or link-local address and cannot be fetched" };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const elapsed = startTimer();
  log(`GET ${parsed.hostname}${parsed.pathname}`);

  try {
    const response = await fetch(url, {
      headers: { "User-Agent": DESKTOP_USER_AGENT },
      signal: controller.signal,
    });

    if (!response.ok) {
      log(`✗ ${response.status} · ${elapsed()}`);
      return { ok: false, error: `Failed to fetch job posting: received status ${response.status}` };
    }

    // response.text() stays inside this same try so the abort timer covers the body read
    // too, not just the header response — a slow/stalled body read would otherwise hang
    // past the 15s budget, and any error thrown here would escape uncaught, bypassing the
    // { ok: false, error } contract callers rely on
    const html = await response.text();
    log(`${response.status} · ${formatCount(html.length)} bytes · ${elapsed()}`);

    const { text: description, strategy } = extractDescriptionWithStrategy(html);

    if (!description) {
      // names the strategy that came up empty, so a board that extracts badly can be diagnosed
      // from the terminal without re-fetching the page by hand
      log(`✗ no description found (json-ld absent, container text under the ${MIN_DESCRIPTION_LENGTH}-char floor)`);
      return { ok: false, error: "Could not extract a job description from this page" };
    }

    log(`strategy=${strategy} · ✓ ${formatCount(description.length)} chars`);
    return { ok: true, description };
  } catch (err) {
    // covers network failures, the AbortController firing on timeout (whether during the
    // fetch or the body read), and any error thrown while reading the response body
    const reason = err instanceof Error && err.name === "AbortError" ? "request timed out" : "network error";
    log(`✗ ${reason} · ${elapsed()}`);
    return { ok: false, error: `Failed to fetch job posting: ${reason}` };
  } finally {
    clearTimeout(timeout);
  }
}
