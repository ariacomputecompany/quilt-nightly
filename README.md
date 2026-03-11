# quilt-nightly

Experimental launchers for Quilt Nightly workflows.

## Production Default

`npx quilt-nightly --cc` is the primary command.

It automatically uses:
- `QUILT_API_URL` from env, defaulting to `https://backend.quilt.sh`
- `QUILT_API_KEY` first, then `QUILT_TOKEN`, from env for auth
- canonical raw `cc/Dockerfile` URL as the `oci=true` image target

## Quick Start

```bash
npx quilt-nightly --cc
```

## Environment Loading

`quilt-nightly` auto-loads env values from current directory:

1. `.env`
2. `.env.local`

Use `.env.example` as template.

## Notes

- Authentication is not embedded in the image.
- Users authenticate inside Claude Code after TUI opens.
- Interactive terminal (TTY) is required.
