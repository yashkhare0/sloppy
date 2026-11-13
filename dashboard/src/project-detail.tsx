import { useState } from 'react';
import type { OnChangeFn, SortingState } from '@tanstack/react-table';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { detailsSchema, formatCount, formatSavedAt, severityLevels, type ProjectDetails } from './report-contract';
import { ChecksTable, FindingsTable } from './report-tables';
import { useReport } from './use-report';
import { useProjectCatalog } from './project-catalog';
import { ProjectStats, ReportBreakdowns } from './report-analytics';
import { ReportError, ReportLoading, Shell } from './report-ui';

export function ProjectDetail({ id }: { id: string }) {
  const catalog = useProjectCatalog();
  const [view, setView] = useState(() => {
    const selected = new URLSearchParams(window.location.search).get('view') ?? 'findings';
    return ['findings', 'analytics', 'checks'].includes(selected) ? selected : 'findings';
  });
  const [filters, setFilters] = useState(() => {
    const query = new URLSearchParams(window.location.search);
    return { q: query.get('q') ?? '', level: query.get('level') ?? 'all', page: Number(query.get('page') ?? 1), sort: query.get('sort') ?? 'order', direction: query.get('direction') ?? 'asc' };
  });
  const { q: query, level, page, sort, direction } = filters;
  const params = new URLSearchParams({ q: query, level, page: String(page), sort, direction });
  const { state, refresh, updating } = useReport(`/api/projects/${id}?${params.toString()}`, detailsSchema);
  const updateFilters = (next: Partial<typeof filters>) => {
    const updated = { ...filters, ...next, page: next.page ?? 1 };
    setFilters(updated);
    const url = new URL(window.location.href);
    for (const [key, value] of Object.entries({ q: updated.q, level: updated.level === 'all' ? '' : updated.level, page: updated.page === 1 ? '' : String(updated.page), sort: updated.sort === 'order' ? '' : updated.sort, direction: updated.sort === 'order' ? '' : updated.direction })) {
      if (value) url.searchParams.set(key, value); else url.searchParams.delete(key);
    }
    window.history.replaceState(null, '', url);
  };
  const sorting: SortingState = sort === 'order' ? [] : [{ id: sort, desc: direction === 'desc' }];
  const changeSorting: OnChangeFn<SortingState> = change => {
    const updated = typeof change === 'function' ? change(sorting) : change;
    updateFilters({ sort: updated[0]?.id ?? 'order', direction: updated[0]?.desc ? 'desc' : 'asc' });
  };
  const changeView = (value: string) => {
    setView(value);
    const url = new URL(window.location.href);
    if (value === 'findings') url.searchParams.delete('view'); else url.searchParams.set('view', value);
    window.history.replaceState(null, '', url);
  };
  const refreshReports = () => { refresh(); catalog.refresh(); };
  return <Shell title={state.kind === 'ready' ? state.data.name : 'Project'} status={state.kind === 'ready' ? state.data.status : undefined} actions={<ReportLinks id={id} />} refresh={refreshReports} loading={state.kind === 'loading' || updating}>
    {state.kind === 'loading' ? <ReportLoading /> : state.kind === 'error' ? <ReportError message={state.message} /> : <>
      <ReportMetadata report={state.data} />
      <ProjectStats report={state.data} />
      <FailedChecks report={state.data} />
      <Tabs value={view} onValueChange={changeView} className="mt-3">
        <TabsList variant="line"><TabsTrigger value="findings">Findings <span className="text-xs">{formatCount(state.data.total)}</span></TabsTrigger><TabsTrigger value="analytics">Analytics</TabsTrigger><TabsTrigger value="checks">Checks <span className="text-xs">{state.data.checks.length}</span></TabsTrigger></TabsList>
        <Separator />
        <TabsContent value="findings">
      <div className="my-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex w-full gap-2 sm:w-auto">
          <label htmlFor="finding-search" className="sr-only">Search findings</label>
          <Input id="finding-search" type="search" className="min-w-0 flex-1 sm:w-56" placeholder="Search findings" value={query} onChange={event => updateFilters({ q: event.target.value })} />
          <Select value={level} onValueChange={value => updateFilters({ level: value })}>
            <SelectTrigger aria-label="Filter severity"><SelectValue /></SelectTrigger>
            <SelectContent><SelectGroup><SelectItem value="all">All levels</SelectItem>{severityLevels.map(item => <SelectItem key={item} value={item}>{item[0]?.toUpperCase()}{item.slice(1)}</SelectItem>)}</SelectGroup></SelectContent>
          </Select>
        </div>
        <FindingPagination report={state.data} updatePage={value => updateFilters({ page: value })} busy={updating} />
      </div>
      {state.data.summary?.hidden ? <Alert className="mb-5"><AlertTitle>Some findings are hidden by the report mode</AlertTitle><AlertDescription>{formatCount(state.data.summary.hidden)} findings are not included in this {state.data.mode} report. Totals still include them. Run <code>sloppy check --mode deep</code> to see every finding.</AlertDescription></Alert> : null}
      <FindingsTable report={state.data} sorting={sorting} onSortingChange={changeSorting} busy={updating} filtered={Boolean(query) || level !== 'all'} />
        </TabsContent>
        <TabsContent value="analytics" className="pt-3"><ReportBreakdowns projects={[state.data]} /><ReportDetails report={state.data} /></TabsContent>
        <TabsContent value="checks" className="pt-2"><ChecksTable checks={state.data.checks} /><p className="mt-3 text-xs text-muted-foreground">Sloppy does not run this project's own test, lint, or build commands.</p></TabsContent>
      </Tabs>
    </>}
  </Shell>;
}

function ReportMetadata({ report }: { report: ProjectDetails }) {
  return <div className="mb-1 flex min-w-0 items-center justify-between gap-3 text-xs text-muted-foreground"><p className="truncate" title={report.root}>{report.root}</p>{!report.sourceAvailable ? <span className="shrink-0">Source missing</span> : null}<p className="shrink-0">Saved {formatSavedAt(report.savedAt)}</p></div>;
}

function FailedChecks({ report }: { report: ProjectDetails }) {
  const failed = report.checks.filter(check => check.status === 'failed');
  if (!failed.length) return null;
  return <Alert variant="destructive" className="my-3"><AlertTitle>Assessment incomplete</AlertTitle><AlertDescription><ul className="flex flex-col gap-1">{failed.map(check => <li key={check.name}>{check.name}: {check.detail ?? 'Check failed.'}</li>)}</ul>Resolve failed checks, then run <code>sloppy check</code> again.</AlertDescription></Alert>;
}

function ReportLinks({ id }: { id: string }) {
  return <><Button variant="ghost" size="xs" asChild><a href={`/api/projects/${id}/report.md`} target="_blank" rel="noreferrer">Markdown</a></Button><Button variant="ghost" size="xs" asChild><a href={`/api/projects/${id}/report.json`} target="_blank" rel="noreferrer">JSON</a></Button></>;
}

function FindingPagination({ report, updatePage, busy }: { report: ProjectDetails; updatePage: (page: number) => void; busy: boolean }) {
  if (report.pages < 2) return null;
  return <div className="flex items-center gap-2"><span className="text-xs text-muted-foreground">{report.page} of {report.pages}</span><Button type="button" variant="outline" size="icon-sm" disabled={busy || report.page === 1} onClick={() => updatePage(report.page - 1)} aria-label="Previous page"><ArrowLeft /></Button><Button type="button" variant="outline" size="icon-sm" disabled={busy || report.page === report.pages} onClick={() => updatePage(report.page + 1)} aria-label="Next page"><ArrowRight /></Button></div>;
}

function ReportDetails({ report }: { report: ProjectDetails }) {
  return <dl className="mt-5 grid gap-x-6 gap-y-3 text-xs sm:grid-cols-2"><div><dt className="text-muted-foreground">Report mode</dt><dd className="mt-1">{report.mode}</dd></div><div><dt className="text-muted-foreground">Git revision</dt><dd className="mt-1">{report.revision ? <><code>{report.revision.commit.slice(0, 12)}</code>{report.revision.dirty === true ? ' + local changes' : report.revision.dirty === null ? ' · worktree state unknown' : ''}</> : 'Unavailable'}</dd></div><div><dt className="text-muted-foreground">Source folder</dt><dd className="mt-1 break-all">{report.root}{!report.sourceAvailable ? ' · missing' : ''}</dd></div><div><dt className="text-muted-foreground">Report saved</dt><dd className="mt-1">{formatSavedAt(report.savedAt)}</dd></div><div><dt className="text-muted-foreground">Baselined findings</dt><dd className="mt-1">{formatCount(report.summary?.baseline ?? 0)}</dd></div><div><dt className="text-muted-foreground">Hidden by report mode</dt><dd className="mt-1">{formatCount(report.summary?.hidden ?? 0)}</dd></div></dl>;
}
