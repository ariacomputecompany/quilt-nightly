# quilt-nightly aegis image

`aegis` is the source definition for the prebuilt Quilt Nightly image used by Linux Aegis workflows.

It is built from the `linux` branch of `ariacomputecompany/aegis` and includes:
- installed `aegis` CLI
- installed Linux native runtime and host library
- built Aegis web dashboard assets
- Linux display stack tooling (`Xvfb`, `x11vnc`, `xdg-open`)
- `quilt-aegis` helper CLI

## Build

```bash
docker build -t ghcr.io/ariacomputecompany/quilt-nightly-aegis:latest .
```

Pin a different upstream ref:

```bash
docker build \
  --build-arg AEGIS_GIT_REF=linux \
  -t ghcr.io/ariacomputecompany/quilt-nightly-aegis:linux \
  .
```

## Verify

```bash
docker run --rm ghcr.io/ariacomputecompany/quilt-nightly-aegis:latest quilt-aegis doctor --json
docker run --rm ghcr.io/ariacomputecompany/quilt-nightly-aegis:latest aegis usage
```

## Helper Commands

```bash
quilt-aegis doctor
quilt-aegis shell
quilt-aegis serve --mode headful --addr 0.0.0.0:7878
quilt-aegis examples
```

Typical launcher flow:

```bash
npx quilt-nightly --aegis
npx quilt-nightly --aegis -- aegis usage
npx quilt-nightly --aegis -s 4
```

`quilt-aegis shell` starts `aegis serve` in the background by default, waits for `/healthz`, and then drops into a shell with the runtime ready.
