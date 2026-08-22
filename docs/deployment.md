# Deployment

This app ships as one Docker container (`Dockerfile`) carrying the Next.js server and the
`tectonic` LaTeX binary, with a persistent volume for the SQLite database and generated
PDFs. It cannot run on Vercel or any other serverless platform -- `lib/compile.ts` shells
out to `tectonic`, which needs a real filesystem and a long-lived process.

The image is host-agnostic. Steps for both Railway and Fly.io are below; pick one.

## 1. Prerequisites

1. Docker installed locally if you want to build/test the image before pushing.
2. A Gemini API key (Google AI Studio) for `GEMINI_API_KEY`.
3. A generated auth secret: run `openssl rand -base64 32` and save the output for
   `BETTER_AUTH_SECRET`.
4. A Railway or Fly.io account with its CLI installed (`railway` or `flyctl`).

## 2. Environment variables

Set these on the host platform (Railway "Variables" tab, or `fly secrets set`). Never put
real values in a committed file.

| Variable | Required | Purpose |
|---|---|---|
| `GEMINI_API_KEY` | yes | Gemini provider credential (`lib/config.ts`). Without it the app falls back to the local CLI provider, which does not exist in the container. |
| `BETTER_AUTH_SECRET` | yes | Signs session tokens (`lib/auth.ts`). The app refuses to start auth without it rather than falling back to an insecure default. |
| `BETTER_AUTH_URL` | yes | The real public URL of the deployment (e.g. `https://resume.example.com`). See section 6 -- getting this wrong breaks sign-in silently. |
| `LLM_PROVIDER` | no | Overrides provider auto-selection (`gemini`, `cli`, or `api`). Leave unset; the app selects `gemini` automatically when `GEMINI_API_KEY` is present. |
| `GEMINI_MODEL` | no | Overrides the default Gemini model id (`lib/config.ts`). |
| `RESUME_OWNER_NAME` | no | Fallback name used in generated filenames until the per-user display name (settings page) supersedes it. |

## 3. Build and deploy to Fly.io

1. Install `flyctl` and run `fly auth login`.
2. From the repo root, run `fly launch --no-deploy` and answer the prompts (app name,
   region). Decline Fly's offer to detect and generate its own Dockerfile-equivalent
   config -- this repo already has one. This creates `fly.toml`; do not commit it to this
   repo without checking it does not conflict with the file-ownership boundaries of any
   in-flight work.
3. Create the persistent volume in the same region as the app:
   `fly volumes create resume_tailor_data --region <your-region> --size 3`.
4. Add a `[mounts]` block to the generated `fly.toml` so the volume lands at the data
   directory the app expects (`lib/config.ts`'s `DATA_DIR` resolves to `<cwd>/data`, and the
   container's working directory is `/app`):
   ```
   [mounts]
     source = "resume_tailor_data"
     destination = "/app/data"
   ```
5. Set secrets: `fly secrets set GEMINI_API_KEY=... BETTER_AUTH_SECRET=... BETTER_AUTH_URL=https://<your-app>.fly.dev`.
6. Deploy: `fly deploy`. Fly builds the `Dockerfile` remotely by default, so a local Docker
   install is not required for this step.
7. Confirm the app is up: `fly status`, then open the printed URL.

## 4. Build and deploy to Railway

1. Install the Railway CLI and run `railway login`.
2. From the repo root, run `railway init` (or link an existing project with
   `railway link`), then `railway up`. Railway detects the `Dockerfile` and builds from it
   automatically -- no separate buildpack configuration is needed.
3. In the Railway dashboard, open the service, go to its **Volumes** tab, and attach a new
   volume mounted at `/app/data`. This is a dashboard action; there is no file in this repo
   to edit for it.
4. In the service's **Variables** tab, add `GEMINI_API_KEY`, `BETTER_AUTH_SECRET`, and
   `BETTER_AUTH_URL` (use the Railway-generated public domain, or your custom domain once
   step 5 below is done). Redeploy after adding variables so the running container picks
   them up.
5. Confirm the healthcheck (built into the `Dockerfile`) is passing in the deployment logs,
   then open the service's public URL.

## 5. Custom domain

1. In the platform's dashboard (Fly: `fly certs add <domain>`; Railway: service **Settings
   → Domains → Custom Domain**), add your domain.
2. For a subdomain (e.g. `resume.example.com`), add a `CNAME` record at your DNS provider
   pointing that subdomain at the hostname the platform gives you.
3. For an apex/root domain (e.g. `example.com`), `CNAME` is not valid at the zone apex per
   the DNS spec. Use whichever mechanism your DNS provider offers for this case: an `ALIAS`
   or `ANAME` record (Cloudflare, DNSimple, others), or the platform's own apex-specific
   instructions (Fly and Railway both document this). Point it at the same hostname the
   platform gave you in step 1.
4. Wait for the certificate to issue (both platforms provision TLS automatically once DNS
   resolves), then update `BETTER_AUTH_URL` to the final `https://` domain and redeploy --
   see section 6 for why this step is not optional.

## 6. Why `BETTER_AUTH_URL` must be the real public URL

`better-auth` signs and validates session cookies against the `baseURL` it was configured
with (`lib/auth.ts`). If `BETTER_AUTH_URL` is left unset, missing, or pointed at the wrong
host (e.g. the platform's internal hostname, `http://localhost:3000`, or a domain that no
longer matches after you add a custom one), sign-in and sign-up requests still return a
success response -- but the session cookie better-auth issues does not match the URL the
browser is actually on, so the browser either rejects it or the next request cannot
validate it. The symptom is exactly "login appears to work, then the user is immediately
signed out again" with no error in the UI. Whenever the public URL changes -- first deploy,
adding a custom domain, moving platforms -- update `BETTER_AUTH_URL` and redeploy before
testing sign-in.

## 7. Backups

The database (`data/tracker.db`) runs in WAL mode (`lib/db.ts`). This changes what "safe to
copy" means and is the most important thing in this document.

### 7.1 Why a plain `cp` is unsafe

In WAL mode, recently committed writes can still live only in the `-wal` file next to the
main database file, not yet folded ("checkpointed") into `tracker.db` itself. A plain
`cp data/tracker.db backup.db` copies only the main file and silently produces a **torn,
stale** backup -- it can be missing committed data, including entire migrations, with no
error or warning at copy time. This was demonstrated directly on the development machine
for this project: a main-file-only copy was missing an entire migration that had already
been applied and committed. Do not use `cp`, `scp`, `rsync` of the `.db` file alone, or any
tool that copies it as a single file, for backups.

### 7.2 The correct backup command

The `sqlite3` CLI is installed in the runtime image specifically for this (the app itself
only uses the `better-sqlite3` Node binding, never this CLI). Run it inside the running
container so it operates on the live database and its volume directly -- on Fly.io,
`fly ssh console`; on Railway, the dashboard's shell/exec feature; with plain Docker,
`docker exec -it <container> sh`. Then:

```
sqlite3 data/tracker.db "VACUUM INTO 'data/backups/tracker-$(date +%Y%m%d-%H%M%S).db'"
```

`VACUUM INTO` opens a read transaction against the live database (including whatever is
currently in the `-wal` file), writes a fully consistent, compacted snapshot to the target
path, and does not block or interfere with the running app. This is the only backup method
to use. Schedule it (cron, a platform's scheduled job feature, or a manual habit before any
risky operation) and copy the resulting file off the volume to separate storage -- a backup
that lives on the same volume it is protecting does not survive that volume being lost.

### 7.3 Volume snapshots

If your host platform offers block-level volume snapshots as an additional safety net, a
snapshot is only a valid backup if it captures `tracker.db`, `tracker.db-wal`, and
`tracker.db-shm` at the exact same instant (an atomic point-in-time snapshot of the whole
volume, not a file-by-file copy). A snapshot that captures those three files at slightly
different moments has the identical torn-copy problem as a plain `cp`. Prefer the
`VACUUM INTO` method above as the primary backup; treat volume snapshots as a secondary,
coarser safety net.

### 7.4 Recovery

There are no down migrations (`lib/migrate.ts`: migrations are forward-only by design).
Recovery from a bad deploy, a bad migration, or data loss is **restore from the most recent
`VACUUM INTO` backup, full stop** -- replace the volume's `tracker.db` (and remove any
stale `-wal`/`-shm` files alongside it) with the backup file and restart the container.
There is no in-place rollback path; do not attempt to hand-edit the schema back to a
previous version.
