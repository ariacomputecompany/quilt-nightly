# quilt-nightly

Experimental launchers for Quilt Nightly workflows.

## Production Default

`npx quilt-nightly --cc` and `npx quilt-nightly --codex` are supported.

It automatically uses:
- `QUILT_API_URL` from env, defaulting to `https://backend.quilt.sh`
- `QUILT_API_KEY` first, then `QUILT_TOKEN`, from env for auth
- canonical raw profile Dockerfile URL as the `oci=true` image target:
  - `cc/Dockerfile` for `--cc`
  - `codex/Dockerfile` for `--codex`
- tool binary path auto-resolved in-container via `/api/containers/:id/exec`
  (optional overrides: `QUILT_NIGHTLY_CLAUDE_PATH`, `QUILT_NIGHTLY_CODEX_PATH`)

## Quick Start

```bash
npx quilt-nightly --cc
npx quilt-nightly --codex
```

## Environment Loading

`quilt-nightly` auto-loads env values from current directory:

1. `.env`
2. `.env.local`

Use `.env.example` as template.

## Notes

- Authentication is not embedded in the image.
- Users authenticate inside the selected tool after TUI opens.
- Interactive terminal (TTY) is required.
