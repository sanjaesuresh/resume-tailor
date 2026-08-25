# Resume Tailor

Takes a base LaTeX resume and a job posting, rewrites the resume to target that posting
through an LLM, rejects anything the model invented, compiles the result to PDF with
`tectonic`, and tracks the application. Invite-only and multi-user: each account has its own
resume, skills whitelist, and tailoring prompt, and sees only its own applications.

The no-fabrication guarantee is the point of the project, and it is enforced in code rather
than by asking a model to behave. `lib/validator.ts` rejects any new capitalised term in a
tailored resume that is neither already in the base resume nor on that user's skills
whitelist, along with removed bullets, over-length bullets, and unescaped `%`. Violations are
fed back for a retry (initial attempt plus at most two). A user can edit their tailoring
prompt freely; it cannot switch those checks off.

Not deployable on Vercel or any serverless platform -- it shells out to a `tectonic` binary,
which needs a real filesystem and a long-lived process. See
[`docs/deployment.md`](docs/deployment.md) for the supported path: one Docker container with
a persistent volume, on Railway or Fly.io.

## How it works

1. **Paste a posting URL** (or the text). `lib/scrape.ts` fetches it, reading schema.org
   `JobPosting` linked data where a board publishes it and falling back to container scoring.
   It has adapters for Greenhouse, Lever, Ashby, Workday, Oracle Fusion and BambooHR.
2. **The posting is narrowed to the job itself.** `lib/jobtext.ts` drops compensation, benefits
   and EEO boilerplate before anything sees it, so terms like "base pay" never reach the
   keyword list a resume is scored against.
3. **Tailoring.** `lib/tailor.ts` sends your resume, your whitelist and your prompt to the
   configured provider, then validates the reply and retries on violations.
4. **Review.** A line-by-line diff, an ATS keyword report (`lib/ats.ts`), and a PDF preview
   compiled from the exact draft on screen -- not an auto-repaired version of it.
5. **Approve.** The document is compiled, persisted, and added to the tracker. If compilation
   fails, one LLM repair attempt runs, and its output is re-validated against the draft you
   approved before anything is saved.

## Routes

| Path | |
|---|---|
| `/` | Public landing page |
| `/signin`, `/signup` | Sign-up requires an invite code |
| `/applications` | The tracker: status, notes, ATS score, downloads, delete |
| `/new` | The tailoring flow |
| `/settings` | Resume, skills whitelist, tailoring prompt, name |
| `/api/health` | Runtime healthcheck for deployments |

## Prerequisites

- Node.js 22 or newer (`better-sqlite3` requires it).
- The `tectonic` LaTeX engine on your `PATH` (`brew install tectonic` on macOS). Without it,
  PDF compilation fails locally the same way it would in a container missing it.
- A Gemini API key (Google AI Studio). Without one the app falls back to a local Claude CLI
  provider, which only works if you have that CLI installed and authenticated.

## Environment variables

Set these in `.env.local` (never committed) or on whatever host runs the container.

| Variable | Required | Purpose |
|---|---|---|
| `BETTER_AUTH_SECRET` | yes | Signs session tokens. Generate with `openssl rand -base64 32`. Auth refuses to start without it, deliberately -- the library would otherwise fall back to a well-known placeholder and every session would be forgeable. |
| `BETTER_AUTH_URL` | yes in production | The public URL the app is actually reachable at (`http://localhost:3000` locally). Production fails closed if it is missing; development/test fall back to localhost. Get it wrong and sign-in appears to succeed but does not stick. |
| `GEMINI_API_KEY` | to use Gemini | Provider credential. Its presence is also what selects Gemini by default. |
| `LLM_PROVIDER` | no | Forces the provider: `gemini`, `cli`, or `api`. `CLAUDE_PROVIDER` is still read as the old name. |
| `GEMINI_MODEL` | no | Overrides the model id. Must be a flash model on a free-tier key -- every pro model answers 429 there. |
| `GEMINI_MAX_OUTPUT_TOKENS` | no | Output ceiling. Defaults well above the resume size because thinking tokens draw on the same allowance. |
| `RESUME_OWNER_NAME` | no | Fallback name in download filenames, for an account that has not set one. |
| `RATE_LIMIT_TAILOR_PER_DAY` | no | Per-user tailoring cap. |
| `RATE_LIMIT_COMPILE_PER_HOUR` | no | Per-user compile cap. |
| `RATE_LIMIT_SCRAPE_PER_HOUR` | no | Per-user scrape cap. |

## Running locally

1. `npm install`
2. Create `.env.local` with at least `BETTER_AUTH_SECRET` and
   `BETTER_AUTH_URL=http://localhost:3000`.
3. `npm run dev`
4. Mint yourself an invite code (below), then sign up at
   [http://localhost:3000/signup](http://localhost:3000/signup).
5. Add your LaTeX resume and skills whitelist at `/settings` before tailoring anything.

In development only, a missing saved resume falls back to the committed sample assets so a
fresh clone runs end to end. That fallback is gated on `NODE_ENV` and never fires in
production -- a deployed instance tailoring against whatever file sits on its filesystem is
the multi-user bug the gate exists to prevent.

Other scripts: `npm run build`, `npm run lint`, `npm test` (vitest).

## Scripts

Accounts are created by redeeming a single-use invite code; there is no open signup form.

```bash
node scripts/create-invite.ts [email]      # prints a code to stdout
node scripts/claim-orphans.ts you@example  # one-time, see below
```

`claim-orphans` assigns applications that predate accounts to your account. It refuses once
more than one account exists, because at that point nothing in the data says whose rows they
were. Run it after signing up, before inviting anyone else. In the deployed Docker image use
the runtime script instead:

```bash
railway ssh -- node scripts/claim-orphans.mjs you@example
```

## Data

Everything that cannot be regenerated lives under `data/`, which is gitignored: `tracker.db`
plus one directory per application holding its `.tex`, `.pdf` and report. Uploaded resumes,
whitelists and prompts live in the database rather than on disk, so the database file is a
complete backup of user state.

SQLite runs in WAL mode. **`cp data/tracker.db` produces a torn, stale copy** -- committed
pages can still be sitting in the `-wal` file. Use:

```bash
sqlite3 data/tracker.db "VACUUM INTO 'backup.db'"
```

There are no down migrations. Recovery is restore-from-backup.

## Deployment

See [`docs/deployment.md`](docs/deployment.md) for building the image, deploying to Railway
or Fly.io, attaching the volume, pointing a domain at it, and the backup procedure.
