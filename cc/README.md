# quilt-nightly cc image

`cc` is the Quilt Nightly image for Claude Code workflows.

It includes:
- Node.js + npm
- global `claude` binary from `@anthropic-ai/claude-code`
- common shell tooling (`bash`, `curl`, `git`, `ssh` client)

## Build

```bash
docker build -t ghcr.io/ariacomputecompany/quilt-nightly-cc:latest .
```

Pin a specific Claude Code version:

```bash
docker build \
  --build-arg CLAUDE_CODE_VERSION=2.1.72 \
  -t ghcr.io/ariacomputecompany/quilt-nightly-cc:2.1.72 \
  .
```

## Verify

```bash
docker run --rm ghcr.io/ariacomputecompany/quilt-nightly-cc:latest claude --version
```

## Security Model

- No auth credentials are baked into the image.
- Users authenticate at runtime inside the TUI.
- Base image updates and Claude Code version pinning should be handled in your release process.
