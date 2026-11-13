import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatCount, severityLevels, type Project, type ProjectDetails } from './report-contract';

type Metric = { label: string; value: string; note: string };
type Breakdown = { label: string; value: number };

export function StatsStrip({ metrics }: { metrics: Metric[] }) {
  return <dl className="stats-strip grid grid-cols-2 gap-x-6 gap-y-3 py-2 sm:grid-cols-4">
    {metrics.map(metric => <div key={metric.label} className="flex min-w-0 flex-col gap-1">
      <dt className="text-xs text-muted-foreground">{metric.label}</dt>
      <dd className="truncate text-2xl font-semibold tracking-tight tabular-nums" title={`${metric.value} · ${metric.note}`}>{metric.value}</dd>
      <dd className="sr-only">{metric.note}</dd>
    </div>)}
  </dl>;
}

export function ProjectStats({ report }: { report: ProjectDetails }) {
  const completed = report.checks.filter(check => check.status === 'completed').length;
  const failed = report.checks.filter(check => check.status === 'failed').length;
  const skipped = report.checks.filter(check => check.status === 'skipped' || check.status === 'disabled').length;
  const summary = report.summary;
  if (!summary) return null;
  return <StatsStrip metrics={[
    { label: 'Findings', value: formatCount(summary.findings), note: `${formatCount(summary.baseline)} baselined · ${formatCount(summary.hidden)} hidden` },
    { label: 'Gate blockers', value: formatCount(summary.blockers), note: 'Unbaselined blockers' },
    { label: 'Files assessed', value: formatCount(summary.files), note: 'In the saved assessment' },
    { label: 'Checks complete', value: completed + failed ? `${String(completed)}/${String(completed + failed)}` : 'None', note: `${String(skipped)} skipped` },
  ]} />;
}

export function PortfolioStats({ projects }: { projects: Project[] }) {
  const reports = projects.flatMap(project => project.summary ? [project.summary] : []);
  const sum = (key: 'findings' | 'blockers') => reports.reduce((total, summary) => total + summary[key], 0);
  return <StatsStrip metrics={[
    { label: 'Projects', value: formatCount(projects.length), note: `${formatCount(reports.length)} readable reports` },
    { label: 'Findings', value: reports.length ? formatCount(sum('findings')) : 'Unavailable', note: 'Across readable reports' },
    { label: 'Gate blockers', value: reports.length ? formatCount(sum('blockers')) : 'Unavailable', note: 'Across readable reports' },
    { label: 'Passing reports', value: formatCount(projects.filter(project => project.status === 'passed').length), note: `${formatCount(projects.filter(project => project.status === 'incomplete').length)} incomplete` },
  ]} />;
}

const groupLabels = new Map([['diagnostic', 'Diagnostics'], ['policy', 'Policy'], ['review', 'Review leads'], ['dependency', 'Dependencies'], ['outsideScope', 'Outside scope']]);
const groupLabel = (name: string) => groupLabels.get(name) ?? name;

export function ReportBreakdowns({ projects }: { projects: Project[] }) {
  const summaries = projects.flatMap(project => project.summary ? [project.summary] : []);
  const withLevels = summaries.filter(summary => summary.levels);
  const withGroups = summaries.filter(summary => summary.groups);
  const severity = severityLevels.map(level => ({ label: level.charAt(0).toUpperCase() + level.slice(1), value: withLevels.reduce((total, summary) => total + (summary.levels?.[level] ?? 0), 0) }));
  const groups = new Map<string, number>();
  for (const summary of withGroups) for (const [name, group] of Object.entries(summary.groups ?? {})) groups.set(name, (groups.get(name) ?? 0) + group.total);
  const note = (known: number) => `${String(known)} of ${String(summaries.length)} readable reports · full totals`;
  return <div className="grid gap-4 md:grid-cols-2">
    <BreakdownCard title="Severity" data={severity} available={withLevels.length > 0} note={note(withLevels.length)} />
    <BreakdownCard title="Finding categories" data={[...groups].map(([name, value]) => ({ label: groupLabel(name), value }))} available={withGroups.length > 0} note={note(withGroups.length)} />
  </div>;
}

function BreakdownCard({ title, data, note, available }: { title: string; data: Breakdown[]; note: string; available: boolean }) {
  const total = data.reduce((sum, item) => sum + item.value, 0);
  return <Card size="sm">
    <CardHeader><CardTitle>{title}</CardTitle></CardHeader>
    <CardContent className="flex flex-col gap-3">
      {available ? data.map(item => <div key={item.label} className="grid grid-cols-[100px_1fr_48px] items-center gap-3 text-xs">
        <span className="text-muted-foreground">{item.label}</span>
        <div className="h-1.5 overflow-hidden rounded-full bg-muted" role="img" aria-label={`${item.label}: ${formatCount(item.value)} of ${formatCount(total)} findings`}><div className="h-full rounded-full bg-primary" style={{ width: `${String(total ? item.value / total * 100 : 0)}%` }} /></div>
        <span className="text-right tabular-nums">{formatCount(item.value)}</span>
      </div>) : <p className="text-xs text-muted-foreground">These totals are not available in the saved report.</p>}
      <p className="pt-1 text-xs text-muted-foreground">{note}</p>
    </CardContent>
  </Card>;
}
