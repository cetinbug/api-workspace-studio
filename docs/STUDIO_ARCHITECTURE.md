# API Workspace Studio: current vertical slice

This fork retains Bruno's MIT license, request editor, `.bru` files, collections,
environment selector and HTTP request executor. The additional workspace features
are opt-in. The package manager is npm (`package-lock.json`); do not run `npm run
setup` merely to build because that script deletes `node_modules` first.

## Run locally

On Windows, use Node 22.12 (see `.nvmrc`) and Git, then run `npm ci` and build the local `@usebruno/*`
packages in the order shown by `scripts/setup.js` (without re-running its cleanup).
Bundle the sandbox with `npm run sandbox:bundle-libraries --workspace=packages/bruno-js`.
Run `npm run dev`. Open or clone a Bruno workspace using the existing UI. Open an
environment in the collection, then click **Studio** in the title bar and initialize
the workspace. Initialization creates `.apiworkspace/manifest.json`; it does not
contact Azure or write any secret value to Git.

The Studio environment name must match the active Bruno collection environment
name. Add a logical secret, map it to a provider/reference and a request variable,
then enter a Mock value. Use `{{variableName}}` in a Bruno request. The main process
resolves it immediately before the HTTP request (including collection-runner and
GraphQL schema requests); Studio status IPC returns source status, not the value.
For Studio-bound HTTP secrets, the outgoing request uses the real value while
request diagnostics sent back to the renderer mask known secret values.

## Shared manifest

`.apiworkspace/manifest.json` is versioned with the workspace. Example:

```json
{
  "version": 1,
  "providers": { "team-mock": { "type": "mock", "name": "Team Mock" } },
  "secrets": { "service.api-key": { "name": "Service API Key" } },
  "environments": {
    "Test": {
      "defaultProvider": "team-mock",
      "variables": { "baseUrl": "https://example.test" },
      "bindings": { "apiKey": "service.api-key" },
      "secrets": { "service.api-key": { "reference": "test-service-key" } }
    }
  }
}
```

One provider ID may be reused by several environments. A secret mapping may
override its environment's default with a `provider` field. Requests know only
the logical variable. Logical IDs are canonical across environments. The Studio
panel searches `.bru` files for usage and warns when different logical IDs map
to the same provider/reference pair. The shared manifest never holds values.

## Per-user data and secret behavior

Electron `userData/api-workspace-studio/<SHA-256-of-workspace-path>/` holds:

| File | Contents |
| --- | --- |
| `local.json` | Source choices, non-secret local variables and mock failure settings |
| `mock-source.json` | Plaintext **mock-only** values, outside the Git workspace |
| `cache.enc.json` | Optional encrypted offline cache and encrypted local secret overrides |
| `sync.json` | Local/Remote Sync mode |

Mock values are deliberately local test fixtures, not a production secret store.
Do not enter real credentials into the Mock provider. Future Azure support can
implement the provider interface without changing requests or the resolver.

The cache is disabled by default and locked after each application restart.
Enabling it requires a user password of at least 12 characters. A random 256-bit
salt and scrypt derive an in-memory key; AES-256-GCM encrypts/authenticates the
payload with a fresh random nonce each write. The password and derived key are
not persisted. Entries expire after seven days by default. A successful remote
read is cached only when enabled and unlocked. Network, timeout and unavailable
errors may use a fresh entry; 401, 403 and 404 never do. Wrong password,
corruption and expiry fail closed. Lock, reset and password change are supported
by the service (the UI currently exposes lock and reset).

A local secret override requires the unlocked encrypted cache. The per-variable
source choice selects either local override or provider; neither source writes
into the other. Ordinary local values may be plaintext in `local.json`, so only
put non-sensitive values there. Remote Git activity cannot overwrite these
user-specific files because they are outside the Git repository.

## Git behavior

Local mode: Bruno saves to the filesystem; the Studio sync service does not
fetch, commit or push. Remote Sync: saving a managed request, environment,
folder, collection or Studio manifest queues its explicit path. A 1.5-second
debounce groups nearby saves. Before committing, the service fetches the current
origin branch, checks for remote changes, scans queued files for obvious raw
credentials, and stages only queued paths with `git add -- <paths>`. It never
uses `git add .`, a force push, or destructive reset. A remote change or dirty
staged state stops automatic push; the local files remain intact. Push failures
retain local commits for retry. The panel's **Check remote**, **Pull changes**
and **Save & Sync** buttons expose these operations. Save & Sync also picks up
eligible files previously saved in Local mode, without staging unrelated files.
Background fetch checks
once per minute in Remote Sync mode; it never merges automatically. Pull accepts
only clean fast-forwards and refreshes the Bruno workspace UI. Divergence and
dirty worktrees are surfaced, not overwritten. Existing Git CLI credentials
are used; there is no GitHub- or Bitbucket-specific API dependency.

The save-time scanner is a safeguard, not a full secret-detection engine. Review
files before sharing and never enter real credentials into raw request fields.
The current UI does not include field-level conflict resolution. It intentionally
stops at conflicts so Git tooling can resolve them without data loss.

For an IPC/HTTP smoke check, run `npm run dev:web` in one terminal and
`node tests/studio/desktop-smoke.js` in another. It creates and removes an
isolated temporary profile/workspace, sends a local HTTP request using a Mock
secret, and checks encrypted fallback and 403 behavior.

## Deferred

Real Azure Key Vault reads/writes, non-Mock providers, automatic workspace
environment creation, native conflict editor, full WebSocket/gRPC secret
integration and thorough existing-Bruno
secret migration are future work. The old product-requirements draft describes
an earlier single-vault design and is not the implementation contract.
