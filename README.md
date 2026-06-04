# quilt-nightly

Experimental launchers for Quilt Nightly workflows.

## Production Default

`npx quilt-nightly --cc`, `npx quilt-nightly --codex`, `npx quilt-nightly --rlm`, `npx quilt-nightly --aegis`, and `npx quilt-nightly --amp` are supported.

It automatically uses:
- `QUILT_API_URL` from env, defaulting to `https://backend.quilt.sh`
- `QUILT_API_KEY` first, then `QUILT_TOKEN`, from env for auth
  - if neither is set, CLI prompts: `Enter your api key:`
- canonical OCI image references:
  - `ghcr.io/ariacomputecompany/quilt-nightly-cc:latest` for `--cc`
  - `ghcr.io/ariacomputecompany/quilt-nightly-codex:latest` for `--codex`
  - `ghcr.io/ariacomputecompany/quilt-nightly-rlm:latest` for `--rlm`
  - `prod-gui` for `--aegis`
  - `ghcr.io/ariacomputecompany/quilt-nightly-amp:latest` for `--amp`
  - optional overrides: `QUILT_NIGHTLY_CC_REF`, `QUILT_NIGHTLY_CODEX_REF`, `QUILT_NIGHTLY_RLM_REF`, `QUILT_NIGHTLY_AEGIS_REF`, `QUILT_NIGHTLY_AMP_REF`
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
npx quilt-nightly --amp
npx quilt-nightly --rlm -- quilt-rlm doctor --json
npx quilt-nightly --rlm -- quilt-rlm run --script /workspace/app.py
npx quilt-nightly --rlm -m
npx quilt-nightly --aegis -- aegis usage
npx quilt-nightly --aegis -s 4
npx quilt-nightly --amp -- amp inspect system --server http://127.0.0.1:7001 --json
```

`--rlm` opens a Bash-attached RLM image, syncs the current working directory into `/workspace` through the archive upload API, and injects a startup command into the shell. Without a passthrough command, it defaults to `quilt-rlm shell`; with `-m/--mesh`, it defaults to `quilt-rlm mesh`.

`--aegis` creates a `prod-gui` container, syncs the current working directory into `/workspace`, and defaults to `python3 /workspace/aegis/quilt_aegis.py shell --mode headful`, which bootstraps Aegis in the container, starts `aegis serve`, and then drops into a shell. `-s/--s/--swarm` creates multiple isolated `prod-gui` Aegis containers and attaches to the leader.

`--amp` opens an AMP-ready image, syncs the current working directory into `/workspace`, bootstraps a durable AMP config and SQLite store under `/workspace/.quilt/amp`, starts `amp serve` on `0.0.0.0:7001`, publishes that port through Quilt's native published-services ingress, and then drops into a shell with `QUILT_AMP_HTTP_URL`, `QUILT_AMP_WS_URL`, `QUILT_AMP_SERVICE_ID`, `QUILT_AMP_NODE_ID`, and bootstrap agent credentials exported.

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
- The `amp/` subdirectory contains the standalone image source and helper for AMP daemon workflows.
