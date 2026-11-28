import titles from '../content/catalog-titles.json';
/** Editorial descriptions explain use; source evidence and qualifications remain separate. */
const purposes: Record<string, string> = {
  'administration-policy': 'White House statements explaining its position on bills in Congress.',
  cbo: 'Congressional Budget Office estimates of how proposed laws affect federal spending and revenue.',
  'cbo-data': 'Congressional Budget Office Open Data series covering 10-year and long-term budget and economic projections, historical data, demographics, revenue and spending detail, trust funds, tax parameters, and automatic stabilizers.',
  'cbo-eval-projections': 'Congressional Budget Office historical baseline projections, realized budget actuals, baseline revision changes, and forecast error evaluations.',
  'census-geocoder': 'Bounded U.S. Census 2020 single-record address and coordinate geocoder lookup outcomes and returned geography layers.',
  'cftc-comments': 'Public comments on Commodity Futures Trading Commission proposals.',
  'cms-part-b-associations': 'Medicare Part B supporting HCPCS drug-use summaries and non-additive manufacturer associations, kept separate from spending totals so manufacturer multiplicity never inflates spending.',
  'congress-committees': 'Congressional committee names and history, for identifying committees across records.',
  'congress-sessions': 'Official House and Senate session dates and party control records across Congresses.',
  'courtlistener-bankruptcy-dockets': 'Archival CourtListener 2022-09-19 bankruptcy docket export across 94 federal bankruptcy courts (plus five non-bankruptcy courts matching court_id LIKE \'%b\'; eight bankruptcy appellate panels are absent).',
  'courtlistener-bulk': 'CourtListener files containing court records for research across cases.',
  ferc: 'Federal Energy Regulatory Commission filings, comments and docket documents.',
  'inspectors-general-archive': 'An archived list of inspector general reports. The listed report documents have not been downloaded.',
  'sec-comments': 'Public comments submitted on Securities and Exchange Commission proposals.',
  'sec-edgar': 'Selected SEC EDGAR issuer filings and US-GAAP financial facts with explicit amendment and period scope.',
  'sec-rulemaking-pages': 'Securities and Exchange Commission pages describing rulemaking. These pages are separate from comment documents.',
  'supreme-court': 'Supreme Court opinion listings and documents for researching decisions.',
  'treasury-debt-to-the-penny': 'Treasury records of daily federal debt totals.',
  'treasury-monthly-statement': 'Treasury monthly reports of federal receipts, spending and balances.',
  uscode: 'U.S. Code releases and section structure for locating federal laws. Section text is separate work.',
  'usitc-edis': 'U.S. International Trade Commission investigation filings and attachments.',
  'agency-monthly-volume': 'Monthly counts of collected regulatory documents by agency.',
  'agency-stats': 'Counts of collected dockets, documents and comments by agency.',
  amendments: 'Proposed changes to bills, with sponsors and links to the legislation they would change.',
  'bill-family': 'Bills, their text, actions and summaries for following legislation through Congress.',
  'bill-subjects': 'Subject labels assigned to bills, for finding legislation by topic.',
  'cfr-sections': 'Sections of the Code of Federal Regulations, for looking up federal agency rules.',
  'cms-medicaid': 'Medicaid drug spending records, for comparing reported spending by drug and year.',
  'cms-part-b': 'Medicare Part B drug spending records, for comparing reported spending by drug and year.',
  'cms-part-d': 'Medicare Part D drug spending records, for comparing reported spending by drug and year.',
  'comment-attributes': 'Information describing public comments, for filtering and comparing submissions.',
  'comments-mirror': 'A saved subset of public comment files. The wider Mirrulations collection is kept elsewhere by choice.',
  comments: 'Published public comment tables. Related saved source files are listed separately; the wider Mirrulations collection is kept elsewhere by choice.',
  'committee-meetings': 'Congressional committee meetings, hearings and related documents.',
  'committee-reports': 'Congressional committee reports explaining legislation and committee work.',
  'committee-rosters': 'Committee memberships, for finding which members served on each committee.',
  'court-citations': 'References between court decisions, for following cited cases.',
  'court-docket-groups': 'Groups of related court dockets, for following connected cases.',
  'court-opinion-clusters': 'Related opinions grouped by court decision.',
  'court-opinion-pdf-extractions': 'Text read from court opinion documents, for searching their contents.',
  'court-opinions': 'Court opinions, for researching decisions and their reasoning.',
  courtlistener: 'Court case dockets and related records from CourtListener.',
  'crs-report-files': 'Receipt-verified Congressional Research Service report PDF and HTML files with embedded extracted text pinned to exact metadata revisions.',
  'crs-reports': 'Congressional Research Service reports explaining policy issues for Congress.',
  'discovery-signals': 'Recorded leads to additional public records that may need collection or review.',
  'docket-attributes': 'Information describing regulatory dockets, for filtering related proceedings.',
  dockets: 'Regulatory dockets that group proposals, supporting documents and comments.',
  'document-attributes': 'Information describing regulatory documents, for filtering and comparing records.',
  documents: 'Regulatory documents and their source information.',
  'executive-orders': 'Executive order records, for finding presidential directives.',
  'fcc-filings': 'Filings submitted to Federal Communications Commission proceedings.',
  'fcc-proceedings': 'Federal Communications Commission proceedings and their identifying information.',
  'fec-candidate-history': 'Federal Election Commission candidate records across recorded election periods.',
  'fec-committee-history': 'Federal Election Commission committee records across recorded election periods.',
  'fec-committees': 'Federal campaign committee records, for identifying the organizations that file reports.',
  'fec-election-results': 'Official Federal Election Commission Federal Elections workbook results and literal worksheet rows across reviewed Presidential, Senate, and House editions.',
  'fec-observations': 'Saved Federal Election Commission source records and the evidence identifying them.',
  'fec-query': 'Federal campaign finance filings, transactions and related records for research. Totals require checks for amendments and overlapping reports.',
  'fec-research-profiles': 'Disclosed FEC committee relationships, reconciled selected-report contribution breakdowns, and candidate outside-spending profiles with explicit interpretation limits.',
  'fec-source-catalog': 'A list of Federal Election Commission source files and their recorded scope.',
  'fec-financial-profiles': 'Reported campaign finance figures grouped for research. Amendments and overlapping reports can affect comparisons.',
  'federal-register': 'Federal Register notices, proposed rules and final rules published by federal agencies.',
  'feed-summary': 'Summaries of collected updates, for seeing recent activity in the saved records.',
  'foreign-assistance': 'Reported U.S. foreign assistance country, regional, and global fiscal-period measures and retained summary snapshots, keeping financial measures and dollar bases separate.',
  'fr-docket-links': 'Links between Federal Register documents and regulatory dockets.',
  'gao-recommendations': 'Government Accountability Office recommendations for improving federal programs.',
  'gao-reports': 'Government Accountability Office reports and decisions about federal programs and spending.',
  'grants-opportunities': 'Grants.gov funding opportunities, for finding federal grant announcements.',
  'house-communications': 'Communications submitted to the House of Representatives.',
  'house-disclosures': 'House Clerk annual financial disclosure indexes, retained Periodic Transaction Report PDFs, parsed native transactions, and explicit reading refusals.',
  laws: 'Enacted laws and links to their sections and the U.S. Code.',
  'lobbying-filings': 'Lobbying disclosures describing clients, lobbyists and reported activity.',
  'member-vote-terms': 'Links between members’ votes and their periods of congressional service.',
  members: 'Members of Congress, their terms of service and party affiliations.',
  'native-legal-references': 'Legal citations found in source documents, for following references to other laws and rules.',
  nominations: 'Presidential nominations and their progress through the Senate.',
  'nppes-providers': 'CMS National Plan and Provider Enumeration System (NPPES) Version 2 provider and sidecar observations, for looking up providers by NPI with deactivation and reactivation history.',
  'ofac-sanctions': 'Treasury sanctions lists and related records, for researching listed entities.',
  'org-committee-links': 'Links between organizations and committees recorded in the collected data.',
  'press-releases': 'Collected public press releases, for following official announcements.',
  'print-citations': 'References found in congressional reports and other printed documents.',
  'record-issues': 'Issues of the Congressional Record documenting congressional proceedings.',
  'roll-call-votes': 'Recorded congressional votes and how each member voted.',
  rulemaking: 'Links between regulatory plans, proposals, comments and final actions.',
  'sam-entities': 'Organizations registered in the System for Award Management, for identifying entities in federal award records.',
  'scorecard-analysis': 'Links and comparisons between advocacy scorecards and congressional activity.',
  scorecards: 'Published scorecards and ratings of lawmakers. Each publisher uses its own methods.',
  'senate-disclosures': 'Senate eFD Periodic Transaction Report listings, parsed electronic transactions with reported dollar ranges, and explicit unsupported paper observations.',
  'senate-expenditures': 'Reported Senate office spending, for researching expenditure records.',
  'treasury-fiscal': 'Treasury debt and monthly financial statement records.',
  treaties: 'Treaties submitted to the Senate and related actions.',
  'unified-agenda': 'Agency plans for upcoming regulatory actions, for following proposed changes over time.',
  'usaspending-recipients': 'Federal award recipient information, for identifying organizations in spending records.',
  'uscode-editions': 'U.S. Code editions and section structure, for locating laws in a particular edition.',
  'white-house-actions': 'Retained White House presidential action page versions with literal publication and modification timestamps and explicit official-document match status.',
};
export function collectionCopyKey(id: string) {
  const key = id.replace(/^[^:]+:/, '').replace(/^retained-/, '').replace(/-originals$/, '');
  const aliases: Record<string, string> = { 'edis-filings': 'usitc-edis', 'inspectors-general': 'inspectors-general-archive' };
  return aliases[key] ?? key;
}
export function catalogPurpose(id: string): string | undefined { return purposes[collectionCopyKey(id)]; }
export function catalogTitle(id: string): string | undefined {
  const key = collectionCopyKey(id);
  return Object.hasOwn(titles.collections, key) ? (titles.collections as Record<string, string>)[key] : undefined;
}

/** Current display names are shared by Explore and Sources; dated review text stays unchanged. */
export function tableTitle(id: string, fallback: string): string {
  return Object.hasOwn(titles.tables, id) ? (titles.tables as Record<string, string>)[id] : fallback;
}

/** Current explanations can correct dated editorial wording without changing its evidence. */
export function tablePurpose(id: string): string | undefined {
  const purposes: Record<string, string> = {
    scorecard_metric_items: 'Links votes and other actions to ratings. Shows whether they count when the publisher specifies it.',
  };
  return Object.hasOwn(purposes, id) ? purposes[id] : undefined;
}
