import { z } from 'zod';

export const severityLevels = ['critical', 'major', 'minor', 'info'] as const;
const count = z.number().int().nonnegative();
const status = z.enum(['passed', 'failed', 'incomplete', 'unavailable']);
const projectSchema = z.object({
  id: z.string(), name: z.string(), root: z.string(), status,
  savedAt: z.string().nullable(), error: z.string().optional(), sourceAvailable: z.boolean(),
  languages: z.array(z.string()),
  revision: z.object({ commit: z.string(), dirty: z.boolean().nullable() }).nullable(),
  summary: z.object({
    files: count, findings: count, blockers: count, baseline: count, hidden: count,
    levels: z.record(z.enum(severityLevels), count).nullable(),
    groups: z.record(z.string(), z.object({ total: count, blockers: count })).nullable(),
  }).nullable(),
});

export const projectsSchema = z.object({ projects: z.array(projectSchema), unreadableDirectories: count, discovering: z.boolean(), discoveryError: z.string().nullable() });
export const detailsSchema = projectSchema.extend({
  mode: z.string(), total: count, page: count, pages: count,
  checks: z.array(z.object({ name: z.string(), status: z.string(), detail: z.string().nullable() })),
  findings: z.array(z.object({
    id: z.string(), ruleId: z.string(), file: z.string(), line: count, column: count, message: z.string(), guidance: z.string(),
    level: z.enum(severityLevels), kind: z.string(), confidence: z.string().nullable(), blocksGate: z.boolean(),
  })),
});

export type Project = z.infer<typeof projectSchema>;
export type ProjectsResponse = z.infer<typeof projectsSchema>;
export type ProjectDetails = z.infer<typeof detailsSchema>;
export type Finding = ProjectDetails['findings'][number];

export const formatCount = (value: number) => value.toLocaleString();
export function formatSavedAt(value: string | null) {
  if (!value) return 'Unavailable';
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}
