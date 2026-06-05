# quilt-nightly aegis helper assets

`aegis/` contains the helper code and bootstrap script used by `npx quilt-nightly --aegis`.

Unlike the other Quilt Nightly case studies, Aegis does not run from a dedicated OCI image here. The launcher creates a Quilt `prod-gui` container, syncs the current working directory into `/workspace`, and then starts Aegis from the synced helper:

```bash
python3 /workspace/aegis/quilt_aegis.py shell --mode headful
```

That flow preserves Aegis headful support by using Quilt's GUI-ready container type and then bootstrapping the Linux branch runtime inside the container when needed.

## Files

- `quilt_aegis.py`: helper CLI for bootstrapping, doctor checks, shell startup, and `aegis serve`
- `bootstrap_aegis_linux.sh`: installs the Linux branch and its runtime dependencies inside a `prod-gui` container

## Typical launcher flow

```bash
npx quilt-nightly --aegis
npx quilt-nightly --aegis -- aegis usage
npx quilt-nightly --aegis -s 4
```

## Direct helper usage

```bash
python3 aegis/quilt_aegis.py doctor
python3 aegis/quilt_aegis.py doctor --bootstrap --json
python3 aegis/quilt_aegis.py shell --mode headful
python3 aegis/quilt_aegis.py serve --mode headless --addr 0.0.0.0:7878
python3 aegis/quilt_aegis.py examples
```

`--aegis -s` creates multiple isolated `prod-gui` containers, syncs the repo into each one, starts background Aegis workers in follower containers, and attaches the terminal to the leader.
