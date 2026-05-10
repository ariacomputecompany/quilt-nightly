#!/usr/bin/env python3

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path


DEFAULT_ADDR = "127.0.0.1:7878"
STATE_ROOT = Path("/workspace/.quilt/aegis")
LOGS_DIR = STATE_ROOT / "logs"


def ensure_state_dirs() -> None:
    LOGS_DIR.mkdir(parents=True, exist_ok=True)


def aegis_command(mode: str, addr: str, profile: str, start_url: str | None) -> list[str]:
    command = ["aegis", "--mode", mode, "--profile", profile]
    if start_url:
        command.extend(["--start-url", start_url])
    command.extend(["serve", "--addr", addr])
    return command


def wait_for_health(addr: str, timeout_s: float = 30.0) -> dict:
    deadline = time.time() + timeout_s
    url = f"http://{addr}/healthz"
    last_error = None
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=2) as response:
                payload = json.loads(response.read().decode("utf-8"))
                if payload.get("command_ready") is True and payload.get("bridge_healthy") is True:
                    return payload
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            last_error = exc
        time.sleep(0.5)
    raise SystemExit(f"aegis runtime did not become healthy at {url}: {last_error}")


def command_doctor(args: argparse.Namespace) -> int:
    ensure_state_dirs()
    payload = {
        "aegis_path": shutil_which("aegis"),
        "workspace": "/workspace",
        "state_root": str(STATE_ROOT),
        "aegis_home": os.getenv("AEGIS_HOME", "/root/.aegis"),
        "doctor": run_json_command(["aegis", "native", "doctor"]),
    }
    if args.json:
        print(json.dumps(payload, indent=2))
    else:
        print(json.dumps(payload, indent=2))
    return 0


def shutil_which(name: str) -> str | None:
    for directory in os.getenv("PATH", "").split(":"):
        candidate = Path(directory) / name
        if candidate.exists() and os.access(candidate, os.X_OK):
            return str(candidate)
    return None


def run_json_command(command: list[str]) -> dict | str:
    result = subprocess.run(command, check=True, capture_output=True, text=True)
    stdout = result.stdout.strip()
    try:
        return json.loads(stdout)
    except json.JSONDecodeError:
        return stdout


def command_serve(args: argparse.Namespace) -> int:
    ensure_state_dirs()
    os.execvp(
        "aegis",
        aegis_command(args.mode, args.addr, args.profile, args.start_url),
    )
    return 0


def command_shell(args: argparse.Namespace) -> int:
    ensure_state_dirs()
    if not args.no_serve:
        log_path = LOGS_DIR / f"serve-{int(time.time())}.log"
        with log_path.open("w", encoding="utf-8") as log_handle:
            process = subprocess.Popen(
                aegis_command(args.mode, args.addr, args.profile, args.start_url),
                stdout=log_handle,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
        health = wait_for_health(args.addr)
        print(
            json.dumps(
                {
                    "status": "ready",
                    "pid": process.pid,
                    "addr": args.addr,
                    "mode": args.mode,
                    "profile": args.profile,
                    "swarm_count": args.swarm_count,
                    "health": health,
                    "log_path": str(log_path),
                },
                indent=2,
            )
        )
    os.execvp("/bin/bash", ["/bin/bash"])
    return 0


def command_examples(_args: argparse.Namespace) -> int:
    print(
        "\n".join(
            [
                "quilt-aegis doctor --json",
                "quilt-aegis shell",
                "quilt-aegis serve --mode headful --addr 0.0.0.0:7878",
                "aegis usage",
                "aegis native doctor",
            ]
        )
    )
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="quilt-aegis")
    subparsers = parser.add_subparsers(dest="command", required=True)

    doctor = subparsers.add_parser("doctor")
    doctor.add_argument("--json", action="store_true")
    doctor.set_defaults(func=command_doctor)

    serve = subparsers.add_parser("serve")
    serve.add_argument("--mode", default="headless", choices=["headless", "headful"])
    serve.add_argument("--addr", default=DEFAULT_ADDR)
    serve.add_argument("--profile", default="default")
    serve.add_argument("--start-url")
    serve.set_defaults(func=command_serve)

    shell = subparsers.add_parser("shell")
    shell.add_argument("--mode", default="headless", choices=["headless", "headful"])
    shell.add_argument("--addr", default=DEFAULT_ADDR)
    shell.add_argument("--profile", default="default")
    shell.add_argument("--start-url")
    shell.add_argument("--swarm-count", type=int, default=0)
    shell.add_argument("--no-serve", action="store_true")
    shell.set_defaults(func=command_shell)

    examples = subparsers.add_parser("examples")
    examples.set_defaults(func=command_examples)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
