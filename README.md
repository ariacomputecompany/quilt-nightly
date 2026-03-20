# quilt-nightly

Experimental launchers for Quilt Nightly workflows.

## Production Default

`npx quilt-nightly --cc` and `npx quilt-nightly --codex` are supported.

It automatically uses:
- `QUILT_API_URL` from env, defaulting to `https://backend.quilt.sh`
- `QUILT_API_KEY` first, then `QUILT_TOKEN`, from env for auth
  - if neither is set, CLI prompts: `Enter your api key:`
- canonical OCI image references:
  - `ghcr.io/ariacomputecompany/quilt-nightly-cc:latest` for `--cc`
  - `ghcr.io/ariacomputecompany/quilt-nightly-codex:latest` for `--codex`
  - optional overrides: `QUILT_NIGHTLY_CC_REF`, `QUILT_NIGHTLY_CODEX_REF`
- OCI image preload endpoint: `POST /api/oci/images/pull` (invoked before container create)
- optional OCI registry credentials for private registries:
  - `QUILT_NIGHTLY_REGISTRY_USERNAME`
  - `QUILT_NIGHTLY_REGISTRY_PASSWORD`

## Quick Start

```bash
npx quilt-nightly --cc
npx quilt-nightly --codex
npx quilt-nightly --cc --name my-session
```

When `--name` is provided, `quilt-nightly` reuses that named container if it already exists.
It resumes/starts the existing container and reattaches instead of creating a new one.

## Environment Loading

`quilt-nightly` auto-loads env values from current directory:

1. `.env`
2. `.env.local`

Use `.env.example` as template.

## Notes

- Authentication is not embedded in the image.
- Users authenticate inside the selected tool after TUI opens.
- Interactive terminal (TTY) is required.
