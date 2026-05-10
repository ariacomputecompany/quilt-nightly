# quilt-nightly

Experimental launchers for Quilt Nightly workflows.

## Production Default

`npx quilt-nightly --cc`, `npx quilt-nightly --codex`, `npx quilt-nightly --rlm`, and `npx quilt-nightly --aegis` are supported.

It automatically uses:
- `QUILT_API_URL` from env, defaulting to `https://backend.quilt.sh`
- `QUILT_API_KEY` first, then `QUILT_TOKEN`, from env for auth
  - if neither is set, CLI prompts: `Enter your api key:`
- canonical OCI image references:
  - `ghcr.io/ariacomputecompany/quilt-nightly-cc:latest` for `--cc`
  - `ghcr.io/ariacomputecompany/quilt-nightly-codex:latest` for `--codex`
  - `ghcr.io/ariacomputecompany/quilt-nightly-rlm:latest` for `--rlm`
  - `ghcr.io/ariacomputecompany/quilt-nightly-aegis:latest` for `--aegis`
  - optional overrides: `QUILT_NIGHTLY_CC_REF`, `QUILT_NIGHTLY_CODEX_REF`, `QUILT_NIGHTLY_RLM_REF`, `QUILT_NIGHTLY_AEGIS_REF`
- OCI image preload endpoint: `POST /api/oci/images/pull` (invoked before container create)
- optional OCI registry credentials for private registries:
  - `QUILT_NIGHTLY_REGISTRY_USERNAME`
  - `QUILT_NIGHTLY_REGISTRY_PASSWORD`

## Quick Start

```bash
npx quilt-nightly --cc
npx quilt-nightly --codex
npx quilt-nightly --rlm
npx quilt-nightly --aegis
npx quilt-nightly --rlm -- quilt-rlm doctor --json
npx quilt-nightly --rlm -- quilt-rlm run --script /workspace/app.py
npx quilt-nightly --rlm -m
npx quilt-nightly --aegis -- aegis usage
npx quilt-nightly --aegis -s 4
```

`--rlm` opens a Bash-attached RLM image, syncs the current working directory into `/workspace` through the archive upload API, and injects a startup command into the shell. Without a passthrough command, it defaults to `quilt-rlm shell`; with `-m/--mesh`, it defaults to `quilt-rlm mesh`.

`--aegis` opens a Bash-attached Aegis image, syncs the current working directory into `/workspace`, and defaults to `quilt-aegis shell`, which starts `aegis serve` in the background before dropping into a shell. `-s/--s/--swarm` creates multiple isolated Aegis containers and attaches to the leader.

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
- The `aegis/` subdirectory contains the standalone image source and helper for Linux Aegis workflows.
