import { RefreshCw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { Separator } from '@/components/ui/separator';
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ProjectSidebar } from './project-sidebar';
import type { Project } from './report-contract';

const statusLabels = { passed: 'Passed', failed: 'Failed', incomplete: 'Incomplete', unavailable: 'Unavailable' } as const;

export function GateBadge({ status }: { status: Project['status'] }) {
  return <Badge variant={status === 'failed' ? 'destructive' : status === 'passed' ? 'secondary' : 'outline'}>{statusLabels[status]}</Badge>;
}

const sidebarStyle: React.CSSProperties & Record<'--sidebar-width', string> = { '--sidebar-width': '13.5rem' };

export function Shell({ children, refresh, loading, title = 'Overview', status, actions }: {
  children: React.ReactNode; refresh: () => void; loading: boolean; title?: string;
  status?: Project['status'] | undefined; actions?: React.ReactNode;
}) {
  return (
    <TooltipProvider><SidebarProvider style={sidebarStyle} defaultOpen={!document.cookie.split(';').some(value => value.trim() === 'sloppy_sidebar_state=false')}>
      <a className="skip-link" href="#main">Skip to content</a>
      <ProjectSidebar />
      <SidebarInset id="main" tabIndex={-1} className="min-w-0">
        <header className="sticky top-0 z-10 flex h-12 shrink-0 items-center justify-between gap-3 bg-background px-3">
          <div className="flex min-w-0 items-center gap-2"><SidebarTrigger /><Separator orientation="vertical" className="mx-1 h-4" /><h1 className="truncate text-sm font-medium">{title}</h1>{status ? <GateBadge status={status} /> : null}</div>
          <div className="flex shrink-0 items-center gap-1">{actions}<Button type="button" variant="ghost" size="icon-sm" onClick={refresh} disabled={loading} aria-label="Refresh" title="Refresh reports"><RefreshCw /></Button></div>
        </header>
        <Separator />
        <div className="min-w-0 flex-1 px-4 py-4 md:px-5">{children}</div>
      </SidebarInset>
    </SidebarProvider></TooltipProvider>
  );
}

export function ReportError({ message }: { message: string }) {
  return <Alert variant="destructive"><AlertTitle>Report unavailable</AlertTitle><AlertDescription>{message}</AlertDescription></Alert>;
}

export function BlankState({ title, children }: { title: string; children: React.ReactNode }) {
  return <Empty className="py-16"><EmptyHeader><EmptyTitle>{title}</EmptyTitle><EmptyDescription>{children}</EmptyDescription></EmptyHeader></Empty>;
}

export function ReportLoading() {
  return <div className="flex flex-col gap-5" role="status" aria-label="Loading saved reports">
    <Skeleton className="h-8 w-40" /><Skeleton className="h-4 w-64 max-w-full" />
    <div className="mt-6 flex flex-col gap-4"><Skeleton className="h-14 w-full" /><Skeleton className="h-14 w-full" /><Skeleton className="h-14 w-full" /></div>
  </div>;
}
