# agent-hub, vendored

This directory is [`ambersecurityinc/agent-hub`](https://github.com/ambersecurityinc/agent-hub),
vendored into the agent-fleet monorepo so that everything is in one place. It is
**upstream code we intend to contribute back to**, not a fork we intend to keep.

| | |
|---|---|
| Upstream | `https://github.com/ambersecurityinc/agent-hub` |
| Vendored from | `cac1f02` — *Fix the two things that broke the first real session on a fresh box* (upstream `main`) |
| Vendored on | 2026-08-17 |

## How to keep this contributable

The point of writing the base commit down is that a future PR has to be a clean
diff against upstream, not a re-derivation. To produce one:

```sh
git clone https://github.com/ambersecurityinc/agent-hub /tmp/upstream
cd /tmp/upstream && git checkout cac1f02
diff -ru --exclude=node_modules --exclude=.git /tmp/upstream . 
```

Two rules that keep that diff small and reviewable:

1. **No fleet code goes in this directory.** Everything agent-fleet needs from
   agent-hub, it gets over the loopback HTTP API from `../src/host/` — see
   [`../docs/sidecar.md`](../docs/sidecar.md). That boundary is not an accident
   of the old two-repo layout; it is what keeps this tree mergeable upstream.
   If fleet concerns start leaking in here, the upstream contribution stops
   being possible and this becomes a fork by default.
2. **Every change here is a bug fix or an improvement that stands on its own
   merits to an agent-hub user** who has never heard of agent-fleet. If a change
   only makes sense because of the fleet, it belongs in `../src/`.

## What has diverged from `cac1f02`

### De-wrap the pane before reading the Remote Control URL

`extractRcUrl` matched raw `capture-pane` output with no de-wrapping, unlike the
login flow, which has `dewrapPane` for exactly this failure. A pane is a
fixed-width grid, and the RC URL is one long token. At 80 columns it lands on a
line of its own and nothing goes wrong — which is why this was never noticed.
Measured against the verbatim CLI 2.1.233 capture in
[`../docs/design.md`](../docs/design.md) §10, and confirmed on a real 70-column
tmux pane:

| pane width | before |
|---|---|
| 80 | correct |
| 100 | `https://claude.ai/code/session_016zf` — truncated, well-formed, and dead |
| 70 | `null` — the `https://` prefix straddles the break, so the session is reported online with no URL to reach it by |

Three parts:

- `dewrapPane` moved from `src/core/login.js` to `src/core/pane.js`. Importing
  it from `login.js` into `claude.js` would be a cycle (`login.js` already
  imports `sleep` from `claude.js`), and with `export const sleep` that is a TDZ
  error rather than a warning.
- `extractRcUrl` de-wraps first, and matches an explicit URL character set
  instead of `\S+`. De-wrapping can only ever join *more* text onto the end of
  the URL, and the pane is a TUI, so what follows is as likely to be a box
  border as a path segment.
- `verifyRemoteControl` tests its marker against de-wrapped text too — one of
  the markers *is* the URL, and a pane narrow enough to wrap it splits
  `claude.ai/code` across two rows and matches nothing.

No behaviour change at 80 columns, which is the only width the existing captures
cover. This one is ready to go upstream as-is.

## Vendoring deviations

- **`.github/workflows/ci.yml` is inert here.** GitHub only runs workflows from
  the repository root, so this file does nothing in the monorepo — the root
  `.github/workflows/ci.yml` runs agent-hub's tests, typecheck and installer
  syntax check instead. It is kept rather than deleted so the upstream diff
  stays clean. **Editing it will not change CI.**
- **`node_modules` is not vendored.** The root `package.json` carries the same
  two devDependencies (`typescript`, `@types/node`), and Node resolves them up
  the tree, so `npm install` at the root is enough for both packages.
- **`package.json` is kept** so this directory stays a runnable package on its
  own — `node agent-hub/src/index.js` and `node agent-hub/bin/agent-hub` both
  work from the monorepo root.
