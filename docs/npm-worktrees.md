# npm install in Worktrees — GCSFuse Workaround

**Status:** MANDATORY when running `npm install` in `/persistent/repos/` worktrees

---

## Problem

`/persistent` is mounted via GCSFuse. Running `npm install` directly inside a
worktree on this mount fails with two distinct errors:

| Error | Cause |
|-------|-------|
| `EMFILE` | GCSFuse has a low concurrent-rename limit; npm's parallel write pattern exceeds it |
| `EPERM` on chmod | `/persistent/npm-cache` may be root-owned; agents cannot `chmod` files there |

Both errors will cause `npm install` to fail or produce a broken `node_modules`.

---

## Fix: Install to /tmp, symlink into worktree

Install packages to a `/tmp` directory, then symlink `node_modules` back into
the worktree. This keeps all fs operations off GCSFuse while the worktree
itself stays on `/persistent`.

### Root package

```bash
WTDIR="/persistent/repos/ClaudeSwarm_PRIVATE-<your-agent-id>"
WT_SLUG="$(basename "$WTDIR")"

npm install \
  --prefix "/tmp/nm-${WT_SLUG}" \
  --cache  "/tmp/npm-cache-${WT_SLUG}"

ln -sf "/tmp/nm-${WT_SLUG}/node_modules" "${WTDIR}/node_modules"
```

### UI sub-package (`ui/`)

```bash
npm install \
  --prefix "/tmp/nm-${WT_SLUG}-ui" \
  --cache  "/tmp/npm-cache-${WT_SLUG}"

ln -sf "/tmp/nm-${WT_SLUG}-ui/node_modules" "${WTDIR}/ui/node_modules"
```

### One-liner (copy-paste template)

```bash
WTDIR="/persistent/repos/ClaudeSwarm_PRIVATE-$(echo $AGENT_ID | cut -c1-8)"
WT_SLUG="$(basename "$WTDIR")"
npm install --prefix "/tmp/nm-${WT_SLUG}"    --cache "/tmp/npm-cache-${WT_SLUG}" && \
npm install --prefix "/tmp/nm-${WT_SLUG}-ui" --cache "/tmp/npm-cache-${WT_SLUG}" --prefix "${WTDIR}/ui" && \
ln -sf "/tmp/nm-${WT_SLUG}/node_modules"     "${WTDIR}/node_modules" && \
ln -sf "/tmp/nm-${WT_SLUG}-ui/node_modules"  "${WTDIR}/ui/node_modules"
```

---

## Why not pnpm?

`pnpm` is configured to use `/persistent/pnpm-store` (a persistent content-
addressable store). New packages still require a write phase to GCSFuse which
can hit the same EMFILE limit. Use the npm `/tmp` pattern until a canonical
pre-installed `node_modules` is available at container start (see GitHub issue
"feat: pre-install canonical node_modules at container startup for worktrees").

---

## Background: entrypoint.sh changes (fix/ad4a0478-npm-persistent-install)

`entrypoint.sh` was updated to:
1. `chown -R agent:agent /persistent/npm-cache` — ensures agents own the cache dir
2. `npm config set cache /tmp/npm-cache --global` — global npm cache redirected
   to `/tmp` so even accidental direct installs don't hit EPERM

These changes reduce the blast radius but do **not** eliminate the EMFILE
problem for direct installs into `/persistent`. Always use the `/tmp` prefix
pattern described above.
