#!/usr/bin/env python3
"""Verify an explicitly reviewed source allowlist; never auto-add files."""
import argparse
import hashlib
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
GENERATED = {'node_modules', 'dist', '.git', '__pycache__', 'coverage', '.pytest_cache', '.godot'}
MANIFEST = 'SHA256SUMS'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--check', action='store_true')
    mode.add_argument('--refresh', action='store_true', help='Refresh hashes for the existing explicit allowlist only')
    args = parser.parse_args()
    lines = (ROOT / 'PUBLIC-FILES.txt').read_text().splitlines()
    allowed = [line for line in lines if line and not line.startswith('#')]
    if allowed != sorted(set(allowed)):
        raise ValueError('Allowlist must be sorted and unique')
    for name in allowed:
        path = pathlib.PurePosixPath(name)
        if path.is_absolute() or '..' in path.parts or any(part in GENERATED for part in path.parts):
            raise ValueError('Unsafe allowlist path: ' + name)
        if path.name in {'world-frame.json', 'mesh-frame.json', 'native-view-run.json'}:
            raise ValueError('Private observation frame must not be published: ' + name)
        if name.endswith(('.log', '.jsonl', '.pyc', '.tgz', '.zip', '.tar.gz')) or (path.name.startswith('.env') and path.name != '.env.example'):
            raise ValueError('Private/generated file must not be published: ' + name)
    found = set()
    def visit(directory):
        for path in directory.iterdir():
            if path.name in GENERATED:
                continue
            name = path.relative_to(ROOT).as_posix()
            if path.is_symlink():
                raise ValueError('Publication tree must not contain symlinks: ' + name)
            if path.is_dir():
                visit(path)
            else:
                found.add(name)
    visit(ROOT)
    expected = set(allowed)
    if args.refresh:
        found.add(MANIFEST)
    if found != expected:
        raise ValueError('Allowlist mismatch; unexpected=' + str(sorted(found - expected)) + '; missing=' + str(sorted(expected - found)))
    if not {'LICENSE', 'NOTICE', 'vendor/awesome-mineflayer-mcp/LICENSE', 'vendor/awesome-mineflayer-mcp/NOTICE', MANIFEST, 'PUBLIC-FILES.txt'} <= expected:
        raise ValueError('Required provenance/manifest file missing')
    # Heuristic signatures supplement human review; they do not prove absence of secrets.
    signatures = [r'gh[pousr]_[A-Za-z0-9]{30,}', r'github_pat_[A-Za-z0-9_]{50,}',
                  r'AKIA[0-9A-Z]{16}', r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----',
                  r'https?://[^\s/@:]+:[^\s/@]+@']
    checksums = []
    for name in allowed:
        if name == MANIFEST:
            continue
        data = (ROOT / name).read_bytes()
        text = data.decode('utf-8')
        if any(re.search(pattern, text) for pattern in signatures):
            raise ValueError('Potential credential signature requires private review: ' + name)
        checksums.append(hashlib.sha256(data).hexdigest() + '  ' + name)
    contents = '\n'.join(checksums) + '\n'
    if args.refresh:
        (ROOT / MANIFEST).write_text(contents)
    elif (ROOT / MANIFEST).read_text() != contents:
        raise ValueError('Source hashes differ; review changes and refresh deliberately')
    print(f'Publication manifest verified: {len(allowed)} source files; heuristic credential scan passed')


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
