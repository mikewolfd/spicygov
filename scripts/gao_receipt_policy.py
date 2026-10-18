"""The explicit GAO subject schemas coverage has reviewed, by declared receipt policy.

government-sources/2 added the three major-rule letter columns to gao_reports.
government-sources/4 (gao_reports) adds url, source and citation_product_id, and
government-sources/3 (gao_decisions) adds listing_page and source. These are
subject values; raw letter readings and source origins stay in shared receipts.
The government_etl_policy Arrow metadata marker remains 1 in that writer.
"""

import pyarrow as pa


GAO_REPORT_V2_SCHEMA = pa.schema([
    ('report_id', pa.string()), ('title', pa.string()), ('report_type', pa.string()),
    ('published_date', pa.date32()), ('abstract', pa.string()),
    ('agencies', pa.list_(pa.string())), ('topics', pa.list_(pa.string())),
    ('product_type', pa.string()), ('report_number', pa.string()),
    ('requester_type', pa.string()), ('requester_committees', pa.list_(pa.string())),
    ('requester_members', pa.list_(pa.string())), ('recommendation_count', pa.int64()),
    ('matters_for_congress_count', pa.int64()), ('page_count', pa.int64()),
    ('subject_terms', pa.list_(pa.string())), ('major_rule_agency', pa.string()),
    ('major_rule_rins', pa.list_(pa.string())),
    ('major_rule_fr_citations', pa.list_(pa.string())),
], metadata={b'government_etl_policy': b'1'})

# url and source follow topics; citation_product_id comes last.
GAO_REPORT_V4_SCHEMA = (GAO_REPORT_V2_SCHEMA.insert(7, pa.field('url', pa.string()))
                        .insert(8, pa.field('source', pa.string()))
                        .append(pa.field('citation_product_id', pa.string())))

GAO_DECISION_V3_SCHEMA = pa.schema([
    ('decision_number', pa.string()), ('b_numbers', pa.list_(pa.string())),
    ('decision_type', pa.string()), ('title', pa.string()), ('topics', pa.list_(pa.string())),
    ('url', pa.string()), ('listing_page', pa.string()), ('source', pa.string()),
    ('released_date', pa.date32()), ('decided_date', pa.date32()),
    ('decision_status', pa.string()), ('outcome', pa.string()),
    ('b_numbers_truncated', pa.bool_()),
], metadata={b'government_etl_policy': b'1'})

REVIEWED_SCHEMAS = {('gao_reports', 'government-sources/2'): GAO_REPORT_V2_SCHEMA,
                    ('gao_reports', 'government-sources/4'): GAO_REPORT_V4_SCHEMA,
                    ('gao_decisions', 'government-sources/3'): GAO_DECISION_V3_SCHEMA}


def reviewed_gao_schema(descriptor):
    """The exact schema reviewed for this declared policy, or None when the policy is not a reviewed GAO one."""
    return REVIEWED_SCHEMAS.get((descriptor['dataset'], descriptor['policy_version']))


def validate_gao_schema(schema, reviewed):
    # Parquet normalizes list child names; names/order/types/nullability remain exact.
    if not schema.equals(reviewed, check_metadata=False):
        raise ValueError('Unsupported GAO subject schema for its declared receipt policy')
