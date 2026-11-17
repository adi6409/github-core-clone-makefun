import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { directChild, initialSnapshot, pushCommands, emptyPack, newBranch, cloneSnapshot, pkt, ZERO_OID, MAX_PUSH_BYTES } from './git-initial.ts';

type Data = Record<string, any>;
type InitialCommit = { files: Map<string, { file: Buffer; blob: string }>; path: string; file: Buffer | null; blob: string | null; objects: Map<string, Buffer>; tree: string; head: string; branch: string; message: string; parent?: string; pack?: Buffer };
type Repository = { data: Data; labels: Map<string, Data>; issues: Map<number, Data>; comments: Map<number, Data[]>; nextIssue: number; branches: Map<string, string>; commits: Map<string, InitialCommit>; initialCommit?: InitialCommit };
class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
const fail = (message = 'Validation Failed'): never => { throw new ApiError(422, message); };
const validName = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_.-]+$/.test(value) && value !== '.' && value !== '..';
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const now = () => new Date().toISOString();

function fileCommit(path: string, file: Buffer | null, message: string, branch: string, previous?: InitialCommit): InitialCommit {
  const objects = new Map(previous?.objects);
  const object = (type: string, payload: Buffer) => {
    const bytes = Buffer.concat([Buffer.from(`${type} ${payload.length}\0`), payload]);
    const sha = createHash('sha1').update(bytes).digest('hex');
    objects.set(sha, bytes);
    return sha;
  };
  const blob = file === null ? null : object('blob', file);
  const files = new Map(previous?.files);
  if (file === null) files.delete(path);
  else files.set(path, { file, blob: blob! });
  // Build the complete snapshot, sorting directories as Git's name + '/'.
  const buildTree = (prefix: string): string => {
    const entries = new Map<string, { directory: boolean; sha: string }>();
    for (const [name, entry] of files) {
      if (!name.startsWith(prefix)) continue;
      const relative = name.slice(prefix.length);
      const slash = relative.indexOf('/');
      if (slash < 0) entries.set(relative, { directory: false, sha: entry.blob });
      else entries.set(relative.slice(0, slash), { directory: true, sha: '' });
    }
    const sorted = [...entries].sort(([a, x], [b, y]) =>
      Buffer.compare(Buffer.from(a + (x.directory ? '/' : '')), Buffer.from(b + (y.directory ? '/' : ''))));
    return object('tree', Buffer.concat(sorted.map(([name, entry]) => Buffer.concat([
      Buffer.from(`${entry.directory ? '40000' : '100644'} ${name}\0`),
      Buffer.from(entry.directory ? buildTree(`${prefix}${name}/`) : entry.sha, 'hex'),
    ]))));
  };
  const tree = buildTree('');
  const identity = 'Fixture <fixture@example.invalid> 0 +0000';
  const head = object('commit', Buffer.from(`tree ${tree}\n${previous ? `parent ${previous.head}\n` : ''}author ${identity}\ncommitter ${identity}\n\n${message}\n`));
  return { files, path, file, blob, objects, tree, head, branch, message, parent: previous?.head };
}

// Advertised tools; only create_repo, get_repo, create_issue, and list_issues execution is supported.
const mcpTools = [
  { name: 'create_repo', description: 'Create a repository.' },
  { name: 'get_repo', description: 'Get a repository.' },
  { name: 'create_issue', description: 'Create an issue.' },
  { name: 'list_issues', description: 'List repository issues.' },
  { name: 'create_pull_request', description: 'Create a pull request.' },
  { name: 'merge_pull_request', description: 'Merge a pull request.' },
].map(tool => ({ ...tool, inputSchema: { type: 'object' } }));

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = status === 204 ? '' : JSON.stringify(body) + '\n';
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), 'x-github-request-id': randomUUID() });
  res.end(text);
}
function readBody(req: IncomingMessage): Promise<Data>;
function readBody(req: IncomingMessage, allowArray: true): Promise<Data | unknown[]>;
async function readBody(req: IncomingMessage, allowArray = false): Promise<Data | unknown[]> {
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
  if (body === null || typeof body !== 'object' || (!allowArray && Array.isArray(body))) fail();
  return body as Data;
}
function authorized(req: IncomingMessage, token: string): boolean {
  const match = /^Bearer ([^\s]+)$/i.exec(req.headers.authorization ?? '');
  if (!token || !match) return false;
  const actual = Buffer.from(match[1]);
  const expected = Buffer.from(token);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
function page(items: Data[], url: URL, res?: ServerResponse): Data[] {
  const number = (name: string, fallback: number) => {
    const raw = url.searchParams.get(name);
    if (raw === null) return fallback;
    if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw))) fail();
    return Number(raw);
  };
  const count = Math.min(100, number('per_page', 30));
  const current = number('page', 1);
  const start = (current - 1) * count;
  if (res) {
    const last = Math.max(1, Math.ceil(items.length / count));
    const links: string[] = [];
    const link = (target: number, relation: string) => {
      const next = new URL(url);
      next.searchParams.set('page', String(target));
      links.push(`<${next.href}>; rel="${relation}"`);
    };
    if (current > 1) {
      link(1, 'first');
      link(current - 1, 'prev');
    }
    if (current < last) {
      link(current + 1, 'next');
      link(last, 'last');
    }
    if (links.length) res.setHeader('link', links.join(', '));
  }
  return items.slice(start, start + count);
}

/** One store per application process/server; no request can borrow another owner's repository. */
export function createApp(options: { token?: string; owner?: string } = {}) {
  const token = options.token ?? process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const owner = options.owner ?? process.env.MAKEFUN_SHOP_OWNER ?? 'adaiversen';
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
  function createRepository(body: Data, login: string): Data {
    repoFields(body);
    if (!validName(body.name) || !validName(login)) fail();
    if (repos.has(key(login, body.name))) fail('Validation Failed: repository already exists');
    const date = now();
    const repo: Repository = { data: { id: nextId++, name: body.name, owner: user(login), private: body.private ?? false, description: body.description ?? null, fork: false, default_branch: 'main', created_at: date, updated_at: date }, labels: new Map(), issues: new Map(), comments: new Map(), nextIssue: 1, branches: new Map(), commits: new Map() };
    refresh(repo);
    repos.set(key(login, body.name), repo);
    return repo.data;
  }
  function issueFields(body: Data, repo: Repository) {
    if ('title' in body && !nonempty(body.title)) fail();
    if ('body' in body && body.body !== null && typeof body.body !== 'string') fail();
    if ('state' in body && !['open', 'closed'].includes(body.state)) fail();
    if ('labels' in body && (!Array.isArray(body.labels) || body.labels.some((name: unknown) => typeof name !== 'string' || !repo.labels.has(name.toLowerCase())))) fail('Validation Failed: unknown label');
  }
  function createIssue(body: Data, repo: Repository): Data {
    issueFields(body, repo);
    if (!nonempty(body.title)) fail();
    const date = now();
    const issue: Data = { id: nextId++, number: repo.nextIssue++, title: body.title, body: body.body ?? null, state: 'open', user: user(owner), labels: [...new Set<string>(body.labels ?? [])].map(name => repo.labels.get(name.toLowerCase())), comments: 0, created_at: date, updated_at: date, closed_at: null };
    repo.issues.set(issue.number, issue); refresh(repo);
    return issue;
  }
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://entry');
      let parts: string[];
      try { parts = url.pathname.replace(/\/$/, '').split('/').filter(Boolean).map(decodeURIComponent); }
      catch { throw new ApiError(400, 'Invalid URL'); }
      const method = req.method ?? 'GET';
      if (method === 'GET' && url.pathname === '/healthz') return send(res, 200, { ok: true });
      const gitPath = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-receive-pack|git-upload-pack)$/.exec(url.pathname);
      if (gitPath && ((method === 'GET' && gitPath[3] === 'info/refs') ||
          (method === 'POST' && gitPath[3] !== 'info/refs'))) {
        if (!authorized(req, token)) throw new ApiError(401, 'Bad credentials');
        const repo = repos.get(key(decodeURIComponent(gitPath[1]), decodeURIComponent(gitPath[2])));
        if (!repo) throw new ApiError(404, 'Not Found');
        const gitReply = (type: string, body: string | Buffer) => {
          res.writeHead(200, { 'content-type': `application/x-git-${type}`, 'content-length': Buffer.byteLength(body), 'cache-control': 'no-cache' });
          res.end(body);
        };
        if (method === 'GET') {
          const service = url.searchParams.get('service');
          if (!['git-upload-pack', 'git-receive-pack'].includes(service ?? '') || [...url.searchParams].length !== 1) {
            throw new ApiError(400, 'Unsupported Git service');
          }
          const caps = service === 'git-receive-pack' ? 'report-status' : 'side-band-64k no-progress';
          const branches = new Map(repo.branches);
          if (repo.initialCommit) branches.set(repo.data.default_branch, repo.initialCommit.head);
          const head = branches.get(repo.data.default_branch);
          const refs = [...branches].map(([name, oid]) => `${oid} refs/heads/${name}`);
          if (head) refs.unshift(`${head} HEAD`);
          const capabilities = [caps, head ? `symref=HEAD:refs/heads/${repo.data.default_branch}` : ''].filter(Boolean).join(' ');
          // v0 only; receive-pack does not advertise sideband or delete support.
          const advertisement = refs.length
            ? refs.map((ref, index) => pkt(`${ref}${index === 0 ? `\0${capabilities}` : ''}\n`)).join('')
            : pkt(`${ZERO_OID} capabilities^{}\0${caps}\n`);
          return gitReply(`${service!.slice(4)}-advertisement`, pkt(`# service=${service}\n`) + '0000' +
            advertisement + '0000');
        }
        if (url.search || req.headers['content-type'] !== `application/x-${gitPath[3]}-request`) {
          throw new ApiError(400, 'Invalid Git request');
        }
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > MAX_PUSH_BYTES) throw new ApiError(413, 'Request body too large');
          chunks.push(chunk);
        }
        if (gitPath[3] === 'git-upload-pack') {
          const snapshot = repo.initialCommit;
          const singleUpdate = snapshot?.parent && repo.commits.size === 2 && repo.branches.size === 0 &&
            repo.commits.get(snapshot.parent)?.parent === undefined && !!repo.commits.get(snapshot.parent)?.pack;
          if (!snapshot?.pack || (repo.commits.size !== 1 && !singleUpdate) ||
              [...repo.branches.values()].some(head => head !== snapshot.head)) {
            throw new ApiError(400, 'Unsupported snapshot');
          }
          let response: Buffer;
          try { response = cloneSnapshot(Buffer.concat(chunks), snapshot.head, snapshot.pack); }
          catch { throw new ApiError(400, 'Unsupported upload-pack request'); }
          return gitReply('upload-pack-result', response);
        }
        let parsed: ReturnType<typeof pushCommands>;
        try { parsed = pushCommands(Buffer.concat(chunks)); }
        catch { throw new ApiError(400, 'Malformed receive-pack commands'); }
        const { commands, pack } = parsed;
        let snapshot: InitialCommit | undefined;
        let branch: string | undefined;
        let deletedBranch: string | undefined;
        try {
          if (repos.get(key(decodeURIComponent(gitPath[1]), decodeURIComponent(gitPath[2]))) !== repo ||
              commands.length !== 1) throw new Error('unsupported update');
          if (commands[0].head === ZERO_OID) {
            const root = repo.initialCommit;
            const name = newBranch(commands[0].ref, [repo.data.default_branch]);
            if (!root?.pack || root.parent || repo.commits.size !== 1 ||
                repo.commits.get(root.head) !== root || pack.length !== 0 ||
                commands[0].old !== root.head || repo.branches.get(name) !== commands[0].old ||
                [...repo.branches.values()].some(head => head !== root.head)) throw new Error('unsupported branch delete');
            deletedBranch = name;
          } else if (commands[0].old !== ZERO_OID) {
            // Only one direct child of the original root, with no branch compositions.
            const root = repo.initialCommit;
            if (!root?.pack || root.parent || repo.commits.size !== 1 || repo.branches.size ||
                repo.commits.get(root.head) !== root || commands[0].old !== root.head ||
                commands[0].ref !== `refs/heads/${repo.data.default_branch}`) throw new Error('unsupported update');
            snapshot = directChild(pack, commands[0].head, repo.data.default_branch, root.pack, root.head);
          } else if (repo.initialCommit) {
            if (!repo.initialCommit.pack || repo.commits.size !== 1 ||
                repo.commits.get(commands[0].head) !== repo.initialCommit ||
                commands[0].head !== repo.initialCommit.head || !emptyPack(pack)) throw new Error('unsupported branch create');
            branch = newBranch(commands[0].ref, [repo.data.default_branch, ...repo.branches.keys()]);
          } else {
            if (repo.commits.size || repo.branches.size ||
                commands[0].ref !== `refs/heads/${repo.data.default_branch}`) throw new Error('unsupported initial push');
            snapshot = initialSnapshot(pack, commands[0].head, repo.data.default_branch);
          }
        } catch {
          return gitReply('receive-pack-result', pkt('unpack unsupported or malformed initial push\n') +
            commands.map(command => pkt(`ng ${command.ref} initial push rejected\n`)).join('') + '0000');
        }
        // No await or mutation until every command, object and reference has been validated.
        if (snapshot) {
          repo.commits.set(snapshot.head, snapshot);
          repo.initialCommit = snapshot;
        } else if (branch) repo.branches.set(branch, commands[0].head);
        else if (deletedBranch) repo.branches.delete(deletedBranch);
        return gitReply('receive-pack-result', pkt('unpack ok\n') + pkt(`ok ${commands[0].ref}\n`) + '0000');
      }
      if (method === 'POST' && url.pathname === '/mcp') {
        if (!authorized(req, token)) throw new ApiError(401, 'Bad credentials');
        let body: Data;
        try { body = await readBody(req); }
        catch (error) {
          if (error instanceof ApiError && error.status === 400) {
            return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
          }
          throw error;
        }
        const hasId = typeof body.id === 'string' || (typeof body.id === 'number' && Number.isFinite(body.id));
        if (body.jsonrpc === '2.0') {
          const params = body.params;
          if (body.method === 'tools/call' && hasId &&
              params !== null && typeof params === 'object' && !Array.isArray(params) && params.name === 'create_repo') {
            try {
              const args = params.arguments;
              if (args === null || typeof args !== 'object' || Array.isArray(args)) fail();
              if ('owner' in args && (!validName(args.owner) || args.owner.toLowerCase() !== owner.toLowerCase())) fail();
              const repo = createRepository(args, owner);
              return send(res, 200, { jsonrpc: '2.0', id: body.id, result: {
                content: [{ type: 'text', text: JSON.stringify(repo) }],
              } });
            } catch (error) {
              if (!(error instanceof ApiError)) throw error;
              return send(res, 200, { jsonrpc: '2.0', id: body.id, result: {
                isError: true, content: [{ type: 'text', text: JSON.stringify({ message: error.message }) }],
              } });
            }
          }
          if (body.method === 'tools/call' && hasId &&
              params !== null && typeof params === 'object' && !Array.isArray(params) && params.name === 'list_issues') {
            const args = params.arguments;
            const toolError = (message: string) => send(res, 200, { jsonrpc: '2.0', id: body.id, result: {
              isError: true, content: [{ type: 'text', text: JSON.stringify({ message }) }],
            } });
            if (args === null || typeof args !== 'object' || Array.isArray(args) ||
                !validName(args.owner) || !validName(args.repo) ||
                ('state' in args && !['open', 'closed', 'all'].includes(args.state))) {
              return toolError('Invalid arguments: owner and repo are required; state must be open, closed, or all');
            }
            const repo = repos.get(key(args.owner, args.repo));
            if (!repo) return toolError('Repository not found');
            const state = args.state ?? 'open';
            const issues: Data[] = [];
            for (const issue of repo.issues.values()) {
              if (state === 'all' || issue.state === state) issues.push(issue);
              if (issues.length === 100) break;
            }
            return send(res, 200, { jsonrpc: '2.0', id: body.id, result: {
              content: [{ type: 'text', text: JSON.stringify(issues) }],
            } });
          }
          if (body.method === 'tools/call' && hasId &&
              params !== null && typeof params === 'object' && !Array.isArray(params) && nonempty(params.name) &&
              (!('arguments' in params) || (params.arguments !== null && typeof params.arguments === 'object' && !Array.isArray(params.arguments)))) {
            if (!mcpTools.some(tool => tool.name === params.name)) {
              return send(res, 200, { jsonrpc: '2.0', id: body.id, error: { code: -32602, message: 'Unknown tool' } });
            }
            if (params.name === 'get_repo' &&
                typeof params.arguments?.owner === 'string' && typeof params.arguments?.repo === 'string') {
              const repo = repos.get(key(params.arguments.owner, params.arguments.repo));
              if (repo) return send(res, 200, { jsonrpc: '2.0', id: body.id, result: {
                content: [{ type: 'text', text: JSON.stringify(repo.data) }],
              } });
            }
            if (params.name === 'create_issue' &&
                ['owner', 'repo', 'title'].some(name => !Object.hasOwn(params.arguments ?? {}, name))) {
              return send(res, 200, { jsonrpc: '2.0', id: body.id, error: { code: -32602, message: 'Missing required arguments: owner, repo, title' } });
            }
            if (params.name === 'create_issue') {
              const args = params.arguments;
              if (!validName(args.owner) || !validName(args.repo)) fail();
              const repo = repos.get(key(args.owner, args.repo));
              if (!repo) throw new ApiError(404, 'Not Found');
              const issue = createIssue(args, repo);
              return send(res, 200, { jsonrpc: '2.0', id: body.id, result: {
                content: [{ type: 'text', text: JSON.stringify(issue) }],
              } });
            }
          }
          if (body.method === 'tools/list' && hasId) {
            return send(res, 200, { jsonrpc: '2.0', id: body.id, result: { tools: mcpTools } });
          }
          if (body.method === 'server/discover' && hasId) {
            return send(res, 200, { jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'Method not found' } });
          }
          if (body.method === 'initialize' && hasId && body.params?.protocolVersion === '2025-11-25') {
            return send(res, 200, { jsonrpc: '2.0', id: body.id, result: {
              protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'github-core-clone', version: '0.0.0' },
            } });
          }
          if (body.method === 'notifications/initialized' && !('id' in body)) {
            res.writeHead(202, { 'content-type': 'application/json; charset=utf-8', 'content-length': 0, 'x-github-request-id': randomUUID() });
            res.end();
            return;
          }
        }
        // Unsupported tool calls and other methods retain the existing refusal.
        throw new ApiError(404, 'Not Found');
      }
      if (method === 'POST' && url.pathname === '/api/graphql') {
        if (!authorized(req, token)) throw new ApiError(401, 'Bad credentials');
        const body = await readBody(req, true);
        if (Array.isArray(body)) {
          // Only the official ViewerLogin, Issue_fields pair is supported, in that order.
          if (body.length !== 2 || body.some(entry => entry === null || typeof entry !== 'object' || Array.isArray(entry))) fail();
          const [viewer, issue] = body as Data[];
          if (typeof viewer.query !== 'string' || typeof issue.query !== 'string' ||
              !/^\s*query\s+ViewerLogin\s*\{\s*viewer\s*\{\s*login\s*\}\s*\}\s*$/.test(viewer.query) ||
              !/^\s*query\s+Issue_fields\s*\{\s*Issue\s*:\s*__type\s*\(\s*name\s*:\s*"Issue"\s*\)\s*\{\s*fields\s*\(\s*includeDeprecated\s*:\s*true\s*\)\s*\{\s*name\s*\}\s*\}\s*\}\s*$/.test(issue.query)) fail();
          return send(res, 200, [
            { data: { viewer: { login: owner } } },
            { data: { Issue: { fields: ['id', 'number', 'title', 'state', 'body'].map(name => ({ name })) } } },
          ]);
        }
        if (typeof body.query === 'string') {
          if (/^\s*query\s+ViewerInvalidField\s*\{\s*viewer\s*\{\s*login\s+noSuchFieldOnViewer\s*\}\s*\}\s*$/.test(body.query)) return send(res, 200, { errors: [{ message: 'Cannot query field "noSuchFieldOnViewer" on type "User".' }] });
          if (/^\s*query\s+ViewerLogin\s*\{\s*viewer\s*\{\s*login\s*\}\s*\}\s*$/.test(body.query)) return send(res, 200, { data: { viewer: { login: owner } } });
          if (/^\s*query\s+Issue_fields\s*\{\s*Issue\s*:\s*__type\s*\(\s*name\s*:\s*"Issue"\s*\)\s*\{\s*fields\s*\(\s*includeDeprecated\s*:\s*true\s*\)\s*\{\s*name\s*\}\s*\}\s*\}\s*$/.test(body.query)) {
            return send(res, 200, { data: { Issue: { fields: ['id', 'number', 'title', 'state', 'body'].map(name => ({ name })) } } });
          }
          if (/^\s*query\s+PullRequestAndRepositoryFields\s*\{\s*PullRequest\s*:\s*__type\s*\(\s*name\s*:\s*"PullRequest"\s*\)\s*\{\s*fields\s*\(\s*includeDeprecated\s*:\s*true\s*\)\s*\{\s*name\s*\}\s*\}\s*Repository\s*:\s*__type\s*\(\s*name\s*:\s*"Repository"\s*\)\s*\{\s*fields\s*\(\s*includeDeprecated\s*:\s*true\s*\)\s*\{\s*name\s*\}\s*\}\s*\}\s*$/.test(body.query)) {
            return send(res, 200, { data: {
              PullRequest: { fields: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'].map(name => ({ name })) },
              Repository: { fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'].map(name => ({ name })) },
            } });
          }
          if (/^\s*query\s+SearchType_enumValues\s*\{\s*SearchType\s*:\s*__type\s*\(\s*name\s*:\s*"SearchType"\s*\)\s*\{\s*enumValues\s*\(\s*includeDeprecated\s*:\s*true\s*\)\s*\{\s*name\s*\}\s*\}\s*\}\s*$/.test(body.query)) {
            return send(res, 200, { data: { SearchType: { enumValues: [{ name: 'ISSUE' }] } } });
          }
          const variables = body.variables;
          if (/^\s*query\s+IssuesPage\s*\(\s*\$owner\s*:\s*String\s*!\s*,\s*\$name\s*:\s*String\s*!\s*,\s*\$first\s*:\s*Int\s*!\s*,\s*\$after\s*:\s*String\s*\)\s*\{\s*repository\s*\(\s*owner\s*:\s*\$owner\s*,\s*name\s*:\s*\$name\s*\)\s*\{\s*issues\s*\(\s*first\s*:\s*\$first\s*,\s*after\s*:\s*\$after\s*\)\s*\{\s*nodes\s*\{\s*number\s*\}\s*pageInfo\s*\{\s*hasNextPage\s+endCursor\s*\}\s*\}\s*\}\s*\}\s*$/.test(body.query) &&
              variables !== null && typeof variables === 'object' && !Array.isArray(variables) &&
              typeof variables.owner === 'string' && typeof variables.name === 'string' &&
              Number.isInteger(variables.first) && variables.first >= 0 && variables.first <= 2147483647 &&
              (variables.after == null || typeof variables.after === 'string')) {
            const repo = repos.get(key(variables.owner, variables.name));
            if (!repo) return send(res, 200, { data: { repository: null } });
            const issues = [...repo.issues.values()].sort((a, b) => a.number - b.number);
            // Bind stable cursors to repository and issue identity, never an array offset.
            const cursor = (issue: Data) => Buffer.from(`IssuesPage:${repo.data.id}:${issue.id}`).toString('base64');
            let start = 0;
            if (variables.after != null) {
              // Canonical comparison rejects malformed encodings and foreign/unknown cursors.
              const index = issues.findIndex(issue => cursor(issue) === variables.after);
              if (index === -1) throw new ApiError(404, 'Not Found');
              start = index + 1;
            }
            const selected = issues.slice(start, start + variables.first);
            return send(res, 200, { data: { repository: { issues: {
              nodes: selected.map(issue => ({ number: issue.number })),
              pageInfo: {
                hasNextPage: start + selected.length < issues.length,
                endCursor: selected.length ? cursor(selected[selected.length - 1]) : null,
              },
            } } } });
          }
          if (/^\s*query\s+OpenIssues\s*\(\s*\$owner\s*:\s*String\s*!\s*,\s*\$name\s*:\s*String\s*!\s*,\s*\$first\s*:\s*Int\s*!\s*\)\s*\{\s*repository\s*\(\s*owner\s*:\s*\$owner\s*,\s*name\s*:\s*\$name\s*\)\s*\{\s*issues\s*\(\s*first\s*:\s*\$first\s*,\s*states\s*:\s*\[\s*OPEN\s*\]\s*,\s*orderBy\s*:\s*\{\s*field\s*:\s*CREATED_AT\s*,\s*direction\s*:\s*DESC\s*\}\s*\)\s*\{\s*nodes\s*\{\s*number\s+title\s+state\s+id\s*\}\s*\}\s*\}\s*\}\s*$/.test(body.query) &&
              variables !== null && typeof variables === 'object' && !Array.isArray(variables) &&
              typeof variables.owner === 'string' && typeof variables.name === 'string' &&
              Number.isInteger(variables.first) && variables.first >= 0 && variables.first <= 2147483647) {
            const repo = repos.get(key(variables.owner, variables.name));
            const nodes = repo ? [...repo.issues.values()]
              .filter(issue => issue.state === 'open')
              .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.number - a.number)
              .slice(0, variables.first)
              .map(issue => ({ number: issue.number, title: issue.title, state: 'OPEN', id: Buffer.from(`Issue:${issue.id}`).toString('base64') })) : [];
            return send(res, 200, { data: { repository: repo ? { issues: { nodes } } : null } });
          }
          if (/^\s*mutation\s+IssueCreate\s*\(\s*\$input\s*:\s*CreateIssueInput\s*!\s*\)\s*\{\s*createIssue\s*\(\s*input\s*:\s*\$input\s*\)\s*\{\s*issue\s*\{\s*number\s+id\s*\}\s*\}\s*\}\s*$/.test(body.query) &&
              variables !== null && typeof variables === 'object' && !Array.isArray(variables) &&
              variables.input !== null && typeof variables.input === 'object' && !Array.isArray(variables.input) &&
              typeof variables.input.repositoryId === 'string') {
            // Resolve only an existing repository's canonical global ID.
            const repo = [...repos.values()].find(
              repo => Buffer.from(`Repository:${repo.data.id}`).toString('base64') === variables.input.repositoryId
            );
            if (repo) {
              const issue = createIssue({ title: variables.input.title, ...('body' in variables.input ? { body: variables.input.body } : {}) }, repo);
              return send(res, 200, { data: { createIssue: { issue: {
                number: issue.number, id: Buffer.from(`Issue:${issue.id}`).toString('base64'),
              } } } });
            }
          }
          if (/^\s*mutation\s+AddComment\s*\(\s*\$input\s*:\s*AddCommentInput\s*!\s*\)\s*\{\s*addComment\s*\(\s*input\s*:\s*\$input\s*\)\s*\{\s*commentEdge\s*\{\s*node\s*\{\s*id\s+body\s*\}\s*\}\s*\}\s*\}\s*$/.test(body.query) &&
              variables !== null && typeof variables === 'object' && !Array.isArray(variables) &&
              variables.input !== null && typeof variables.input === 'object' && !Array.isArray(variables.input) &&
              typeof variables.input.subjectId === 'string' && nonempty(variables.input.body)) {
            for (const repo of repos.values()) {
              if (repo.data.owner.login.toLowerCase() !== owner.toLowerCase()) continue;
              // Match canonical IDs, rejecting malformed encodings and IDs of other node types.
              const issue = [...repo.issues.values()].find(
                issue => Buffer.from(`Issue:${issue.id}`).toString('base64') === variables.input.subjectId
              );
              if (!issue) continue;
              const date = now();
              const comment = { id: nextId++, body: variables.input.body, user: user(owner), created_at: date, updated_at: date };
              const comments = repo.comments.get(issue.id) ?? [];
              comments.push(comment);
              repo.comments.set(issue.id, comments);
              issue.comments = comments.length;
              issue.updated_at = date;
              return send(res, 200, { data: { addComment: { commentEdge: { node: {
                id: Buffer.from(`IssueComment:${comment.id}`).toString('base64'), body: comment.body,
              } } } } });
            }
          }
          if (/^\s*mutation\s+IssueClose\s*\(\s*\$input\s*:\s*CloseIssueInput\s*!\s*\)\s*\{\s*closeIssue\s*\(\s*input\s*:\s*\$input\s*\)\s*\{\s*issue\s*\{\s*number\s+id\s+state\s*\}\s*\}\s*\}\s*$/.test(body.query) &&
              variables !== null && typeof variables === 'object' && !Array.isArray(variables) &&
              variables.input !== null && typeof variables.input === 'object' && !Array.isArray(variables.input) &&
              typeof variables.input.issueId === 'string') {
            // Compare canonical encodings so permissive base64 decoding cannot alias an ID.
            for (const repo of repos.values()) {
              const issue = [...repo.issues.values()].find(
                issue => Buffer.from(`Issue:${issue.id}`).toString('base64') === variables.input.issueId
              );
              if (!issue) continue;
              const date = now();
              if (issue.state !== 'closed') issue.closed_at = date;
              issue.state = 'closed';
              issue.updated_at = date;
              refresh(repo);
              return send(res, 200, { data: { closeIssue: { issue: {
                number: issue.number, id: variables.input.issueId, state: 'CLOSED',
              } } } });
            }
          }
          if (/^\s*query\s+IssueByNumber\s*\(\s*\$owner\s*:\s*String\s*!\s*,\s*\$name\s*:\s*String\s*!\s*,\s*\$number\s*:\s*Int\s*!\s*\)\s*\{\s*repository\s*\(\s*owner\s*:\s*\$owner\s*,\s*name\s*:\s*\$name\s*\)\s*\{\s*issue\s*\(\s*number\s*:\s*\$number\s*\)\s*\{\s*number\s+title\s+state\s+id\s+body\s*\}\s*\}\s*\}\s*$/.test(body.query) &&
              variables !== null && typeof variables === 'object' && !Array.isArray(variables) &&
              typeof variables.owner === 'string' && typeof variables.name === 'string' &&
              Number.isInteger(variables.number) && variables.number >= -2147483648 && variables.number <= 2147483647) {
            const repo = repos.get(key(variables.owner, variables.name));
            const issue = repo?.issues.get(variables.number);
            return send(res, 200, { data: { repository: repo ? { issue: issue ? {
              number: issue.number,
              title: issue.title,
              state: issue.state.toUpperCase(),
              id: Buffer.from(`Issue:${issue.id}`).toString('base64'),
              body: issue.body,
            } : null } : null } });
          }
          if (/^\s*query\s+NodeRepository\s*\(\s*\$id\s*:\s*ID\s*!\s*\)\s*\{\s*node\s*\(\s*id\s*:\s*\$id\s*\)\s*\{\s*id\s*\.\.\.\s+on\s+Repository\s*\{\s*name\s+nameWithOwner\s*\}\s*\}\s*\}\s*$/.test(body.query) &&
              variables !== null && typeof variables === 'object' && !Array.isArray(variables) &&
              typeof variables.id === 'string') {
            const d = [...repos.values()].find(
              repo => Buffer.from(`Repository:${repo.data.id}`).toString('base64') === variables.id
            )?.data;
            return send(res, 200, { data: { node: d ? {
              id: variables.id,
              name: d.name,
              nameWithOwner: d.full_name,
            } : null } });
          }
          if (/^\s*query\s+RepositoryFields\s*\(\s*\$owner\s*:\s*String\s*!\s*,\s*\$name\s*:\s*String\s*!\s*\)\s*\{\s*repository\s*\(\s*owner\s*:\s*\$owner\s*,\s*name\s*:\s*\$name\s*\)\s*\{\s*id\s+databaseId\s+name\s+owner\s*\{\s*login\s*\}\s*defaultBranchRef\s*\{\s*name\s*\}\s*viewerPermission\s+hasIssuesEnabled\s*\}\s*\}\s*$/.test(body.query) &&
              variables !== null && typeof variables === 'object' && !Array.isArray(variables) &&
              typeof variables.owner === 'string' && typeof variables.name === 'string') {
            const repo = repos.get(key(variables.owner, variables.name));
            const d = repo?.data;
            return send(res, 200, { data: { repository: d ? {
              id: Buffer.from(`Repository:${d.id}`).toString('base64'),
              databaseId: d.id,
              name: d.name,
              owner: { login: d.owner.login },
              defaultBranchRef: { name: d.default_branch },
              viewerPermission: 'ADMIN',
              hasIssuesEnabled: true,
            } : null } });
          }
        }
        throw new ApiError(404, 'Not Found');
      }
      if (parts[0] !== 'api' || parts[1] !== 'v3') throw new ApiError(404, 'Not Found');
      const p = parts.slice(2);
      // Read the original path: URL normalization must not hide empty/dot segments.
      const contentsPath = /^\/api\/v3\/repos\/[^/]+\/[^/]+\/contents\/(.*)$/.exec((req.url ?? '').split('?')[0]);
      const fileContents = (method === 'PUT' || method === 'GET' || method === 'DELETE') && contentsPath !== null;
      const createRef = method === 'POST' && p[0] === 'repos' && p.length === 5 && p[3] === 'git' && p[4] === 'refs';
      const listBranches = method === 'GET' && p[0] === 'repos' && p.length === 4 && p[3] === 'branches';
      const listCommits = method === 'GET' && p[0] === 'repos' && p.length === 4 && p[3] === 'commits';
      // Unsupported REST surfaces remain 404.
      const recognized = createRef || listBranches || listCommits || fileContents || p.length === 0 || (p.length === 1 && ['meta', 'user'].includes(p[0])) ||
        (p[0] === 'user' && p[1] === 'repos' && p.length === 2) ||
        (['users', 'orgs'].includes(p[0]) && p[2] === 'repos' && p.length === 3) ||
        (p[0] === 'repos' && (p.length === 3 || (['labels', 'issues'].includes(p[3]) && (p.length === 4 || (p[3] === 'issues' && (p.length === 5 || (p.length === 6 && p[5] === 'comments')))))));
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
        if (method === 'GET') {
          const protocol = req.headers['x-forwarded-proto'] === 'https' || (req.socket as any).encrypted ? 'https' : 'http';
          const listURL = new URL(req.url ?? '/', `${protocol}://${req.headers.host ?? 'entry'}`);
          return send(res, 200, page([...repos.values()].filter(r => r.data.owner.login.toLowerCase() === login.toLowerCase()).map(r => r.data), listURL, res));
        }
        if (method === 'POST' && p[0] !== 'users') {
          const body = await readBody(req);
          return send(res, 201, createRepository(body, login));
        }
      }
      if (p[0] === 'repos') {
        const repo = repos.get(key(p[1], p[2]));
        if (!repo) throw new ApiError(404, 'Not Found');
        if (listCommits) {
          const branch = url.searchParams.get('sha') ?? repo.data.default_branch;
          let head = branch === repo.data.default_branch ? repo.initialCommit?.head : repo.branches.get(branch);
          if (!head) throw new ApiError(404, 'Not Found');
          const history: Data[] = [];
          while (head) {
            const commit = repo.commits.get(head)!;
            history.push({ sha: commit.head, commit: { message: commit.message } });
            head = commit.parent;
          }
          return send(res, 200, history);
        }
        if (createRef || listBranches) {
          const branches = new Map(repo.branches);
          if (repo.initialCommit) branches.set(repo.data.default_branch, repo.initialCommit.head);
          if (listBranches) return send(res, 200, [...branches].map(([name, sha]) => ({ name, commit: { sha } })));
          const body = await readBody(req);
          if (typeof body.ref !== 'string' || !body.ref.startsWith('refs/heads/') ||
              typeof body.sha !== 'string' || !/^[0-9a-fA-F]{40}$/.test(body.sha)) fail();
          const name = body.ref.slice('refs/heads/'.length);
          if (!name || name.endsWith('.') || /[\x00-\x20\x7f~^:?*\[\\]/.test(name) ||
              name.includes('..') || name.includes('@{') ||
              name.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.lock'))) fail();
          if ([...branches.keys()].some(existing => existing === name || existing.startsWith(`${name}/`) || name.startsWith(`${existing}/`))) {
            fail('Validation Failed: branch already exists or conflicts');
          }
          const sha = body.sha.toLowerCase();
          if (!repo.commits.has(sha)) fail('Validation Failed: unknown commit SHA');
          repo.branches.set(name, sha);
          return send(res, 201, { ref: body.ref, object: { sha } });
        }
        if (fileContents) {
          let path: string;
          try { path = decodeURIComponent(contentsPath![1]); }
          catch { throw new ApiError(400, 'Invalid URL'); }
          if (path.split('/').some(name => !name || name === '.' || name === '..' || name.toLowerCase() === '.git') || /[\x00-\x1f\x7f\\]/.test(path)) fail();
          if (method === 'GET') {
            if (url.search) throw new ApiError(404, 'Not Found');
            const entry = repo.initialCommit?.files.get(path);
            if (entry) return send(res, 200, { type: 'file', encoding: 'base64', content: entry.file.toString('base64'), sha: entry.blob, size: entry.file.length });
            const prefix = `${path}/`;
            const descendants = [...(repo.initialCommit?.files ?? [])].filter(([filePath]) => filePath.startsWith(prefix));
            if (!descendants.length) throw new ApiError(404, 'Not Found');
            const entries = descendants.flatMap(([filePath, file]) => {
              const name = filePath.slice(prefix.length);
              return name.includes('/') ? [] : [{ type: 'file', name, path: filePath, sha: file.blob }];
            });
            return send(res, 200, entries);
          }
          const body = await readBody(req);
          if (method === 'DELETE') {
            if (url.search) throw new ApiError(404, 'Not Found');
            if (!nonempty(body.message) || Object.keys(body).some(field => !['message', 'sha'].includes(field))) fail();
            const previous = repo.initialCommit;
            const current = previous?.files.get(path);
            if (!current) throw new ApiError(404, 'Not Found');
            if (!('sha' in body)) throw new ApiError(409, 'Current file SHA is required');
            if (typeof body.sha !== 'string' || !/^[0-9a-fA-F]{40}$/.test(body.sha)) fail();
            if (body.sha.toLowerCase() !== current.blob) throw new ApiError(409, 'File SHA does not match current blob');
            const commit = fileCommit(path, null, body.message, repo.data.default_branch, previous);
            repo.initialCommit = commit;
            repo.commits.set(commit.head, commit);
            return send(res, 200, { commit: { sha: commit.head } });
          }
          if (!nonempty(body.message) || typeof body.content !== 'string' ||
              Object.keys(body).some(field => !['message', 'content', 'sha', 'branch'].includes(field))) fail();
          const file = Buffer.from(body.content, 'base64');
          if (file.toString('base64') !== body.content) fail();
          if ('branch' in body && (typeof body.branch !== 'string' ||
              !(body.branch === repo.data.default_branch ? repo.initialCommit : repo.branches.has(body.branch)))) fail('Validation Failed: unknown branch');
          const branch = body.branch ?? repo.data.default_branch;
          const previous = branch === repo.data.default_branch ? repo.initialCommit : repo.commits.get(repo.branches.get(branch)!);
          const current = previous?.files.get(path);
          if (current) {
            if (url.search) throw new ApiError(404, 'Not Found');
            if (!('sha' in body)) throw new ApiError(409, 'Current file SHA is required');
            if (typeof body.sha !== 'string' || !/^[0-9a-fA-F]{40}$/.test(body.sha)) fail();
            if (body.sha.toLowerCase() !== current.blob) throw new ApiError(409, 'File SHA does not match current blob');
          } else if ('sha' in body) fail();
          if (!current && previous && (previous.files.size >= 3 || [...previous.files.keys()].some(name =>
            name === path || name.startsWith(`${path}/`) || path.startsWith(`${name}/`)))) {
            throw new ApiError(409, 'Only three distinct file creations are supported');
          }
          const commit = fileCommit(path, file, body.message, branch, previous);
          repo.commits.set(commit.head, commit);
          if (branch === repo.data.default_branch) repo.initialCommit = commit;
          else repo.branches.set(branch, commit.head);
          return send(res, 201, { content: { sha: commit.blob, encoding: 'base64' }, commit: { sha: commit.head } });
        }
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
            const issue = createIssue(body, repo);
            return send(res, 201, issue);
          }
          if (p.length === 6 && p[5] === 'comments' && method === 'GET') {
            const issue = /^\d+$/.test(p[4]) ? repo.issues.get(Number(p[4])) : undefined;
            if (!issue) throw new ApiError(404, 'Not Found');
            return send(res, 200, page(repo.comments.get(issue.id) ?? [], url, res));
          }
          if (p.length === 6 && p[5] === 'comments' && method === 'POST') {
            const issue = /^\d+$/.test(p[4]) ? repo.issues.get(Number(p[4])) : undefined;
            if (!issue) throw new ApiError(404, 'Not Found');
            const body = await readBody(req);
            if (!nonempty(body.body) || Object.keys(body).some(field => field !== 'body')) fail();
            const date = now();
            const comment = { id: nextId++, body: body.body, user: user(owner), created_at: date, updated_at: date };
            const comments = repo.comments.get(issue.id) ?? [];
            comments.push(comment);
            repo.comments.set(issue.id, comments);
            issue.comments = comments.length;
            issue.updated_at = date;
            return send(res, 201, comment);
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
