import { useEffect, useState } from 'react';
import type { z } from 'zod';

type ReportState<T> = { kind: 'loading' } | { kind: 'ready'; data: T } | { kind: 'error'; message: string };

export function useReport<T>(url: string, schema: z.ZodType<T>) {
  const [result, setResult] = useState<{ url: string; state: ReportState<T> }>({ url, state: { kind: 'loading' } });
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let controller: AbortController | undefined;
    const load = async () => {
      controller?.abort();
      controller = new AbortController();
      const signal = controller.signal;
      try {
        const response = await fetch(url, { signal });
        if (!response.ok) throw new Error(response.status === 404 ? 'This project report was not found.' : 'Could not load the saved report. Run sloppy check again, then refresh.');
        const value: unknown = await response.json();
        const parsed = schema.safeParse(value);
        if (!parsed.success) throw new Error('The dashboard received an invalid report. Run sloppy check again, then refresh.');
        if (!signal.aborted) setResult({ url, state: { kind: 'ready', data: parsed.data } });
      } catch (error) {
        if (!signal.aborted) setResult({ url, state: { kind: 'error', message: error instanceof Error ? error.message : 'Could not load reports.' } });
      }
    };
    void load();
    const interval = window.setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 30_000);
    return () => { controller?.abort(); window.clearInterval(interval); };
  }, [url, schema, revision]);

  const refresh = () => {
    setResult({ url, state: { kind: 'loading' } });
    setRevision(previous => previous + 1);
  };
  return { state: result.state, updating: result.url !== url, refresh };
}
