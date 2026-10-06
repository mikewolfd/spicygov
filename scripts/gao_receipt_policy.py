"""The explicit GAO report policy added by the current government writer.

Only government-sources/2 adds the three major-rule letter columns. These are
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


def is_gao_report_v2(descriptor):
    return (descriptor['dataset'] == 'gao_reports'
            and descriptor['policy_version'] == 'government-sources/2'
            and descriptor['identity_fields'] == ['report_id'])


def validate_gao_report_v2_schema(schema):
    # Parquet normalizes list child names; names/order/types/nullability remain exact.
    if not schema.equals(GAO_REPORT_V2_SCHEMA, check_metadata=False):
        raise ValueError('Unsupported government-sources/2 GAO report schema')
