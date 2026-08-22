# Resume Tailor

Takes a base LaTeX resume and a job posting, produces a tailored resume and cover letter
through an LLM, validates the output against a no-fabrication whitelist so nothing gets
invented, compiles it to PDF with `tectonic`, and tracks the application. Invite-only,
multi-user: each account has its own resume, whitelist, and tailoring prompt, and sees only
its own applications.

Not deployable on Vercel or any serverless platform -- it shells out to a `tectonic`
binary, which needs a real filesystem and a long-lived process. See
[`docs/deployment.md`](docs/deployment.md) for the supported deployment path (one Docker
container with a persistent volume, on Railway or Fly.io).

## Prerequisites

- Node.js 22 or newer (`better-sqlite3` requires it).
- The `tectonic` LaTeX engine on your `PATH` (`brew install tectonic` on macOS). Without
  it, PDF compilation fails locally the same way it would in a container missing it.
- A Gemini API key (Google AI Studio) to actually run tailoring. Without one, the app falls
  back to a local Claude CLI provider, which only works if you have that CLI installed and
  authenticated.

## Environment variables

Set these in a local `.env.local` (never committed) or on whatever host runs the container.

| Variable | Required | Purpose |
|---|---|---|
| `GEMINI_API_KEY` | yes, to use Gemini | Provider credential (`lib/config.ts`). |
| `BETTER_AUTH_SECRET` | yes | Signs session tokens. Generate with `openssl rand -base64 32`. The app refuses to start auth without it. |
| `BETTER_AUTH_URL` | yes | The public URL the app is actually reachable at (`http://localhost:3000` locally). See `docs/deployment.md` for why this matters -- get it wrong and sign-in silently doesn't stick. |
| `LLM_PROVIDER` | no | Overrides provider auto-selection (`gemini`, `cli`, or `api`). |
| `GEMINI_MODEL` | no | Overrides the default Gemini model id. |
| `RESUME_OWNER_NAME` | no | Fallback name used in generated filenames until a user sets their display name. |

## Running locally

1. `npm install`
2. Create `.env.local` with at least `BETTER_AUTH_SECRET` and `BETTER_AUTH_URL=http://localhost:3000` (see the table above).
3. `npm run dev`
4. Open [http://localhost:3000](http://localhost:3000). Signup is invite-only -- see below to
   mint a code before you can create an account.

Other scripts: `npm run build` (production build), `npm run lint` (ESLint), `npm test`
(the vitest suite).

## Minting an invite code

Accounts are created by redeeming a single-use invite code; there is no open signup form.
Generate one against the local database:

```bash
node scripts/create-invite.ts [email]
```

The email argument is optional and only used to record who a code was issued for. The code
itself is printed to stdout -- give it to whoever you're inviting so they can use it on the
signup form.

## Deployment

See [`docs/deployment.md`](docs/deployment.md) for building the Docker image, deploying to
Railway or Fly.io, attaching a persistent volume, and the required backup procedure.
