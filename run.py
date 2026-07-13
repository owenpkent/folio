#!/usr/bin/env python3
"""Folio launcher.

One command to run Folio on your machine, so you don't have to remember the
npm / vsce / code invocations. Run with no arguments for an interactive menu,
or pass a subcommand:

    python run.py dev              # Folio in the browser (Vite dev server)
    python run.py ext [file.pdf]   # build + open the VS Code extension (dev host)
    python run.py build-ext        # just build the VS Code extension
    python run.py package          # build a distributable .vsix
    python run.py install          # install the .vsix into your VS Code
    python run.py desktop          # the native desktop app (needs Rust)
    python run.py doctor           # check prerequisites

Stdlib only; works with any Python 3.8+.
"""
from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent
EXT = REPO / "extensions" / "vscode"
BASE_URL = "https://github.com/owenpkent/folio/raw/main/extensions/vscode"


# --- small helpers ---------------------------------------------------------

def tool(name: str) -> str | None:
    """Resolve an executable, tolerating Windows .cmd/.exe shims."""
    return shutil.which(name)


def need(name: str) -> str:
    path = tool(name)
    if not path:
        sys.exit(f"error: '{name}' not found on PATH. Run `python run.py doctor`.")
    return path


def run(cmd: list[str], *, cwd: Path = REPO) -> int:
    """Run a command, streaming its output; return its exit code."""
    print(f"\n$ {' '.join(cmd)}  (in {cwd})\n")
    return subprocess.run(cmd, cwd=str(cwd)).returncode


def latest_vsix() -> Path | None:
    vsixes = sorted(EXT.glob("*.vsix"), key=lambda p: p.stat().st_mtime, reverse=True)
    return vsixes[0] if vsixes else None


# --- actions ---------------------------------------------------------------

def cmd_doctor(_args) -> int:
    checks = [
        ("node", "Node.js (required for everything)"),
        ("npm", "npm (install deps, run the app)"),
        ("code", "VS Code CLI (extension dev host, install)"),
        ("cargo", "Rust/Cargo (only for the native desktop app)"),
    ]
    print("Folio prerequisites:\n")
    for name, desc in checks:
        path = tool(name)
        mark = "OK " if path else "-- "
        print(f"  [{mark}] {name:6s} {desc}")
        if path:
            print(f"         {path}")
    deps = (REPO / "node_modules").is_dir()
    print(f"\n  [{'OK ' if deps else '-- '}] node_modules {'installed' if deps else 'MISSING (run: npm install)'}")
    return 0


def ensure_deps() -> None:
    if not (REPO / "node_modules").is_dir():
        print("node_modules missing; installing dependencies first...")
        if run([need("npm"), "install"]) != 0:
            sys.exit("npm install failed.")


def cmd_dev(_args) -> int:
    """Folio in the browser via the Vite dev server (no Rust needed)."""
    ensure_deps()
    print("Starting the Vite dev server. Open http://localhost:1420/ in your browser.")
    print("Press Ctrl+C to stop.")
    return run([need("npm"), "run", "dev"])


def cmd_build_ext(_args) -> int:
    ensure_deps()
    return run([need("node"), "build.mjs"], cwd=EXT)


def cmd_ext(args) -> int:
    """Build the extension and open it in a VS Code Extension Development Host."""
    if cmd_build_ext(args) != 0:
        return 1
    code = need("code")
    cmd = [code, "--new-window", f"--extensionDevelopmentPath={EXT}"]
    pdf = getattr(args, "pdf", None)
    if pdf:
        p = Path(pdf).resolve()
        if not p.exists():
            sys.exit(f"error: PDF not found: {p}")
        cmd.append(str(p))
    print("Launching VS Code Extension Development Host...")
    if pdf:
        print("The PDF should open in the Folio custom editor.")
    else:
        print("Open any .pdf in the new window to view it with Folio.")
    return run(cmd, cwd=EXT)


def cmd_package(_args) -> int:
    if cmd_build_ext(_args) != 0:
        return 1
    npx = need("npx")
    return run(
        [npx, "--yes", "@vscode/vsce", "package", "--no-dependencies",
         "--baseContentUrl", BASE_URL, "--baseImagesUrl", BASE_URL],
        cwd=EXT,
    )


def cmd_install(_args) -> int:
    vsix = latest_vsix()
    if not vsix:
        print("No .vsix found; building one first...")
        if cmd_package(_args) != 0:
            return 1
        vsix = latest_vsix()
        if not vsix:
            sys.exit("packaging did not produce a .vsix.")
    print(f"Installing {vsix.name} into VS Code.")
    print("Note: this makes Folio your default PDF viewer in VS Code.")
    return run([need("code"), "--install-extension", str(vsix)], cwd=EXT)


def cmd_desktop(_args) -> int:
    """The native desktop app via Tauri (requires Rust)."""
    if not tool("cargo"):
        print("Rust/Cargo is not installed, which the native desktop app needs.")
        print("Install it from https://rustup.rs, then re-run. Meanwhile, try:")
        print("  python run.py dev     (browser)   or   python run.py ext (VS Code)")
        return 1
    ensure_deps()
    return run([need("npm"), "run", "tauri", "dev"])


# --- interactive menu ------------------------------------------------------

MENU = [
    ("Browser (Vite dev server)", cmd_dev),
    ("VS Code extension (dev host)", cmd_ext),
    ("Build the VS Code extension", cmd_build_ext),
    ("Package a .vsix", cmd_package),
    ("Install the .vsix into VS Code", cmd_install),
    ("Native desktop app (needs Rust)", cmd_desktop),
    ("Check prerequisites", cmd_doctor),
]


def interactive() -> int:
    print("How do you want to run Folio?\n")
    for i, (label, _) in enumerate(MENU, 1):
        print(f"  {i}. {label}")
    print("  0. Quit")
    try:
        choice = input("\nChoose [1]: ").strip() or "1"
    except (EOFError, KeyboardInterrupt):
        print()
        return 0
    if choice == "0":
        return 0
    try:
        _, fn = MENU[int(choice) - 1]
    except (ValueError, IndexError):
        print("Invalid choice.")
        return 1
    return fn(argparse.Namespace(pdf=None))


# --- entrypoint ------------------------------------------------------------

def main() -> int:
    parser = argparse.ArgumentParser(
        description="Run Folio (browser, VS Code extension, or desktop).",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    sub = parser.add_subparsers(dest="command")
    sub.add_parser("dev", help="Folio in the browser (Vite dev server)")
    p_ext = sub.add_parser("ext", help="build + open the VS Code extension dev host")
    p_ext.add_argument("pdf", nargs="?", help="a PDF to open in the dev host")
    sub.add_parser("build-ext", help="build the VS Code extension")
    sub.add_parser("package", help="build a distributable .vsix")
    sub.add_parser("install", help="install the .vsix into VS Code")
    sub.add_parser("desktop", help="the native desktop app (needs Rust)")
    sub.add_parser("doctor", help="check prerequisites")

    args = parser.parse_args()
    dispatch = {
        "dev": cmd_dev,
        "ext": cmd_ext,
        "build-ext": cmd_build_ext,
        "package": cmd_package,
        "install": cmd_install,
        "desktop": cmd_desktop,
        "doctor": cmd_doctor,
    }
    if args.command is None:
        return interactive()
    return dispatch[args.command](args)


if __name__ == "__main__":
    sys.exit(main())
