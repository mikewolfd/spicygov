import type { Dataset, Filter, Row } from './catalog';
export type BrowseField = {axis: string; column: string; label: string; description: string};
const congressTables = new Set(['amendments','bill_family_archives','bill_family_backfill_walks','bill_family_backfills','bill_sections','bill_vote_references','cbo_cost_estimates','cbo_feed_items','committee_assignments','committee_meetings','committee_reports','congress_bills','hearing_bill_links','hearing_transcripts','house_activity_reports','house_communications','law_code_sections','laws','member_votes','nominations','record_issues','roll_call_votes','scorecard_item_links','table3_records']);
const chamberTables = new Set(['amendments','bill_committee_actions','bill_committees','bill_vote_references','committee_assignments','committee_meetings','committee_reports','committees','hearing_bill_links','hearing_transcripts','house_communications','member_vote_terms','member_votes','press_releases','roll_call_votes','scorecard_item_links']);
const titleCaseChambers = new Set(['amendments','bill_committees','committees','house_communications','congress_bills','laws']);
const agencies = new Set(['agency_lifecycle_stats','agency_monthly_volume','agency_stats','comments','comments_index','discovery_signals','dockets','documents','feed_summary','proceedings','rulemaking_lifecycles','unified_agenda']);
const scalarCategory = /^(?:VARCHAR|TINYINT|SMALLINT|INTEGER|BIGINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|HUGEINT|UHUGEINT)$/;
/** Reviewed browsing categories. Equal labels alone never create record joins. */
export function browseFields(table: Dataset): BrowseField[] {
  const supported: [string,string,string][] = [];
  if (congressTables.has(table.id)) supported.push(['congress','congress',table.id==='house_activity_reports'?'Congress filed':'Congress']);
  if (table.id==='house_activity_reports') supported.push(['congress','covered_congress','Congress covered']);
  if (chamberTables.has(table.id)) supported.push(['chamber','chamber','Chamber']);
  if (['congress_bills','laws'].includes(table.id)) supported.push(['chamber','origin_chamber','Origin chamber']);
  if (congressTables.has(table.id)) supported.push(['session','session','Session within Congress'],['bill-type','bill_type','Bill type']);
  if (agencies.has(table.id)) supported.push(['agency','agency_code','Agency']);
  if (table.id.startsWith('fec_')) supported.push(['cycle','cycle','Election cycle'],['source-cycle','source_cycle','Source collection cycle']);
  if (['budget_volumes','fec_agency_reports','fec_report_metrics'].includes(table.id)) supported.push(['fiscal-year','fiscal_year','Fiscal year']);
  if (table.id==='cfr_sections') supported.push(['edition-year','edition_year','CFR edition year']);
  if (['scorecards','scorecard_publishers'].includes(table.id)) supported.push(['scorecard-publisher','publisher_id','Scorecard publisher']);
  return supported.flatMap(([axis,column,label])=>{const c=table.columns.find(c=>c.name===column&&scalarCategory.test(c.type));return c?[{axis,column,label,description:c.description}]:[]});
}
export function browseValue(field: BrowseField, raw: unknown): string | undefined {
  if (!['string','number','bigint'].includes(typeof raw)) return;
  const value=String(raw).trim(); if (!value) return;
  if (field.axis==='chamber') return ({house:'House','house of representatives':'House',senate:'Senate',joint:'Joint'} as Record<string,string>)[value.toLowerCase()];
  if (field.axis==='congress') return /^(\d{1,3})(?:(?:st|nd|rd|th) Cong\.)?$/.exec(value)?.[1];
  if (['session','cycle','source-cycle','fiscal-year','edition-year'].includes(field.axis)) return /^\d{1,4}$/.test(value)?value:undefined;
  return value;
}
function exactFilter(table: Dataset, field: BrowseField, value: string): Filter {
  if (field.axis==='chamber') {
    const v=titleCaseChambers.has(table.id)?value:value.toLowerCase();
    return {column:field.column,value:v,...(table.id==='amendments'&&value==='House'?{values:['House','House of Representatives']}:{})};
  }
  if (field.axis==='congress'&&table.id==='table3_records') {const n=Number(value), suffix=n%100>=11&&n%100<=13?'th':({1:'st',2:'nd',3:'rd'} as Record<number,string>)[n%10]??'th';return {column:field.column,value,values:[value,value+suffix+' Cong.']};}
  return {column:field.column,value};
}
export function browseTargets(catalog: Dataset[], field: BrowseField, raw: unknown, context?: string) {
  const value=browseValue(field,raw);if (value===undefined) return [];
  if (field.axis==='session'&&!context?.match(/^\d{1,3}$/)) return [];
  return catalog.flatMap(table=>{
    if (!table.rows || table.recordsAvailable===false || !['current','older-publication'].includes(table.metadataState)) return [];
    return browseFields(table).filter(f=>f.axis===field.axis).flatMap(f=>{
      const filters=[exactFilter(table,f,value)];
      if (f.axis==='session') {const congress=browseFields(table).find(c=>c.column==='congress');if(!congress)return [];filters.unshift(exactFilter(table,congress,context!));}
      return [{table,field:f,value,filters}];
    });
  });
}
export function congressContext(table: Dataset, row: Row | undefined, filters: Filter[]): string | undefined {
  const field=browseFields(table).find(f=>f.column==='congress');
  if(!field)return;
  if(row?.congress!=null)return browseValue(field,row.congress);
  const filter=filters.find(f=>f.column==='congress');
  if(!filter)return;
  const values=(filter.values??[filter.value]).map(v=>browseValue(field,v));
  return values[0]!==undefined&&values.every(v=>v===values[0])?values[0]:undefined;
}
