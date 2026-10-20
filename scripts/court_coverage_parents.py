"""Prove the original court parent from complete, exact retained source witnesses."""
import re

import duckdb


def resolve_parent(adapter, child_id, owner, relation, bridge):
    identity = (owner["family"], owner["artifactDigest"])
    if identity in adapter.parent_cache:
        return adapter.parent_cache[identity]
    restored = adapter.restore(child_id, owner)
    groups = restored["_coverageProcessing"].get("acceptedWitnessGroups", [])
    if (not groups or any(type(g.get("rows")) is not int or g["rows"] <= 0 for g in groups)
            or sum(g["rows"] for g in groups) != owner["rows"]):
        raise ValueError("Accepted group receipts do not all witness the exact source member")
    pattern = rf"generations/{re.escape(owner['family'])}/[a-f0-9]{{64}}/{re.escape(child_id)}\.parquet"
    candidates = None
    for group in groups:
        witnessed = {(w["source_id"], w["sha256"]) for w in group["witnesses"]
                     if isinstance(w.get("source_id"), str) and re.fullmatch(pattern, w["source_id"])
                     and isinstance(w.get("sha256"), str) and re.fullmatch(r"sha256:[a-f0-9]{64}", w["sha256"])}
        candidates = witnessed if candidates is None else candidates & witnessed
    if not candidates:
        raise ValueError("Accepted group receipts do not all witness the exact source member")
    if len(candidates) != 1:
        raise ValueError("Accepted group receipts witness ambiguous source members")
    (source_key, source_hash), = candidates
    source_generation = "sha256:" + source_key.split("/")[2]
    if source_generation == owner["artifactDigest"]:
        raise ValueError("Native group source cannot be its own generation")
    prior = adapter.inputs.table(owner["family"], source_generation, child_id)
    key, artifact, members = adapter.inputs.artifact(prior["family"], prior["artifactDigest"])
    if (source_key != key + "/" + child_id + ".parquet" or len(prior["members"]) != 1
            or prior["members"][0]["key"] != child_id + ".parquet"
            or prior["members"][0]["sha256"] != source_hash or prior["rows"] != owner["rows"]):
        raise ValueError("Prior group bytes/rows differ from the witnessed source member")
    # An immediate source snapshot adds a check; later native conversions
    # retain the original source witness even when that snapshot names an intermediate.
    snapshot = owner["artifact"]["spec"].get("readSnapshot", {}).get("families", {}).get(owner["family"])
    if isinstance(snapshot, dict) and snapshot.get("artifactDigest") == source_generation:
        descriptor = snapshot.get("tables", {}).get(child_id + ".parquet")
        if not isinstance(descriptor, dict) or descriptor.get("members"):
            raise ValueError("Native group source descriptor is absent or unsupported")
        expected = [{"key": child_id + ".parquet", "sha256": descriptor.get("sha256"),
                     "rows": descriptor.get("rows"), "byteSize": descriptor.get("byteSize")}]
        if (prior["members"] != expected or snapshot.get("prefix") != key
                or descriptor.get("columns") != restored["_coverageProcessing"]["processingSchema"]):
            raise ValueError("Prior group bytes/schema differ from recorded source snapshot")
    source = next(m for m in members if m["objectKey"] == child_id + ".parquet")
    local = adapter.staging._member(key, source)
    with duckdb.connect() as conn:
        conn.execute("SET memory_limit='256MB'")
        conn.execute("SET threads=2")
        conn.read_parquet(restored["urls"]).create_view("restored_groups")
        conn.read_parquet(local["path"]).create_view("prior_groups")
        actual_schema = [list(row[:2]) for row in conn.execute("DESCRIBE prior_groups").fetchall()]
        if actual_schema != restored["_coverageProcessing"]["processingSchema"]:
            raise ValueError("Prior group physical schema differs from the restored processing schema")
        changed = conn.execute("SELECT count(*) FROM ((SELECT * FROM restored_groups EXCEPT ALL SELECT * FROM prior_groups) UNION ALL (SELECT * FROM prior_groups EXCEPT ALL SELECT * FROM restored_groups))").fetchone()[0]
        if changed:
            raise ValueError("Restored group rows differ from the witnessed prior input")
    parent = adapter.inputs.parent(child_id, prior, relation)
    _, parent_artifact, _ = adapter.inputs.artifact(parent["family"], parent["artifactDigest"])
    bridge(["--verify-artifacts"], request=[artifact, parent_artifact])
    chain = {"qualification": "Every restored group row equals its witnessed prior input; that release declares this parent.",
             "sourceTable": {k: prior[k] for k in ("family", "artifactDigest", "tableId", "recordUrl", "members", "rows")},
             "witnessSourceId": source_key, "matchedSourceRows": owner["rows"]}
    parent = {**parent, "_additionalParentEvidence": chain}
    adapter.parent_cache[identity] = parent
    return parent
