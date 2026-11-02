#!/usr/bin/env python3
"""Export approved Git blobs into this repository without copying source history."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import tempfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]


def digest(data):
    return hashlib.sha256(data).hexdigest()


def git(source, *args):
    return subprocess.check_output(["git", "-C", str(source), *args], stderr=subprocess.PIPE)


def safe_path(path):
    p = PurePosixPath(path)
    if not path or p.is_absolute() or str(p) != path or any(s in ("..", ".git") for s in p.parts):
        raise ValueError("Invalid export path")
    return path


def refuse_links(root, path):
    current = root
    for part in PurePosixPath(path).parts:
        current = current / part
        if current.is_symlink():
            raise ValueError("Linked export paths are refused")


def approved_blobs(source, revision, files):
    entries = {}
    for entry in git(source, "ls-tree", "-rz", "--full-tree", revision).split(b"\0"):
        if not entry:
            continue
        header, name = entry.split(b"\t", 1)
        mode, kind, oid = header.decode().split()
        entries[name.decode()] = (mode, kind, oid)
    result = {}
    for path in files:
        safe_path(path)
        if path not in entries or entries[path][0] not in ("100644", "100755") or entries[path][1] != "blob":
            raise ValueError("Approved source missing or not a regular file: " + path)
        mode, _, oid = entries[path]
        result[path] = (git(source, "cat-file", "blob", oid), int(mode[-3:], 8))
    return result, len(set(entries) - set(files))


def sanitize(blobs, patches):
    grouped = {}
    for patch in patches:
        grouped.setdefault(patch["file"], []).append(patch)
    for path, changes in grouped.items():
        raw, mode = blobs[path]
        lines = raw.decode("utf-8").splitlines(keepends=True)
        for patch in sorted(changes, key=lambda x: x["startLine"], reverse=True):
            start, end = patch["startLine"] - 1, patch["endLine"]
            if digest("".join(lines[start:end]).encode()) != patch["beforeSha256"]:
                raise ValueError("Sanitization needs review before exporting: " + path)
            lines[start:end] = patch["replacement"].splitlines(keepends=True)
        blobs[path] = ("".join(lines).encode(), mode)


def overlay_files(blobs):
    for file in sorted((HERE / "overlays").rglob("*")):
        if file.is_symlink():
            raise ValueError("Linked overlay refused")
        if file.is_file():
            path = safe_path(file.relative_to(HERE / "overlays").as_posix())
            mode = blobs.get(path, (None, 0o644))[1]
            blobs[path] = (file.read_bytes(), mode)


def fix_document_links(blobs):
    # Internal inherited guides can reference private, unexported documentation.
    # Route missing relative Markdown targets to the maintained public overview.
    for path, (raw, mode) in list(blobs.items()):
        if not path.endswith(".md"):
            continue
        text = raw.decode("utf-8")

        def link(match):
            target = match["target"]
            if not target.endswith(".md") or ":" in target or target.startswith(("/", "#")):
                return match[0]
            candidate = os.path.normpath(str(PurePosixPath(path).parent / target)).replace(os.sep, "/")
            if candidate in blobs:
                return match[0]
            overview = os.path.relpath("docs/ARCHITECTURE.md", str(PurePosixPath(path).parent)).replace(os.sep, "/")
            return "](" + overview + ")"

        blobs[path] = (re.sub(r"\]\((?P<target>[^)#]+)(?:#[^)]*)?\)", link, text).encode(), mode)


def privacy_check(blobs):
    # Host/account deny entries are SHA-256 digests, keeping private literals out
    # of this repository. General secret rules supplement a separate Gitleaks run.
    policy = json.loads((HERE / "privacy.json").read_text())
    banned = set(policy["forbiddenTokenSha256"])
    secrets = re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AIza[\w-]{30,}|sk-(?:proj-|ant-api\d{2}-)?[A-Za-z0-9_-]{24,})")
    failures = []
    for path, (raw, _) in blobs.items():
        if b"\0" in raw[:8192]:
            continue
        text = raw.decode("utf-8", "replace")
        tokens = re.findall(r"[A-Za-z0-9_.@/-]+", text) + re.findall(r"[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+", text)
        if any(digest(token.lower().encode()) in banned for token in tokens):
            failures.append(path)
        if re.search(r"/Users/[A-Za-z0-9_.-]+/|[A-Z]:\\\\Users\\\\(?!Public\b)[A-Za-z0-9_.-]+", text):
            failures.append(path)
        if secrets.search(text):
            failures.append(path)
    if failures:
        raise ValueError("Privacy review required for: " + ", ".join(sorted(set(failures))))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=Path, help="Local upstream Git checkout")
    parser.add_argument("--ref", default="HEAD", help="Exact source revision or local ref")
    parser.add_argument("--output", type=Path, default=ROOT, help="Existing destination root")
    parser.add_argument("--check", action="store_true", help="Validate in memory without changing destination")
    args = parser.parse_args()
    source, output = args.source.resolve(), args.output.resolve()
    if output == source or output.is_relative_to(source) or source.is_relative_to(output):
        raise ValueError("Source and destination must be separate checkouts")
    if not output.is_dir():
        raise ValueError("Create the destination directory first")
    manifest = json.loads((HERE / "manifest.json").read_text())
    revision = git(source, "rev-parse", "--verify", args.ref + "^{commit}").decode().strip()
    blobs, omitted = approved_blobs(source, revision, manifest["files"])
    sanitize(blobs, manifest["patches"])
    overlay_files(blobs)
    fix_document_links(blobs)
    privacy_check(blobs)
    if args.check:
        print(json.dumps({"approvedFiles": len(blobs), "unexportedSourceFiles": omitted, "check": "passed"}))
        return
    state_path = output / ".upstream-state.json"
    if state_path.is_symlink():
        raise ValueError("Linked export state refused")
    baseline_path = output / ".upstream-managed.json"
    if baseline_path.is_symlink():
        raise ValueError("Linked export baseline refused")
    if state_path.exists():
        prior = json.loads(state_path.read_text())
    elif baseline_path.exists():
        baseline = json.loads(baseline_path.read_text())
        prior = {"files": dict(baseline["files"])}
    else:
        prior = {"files": {}}
    # Validate every write/delete before applying any of them. Preserve community
    # edits by refusing overwrites; move reviewed changes into overlays first.
    for path in set(prior["files"]) | set(blobs):
        safe_path(path)
        refuse_links(output, path)
        dest = output / path
        if dest.exists():
            if not dest.is_file():
                raise ValueError("Destination is not a regular file: " + path)
            expected = prior["files"].get(path)
            actual = digest(dest.read_bytes())
            if expected is None and path in blobs and actual == digest(blobs[path][0]):
                continue
            if actual != expected:
                raise ValueError("Destination has independent changes; review before overwriting: " + path)
    for path, (raw, mode) in blobs.items():
        dest = output / path
        dest.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=dest.parent, delete=False) as temp:
            temp.write(raw)
            temp_path = Path(temp.name)
        temp_path.chmod(mode)
        temp_path.replace(dest)
    for path in set(prior["files"]) - set(blobs):
        (output / path).unlink(missing_ok=True)
    hashes = {p: digest(v[0]) for p, v in blobs.items()}
    baseline = {"version": 1, "files": sorted(hashes.items())}
    baseline_path.write_text(json.dumps(baseline, indent=2) + "\n")
    state = {"version": 1, "sourceCommit": revision, "files": hashes}
    fd = os.open(state_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as stream:
        json.dump(state, stream, indent=2)
        stream.write("\n")
    print(json.dumps({"exportedFiles": len(blobs), "unexportedSourceFiles": omitted, "state": "saved locally; excluded from Git"}))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, subprocess.CalledProcessError) as error:
        raise SystemExit(str(error) if isinstance(error, ValueError) else "Git source read failed")
