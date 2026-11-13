import { createContext, useContext } from 'react';
import { projectsSchema, type ProjectsResponse } from './report-contract';
import { useReport } from './use-report';

type Catalog = ReturnType<typeof useReport<ProjectsResponse>>;
const ProjectCatalogContext = createContext<Catalog | null>(null);

export function ProjectCatalogProvider({ children }: { children: React.ReactNode }) {
  const catalog = useReport('/api/projects', projectsSchema);
  return <ProjectCatalogContext.Provider value={catalog}>{children}</ProjectCatalogContext.Provider>;
}

export function useProjectCatalog() {
  const catalog = useContext(ProjectCatalogContext);
  if (!catalog) throw new Error('Project catalog must be used inside the dashboard.');
  return catalog;
}
