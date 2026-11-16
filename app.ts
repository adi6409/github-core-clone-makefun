import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';

type Data = Record<string, any>;
type Repository = { data: Data; labels: Map<string, Data>; issues: Map<number, Data>; nextIssue: number };
class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
const fail = (message = 'Validation Failed'): never => { throw new ApiError(422, message); };
const validName = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_.-]+$/.test(value) && value !== '.' && value !== '..';
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const now = () => new Date().toISOString();

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = status === 204 ? '' : JSON.stringify(body) + '\n';
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), 'x-github-request-id': randomUUID() });
  res.end(text);
}
async function readBody(req: IncomingMessage): Promise<Data> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_048_576) throw new ApiError(413, 'Request body too large');
    chunks.push(chunk);
  }
  let body: unknown;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ApiError(400, 'Problems parsing JSON'); }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) fail();
  return body as Data;
}
function authorized(req: IncomingMessage, token: string): boolean {
  const match = /^Bearer ([^\s]+)$/i.exec(req.headers.authorization ?? '');
  if (!token || !match) return false;
  const actual = Buffer.from(match[1]);
  const expected = Buffer.from(token);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
function page(items: Data[], url: URL): Data[] {
  const number = (name: string, fallback: number) => {
    const raw = url.searchParams.get(name);
    if (raw === null) return fallback;
    if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw))) fail();
    return Number(raw);
  };
  const count = Math.min(100, number('per_page', 30));
  const start = (number('page', 1) - 1) * count;
  return items.slice(start, start + count);
}

/** One store per application process/server; no request can borrow another owner's repository. */
export function createApp(options: { token?: string; owner?: string } = {}) {
  const token = options.token ?? process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const owner = options.owner ?? process.env.MAKEFUN_SHOP_OWNER ?? 'makefun';
  const repos = new Map<string, Repository>();
  let nextId = 1;
  const key = (login: string, name: string) => `${login.toLowerCase()}/${name.toLowerCase()}`;
  const user = (login: string) => ({ login, type: 'User', url: `/api/v3/users/${login}` });
  const repoURL = (login: string, name: string) => `/api/v3/repos/${login}/${name}`;
  const refresh = (repo: Repository) => {
    const d = repo.data;
    d.full_name = `${d.owner.login}/${d.name}`;
    d.url = repoURL(d.owner.login, d.name);
    d.html_url = `/${d.full_name}`;
    d.issues_url = `${d.url}/issues{/number}`;
    d.labels_url = `${d.url}/labels{/name}`;
    for (const issue of repo.issues.values()) {
      issue.url = `${d.url}/issues/${issue.number}`;
      issue.repository_url = d.url;
      issue.html_url = `${d.html_url}/issues/${issue.number}`;
    }
    for (const label of repo.labels.values()) label.url = `${d.url}/labels/${encodeURIComponent(label.name)}`;
    d.open_issues_count = [...repo.issues.values()].filter(i => i.state === 'open').length;
    d.open_issues = d.open_issues_count;
  };
  function repoFields(body: Data) {
    if ('name' in body && !validName(body.name)) fail();
    if ('description' in body && body.description !== null && typeof body.description !== 'string') fail();
    if ('private' in body && typeof body.private !== 'boolean') fail();
  }
  function issueFields(body: Data, repo: Repository) {
    if ('title' in body && !nonempty(body.title)) fail();
    if ('body' in body && body.body !== null && typeof body.body !== 'string') fail();
    if ('state' in body && !['open', 'closed'].includes(body.state)) fail();
    if ('labels' in body && (!Array.isArray(body.labels) || body.labels.some((name: unknown) => typeof name !== 'string' || !repo.labels.has(name.toLowerCase())))) fail('Validation Failed: unknown label');
  }
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://entry');
      let parts: string[];
      try { parts = url.pathname.replace(/\/$/, '').split('/').filter(Boolean).map(decodeURIComponent); }
      catch { throw new ApiError(400, 'Invalid URL'); }
      const method = req.method ?? 'GET';
      if (method === 'GET' && url.pathname === '/healthz') return send(res, 200, { ok: true });
      if (parts[0] !== 'api' || parts[1] !== 'v3') throw new ApiError(404, 'Not Found');
      const p = parts.slice(2);
      // Unsupported surfaces remain 404, including GraphQL and MCP.
      const recognized = p.length === 0 || (p.length === 1 && ['meta', 'user'].includes(p[0])) ||
        (p[0] === 'user' && p[1] === 'repos' && p.length === 2) ||
        (['users', 'orgs'].includes(p[0]) && p[2] === 'repos' && p.length === 3) ||
        (p[0] === 'repos' && (p.length === 3 || (['labels', 'issues'].includes(p[3]) && (p.length === 4 || (p[3] === 'issues' && p.length === 5)))));
      if (!recognized) throw new ApiError(404, 'Not Found');
      if (!authorized(req, token)) throw new ApiError(401, 'Bad credentials');
      if (method === 'GET' && p.length === 0) {
        res.setHeader('x-oauth-scopes', 'repo, read:org');
        return send(res, 200, { current_user_url: '/api/v3/user', repository_url: '/api/v3/repos/{owner}/{repo}' });
      }
      if (method === 'GET' && p.length === 1 && p[0] === 'meta') return send(res, 200, { verifiable_password_authentication: false, installed_version: 'github-core-clone-01', hooks: [], web: [], api: [], git: [] });
      if (method === 'GET' && p.length === 1 && p[0] === 'user') return send(res, 200, user(owner));
      if ((p[0] === 'user' && p[1] === 'repos') || (['users', 'orgs'].includes(p[0]) && p[2] === 'repos')) {
        const login = p[0] === 'user' ? owner : p[1];
        if (method === 'GET') return send(res, 200, page([...repos.values()].filter(r => r.data.owner.login.toLowerCase() === login.toLowerCase()).map(r => r.data), url));
        if (method === 'POST' && p[0] !== 'users') {
          const body = await readBody(req);
          repoFields(body);
          if (!validName(body.name) || !validName(login)) fail();
          if (repos.has(key(login, body.name))) fail('Validation Failed: repository already exists');
          const date = now();
          const repo: Repository = { data: { id: nextId++, name: body.name, owner: user(login), private: body.private ?? false, description: body.description ?? null, fork: false, default_branch: 'main', created_at: date, updated_at: date }, labels: new Map(), issues: new Map(), nextIssue: 1 };
          refresh(repo);
          repos.set(key(login, body.name), repo);
          return send(res, 201, repo.data);
        }
      }
      if (p[0] === 'repos') {
        const repo = repos.get(key(p[1], p[2]));
        if (!repo) throw new ApiError(404, 'Not Found');
        if (p.length === 3) {
          if (method === 'GET') return send(res, 200, repo.data);
          if (method === 'DELETE') { repos.delete(key(p[1], p[2])); return send(res, 204, null); }
          if (method === 'PATCH') {
            const body = await readBody(req);
            repoFields(body);
            const newKey = key(repo.data.owner.login, body.name ?? repo.data.name);
            if (repos.has(newKey) && repos.get(newKey) !== repo) fail('Validation Failed: repository already exists');
            for (const field of ['name', 'description', 'private']) if (field in body) repo.data[field] = body[field];
            repo.data.updated_at = now();
            repos.delete(key(p[1], p[2])); repos.set(newKey, repo); refresh(repo);
            return send(res, 200, repo.data);
          }
        }
        if (p[3] === 'labels' && p.length === 4) {
          if (method === 'GET') return send(res, 200, page([...repo.labels.values()], url));
          if (method === 'POST') {
            const body = await readBody(req);
            if (!nonempty(body.name) || typeof body.color !== 'string' || !/^[a-fA-F0-9]{6}$/.test(body.color) || (body.description != null && typeof body.description !== 'string')) fail();
            if (repo.labels.has(body.name.toLowerCase())) fail('Validation Failed: label already exists');
            const label = { id: nextId++, name: body.name, color: body.color.toLowerCase(), description: body.description ?? null, default: false, url: `${repo.data.url}/labels/${encodeURIComponent(body.name)}` };
            repo.labels.set(body.name.toLowerCase(), label);
            return send(res, 201, label);
          }
        }
        if (p[3] === 'issues') {
          if (p.length === 4 && method === 'GET') {
            const state = url.searchParams.get('state') ?? 'open';
            if (!['open', 'closed', 'all'].includes(state)) fail();
            const labels = (url.searchParams.get('labels') ?? '').split(',').filter(Boolean).map(s => s.toLowerCase());
            const items = [...repo.issues.values()].filter(i => (state === 'all' || i.state === state) && labels.every(name => i.labels.some((l: Data) => l.name.toLowerCase() === name)));
            items.sort((a, b) => url.searchParams.get('direction') === 'asc' ? a.number - b.number : b.number - a.number);
            return send(res, 200, page(items, url));
          }
          if (p.length === 4 && method === 'POST') {
            const body = await readBody(req);
            issueFields(body, repo);
            if (!nonempty(body.title)) fail();
            const date = now();
            const issue: Data = { id: nextId++, number: repo.nextIssue++, title: body.title, body: body.body ?? null, state: 'open', user: user(owner), labels: [...new Set<string>(body.labels ?? [])].map(name => repo.labels.get(name.toLowerCase())), comments: 0, created_at: date, updated_at: date, closed_at: null };
            repo.issues.set(issue.number, issue); refresh(repo);
            return send(res, 201, issue);
          }
          if (p.length === 5) {
            const issue = /^\d+$/.test(p[4]) ? repo.issues.get(Number(p[4])) : undefined;
            if (!issue) throw new ApiError(404, 'Not Found');
            if (method === 'GET') return send(res, 200, issue);
            if (method === 'PATCH') {
              const body = await readBody(req);
              issueFields(body, repo);
              for (const field of ['title', 'body']) if (field in body) issue[field] = body[field];
              if ('labels' in body) issue.labels = [...new Set<string>(body.labels)].map(name => repo.labels.get(name.toLowerCase()));
              if ('state' in body && body.state !== issue.state) { issue.state = body.state; issue.closed_at = body.state === 'closed' ? now() : null; }
              issue.updated_at = now(); refresh(repo);
              return send(res, 200, issue);
            }
          }
        }
      }
      throw new ApiError(404, 'Not Found');
    } catch (error) {
      send(res, error instanceof ApiError ? error.status : 500, { message: error instanceof ApiError ? error.message : 'Internal Server Error' });
    }
  });
}
