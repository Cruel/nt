#!/usr/bin/env python3
"""Partition the exact Build CTest selection, preserving CTest dependencies."""
import argparse
from collections import Counter, defaultdict
import hashlib
import json
from pathlib import Path
import re
import subprocess

BUILD = Path("build/linux-debug")
PLAN = BUILD / "ci-native-shards.json"
CLI = r"^(native_cli_|native_authoring_cli_commands$)"
CLI_EXCLUDED = r"^(native_cli_(incremental_validation_certification|dependency_mutation_certification|shader_validation_cache|portable_validation_cache)|native_authoring_cli_commands)$"
SUITES = {
    "native": (["-E", CLI], 2),
    "cli": (["-R", CLI, "-E", CLI_EXCLUDED], 1),
}
SHARDS = {"native": 4, "cli": 2}


def inventory(build, flags=()):
    output = subprocess.check_output(
        ["ctest", "--test-dir", str(build), "--show-only=json-v1", *flags],
        text=True,
    )
    data = json.loads(output)
    if data["kind"] != "ctestInfo" or data["version"]["major"] != 1:
        raise ValueError("Unsupported CTest inventory")
    return data["tests"]


def properties(test):
    return {p["name"]: p["value"] for p in test["properties"]}


def identity(test):
    # CTest can add fixture-derived DEPENDS when filtering. The command,
    # working directory and name distinguish registered test occurrences.
    return (test["name"], tuple(test.get("command", [])),
            properties(test).get("WORKING_DIRECTORY"))


def members(tests):
    return Counter(identity(test) for test in tests)


def digest(tests):
    return hashlib.sha256(json.dumps(tests, sort_keys=True).encode()).hexdigest()


def flags_for(indices):
    # CTest's 1-based registration indices handle duplicate names and names
    # containing regex metacharacters. Set a one-test range explicitly: an
    # omitted range silently selects every registration, not just the list.
    if not indices:
        raise ValueError("Empty native test shard")
    return ["-I", f"{indices[0]},{indices[0]},1," + ",".join(map(str, indices))]


def partition(tests, weights):
    by_name = defaultdict(list)
    parent = list(range(len(tests)))
    for i, test in enumerate(tests):
        by_name[test["name"]].append(i)

    def root(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    def join(i, j):
        parent[root(j)] = root(i)

    fixtures = defaultdict(list)
    locks = defaultdict(list)
    selected = {}
    for i, test in enumerate(tests):
        name = test["name"]
        if not re.search(CLI, name):
            selected[i] = "native"
        elif not re.search(CLI_EXCLUDED, name):
            selected[i] = "cli"
        for j in by_name[name]:
            join(i, j)
        props = properties(test)
        for dependency in props.get("DEPENDS", []):
            if dependency not in by_name:
                raise ValueError(f"Unknown dependency {dependency} for {name}")
            for j in by_name[dependency]:
                join(i, j)
        for kind in ("FIXTURES_SETUP", "FIXTURES_REQUIRED", "FIXTURES_CLEANUP"):
            for fixture in props.get(kind, []):
                fixtures[fixture].append(i)
        for lock in props.get("RESOURCE_LOCK", []):
            locks[lock].append(i)
    for group in [*fixtures.values(), *locks.values()]:
        for j in group[1:]:
            join(group[0], j)

    groups = defaultdict(list)
    for i in range(len(tests)):
        groups[root(i)].append(i)
    result = {}
    for suite, (_, parallel) in SUITES.items():
        candidates = []
        for group in groups.values():
            if not any(selected.get(i) == suite for i in group):
                continue
            if any(selected.get(i) != suite for i in group):
                raise ValueError("Dependency/fixture/lock group crosses the original Build selectors: "
                                 + ", ".join(tests[i]["name"] for i in group))
            # Serial tests consume both native execution slots. Unknown cases
            # receive a small positive cost; weights never affect membership.
            cost = sum(weights.get(tests[i]["name"], 0.25) *
                       (parallel if properties(tests[i]).get("RUN_SERIAL") else 1)
                       for i in group)
            candidates.append((cost, group))
        bins = [[] for _ in range(SHARDS[suite])]
        costs = [0.0] * SHARDS[suite]
        for cost, group in sorted(candidates, key=lambda pair: (-pair[0], pair[1])):
            target = min(range(SHARDS[suite]), key=lambda i: (costs[i], i))
            bins[target].extend(i + 1 for i in group)
            costs[target] += cost
        for i, indices in enumerate(bins):
            result[f"{suite}-{i + 1}"] = sorted(indices)
            flags_for(indices)
            print(f"{suite}-{i + 1}: {len(indices)} tests, estimated slot-seconds {costs[i]:.1f}")
    # The partition is over registration occurrences, not unique names.
    expected = Counter(i + 1 for i in selected)
    actual = Counter(i for indices in result.values() for i in indices)
    if actual != expected:
        raise ValueError("Native shard union is incomplete or overlapping")
    return result


def verify_selection(build, tests, indices):
    expected = members(tests[i - 1] for i in indices)
    if members(inventory(build, flags_for(indices))) != expected:
        raise ValueError("CTest selected a different shard (including implicit fixtures)")


def make_plan(build, plan, weights):
    tests = inventory(build)
    shards = partition(tests, weights)
    for suite, (flags, _) in SUITES.items():
        indices = [i for key, values in shards.items() if key.startswith(suite + "-")
                   for i in values]
        if members(inventory(build, flags)) != members(tests[i - 1] for i in indices):
            raise ValueError(f"Shard union differs from original {suite} CTest selection")
    for indices in shards.values():
        verify_selection(build, tests, indices)
    plan.write_text(json.dumps({"inventory": digest(tests), "shards": shards}, indent=2) + "\n")


def run_shard(build, plan, shard):
    tests = inventory(build)
    recorded = json.loads(plan.read_text())
    if digest(tests) != recorded["inventory"]:
        raise ValueError("Restored CTest inventory differs from producer")
    indices = recorded["shards"][shard]
    verify_selection(build, tests, indices)
    subprocess.run(["ctest", "--test-dir", str(build),
                    "--output-on-failure", "--no-tests=error",
                    "--parallel", str(SUITES[shard.split("-")[0]][1]),
                    *flags_for(indices)], check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--build", type=Path, default=BUILD)
    parser.add_argument("--plan", type=Path, default=PLAN)
    sub = parser.add_subparsers(dest="mode", required=True)
    sub.add_parser("plan")
    run = sub.add_parser("run")
    run.add_argument("shard", choices=[f"{suite}-{i+1}" for suite in SUITES for i in range(SHARDS[suite])])
    args = parser.parse_args()
    if args.mode == "plan":
        weights = json.loads(Path(__file__).with_name("linux-native-test-costs.json").read_text())
        make_plan(args.build, args.plan, weights["seconds"])
    else:
        run_shard(args.build, args.plan, args.shard)


if __name__ == "__main__":
    main()
