import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.ts';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Duplex } from 'node:stream';

async function fixture(t: any, token = 'test-token', ownerOptions: { owner?: string } = { owner: 'alice' }) {
  const server = createApp({ token, ...ownerOptions });
  return async (path: string, method = 'GET', body?: unknown, authorization: string | null = 'Bearer test-token') => {
    const output: Buffer[] = [];
    const socket = new Duplex({ read() {}, write(chunk, encoding, callback) { output.push(Buffer.from(chunk)); callback(); } });
    const req = new IncomingMessage(socket as any);
    req.url = path;
    req.method = method;
    req.headers = { 'content-type': 'application/json' };
    if (authorization !== null) req.headers.authorization = authorization;
    if (body !== undefined) req.push(Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)));
    req.push(null);
    req.complete = true;
    const res = new ServerResponse(req);
    res.assignSocket(socket as any);
    await new Promise<void>((resolve, reject) => {
      res.on('finish', resolve);
      res.on('error', reject);
      server.emit('request', req, res);
    });
    const wire = Buffer.concat(output).toString('utf8');
    const split = wire.indexOf('\r\n\r\n');
    assert.ok(split > 0);
    assert.match(wire.slice(0, split), /content-type: application\/json/i);
    assert.match(wire.slice(0, split), /x-github-request-id: [^\r\n]+/i);
    const text = wire.slice(split + 4);
    const data = text ? JSON.parse(text) : null;
    if (res.statusCode >= 400) assert.ok(data.message);
    socket.destroy();
    return { status: res.statusCode, data };
  };
}

test('default owner repository is readable through /user/repos', async t => {
  const previousOwner = process.env.MAKEFUN_SHOP_OWNER;
  let call: Awaited<ReturnType<typeof fixture>>;
  try {
    delete process.env.MAKEFUN_SHOP_OWNER;
    call = await fixture(t, 'test-token', {});
  } finally {
    if (previousOwner === undefined) delete process.env.MAKEFUN_SHOP_OWNER;
    else process.env.MAKEFUN_SHOP_OWNER = previousOwner;
  }
  const created = await call('/api/v3/user/repos', 'POST', { name: 'default-owner' });
  assert.equal(created.status, 201);
  assert.equal(created.data.owner.login, 'adaiversen');
  assert.equal(created.data.full_name, 'adaiversen/default-owner');
  const listed = await call('/api/v3/user/repos');
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.data, [created.data]);
  const read = await call('/api/v3/repos/adaiversen/default-owner');
  assert.equal(read.status, 200);
  assert.deepEqual(read.data, created.data);
});

test('bearer auth fails closed and covers reads and writes', async t => {
  const call = await fixture(t);
  for (const auth of [null, '', 'Bearer wrong', 'token test-token', 'Bearer test-token extra']) {
    assert.equal((await call('/api/v3/user/repos', 'POST', { name: 'hidden' }, auth)).status, 401);
    assert.equal((await call('/api/v3/meta', 'GET', undefined, auth)).status, 401);
  }
  assert.deepEqual((await call('/api/v3/user/repos')).data, []);
  assert.equal((await call('/api/v3/meta')).status, 200);
  assert.equal((await call('/healthz', 'GET', undefined, null)).status, 200);
  for (const route of ['/graphql', '/mcp', '/repo.git/info/refs', '/api/v3/unknown']) assert.equal((await call(route)).status, 404);
  const noToken = await fixture(t, '');
  assert.equal((await noToken('/api/v3/meta')).status, 401);
});

test('repository CRUD persists, isolates owners, renames and deletes', async t => {
  const call = await fixture(t);
  const first = await call('/api/v3/user/repos', 'POST', { name: 'demo', description: 'hello', private: true });
  assert.equal(first.status, 201);
  assert.equal(first.data.full_name, 'alice/demo');
  assert.equal((await call('/api/v3/orgs/bob/repos', 'POST', { name: 'demo' })).status, 201);
  assert.equal((await call('/api/v3/user/repos', 'POST', { name: 'DEMO' })).status, 422);
  assert.equal((await call('/api/v3/repos/carol/demo')).status, 404);
  assert.equal((await call('/api/v3/users/alice/repos')).data.length, 1);
  assert.equal((await call('/api/v3/repos/bob/demo')).data.private, false);
  assert.equal((await call('/api/v3/repos/alice/demo', 'PATCH', { name: 'renamed', description: null, private: false })).status, 200);
  assert.equal((await call('/api/v3/repos/alice/demo')).status, 404);
  assert.equal((await call('/api/v3/repos/alice/renamed')).data.id, first.data.id);
  assert.equal((await call('/api/v3/repos/alice/renamed', 'DELETE')).status, 204);
  assert.equal((await call('/api/v3/repos/alice/renamed')).status, 404);
  assert.equal((await call('/api/v3/repos/bob/demo')).status, 200);
});

test('labels and issue CRUD, filtering, closing, reopening and atomic validation', async t => {
  const call = await fixture(t);
  await call('/api/v3/user/repos', 'POST', { name: 'demo' });
  await call('/api/v3/orgs/bob/repos', 'POST', { name: 'demo' });
  const base = '/api/v3/repos/alice/demo';
  assert.equal((await call(`${base}/labels`, 'POST', { name: 'bug', color: '#ff0000' })).status, 422);
  assert.equal((await call(`${base}/labels`, 'POST', { name: 'bug', color: 'FF0000' })).status, 201);
  assert.equal((await call(`${base}/labels`, 'POST', { name: 'BUG', color: 'ff0000' })).status, 422);
  assert.equal((await call(`${base}/issues`, 'POST', { title: 'bad', labels: ['missing'] })).status, 422);
  assert.equal((await call('/api/v3/repos/bob/demo/issues', 'POST', { title: 'bad', labels: ['bug'] })).status, 422);
  const issue = await call(`${base}/issues`, 'POST', { title: 'first', body: 'details', labels: ['bug'] });
  assert.equal(issue.status, 201);
  assert.equal(issue.data.number, 1);
  assert.equal(issue.data.labels[0].name, 'bug');
  assert.equal((await call(`${base}/issues/1`, 'PATCH', { title: 'must not persist', labels: ['missing'] })).status, 422);
  assert.equal((await call(`${base}/issues/1`)).data.title, 'first');
  assert.equal((await call('/api/v3/repos/bob/demo/issues/1')).status, 404);
  assert.equal((await call(`${base}/issues`, 'POST', { title: 'second' })).data.number, 2);
  assert.equal((await call(`${base}/issues?labels=bug`)).data.length, 1);
  assert.equal((await call(`${base}/issues?per_page=1&page=2`)).data[0].number, 1);
  const closed = await call(`${base}/issues/1`, 'PATCH', { state: 'closed', title: 'fixed', body: null, labels: [] });
  assert.equal(closed.data.state, 'closed');
  assert.ok(closed.data.closed_at);
  assert.equal((await call(`${base}/issues`)).data.length, 1);
  assert.equal((await call(`${base}/issues?state=closed`)).data[0].title, 'fixed');
  assert.equal((await call(base)).data.open_issues_count, 1);
  assert.equal((await call(`${base}/issues/1`, 'PATCH', { state: 'open' })).data.closed_at, null);
  assert.equal((await call(base)).data.open_issues_count, 2);
  await call(base, 'PATCH', { name: 'new' });
  assert.equal((await call('/api/v3/repos/alice/new/issues/1')).data.repository_url, '/api/v3/repos/alice/new');
  await call('/api/v3/repos/alice/new', 'DELETE');
  await call('/api/v3/user/repos', 'POST', { name: 'new' });
  assert.deepEqual((await call('/api/v3/repos/alice/new/issues')).data, []);
});

test('malformed JSON and invalid fields are JSON errors without mutation', async t => {
  const call = await fixture(t);
  for (const body of ['{', '', 'null', '[]', '42']) {
    const result = await call('/api/v3/user/repos', 'POST', body);
    assert.ok([400, 422].includes(result.status));
  }
  for (const body of [{}, { name: '../escape' }, { name: 'demo', private: 'false' }]) assert.equal((await call('/api/v3/user/repos', 'POST', body)).status, 422);
  assert.deepEqual((await call('/api/v3/user/repos')).data, []);
  await call('/api/v3/user/repos', 'POST', { name: 'demo' });
  assert.equal((await call('/api/v3/repos/alice/demo', 'PATCH', '{')).status, 400);
  assert.equal((await call('/api/v3/repos/alice/demo/issues', 'POST', { title: '' })).status, 422);
  assert.equal((await call('/api/v3/repos/alice/demo/issues?state=invalid')).status, 422);
  assert.equal((await call('/api/v3/user/repos?page=0')).status, 422);
  assert.equal((await call('/api/v3/repos/%ZZ/demo')).status, 400);
  assert.equal((await call('/api/v3/repos/alice/demo')).data.name, 'demo');
});
