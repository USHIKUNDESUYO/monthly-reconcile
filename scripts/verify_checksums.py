"""Compare SHA256SUMS with Git blobs, avoiding Windows checkout line endings."""
import argparse
import hashlib
import json
import pathlib
import re
import subprocess


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("repository", type=pathlib.Path)
    parser.add_argument("--checksum-file", type=pathlib.Path)
    args = parser.parse_args()

    def blob(name):
        return subprocess.check_output(
            ["git", "-C", str(args.repository), "show", "HEAD:" + name],
            stderr=subprocess.PIPE,
        )

    try:
        data = args.checksum_file.read_bytes() if args.checksum_file else blob("SHA256SUMS")
        entries = {}
        for line in data.decode("utf-8").splitlines():
            digest, name = line.split("  ", 1)
            parts = pathlib.PurePosixPath(name)
            if (
                not re.fullmatch(r"[0-9a-f]{64}", digest)
                or not name
                or parts.is_absolute()
                or ".." in parts.parts
                or name in entries
            ):
                raise ValueError("Invalid or duplicate checksum entry")
            entries[name] = digest
        if not entries:
            raise ValueError("Empty checksum list")
        mismatches = []
        for name, expected in entries.items():
            actual = hashlib.sha256(blob(name)).hexdigest()
            if actual != expected:
                mismatches.append({"file": name, "expected": expected, "actual": actual})
        print(json.dumps({"files_checked": len(entries), "mismatches": mismatches}, indent=2))
        return 1 if mismatches else 0
    except (OSError, ValueError, subprocess.CalledProcessError) as exc:
        print(json.dumps({"error": str(exc)}))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
