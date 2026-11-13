import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { catalogDirectory, catalogEntries, discoverReports } from '../project/report-catalog.js';
import { listProjects, projectDetails, parseReportQuery, resolveReportFile } from './report-data.js';

const assetsDirectory = fileURLToPath(new URL('../../dashboard/dist', import.meta.url));
const contentTypes = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png' };

export function dashboardHandler({ directory = catalogDirectory(), scanRoot = os.homedir(), assets = null, discover = discoverReports } = {}) {
  let discovery;
  const scan = { discovering: true, unreadableDirectories: 0, discoveryError: null };
  return (request, response, next) => {
    let url;
    try { url = new URL(request.url, 'http://localhost'); }
    catch { response.writeHead(400); response.end('Invalid request URL.'); return; }
    if (!url.pathname.startsWith('/api/') && next) return next();
    if (!localRequest(request)) { response.writeHead(403); response.end('Local dashboard access only.'); return; }
    if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405, { Allow: 'GET, HEAD' }); response.end(); return; }
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cache-Control', 'no-store');
    discovery ??= discover(scanRoot, directory).then(result => {
      scan.unreadableDirectories = result.unreadableDirectories;
      scan.discovering = false;
    }).catch(error => {
      console.error(`sloppy dashboard discovery: ${error.message}`);
      scan.discoveryError = 'Could not finish discovering reports. Use sloppy dashboard --root PATH to scan a readable folder.';
      scan.discovering = false;
    });
    handleRequest(url, response, { directory, assets, scan }).catch(error => {
      console.error(`sloppy dashboard: ${error.message}`);
      if (!response.headersSent) json(response, 500, { error: 'Could not read the saved report. Run sloppy check again, then refresh.' });
      else response.end();
    });
  };
}

function localRequest(request) {
  const host = request.headers.host ?? '';
  if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host)) return false;
  if (request.headers['sec-fetch-site'] === 'cross-site') return false;
  return !request.headers.origin || request.headers.origin === `http://${host}`;
}

async function handleRequest(url, response, { directory, assets, scan }) {
  if (url.pathname === '/api/projects') {
    return json(response, 200, { projects: await listProjects(catalogEntries(directory)), ...scan });
  }
  const match = /^\/api\/projects\/([a-f0-9]{24})(?:\/(report\.json|report\.md))?$/.exec(url.pathname);
  if (match) return serveProject(url, response, match, directory);
  if (url.pathname.startsWith('/api/') || !assets) return json(response, 404, { error: 'Not found.' });
  return serveAsset(url, response, assets);
}

async function serveProject(url, response, match, directory) {
  const entry = catalogEntries(directory).find(item => item.id === match[1]);
  if (!entry) return json(response, 404, { error: 'Project report not found.' });
  if (match[2]) return serveReportFile(entry, match[2], response);
  let query;
  try { query = parseReportQuery(url.searchParams); }
  catch (error) { return json(response, 400, { error: error.message }); }
  return json(response, 200, await projectDetails(entry, query));
}

async function serveReportFile(entry, name, response) {
  const reportFile = await resolveReportFile(entry);
  const file = name === 'report.json' ? reportFile : path.join(path.dirname(reportFile), 'report.md');
  if ((await fs.stat(file)).size > 64 * 1024 * 1024) throw new Error('Report exceeds the 64 MB size limit.');
  const content = await fs.readFile(file);
  response.writeHead(200, { 'Content-Type': name === 'report.json' ? 'application/json' : 'text/plain; charset=utf-8' });
  response.end(content);
}

async function serveAsset(url, response, assets) {
  const file = path.resolve(assets, `.${decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)}`);
  if (!file.startsWith(`${assets}${path.sep}`)) return json(response, 404, { error: 'Not found.' });
  try {
    const content = await fs.readFile(file);
    response.writeHead(200, { 'Content-Type': contentTypes[path.extname(file)] ?? 'application/octet-stream' });
    response.end(content);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    json(response, 404, { error: 'Not found.' });
  }
}

function json(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

export async function startDashboard({ port = 4173, scanRoot = os.homedir(), directory = catalogDirectory() } = {}) {
  await fs.access(path.join(assetsDirectory, 'index.html')).catch(() => { throw new Error('Build the dashboard first with pnpm build. Use pnpm dev for development.'); });
  const server = http.createServer(dashboardHandler({ directory, scanRoot, assets: assetsDirectory }));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  console.log(`Sloppy dashboard: http://127.0.0.1:${server.address().port}`);
  return server;
}
