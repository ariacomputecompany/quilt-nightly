# quilt-nightly

Experimental launchers for Quilt Nightly workflows.

## Production Default

`npx quilt-nightly --cc`, `npx quilt-nightly --codex`, `npx quilt-nightly --rlm`, `npx quilt-nightly --aegis`, and `npx quilt-nightly --amp` are supported.

It automatically uses:
- `QUILT_API_URL` from env, defaulting to `https://backend.quilt.sh`
- `QUILT_API_KEY` first, then `QUILT_TOKEN`, from env for auth
  - if neither is set, CLI prompts: `Enter your api key:`
- canonical OCI image references:
  - `backend.quilt.sh/nightly/cc:latest` for `--cc`
  - `backend.quilt.sh/nightly/codex:latest` for `--codex`
  - `backend.quilt.sh/nightly/rlm:latest` for `--rlm`
  - `prod-gui` for `--aegis`
  - `backend.quilt.sh/nightly/amp:latest` for `--amp`
  - optional overrides: `QUILT_NIGHTLY_CC_REF`, `QUILT_NIGHTLY_CODEX_REF`, `QUILT_NIGHTLY_RLM_REF`, `QUILT_NIGHTLY_AEGIS_REF`, `QUILT_NIGHTLY_AMP_REF`
  - for `cc`, `codex`, `rlm`, and `amp`, the launcher resolves the visible Nightly `latest` channel through `GET /api/nightly/profiles/<profile>/resolve?channel=latest&platform=linux/amd64` and pulls the pinned immutable `oci_reference`
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
npx quilt-nightly --cc --name my-session
npx quilt-nightly --rlm -- quilt-rlm doctor --json
npx quilt-nightly --rlm -- quilt-rlm run --script /workspace/app.py
npx quilt-nightly --rlm -m
npx quilt-nightly --aegis -- aegis usage
npx quilt-nightly --aegis -s 4
npx quilt-nightly --amp -- amp inspect system --server http://127.0.0.1:7001 --json
```

When `--name` is provided, `quilt-nightly` reuses that named container if it already exists.
It resumes/starts the existing container and reattaches instead of creating a new one.

`--rlm` opens a Bash-attached RLM image, syncs the current working directory into `/workspace` through the archive upload API, and injects a startup command into the shell. Without a passthrough command, it defaults to `quilt-rlm shell`; with `-m/--mesh`, it defaults to `quilt-rlm mesh`.

`--aegis` creates a `prod-gui` container, syncs the current working directory into `/workspace`, and defaults to `python3 /workspace/aegis/quilt_aegis.py shell --mode headful`, which bootstraps Aegis in the container, starts `aegis serve`, and then drops into a shell. `-s/--s/--swarm` creates multiple isolated `prod-gui` Aegis containers and attaches to the leader.

`--amp` opens an AMP-ready image, syncs the current working directory into `/workspace`, bootstraps a durable AMP config and SQLite store under `/workspace/.quilt/amp`, starts `amp serve` on `0.0.0.0:7001`, publishes that port through Quilt's native published-services ingress, persists the `QUILT_AMP_*` connection details onto the container environment for follow-up sessions, and then drops into a shell with `QUILT_AMP_HTTP_URL`, `QUILT_AMP_WS_URL`, `QUILT_AMP_SERVICE_ID`, `QUILT_AMP_NODE_ID`, and bootstrap agent credentials exported.

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
