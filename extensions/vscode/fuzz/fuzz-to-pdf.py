"""Fuzz to_pdf.py for command injection.

Creates real files whose NAMES are shell-injection payloads (valid on Windows:
avoids <>:"/\\|?* and control chars, but includes ; & $ ` ( ) space - ~), then
runs to_pdf with subprocess mocked to capture argv. Asserts the filename always
lands as a single argv element, argv[0] is the configured executable, and the
shell is never invoked. If soffice were called via a shell string, these names
would execute; with list-form argv they cannot.
"""
import random
import subprocess
import sys
import types
from pathlib import Path

SCRIPTS = Path(r"C:\Users\owenp\dev\ATDev-Marketing\scripts")
sys.path.insert(0, str(SCRIPTS))
import to_pdf  # noqa: E402

SENTINEL_EXE = r"C:\FAKE\soffice.exe"

captured = []  # list of (args, kwargs) per subprocess.run call


def fake_run(cmd, *args, **kwargs):
    captured.append((cmd, kwargs))
    # Simulate a successful conversion: create the expected output pdf.
    outdir = Path(cmd[cmd.index("--outdir") + 1])
    src = Path(cmd[-1])
    (outdir / (src.stem + ".pdf")).write_bytes(b"%PDF-1.4\n")
    return types.SimpleNamespace(returncode=0, stdout="", stderr="")


to_pdf.subprocess.run = fake_run

# Shell-injection payloads that are legal Windows filenames.
CURATED = [
    "; calc.pdf",
    "&& calc.pdf",
    "$(touch pwned).pdf",
    "`whoami`.pdf",
    "a & b.pdf",
    "--headless.pdf",
    "-rf.pdf",
    "x;id.pdf",
    "$IFS$9.pdf",
    "file $(id).pdf",
    "a`id`b.pdf",
    "~root .pdf",
    "!(x).pdf",
    "a$b.pdf",
    "normal file.pdf",
    "семпл.pdf",
    "空白 テスト.pdf",
]

# Random fuzz names from a shell-hostile but Windows-legal alphabet.
ALPHA = list("abc0 ;&$`()~-!^%.")
def rand_name():
    n = 1 + random.randint(0, 30)
    return "".join(random.choice(ALPHA) for _ in range(n)).strip() or "x"


def run_case(name, tmp, out):
    # Skip names Windows will not let us create; those are not a real threat.
    try:
        src = tmp / (name if name.lower().endswith(".pdf") else name + ".pdf")
        src.write_bytes(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    except OSError:
        return None
    captured.clear()
    to_pdf.to_pdf(src, outdir=out, soffice=SENTINEL_EXE)
    assert len(captured) == 1, f"expected one run, got {len(captured)}"
    cmd, kwargs = captured[0]
    assert isinstance(cmd, list), "argv is not a list (shell string?)"
    assert kwargs.get("shell", False) is False, "shell=True used"
    assert cmd[0] == SENTINEL_EXE, f"argv[0] not the exe: {cmd[0]!r}"
    resolved = str(src.resolve())
    # The filename must be exactly one argv element, unmodified and unmerged.
    assert cmd.count(resolved) == 1, f"src not a single argv element: {cmd!r}"
    assert cmd[-1] == resolved, f"src not passed as final argv: {cmd[-1]!r}"
    return True


def main():
    import tempfile

    ran = skipped = 0
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td) / "in"
        out = Path(td) / "out"
        tmp.mkdir()
        out.mkdir()
        cases = CURATED + [rand_name() for _ in range(5000)]
        for name in cases:
            r = run_case(name, tmp, out)
            if r is None:
                skipped += 1
            else:
                ran += 1
    print(f"to_pdf command-injection fuzz: {ran} cases passed, {skipped} skipped (illegal Windows names)")
    print("ALL PASS")


if __name__ == "__main__":
    main()
