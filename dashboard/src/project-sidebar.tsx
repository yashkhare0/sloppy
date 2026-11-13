import { Folder, LayoutDashboard } from 'lucide-react';
import { Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarHeader, SidebarMenu, SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar';
import { Skeleton } from '@/components/ui/skeleton';
import { useProjectCatalog } from './project-catalog';

export function ProjectSidebar() {
  const { state } = useProjectCatalog();
  const activeId = new URLSearchParams(window.location.search).get('project');
  return <Sidebar>
    <SidebarHeader className="h-12 justify-center px-4"><a href="/" aria-label="Sloppy overview" className="w-fit rounded-sm"><span className="text-base font-semibold tracking-tight">sloppy</span></a></SidebarHeader>
    <SidebarContent role="navigation" aria-label="Project navigation">
      <SidebarGroup><SidebarGroupContent><SidebarMenu><SidebarMenuItem>
        <SidebarMenuButton asChild isActive={!activeId}><a href="/" aria-current={!activeId ? 'page' : undefined}><LayoutDashboard /><span>Overview</span></a></SidebarMenuButton>
      </SidebarMenuItem></SidebarMenu></SidebarGroupContent></SidebarGroup>
      <SidebarGroup>
        <SidebarGroupLabel>Projects</SidebarGroupLabel>
        <SidebarGroupContent>
          {state.kind === 'ready' ? <SidebarMenu>{state.data.projects.map(project => <SidebarMenuItem key={project.id}>
            <SidebarMenuButton asChild isActive={activeId === project.id} tooltip={project.name}>
              <a href={`/?project=${project.id}`} title={project.root} aria-label={`Open ${project.name} report`} aria-current={activeId === project.id ? 'page' : undefined}><Folder /><span>{project.name}</span></a>
            </SidebarMenuButton>
          </SidebarMenuItem>)}</SidebarMenu> : state.kind === 'loading' ? <div className="flex flex-col gap-2 px-2"><Skeleton className="h-7 w-full" /><Skeleton className="h-7 w-full" /></div> : <p className="px-2 text-xs text-muted-foreground">Project list unavailable.</p>}
        </SidebarGroupContent>
      </SidebarGroup>
    </SidebarContent>
    <SidebarFooter className="gap-1 px-4 py-4"><p className="text-xs text-muted-foreground">Local reports</p><p className="text-xs text-muted-foreground">Updates every 30 seconds</p></SidebarFooter>
  </Sidebar>;
}
