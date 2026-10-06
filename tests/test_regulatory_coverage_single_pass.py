"""The efficient adapter preserves full admission, exact values, and late refusals."""
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


def _check_one_admission_matches_original_row_reader_and_preserves_order(tmp_path):
    request, originals = _fixture(tmp_path)
    old_request = {**copy.deepcopy(request), "destination":str(tmp_path / "reference")}
    reference = reader.MAINTAINED.restore(old_request)
    def add_unrelated(rows):
        other = {**rows[0], "dataset":"unrelated", "generation_id":"other", "receipt_id":"invalid"}
        rows.insert(1, other)
    _change_receipts(request, add_unrelated)
    with patch.object(reader, "read_with_receipts", wraps=reader.read_with_receipts) as visit, patch.object(
            reader.MAINTAINED, "restore", side_effect=AssertionError("No redundant generic restore")):
        result = reader.restore(request)
    assert visit.call_count == 1
    actual = pq.read_table(result["urls"][0])
    assert actual.equals(pq.read_table(reference["urls"][0]).select(actual.schema.names), check_metadata=False)
    assert actual.to_pylist() == [{name:row[name] for name in actual.schema.names} for row in originals]
    assert result["selection"] == {key:request[key] for key in ("subjects", "receipts")}


def _check_documents_uses_bulk_for_reviewed_source_and_keeps_row_fallback_parity(tmp_path, full_source):
    names = ([name for name, _ in SOURCE_COLUMNS["documents"]] if full_source else
             [name for name, _ in reader.reviewed_schema("documents")])
    schema = pa.schema([(name, pa.string()) for name in names])
    raw = dict.fromkeys(names)
    raw.update(document_id="EPA-2026-0001-0002", docket_id="EPA-2026-0001", withdrawn="True",
               attachments_json='[ {"url":"https://example.gov/a.pdf","format":"pdf","size":7},'
                                ' {"url":"https://example.gov/a.pdf","format":"pdf","size":7} ]',
               file_url="https://example.gov/source", title="Retained document")
    source = tmp_path / "source.parquet"
    pq.write_table(pa.Table.from_pylist([raw], schema=schema), source)
    subject, receipts = write_held_dataset("documents", source, tmp_path / "native", generation_id="selected", bulk=True)
    request = {"dataset":"documents", "generationId":"selected", "subjects":[_member(subject)],
               "receipts":_member(receipts), "destination":str(tmp_path / "restored")}
    with patch.object(reader.regulations_bulk, "_materialize_selected",
                      wraps=reader.regulations_bulk._materialize_selected) as bulk, patch.object(
            reader, "read_with_receipts", wraps=reader.read_with_receipts) as row:
        result = reader.restore(request)
    assert bulk.call_count == 1
    assert row.call_count == int(full_source)
    assert pq.read_table(result["urls"][0]).to_pylist() == [
        {name:raw[name] for name, _ in reader.reviewed_schema("documents")}]


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
            row["generation_id"] = "different"
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


class RegulatoryCoverageSinglePassTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.root = Path(self.folder.name)

    def tearDown(self):
        self.folder.cleanup()

    def test_one_admission_matches_original_row_reader_and_preserves_order(self):
        _check_one_admission_matches_original_row_reader_and_preserves_order(self.root)

    def test_documents_uses_bulk_for_reviewed_source_and_keeps_row_fallback_parity(self):
        for full_source in (False, True):
            with self.subTest(full_source=full_source):
                root = self.root / str(full_source)
                root.mkdir()
                _check_documents_uses_bulk_for_reviewed_source_and_keeps_row_fallback_parity(root, full_source)

    def test_register_bulk_dispatch_keeps_full_keys_order_and_exact_row_fallback(self):
        for dataset in ('federal_register', 'fr_docket_links'):
            with self.subTest(dataset=dataset):
                root = self.root / dataset
                root.mkdir()
                schema = pa.schema([(name, pa.int64() if dtype == 'BIGINT' else pa.string())
                                    for name, dtype in SOURCE_COLUMNS[dataset]])
                rows = []
                for date, ordinal, docket in (('2025-06-30', 0, 'EPA-1'), ('2026-06-30', None, 'EPA-2')):
                    raw = dict.fromkeys(schema.names)
                    raw.update(document_number='2026-00001', publication_date=date, title='Repeated label')
                    if dataset == 'fr_docket_links':
                        raw.update(docket_source_ordinal=ordinal, docket_id=docket)
                    rows.append(raw)
                source = root / 'source.parquet'
                pq.write_table(pa.Table.from_pylist(rows, schema=schema), source)
                subject, receipts = write_held_dataset(dataset, source, root / 'native', generation_id='selected')
                request = {'dataset':dataset, 'generationId':'selected', 'subjects':[_member(subject)],
                           'receipts':_member(receipts), 'destination':str(root / 'restored')}
                with patch.object(reader.regulations_bulk, '_materialize_selected',
                                  wraps=reader.regulations_bulk._materialize_selected) as bulk, patch.object(
                        reader, 'write_regulatory_facts', side_effect=AssertionError('Unexpected row fallback')):
                    result = reader.restore(request)
                self.assertEqual(bulk.call_count, 1)
                expected = [{name:raw[name] for name, _ in reader.reviewed_schema(dataset)} for raw in rows]
                actual = pq.read_table(result['urls'][0])
                self.assertEqual(actual.to_pylist(), expected)
                request['destination'] = str(root / 'fallback')
                with patch.object(reader.regulations_bulk, '_materialize_selected',
                                  side_effect=reader.etl_bulk.NotBulkEligible('Forced unproven batch')):
                    fallback = reader.restore(request)
                self.assertTrue(actual.equals(pq.read_table(fallback['urls'][0]), check_metadata=True))

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

    def test_metadata_refusal_precedes_later_reproduction_refusal(self):
        request, _ = _fixture(self.root)
        def mutate(rows):
            accepted = [row for row in rows if row["outcome"] == "accepted"]
            values = decode_exact_json(accepted[1]["processing_json"])
            values["input_metadata"] = {"dump_date": "different"}
            accepted[1]["processing_json"] = exact_json(values)
            _redigest(accepted[1])
            values = decode_exact_json(accepted[2]["processing_json"])
            values["raw_conversion_inputs"]["heading"] = "Different native heading"
            accepted[2]["processing_json"] = exact_json(values)
            _redigest(accepted[2])
        _change_receipts(request, mutate)
        with self.assertRaisesRegex(ValueError, "Regulatory input metadata differs across selected receipts"):
            reader.restore(request)
        self.assertFalse((Path(request["destination"]) / "coverage-facts.parquet").exists())
        self.assertFalse((Path(request["destination"]) / "provisional-coverage-facts.parquet").exists())


if __name__ == "__main__":
    unittest.main()
