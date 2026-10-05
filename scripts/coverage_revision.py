"""Reuse reviewed legacy measurements only while their exact dependencies match.

The legacy scanner remains separate from native restoration. This check retains
its original revision; a changed legacy function or reader forces a fresh scan.
"""

import ast
import hashlib
import json
from pathlib import Path


def legacy_revision(root, driver):
    proof = json.loads(
        (Path(root) / "content/legacy-coverage-compatibility.v1.json").read_text()
    )
    if (
        proof.get("format") != "spicygov-legacy-coverage-compatibility"
        or proof.get("version") != 1
    ):
        return None
    for name, expected in proof["files"].items():
        if (
            hashlib.sha256((Path(root) / "scripts" / name).read_bytes()).hexdigest()
            != expected
        ):
            return None
    text = Path(driver).read_text()
    lines = text.splitlines()
    tree = ast.parse(text)
    extra_imports = {
        ("contextlib", ("ExitStack",)),
        ("native_legislative_coverage", ("processing_context", "variant")),
    }
    top = [
        node
        for node in tree.body
        if not isinstance(node, ast.FunctionDef)
        and not (
            isinstance(node, ast.ImportFrom)
            and (node.module, tuple(alias.name for alias in node.names))
            in extra_imports
        )
    ]
    if (
        hashlib.sha256(
            "".join(
                "\n".join(lines[node.lineno - 1 : node.end_lineno]) + "\n"
                for node in top
            ).encode()
        ).hexdigest()
        != proof["topLevelSha256"]
    ):
        return None
    nodes = {n.name: n for n in tree.body if isinstance(n, ast.FunctionDef)}
    for name, expected in proof["functions"].items():
        if name not in nodes:
            return None
        node = nodes[name]
        body = "\n".join(lines[node.lineno - 1 : node.end_lineno]) + "\n"
        # These exact additions select the separate native path; legacy values take the original branch.
        if name == "cached":
            body = body.replace(
                "measurement_revision(policy)", "measurement_revision()"
            )
        if name == "validate_plan":
            body = body.replace(
                "policy = policies[id] = variant(id, table, policies[id])",
                "policy = policies[id]",
            )
            body = body.replace(
                "validate_definition(policy, schema(policy.get('processingSchema', expected)))",
                "validate_definition(policy, expected)",
            )
        if hashlib.sha256(body.encode()).hexdigest() != expected:
            return None
    adapter = (Path(root) / "scripts/native_legislative_coverage.py").read_text()
    adapter_lines = adapter.splitlines()
    guard = next(
        (
            node
            for node in ast.parse(adapter).body
            if isinstance(node, ast.FunctionDef) and node.name == "variant"
        ),
        None,
    )
    if guard is None:
        return None
    body = "\n".join(adapter_lines[guard.lineno - 1 : guard.end_lineno]) + "\n"
    if hashlib.sha256(body.encode()).hexdigest() != proof["nativeLegacyGuardSha256"]:
        return None
    return proof["measurementRevision"]
