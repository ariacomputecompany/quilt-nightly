# quilt-nightly codex image

`codex` is the Quilt Nightly image for Codex workflows.

It includes:
- Node.js + npm
- global `codex` binary from `@openai/codex`
- common shell tooling (`bash`, `curl`, `git`, `ssh` client)

## Build

```bash
docker build -t ghcr.io/ariacomputecompany/quilt-nightly-codex:latest .
```

Pin a specific Codex version:

```bash
docker build \
  --build-arg CODEX_VERSION=0.115.0 \
  -t ghcr.io/ariacomputecompany/quilt-nightly-codex:0.115.0 \
  .
```

## Verify

```bash
docker run --rm ghcr.io/ariacomputecompany/quilt-nightly-codex:latest codex --version
```

## Security Model

- No auth credentials are baked into the image.
- Users authenticate at runtime inside the TUI.
- Base image updates and Codex version pinning should be handled in your release process.
