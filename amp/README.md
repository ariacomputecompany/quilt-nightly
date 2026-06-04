# quilt-nightly amp image

`amp/` is the standalone Quilt Nightly case study for the Agent Messaging Protocol daemon.

It includes:
- a prebuilt Linux `amp` binary produced from [`saint0x/amp`](https://github.com/saint0x/amp)
- the `quilt-amp` helper CLI
- common shell tooling (`bash`, `curl`, `git`)

`quilt-nightly --amp` uses this image, syncs the current working directory into `/workspace`, bootstraps a durable AMP config and SQLite store under `/workspace/.quilt/amp`, starts the daemon on `0.0.0.0:7001`, publishes that port through Quilt ingress, and then drops into a shell with the connection details exported.

## Build

```bash
docker build -t ghcr.io/ariacomputecompany/quilt-nightly-amp:latest .
```

The image copies [`amp/bin/amp-linux-x86_64-musl`](/Users/deepsaint/Desktop/quilt-nightly/amp/bin/amp-linux-x86_64-musl), which is the Linux binary baked into this case study.

## Verify

```bash
docker run --rm ghcr.io/ariacomputecompany/quilt-nightly-amp:latest quilt-amp doctor --json
docker run --rm ghcr.io/ariacomputecompany/quilt-nightly-amp:latest amp --version
```

## Helper Commands

```bash
quilt-amp doctor --json
quilt-amp bootstrap --json
quilt-amp launch --addr 0.0.0.0:7001 --json
quilt-amp shell
quilt-amp examples
```

The helper persists runtime state under `/workspace/.quilt/amp/`:
- `config.json`
- `credentials.json`
- `amp.db`
- `logs/`
- `runtime/`

Typical launcher flow:

```bash
npx quilt-nightly --amp
npx quilt-nightly --amp -- amp inspect system --server http://127.0.0.1:7001 --json
```

The launcher exports:
- `QUILT_AMP_HTTP_URL`
- `QUILT_AMP_WS_URL`
- `QUILT_AMP_SERVICE_ID`
- `QUILT_AMP_LOCAL_HTTP_URL`
- `QUILT_AMP_LOCAL_WS_URL`
- `QUILT_AMP_NODE_ID`
- `QUILT_AMP_AGENT_ID`
- `QUILT_AMP_AGENT_CANONICAL_ID`
- `QUILT_AMP_AGENT_TOKEN`
