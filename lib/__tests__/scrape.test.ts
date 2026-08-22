import { describe, it, expect, afterEach, vi } from "vitest";
import {
  extractDescription,
  extractJobPostingJsonLd,
  extractViaBoardAdapters,
  normalizeJobUrl,
  scrapeJob,
} from "../scrape";

// long enough to clear the 200-char minimum, so these fixtures exercise the real accept/reject path
const JOB_BODY =
  "We are hiring a Backend Engineer to design and operate the services behind our payments " +
  "platform. You will own ingestion, work closely with product and design, mentor other engineers, " +
  "and drive reliability improvements across both our streaming and batch infrastructure at scale.";

function ldScript(payload: unknown): string {
  return `<script type="application/ld+json">${JSON.stringify(payload)}</script>`;
}

// the failure this whole strategy exists for: a client-rendered board whose visible markup is an
// empty mount point, with the real posting sitting in linked data beside it
function spaShell(...scripts: string[]): string {
  return `<html><head>${scripts.join("")}</head><body><div id="root"></div></body></html>`;
}

describe("extractDescription", () => {
  it("extracts job text from a Greenhouse-like page, ignoring nav/footer noise", () => {
    // realistic length job description (>200 chars) so it survives the too-short guard
    const jobText =
      "We are looking for a Senior Software Engineer to join our platform team. " +
      "You will design and build scalable backend services, collaborate with product and design, " +
      "and mentor junior engineers. Requirements include 5+ years of experience with distributed systems, " +
      "strong communication skills, and a track record of shipping production software.";
    const html = `
      <html>
        <head><title>Senior Software Engineer at Acme</title></head>
        <body>
          <nav>Home About Careers Contact Sign In</nav>
          <header>Acme Careers Header Navigation Menu</header>
          <div id="content" class="job-description">
            <h1>Senior Software Engineer</h1>
            <p>${jobText}</p>
          </div>
          <footer>Copyright Acme Corp. Privacy Policy Terms of Service</footer>
        </body>
      </html>
    `;

    const result = extractDescription(html);

    expect(result).toContain("Senior Software Engineer to join our platform team");
    expect(result).not.toContain("Sign In");
    expect(result).not.toContain("Privacy Policy");
  });

  it("returns an empty string when the body is only a script tag", () => {
    const html = `
      <html>
        <head><title>Loading</title></head>
        <body>
          <script>
            window.__INITIAL_STATE__ = { some: "data that is long enough to pad this script tag well beyond two hundred characters so it would otherwise pass the length check if it were not stripped correctly by the extractor before measuring text length" };
          </script>
        </body>
      </html>
    `;

    expect(extractDescription(html)).toBe("");
  });

  it("decodes HTML entities like &amp;", () => {
    const jobText =
      "Join our Engineering &amp; Product team to build tools that help millions of users " +
      "every day. We value collaboration &amp; ownership, and we invest heavily in growth &amp; mentorship " +
      "for every engineer on the team, regardless of seniority or background, across the whole org.";
    const html = `<html><body><main><p>${jobText}</p></main></body></html>`;

    const result = extractDescription(html);

    expect(result).toContain("Engineering & Product team");
    expect(result).not.toContain("&amp;");
  });

  it("picks the tightest container over an outer wrapper padded with sibling noise", () => {
    // job text made long enough that it stays >=80% of the outer wrapper's total text
    // even after the sibling noise below is added, so the inner div should win over body
    const jobText =
      "We are seeking an experienced Data Platform Engineer to design, build, and operate " +
      "large-scale data pipelines that power analytics across the company. In this role you will " +
      "own the ingestion and transformation layer, partner closely with data science and product " +
      "teams, and drive reliability improvements across our streaming and batch infrastructure. " +
      "We are looking for someone with deep experience in distributed systems, a strong sense of " +
      "operational ownership, and the communication skills to work across many stakeholders. " +
      "You will mentor other engineers, participate in architecture reviews, and help define the " +
      "long-term roadmap for our data platform as the company continues to scale rapidly. " +
      "Responsibilities include designing schemas for our warehouse, building self-service tooling " +
      "for analysts, and establishing SLAs for data freshness and quality across every pipeline we " +
      "own. You will also lead incident response for the data platform, write postmortems, and " +
      "collaborate with security and compliance teams on data retention and access policies. " +
      "We value engineers who can move fast without sacrificing correctness, who document their " +
      "systems clearly, and who enjoy pairing with teammates to level up the whole organization. " +
      "This role reports to the Director of Data Platform and has significant room to grow into " +
      "a technical leadership position as our data organization continues to expand its scope.";
    const breadcrumb = "Home / Careers / Engineering / Data Platform Engineer";
    const applyButton = "Apply now";
    const cookieBanner =
      "We use cookies to improve your experience on this site. By continuing to browse you agree " +
      "to our use of cookies as described in our Cookie Policy. Accept Decline Manage preferences";
    const relatedJobs = "Related jobs: Backend Engineer, Site Reliability Engineer, Data Scientist";
    const html = `
      <html>
        <body>
          <div class="breadcrumb">${breadcrumb}</div>
          <div class="job-description">
            <h1>Data Platform Engineer</h1>
            <p>${jobText}</p>
          </div>
          <button>${applyButton}</button>
          <div class="cookie-banner">${cookieBanner}</div>
          <div class="related-jobs">${relatedJobs}</div>
        </body>
      </html>
    `;

    const result = extractDescription(html);

    expect(result).toContain("Data Platform Engineer to design, build, and operate");
    expect(result).not.toContain(breadcrumb);
    expect(result).not.toContain(applyButton);
    expect(result).not.toContain(cookieBanner);
    expect(result).not.toContain(relatedJobs);
  });

  it("strips HTML comments so commented-out markup is never scored as content", () => {
    const jobText =
      "We are hiring a Product Designer to shape the end-to-end experience of our platform. " +
      "You will partner with engineering and product to research, prototype, and ship features " +
      "used by millions of people, and you will help build a design system that scales across teams.";
    const commentedOut =
      "This entire paragraph is commented out legacy copy about an old internship program that " +
      "no longer exists and should never appear in the extracted job description text at all.";
    const html = `
      <html>
        <body>
          <main>
            <!-- <p>${commentedOut}</p> -->
            <p>${jobText}</p>
          </main>
        </body>
      </html>
    `;

    const result = extractDescription(html);

    expect(result).toContain("Product Designer to shape the end-to-end experience");
    expect(result).not.toContain(commentedOut);
  });
});

describe("extractDescription (schema.org JobPosting in linked data)", () => {
  it("recovers the posting from a client-rendered page whose body is an empty mount point", () => {
    // this is the Ashby/Workday case: container scoring sees nothing, JSON-LD has everything
    const html = spaShell(
      ldScript({ "@context": "https://schema.org", "@type": "JobPosting", title: "Backend Engineer", description: `<p>${JOB_BODY}</p>` })
    );

    expect(extractDescription(html)).toContain("design and operate the services behind our payments");
  });

  it("carries the title and company through, so company/role detection does not regress", () => {
    const html = spaShell(
      ldScript({
        "@type": "JobPosting",
        title: "Backend Engineer",
        hiringOrganization: { "@type": "Organization", name: "Acme" },
        description: JOB_BODY,
      })
    );

    expect(extractDescription(html)).toContain("Backend Engineer at Acme");
  });

  it("omits the company when the board publishes an empty organization name (Workday does)", () => {
    const html = spaShell(
      ldScript({
        "@type": "JobPosting",
        title: "Backend Engineer",
        hiringOrganization: { "@type": "Organization", name: "" },
        description: JOB_BODY,
      })
    );

    // assert on the heading line alone: the body text legitimately contains "at scale"
    const heading = extractDescription(html).split("\n\n")[0];
    expect(heading).toBe("Backend Engineer");
  });

  it("finds the posting inside an @graph wrapper alongside unrelated linked-data nodes", () => {
    const html = spaShell(
      ldScript({
        "@context": "https://schema.org",
        "@graph": [
          { "@type": "Organization", name: "Acme", url: "https://acme.example" },
          { "@type": "BreadcrumbList", itemListElement: [] },
          { "@type": "JobPosting", title: "Backend Engineer", description: JOB_BODY },
        ],
      })
    );

    const result = extractDescription(html);
    expect(result).toContain("design and operate the services behind our payments");
    expect(result).not.toContain("BreadcrumbList");
  });

  it("accepts @type published as an array", () => {
    const html = spaShell(ldScript({ "@type": ["JobPosting"], description: JOB_BODY }));
    expect(extractDescription(html)).toContain("design and operate the services");
  });

  it("skips a malformed block instead of letting it hide a valid one later on the page", () => {
    const html = spaShell(
      `<script type="application/ld+json">{ not valid json ]</script>`,
      ldScript({ "@type": "JobPosting", description: JOB_BODY })
    );

    expect(extractDescription(html)).toContain("design and operate the services");
  });

  it("strips markup and decodes entities inside the description", () => {
    const html = spaShell(
      ldScript({
        "@type": "JobPosting",
        description: `<p>Join Engineering &amp; Product.</p><ul><li>${JOB_BODY}</li></ul>`,
      })
    );

    const result = extractDescription(html);
    expect(result).toContain("Engineering & Product");
    expect(result).not.toContain("<li>");
    expect(result).not.toContain("&amp;");
  });

  it("prefers the longest posting when a page publishes several", () => {
    const shortBody = JOB_BODY.slice(0, 210);
    const html = spaShell(
      ldScript({ "@type": "JobPosting", description: shortBody }),
      ldScript({ "@type": "JobPosting", description: `${JOB_BODY} You will also lead incident response.` })
    );

    expect(extractDescription(html)).toContain("lead incident response");
  });

  it("falls back to container scoring when the linked-data description is too short to trust", () => {
    const html = `
      <html>
        <head>${ldScript({ "@type": "JobPosting", description: "Backend Engineer" })}</head>
        <body><main><p>${JOB_BODY}</p></main></body>
      </html>
    `;

    const result = extractDescription(html);
    expect(result).toContain("design and operate the services behind our payments");
    // the container text won outright -- the too-short heading was not prepended to it
    expect(result.startsWith("Backend Engineer at")).toBe(false);
  });

  it("returns nothing for linked data that carries no JobPosting at all", () => {
    const html = spaShell(ldScript({ "@type": "Organization", name: "Acme", description: JOB_BODY }));
    expect(extractJobPostingJsonLd(html)).toBe("");
    expect(extractDescription(html)).toBe("");
  });
});

describe("extractDescription (application-form noise)", () => {
  it("ignores <select> options so a dropdown cannot outweigh the posting", () => {
    // Lever's /apply page ships a ~3,300-entry university dropdown; before <select> was treated as
    // noise it scored as the densest text on the page and became the "description"
    const universities = Array.from(
      { length: 400 },
      (_, i) => `<option value="${i}">National Institute of Technology Campus Number ${i}</option>`
    ).join("");
    const html = `
      <html>
        <body>
          <div class="posting"><p>${JOB_BODY}</p></div>
          <form><select name="school">${universities}</select></form>
        </body>
      </html>
    `;

    const result = extractDescription(html);

    expect(result).toContain("design and operate the services behind our payments");
    expect(result).not.toContain("National Institute of Technology");
  });
});

describe("normalizeJobUrl", () => {
  it("drops Lever's /apply segment, where the form replaces the posting body", () => {
    expect(normalizeJobUrl(new URL("https://jobs.lever.co/acme/abc-123/apply")).href).toBe(
      "https://jobs.lever.co/acme/abc-123"
    );
  });

  it("keeps the query string (aggregators append tracking params to the apply link)", () => {
    expect(normalizeJobUrl(new URL("https://jobs.lever.co/acme/abc-123/apply?ref=Simplify")).href).toBe(
      "https://jobs.lever.co/acme/abc-123?ref=Simplify"
    );
  });

  it("leaves a Lever posting URL and other hosts untouched", () => {
    expect(normalizeJobUrl(new URL("https://jobs.lever.co/acme/abc-123")).href).toBe(
      "https://jobs.lever.co/acme/abc-123"
    );
    // "/apply" is the posting itself on plenty of other boards, so the rewrite must stay scoped
    expect(normalizeJobUrl(new URL("https://careers.example.com/jobs/9/apply")).href).toBe(
      "https://careers.example.com/jobs/9/apply"
    );
  });
});

describe("extractViaBoardAdapters", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // every adapter test drives the real fetch path through a stub, so the suite never touches the
  // network; `calls` lets each test assert on the endpoint the adapter derived
  function stubFetch(body: string, ok = true) {
    const fetchMock = vi.fn().mockResolvedValue({
      ok,
      status: ok ? 200 : 404,
      text: () => Promise.resolve(body),
    } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  const SPA_SHELL = `<html><body><div id="root"></div></body></html>`;

  it("reads an Oracle Fusion posting from the recruiting REST endpoint", async () => {
    const fetchMock = stubFetch(
      JSON.stringify({
        items: [
          {
            Id: "155860",
            Title: "Software Engineer I",
            ExternalDescriptionStr: `<p>${JOB_BODY}</p>`,
            ExternalResponsibilitiesStr: "<ul><li>Assist in the design and coding of features.</li></ul>",
          },
        ],
      })
    );

    const result = await extractViaBoardAdapters(
      new URL("https://ibqbjb.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/Honeywell/job/155860"),
      SPA_SHELL
    );

    expect(result?.strategy).toBe("oracle-fusion");
    expect(result?.text).toContain("Software Engineer I");
    expect(result?.text).toContain("design and operate the services behind our payments");
    const requested = String(fetchMock.mock.calls[0][0]);
    expect(requested).toContain("/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails");
    expect(requested).toContain("Id=%22155860%22");
    expect(requested).toContain("siteNumber=%22Honeywell%22");
  });

  it("skips the Internal* copies so the requirements are not repeated", async () => {
    stubFetch(
      JSON.stringify({
        items: [
          {
            Title: "Software Engineer I",
            ExternalQualificationsStr: `<p>${JOB_BODY}</p>`,
            InternalQualificationsStr: `<p>${JOB_BODY}</p>`,
          },
        ],
      })
    );

    const result = await extractViaBoardAdapters(
      new URL("https://eeho.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_45001/job/340728"),
      SPA_SHELL
    );

    const occurrences = result!.text.split("design and operate the services").length - 1;
    expect(occurrences).toBe(1);
  });

  it("reads a Greenhouse-embedded posting using gh_jid plus the board token in the page", async () => {
    // greenhouse returns `content` as entity-escaped HTML, so the fixture escapes it the same way
    const escaped = `&lt;p&gt;${JOB_BODY} We value ownership &amp;amp; craft.&lt;/p&gt;`;
    const fetchMock = stubFetch(
      JSON.stringify({ title: "Embedded Engineer", company_name: "DMC", content: escaped })
    );
    const html = `<html><body><div id="grnhse_app"></div>
      <script src="https://boards.greenhouse.io/embed/job_board/js?for=dmcengineering"></script></body></html>`;

    const result = await extractViaBoardAdapters(
      new URL("https://www.dmcinfo.com/careers/open-positions?gh_jid=5136284008"),
      html
    );

    expect(result?.strategy).toBe("greenhouse-embed");
    expect(result?.text).toContain("Embedded Engineer at DMC");
    expect(result?.text).toContain("ownership & craft");
    expect(result?.text).not.toContain("&lt;");
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "https://boards-api.greenhouse.io/v1/boards/dmcengineering/jobs/5136284008?content=true"
    );
  });

  it("does not guess a Greenhouse board token when the page never names one", async () => {
    // Hudson River Trading is exactly this case: gh_jid in the URL, token injected by their own JS.
    // A guessed token just 404s, so the adapter must decline rather than invent one.
    const fetchMock = stubFetch("{}");

    const result = await extractViaBoardAdapters(
      new URL("https://www.hudsonrivertrading.com/careers/job/?gh_jid=8052050"),
      `<html><body><div id="grnhse_app_new"></div></body></html>`
    );

    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads a BambooHR posting from the /detail endpoint beside the careers page", async () => {
    const fetchMock = stubFetch(
      JSON.stringify({
        result: { jobOpening: { jobOpeningName: "Software Engineer - New Grad", description: `<p>${JOB_BODY}</p>` } },
      })
    );

    const result = await extractViaBoardAdapters(
      new URL("https://nexthopai.bamboohr.com/careers/24/"),
      SPA_SHELL
    );

    expect(result?.strategy).toBe("bamboohr");
    expect(result?.text).toContain("Software Engineer - New Grad");
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://nexthopai.bamboohr.com/careers/24/detail");
  });

  it("follows a markdown alternate the page declares about itself", async () => {
    const markdown = `# Deployed Software Engineer\n\n\n\n## Description\n\n${JOB_BODY}`;
    const fetchMock = stubFetch(markdown);
    const html = `<html><head>
      <link rel="alternate" type="text/plain" href="/arondite/llms.txt"/>
      <link rel="alternate" type="text/markdown" href="/arondite/jobs/view/5C5C551ADA.md"/>
    </head><body><div id="root"></div></body></html>`;

    const result = await extractViaBoardAdapters(
      new URL("https://apply.workable.com/arondite/j/5C5C551ADA/apply"),
      html
    );

    expect(result?.strategy).toBe("markdown-alternate");
    // headings survive; only runs of blank lines are collapsed
    expect(result?.text).toContain("# Deployed Software Engineer");
    expect(result?.text).not.toContain("\n\n\n");
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "https://apply.workable.com/arondite/jobs/view/5C5C551ADA.md"
    );
  });

  it("ignores an alternate link that is not markdown", async () => {
    const fetchMock = stubFetch("irrelevant");
    const html = `<html><head><link rel="alternate" type="application/rss+xml" href="/feed.xml"/></head></html>`;

    expect(await extractViaBoardAdapters(new URL("https://example.com/job/1"), html)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a derived endpoint that points at a private or metadata address", async () => {
    // the markdown alternate's href comes from page content, so a hostile page could aim the
    // scraper's second request at cloud metadata. The SSRF guards must cover it exactly as they
    // cover the URL the user pasted.
    const fetchMock = stubFetch("should never be fetched");
    const hostile = `<html><head>
      <link rel="alternate" type="text/markdown" href="http://169.254.169.254/latest/meta-data/iam/security-credentials/"/>
    </head></html>`;

    expect(await extractViaBoardAdapters(new URL("https://evil.example.com/job/1"), hostile)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a derived endpoint on a non-http scheme", async () => {
    const fetchMock = stubFetch("should never be fetched");
    const hostile = `<html><head>
      <link rel="alternate" type="text/markdown" href="file:///etc/passwd"/>
    </head></html>`;

    expect(await extractViaBoardAdapters(new URL("https://evil.example.com/job/1"), hostile)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns null without fetching when no adapter recognises the page", async () => {
    const fetchMock = stubFetch("{}");

    expect(await extractViaBoardAdapters(new URL("https://careers.example.com/jobs/42"), SPA_SHELL)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls through when the derived endpoint errors instead of failing the whole scrape", async () => {
    const fetchMock = stubFetch("", false);

    const result = await extractViaBoardAdapters(
      new URL("https://nexthopai.bamboohr.com/careers/24"),
      SPA_SHELL
    );

    expect(result).toBeNull();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("falls through when the endpoint returns JSON with no description in it", async () => {
    stubFetch(JSON.stringify({ result: { jobOpening: { jobOpeningName: "Engineer", description: "" } } }));

    expect(
      await extractViaBoardAdapters(new URL("https://nexthopai.bamboohr.com/careers/24"), SPA_SHELL)
    ).toBeNull();
  });

  it("falls through when the endpoint returns malformed JSON", async () => {
    stubFetch("{ not json ]");

    expect(
      await extractViaBoardAdapters(new URL("https://nexthopai.bamboohr.com/careers/24"), SPA_SHELL)
    ).toBeNull();
  });
});

describe("scrapeJob", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns ok:false instead of throwing when reading the response body fails", async () => {
    // simulates a connection that resolves headers fine but errors mid-body-read; before the
    // fix this rejection escaped scrapeJob uncaught since the timer only guarded the fetch call
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.reject(new Error("stream reset")),
      } as unknown as Response)
    );

    const result = await scrapeJob("https://example.com/job/123");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Failed to fetch job posting");
    }
  });

  it("falls back to a board endpoint when the fetched page is an empty SPA shell", async () => {
    const fetchMock = vi.fn(async (target: string) => {
      const body = target.includes("/hcmRestApi")
        ? JSON.stringify({ items: [{ Title: "Software Engineer I", ExternalDescriptionStr: `<p>${JOB_BODY}</p>` }] })
        : `<html><body><div id="root"></div></body></html>`;
      return { ok: true, status: 200, text: () => Promise.resolve(body) } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await scrapeJob(
      "https://ibqbjb.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/Honeywell/job/155860"
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.description).toContain("design and operate the services behind our payments");
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("requests the normalized URL, not the aggregator's /apply deep link", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(`<html><body><main><p>${JOB_BODY}</p></main></body></html>`),
    } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);

    await scrapeJob("https://jobs.lever.co/acme/abc-123/apply?ref=Simplify");

    expect(String(fetchMock.mock.calls[0][0])).toBe("https://jobs.lever.co/acme/abc-123?ref=Simplify");
  });

  it("still refuses a private/loopback host after the guard refactor", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    for (const url of [
      "http://169.254.169.254/latest/meta-data/",
      "http://localhost:3000/job/1",
      "http://0x7f.0.0.1/job/1",
      "http://[::1]/job/1",
    ]) {
      const result = await scrapeJob(url);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("private, loopback, or link-local");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still refuses a non-http scheme after the guard refactor", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await scrapeJob("file:///etc/passwd");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Unsupported URL scheme");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
