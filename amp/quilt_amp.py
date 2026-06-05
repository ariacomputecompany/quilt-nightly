#!/usr/bin/env python3

import argparse
import json
import os
import secrets
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


DEFAULT_ADDR = "0.0.0.0:7001"
DEFAULT_NODE_PREFIX = "amp"
DEFAULT_BOOTSTRAP_AGENT = "owner"
WORKSPACE = Path(os.getenv("QUILT_AMP_WORKSPACE", "/workspace"))
STATE_ROOT = WORKSPACE / ".quilt" / "amp"
LOGS_DIR = STATE_ROOT / "logs"
RUNTIME_DIR = STATE_ROOT / "runtime"
CONFIG_PATH = STATE_ROOT / "config.json"
SQLITE_PATH = STATE_ROOT / "amp.db"
CREDENTIALS_PATH = STATE_ROOT / "credentials.json"
PID_PATH = RUNTIME_DIR / "amp.pid"
LAST_RUN_PATH = RUNTIME_DIR / "last-run.json"


def utc_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def ensure_dirs() -> None:
    for directory in (STATE_ROOT, LOGS_DIR, RUNTIME_DIR):
        directory.mkdir(parents=True, exist_ok=True)


def run_text(command: list[str]) -> str:
    result = subprocess.run(command, check=True, capture_output=True, text=True)
    return result.stdout.strip()


def detect_amp_path() -> str | None:
    for directory in os.getenv("PATH", "").split(":"):
        if not directory:
            continue
        candidate = Path(directory) / "amp"
        if candidate.exists() and os.access(candidate, os.X_OK):
            return str(candidate)
    return None


def ensure_amp_available() -> str:
    path = detect_amp_path()
    if not path:
        raise SystemExit("`amp` binary not found on PATH")
    return path


def random_token() -> str:
    return secrets.token_urlsafe(24)


def random_node_id() -> str:
    return f"{DEFAULT_NODE_PREFIX}-{secrets.token_hex(4)}"


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def config_payload(node_id: str, bootstrap_agent: str, bootstrap_token: str) -> dict[str, Any]:
    return {
        "node_id": node_id,
        "agents": {
            bootstrap_agent: bootstrap_token,
        },
        "peers": {},
        "retry_policy": {
            "max_attempts": 8,
            "base_delay_ms": 500,
            "ttl_ms": 60000,
        },
    }


def ensure_state(node_id: str | None = None, bootstrap_agent: str = DEFAULT_BOOTSTRAP_AGENT) -> dict[str, Any]:
    ensure_dirs()

    if CREDENTIALS_PATH.exists():
        credentials = read_json(CREDENTIALS_PATH)
        if not CONFIG_PATH.exists():
            write_json(
                CONFIG_PATH,
                config_payload(
                    credentials["node_id"],
                    credentials["bootstrap_agent"],
                    credentials["bootstrap_token"],
                ),
            )
        return credentials

    actual_node_id = node_id or random_node_id()
    bootstrap_token = random_token()
    credentials = {
        "created_at": utc_now(),
        "node_id": actual_node_id,
        "bootstrap_agent": bootstrap_agent,
        "bootstrap_agent_canonical": f"{actual_node_id}/{bootstrap_agent}",
        "bootstrap_token": bootstrap_token,
        "config_path": str(CONFIG_PATH),
        "sqlite_path": str(SQLITE_PATH),
        "state_root": str(STATE_ROOT),
    }
    write_json(CREDENTIALS_PATH, credentials)
    write_json(CONFIG_PATH, config_payload(actual_node_id, bootstrap_agent, bootstrap_token))
    return credentials


def health_url(addr: str) -> str:
    return f"http://127.0.0.1:{addr.rsplit(':', 1)[1]}/health"


def read_pid() -> int | None:
    if not PID_PATH.exists():
        return None
    try:
        return int(PID_PATH.read_text(encoding="utf-8").strip())
    except ValueError:
        return None


def pid_is_running(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def wait_for_health(addr: str, timeout_s: float = 30.0) -> dict[str, Any]:
    url = health_url(addr)
    deadline = time.time() + timeout_s
    last_error: str | None = None
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=2) as response:
                payload = json.loads(response.read().decode("utf-8"))
                if payload.get("ok") is True:
                    return payload
                last_error = json.dumps(payload)
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            last_error = str(exc)
        time.sleep(0.5)
    raise SystemExit(f"AMP daemon did not become healthy at {url}: {last_error}")


def launch_payload(addr: str, credentials: dict[str, Any]) -> dict[str, Any]:
    return {
        "addr": addr,
        "health_url": health_url(addr),
        "node_id": credentials["node_id"],
        "bootstrap_agent": credentials["bootstrap_agent"],
        "bootstrap_agent_canonical": credentials["bootstrap_agent_canonical"],
        "bootstrap_token": credentials["bootstrap_token"],
        "config_path": str(CONFIG_PATH),
        "sqlite_path": str(SQLITE_PATH),
        "state_root": str(STATE_ROOT),
        "pid_path": str(PID_PATH),
        "last_run_path": str(LAST_RUN_PATH),
    }


def command_doctor(args: argparse.Namespace) -> int:
    credentials = ensure_state()
    amp_path = detect_amp_path()
    payload: dict[str, Any] = {
        "amp_path": amp_path,
        "amp_version": run_text(["amp", "--version"]) if amp_path else None,
        "workspace": str(WORKSPACE),
        "state_root": str(STATE_ROOT),
        "config_path": str(CONFIG_PATH),
        "sqlite_path": str(SQLITE_PATH),
        "bootstrap_agent": credentials["bootstrap_agent_canonical"],
        "running_pid": read_pid(),
    }
    if args.json:
        print(json.dumps(payload, indent=2))
    else:
        for key, value in payload.items():
            print(f"{key}: {value}")
    return 0


def command_bootstrap(args: argparse.Namespace) -> int:
    ensure_amp_available()
    credentials = ensure_state(node_id=args.node_id, bootstrap_agent=args.bootstrap_agent)
    if args.json:
        print(json.dumps(credentials, indent=2))
    else:
        for key, value in credentials.items():
            print(f"{key}: {value}")
    return 0


def launch_daemon(addr: str, credentials: dict[str, Any]) -> dict[str, Any]:
    ensure_amp_available()
    existing_pid = read_pid()
    if existing_pid and pid_is_running(existing_pid):
        health = wait_for_health(addr, timeout_s=3.0)
        payload = launch_payload(addr, credentials)
        payload.update(
            {
                "status": "already_running",
                "pid": existing_pid,
                "health": health,
                "log_path": str(read_json(LAST_RUN_PATH).get("log_path", "")) if LAST_RUN_PATH.exists() else None,
            }
        )
        return payload

    log_path = LOGS_DIR / f"serve-{int(time.time())}.log"
    with log_path.open("w", encoding="utf-8") as log_handle:
        process = subprocess.Popen(
            [
                "amp",
                "serve",
                "--listen",
                addr,
                "--store",
                "sqlite",
                "--sqlite-path",
                str(SQLITE_PATH),
                "--config",
                str(CONFIG_PATH),
                "--node-id",
                credentials["node_id"],
            ],
            cwd=str(WORKSPACE),
            stdout=log_handle,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
    PID_PATH.write_text(f"{process.pid}\n", encoding="utf-8")
    write_json(
        LAST_RUN_PATH,
        {
            "created_at": utc_now(),
            "pid": process.pid,
            "addr": addr,
            "log_path": str(log_path),
        },
    )
    health = wait_for_health(addr)
    payload = launch_payload(addr, credentials)
    payload.update(
        {
            "status": "ready",
            "pid": process.pid,
            "health": health,
            "log_path": str(log_path),
        }
    )
    return payload


def command_launch(args: argparse.Namespace) -> int:
    credentials = ensure_state(node_id=args.node_id, bootstrap_agent=args.bootstrap_agent)
    payload = launch_daemon(args.addr, credentials)
    if args.json:
        print(json.dumps(payload, indent=2))
    else:
        for key, value in payload.items():
            print(f"{key}: {value}")
    return 0


def print_shell_summary(args: argparse.Namespace) -> None:
    local_port = args.addr.rsplit(":", 1)[1]
    lines = [
        "quilt-amp shell ready",
        f"state_root={STATE_ROOT}",
        f"local_http_url=http://127.0.0.1:{local_port}",
        f"local_ws_url=ws://127.0.0.1:{local_port}/ws",
    ]
    if args.service_id:
        lines.append(f"service_id={args.service_id}")
    if args.http_url:
        lines.append(f"http_url={args.http_url}")
    if args.websocket_url:
        lines.append(f"websocket_url={args.websocket_url}")
    if args.bootstrap_agent:
        lines.append(f"bootstrap_agent={args.bootstrap_agent}")
    if args.bootstrap_token:
        lines.append(f"bootstrap_token={args.bootstrap_token}")
    print("\n".join(lines))


def command_shell(args: argparse.Namespace) -> int:
    credentials = ensure_state()
    if not args.no_launch:
        launch_daemon(args.addr, credentials)

    local_port = args.addr.rsplit(":", 1)[1]
    os.environ["QUILT_AMP_LOCAL_HTTP_URL"] = f"http://127.0.0.1:{local_port}"
    os.environ["QUILT_AMP_LOCAL_WS_URL"] = f"ws://127.0.0.1:{local_port}/ws"
    os.environ["QUILT_AMP_NODE_ID"] = credentials["node_id"]
    os.environ["QUILT_AMP_AGENT_ID"] = credentials["bootstrap_agent"]
    os.environ["QUILT_AMP_AGENT_CANONICAL_ID"] = credentials["bootstrap_agent_canonical"]
    os.environ["QUILT_AMP_AGENT_TOKEN"] = credentials["bootstrap_token"]
    if args.http_url:
        os.environ["QUILT_AMP_HTTP_URL"] = args.http_url
    if args.websocket_url:
        os.environ["QUILT_AMP_WS_URL"] = args.websocket_url
    if args.service_id:
        os.environ["QUILT_AMP_SERVICE_ID"] = args.service_id
    print_shell_summary(args)
    os.execvp("/bin/bash", ["/bin/bash"])
    return 0


def command_examples(_args: argparse.Namespace) -> int:
    print(
        "\n".join(
            [
                "quilt-amp doctor --json",
                "quilt-amp bootstrap --json",
                "quilt-amp launch --addr 0.0.0.0:7001 --json",
                "amp inspect system --server http://127.0.0.1:7001 --json",
                "amp msg watch --server ws://127.0.0.1:7001/ws --as owner --token $QUILT_AMP_AGENT_TOKEN --auto-ack",
            ]
        )
    )
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="quilt-amp")
    subparsers = parser.add_subparsers(dest="command", required=True)

    doctor = subparsers.add_parser("doctor")
    doctor.add_argument("--json", action="store_true")
    doctor.set_defaults(func=command_doctor)

    bootstrap = subparsers.add_parser("bootstrap")
    bootstrap.add_argument("--node-id")
    bootstrap.add_argument("--bootstrap-agent", default=DEFAULT_BOOTSTRAP_AGENT)
    bootstrap.add_argument("--json", action="store_true")
    bootstrap.set_defaults(func=command_bootstrap)

    launch = subparsers.add_parser("launch")
    launch.add_argument("--addr", default=DEFAULT_ADDR)
    launch.add_argument("--node-id")
    launch.add_argument("--bootstrap-agent", default=DEFAULT_BOOTSTRAP_AGENT)
    launch.add_argument("--json", action="store_true")
    launch.set_defaults(func=command_launch)

    shell = subparsers.add_parser("shell")
    shell.add_argument("--addr", default=DEFAULT_ADDR)
    shell.add_argument("--no-launch", action="store_true")
    shell.add_argument("--http-url")
    shell.add_argument("--websocket-url")
    shell.add_argument("--service-id")
    shell.add_argument("--bootstrap-agent")
    shell.add_argument("--bootstrap-token")
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
