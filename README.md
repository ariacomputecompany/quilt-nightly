# quilt-nightly

Experimental launchers for Quilt Nightly workflows.

## Production Default

`npx quilt-nightly --cc`, `npx quilt-nightly --codex`, and `npx quilt-nightly --rlm` are supported.

It automatically uses:
- `QUILT_API_URL` from env, defaulting to `https://backend.quilt.sh`
- `QUILT_API_KEY` first, then `QUILT_TOKEN`, from env for auth
  - if neither is set, CLI prompts: `Enter your api key:`
- canonical OCI image references:
  - `ghcr.io/ariacomputecompany/quilt-nightly-cc:latest` for `--cc`
  - `ghcr.io/ariacomputecompany/quilt-nightly-codex:latest` for `--codex`
  - `ghcr.io/ariacomputecompany/quilt-nightly-rlm:latest` for `--rlm`
  - optional overrides: `QUILT_NIGHTLY_CC_REF`, `QUILT_NIGHTLY_CODEX_REF`, `QUILT_NIGHTLY_RLM_REF`
- OCI image preload endpoint: `POST /api/oci/images/pull` (invoked before container create)
- optional OCI registry credentials for private registries:
  - `QUILT_NIGHTLY_REGISTRY_USERNAME`
  - `QUILT_NIGHTLY_REGISTRY_PASSWORD`

## Quick Start

```bash
npx quilt-nightly --cc
npx quilt-nightly --codex
npx quilt-nightly --rlm
npx quilt-nightly --rlm -- quilt-rlm doctor --json
npx quilt-nightly --rlm -- quilt-rlm run --script /workspace/app.py
npx quilt-nightly --rlm -m
```

`--rlm` opens a Bash-attached RLM image, syncs the current working directory into `/workspace` through the archive upload API, and injects a startup command into the shell. Without a passthrough command, it defaults to `quilt-rlm shell`; with `-m/--mesh`, it defaults to `quilt-rlm mesh`.

## Environment Loading

`quilt-nightly` auto-loads env values from current directory:

1. `.env`
2. `.env.local`

Use `.env.example` as template.

## Notes

- Authentication is not embedded in the image.
- Users authenticate inside the selected tool after TUI opens.
- Interactive terminal (TTY) is required.
- The `rlm/` subdirectory contains the standalone image source and helper for RLM workflows.
