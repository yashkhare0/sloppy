import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { ProjectList } from './project-list';
import { ReportLoading, Shell } from './report-ui';
import { ProjectCatalogProvider } from './project-catalog';
import './index.css';

const root = document.getElementById('root');
if (!root) throw new Error('Dashboard root element is missing.');
const project = new URLSearchParams(window.location.search).get('project');
const ProjectDetail = lazy(() => import('./project-detail').then(module => ({ default: module.ProjectDetail })));
createRoot(root).render(<StrictMode><ProjectCatalogProvider><Suspense fallback={<Shell refresh={() => {}} loading><ReportLoading /></Shell>}>{project ? <ProjectDetail id={project} /> : <ProjectList />}</Suspense></ProjectCatalogProvider></StrictMode>);
