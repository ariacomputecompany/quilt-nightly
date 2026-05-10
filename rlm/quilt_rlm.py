#!/usr/bin/env python3

import argparse
import json
import os
import shutil
import subprocess
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


DEFAULT_WORKSPACE = Path(os.getenv("QUILT_RLM_WORKSPACE", "/workspace"))
WORKSPACE = DEFAULT_WORKSPACE if DEFAULT_WORKSPACE.exists() else Path.cwd()
STATE_ROOT = WORKSPACE / ".quilt" / "rlm"
MANIFESTS_DIR = STATE_ROOT / "manifests"
TRAJECTORIES_DIR = STATE_ROOT / "trajectories"
ARTIFACTS_DIR = STATE_ROOT / "artifacts"
EXAMPLES_DIR = Path("/opt/quilt-rlm/examples")
MESH_DIR = STATE_ROOT / "mesh"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def ensure_dirs() -> None:
    for directory in (STATE_ROOT, MANIFESTS_DIR, TRAJECTORIES_DIR, ARTIFACTS_DIR, MESH_DIR):
        directory.mkdir(parents=True, exist_ok=True)


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def detect_provider_key(backend: str) -> str | None:
    mapping = {
        "openai": "OPENAI_API_KEY",
        "anthropic": "ANTHROPIC_API_KEY",
        "openrouter": "OPENROUTER_API_KEY",
        "portkey": "PORTKEY_API_KEY",
    }
    key_name = mapping.get(backend)
    if not key_name:
        return None
    return key_name if os.getenv(key_name) else None


def session_paths(session_id: str) -> dict[str, Path]:
    session_dir = ARTIFACTS_DIR / session_id
    return {
        "session_dir": session_dir,
        "stdout": session_dir / "stdout.log",
        "stderr": session_dir / "stderr.log",
        "manifest": MANIFESTS_DIR / f"{session_id}.json",
    }


def build_manifest(
    session_id: str,
    mode: str,
    command: list[str],
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    paths = session_paths(session_id)
    manifest = {
        "session_id": session_id,
        "mode": mode,
        "command": command,
        "created_at": utc_now(),
        "workspace": str(WORKSPACE),
        "state_root": str(STATE_ROOT),
        "artifact_dir": str(paths["session_dir"]),
        "stdout_log": str(paths["stdout"]),
        "stderr_log": str(paths["stderr"]),
        "trajectory_dir": str(TRAJECTORIES_DIR),
        "extra": extra or {},
    }
    return manifest


def load_manifest(session_id: str) -> dict[str, Any]:
    manifest_path = MANIFESTS_DIR / f"{session_id}.json"
    if not manifest_path.exists():
        raise SystemExit(f"Unknown session: {session_id}")
    return json.loads(manifest_path.read_text(encoding="utf-8"))


def persist_manifest(session_id: str, manifest: dict[str, Any]) -> None:
    write_json(session_paths(session_id)["manifest"], manifest)


def run_subprocess(command: list[str], session_id: str, manifest: dict[str, Any]) -> int:
    paths = session_paths(session_id)
    paths["session_dir"].mkdir(parents=True, exist_ok=True)
    with paths["stdout"].open("w", encoding="utf-8") as stdout_file, paths["stderr"].open(
        "w", encoding="utf-8"
    ) as stderr_file:
        process = subprocess.run(
            command,
            cwd=WORKSPACE,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
        stdout_file.write(process.stdout)
        stderr_file.write(process.stderr)
        if process.stdout:
            sys.stdout.write(process.stdout)
        if process.stderr:
            sys.stderr.write(process.stderr)
    manifest["completed_at"] = utc_now()
    manifest["exit_code"] = process.returncode
    persist_manifest(session_id, manifest)
    return process.returncode


def command_doctor(args: argparse.Namespace) -> int:
    ensure_dirs()
    payload = {
        "python": sys.version.split()[0],
        "workspace": str(WORKSPACE),
        "state_root": str(STATE_ROOT),
        "provider_env": {
            "OPENAI_API_KEY": bool(os.getenv("OPENAI_API_KEY")),
            "ANTHROPIC_API_KEY": bool(os.getenv("ANTHROPIC_API_KEY")),
            "OPENROUTER_API_KEY": bool(os.getenv("OPENROUTER_API_KEY")),
            "PORTKEY_API_KEY": bool(os.getenv("PORTKEY_API_KEY")),
        },
    }
    try:
        import rlm  # type: ignore

        payload["rlm_import"] = getattr(rlm, "__file__", "unknown")
    except Exception as exc:  # pragma: no cover
        payload["rlm_import_error"] = str(exc)
    if args.json:
        print(json.dumps(payload, indent=2))
    else:
        for key, value in payload.items():
            print(f"{key}: {value}")
    return 0


def command_shell(_args: argparse.Namespace) -> int:
    ensure_dirs()
    os.execvp("/bin/bash", ["/bin/bash"])
    return 0


def command_mesh(args: argparse.Namespace) -> int:
    ensure_dirs()
    session_id = args.name or f"mesh-{uuid.uuid4().hex[:10]}"
    manifest = {
        "session_id": session_id,
        "mode": "mesh-shell",
        "created_at": utc_now(),
        "workspace": str(WORKSPACE),
        "mesh_dir": str(MESH_DIR / session_id),
        "workers": args.workers,
    }
    mesh_dir = MESH_DIR / session_id
    mesh_dir.mkdir(parents=True, exist_ok=True)
    write_json(mesh_dir / "manifest.json", manifest)
    os.environ["QUILT_RLM_MESH_SESSION"] = session_id
    os.environ["QUILT_RLM_MESH_WORKERS"] = str(args.workers)
    os.execvp("/bin/bash", ["/bin/bash"])
    return 0


def command_examples(args: argparse.Namespace) -> int:
    ensure_dirs()
    if args.examples_action == "ls":
        for path in sorted(EXAMPLES_DIR.glob("*")):
            print(path.name)
        return 0
    if args.examples_action == "clone":
        if not args.repo:
            raise SystemExit("examples clone requires a repo URL")
        destination = WORKSPACE / (args.dest or Path(args.repo).stem.replace(".git", ""))
        subprocess.run(["git", "clone", args.repo, str(destination)], check=True)
        print(destination)
        return 0
    if args.examples_action == "show":
        example_path = EXAMPLES_DIR / args.name
        if not example_path.exists():
            raise SystemExit(f"Unknown example: {args.name}")
        print(example_path.read_text(encoding="utf-8"))
        return 0
    raise SystemExit(f"Unknown examples action: {args.examples_action}")


def command_trajectories(args: argparse.Namespace) -> int:
    ensure_dirs()
    if args.trajectories_action == "ls":
        manifests = sorted(MANIFESTS_DIR.glob("*.json"))
        for manifest_path in manifests:
            payload = json.loads(manifest_path.read_text(encoding="utf-8"))
            print(
                f"{payload.get('session_id')}  mode={payload.get('mode')}  exit={payload.get('exit_code', 'running')}"
            )
        return 0
    if args.trajectories_action == "show":
        print(json.dumps(load_manifest(args.session_id), indent=2))
        return 0
    if args.trajectories_action == "export":
        manifest = load_manifest(args.session_id)
        target = Path(args.out).expanduser().resolve()
        target.mkdir(parents=True, exist_ok=True)
        write_json(target / "manifest.json", manifest)
        artifact_dir = Path(manifest["artifact_dir"])
        if artifact_dir.exists():
            for item in artifact_dir.iterdir():
                shutil.copy2(item, target / item.name)
        trajectory_dir = Path(manifest["trajectory_dir"])
        if trajectory_dir.exists():
            for item in trajectory_dir.glob("*.jsonl"):
                shutil.copy2(item, target / item.name)
        print(target)
        return 0
    raise SystemExit(f"Unknown trajectories action: {args.trajectories_action}")


def run_prompt_mode(args: argparse.Namespace, session_id: str, manifest: dict[str, Any]) -> int:
    ensure_dirs()
    prompt = Path(args.prompt_file).read_text(encoding="utf-8")
    if args.context_file:
        context = Path(args.context_file).read_text(encoding="utf-8")
        prompt = f"{prompt}\n\nContext:\n{context}"

    provider_key = detect_provider_key(args.backend)
    paths = session_paths(session_id)
    paths["session_dir"].mkdir(parents=True, exist_ok=True)

    from rlm import RLM  # type: ignore
    from rlm.logger import RLMLogger  # type: ignore

    logger = RLMLogger(log_dir=str(TRAJECTORIES_DIR))
    backend_kwargs: dict[str, Any] = {"model_name": args.model}
    if provider_key:
        backend_kwargs["api_key"] = os.getenv(provider_key)

    rlm = RLM(
        backend=args.backend,
        backend_kwargs=backend_kwargs,
        environment=args.environment,
        logger=logger,
        verbose=args.verbose,
    )
    result = rlm.completion(prompt)
    response = getattr(result, "response", str(result))
    paths["stdout"].write_text(response + "\n", encoding="utf-8")
    print(response)

    manifest["completed_at"] = utc_now()
    manifest["exit_code"] = 0
    manifest["extra"]["provider_env_var"] = provider_key
    persist_manifest(session_id, manifest)
    return 0


def command_run(args: argparse.Namespace) -> int:
    ensure_dirs()
    session_id = args.name or f"run-{uuid.uuid4().hex[:10]}"
    command: list[str]
    normalized_command = list(args.command)
    if normalized_command[:1] == ["--"]:
        normalized_command = normalized_command[1:]
    extra: dict[str, Any] = {
        "backend": args.backend,
        "model": args.model,
        "environment": args.environment,
        "script": args.script,
        "prompt_file": args.prompt_file,
        "context_file": args.context_file,
    }

    if normalized_command:
        command = normalized_command
        manifest = build_manifest(session_id, "command", command, extra)
        persist_manifest(session_id, manifest)
        return run_subprocess(command, session_id, manifest)

    if args.script:
        command = [sys.executable, args.script]
        manifest = build_manifest(session_id, "script", command, extra)
        persist_manifest(session_id, manifest)
        return run_subprocess(command, session_id, manifest)

    if args.prompt_file:
        command = ["rlm-prompt", args.prompt_file]
        manifest = build_manifest(session_id, "prompt", command, extra)
        persist_manifest(session_id, manifest)
        return run_prompt_mode(args, session_id, manifest)

    raise SystemExit("run requires either a command, --script, or --prompt-file")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="quilt-rlm")
    subparsers = parser.add_subparsers(dest="command", required=True)

    doctor = subparsers.add_parser("doctor")
    doctor.add_argument("--json", action="store_true")
    doctor.set_defaults(func=command_doctor)

    shell = subparsers.add_parser("shell")
    shell.set_defaults(func=command_shell)

    mesh = subparsers.add_parser("mesh")
    mesh.add_argument("--workers", type=int, default=2)
    mesh.add_argument("--name")
    mesh.set_defaults(func=command_mesh)

    run = subparsers.add_parser("run")
    run.add_argument("--script")
    run.add_argument("--prompt-file")
    run.add_argument("--context-file")
    run.add_argument("--backend", default="openai")
    run.add_argument("--model", default=os.getenv("OPENAI_MODEL", "gpt-5-mini"))
    run.add_argument("--environment", default="local")
    run.add_argument("--name")
    run.add_argument("--verbose", action="store_true")
    run.add_argument("command", nargs=argparse.REMAINDER)
    run.set_defaults(func=command_run)

    examples = subparsers.add_parser("examples")
    examples_sub = examples.add_subparsers(dest="examples_action", required=True)
    examples_sub.add_parser("ls")
    example_show = examples_sub.add_parser("show")
    example_show.add_argument("name")
    example_clone = examples_sub.add_parser("clone")
    example_clone.add_argument("repo")
    example_clone.add_argument("dest", nargs="?")
    examples.set_defaults(func=command_examples)

    trajectories = subparsers.add_parser("trajectories")
    trajectories_sub = trajectories.add_subparsers(dest="trajectories_action", required=True)
    trajectories_sub.add_parser("ls")
    traj_show = trajectories_sub.add_parser("show")
    traj_show.add_argument("session_id")
    traj_export = trajectories_sub.add_parser("export")
    traj_export.add_argument("session_id")
    traj_export.add_argument("--out", required=True)
    trajectories.set_defaults(func=command_trajectories)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
