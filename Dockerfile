# syntax=docker/dockerfile:1
#
# Multi-stage build for a single container carrying the Next.js server and the tectonic
# binary (see docs/deployment.md). --platform is pinned to linux/amd64 in both stages so a
# build on an ARM machine (e.g. Apple Silicon) still produces an x86 image -- Railway and
# Fly.io both default to amd64 hosts, and letting the platform float with the build host is
# exactly the mismatch that crashes a native module at container startup instead of at
# build time. If you deploy to an arm64 host, override both lines to linux/arm64.
#
# BuildKit's linter flags a hardcoded --platform constant (FromPlatformFlagConstDisallowed)
# because it suggests parameterizing via `ARG TARGETPLATFORM`/`--platform=$BUILDPLATFORM` for
# multi-arch builds. Deliberately not doing that here: the whole point of this pin is that
# the target platform must NOT float with however `docker build` happens to be invoked or
# with the host's own architecture -- that is exactly the failure mode this addresses (see
# above). A constant is the correct choice for a single-target deployment; the warning is
# expected and intentionally left as-is.
#
# better-sqlite3 13.x ships prebuilt native binaries for every platform/arch/libc combo
# *inside the npm package itself* (node_modules/better-sqlite3/prebuilds/*.node) and would
# pick the right one at require() time based on the running process -- see
# node_modules/better-sqlite3/lib/binding.js. That does NOT avoid the compiler dependency
# below, though: npm's own install machinery runs `node-gyp rebuild` unconditionally on
# install whenever a binding.gyp exists in a package (confirmed against this exact
# Dockerfile -- `npm ci` fails without python3/make/g++ in the builder, "Could not find any
# Python installation to use"), regardless of bundled prebuilds. So the builder stage still
# needs a full toolchain, and it compiles a binary matching *this build container's*
# platform -- which is exactly why --platform is pinned above rather than left to float with
# the host. The runtime stage below also re-copies the whole better-sqlite3 package
# explicitly, as a safety net against Next's output-file-tracing not following binding.js's
# dynamic, computed require(filename) when deciding what ships in the standalone folder.

FROM --platform=linux/amd64 node:22-bookworm-slim AS builder
WORKDIR /app

# python3/make/g++: node-gyp's build requirements for compiling better-sqlite3's native addon
# during `npm ci` (see the top-of-file note -- this is not optional even though the package
# also ships prebuilds). Kept to this stage only; the runtime image below never installs it.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# .npmrc must land before `npm ci`: it sets legacy-peer-deps=true, required because
# better-auth declares better-sqlite3 ^12 as an optional peer while this repo runs ^13.0.3
# (see the comment in .npmrc itself) -- a clean install fails on ERESOLVE without it.
COPY package.json package-lock.json .npmrc ./
RUN npm ci

COPY . .

# app/layout.tsx uses next/font/google, which fetches font files during `next build` --
# this stage must have network access, and must run before the network-isolated runtime
# stage below.
RUN npm run build

FROM --platform=linux/amd64 node:22-bookworm-slim AS runner
WORKDIR /app

# curl: fetches the tectonic release binary below and backs the HEALTHCHECK.
# ca-certificates: TLS for that curl call and for tectonic's own resource-bundle fetch
# during the warm-up step further down.
# sqlite3: the app itself only uses the better-sqlite3 Node binding, never this CLI -- it's
# installed purely so the backup procedure in docs/deployment.md (`sqlite3 ... VACUUM INTO
# ...`, run via `docker exec` against the live container) has something to call. Without it
# the documented backup command would fail with "not found" inside this image.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates sqlite3 \
    && rm -rf /var/lib/apt/lists/*

# tectonic 0.17.0, pinned to match the version verified locally (see docs/deployment.md).
# The musl build is a single statically-linked binary with no runtime shared-library
# dependencies, so it drops into a glibc (Debian) image cleanly -- no libc matching needed.
ARG TECTONIC_VERSION=0.17.0
RUN curl -fsSL -o /tmp/tectonic.tar.gz \
      "https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%40${TECTONIC_VERSION}/tectonic-${TECTONIC_VERSION}-x86_64-unknown-linux-musl.tar.gz" \
    && tar -xzf /tmp/tectonic.tar.gz -C /usr/local/bin tectonic \
    && chmod +x /usr/local/bin/tectonic \
    && rm /tmp/tectonic.tar.gz \
    && tectonic --version

# non-root runtime user -- the container should hold nothing worth escalating for beyond
# the app's own data, and the mounted volume below is chowned to this user, not root.
# uid/gid 10001 is outside both the host's typical user range and Debian's reserved system
# range (0-999), which is why --system is not used here -- it would only trigger a spurious
# "uid is greater than SYS_UID_MAX" warning for no behavioral benefit at a fixed, chosen id.
RUN groupadd --gid 10001 app \
    && useradd --uid 10001 --gid app --create-home --home-dir /home/app --shell /usr/sbin/nologin app

ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
# tectonic's cache (fonts, format files) lives under $HOME/.cache/tectonic by default;
# pinning HOME explicitly keeps that path stable across the warm-up RUN below and every
# later container start, regardless of how the base image sets up the app user's home.
ENV HOME=/home/app

# Next's standalone output (see next.config.ts) -- a self-contained server.js plus a
# node_modules pruned to only what's traced as actually required.
COPY --from=builder --chown=app:app /app/.next/standalone ./
COPY --from=builder --chown=app:app /app/.next/static ./.next/static
COPY --from=builder --chown=app:app /app/public ./public

# Defensive re-copy, see the top-of-file note: guarantees every platform prebuild ships
# regardless of whether output-file-tracing followed better-sqlite3's dynamic require.
COPY --from=builder --chown=app:app /app/node_modules/better-sqlite3 ./node_modules/better-sqlite3
COPY --from=builder --chown=app:app /app/scripts/create-invite.mjs ./scripts/create-invite.mjs

# DATA_DIR (lib/config.ts) resolves to <process.cwd()>/data, and process.cwd() for
# `node server.js` in this layout is /app -- so the volume mounts here with no code change.
# The image path is created and chowned for plain Docker bind mounts. Railway-managed
# volumes are attached outside the Dockerfile and mounted as root-owned; set RAILWAY_RUN_UID=0
# on Railway so the app can write tracker.db under /app/data.
#
# /home/app is (re-)chowned here too, as the very last root action before USER below, rather
# than immediately after useradd creates it: on an emulated build host (confirmed on this
# machine -- Docker Desktop's Rosetta layer, used to run this image's amd64 binaries under
# an arm64 host kernel) a root-owned .cache/rosetta directory gets lazily created under
# $HOME by the *first* emulated binary that runs after useradd, which is after that earlier
# point and would otherwise leave tectonic's warm-up below unable to create
# .cache/tectonic next to it. Chowning here, after every other root RUN step in this stage
# has had a chance to run, is what makes this correct regardless of which build host it runs
# on -- native x86 builders (Railway, Fly.io) never hit this path at all.
RUN mkdir -p /app/data \
    && chown -R app:app /app/data \
    && chown -R app:app /home/app

USER app

# Warms tectonic's resource bundle at build time rather than on a stranger's first request.
# tectonic pulls its (tens-of-megabytes) font/format bundle from the network on first use;
# compiling a throwaway document here bakes that cache into this image layer as the same
# user (app) that will own it at runtime, so a cold container's first real compile is local.
RUN printf '\\documentclass{article}\n\\begin{document}\nwarm\n\\end{document}\n' > /tmp/warm.tex \
    && tectonic --outdir /tmp /tmp/warm.tex \
    && rm -f /tmp/warm.tex /tmp/warm.pdf

EXPOSE 3000

# liveness only -- no dedicated health route exists (see docs/deployment.md); "/" always
# answers (redirect or page) as long as the Next server itself is up, which is everything a
# container orchestrator needs to decide whether to keep routing traffic here.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://localhost:3000/ -o /dev/null || exit 1

CMD ["node", "server.js"]
