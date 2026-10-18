"""Regulatory coverage restores exact original values through the one packaged reader and refuses late invalid evidence."""
import copy
import hashlib
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

import pyarrow as pa
import pyarrow.parquet as pq

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import restore_source_navigation_coverage as reader
from spicy_regs.etl_receipts import RECEIPT_SCHEMA, _digest, decode_exact_json, exact_json
from spicy_regs.transforms.regulations_receipts import write_held_dataset
from spicy_regs.transforms.regulations_shape import SOURCE_COLUMNS


def _member(path):
    return {"path":str(path.resolve()), "byteSize":path.stat().st_size,
            "sha256":"sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()}


def _fixture(root, count=3):
    schema = pa.schema([(name, pa.int64() if dtype == "BIGINT" else pa.string())
                        for name, dtype in SOURCE_COLUMNS["cfr_sections"]])
    rows = []
    for index in range(count):
        row = dict.fromkeys(schema.names)
        row.update(granule_id=f"CFR-2025-title7-sec1-{index}", package_id="CFR-2025-title7",
                   title="07", edition_year="2025", heading="Repeated heading", part_granule="False",
                   url="https://example.gov/source")
        rows.append(row)
    source = root / "source.parquet"
    pq.write_table(pa.Table.from_pylist(rows, schema=schema), source)
    subject, receipts = write_held_dataset("cfr_sections", source, root / "native", generation_id="selected")
    return {"dataset":"cfr_sections", "generationId":"selected", "subjects":[_member(subject)],
            "receipts":_member(receipts), "destination":str(root / "restored")}, rows


def _change_receipts(request, mutate):
    path = Path(request["receipts"]["path"])
    rows = pq.read_table(path).to_pylist()
    mutate(rows)
    pq.write_table(pa.Table.from_pylist(rows, schema=RECEIPT_SCHEMA), path)
    request["receipts"] = _member(path)


def _redigest(row):
    row["receipt_id"] = _digest({key:value for key, value in row.items() if key != "receipt_id"})


def _documents_fixture(root, full_source):
    names = ([name for name, _ in SOURCE_COLUMNS["documents"]] if full_source else
             [name for name, _ in reader.reviewed_schema("documents")])
    schema = pa.schema([(name, pa.string()) for name in names])
    raw = dict.fromkeys(names)
    raw.update(document_id="EPA-2026-0001-0002", docket_id="EPA-2026-0001", withdrawn="True",
               attachments_json='[ {"url":"https://example.gov/a.pdf","format":"pdf","size":7},'
                                ' {"url":"https://example.gov/a.pdf","format":"pdf","size":7} ]',
               file_url="https://example.gov/source", title="Retained document")
    source = root / "source.parquet"
    pq.write_table(pa.Table.from_pylist([raw], schema=schema), source)
    subject, receipts = write_held_dataset("documents", source, root / "native", generation_id="selected", bulk=True)
    request = {"dataset":"documents", "generationId":"selected", "subjects":[_member(subject)],
               "receipts":_member(receipts), "destination":str(root / "restored")}
    return request, raw


def _check_late_invalid_selected_evidence_never_exposes_coverage_output(tmp_path, change, count=3):
    request, _ = _fixture(tmp_path, count=count)
    def mutate(rows):
        row = next(row for row in reversed(rows) if row["outcome"] == "accepted")
        if change == "digest":
            row["receipt_id"] = "sha256:" + "0" * 64
            return
        if change == "version":
            row["subject_version"] = "sha256:" + "0" * 64
        elif change == "generation":
            row["generation_id"] = ""
        elif change == "failed-outcome":
            row["outcome"] = "error"
        else:
            values = decode_exact_json(row["processing_json"])
            if change == "raw":
                values["raw_conversion_inputs"]["heading"] = "Different retained value"
            else:
                values["input_metadata"] = {"dump_date":"different"}
            row["processing_json"] = exact_json(values)
        _redigest(row)
    _change_receipts(request, mutate)
    with unittest.TestCase().assertRaises((ValueError, TypeError)):
        reader.restore(request)
    destination = Path(request["destination"])
    assert not (destination / "coverage-facts.parquet").exists()
    assert not (destination / "provisional-coverage-facts.parquet").exists()


def _check_empty_success_preserves_schema_and_requires_consistent_observed_metadata(tmp_path):
    request, _ = _fixture(tmp_path, count=0)
    result = reader.restore(request)
    assert result["rows"] == 0
    assert pq.read_table(result["urls"][0]).schema == reader.arrow_schema("cfr_sections")
    request["destination"] = str(tmp_path / "bad-empty")
    def conflicting(rows):
        other = copy.deepcopy(rows[0])
        other["attempt_id"] += "-different"
        values = decode_exact_json(other["processing_json"])
        values["input_metadata"] = {"dump_date":"different"}
        other["processing_json"] = exact_json(values)
        _redigest(other)
        rows.append(other)
    _change_receipts(request, conflicting)
    with unittest.TestCase().assertRaisesRegex(ValueError, "Empty input metadata differs"):
        reader.restore(request)
    assert not (Path(request["destination"]) / "coverage-facts.parquet").exists()


class RegulatoryCoverageRestoreTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.root = Path(self.folder.name)

    def tearDown(self):
        self.folder.cleanup()

    def test_cfr_values_and_order_with_unrelated_rows(self):
        request, originals = _fixture(self.root)

        def add_unrelated(rows):
            other = {**rows[0], "dataset":"unrelated", "generation_id":"other", "receipt_id":"invalid"}
            rows.insert(1, other)
        _change_receipts(request, add_unrelated)
        result = reader.restore(request)
        actual = pq.read_table(result["urls"][0])
        self.assertEqual(actual.to_pylist(), [{name:row[name] for name in actual.schema.names} for row in originals])
        self.assertEqual(result["selection"], {key:request[key] for key in ("subjects", "receipts")})

    def test_documents_values_reviewed_and_full_source(self):
        for full_source in (False, True):
            with self.subTest(full_source=full_source):
                root = self.root / str(full_source)
                root.mkdir()
                request, raw = _documents_fixture(root, full_source)
                result = reader.restore(request)
                self.assertEqual(pq.read_table(result["urls"][0]).to_pylist(),
                                 [{name:raw[name] for name, _ in reader.reviewed_schema("documents")}])

    def test_register_and_docket_link_values_keep_order(self):
        for dataset in ("federal_register", "fr_docket_links"):
            with self.subTest(dataset=dataset):
                root = self.root / dataset
                root.mkdir()
                schema = pa.schema([(name, pa.int64() if dtype == "BIGINT" else pa.string())
                                    for name, dtype in SOURCE_COLUMNS[dataset]])
                rows = []
                for date, ordinal, docket in (("2025-06-30", 0, "EPA-1"), ("2026-06-30", None, "EPA-2")):
                    raw = dict.fromkeys(schema.names)
                    raw.update(document_number="2026-00001", publication_date=date, title="Repeated label")
                    if dataset == "fr_docket_links":
                        raw.update(docket_source_ordinal=ordinal, docket_id=docket)
                    rows.append(raw)
                source = root / "source.parquet"
                pq.write_table(pa.Table.from_pylist(rows, schema=schema), source)
                subject, receipts = write_held_dataset(dataset, source, root / "native", generation_id="selected")
                request = {"dataset":dataset, "generationId":"selected", "subjects":[_member(subject)],
                           "receipts":_member(receipts), "destination":str(root / "restored")}
                result = reader.restore(request)
                expected = [{name:raw[name] for name, _ in reader.reviewed_schema(dataset)} for raw in rows]
                self.assertEqual(pq.read_table(result["urls"][0]).to_pylist(), expected)

    def test_late_invalid_selected_evidence_never_exposes_coverage_output(self):
        for change in ("digest", "version", "raw", "generation", "metadata", "failed-outcome"):
            with self.subTest(change=change):
                root = self.root / change
                root.mkdir()
                _check_late_invalid_selected_evidence_never_exposes_coverage_output(root, change)

    def test_empty_success_preserves_schema_and_requires_consistent_observed_metadata(self):
        _check_empty_success_preserves_schema_and_requires_consistent_observed_metadata(self.root)

    def test_metadata_refusal_after_a_written_batch_removes_provisional_output(self):
        _check_late_invalid_selected_evidence_never_exposes_coverage_output(self.root, "metadata", count=2001)

    def test_earlier_policy_and_missing_field_refused_before_restoration(self):
        request, _ = _fixture(self.root)
        path = Path(request["receipts"]["path"])
        original = path.read_bytes()

        def earlier(rows):
            for row in rows:
                row["policy_version"] = "regulations/0"
                _redigest(row)
        _change_receipts(request, earlier)
        with self.assertRaisesRegex(ValueError, "Unsupported coverage receipt policy"):
            reader.restore(request)
        self.assertFalse(Path(request["destination"]).exists())

        path.write_bytes(original)
        pq.write_table(pq.read_table(path).drop_columns(["policy_version"]), path)
        request["receipts"] = _member(path)
        with self.assertRaisesRegex(ValueError, "Unsupported coverage receipt format"):
            reader.restore(request)
        self.assertFalse(Path(request["destination"]).exists())

    def test_non_mapping_request_is_refused(self):
        for request in ([], "cfr_sections", None):
            with self.subTest(request=request):
                with self.assertRaises(ValueError):
                    reader.restore(request)

    def test_each_restore_hashes_and_scans_receipts_once(self):
        (self.root / "cfr").mkdir()
        (self.root / "documents").mkdir()
        cfr, _ = _fixture(self.root / "cfr")
        documents, _ = _documents_fixture(self.root / "documents", False)
        for request in (cfr, documents):
            with self.subTest(dataset=request["dataset"]):
                with (patch.object(reader.MAINTAINED, "checked_member", wraps=reader.MAINTAINED.checked_member) as hashed,
                      patch.object(reader.MAINTAINED, "current_receipts", wraps=reader.MAINTAINED.current_receipts) as scanned):
                    reader.restore(request)
                paths = [call.args[0]["path"] for call in hashed.call_args_list]
                self.assertEqual(paths.count(request["receipts"]["path"]), 1)
                self.assertEqual(scanned.call_count, 1)


if __name__ == "__main__":
    unittest.main()
