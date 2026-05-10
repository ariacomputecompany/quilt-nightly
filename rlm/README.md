# quilt-nightly rlm image

`rlm` is the source definition for the prebuilt Quilt Nightly image used by Recursive Language Model workflows.

It includes:
- Python 3.12
- `uv`
- upstream `rlms` from PyPI
- `quilt-rlm` helper CLI
- common shell tooling (`bash`, `curl`, `git`, `ssh` client)

## Build

```bash
docker build -t ghcr.io/ariacomputecompany/quilt-nightly-rlm:latest .
```

## Verify

```bash
docker run --rm ghcr.io/ariacomputecompany/quilt-nightly-rlm:latest quilt-rlm doctor --json
docker run --rm ghcr.io/ariacomputecompany/quilt-nightly-rlm:latest python -c "import rlm; print(rlm.__file__)"
```

## Helper Commands

```bash
quilt-rlm doctor
quilt-rlm shell
quilt-rlm run --script path/to/script.py
quilt-rlm run --prompt-file prompt.txt --context-file corpus.txt --backend openai --model gpt-5-mini
quilt-rlm examples ls
quilt-rlm trajectories ls
quilt-rlm mesh
```

`quilt-rlm` stores manifests, logs, and trajectories under `/workspace/.quilt/rlm/`.

Typical launcher flow:

```bash
npx quilt-nightly --rlm -- quilt-rlm run --script /workspace/app.py
npx quilt-nightly --rlm -m
```

## Security Model

- No provider credentials are baked into the image.
- Users pass provider keys at runtime through the Quilt environment.
- The image uses upstream `rlms`; Quilt-specific logic lives in the launcher and helper script.
