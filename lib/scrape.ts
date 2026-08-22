import { formatCount, logger, startTimer } from "./log";

// minimum plain-text length before we trust an extraction; shorter results are usually
// nav-only skeletons or JS-rendered shells, so callers treat them as extraction failure
const MIN_DESCRIPTION_LENGTH = 200;

// tags whose entire contents (including nested markup) are noise for job text and must
// be dropped before we look for a content container, not just have their own tags stripped.
// <select> is here because an application form's dropdowns are form data, not prose: Lever's
// apply page ships a ~3,300-<option> university list that otherwise drowns the real posting,
// scoring as 100KB of the "densest" text on the page.
const NOISE_TAGS = ["script", "style", "nav", "header", "footer", "noscript", "select"];

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

// which path produced the text -- reported in the dev-console progress output, since "which
// strategy won" is the single most useful fact when a given board extracts badly.
// "json-ld" and "container" read the fetched HTML alone; the rest need the page URL (and
// sometimes the page body) to derive a second request, so they run in scrapeJob, not here.
export type ExtractionStrategy =
  | "json-ld"
  | "container"
  | "markdown-alternate"
  | "oracle-fusion"
  | "greenhouse-embed"
  | "bamboohr"
  | "none";

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

type TargetCheck =
  | { ok: true; url: URL }
  | { ok: false; error: string; reason: string };

/**
 * The single gate every outbound request in this module passes through. Board endpoints below are
 * built from the page URL and, for the greenhouse/markdown cases, from the page *body* — which is
 * attacker-controlled — so they get the identical scheme and private/loopback/link-local host
 * checks as the user-supplied URL. Deriving a string ourselves is not a reason to trust its host.
 */
function checkFetchTarget(raw: string): TargetCheck {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, error: "Invalid URL", reason: "invalid URL" };
  }
  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    return {
      ok: false,
      error: `Unsupported URL scheme "${parsed.protocol}" -- only http/https URLs can be fetched`,
      reason: `refused scheme ${parsed.protocol}`,
    };
  }
  if (isBlockedHost(parsed.hostname)) {
    return {
      ok: false,
      error: "This URL points to a private, loopback, or link-local address and cannot be fetched",
      reason: `refused private/loopback host ${parsed.hostname}`,
    };
  }
  return { ok: true, url: parsed };
}

// ---------------------------------------------------------------------------
// board adapters
//
// Some boards serve a plain fetch nothing but an empty SPA shell: the posting exists only behind
// an XHR the page's JavaScript makes after mount, so there is no JSON-LD and no container to
// score (the whole document is under 250 chars of text). Where that XHR targets a public,
// unauthenticated endpoint whose URL is derivable from the page URL, we can call it directly and
// get the posting body verbatim — cleaner than any rendered-HTML scrape, and no browser needed.
//
// These are deliberately narrow: each adapter matches one board's URL shape and returns null for
// everything else, so a miss costs nothing and falls through to the next.
// ---------------------------------------------------------------------------

function safeJsonParse(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

// same shape the JSON-LD path produces: an optional "<role> at <company>" line, then the body,
// because the tailoring step reads company and role back out of this same text
function joinHeadingAndBody(heading: string, parts: string[]): string {
  const body = parts.filter(Boolean).join("\n\n");
  if (!body) return "";
  return [heading.trim(), body].filter(Boolean).join("\n\n");
}

interface BoardAdapter {
  strategy: ExtractionStrategy;
  // the endpoint to fetch, or null when this adapter does not recognise the page
  endpoint(pageUrl: URL, html: string): string | null;
  parse(body: string): string;
}

// Oracle Fusion recruiting ("Candidate Experience"). Every tenant serves the same SPA on its own
// subdomain, so one adapter covers all of them; the site number and requisition id are both right
// there in the path.
const ORACLE_JOB_PATH_RE = /\/hcmUI\/CandidateExperience\/[^/]+\/sites\/([^/]+)\/job\/(\d+)/;

const oracleFusionAdapter: BoardAdapter = {
  strategy: "oracle-fusion",
  endpoint(pageUrl) {
    if (!/(^|\.)oraclecloud\.com$/i.test(pageUrl.hostname)) return null;
    const match = pageUrl.pathname.match(ORACLE_JOB_PATH_RE);
    if (!match) return null;
    const [, site, id] = match;
    // the finder argument is a quoted key=value list, so the quotes must survive encoding
    const finder = `ById;Id=%22${encodeURIComponent(id)}%22,siteNumber=%22${encodeURIComponent(site)}%22`;
    return `${pageUrl.origin}/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails?expand=all&onlyData=true&finder=${finder}`;
  },
  parse(body) {
    const items = asObject(safeJsonParse(body))?.items;
    if (!Array.isArray(items)) return "";
    const item = asObject(items[0]);
    if (!item) return "";
    // only the External* variants: tenants populate Internal*Str with byte-identical copy, and
    // taking both would hand the model the same requirements list twice
    const parts = [
      "ExternalDescriptionStr",
      "ExternalResponsibilitiesStr",
      "ExternalQualificationsStr",
      "CorporateDescriptionStr",
    ].map((key) => tagsToText(asString(item[key])));
    return joinHeadingAndBody(tagsToText(asString(item.Title)), parts);
  },
};

// Company-run career pages that embed Greenhouse in an iframe: the posting id is the gh_jid query
// param the aggregator link carries, and the board token is in the embed script's src. Both must
// be present — we never guess a token, since a wrong guess just 404s.
const GREENHOUSE_EMBED_TOKEN_RE = /boards\.greenhouse\.io\/embed\/job_board\/js\?for=([A-Za-z0-9_-]+)/i;

const greenhouseEmbedAdapter: BoardAdapter = {
  strategy: "greenhouse-embed",
  endpoint(pageUrl, html) {
    const jobId = pageUrl.searchParams.get("gh_jid");
    if (!jobId || !/^\d+$/.test(jobId)) return null;
    const token = html.match(GREENHOUSE_EMBED_TOKEN_RE)?.[1];
    if (!token) return null;
    return `https://boards-api.greenhouse.io/v1/boards/${token}/jobs/${jobId}?content=true`;
  },
  parse(body) {
    const job = asObject(safeJsonParse(body));
    if (!job) return "";
    // greenhouse double-escapes this field: the markup arrives with its angle brackets as
    // &lt;/&gt;, so it needs one entity decode to become HTML again before tag stripping sees tags
    const content = tagsToText(decodeEntities(asString(job.content)));
    if (!content) return "";
    const title = asString(job.title).trim();
    const company = asString(job.company_name).trim();
    const heading = title && company ? `${title} at ${company}` : title || company;
    return joinHeadingAndBody(heading, [content]);
  },
};

// BambooHR careers pages are /careers/<id>; the SPA reads the same id back from /careers/<id>/detail
const bambooHrAdapter: BoardAdapter = {
  strategy: "bamboohr",
  endpoint(pageUrl) {
    if (!/(^|\.)bamboohr\.com$/i.test(pageUrl.hostname)) return null;
    const match = pageUrl.pathname.match(/^\/careers\/(\d+)\/?$/);
    if (!match) return null;
    return `${pageUrl.origin}/careers/${match[1]}/detail`;
  },
  parse(body) {
    const opening = asObject(asObject(asObject(safeJsonParse(body))?.result)?.jobOpening);
    if (!opening) return "";
    const description = tagsToText(asString(opening.description));
    if (!description) return "";
    return joinHeadingAndBody(asString(opening.jobOpeningName), [description]);
  },
};

// Not board-specific: a page can advertise a plain-text rendering of itself via
// <link rel="alternate" type="text/markdown">. Workable emits one, and a markdown twin of the
// posting is strictly better input than scraped markup. Attribute order varies between boards, so
// match the whole tag and read the attributes out of it rather than assuming a fixed layout.
const ALTERNATE_LINK_RE = /<link\b[^>]*\brel=["']alternate["'][^>]*>/gi;

function findMarkdownAlternate(pageUrl: URL, html: string): string | null {
  for (const tag of html.match(ALTERNATE_LINK_RE) ?? []) {
    if (!/\btype=["']text\/markdown["']/i.test(tag)) continue;
    const href = tag.match(/\bhref=["']([^"']+)["']/i)?.[1];
    if (!href) continue;
    try {
      return new URL(decodeEntities(href), pageUrl).href;
    } catch {
      continue;
    }
  }
  return null;
}

// markdown is already human-readable, so this only tidies whitespace -- stripping the syntax
// would throw away the heading/bullet structure that makes the posting easy to read
function normalizeMarkdown(markdown: string): string {
  return markdown
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const markdownAlternateAdapter: BoardAdapter = {
  strategy: "markdown-alternate",
  endpoint: findMarkdownAlternate,
  parse: normalizeMarkdown,
};

// board-specific endpoints first (they return the posting alone), generic last
const BOARD_ADAPTERS: BoardAdapter[] = [
  oracleFusionAdapter,
  greenhouseEmbedAdapter,
  bambooHrAdapter,
  markdownAlternateAdapter,
];

/**
 * Runs each adapter that recognises the page, fetching its derived endpoint through the same SSRF
 * guards as the top-level request. Returns the first extraction that clears the length floor.
 * Exported for tests, which drive it with fixture bodies and a stubbed fetch.
 */
export async function extractViaBoardAdapters(
  pageUrl: URL,
  html: string,
  log: (message: string) => void = () => {}
): Promise<Extraction | null> {
  for (const adapter of BOARD_ADAPTERS) {
    let endpoint: string | null;
    try {
      endpoint = adapter.endpoint(pageUrl, html);
    } catch {
      continue;
    }
    if (!endpoint) continue;

    const target = checkFetchTarget(endpoint);
    if (!target.ok) {
      log(`✗ ${adapter.strategy} endpoint ${target.reason}`);
      continue;
    }

    const body = await fetchTextWithTimeout(target.url);
    if (body === null) continue;

    const text = adapter.parse(body);
    if (text.length >= MIN_DESCRIPTION_LENGTH) {
      return { text, strategy: adapter.strategy };
    }
  }
  return null;
}

// shared by every adapter: a failed secondary request must never take down the whole scrape, since
// the caller already has a page in hand and other adapters may still match -- so this swallows
// network errors and non-2xx into null rather than throwing
async function fetchTextWithTimeout(url: URL): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url.href, {
      headers: {
        "User-Agent": DESKTOP_USER_AGENT,
        Accept: "application/json, text/markdown;q=0.9, text/plain;q=0.8, */*;q=0.5",
      },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Aggregator links (Simplify's among them) often point at a board's application form rather than
 * the posting. Lever's /apply page is the form alone — the description lives one segment up — so
 * without this the extractor returns a wall of form labels and dropdown options instead of the job.
 */
export function normalizeJobUrl(parsed: URL): URL {
  if (parsed.hostname.toLowerCase() === "jobs.lever.co" && /\/apply\/?$/.test(parsed.pathname)) {
    const normalized = new URL(parsed.href);
    normalized.pathname = parsed.pathname.replace(/\/apply\/?$/, "");
    return normalized;
  }
  return parsed;
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

  const target = checkFetchTarget(url);
  if (!target.ok) {
    log(`✗ ${target.reason}`);
    return { ok: false, error: target.error };
  }
  const parsed = normalizeJobUrl(target.url);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const elapsed = startTimer();
  log(`GET ${parsed.hostname}${parsed.pathname}`);

  try {
    const response = await fetch(parsed.href, {
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

    let extraction: Extraction | null = null;
    const fromHtml = extractDescriptionWithStrategy(html);
    if (fromHtml.text) {
      extraction = fromHtml;
    } else {
      // the HTML alone was an empty SPA shell; see whether this board publishes the posting at an
      // endpoint we can derive from the URL (or from a markdown alternate the page itself declares)
      log(`json-ld absent and container text under the ${MIN_DESCRIPTION_LENGTH}-char floor · trying board endpoints`);
      extraction = await extractViaBoardAdapters(parsed, html, log);
    }

    if (!extraction) {
      // names what came up empty, so a board that extracts badly can be diagnosed from the
      // terminal without re-fetching the page by hand
      log(`✗ no description found (no linked data, no content container, no board endpoint matched)`);
      return { ok: false, error: "Could not extract a job description from this page" };
    }

    log(`strategy=${extraction.strategy} · ✓ ${formatCount(extraction.text.length)} chars`);
    return { ok: true, description: extraction.text };
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
