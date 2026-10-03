import type { Dataset } from './catalog';
export type Source = { id: string; name: string; note: string; url?: string; families: string[]; derived?: boolean };
// Source routes verified against SpicyRegs pipeline/transform definitions, 2026-10-03.
export const sources: Source[] = [
  { id:'congress', name:'Congress.gov & GovInfo', note:'Bills, amendments, congressional activity, reports and their extracted text.', url:'https://www.congress.gov/', families:['bill-family','bill-subjects','amendments','committee-meetings','committee-reports','house-communications','nominations','treaties','record-issues','crs-reports','print-citations'] },
  { id:'rosters', name:'Congressional committee rosters', note:'Congress.gov committee records and community-maintained membership files.', url:'https://github.com/unitedstates/congress-legislators', families:['committee-rosters'] },
  { id:'members', name:'United States project', note:'Community-maintained legislator identities, terms and party affiliations.', url:'https://github.com/unitedstates/congress-legislators', families:['members'] },
  { id:'votes', name:'House Clerk & Senate', note:'Recorded roll calls and each member’s position.', url:'https://clerk.house.gov/Votes', families:['roll-call-votes'] },
  { id:'appropriations', name:'House & Senate Appropriations', note:'Committee press-release feeds; bill links are added by SpicyGov.', url:'https://appropriations.house.gov/', families:['press-releases'] },
  { id:'laws', name:'Congress.gov, GovInfo & U.S. Code', note:'Enacted laws, printed law text and Office of the Law Revision Counsel code mappings.', url:'https://uscode.house.gov/', families:['laws'] },
  { id:'cfr', name:'GovInfo — Code of Federal Regulations', note:'Section metadata from published CFR volumes.', url:'https://www.govinfo.gov/app/collection/cfr', families:['cfr-sections'] },
  { id:'regulations', name:'Regulations.gov', note:'Regulatory dockets, documents and extracted attributes; comment material also uses Mirrulations.', url:'https://www.regulations.gov/', families:['dockets','documents','docket-attributes','document-attributes','comment-attributes'] },
  { id:'register', name:'FederalRegister.gov', note:'Published rules, proposed rules and notices from the public API.', url:'https://www.federalregister.gov/', families:['federal-register'] },
  { id:'agenda', name:'RegInfo.gov', note:'Unified Agenda editions describing agency rulemaking plans.', url:'https://www.reginfo.gov/public/do/eAgendaMain', families:['unified-agenda'] },
  { id:'fcc', name:'Federal Communications Commission', note:'Proceedings and filings from the Electronic Comment Filing System.', url:'https://www.fcc.gov/ecfs/', families:['fcc-filings','fcc-proceedings'] },
  { id:'fec', name:'Federal Election Commission', note:'Official APIs, bulk files, filings and retained source documents; query tables organize those observations.', url:'https://www.fec.gov/data/', families:['fec-candidate-history','fec-committee-history','fec-committees','fec-observations','fec-query','fec-source-catalog'] },
  { id:'courts', name:'CourtListener / Free Law Project', note:'Court dockets, opinions and citations from RECAP and bulk exports; some tables group or extract these records.', url:'https://www.courtlistener.com/', families:['court-citations','court-docket-groups','court-opinion-clusters','court-opinion-pdf-extractions','court-opinions','courtlistener'] },
  { id:'gao', name:'Government Accountability Office', note:'Reports, decisions and open recommendations from GAO, with GovInfo listings.', url:'https://www.gao.gov/', families:['gao-reports','gao-recommendations'] },
  { id:'lobbying', name:'Senate lobbying disclosures', note:'Lobbying Disclosure Act filings, activities and named lobbyists.', url:'https://lda.senate.gov/', families:['lobbying-filings'] },
  { id:'senate-spending', name:'Secretary of the Senate via GovInfo', note:'Rows extracted from semiannual expenditure-report PDFs; reads may cover only part of a report.', url:'https://www.govinfo.gov/app/collection/CDOC', families:['senate-expenditures'] },
  { id:'sam', name:'SAM.gov', note:'Registered entity records from the Entity API.', url:'https://sam.gov/', families:['sam-entities'] },
  { id:'spending', name:'USAspending.gov', note:'Recipient records from the public spending API.', url:'https://www.usaspending.gov/', families:['usaspending-recipients'] },
  { id:'scorecards', name:'Scorecard publishers', note:'Selected editions from the publishers named in each record. Ratings express the publisher’s position.', families:['scorecards'] },
  { id:'derived', name:'Calculated from other tables', note:'SpicyGov counts, extracted references and links across regulatory, congressional, election and scorecard data.', families:['agency-monthly-volume','agency-stats','discovery-signals','feed-summary','fr-docket-links','member-vote-terms','native-legal-references','org-committee-links','scorecard-analysis'], derived:true },
];
export const unlistedSource: Source = {id:'unlisted',name:'Source not yet documented',note:'Newly published tables awaiting a source summary. Check each table’s field descriptions and source URLs.',families:[]};
export function sourceFor(table: Dataset): Source {
  return sources.find(s=>s.families.includes(table.family)) ?? unlistedSource;
}
const tableNotes: Record<string,string> = {
  bill_actions:'GovInfo BILLSTATUS action entries',
  cbo_cost_estimates:'Congressional Budget Office estimates', cbo_feed_items:'Congressional Budget Office feed',
  bill_summaries:'Model-generated bill summaries',diff_summaries:'Model-generated change summaries',section_classifications:'Model-generated section classifications',
  financial_changes:'Changes derived from bill text',section_diffs:'Differences between bill versions',section_diff_items:'Individual differences between bill versions',public_activity_events:'Events assembled from source records',
  scorecard_member_links:'Scorecards + congressional member identities', scorecard_item_links:'Scorecards + bills, amendments and roll calls',
  org_committee_links:'Commenter organizations + FEC committees',fr_docket_links:'Federal Register + regulatory dockets',member_vote_terms:'Member votes + historical legislator terms',
  agency_stats:'Counts from regulatory dockets, documents and comments',agency_monthly_volume:'Monthly counts of regulatory documents',discovery_signals:'Changes in agency document volume',feed_summary:'Dockets + comment counts + comment deadlines',
  native_legal_references:'References extracted from retained legal XML',native_legal_reference_reads:'Evidence of legal-reference extraction reads',
};
export function sourceNote(table: Dataset): string | undefined { return tableNotes[table.id]; }
