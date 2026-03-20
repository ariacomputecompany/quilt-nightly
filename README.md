# quilt-nightly

Experimental launchers for Quilt Nightly workflows.

## Production Default

`npx quilt-nightly --cc` and `npx quilt-nightly --codex` are supported.

It automatically uses:
- `QUILT_API_URL` from env, defaulting to `https://backend.quilt.sh`
- `QUILT_API_KEY` first, then `QUILT_TOKEN`, from env for auth
  - if neither is set, CLI prompts: `Enter your api key:`
- canonical profile Dockerfile URLs as OCI image source:
  - `https://raw.githubusercontent.com/ariacomputecompany/quilt-nightly/master/cc/Dockerfile` for `--cc`
  - `https://raw.githubusercontent.com/ariacomputecompany/quilt-nightly/master/codex/Dockerfile` for `--codex`
  - optional overrides: `QUILT_NIGHTLY_CC_REF`, `QUILT_NIGHTLY_CODEX_REF`

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
