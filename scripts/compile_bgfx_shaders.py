#!/usr/bin/env python3
import argparse
import json
import pathlib
import subprocess
import sys


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--shaderc", required=True)
    parser.add_argument("--source-dir", required=True)
    parser.add_argument("--output-root", required=True)
    parser.add_argument("--variant", action="append", required=True)
    parser.add_argument("--include", action="append", default=[])
    parser.add_argument("--verify-only", action="store_true")
    args = parser.parse_args()

    manifest_path = pathlib.Path(args.manifest)
    source_dir = pathlib.Path(args.source_dir)
    output_root = pathlib.Path(args.output_root)
    manifest = json.loads(manifest_path.read_text())

    missing = []
    for variant in args.variant:
        if variant not in manifest["variants"]:
            print(f"unknown shader variant: {variant}", file=sys.stderr)
            return 2
        target = manifest["variants"][variant]
        out_dir = output_root / "shaders" / "bgfx" / variant
        if not args.verify_only:
            out_dir.mkdir(parents=True, exist_ok=True)
        for shader in manifest["shaders"]:
            for stage_key, stage, shader_type in (("vertex", "vs", "v"), ("fragment", "fs", "f")):
                source = source_dir / shader[stage_key]
                output = out_dir / f"{shader['name']}.{stage}.bin"
                if args.verify_only:
                    if not output.is_file():
                        missing.append(str(output))
                    continue
                command = [
                    args.shaderc,
                    "-f", str(source),
                    "-o", str(output),
                    "--type", shader_type,
                    "--platform", target["platform"],
                    "-p", target["profile"],
                    "-i", str(source_dir),
                ]
                for include in args.include:
                    command.extend(["-i", include])
                subprocess.run(command, check=True)

    if missing:
        print("missing compiled shader assets:", file=sys.stderr)
        for path in missing:
            print(path, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
