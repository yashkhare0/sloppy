import type { ColumnDef, OnChangeFn, SortingState } from '@tanstack/react-table';
import { Badge } from '@/components/ui/badge';
import { DataTable, SortHeading } from './data-table';
import { BlankState } from './report-ui';
import type { Finding, ProjectDetails } from './report-contract';

const findingColumns: ColumnDef<Finding>[] = [
  {
    accessorKey: 'level', size: 100, sortDescFirst: false,
    header: ({ column }) => <SortHeading column={column}>Severity</SortHeading>,
    cell: ({ row }) => <Badge variant={row.original.blocksGate ? 'destructive' : 'secondary'}>{row.original.level}</Badge>,
  },
  {
    accessorKey: 'message', size: 460, sortDescFirst: false,
    header: ({ column }) => <SortHeading column={column}>Finding</SortHeading>,
    cell: ({ row }) => <FindingText finding={row.original} />,
  },
  {
    accessorKey: 'file', size: 240, sortDescFirst: false,
    header: ({ column }) => <SortHeading column={column}>Location</SortHeading>,
    cell: ({ row }) => <code className="block break-all text-xs leading-5 text-muted-foreground">{row.original.file}:{row.original.line}:{row.original.column}</code>,
  },
  {
    accessorKey: 'blocksGate', size: 100, sortDescFirst: false,
    header: ({ column }) => <SortHeading column={column}>Gate</SortHeading>,
    cell: ({ row }) => <span className="text-xs text-muted-foreground">{row.original.blocksGate ? 'Blocking' : 'Advisory'}</span>,
  },
];

function FindingText({ finding }: { finding: Finding }) {
  return <div className="flex flex-col gap-1">
    <p className="break-words leading-5">{finding.message}</p>
    <p className="break-words text-xs leading-5 text-muted-foreground" title={finding.confidence ? `${finding.confidence} confidence` : undefined}>{finding.ruleId} · {finding.kind}</p>
    {finding.guidance ? <details className="text-xs text-muted-foreground"><summary className="w-fit cursor-pointer rounded-sm">Guidance</summary>{finding.confidence ? <p className="mt-2 leading-5">Confidence: {finding.confidence}</p> : null}<p className="mt-2 leading-5">{finding.guidance}</p></details> : null}
  </div>;
}

export function FindingsTable({ report, sorting, onSortingChange, busy, filtered }: { report: ProjectDetails; sorting: SortingState; onSortingChange: OnChangeFn<SortingState>; busy: boolean; filtered: boolean }) {
  if (!report.findings.length) return <BlankState title={filtered ? 'No matching findings' : 'No surfaced findings'}>{filtered ? 'Try another search or severity level.' : 'Review the checks above for the assessment result.'}</BlankState>;
  return <DataTable data={report.findings} columns={findingColumns} label="Report findings" getRowId={finding => finding.id} sorting={sorting} onSortingChange={onSortingChange} manualSorting busy={busy} />;
}

type Check = ProjectDetails['checks'][number];
const checkColumns: ColumnDef<Check>[] = [
  { accessorKey: 'name', header: 'Check', size: 240 },
  {
    accessorKey: 'status', header: 'Result', size: 130,
    cell: ({ row }) => <Badge variant={row.original.status === 'failed' ? 'destructive' : 'outline'}>{row.original.status}</Badge>,
  },
  { accessorKey: 'detail', header: 'Detail', size: 530, cell: ({ row }) => <span className="text-xs text-muted-foreground">{row.original.detail ?? 'No detail recorded'}</span> },
];

export function ChecksTable({ checks }: { checks: Check[] }) {
  return <DataTable data={checks} columns={checkColumns} label="Assessment checks" getRowId={check => check.name} />;
}
