import { useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatCount, formatSavedAt, type Project, type ProjectsResponse } from './report-contract';
import { useProjectCatalog } from './project-catalog';
import { PortfolioStats, ReportBreakdowns } from './report-analytics';
import { BlankState, GateBadge, ReportError, ReportLoading, Shell } from './report-ui';

export function ProjectList() {
  const [search, setSearch] = useState(() => new URLSearchParams(window.location.search).get('q') ?? '');
  const { state, refresh } = useProjectCatalog();
  const changeSearch = (value: string) => {
    setSearch(value);
    const url = new URL(window.location.href);
    if (value) url.searchParams.set('q', value); else url.searchParams.delete('q');
    window.history.replaceState(null, '', url);
  };
  return <Shell refresh={refresh} loading={state.kind === 'loading'}>
    {state.kind === 'loading' ? <ReportLoading /> : state.kind === 'error' ? <ReportError message={state.message} /> : <ProjectReports data={state.data} search={search} onSearch={changeSearch} />}
  </Shell>;
}

function ProjectReports({ data, search, onSearch }: { data: ProjectsResponse; search: string; onSearch: (value: string) => void }) {
  if (data.projects.length === 0 && data.discovering) return <ReportLoading />;
  if (data.projects.length === 0 && data.discoveryError) return <ReportError message={data.discoveryError} />;
  if (data.projects.length === 0) return <BlankState title="No reports yet">Run <code>sloppy check</code> in a project. Its saved report will appear here automatically.</BlankState>;
  const query = search.toLowerCase().trim();
  const visible = data.projects.filter(project => `${project.name} ${project.root}`.toLowerCase().includes(query));
  return <>
      <PortfolioStats projects={data.projects} />
      <div className="mt-3 mb-5"><ReportBreakdowns projects={data.projects} /></div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3"><h2 className="text-sm font-medium">Projects <span className="ml-1 font-normal text-muted-foreground">{data.projects.length}</span></h2>
      <label htmlFor="project-search" className="sr-only">Search projects</label><Input id="project-search" type="search" placeholder="Search projects" value={search} onChange={event => onSearch(event.target.value)} className="max-w-60" /></div>
      {visible.length ? <ProjectTable projects={visible} /> : <BlankState title="No matching projects">Try another project name or path.</BlankState>}
      {data.discovering ? <p className="mt-6 text-xs text-muted-foreground" role="status">Discovering other saved reports…</p> : null}
      {data.discoveryError ? <Alert className="mt-6"><AlertTitle>Discovery incomplete</AlertTitle><AlertDescription>{data.discoveryError}</AlertDescription></Alert> : null}
      {data.unreadableDirectories > 0 ? <p className="mt-6 text-xs text-muted-foreground">{formatCount(data.unreadableDirectories)} folders could not be read during discovery. Use <code>sloppy dashboard --root PATH</code> to scan another folder.</p> : null}
    </>;
}

function ProjectTable({ projects }: { projects: Project[] }) {
  return <Table aria-label="Project reports">
    <TableHeader><TableRow>
      <TableHead className="w-[42%] pl-0">Project</TableHead><TableHead>Gate</TableHead>
      <TableHead className="hidden text-right sm:table-cell">Findings</TableHead>
      <TableHead className="hidden text-right sm:table-cell">Blockers</TableHead>
      <TableHead className="hidden text-right lg:table-cell">Report saved</TableHead>
      <TableHead className="w-9 pr-0"><span className="sr-only">Open report</span></TableHead>
    </TableRow></TableHeader>
    <TableBody>{projects.map(project => <TableRow key={project.id}>
      <TableCell className="max-w-0 py-3 pl-0">
        <a href={`/?project=${project.id}`} className="block rounded-sm" aria-label={`Open ${project.name} report`}>
          <span className="block truncate font-medium">{project.name}</span>
          <span className="mt-1 block truncate text-xs text-muted-foreground" title={project.root}>{project.root}</span>
        </a>
        {!project.sourceAvailable && !project.error ? <span className="mt-2 block text-xs text-muted-foreground">Source folder missing</span> : null}
        {project.summary ? <span className="mt-2 block text-xs whitespace-normal text-muted-foreground sm:hidden">{formatCount(project.summary.findings)} findings · {formatCount(project.summary.blockers)} blockers</span> : null}
        {project.error ? <span className="mt-2 block text-xs whitespace-normal text-muted-foreground">{project.error}</span> : null}
      </TableCell>
      <TableCell><GateBadge status={project.status} /></TableCell>
      <TableCell className="hidden text-right tabular-nums sm:table-cell">{project.summary ? formatCount(project.summary.findings) : '—'}</TableCell>
      <TableCell className="hidden text-right tabular-nums sm:table-cell">{project.summary ? formatCount(project.summary.blockers) : '—'}</TableCell>
      <TableCell className="hidden text-right text-muted-foreground lg:table-cell"><time dateTime={project.savedAt ?? undefined} title={project.savedAt ? new Date(project.savedAt).toLocaleString() : undefined}>{formatSavedAt(project.savedAt)}</time></TableCell>
      <TableCell className="pr-0 text-right"><Button asChild variant="ghost" size="icon-sm"><a href={`/?project=${project.id}`} aria-label={`View ${project.name} report`}><ArrowRight /></a></Button></TableCell>
    </TableRow>)}</TableBody>
  </Table>;
}
