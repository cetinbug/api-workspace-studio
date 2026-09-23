# Implementation plan

API Workspace Studio extends Bruno's existing Electron main process and React renderer; it does not replace the `.bru` editor or collection format. The repo uses npm workspaces (`package-lock.json`), so this iteration retains npm.

1. Add `.apiworkspace/manifest.json` for shareable logical secret definitions, reusable provider IDs, and environment bindings. Store mock values, local source choices and encrypted cache under Electron `userData`, keyed by workspace path.
2. Resolve logical secrets in the Electron request IPC before Bruno's existing variable interpolation. Inject only resolved variables, never provider configuration, into requests.
3. Add a workspace control surface to the title bar for provider simulation, cache controls, and Git mode/status. Keep secrets masked.
4. Add a Git sync service behind IPC. Local mode remains file-only. Remote mode queues a saved managed file for a debounced, scoped commit/push; fetch detects remote changes, while Pull is an explicit safe integration step.
5. Test domain invariants with unit tests and Git behavior with two temporary clones and a bare remote. Validate the existing app build and relevant tests.

This is a deliberately narrow vertical slice; real Azure Key Vault, secret writes, SaaS accounts and cloud-specific Git APIs are deferred.
