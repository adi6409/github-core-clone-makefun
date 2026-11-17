import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.ts';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Duplex } from 'node:stream';
import { createHash } from 'node:crypto';

test('initial contents PUT creates deterministic nested Unicode file and root commit', async t => {
  const file = Buffer.from('Hello café ☃ 🌍\n', 'utf8');
  const body = { message: 'Initial file', content: file.toString('base64') };
  const hash = (kind: string, bytes: Buffer) => createHash('sha1').update(`${kind} ${bytes.length}\0`).update(bytes).digest('hex');
  const blob = hash('blob', file);
  const leafTree = hash('tree', Buffer.concat([Buffer.from('100644 café.txt\0'), Buffer.from(blob, 'hex')]));
  const rootTree = hash('tree', Buffer.concat([Buffer.from('40000 docs\0'), Buffer.from(leafTree, 'hex')]));
  const commit = hash('commit', Buffer.from(`tree ${rootTree}\nauthor Fixture <fixture@example.invalid> 0 +0000\ncommitter Fixture <fixture@example.invalid> 0 +0000\n\nInitial file\n`));
  let previous: unknown;
  for (let i = 0; i < 2; i++) {
    const call = await fixture(t);
    const created = await call('/api/v3/user/repos', 'POST', { name: 'seed', private: true });
    assert.equal(created.status, 201);
    assert.ok(created.data.default_branch.length > 0);
    const base = '/api/v3/repos/alice/seed';
    const result = await call(`${base}/contents/docs/caf%C3%A9.txt`, 'PUT', body);
    assert.deepEqual(result, { status: 201, data: { content: { sha: blob, encoding: 'base64' }, commit: { sha: commit } } });
    assert.match(result.data.content.sha, /^[0-9a-f]{40}$/);
    assert.match(result.data.commit.sha, /^[0-9a-f]{40}$/);
    if (i) assert.deepEqual(result, previous);
    previous = result;
    for (let read = 0; read < 2; read++) {
      assert.deepEqual(await call(base), { status: 200, data: created.data });
      assert.equal((await call(base)).data.private, true);
    }
    for (const path of ['docs/caf%C3%A9.txt']) {
      assert.equal((await call(`${base}/contents/${path}`, 'PUT', body)).status, 409);
    }
    assert.equal((await call(`${base}/contents/docs/caf%C3%A9.txt`, 'DELETE', body)).status, 422);
    for (const method of ['POST']) {
      assert.equal((await call(`${base}/contents/docs/caf%C3%A9.txt`, method, body)).status, 404);
    }
    assert.equal((await call(`${base}/contents`)).status, 404);
    assert.deepEqual((await call(base)).data, created.data);
    const issue = await call(`${base}/issues`, 'POST', { title: 'IDs unchanged' });
    assert.equal(issue.data.id, created.data.id + 1);
  }
});

test('initial contents PUT refuses invalid input without initializing repository', async t => {
  const call = await fixture(t);
  const repo = (await call('/api/v3/user/repos', 'POST', { name: 'seed', private: true })).data;
  const base = '/api/v3/repos/alice/seed';
  const path = `${base}/contents/first.txt`;
  const body = { message: 'Seed', content: Buffer.from('hello\n').toString('base64') };
  for (const auth of [null, '', 'Bearer wrong', 'token test-token']) {
    for (const payload of [body, '{', null]) {
      assert.equal((await call(path, 'PUT', payload, auth)).status, 401);
    }
  }
  const noToken = await fixture(t, '');
  assert.equal((await noToken(path, 'PUT', body)).status, 401);
  for (const missing of ['/api/v3/repos/alice/missing/contents/a', '/api/v3/repos/bob/seed/contents/a']) {
    assert.equal((await call(missing, 'PUT', body)).status, 404);
  }
  assert.equal((await call(path, 'PUT', '{')).status, 400);
  for (const payload of [null, [], {},
    ...[undefined, null, 1, '', '  ', [], {}].map(message => ({ ...body, message })),
    ...[undefined, null, 1, [], {}, '!!!', 'aGVsbG8', 'aGVsbG8=\n', 'Zh=='].map(content => ({ ...body, content })),
    { ...body, branch: 'main' }, { ...body, branch: null }, { ...body, sha: '0'.repeat(40) },
    { ...body, sha: null }, { ...body, extra: true },
  ]) assert.equal((await call(path, 'PUT', payload)).status, 422);
  for (const suffix of ['', 'a/', 'a//b', 'a/%2E/b', 'a/%2E%2E/b', '%2Ffile', 'a%00b', 'a%5Cb', '.git/config']) {
    assert.equal((await call(`${base}/contents/${suffix}`, 'PUT', body)).status, 422, suffix);
  }
  assert.equal((await call(`${base}/contents/%ZZ/../file`, 'PUT', body)).status, 400);
  assert.deepEqual((await call(base)).data, repo);
  // Every refusal leaves the repository unborn, so this remains its first write.
  const result = await call(path, 'PUT', body);
  assert.equal(result.status, 201);
  assert.equal(result.data.content.sha, 'ce013625030ba8dba906f756967f9e9ca394464a');
  assert.deepEqual((await call(base)).data, repo);
  assert.equal((await call(path, 'PUT', body)).status, 409);
});

test('contents-create keeps both files in a parented second commit and refuses conflicts', async t => {
  const hash = (kind: string, bytes: Buffer) => createHash('sha1').update(`${kind} ${bytes.length}\0`).update(bytes).digest('hex');
  const treeEntry = (mode: string, name: string, sha: string) => Buffer.concat([Buffer.from(`${mode} ${name}\0`), Buffer.from(sha, 'hex')]);
  for (const sibling of [true, false]) {
    const call = await fixture(t);
    const created = await call('/api/v3/user/repos', 'POST', { name: 'two-files', private: true });
    assert.equal(created.status, 201);
    const base = '/api/v3/repos/alice/two-files';
    const seedPath = 'docs/café.txt';
    const newPath = sibling ? 'docs/café-created.txt' : 'docs.txt';
    const fileURL = (path: string) => `${base}/contents/${path.split('/').map(encodeURIComponent).join('/')}`;
    const seed = Buffer.from('seed café 🌍\n');
    const added = Buffer.from('new ☃ café 🌍\n');
    const payload = { message: 'Seeded commit', content: seed.toString('base64') };
    assert.equal((await call(fileURL(seedPath))).status, 404);
    const first = await call(fileURL(seedPath), 'PUT', payload);
    assert.equal(first.status, 201);
    assert.ok((await call(base)).data.default_branch.length > 0);
    const seedSha = hash('blob', seed);
    const addedSha = hash('blob', added);
    const readFiles = async (includeNew: boolean) => {
      for (const [path, bytes, sha] of [[seedPath, seed, seedSha], ...(includeNew ? [[newPath, added, addedSha]] : [])] as [string, Buffer, string][]) {
        assert.deepEqual(await call(fileURL(path)), { status: 200, data: {
          type: 'file', encoding: 'base64', content: bytes.toString('base64'), sha, size: bytes.length,
        } });
      }
    };
    await readFiles(false);
    const body = { ...payload, content: added.toString('base64') };
    for (const auth of [null, '', 'Bearer wrong', 'token test-token']) {
      assert.equal((await call(fileURL(seedPath), 'GET', undefined, auth)).status, 401);
      assert.equal((await call(fileURL(newPath), 'PUT', body, auth)).status, 401);
    }
    for (const extra of [{ branch: 'missing' }, { sha: seedSha }, { extra: true }]) {
      assert.equal((await call(fileURL(newPath), 'PUT', { ...body, ...extra })).status, 422);
    }
    assert.equal((await call(fileURL(newPath), 'PUT', { ...body, content: '!!!' })).status, 422);
    assert.equal((await call(fileURL(newPath), 'PUT', '{')).status, 400);
    for (const path of [seedPath, 'docs', `${seedPath}/child`]) {
      assert.equal((await call(fileURL(path), 'PUT', body)).status, 409);
    }
    for (const method of ['GET', 'PUT']) {
      assert.equal((await call(`${base}/contents/docs/%2E%2E/invalid`, method, body)).status, 422);
      assert.equal((await call(`${base}/contents/%ZZ`, method, body)).status, 400);
    }
    const second = await call(fileURL(newPath), 'PUT', body);
    const docsTree = hash('tree', Buffer.concat(sibling ? [
      treeEntry('100644', 'café-created.txt', addedSha), treeEntry('100644', 'café.txt', seedSha),
    ] : [treeEntry('100644', 'café.txt', seedSha)]));
    // A file named docs.txt sorts before directory docs/ in Git tree order.
    const rootTree = hash('tree', Buffer.concat(sibling ? [treeEntry('40000', 'docs', docsTree)] : [
      treeEntry('100644', 'docs.txt', addedSha), treeEntry('40000', 'docs', docsTree),
    ]));
    const expectedHead = hash('commit', Buffer.from(`tree ${rootTree}\nparent ${first.data.commit.sha}\nauthor Fixture <fixture@example.invalid> 0 +0000\ncommitter Fixture <fixture@example.invalid> 0 +0000\n\n${body.message}\n`));
    assert.deepEqual(second, { status: 201, data: { content: { sha: addedSha, encoding: 'base64' }, commit: { sha: expectedHead } } });
    await readFiles(true);
    for (const path of [seedPath, newPath]) {
      assert.equal((await call(fileURL(path), 'PUT', body)).status, 409);
    }
    assert.equal((await call(fileURL(newPath), 'DELETE', body)).status, 422);
    for (const method of ['POST', 'PATCH']) {
      assert.equal((await call(fileURL(newPath), method, body)).status, 404);
    }
    assert.deepEqual(await call(`${base}/contents/docs`), { status: 200, data: [
      { type: 'file', name: 'café.txt', path: seedPath, sha: seedSha },
      ...(sibling ? [{ type: 'file', name: 'café-created.txt', path: newPath, sha: addedSha }] : []),
    ] });
    for (const suffix of ['', '/missing', `/${encodeURIComponent(newPath)}?ref=${created.data.default_branch}`]) {
      assert.equal((await call(`${base}/contents${suffix}`)).status, 404);
    }
    await readFiles(true);
    assert.deepEqual((await call(base)).data, created.data);
  }
});

test('contents-directory seeds and adds two files with parented commits and immediate file listings', async t => {
  const call = await fixture(t);
  const created = await call('/api/v3/user/repos', 'POST', { name: 'contents-dir', private: true, description: 'Directory fixture' });
  assert.equal(created.status, 201);
  const base = '/api/v3/repos/alice/contents-dir';
  const dir = 'docs/café';
  const url = (path: string) => `${base}/contents/${path.split('/').map(encodeURIComponent).join('/')}`;
  const hash = (kind: string, bytes: Buffer) => createHash('sha1').update(`${kind} ${bytes.length}\0`).update(bytes).digest('hex');
  const treeEntry = (mode: string, name: string, sha: string) => Buffer.concat([Buffer.from(`${mode} ${name}\0`), Buffer.from(sha, 'hex')]);
  const seed = Buffer.from('seed café 🌍\n');
  const added = Buffer.from('new ☃ café 🌍\n');
  const files: { name: string; bytes: Buffer; sha: string }[] = [];
  let head = '';
  const readBack = async () => {
    assert.deepEqual(await call(url(dir)), { status: 200, data: files.map(file => ({
      type: 'file', name: file.name, path: `${dir}/${file.name}`, sha: file.sha,
    })) });
    for (const file of files) {
      assert.deepEqual(await call(url(`${dir}/${file.name}`)), { status: 200, data: {
        type: 'file', encoding: 'base64', content: file.bytes.toString('base64'), sha: file.sha, size: file.bytes.length,
      } });
    }
    assert.deepEqual((await call(base)).data, created.data);
  };
  assert.equal((await call(url(dir))).status, 404);
  for (const name of ['seed.txt', 'one.txt', 'two.txt']) {
    const bytes = name === 'seed.txt' ? seed : added;
    const message = name === 'seed.txt' ? 'Seeded commit' : `Seeded commit (${name})`;
    const sha = hash('blob', bytes);
    files.push({ name, bytes, sha });
    const leaf = hash('tree', Buffer.concat([...files].sort((a, b) => a.name.localeCompare(b.name)).map(file => treeEntry('100644', file.name, file.sha))));
    const docs = hash('tree', treeEntry('40000', 'café', leaf));
    const tree = hash('tree', treeEntry('40000', 'docs', docs));
    const expectedHead = hash('commit', Buffer.from(`tree ${tree}\n${head ? `parent ${head}\n` : ''}author Fixture <fixture@example.invalid> 0 +0000\ncommitter Fixture <fixture@example.invalid> 0 +0000\n\n${message}\n`));
    assert.deepEqual(await call(url(`${dir}/${name}`), 'PUT', { message, content: bytes.toString('base64') }), {
      status: 201, data: { content: { sha, encoding: 'base64' }, commit: { sha: expectedHead } },
    });
    head = expectedHead;
    if (name === 'seed.txt') assert.ok((await call(base)).data.default_branch.length > 0);
  }
  await readBack();
  const body = { message: 'Another file', content: added.toString('base64') };
  for (const auth of [null, '', 'Bearer wrong', 'token test-token']) {
    for (const path of [dir, 'missing', `${dir}/seed.txt`]) {
      assert.equal((await call(url(path), 'GET', undefined, auth)).status, 401);
    }
    assert.equal((await call('/api/v3/repos/alice/absent/contents/docs', 'GET', undefined, auth)).status, 401);
    assert.equal((await call(url(`${dir}/four.txt`), 'PUT', body, auth)).status, 401);
  }
  for (const path of [`${dir}/four.txt`, `${dir}/seed.txt`, dir, `${dir}/seed.txt/child`]) {
    assert.equal((await call(url(path), 'PUT', body)).status, 409);
  }
  for (const payload of [{ ...body, branch: 'missing' }, { ...body, sha: files[0].sha }, { ...body, extra: true }, { ...body, content: '!!!' }, { ...body, message: '' }]) {
    assert.equal((await call(url(`${dir}/four.txt`), 'PUT', payload)).status, 422);
  }
  assert.equal((await call(url(`${dir}/four.txt`), 'PUT', '{')).status, 400);
  for (const method of ['GET', 'PUT']) {
    for (const path of ['', `${dir}/`, `${dir}//bad`, `${dir}/%2E/bad`, `${dir}/%2E%2E/bad`, '.git/config', 'bad%00name', 'bad%5Cname']) {
      assert.equal((await call(`${base}/contents/${path}`, method, body)).status, 422, `${method} ${path}`);
    }
    assert.equal((await call(`${base}/contents/%ZZ`, method, body)).status, 400);
  }
  // Ancestors contain no immediate files: do not return recursive files or directory entries.
  assert.deepEqual(await call(url('docs')), { status: 200, data: [] });
  for (const path of ['missing', `${dir}/missing`, 'docs/caf', `${dir}/four.txt`]) {
    assert.equal((await call(url(path))).status, 404);
  }
  assert.equal((await call(`${base}/contents`)).status, 404);
  for (const path of [dir, `${dir}/seed.txt`]) {
    for (const query of ['?ref=main', '?extra=1']) assert.equal((await call(`${url(path)}${query}`)).status, 404);
    assert.equal((await call(url(path), 'DELETE', body)).status, 422);
    for (const method of ['POST', 'PATCH']) assert.equal((await call(url(path), method, body)).status, 404);
  }
  assert.equal((await call('/api/v3/repos/bob/contents-dir/contents/docs')).status, 404);
  assert.equal((await call('/api/v3/repos/alice/absent/contents/docs')).status, 404);
  await readBack();
});

test('repos.contents-stale-sha updates only a matching blob and preserves rejected-write state', async t => {
  // Local official checks-rest.ts reposContentsStaleSha: seed, GET, update, stale retry.
  for (const siblingCount of [0, 2]) {
    const call = await fixture(t);
    assert.equal((await call('/api/v3/user/repos', 'POST', { name: 'stale', private: true })).status, 201);
    const base = '/api/v3/repos/alice/stale';
    const url = (name: string) => `${base}/contents/docs/${encodeURIComponent(name)}`;
    const seed = Buffer.from('seed café 🌍\n');
    const alternate = Buffer.from('alternate ☃ café 🌍\n');
    const message = 'Seeded commit';
    const payload = (bytes: Buffer) => ({ message, content: bytes.toString('base64') });
    const hash = (kind: string, bytes: Buffer) => createHash('sha1').update(`${kind} ${bytes.length}\0`).update(bytes).digest('hex');
    const entry = (mode: string, name: string, sha: string) => Buffer.concat([Buffer.from(`${mode} ${name}\0`), Buffer.from(sha, 'hex')]);
    const files = new Map<string, Buffer>();
    let head = '';
    const write = async (name: string, bytes: Buffer, sha?: string) => {
      const result = await call(url(name), 'PUT', { ...payload(bytes), ...(sha === undefined ? {} : { sha }) });
      assert.equal(result.status, 201);
      files.set(name, bytes);
      const leaf = hash('tree', Buffer.concat([...files].sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
        .map(([name, bytes]) => entry('100644', name, hash('blob', bytes)))));
      const tree = hash('tree', entry('40000', 'docs', leaf));
      const expected = hash('commit', Buffer.from(`tree ${tree}\n${head ? `parent ${head}\n` : ''}author Fixture <fixture@example.invalid> 0 +0000\ncommitter Fixture <fixture@example.invalid> 0 +0000\n\n${message}\n`));
      assert.deepEqual(result.data, { content: { sha: hash('blob', bytes), encoding: 'base64' }, commit: { sha: expected } });
      head = expected;
      return result;
    };
    const readBack = async () => {
      for (const [name, bytes] of files) {
        assert.deepEqual(await call(url(name)), { status: 200, data: {
          type: 'file', encoding: 'base64', content: bytes.toString('base64'), sha: hash('blob', bytes), size: bytes.length,
        } });
      }
    };
    // SHA never turns an absent path into an update, even in an unborn repository.
    assert.equal((await call(url('seed.txt'), 'PUT', { ...payload(seed), sha: '0'.repeat(40) })).status, 422);
    await write('seed.txt', seed);
    for (let i = 0; i < siblingCount; i++) await write(`sibling-${i}.txt`, seed);
    const current = await call(url('seed.txt'));
    assert.equal(current.status, 200);
    const updated = await write('seed.txt', alternate, current.data.sha);
    assert.notEqual(updated.data.content.sha, current.data.sha);
    await readBack();
    const stale = await call(url('seed.txt'), 'PUT', { ...payload(seed), sha: current.data.sha });
    assert.equal(stale.status, 409);
    assert.ok(typeof stale.data.message === 'string' && stale.data.message.length > 0);
    await readBack();
    assert.equal((await call(url('seed.txt'), 'PUT', payload(seed))).status, 409);
    for (const sha of [null, 1, [], {}, '', 'abc', 'g'.repeat(40), '0'.repeat(39), '0'.repeat(41)]) {
      assert.equal((await call(url('seed.txt'), 'PUT', { ...payload(seed), sha })).status, 422);
    }
    const valid = { ...payload(seed), sha: updated.data.content.sha };
    for (const extra of [{ branch: 'missing' }, { ref: 'main' }, { extra: true }, { content: '!!!' }, { message: '' }]) {
      assert.equal((await call(url('seed.txt'), 'PUT', { ...valid, ...extra })).status, 422);
    }
    assert.equal((await call(`${url('seed.txt')}?ref=main`, 'PUT', valid)).status, 404);
    assert.equal((await call(url('seed.txt'), 'DELETE', valid)).status, 422);
    for (const method of ['PATCH', 'POST']) assert.equal((await call(url('seed.txt'), method, valid)).status, 404);
    assert.equal((await call(url('new.txt'), 'PUT', valid)).status, 422);
    assert.equal((await call(url('new.txt'))).status, 404);
    await readBack();
    // Exact successor hash proves all refused requests left the previous head intact.
    await write('seed.txt', seed, updated.data.content.sha);
    for (let i = siblingCount; i < 2; i++) await write(`sibling-${i}.txt`, seed);
    assert.equal((await call(url('fourth.txt'), 'PUT', payload(seed))).status, 409);
    // Updating at the three-file cap still works and keeps every sibling.
    await write('seed.txt', alternate, current.data.sha);
    await readBack();
  }
});

test('repos.contents-delete removes the seeded file with a deterministic parented empty-tree commit', async t => {
  const hash = (kind: string, bytes: Buffer) => createHash('sha1').update(`${kind} ${bytes.length}\0`).update(bytes).digest('hex');
  const commitHash = (tree: string, parent: string, message: string) => hash('commit', Buffer.from(`tree ${tree}\nparent ${parent}\nauthor Fixture <fixture@example.invalid> 0 +0000\ncommitter Fixture <fixture@example.invalid> 0 +0000\n\n${message}\n`));
  let deletedSha: string | undefined;
  for (let run = 0; run < 2; run++) {
    const call = await fixture(t);
    const repo = await call('/api/v3/user/repos', 'POST', { name: 'delete', private: true });
    assert.equal(repo.status, 201);
    const base = '/api/v3/repos/alice/delete';
    const path = `${base}/contents/docs/caf%C3%A9.txt`;
    const payload = { message: 'Seeded commit', content: Buffer.from('seed café 🌍\n').toString('base64') };
    const initial = await call(path, 'PUT', payload);
    assert.equal(initial.status, 201);
    const entry = await call(path);
    assert.equal(entry.status, 200);
    assert.equal(entry.data.sha, initial.data.content.sha);
    const message = 'Remove seeded file';
    assert.equal((await call(`${base}/contents/docs`, 'DELETE', { message, sha: entry.data.sha })).status, 404);
    assert.deepEqual(await call(path), entry);
    const deleted = await call(path, 'DELETE', { message, sha: entry.data.sha });
    const expected = commitHash('4b825dc642cb6eb9a060e54bf8d69288fbee4904', initial.data.commit.sha, message);
    assert.deepEqual(deleted, { status: 200, data: { commit: { sha: expected } } });
    assert.match(deleted.data.commit.sha, /^[0-9a-f]{40}$/);
    if (run) assert.equal(expected, deletedSha);
    deletedSha = expected;
    for (const missing of [path, `${base}/contents/docs`]) {
      const after = await call(missing);
      assert.equal(after.status, 404);
      assert.ok(typeof after.data.message === 'string' && after.data.message.length > 0);
    }
    assert.equal((await call(path, 'DELETE', { message, sha: entry.data.sha })).status, 404);
    assert.deepEqual((await call(base)).data, repo.data);
    // Recreate through the existing PUT surface: the deletion snapshot must be the parent.
    const bytes = Buffer.from('restored\n');
    const restored = await call(`${base}/contents/restored.txt`, 'PUT', { message: 'Restore', content: bytes.toString('base64') });
    const tree = hash('tree', Buffer.concat([Buffer.from('100644 restored.txt\0'), Buffer.from(hash('blob', bytes), 'hex')]));
    assert.equal(restored.status, 201);
    assert.equal(restored.data.commit.sha, commitHash(tree, expected, 'Restore'));
    assert.equal((await call(path)).status, 404);
  }
});

test('contents DELETE rejects missing, stale and malformed inputs without changing files or head', async t => {
  const call = await fixture(t);
  await call('/api/v3/user/repos', 'POST', { name: 'delete-invalid' });
  const base = '/api/v3/repos/alice/delete-invalid';
  const path = `${base}/contents/seed.txt`;
  const hash = (kind: string, bytes: Buffer) => createHash('sha1').update(`${kind} ${bytes.length}\0`).update(bytes).digest('hex');
  const seed = { message: 'Seed', content: Buffer.from('seed\n').toString('base64') };
  assert.equal((await call(path, 'DELETE', { message: 'Delete', sha: '0'.repeat(40) })).status, 404);
  const first = await call(path, 'PUT', seed);
  const bytes = Buffer.from('updated\n');
  const updated = await call(path, 'PUT', { ...seed, content: bytes.toString('base64'), sha: first.data.content.sha });
  assert.equal(updated.status, 201);
  const before = await call(path);
  const repo = await call(base);
  const valid = { message: 'Delete', sha: before.data.sha };
  const reject = async (url: string, payload: unknown, status: number, auth?: string | null) => {
    const result = await call(url, 'DELETE', payload, auth);
    assert.equal(result.status, status);
    assert.ok(typeof result.data.message === 'string' && result.data.message.length > 0);
    assert.deepEqual(await call(path), before);
    assert.deepEqual(await call(base), repo);
  };
  await reject(path, { message: 'Delete' }, 409);
  await reject(path, { ...valid, sha: first.data.content.sha }, 409);
  await reject(path, { ...valid, sha: '0'.repeat(40) }, 409);
  for (const sha of [null, 1, [], {}, '', 'abc', 'g'.repeat(40), '0'.repeat(39), '0'.repeat(41)]) await reject(path, { ...valid, sha }, 422);
  for (const message of [undefined, null, 1, [], {}, '', '  ']) await reject(path, { ...valid, message }, 422);
  for (const payload of [null, [], {}, { ...valid, content: seed.content }, { ...valid, branch: 'main' }, { ...valid, ref: 'main' }, { ...valid, extra: true }]) await reject(path, payload, 422);
  await reject(path, '{', 400);
  for (const auth of [null, '', 'Bearer wrong', 'token test-token']) await reject(path, '{', 401, auth);
  for (const suffix of ['', 'a/', 'a//b', 'a/%2E/b', 'a/%2E%2E/b', '.git/config', 'a%00b', 'a%5Cb']) await reject(`${base}/contents/${suffix}`, valid, 422);
  await reject(`${base}/contents/%ZZ`, valid, 400);
  for (const url of [`${path}?ref=main`, `${base}/contents/missing`, `${base}/contents`, '/api/v3/repos/alice/absent/contents/seed.txt', '/api/v3/repos/bob/delete-invalid/contents/seed.txt', `${base}/git/refs/heads/main`]) await reject(url, valid, 404);
  // The exact deletion hash proves no rejected request advanced the head.
  const expected = hash('commit', Buffer.from(`tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\nparent ${updated.data.commit.sha}\nauthor Fixture <fixture@example.invalid> 0 +0000\ncommitter Fixture <fixture@example.invalid> 0 +0000\n\nDelete\n`));
  assert.deepEqual(await call(path, 'DELETE', { ...valid, sha: valid.sha.toUpperCase() }), { status: 200, data: { commit: { sha: expected } } });
});

const openIssuesQuery = `query OpenIssues($owner: String!, $name: String!, $first: Int!) {
  repository(owner: $owner, name: $name) {
    issues(first: $first, states: [OPEN], orderBy: {field: CREATED_AT, direction: DESC}) {
      nodes { number title state id }
    }
  }
}`;

test('GraphQL OpenIssues filters before limiting, orders creation times and ties, and returns canonical IDs', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 2000 });
  const call = await fixture(t);
  const name = 'open-issues';
  const base = `/api/v3/repos/alice/${name}`;
  assert.equal((await call('/api/v3/user/repos', 'POST', { name })).status, 201);
  const issues: any[] = [];
  // Reversed clock for #3 distinguishes creation-time ordering from number ordering.
  for (const [title, time] of [['first', 2000], ['second', 3000], ['older', 1000], ['tie', 3000], ['closed', 4000]] as const) {
    t.mock.timers.setTime(time);
    const created = await call(`${base}/issues`, 'POST', { title });
    assert.equal(created.status, 201);
    issues.push(created.data);
  }
  assert.equal((await call(`${base}/issues/5`, 'PATCH', { state: 'closed' })).status, 200);
  const variables = { owner: 'alice', name, first: 10 };
  const expected = (selected: any[]) => ({ status: 200, data: { data: { repository: { issues: { nodes: selected.map(issue => ({
    number: issue.number, title: issue.title, state: 'OPEN', id: Buffer.from(`Issue:${issue.id}`).toString('base64'),
  })) } } } } });
  const ordered = [issues[3], issues[1], issues[0], issues[2]];
  for (const first of [0, 1, 2, 4, 10, 2147483647]) {
    assert.deepEqual(await call('/api/graphql', 'POST', { query: openIssuesQuery, variables: { ...variables, first } }), expected(ordered.slice(0, first)));
  }
  for (const query of [openIssuesQuery.replace(/\s+/g, ' '), openIssuesQuery.replace(/\s+/g, '\t\r\n')]) {
    assert.deepEqual(await call('/api/graphql', 'POST', { query, variables: { ...variables, owner: 'ALICE', name: name.toUpperCase() } }), expected(ordered));
  }
  const read = () => call('/api/graphql', 'POST', { query: openIssuesQuery, variables });
  const before = await read();
  assert.equal(new Set(before.data.data.repository.issues.nodes.map((node: any) => node.id)).size, 4);
  assert.equal((await call(`${base}/issues/4`, 'PATCH', { state: 'closed' })).status, 200);
  assert.deepEqual(await read(), expected(ordered.slice(1)));
  assert.equal((await call(`${base}/issues/4`, 'PATCH', { state: 'open' })).status, 200);
  assert.deepEqual(await read(), before);
  assert.equal((await call('/api/v3/user/repos', 'POST', { name: 'empty' })).status, 201);
  assert.deepEqual(await call('/api/graphql', 'POST', { query: openIssuesQuery, variables: { ...variables, name: 'empty' } }), expected([]));
});

test('GraphQL OpenIssues rejects malformed inputs and nonfixture documents, handles unknown repositories, and authenticates first', async t => {
  const call = await fixture(t);
  const query = openIssuesQuery;
  const variables = { owner: 'alice', name: 'demo', first: 10 };
  const notFound = { status: 404, data: { message: 'Not Found' } };
  for (const lookup of [variables, { ...variables, owner: 'bob' }]) {
    assert.deepEqual(await call('/api/graphql', 'POST', { query, variables: lookup }), { status: 200, data: { data: { repository: null } } });
  }
  for (const invalid of [undefined, null, [], 'invalid', {},
    { name: 'demo', first: 10 }, { owner: 'alice', first: 10 }, { owner: 'alice', name: 'demo' },
    { ...variables, owner: 1 }, { ...variables, name: null },
    ...[-1, 2147483648, 1.5, '10', true, null, [], {}].map(first => ({ ...variables, first }))]) {
    assert.deepEqual(await call('/api/graphql', 'POST', { query, variables: invalid }), notFound);
  }
  for (const document of [null, 1, query.replace('OpenIssues', 'Other'), query.replace('query ', 'mutation '),
    query.replace('[OPEN]', '[CLOSED]'), query.replace('DESC', 'ASC'), query.replace('CREATED_AT', 'UPDATED_AT'),
    query.replace('number title state id', 'number title state id body'), query.replace('number title state id', 'number title state'),
    query.replace('first: $first', 'first: 10'), query.replace('nodes {', 'edges {'), query.replace('Int!', 'Int'),
    query.slice(0, -1), `${query} query ViewerLogin { viewer { login } }`]) {
    assert.deepEqual(await call('/api/graphql', 'POST', { query: document, variables }), notFound);
  }
  for (const auth of [null, '', 'Bearer wrong', 'token test-token', 'Bearer test-token extra']) {
    for (const body of [{ query, variables }, { query, variables: null }, '{', null]) {
      assert.deepEqual(await call('/api/graphql', 'POST', body, auth), { status: 401, data: { message: 'Bad credentials' } });
    }
  }
  const noToken = await fixture(t, '');
  for (const body of [{ query, variables }, '{']) {
    assert.deepEqual(await noToken('/api/graphql', 'POST', body), { status: 401, data: { message: 'Bad credentials' } });
  }
  assert.deepEqual(await call('/api/graphql', 'POST', '{'), { status: 400, data: { message: 'Problems parsing JSON' } });
  assert.deepEqual(await call('/api/graphql', 'POST', null), { status: 422, data: { message: 'Validation Failed' } });
});

async function fixture(t: any, token = 'test-token', ownerOptions: { owner?: string } = { owner: 'alice' }, inspectHeaders?: (headers: string) => void) {
  const server = createApp({ token, ...ownerOptions });
  return async (path: string, method = 'GET', body?: unknown, authorization: string | null = 'Bearer test-token', headers: Record<string, string> = {}) => {
    const output: Buffer[] = [];
    const socket = new Duplex({ read() {}, write(chunk, encoding, callback) { output.push(Buffer.from(chunk)); callback(); } });
    const req = new IncomingMessage(socket as any);
    req.url = path;
    req.method = method;
    req.headers = { 'content-type': 'application/json', ...headers };
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
    inspectHeaders?.(wire.slice(0, split));
    assert.match(wire.slice(0, split), /content-type: application\/json/i);
    assert.match(wire.slice(0, split), /x-github-request-id: [^\r\n]+/i);
    const text = wire.slice(split + 4);
    const data = text ? JSON.parse(text) : null;
    if (res.statusCode >= 400) assert.ok(path === '/mcp' ? data.message || data.error?.message : data.message);
    if (path === '/mcp') assert.equal(res.getHeader('mcp-session-id'), undefined);
    socket.destroy();
    return { status: res.statusCode, data };
  };
}

test('MCP legacy negotiation is stateless and advertises the MCP tools capability', async t => {
  const call = await fixture(t);
  const meta = (revision: string) => ({
    'io.modelcontextprotocol/protocolVersion': revision,
    'io.modelcontextprotocol/clientInfo': { name: 'makefun-github-core-clone-env', version: '1.0.0' },
    'io.modelcontextprotocol/clientCapabilities': {}, protocolVersion: revision,
  });
  assert.deepEqual(await call('/mcp', 'POST', {
    jsonrpc: '2.0', id: 'discover-1', method: 'server/discover', params: { _meta: meta('2026-07-28') },
  }, 'Bearer test-token', { 'mcp-method': 'server/discover', 'mcp-protocol-version': '2026-07-28' }), {
    status: 200, data: { jsonrpc: '2.0', id: 'discover-1', error: { code: -32601, message: 'Method not found' } },
  });
  for (const id of ['initialize-1', 7]) {
    const initialized = await call('/mcp', 'POST', {
      jsonrpc: '2.0', id, method: 'initialize', params: {
        protocolVersion: '2025-11-25', capabilities: {},
        clientInfo: { name: 'makefun-github-core-clone-env', version: '1.0.0' }, _meta: meta('2026-07-28'),
      },
    }, 'Bearer test-token', { 'mcp-method': 'initialize' });
    assert.equal(initialized.status, 200);
    assert.equal(initialized.data.jsonrpc, '2.0');
    assert.equal(initialized.data.id, id);
    assert.equal(initialized.data.result.protocolVersion, '2025-11-25');
    assert.deepEqual(initialized.data.result.capabilities.tools, {});
    assert.ok(initialized.data.result.serverInfo.name.trim());
    assert.ok(initialized.data.result.serverInfo.version.trim());
  }
  assert.deepEqual(await call('/mcp', 'POST', {
    jsonrpc: '2.0', method: 'notifications/initialized', params: { _meta: meta('2025-11-25') },
  }), { status: 202, data: null });
  let firstTools: unknown;
  for (const id of ['list-1', 0]) {
    const listed = await call('/mcp', 'POST', {
      jsonrpc: '2.0', id, method: 'tools/list', params: {},
    }, 'Bearer test-token', { 'mcp-method': 'tools/list', 'mcp-protocol-version': '2025-11-25' });
    assert.equal(listed.status, 200);
    assert.equal(listed.data.jsonrpc, '2.0');
    assert.equal(listed.data.id, id);
    const tools = listed.data.result.tools;
    assert.deepEqual(tools.map((tool: any) => tool.name), [
      'create_repo', 'get_repo', 'create_issue', 'list_issues', 'create_pull_request', 'merge_pull_request',
    ]);
    for (const tool of tools) {
      assert.equal(typeof tool.description, 'string');
      assert.ok(tool.description.trim());
      assert.deepEqual(tool.inputSchema, { type: 'object' });
    }
    if (firstTools === undefined) firstTools = tools;
    else assert.deepEqual(tools, firstTools);
  }
  assert.deepEqual(await call('/mcp', 'POST', '{"jsonrpc": "2.0", "id": 424242, "method": "tools/list"',
    'Bearer test-token', { 'mcp-method': 'tools/list', 'mcp-protocol-version': '2025-11-25' }), {
    status: 400, data: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
  });
  assert.deepEqual((await call('/api/v3/user/repos')).data, []);
});

test('MCP syntax errors use JSON-RPC while valid JSON is not a parse error', async t => {
  const call = await fixture(t);
  for (const body of ['', '{', '{"id":123,', 'not JSON']) {
    assert.deepEqual(await call('/mcp', 'POST', body), {
      status: 400, data: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
    });
  }
  for (const body of ['null', '[]', '42', '{}']) {
    const answer = await call('/mcp', 'POST', body);
    assert.ok(answer.status >= 400);
    assert.notEqual(answer.data.error?.code, -32700);
  }
});

test('MCP authenticates before parsing or negotiation and fails closed', async t => {
  const call = await fixture(t);
  for (const auth of [null, '', 'Bearer wrong', 'token test-token', 'Bearer test-token extra']) {
    for (const body of ['{', { jsonrpc: '2.0', id: 1, method: 'server/discover' },
      { jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2025-11-25' } },
      { jsonrpc: '2.0', id: 3, method: 'tools/list' },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'create_repo', arguments: { name: 'unwanted' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' }]) {
      assert.deepEqual(await call('/mcp', 'POST', body, auth), { status: 401, data: { message: 'Bad credentials' } });
    }
  }
  const noToken = await fixture(t, '');
  assert.equal((await noToken('/mcp', 'POST', '{')).status, 401);
  assert.equal((await noToken('/mcp', 'POST', { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status, 401);
});

test('MCP unknown tools return invalid params after an authenticated legacy handshake', async t => {
  const call = await fixture(t);
  const initialized = await call('/mcp', 'POST', {
    jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2025-11-25', capabilities: {},
      clientInfo: { name: 'makefun-github-core-clone-env', version: '1.0.0' },
    },
  });
  assert.equal(initialized.status, 200);
  assert.equal(initialized.data.result.protocolVersion, '2025-11-25');
  assert.deepEqual(await call('/mcp', 'POST', {
    jsonrpc: '2.0', method: 'notifications/initialized',
  }), { status: 202, data: null });
  for (const id of ['unknown-tool', 0]) {
    for (const params of [{ name: 'mcp_no_such_tool_12345678', arguments: {} }, { name: 'another_unknown_tool' }]) {
      const body = { jsonrpc: '2.0', id, method: 'tools/call', params };
      assert.deepEqual(await call('/mcp', 'POST', body, 'Bearer test-token', {
        'mcp-method': 'tools/call', 'mcp-protocol-version': '2025-11-25',
      }), { status: 200, data: { jsonrpc: '2.0', id, error: { code: -32602, message: 'Unknown tool' } } });
      for (const auth of [null, '', 'Bearer wrong', 'token test-token', 'Bearer test-token extra']) {
        assert.deepEqual(await call('/mcp', 'POST', body, auth), {
          status: 401, data: { message: 'Bad credentials' },
        });
      }
    }
  }
});

test('MCP create_issue stores the actual issue for REST with shared IDs and numbering', async t => {
  const call = await fixture(t);
  const repository = await call('/api/v3/user/repos', 'POST', { name: 'demo' });
  assert.equal(repository.status, 201);
  const base = '/api/v3/repos/alice/demo';
  const first = await call(`${base}/issues`, 'POST', { title: 'REST first' });
  for (const [index, id] of [0, 'create-issue'].entries()) {
    const args = { owner: 'ALICE', repo: 'DEMO', title: `MCP issue ${index}`, body: 'Fixture details' };
    const answer = await call('/mcp', 'POST', {
      jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'create_issue', arguments: args },
    }, 'Bearer test-token', { 'mcp-method': 'tools/call', 'mcp-protocol-version': '2025-11-25' });
    assert.equal(answer.status, 200);
    assert.equal(answer.data.jsonrpc, '2.0');
    assert.equal(answer.data.id, id);
    assert.equal(answer.data.error, undefined);
    assert.equal(answer.data.result.isError, undefined);
    assert.equal(answer.data.result.content.length, 1);
    assert.equal(answer.data.result.content[0].type, 'text');
    const issue = JSON.parse(answer.data.result.content[0].text);
    assert.equal(issue.title, args.title);
    assert.equal(issue.body, args.body);
    assert.equal(issue.id, first.data.id + index + 1);
    assert.equal(issue.number, index + 2);
    assert.equal(issue.state, 'open');
    assert.equal(issue.closed_at, null);
    assert.equal(issue.comments, 0);
    assert.deepEqual(issue.labels, []);
    assert.deepEqual(issue.user, (await call('/api/v3/user')).data);
    assert.ok(Number.isFinite(Date.parse(issue.created_at)));
    assert.equal(issue.updated_at, issue.created_at);
    assert.equal(issue.repository_url, base);
    assert.equal(issue.url, `${base}/issues/${issue.number}`);
    assert.equal(issue.html_url, `/alice/demo/issues/${issue.number}`);
    assert.deepEqual((await call(issue.url)).data, issue);
    assert.deepEqual((await call(`${base}/issues`)).data.find((item: any) => item.title === args.title), issue);
  }
  const last = await call(`${base}/issues`, 'POST', { title: 'REST last' });
  assert.equal(last.data.number, 4);
  assert.equal(last.data.id, first.data.id + 3);
  assert.equal((await call(base)).data.open_issues_count, 4);
});

test('MCP create_issue rejects invalid fields and repositories without storing issues or consuming IDs', async t => {
  const call = await fixture(t);
  const repository = await call('/api/v3/user/repos', 'POST', { name: 'demo' });
  const valid = { owner: 'alice', repo: 'demo', title: 'Issue', body: 'Details' };
  for (const args of [
    ...[null, 42, '', '.', '..', 'a/b', {}, []].flatMap(value => [{ ...valid, owner: value }, { ...valid, repo: value }]),
    ...[null, 42, '', '  ', {}, []].map(title => ({ ...valid, title })),
    ...[42, false, {}, []].map(body => ({ ...valid, body })),
  ]) {
    assert.deepEqual(await call('/mcp', 'POST', {
      jsonrpc: '2.0', id: 0, method: 'tools/call', params: { name: 'create_issue', arguments: args },
    }), { status: 422, data: { message: 'Validation Failed' } });
  }
  for (const args of [{ ...valid, owner: 'bob' }, { ...valid, repo: 'missing' }]) {
    assert.deepEqual(await call('/mcp', 'POST', {
      jsonrpc: '2.0', id: 'missing-repo', method: 'tools/call', params: { name: 'create_issue', arguments: args },
    }), { status: 404, data: { message: 'Not Found' } });
  }
  for (const invalid of [{ id: undefined }, { id: null }, { id: true }, { jsonrpc: '1.0' }]) {
    assert.equal((await call('/mcp', 'POST', {
      jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_issue', arguments: valid }, ...invalid,
    })).status, 404);
  }
  assert.deepEqual((await call('/api/v3/repos/alice/demo/issues')).data, []);
  const created = await call('/api/v3/repos/alice/demo/issues', 'POST', { title: 'First' });
  assert.equal(created.data.number, 1);
  assert.equal(created.data.id, repository.data.id + 1);
});

test('MCP create_issue missing arguments return invalid params after initialize and tools/list', async t => {
  const call = await fixture(t);
  const initialized = await call('/mcp', 'POST', {
    jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2025-11-25', capabilities: {},
      clientInfo: { name: 'makefun-github-core-clone-env', version: '1.0.0' },
    },
  });
  assert.equal(initialized.status, 200);
  assert.equal(initialized.data.result.protocolVersion, '2025-11-25');
  assert.deepEqual(await call('/mcp', 'POST', {
    jsonrpc: '2.0', method: 'notifications/initialized',
  }), { status: 202, data: null });
  const listed = await call('/mcp', 'POST', { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.equal(listed.status, 200);
  assert.ok(listed.data.result.tools.some((tool: any) => tool.name === 'create_issue'));
  for (const id of ['missing-arguments', 0]) {
    for (const args of [{}, undefined, { repo: 'demo', title: 'Issue' },
      { owner: 'alice', title: 'Issue' }, { owner: 'alice', repo: 'demo' }]) {
      const answer = await call('/mcp', 'POST', {
        jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'create_issue', arguments: args },
      }, 'Bearer test-token', { 'mcp-method': 'tools/call', 'mcp-protocol-version': '2025-11-25' });
      assert.equal(answer.status, 200);
      assert.equal(answer.data.jsonrpc, '2.0');
      assert.equal(answer.data.id, id);
      assert.equal(answer.data.error.code, -32602);
      assert.equal(answer.data.result, undefined);
    }
  }
  assert.deepEqual(await call('/mcp', 'POST', {
    jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'create_issue', arguments: { owner: 'alice', repo: 'demo', title: 'Issue' } },
  }), { status: 404, data: { message: 'Not Found' } });
});

test('MCP create_issue authenticates before parsing, validation, lookup, or mutation', async t => {
  const call = await fixture(t);
  await call('/api/v3/user/repos', 'POST', { name: 'demo' });
  const noToken = await fixture(t, '');
  for (const body of ['{', ...[{}, { owner: 'alice', repo: 'demo', title: 'Issue', body: 'Details' },
    { owner: 'alice', repo: 'missing', title: 'Issue' }, { owner: null, repo: 'demo', title: 'Issue' }]
    .map(args => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_issue', arguments: args } }))]) {
    for (const auth of [null, '', 'Bearer wrong', 'token test-token', 'Bearer test-token extra']) {
      assert.deepEqual(await call('/mcp', 'POST', body, auth), { status: 401, data: { message: 'Bad credentials' } });
    }
    assert.deepEqual(await noToken('/mcp', 'POST', body), { status: 401, data: { message: 'Bad credentials' } });
  }
  assert.deepEqual((await call('/api/v3/repos/alice/demo/issues')).data, []);
});

test('MCP malformed tool calls retain unsupported handling', async t => {
  const call = await fixture(t);
  const request = { jsonrpc: '2.0', id: 1, method: 'tools/call' };
  for (const params of [undefined, null, [], 'unknown', {}, { name: 42 }, { name: '' }, { name: ' ' },
    ...[null, [], 'bad', 42, true].map(argumentsValue => ({ name: 'unknown', arguments: argumentsValue }))]) {
    assert.deepEqual(await call('/mcp', 'POST', { ...request, params }), {
      status: 404, data: { message: 'Not Found' },
    });
  }
  for (const invalid of [{ id: undefined }, { id: null }, { id: true }, { jsonrpc: '1.0' }]) {
    assert.deepEqual(await call('/mcp', 'POST', {
      ...request, params: { name: 'unknown', arguments: {} }, ...invalid,
    }), { status: 404, data: { message: 'Not Found' } });
  }
});

test('MCP concurrent get_repo calls preserve request IDs and REST repository data', async t => {
  const call = await fixture(t);
  assert.equal((await call('/mcp', 'POST', {
    jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' },
  })).status, 200);
  await call('/mcp', 'POST', { jsonrpc: '2.0', method: 'notifications/initialized' });
  const listed = await call('/mcp', 'POST', { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const tool = listed.data.result.tools.find((tool: any) => tool.name === 'get_repo');
  assert.ok(tool);
  const owner = (await call('/api/v3/user')).data.login;
  const repositories = [];
  for (const name of ['mcp-concurrent-left', 'mcp-concurrent-right']) {
    const created = await call('/api/v3/user/repos', 'POST', {
      name, private: true, description: 'github-core-clone-01 MCP setup',
    });
    assert.equal(created.status, 201);
    assert.deepEqual((await call(`/api/v3/repos/${owner}/${name}`)).data, created.data);
    repositories.push(created.data);
  }
  assert.notEqual(repositories[0].id, repositories[1].id);
  for (const ids of [['concurrent-left', 'concurrent-right'], [0, 7]]) {
    const answers = await Promise.all(repositories.map((repo, i) => call('/mcp', 'POST', {
      jsonrpc: '2.0', id: ids[i], method: 'tools/call',
      params: { name: tool.name, arguments: { owner, repo: repo.name } },
    }, 'Bearer test-token', { 'mcp-method': 'tools/call', 'mcp-protocol-version': '2025-11-25' })));
    answers.forEach((answer, i) => {
      assert.deepEqual(answer, { status: 200, data: { jsonrpc: '2.0', id: ids[i], result: {
        content: [{ type: 'text', text: JSON.stringify(repositories[i]) }],
      } } });
      assert.deepEqual(JSON.parse(answer.data.result.content[0].text), repositories[i]);
    });
  }
});

test('MCP get_repo retains unknown repository and malformed request handling', async t => {
  const call = await fixture(t);
  await call('/api/v3/user/repos', 'POST', { name: 'demo' });
  const request = { jsonrpc: '2.0', id: 'get-repo', method: 'tools/call',
    params: { name: 'get_repo', arguments: { owner: 'alice', repo: 'demo' } } };
  for (const args of [undefined, null, [], 'bad', {}, { owner: 'alice' }, { repo: 'demo' },
    { owner: 1, repo: 'demo' }, { owner: 'alice', repo: null },
    { owner: 'alice', repo: 'missing' }, { owner: 'bob', repo: 'demo' }]) {
    assert.deepEqual(await call('/mcp', 'POST', {
      ...request, params: { name: 'get_repo', arguments: args },
    }), { status: 404, data: { message: 'Not Found' } });
  }
  for (const invalid of [{ id: undefined }, { id: null }, { id: true }, { jsonrpc: '1.0' }]) {
    assert.deepEqual(await call('/mcp', 'POST', { ...request, ...invalid }), {
      status: 404, data: { message: 'Not Found' },
    });
  }
});

test('MCP get_repo authenticates before lookup, validation, or parsing', async t => {
  const call = await fixture(t);
  await call('/api/v3/user/repos', 'POST', { name: 'demo' });
  const noToken = await fixture(t, '');
  for (const body of ['{', ...[{ owner: 'alice', repo: 'demo' }, { owner: 'alice', repo: 'missing' }, {}]
    .map(args => ({ jsonrpc: '2.0', id: 'get-repo', method: 'tools/call', params: { name: 'get_repo', arguments: args } }))]) {
    for (const auth of [null, '', 'Bearer wrong', 'token test-token', 'Bearer test-token extra']) {
      assert.deepEqual(await call('/mcp', 'POST', body, auth), {
        status: 401, data: { message: 'Bad credentials' },
      });
    }
    assert.deepEqual(await noToken('/mcp', 'POST', body), { status: 401, data: { message: 'Bad credentials' } });
  }
});

test('MCP advertised list_issues returns REST-created issues and filters state', async t => {
  const call = await fixture(t);
  const listed = await call('/mcp', 'POST', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const tool = listed.data.result.tools.find((tool: any) => tool.name === 'list_issues');
  assert.ok(tool);
  const owner = (await call('/api/v3/user')).data.login;
  assert.equal((await call('/api/v3/user/repos', 'POST', { name: 'issues' })).status, 201);
  const base = `/api/v3/repos/${owner}/issues/issues`;
  const opened = await call(base, 'POST', { title: 'REST issue visible over MCP' });
  const closing = await call(base, 'POST', { title: 'Closed REST issue' });
  assert.equal(opened.status, 201);
  assert.equal(closing.status, 201);
  const closed = await call(`${base}/${closing.data.number}`, 'PATCH', { state: 'closed' });
  assert.equal(closed.status, 200);
  for (const [state, expected] of [['open', [opened.data]], ['closed', [closed.data]],
    ['all', [opened.data, closed.data]], [undefined, [opened.data]]] as const) {
    for (const id of [0, 'list-issues']) {
      assert.deepEqual(await call('/mcp', 'POST', {
        jsonrpc: '2.0', id, method: 'tools/call', params: { name: tool.name, arguments: { owner, repo: 'issues', state } },
      }), { status: 200, data: { jsonrpc: '2.0', id, result: {
        content: [{ type: 'text', text: JSON.stringify(expected) }],
      } } });
    }
  }
  assert.equal((await call('/api/v3/user/repos', 'POST', { name: 'empty' })).status, 201);
  const empty = await call('/mcp', 'POST', { jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: tool.name, arguments: { owner, repo: 'empty' } } });
  assert.deepEqual(JSON.parse(empty.data.result.content[0].text), []);
});

test('MCP list_issues bounds results after state filtering', async t => {
  const call = await fixture(t);
  await call('/api/v3/user/repos', 'POST', { name: 'issues' });
  for (let i = 0; i < 102; i++) {
    assert.equal((await call('/api/v3/repos/alice/issues/issues', 'POST', { title: `Issue ${i}` })).status, 201);
  }
  await call('/api/v3/repos/alice/issues/issues/1', 'PATCH', { state: 'closed' });
  const answer = await call('/mcp', 'POST', { jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'list_issues', arguments: { owner: 'ALICE', repo: 'ISSUES', state: 'open' } } });
  assert.equal(answer.status, 200);
  const issues = JSON.parse(answer.data.result.content[0].text);
  assert.equal(issues.length, 100);
  assert.ok(issues.every((issue: any) => issue.state === 'open'));
  assert.equal(issues[0].number, 2);
});

test('MCP list_issues returns tool errors for unknown repositories and malformed arguments', async t => {
  const call = await fixture(t);
  await call('/api/v3/user/repos', 'POST', { name: 'issues' });
  const valid = { owner: 'alice', repo: 'issues' };
  for (const args of [undefined, null, [], 'bad', 42, true, {}, { owner: 'alice' }, { repo: 'issues' },
    ...[null, 1, '', '../alice', {}, []].flatMap(value => [{ ...valid, owner: value }, { ...valid, repo: value }]),
    ...[null, 'invalid', 'OPEN', '', 1, {}, []].map(state => ({ ...valid, state })),
    { ...valid, repo: 'missing' }, { ...valid, owner: 'bob' }]) {
    for (const id of [0, 'invalid-list']) {
      const answer = await call('/mcp', 'POST', { jsonrpc: '2.0', id, method: 'tools/call',
        params: { name: 'list_issues', arguments: args } });
      assert.equal(answer.status, 200);
      assert.equal(answer.data.jsonrpc, '2.0');
      assert.equal(answer.data.id, id);
      assert.equal(answer.data.error, undefined);
      assert.equal(answer.data.result.isError, true);
      assert.equal(answer.data.result.content[0].type, 'text');
      assert.ok(JSON.parse(answer.data.result.content[0].text).message);
    }
  }
  for (const invalid of [{ id: undefined }, { id: null }, { id: true }, { jsonrpc: '1.0' }]) {
    assert.deepEqual(await call('/mcp', 'POST', { jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'list_issues', arguments: valid }, ...invalid }), { status: 404, data: { message: 'Not Found' } });
  }
});

test('MCP list_issues authenticates before lookup, argument validation, or parsing', async t => {
  const call = await fixture(t);
  await call('/api/v3/user/repos', 'POST', { name: 'issues' });
  const noToken = await fixture(t, '');
  for (const body of ['{', ...[{ owner: 'alice', repo: 'issues', state: 'open' },
    { owner: 'alice', repo: 'missing' }, { owner: 'alice', repo: 'issues', state: null }, null, []]
    .map(args => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_issues', arguments: args } }))]) {
    for (const auth of [null, '', 'Bearer wrong', 'token test-token', 'Bearer test-token extra']) {
      assert.deepEqual(await call('/mcp', 'POST', body, auth), { status: 401, data: { message: 'Bad credentials' } });
    }
    assert.deepEqual(await noToken('/mcp', 'POST', body), { status: 401, data: { message: 'Bad credentials' } });
  }
});

test('MCP leaves remaining advertised tool calls and other routes unsupported', async t => {
  const call = await fixture(t);
  for (const method of ['ping', 'unknown']) {
    assert.deepEqual(await call('/mcp', 'POST', {
      jsonrpc: '2.0', id: 1, method, params: { name: 'create_repo', arguments: { name: 'unwanted' } },
    }), { status: 404, data: { message: 'Not Found' } });
  }
  for (const name of ['get_repo', 'create_issue', 'create_pull_request', 'merge_pull_request']) {
    assert.deepEqual(await call('/mcp', 'POST', {
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name, arguments: name === 'create_issue' ? { owner: 'alice', repo: 'demo', title: 'Issue' } : {} },
    }), { status: 404, data: { message: 'Not Found' } });
  }
  for (const body of [
    { jsonrpc: '2.0', method: 'tools/list' },
    { jsonrpc: '2.0', id: null, method: 'tools/list' },
    { jsonrpc: '1.0', id: 1, method: 'tools/list' },
  ]) assert.deepEqual(await call('/mcp', 'POST', body), { status: 404, data: { message: 'Not Found' } });
  assert.equal((await call('/mcp', 'POST', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2026-07-28' } })).status, 404);
  for (const method of ['GET', 'DELETE', 'PUT']) assert.equal((await call('/mcp', method)).status, 404);
  for (const path of ['/mcp/', '/mcp/tools', '/api/v3/mcp']) assert.equal((await call(path, 'POST', {})).status, 404);
  assert.deepEqual((await call('/api/v3/user/repos')).data, []);
});

test('MCP create_repo shares REST state and supports the rest-parity issue continuation', async t => {
  const call = await fixture(t);
  // Official kit sdk/conformance/checks-mcp.ts: mcp.rest-parity sends these four arguments.
  const owner = (await call('/api/v3/user')).data.login;
  const args = { owner, name: 'mcp-12345678-parity', description: 'Parity repository', private: true };
  const answer = await call('/mcp', 'POST', {
    jsonrpc: '2.0', id: 'repo-parity', method: 'tools/call', params: { name: 'create_repo', arguments: args },
  });
  assert.equal(answer.status, 200);
  const repo = JSON.parse(answer.data.result.content[0].text);
  assert.deepEqual(answer.data, { jsonrpc: '2.0', id: 'repo-parity', result: {
    content: [{ type: 'text', text: JSON.stringify(repo) }],
  } });
  assert.equal(repo.id, 1);
  assert.equal(repo.name, args.name);
  assert.equal(repo.owner.login, owner);
  assert.equal(repo.full_name, owner + '/' + args.name);
  assert.equal(repo.private, true);
  assert.equal(repo.description, args.description);
  const path = '/api/v3/repos/' + repo.full_name;
  for (let i = 0; i < 2; i++) assert.deepEqual(await call(path), { status: 200, data: repo });
  assert.deepEqual((await call('/api/v3/user/repos')).data, [repo]);
  const createdIssue = await call('/mcp', 'POST', {
    jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'create_issue', arguments: {
      owner, repo: args.name, title: 'Parity issue', body: 'Fixture details',
    } },
  });
  assert.equal(createdIssue.status, 200);
  const issue = JSON.parse(createdIssue.data.result.content[0].text);
  assert.equal(issue.id, 2);
  assert.equal(issue.number, 1);
  assert.equal(issue.title, 'Parity issue');
  for (let i = 0; i < 2; i++) assert.deepEqual(await call(path + '/issues/1'), { status: 200, data: issue });
  const next = await call('/api/v3/user/repos', 'POST', { name: 'rest-next' });
  assert.equal(next.status, 201);
  assert.equal(next.data.id, 3);
});

test('MCP create_repo rejects invalid arguments and duplicates without mutation or ID allocation', async t => {
  const call = await fixture(t);
  const create = (args: unknown, id: string | number = 0) => call('/mcp', 'POST', {
    jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'create_repo', arguments: args },
  });
  for (const args of [undefined, null, [], 'bad', 42, true, {}, { owner: 'alice' },
    ...['', '.', '..', 'bad/name', 'bad name', 42, null].map(name => ({ name })),
    ...['', '.', '..', 'bad/owner', 'bob', 42, null].map(owner => ({ name: 'demo', owner })),
    { name: 'demo', private: 'true' }, { name: 'demo', description: 42 }]) {
    const answer = await create(args);
    assert.deepEqual(answer, { status: 200, data: { jsonrpc: '2.0', id: 0, result: {
      isError: true, content: [{ type: 'text', text: JSON.stringify({ message: 'Validation Failed' }) }],
    } } });
    assert.deepEqual((await call('/api/v3/user/repos')).data, []);
  }
  const first = await call('/api/v3/user/repos', 'POST', { name: 'Demo', description: 'Original' });
  assert.equal(first.status, 201);
  assert.equal(first.data.id, 1);
  const duplicate = await create({ name: 'DEMO', owner: 'ALICE', private: true }, 'duplicate');
  assert.deepEqual(duplicate, { status: 200, data: { jsonrpc: '2.0', id: 'duplicate', result: {
    isError: true, content: [{ type: 'text', text: JSON.stringify({ message: 'Validation Failed: repository already exists' }) }],
  } } });
  assert.deepEqual(await call('/api/v3/repos/alice/demo'), { status: 200, data: first.data });
  const next = await create({ name: 'next', owner: 'ALICE' }, 3);
  const nextRepo = JSON.parse(next.data.result.content[0].text);
  assert.equal(nextRepo.id, 2);
  assert.equal(nextRepo.owner.login, 'alice');
  assert.equal(nextRepo.private, false);
  assert.equal(nextRepo.description, null);
  const withoutOwner = await create({ name: 'without-owner' });
  assert.equal(JSON.parse(withoutOwner.data.result.content[0].text).owner.login, 'alice');
  const invalidOwner = await fixture(t, 'test-token', { owner: 'bad/owner' });
  const refused = await invalidOwner('/mcp', 'POST', {
    jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_repo', arguments: { name: 'demo' } },
  });
  assert.equal(refused.data.result.isError, true);
  assert.deepEqual((await invalidOwner('/api/v3/user/repos')).data, []);
});

test('MCP create_repo authenticates before parsing or mutation and rejects malformed envelopes', async t => {
  const call = await fixture(t);
  const noToken = await fixture(t, '');
  const request = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
    name: 'create_repo', arguments: { name: 'unwanted', owner: 'alice' },
  } };
  for (const body of [request, { ...request, params: { name: 'create_repo' } }, '{']) {
    for (const auth of [null, 'Bearer wrong', 'Basic test-token']) {
      assert.deepEqual(await call('/mcp', 'POST', body, auth), { status: 401, data: { message: 'Bad credentials' } });
    }
    assert.equal((await noToken('/mcp', 'POST', body)).status, 401);
  }
  for (const invalid of [{ id: undefined }, { id: null }, { id: true }, { jsonrpc: '1.0' }]) {
    assert.deepEqual(await call('/mcp', 'POST', { ...request, ...invalid }), { status: 404, data: { message: 'Not Found' } });
  }
  assert.deepEqual((await call('/api/v3/user/repos')).data, []);
  const created = await call('/api/v3/user/repos', 'POST', { name: 'first' });
  assert.equal(created.data.id, 1);
});

test('MCP preserves the one MiB body cap without treating size errors as parse errors', async t => {
  const call = await fixture(t);
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } });
  assert.equal((await call('/mcp', 'POST', body.padEnd(1_048_576))).status, 200);
  assert.deepEqual(await call('/mcp', 'POST', body.padEnd(1_048_577)), {
    status: 413, data: { message: 'Request body too large' },
  });
});

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

test('GraphQL ViewerLogin returns the token owner and requires bearer authentication', async t => {
  const call = await fixture(t);
  const queries = ['query ViewerLogin { viewer { login } }', `query ViewerLogin {
  viewer {
    login
  }
}`];
  for (const query of queries) {
    assert.deepEqual(await call('/api/graphql', 'POST', { query }), {
      status: 200, data: { data: { viewer: { login: 'alice' } } },
    });
  }
  for (const auth of [null, 'Bearer wrong', 'token test-token']) {
    assert.deepEqual(await call('/api/graphql', 'POST', { query: queries[0] }, auth), {
      status: 401, data: { message: 'Bad credentials' },
    });
  }
  assert.deepEqual(await call('/api/graphql', 'POST', { query: 'query Other { viewer { login } }' }), {
    status: 404, data: { message: 'Not Found' },
  });
  assert.equal((await call('/api/graphql')).status, 404);
});

test('GraphQL ViewerInvalidField reports only the supported document and authenticates before parsing', async t => {
  const call = await fixture(t);
  const query = `query ViewerInvalidField {
  viewer {
    login
    noSuchFieldOnViewer
  }
}`;
  for (const document of [query, query.replace(/\s+/g, ' '), `\t${query.replace(/\s+/g, '\t\n')}\n`,
    'query ViewerInvalidField{viewer{login noSuchFieldOnViewer}}']) {
    const response = await call('/api/graphql', 'POST', { query: document });
    assert.equal(response.status, 200);
    assert.ok(Array.isArray(response.data.errors));
    assert.ok(response.data.errors.length > 0);
    assert.ok(response.data.errors.some((error: { message: string }) => error.message.includes('noSuchFieldOnViewer')));
  }
  for (const auth of [null, '', 'Bearer wrong', 'token test-token', 'Bearer test-token extra']) {
    for (const body of [{ query }, '{']) {
      assert.deepEqual(await call('/api/graphql', 'POST', body, auth), {
        status: 401, data: { message: 'Bad credentials' },
      });
    }
  }
  const noToken = await fixture(t, '');
  for (const body of [{ query }, '{']) {
    assert.deepEqual(await noToken('/api/graphql', 'POST', body), {
      status: 401, data: { message: 'Bad credentials' },
    });
  }
  for (const document of [query.replace('ViewerInvalidField', 'Other'),
    `${query} query ViewerLogin { viewer { login } }`,
    query.replace('noSuchFieldOnViewer', 'NoSuchFieldOnViewer'),
    query.replace('noSuchFieldOnViewer', 'unsupportedField'),
    query.replace('login', 'login extraField'), query.replace('login', ''), null]) {
    assert.deepEqual(await call('/api/graphql', 'POST', { query: document }), {
      status: 404, data: { message: 'Not Found' },
    });
  }
});

test('GraphQL Issue_fields lists required fields only for the supported document and authenticates before parsing', async t => {
  const call = await fixture(t);
  const query = `query Issue_fields {
  Issue: __type(name: "Issue") {
    fields(includeDeprecated: true) {
      name
    }
  }
}`;
  for (const document of [query, query.replace(/\s+/g, ' '), `\t${query.replace(/\s+/g, '\t\r\n')}\n`,
    'query Issue_fields{Issue:__type(name:"Issue"){fields(includeDeprecated:true){name}}}',
    ' query Issue_fields { Issue : __type ( name : "Issue" ) { fields ( includeDeprecated : true ) { name } } } ']) {
    const response = await call('/api/graphql', 'POST', { query: document, variables: {} });
    assert.equal(response.status, 200);
    assert.equal(response.data.errors, undefined);
    assert.ok(Array.isArray(response.data.data.Issue.fields));
    const names = response.data.data.Issue.fields.map((field: { name: string }) => field.name);
    for (const name of ['id', 'number', 'title', 'state', 'body']) assert.ok(names.includes(name), `missing ${name}`);
  }
  for (const auth of [null, '', 'Bearer wrong', 'token test-token', 'Bearer test-token extra']) {
    for (const body of [{ query }, '{']) {
      assert.deepEqual(await call('/api/graphql', 'POST', body, auth), {
        status: 401, data: { message: 'Bad credentials' },
      });
    }
  }
  const noToken = await fixture(t, '');
  for (const body of [{ query }, '{']) {
    assert.deepEqual(await noToken('/api/graphql', 'POST', body), {
      status: 401, data: { message: 'Bad credentials' },
    });
  }
  assert.deepEqual(await call('/api/graphql', 'POST', '{'), {
    status: 400, data: { message: 'Problems parsing JSON' },
  });
  for (const document of [query.replace('Issue_fields', 'Other'), query.replace('Issue:', 'Other:'),
    query.replace('"Issue"', '"Repository"'), query.replace('"Issue"', '" Issue "'),
    query.replace('fields(', 'enumValues('), query.replace('true', 'false'),
    query.replace('      name', '      unsupportedField'), query.replace('      name', '      name extraField'),
    `${query} query ViewerLogin { viewer { login } }`, null]) {
    assert.deepEqual(await call('/api/graphql', 'POST', { query: document }), {
      status: 404, data: { message: 'Not Found' },
    });
  }
});

test('GraphQL official batch returns viewer then Issue fields, with flexible whitespace and no setup', async t => {
  const call = await fixture(t, 'test-token', { owner: 'batch-owner' });
  const viewer = 'query ViewerLogin { viewer { login } }';
  const issue = 'query Issue_fields { Issue: __type(name: "Issue") { fields(includeDeprecated: true) { name } } }';
  const expected = [
    { data: { viewer: { login: 'batch-owner' } } },
    { data: { Issue: { fields: ['id', 'number', 'title', 'state', 'body'].map(name => ({ name })) } } },
  ];
  for (const queries of [
    [viewer, issue],
    [viewer, issue].map(query => `\t${query.replace(/\s+/g, '\r\n\t')}\n`),
    ['query ViewerLogin{viewer{login}}', 'query Issue_fields{Issue:__type(name:"Issue"){fields(includeDeprecated:true){name}}}'],
  ]) {
    for (const withVariables of [false, true]) {
      const body = queries.map(query => withVariables ? { query, variables: {} } : { query });
      assert.deepEqual(await call('/api/graphql', 'POST', body), { status: 200, data: expected });
      const singles = await Promise.all(body.map(operation => call('/api/graphql', 'POST', operation)));
      assert.deepEqual(singles.map(response => response.data), expected);
    }
  }
  assert.deepEqual((await call('/api/v3/user/repos')).data, []);
});

test('GraphQL batches authenticate before parsing and reject unsupported forms without changing REST validation', async t => {
  const call = await fixture(t);
  const noToken = await fixture(t, '');
  const viewer = { query: 'query ViewerLogin { viewer { login } }', variables: {} };
  const issue = { query: 'query Issue_fields { Issue: __type(name: "Issue") { fields(includeDeprecated: true) { name } } }', variables: {} };
  const batch = [viewer, issue];
  for (const auth of [null, '', 'Bearer wrong', 'token test-token', 'Bearer test-token extra']) {
    for (const body of [batch, [], '[']) {
      assert.deepEqual(await call('/api/graphql', 'POST', body, auth), {
        status: 401, data: { message: 'Bad credentials' },
      });
    }
  }
  for (const body of [batch, [], '[']) {
    assert.deepEqual(await noToken('/api/graphql', 'POST', body), {
      status: 401, data: { message: 'Bad credentials' },
    });
  }
  for (const body of [
    [], [viewer], [viewer, issue, viewer], [issue, viewer], [viewer, viewer], [issue, issue],
    ...[null, 1, 'query ViewerLogin { viewer { login } }', [], {}, { query: null }, { query: 42 }]
      .flatMap(entry => [[entry, issue], [viewer, entry]]),
    [viewer, { query: issue.query.replace('Issue_fields', 'Other') }],
    [{ query: viewer.query.replace('ViewerLogin', 'Other') }, issue],
    [viewer, { query: issue.query.replace('true', 'false') }],
    [viewer, { query: issue.query.replace('Issue:', 'Other:') }],
    [viewer, { query: issue.query.replace('"Issue"', '"Repository"') }],
    [{ query: viewer.query.replace('login', 'login extraField') }, issue],
    [viewer, { query: `${issue.query} ${viewer.query}` }],
    [{ query: `${viewer.query} ${issue.query}` }, issue],
    null, 1,
  ]) {
    assert.deepEqual(await call('/api/graphql', 'POST', body), {
      status: 422, data: { message: 'Validation Failed' },
    });
  }
  assert.deepEqual(await call('/api/graphql', 'POST', '['), {
    status: 400, data: { message: 'Problems parsing JSON' },
  });
  assert.deepEqual(await call('/api/graphql', 'POST', JSON.stringify(batch) + ' '.repeat(1_048_576)), {
    status: 413, data: { message: 'Request body too large' },
  });
  for (const body of [batch, [], [{ name: 'not-created' }]]) {
    assert.deepEqual(await call('/api/v3/user/repos', 'POST', body), {
      status: 422, data: { message: 'Validation Failed' },
    });
  }
  assert.deepEqual((await call('/api/v3/user/repos')).data, []);
});

test('GraphQL introspection-types supports only the official documents without repository setup', async t => {
  const call = await fixture(t);
  const noToken = await fixture(t, '');
  const probes = [
    {
      query: `query PullRequestAndRepositoryFields {
  PullRequest: __type(name: "PullRequest") {
    fields(includeDeprecated: true) {
      name
    }
  }
  Repository: __type(name: "Repository") {
    fields(includeDeprecated: true) {
      name
    }
  }
}`,
      operation: 'PullRequestAndRepositoryFields',
      type: 'PullRequest',
      list: 'fields',
      expected: {
        PullRequest: { fields: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'].map(name => ({ name })) },
        Repository: { fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'].map(name => ({ name })) },
      },
    },
    {
      query: `query SearchType_enumValues {
  SearchType: __type(name: "SearchType") {
    enumValues(includeDeprecated: true) {
      name
    }
  }
}`,
      operation: 'SearchType_enumValues',
      type: 'SearchType',
      list: 'enumValues',
      expected: { SearchType: { enumValues: [{ name: 'ISSUE' }] } },
    },
  ];
  for (const { query, operation, type, list, expected } of probes) {
    for (const document of [query, query.replace(/\s+/g, ' '), `\t${query.replace(/\s+/g, '\t\r\n')}\n`,
      query.replace(/\s*([{}():])\s*/g, '$1'), query.replace(/([{}():])/g, ' $1 ')]) {
      assert.deepEqual(await call('/api/graphql', 'POST', { query: document, variables: {} }), {
        status: 200, data: { data: expected },
      });
    }
    for (const auth of [null, '', 'Bearer wrong', 'token test-token', 'Bearer test-token extra']) {
      for (const body of [{ query }, '{']) {
        assert.deepEqual(await call('/api/graphql', 'POST', body, auth), {
          status: 401, data: { message: 'Bad credentials' },
        });
      }
    }
    assert.deepEqual(await noToken('/api/graphql', 'POST', { query }), {
      status: 401, data: { message: 'Bad credentials' },
    });
    for (const document of [
      query.replace(operation, 'Other'), query.replace('query ', 'mutation '),
      query.replace(`${type}:`, 'Other:'), query.replace(`"${type}"`, '"Other"'),
      query.replace(`"${type}"`, `" ${type} "`), query.replace(list + '(', 'unsupported('),
      query.replace('true', 'false'), query.replace('(includeDeprecated: true)', ''),
      query.replace('      name', '      name extraField'), query.replace('      name', '      unsupportedField'),
      query.replace('Repository:', 'Other:'), query.replace('"Repository"', '"Other"'),
      query.replaceAll('true', 'false'), query.slice(0, -1),
      `prefix ${query}`, `${query} query ViewerLogin { viewer { login } }`,
    ].filter(document => document !== query)) {
      assert.deepEqual(await call('/api/graphql', 'POST', { query: document }), {
        status: 404, data: { message: 'Not Found' },
      }, document);
    }
  }
});

test('GraphQL RepositoryFields returns null only for absent repositories and requires authentication', async t => {
  const call = await fixture(t);
  const query = `query RepositoryFields($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    id
    databaseId
    name
    owner {
      login
    }
    defaultBranchRef {
      name
    }
    viewerPermission
    hasIssuesEnabled
  }
}`;
  const variables = { owner: 'alice', name: 'demo-graphql-missing' };
  const missing = { status: 200, data: { data: { repository: null } } };
  const notFound = { status: 404, data: { message: 'Not Found' } };
  for (const document of [query, query.replace(/\s+/g, ' '), query.replace(/\s+/g, '\t\n')]) {
    assert.deepEqual(await call('/api/graphql', 'POST', { query: document, variables }), missing);
  }
  const created = await call('/api/v3/user/repos', 'POST', { name: variables.name });
  assert.equal(created.status, 201);
  const expected = { status: 200, data: { data: { repository: {
    id: Buffer.from(`Repository:${created.data.id}`).toString('base64'),
    databaseId: created.data.id,
    name: created.data.name,
    owner: { login: created.data.owner.login },
    defaultBranchRef: { name: created.data.default_branch },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
  } } } };
  for (const owner of ['alice', 'ALICE']) {
    assert.deepEqual(await call('/api/graphql', 'POST', {
      query, variables: { owner, name: variables.name.toUpperCase() },
    }), expected);
  }
  for (const document of [query, query.replace(/\s+/g, ' '), query.replace(/\s+/g, '\t\n')]) {
    assert.deepEqual(await call('/api/graphql', 'POST', { query: document, variables }), expected);
  }
  const renamed = `${variables.name}-renamed`;
  assert.equal((await call(`/api/v3/repos/alice/${variables.name}`, 'PATCH', { name: renamed })).status, 200);
  assert.deepEqual(await call('/api/graphql', 'POST', { query, variables: { ...variables, name: renamed } }), {
    ...expected, data: { data: { repository: { ...expected.data.data.repository, name: renamed } } },
  });
  assert.equal((await call(`/api/v3/repos/alice/${renamed}`, 'PATCH', { name: variables.name })).status, 200);
  assert.deepEqual(await call('/api/graphql', 'POST', { query, variables }), expected);
  assert.deepEqual(await call('/api/graphql', 'POST', {
    query, variables: { ...variables, owner: 'bob' },
  }), missing);
  for (const invalid of [undefined, null, [], 'invalid', {}, { owner: 'alice' }, { name: 'missing' },
    { owner: 1, name: 'missing' }, { owner: 'alice', name: null }]) {
    assert.deepEqual(await call('/api/graphql', 'POST', { query, variables: invalid }), notFound);
  }
  for (const document of [query.replace('hasIssuesEnabled', 'unsupportedField'),
    query.replace('RepositoryFields', 'Other'), `${query} query ViewerLogin { viewer { login } }`, null]) {
    assert.deepEqual(await call('/api/graphql', 'POST', {
      query: document, variables: { ...variables, owner: 'bob' },
    }), notFound);
  }
  for (const auth of [null, '', 'Bearer wrong', 'token test-token', 'Bearer test-token extra']) {
    for (const body of [{ query, variables }, '{']) {
      assert.deepEqual(await call('/api/graphql', 'POST', body, auth), {
        status: 401, data: { message: 'Bad credentials' },
      });
    }
  }
  const noToken = await fixture(t, '');
  assert.deepEqual(await noToken('/api/graphql', 'POST', { query, variables }), {
    status: 401, data: { message: 'Bad credentials' },
  });
});

const issueByNumberQuery = `query IssueByNumber($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      number
      title
      state
      id
      body
    }
  }
}`;

test('GraphQL IssueByNumber reads the REST fixture and preserves its ID across state changes', async t => {
  const call = await fixture(t);
  const name = 'fixture-graphql';
  const base = `/api/v3/repos/alice/${name}`;
  const created = await call('/api/v3/user/repos', 'POST', { name, private: true, description: 'seed description' });
  assert.equal(created.status, 201);
  assert.equal((await call(base)).data.id, created.data.id);
  const repository = await call('/api/graphql', 'POST', {
    query: `query RepositoryFields($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) {
        id databaseId name owner { login } defaultBranchRef { name } viewerPermission hasIssuesEnabled
      }
    }`, variables: { owner: 'alice', name },
  });
  assert.equal(repository.status, 200);
  assert.equal(repository.data.data.repository.databaseId, created.data.id);
  assert.equal(repository.data.data.repository.id, Buffer.from(`Repository:${created.data.id}`).toString('base64'));
  const issues = [];
  for (const suffix of ['open 1', 'open 2', 'open 3', 'closed']) {
    const response = await call(`${base}/issues`, 'POST', { title: `seed title ${suffix}`, body: 'seed body\nsecond line' });
    assert.equal(response.status, 201);
    issues.push(response.data);
  }
  assert.equal((await call(`${base}/issues/${issues[3].number}`, 'PATCH', { state: 'closed' })).status, 200);
  const first = issues[0];
  const id = Buffer.from(`Issue:${first.id}`).toString('base64');
  assert.notEqual(first.id, first.number);
  const variables = { owner: 'alice', name, number: first.number };
  const expected = (issue: any) => ({ status: 200, data: { data: { repository: { issue: {
    number: issue.number, title: issue.title, state: issue.state.toUpperCase(),
    id: Buffer.from(`Issue:${issue.id}`).toString('base64'), body: issue.body,
  } } } } });
  for (const query of [issueByNumberQuery, issueByNumberQuery.replace(/\s+/g, ' '), issueByNumberQuery.replace(/\s+/g, '\t\r\n')]) {
    assert.deepEqual(await call('/api/graphql', 'POST', { query, variables }), expected(first));
  }
  assert.deepEqual(await call('/api/graphql', 'POST', {
    query: issueByNumberQuery, variables: { ...variables, owner: 'ALICE', name: name.toUpperCase() },
  }), expected(first));
  for (const state of ['closed', 'open']) {
    assert.equal((await call(`${base}/issues/${first.number}`, 'PATCH', { state })).status, 200);
    const rest = await call(`${base}/issues/${first.number}`);
    const graphql = await call('/api/graphql', 'POST', { query: issueByNumberQuery, variables });
    assert.deepEqual(graphql, expected(rest.data));
    assert.equal(graphql.data.data.repository.issue.id, id);
  }
  const closed = await call(`${base}/issues/${issues[3].number}`);
  assert.deepEqual(await call('/api/graphql', 'POST', {
    query: issueByNumberQuery, variables: { ...variables, number: issues[3].number },
  }), expected(closed.data));
});

test('GraphQL IssueByNumber handles unknowns, validates the exact query and authenticates before parsing', async t => {
  const call = await fixture(t);
  const query = issueByNumberQuery;
  const variables = { owner: 'alice', name: 'demo', number: 1 };
  const absentRepo = { status: 200, data: { data: { repository: null } } };
  const absentIssue = { status: 200, data: { data: { repository: { issue: null } } } };
  const notFound = { status: 404, data: { message: 'Not Found' } };
  assert.deepEqual(await call('/api/graphql', 'POST', { query, variables }), absentRepo);
  await call('/api/v3/user/repos', 'POST', { name: 'demo' });
  for (const number of [1, 0, -1, -2147483648, 2147483647]) {
    assert.deepEqual(await call('/api/graphql', 'POST', { query, variables: { ...variables, number } }), absentIssue);
  }
  await call('/api/v3/repos/alice/demo/issues', 'POST', { title: 'existing' });
  for (const unknown of [{ ...variables, owner: 'bob' }, { ...variables, name: 'missing' }]) {
    assert.deepEqual(await call('/api/graphql', 'POST', { query, variables: unknown }), absentRepo);
  }
  for (const invalid of [undefined, null, [], 'invalid', {},
    { name: 'demo', number: 1 }, { owner: 'alice', number: 1 }, { owner: 'alice', name: 'demo' },
    { ...variables, owner: 1 }, { ...variables, name: null },
    ...[null, '1', true, [], {}, 1.5, 2147483648, -2147483649].map(number => ({ ...variables, number }))]) {
    assert.deepEqual(await call('/api/graphql', 'POST', { query, variables: invalid }), notFound);
  }
  for (const document of [null, query.replace('IssueByNumber', 'Other'), query.replace('query ', 'mutation '),
    query.replace('      body', '      body extraField'), query.replace('      title', '      other'),
    query.replace('issue(number: $number)', 'issue(number: 1)'), query.slice(0, -1),
    `${query} query ViewerLogin { viewer { login } }`]) {
    assert.deepEqual(await call('/api/graphql', 'POST', { query: document, variables }), notFound);
  }
  for (const auth of [null, '', 'Bearer wrong', 'token test-token', 'Bearer test-token extra']) {
    for (const body of [{ query, variables }, '{']) {
      assert.deepEqual(await call('/api/graphql', 'POST', body, auth), { status: 401, data: { message: 'Bad credentials' } });
    }
  }
  const noToken = await fixture(t, '');
  for (const body of [{ query, variables }, '{']) {
    assert.deepEqual(await noToken('/api/graphql', 'POST', body), { status: 401, data: { message: 'Bad credentials' } });
  }
  assert.deepEqual(await call('/api/graphql', 'POST', '{'), { status: 400, data: { message: 'Problems parsing JSON' } });
});

test('GraphQL NodeRepository round-trips the REST repository through its RepositoryFields ID', async t => {
  const call = await fixture(t);
  const name = 'demo-graphql-node';
  const created = await call('/api/v3/user/repos', 'POST', { name });
  assert.equal(created.status, 201);
  const read = await call(`/api/v3/repos/alice/${name}`);
  assert.equal(read.status, 200);
  const repository = await call('/api/graphql', 'POST', {
    query: `query RepositoryFields($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    id
    databaseId
    name
    owner {
      login
    }
    defaultBranchRef {
      name
    }
    viewerPermission
    hasIssuesEnabled
  }
}`,
    variables: { owner: 'alice', name },
  });
  assert.equal(repository.status, 200);
  const id = repository.data.data.repository.id;
  assert.equal(id, Buffer.from(`Repository:${read.data.id}`).toString('base64'));
  const query = `query NodeRepository($id: ID!) {
  node(id: $id) {
    id
    ... on Repository {
      name
      nameWithOwner
    }
  }
}`;
  for (const document of [query, query.replace(/\s+/g, ' '), query.replace(/\s+/g, '\t\n')]) {
    assert.deepEqual(await call('/api/graphql', 'POST', { query: document, variables: { id } }), {
      status: 200, data: { data: { node: { id, name, nameWithOwner: `alice/${name}` } } },
    });
  }
  assert.deepEqual(await call('/api/graphql', 'POST', {
    query, variables: { id: Buffer.from('Repository:999999').toString('base64') },
  }), { status: 200, data: { data: { node: null } } });
});

test('repository pagination follows Link headers through 30 REST-created repositories', async t => {
  let responseHeaders = '';
  const call = await fixture(t, 'test-token', { owner: 'alice' }, headers => { responseHeaders = headers; });
  const links = () => Object.fromEntries([...responseHeaders.matchAll(/<([^>]+)>; rel="([^"]+)"/g)].map(([, url, rel]) => [rel, url]));
  const names = Array.from({ length: 30 }, (_, i) => `pagination-${i}`);
  for (const name of names) {
    assert.equal((await call('/api/v3/user/repos', 'POST', { name, private: true })).status, 201);
    assert.deepEqual(links(), {});
    assert.equal((await call(`/api/v3/repos/alice/${name}`)).data.name, name);
    assert.deepEqual(links(), {});
  }
  for (const path of ['/api/v3/user/repos', '/api/v3/users/alice/repos', '/api/v3/orgs/alice/repos']) {
    const seen: string[] = [];
    let next: string | undefined = `https://forge.example${path}?per_page=10&type=owner`;
    let pages = 0;
    while (next) {
      assert.ok(++pages <= 3, 'pagination must terminate');
      const url = new URL(next);
      assert.equal(url.origin, 'https://forge.example');
      assert.equal(url.pathname, path);
      assert.equal(url.searchParams.get('per_page'), '10');
      assert.equal(url.searchParams.get('type'), 'owner');
      const result = await call(url.pathname + url.search, 'GET', undefined, 'Bearer test-token', { host: 'forge.example', 'x-forwarded-proto': 'https' });
      assert.equal(result.status, 200);
      assert.equal(result.data.length, 10);
      seen.push(...result.data.map((repo: any) => repo.name));
      const navigation = links();
      if (pages === 1) {
        assert.equal(navigation.prev, undefined);
        assert.equal(navigation.first, undefined);
      } else {
        assert.equal(new URL(navigation.prev).searchParams.get('page'), String(pages - 1));
        assert.equal(new URL(navigation.first).searchParams.get('page'), '1');
      }
      if (pages < 3) assert.equal(new URL(navigation.last).searchParams.get('page'), '3');
      else assert.equal(navigation.last, undefined);
      next = navigation.next;
    }
    assert.equal(pages, 3);
    assert.equal(new Set(seen).size, seen.length);
    assert.deepEqual(seen, names);
  }
  for (const query of ['', '?per_page=100', '?per_page=101']) {
    assert.equal((await call(`/api/v3/user/repos${query}`)).data.length, 30);
    assert.deepEqual(links(), {});
  }
  assert.deepEqual((await call('/api/v3/users/empty/repos?per_page=10')).data, []);
  assert.deepEqual(links(), {});
  assert.deepEqual((await call('/api/v3/user/repos?per_page=10&page=4')).data, []);
  assert.equal(links().next, undefined);
  for (const query of ['page=0', 'per_page=0', 'page=bad']) {
    assert.equal((await call(`/api/v3/user/repos?${query}`)).status, 422);
    assert.deepEqual(links(), {});
  }
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

const closeIssueQuery = `mutation IssueClose($input: CloseIssueInput!) {
  closeIssue(input: $input) {
    issue {
      number
      id
      state
    }
  }
}`;

test('GraphQL IssueClose closes the canonical issue in place with REST readback, counters and stable ID', async t => {
  const call = await fixture(t);
  const base = '/api/v3/repos/alice/close-fixture';
  await call('/api/v3/user/repos', 'POST', { name: 'other' });
  const other = (await call('/api/v3/repos/alice/other/issues', 'POST', { title: 'other issue' })).data;
  await call('/api/v3/user/repos', 'POST', { name: 'close-fixture' });
  const first = (await call(`${base}/issues`, 'POST', { title: 'close me', body: 'keep body' })).data;
  const second = (await call(`${base}/issues`, 'POST', { title: 'keep open' })).data;
  const variables = { owner: 'alice', name: 'close-fixture', number: first.number };
  const readGraphQL = () => call('/api/graphql', 'POST', { query: issueByNumberQuery, variables });
  const id = (await readGraphQL()).data.data.repository.issue.id;
  assert.equal(id, Buffer.from(`Issue:${first.id}`).toString('base64'));
  assert.notEqual(first.id, first.number);
  assert.equal((await call(base)).data.open_issues_count, 2);
  const before = Date.now();
  assert.deepEqual(await call('/api/graphql', 'POST', {
    query: closeIssueQuery, variables: { input: { issueId: id } },
  }), { status: 200, data: { data: { closeIssue: { issue: { number: first.number, id, state: 'CLOSED' } } } } });
  const closed = (await call(`${base}/issues/${first.number}`)).data;
  assert.deepEqual(closed, { ...first, state: 'closed', closed_at: closed.closed_at, updated_at: closed.updated_at });
  assert.ok(Date.parse(closed.closed_at) >= before);
  assert.ok(Date.parse(closed.updated_at) <= Date.now());
  assert.equal(closed.updated_at, closed.closed_at);
  const repo = (await call(base)).data;
  assert.equal(repo.open_issues_count, 1);
  assert.equal(repo.open_issues, 1);
  assert.deepEqual((await call(`${base}/issues?state=open`)).data.map((issue: any) => issue.id), [second.id]);
  assert.deepEqual((await call(`${base}/issues?state=closed`)).data.map((issue: any) => issue.id), [first.id]);
  assert.equal((await readGraphQL()).data.data.repository.issue.id, id);
  assert.equal((await readGraphQL()).data.data.repository.issue.state, 'CLOSED');
  assert.deepEqual((await call('/api/v3/repos/alice/other/issues/1')).data, other);
  assert.equal((await call('/api/v3/repos/alice/other')).data.open_issues_count, 1);
  // Closing again must not allocate an issue, change its ID, or decrement twice.
  assert.equal((await call('/api/graphql', 'POST', {
    query: closeIssueQuery.replace(/\s+/g, ' '), variables: { input: { issueId: id } },
  })).status, 200);
  assert.equal((await call(`${base}/issues/1`)).data.closed_at, closed.closed_at);
  assert.equal((await call(base)).data.open_issues_count, 1);
  assert.equal((await call(`${base}/issues`, 'POST', { title: 'next' })).data.number, 3);
});

test('GraphQL IssueClose preserves malformed and unknown ID refusals without mutations', async t => {
  const call = await fixture(t);
  const repo = (await call('/api/v3/user/repos', 'POST', { name: 'close-invalid' })).data;
  const base = '/api/v3/repos/alice/close-invalid';
  const issue = (await call(`${base}/issues`, 'POST', { title: 'stay open' })).data;
  const encode = (value: string) => Buffer.from(value).toString('base64');
  const id = encode(`Issue:${issue.id}`);
  const invalidVariables = [undefined, null, [], {}, { issueId: id }, { input: null }, { input: [] }, { input: {} },
    ...[null, 1, {}, [], '', 'garbage', `Issue:${issue.id}`, encode('Issue:999999'), encode(`Repository:${repo.id}`),
      encode(`Issue:0${issue.id}`), encode(`Issue:${issue.id}.0`), id + '\n', id + '=', id.replace(/=+$/, '')]
      .map(issueId => ({ input: { issueId } }))];
  for (const variables of invalidVariables) {
    assert.deepEqual(await call('/api/graphql', 'POST', { query: closeIssueQuery, variables }), {
      status: 404, data: { message: 'Not Found' },
    });
  }
  for (const query of [closeIssueQuery.replace('IssueClose', 'Other'), closeIssueQuery.replace('number\n      id', 'id\n      number'),
    closeIssueQuery + '\nmutation Other { closeIssue { issue { id } } }']) {
    assert.deepEqual(await call('/api/graphql', 'POST', { query, variables: { input: { issueId: id } } }), {
      status: 404, data: { message: 'Not Found' },
    });
  }
  assert.deepEqual((await call(`${base}/issues/1`)).data, issue);
  assert.equal((await call(base)).data.open_issues_count, 1);
});

test('GraphQL IssueClose authenticates before parsing or mutating', async t => {
  const call = await fixture(t);
  await call('/api/v3/user/repos', 'POST', { name: 'close-auth' });
  const base = '/api/v3/repos/alice/close-auth';
  const issue = (await call(`${base}/issues`, 'POST', { title: 'stay open' })).data;
  const operation = { query: closeIssueQuery, variables: { input: { issueId: Buffer.from(`Issue:${issue.id}`).toString('base64') } } };
  for (const auth of [null, 'Bearer wrong', 'Basic test-token']) {
    for (const body of [operation, '{', { query: closeIssueQuery, variables: null }]) {
      assert.deepEqual(await call('/api/graphql', 'POST', body, auth), { status: 401, data: { message: 'Bad credentials' } });
    }
  }
  const noToken = await fixture(t, '');
  assert.deepEqual(await noToken('/api/graphql', 'POST', operation), { status: 401, data: { message: 'Bad credentials' } });
  assert.deepEqual(await call('/api/graphql', 'POST', '{'), { status: 400, data: { message: 'Problems parsing JSON' } });
  assert.deepEqual((await call(`${base}/issues/1`)).data, issue);
  assert.equal((await call(base)).data.open_issues_count, 1);
});

const createIssueQuery = `mutation IssueCreate($input: CreateIssueInput!) {
  createIssue(input: $input) {
    issue {
      number
      id
    }
  }
}`;

async function createIssueSetup(t: any) {
  const call = await fixture(t);
  const base = '/api/v3/repos/alice/create-fixture';
  const repo = (await call('/api/v3/user/repos', 'POST', { name: 'create-fixture' })).data;
  const lookup = await call('/api/graphql', 'POST', {
    query: `query RepositoryFields($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) {
        id databaseId name owner { login } defaultBranchRef { name } viewerPermission hasIssuesEnabled
      }
    }`, variables: { owner: 'alice', name: 'create-fixture' },
  });
  assert.equal(lookup.status, 200);
  const repositoryId = lookup.data.data.repository.id;
  assert.equal(repositoryId, Buffer.from(`Repository:${repo.id}`).toString('base64'));
  return { call, base, repo, repositoryId };
}

test('GraphQL IssueCreate official mutation creates one REST-visible issue with shared numbering, counts and stable ID', async t => {
  const { call, base, repositoryId } = await createIssueSetup(t);
  await call('/api/v3/user/repos', 'POST', { name: 'other-create' });
  const otherBase = '/api/v3/repos/alice/other-create';
  const other = (await call(otherBase)).data;
  const first = (await call(`${base}/issues`, 'POST', { title: 'existing' })).data;
  const input = { repositoryId, title: 'Created over GraphQL ☃', body: 'First line\nSecond **line**' };
  const result = await call('/api/graphql', 'POST', { query: createIssueQuery, variables: { input } });
  const rest = await call(`${base}/issues/2`);
  assert.equal(rest.status, 200);
  const issue = rest.data;
  const id = Buffer.from(`Issue:${issue.id}`).toString('base64');
  assert.deepEqual(result, { status: 200, data: { data: { createIssue: { issue: { number: 2, id } } } } });
  assert.equal(issue.id, first.id + 1);
  assert.equal(issue.title, input.title);
  assert.equal(issue.body, input.body);
  assert.equal(issue.state, 'open');
  assert.equal(issue.closed_at, null);
  assert.deepEqual(issue.labels, []);
  assert.equal(issue.repository_url, base);
  assert.equal((await call(`${base}/issues?state=all`)).data.length, 2);
  const repo = (await call(base)).data;
  assert.equal(repo.open_issues_count, 2);
  assert.equal(repo.open_issues, 2);
  for (let i = 0; i < 2; i++) {
    assert.deepEqual((await call('/api/graphql', 'POST', {
      query: issueByNumberQuery, variables: { owner: 'alice', name: 'create-fixture', number: 2 },
    })).data.data.repository.issue, { number: 2, title: input.title, body: input.body, state: 'OPEN', id });
  }
  assert.deepEqual((await call(otherBase)).data, other);
  assert.deepEqual((await call(`${otherBase}/issues`)).data, []);
  const next = (await call(`${base}/issues`, 'POST', { title: 'next' })).data;
  assert.equal(next.number, 3);
  assert.equal(next.id, issue.id + 1);
  // Whitespace variations and optional nullable body retain the shared creation semantics.
  for (const extra of [{}, { body: null }, { body: '' }]) {
    const response = await call('/api/graphql', 'POST', {
      query: createIssueQuery.replace(/\s+/g, ' '), variables: { input: { repositoryId, title: 'optional body', ...extra } },
    });
    assert.equal(response.status, 200);
    assert.equal((await call(`${base}/issues/${response.data.data.createIssue.issue.number}`)).data.body, extra.body ?? null);
  }
});

test('GraphQL IssueCreate rejects invalid IDs and input without changing state or consuming IDs', async t => {
  const { call, base, repo, repositoryId } = await createIssueSetup(t);
  const encode = (value: string) => Buffer.from(value).toString('base64');
  const first = (await call(`${base}/issues`, 'POST', { title: 'unchanged' })).data;
  const before = (await call(base)).data;
  const input = { repositoryId, title: 'valid', body: 'valid body' };
  const invalidVariables = [undefined, null, [], 'input', 1, {}, { repositoryId },
    ...[undefined, null, [], 'input', 1, {}].map(input => ({ input })),
    ...[null, 1, {}, [], '', 'garbage', String(repo.id), `Repository:${repo.id}`, encode('Repository:999999'),
      encode(`Issue:${first.id}`), encode(`Issue:${repo.id}`), encode(`repository:${repo.id}`), encode(`Repository:0${repo.id}`),
      encode(`Repository:${repo.id}.0`), encode(`Repository:+${repo.id}`), repositoryId + '\n', repositoryId + '=',
      repositoryId.slice(0, -1)].map(repositoryId => ({ input: { ...input, repositoryId } }))];
  for (const variables of invalidVariables) {
    assert.deepEqual(await call('/api/graphql', 'POST', { query: createIssueQuery, variables }), {
      status: 404, data: { message: 'Not Found' },
    });
  }
  for (const invalid of [
    ...[undefined, null, '', '  ', 42, {}, []].map(title => ({ ...input, title })),
    ...[42, false, {}, []].map(body => ({ ...input, body })),
  ]) {
    assert.deepEqual(await call('/api/graphql', 'POST', { query: createIssueQuery, variables: { input: invalid } }), {
      status: 422, data: { message: 'Validation Failed' },
    });
  }
  assert.deepEqual((await call(base)).data, before);
  assert.deepEqual((await call(`${base}/issues?state=all`)).data, [first]);
  const next = (await call(`${base}/issues`, 'POST', { title: 'next' })).data;
  assert.equal(next.number, 2);
  assert.equal(next.id, first.id + 1);
});

test('GraphQL IssueCreate matches only the official mutation document before creating', async t => {
  const { call, base, repo, repositoryId } = await createIssueSetup(t);
  for (const query of [null, '', createIssueQuery.replace('IssueCreate', 'Other'),
    createIssueQuery.replace('mutation', 'query'), createIssueQuery.replace('CreateIssueInput!', 'CreateIssueInput'),
    createIssueQuery.replace('number\n      id', 'id\n      number'), createIssueQuery.replace('number', 'title'),
    createIssueQuery.replace('createIssue(input:', 'alias: createIssue(input:'),
    createIssueQuery.replace('input: $input', 'input: {}'),
    createIssueQuery + '\n' + createIssueQuery, 'junk ' + createIssueQuery, createIssueQuery + ' junk']) {
    assert.deepEqual(await call('/api/graphql', 'POST', {
      query, variables: { input: { repositoryId, title: 'must not create' } },
    }), { status: 404, data: { message: 'Not Found' } });
  }
  assert.deepEqual((await call(base)).data, repo);
  assert.deepEqual((await call(`${base}/issues`)).data, []);
  const next = (await call(`${base}/issues`, 'POST', { title: 'first' })).data;
  assert.equal(next.number, 1);
  assert.equal(next.id, repo.id + 1);
});

test('GraphQL IssueCreate authenticates before parsing, validation, lookup or creation', async t => {
  const { call, base, repo, repositoryId } = await createIssueSetup(t);
  const operation = { query: createIssueQuery, variables: { input: { repositoryId, title: 'authorized only', body: 'body' } } };
  const bodies = [operation, '{', { query: createIssueQuery, variables: null },
    { query: createIssueQuery, variables: { input: { repositoryId: 'unknown', title: null } } }];
  for (const auth of [null, 'Bearer wrong', 'Basic test-token']) {
    for (const body of bodies) {
      assert.deepEqual(await call('/api/graphql', 'POST', body, auth), { status: 401, data: { message: 'Bad credentials' } });
    }
  }
  const noToken = await fixture(t, '');
  for (const body of bodies) {
    assert.deepEqual(await noToken('/api/graphql', 'POST', body), { status: 401, data: { message: 'Bad credentials' } });
  }
  assert.deepEqual(await call('/api/graphql', 'POST', '{'), { status: 400, data: { message: 'Problems parsing JSON' } });
  assert.deepEqual((await call(base)).data, repo);
  assert.deepEqual((await call(`${base}/issues`)).data, []);
  const next = (await call(`${base}/issues`, 'POST', { title: 'first' })).data;
  assert.equal(next.number, 1);
  assert.equal(next.id, repo.id + 1);
});

const issuesPageQuery = 'query IssuesPage($owner: String!, $name: String!, $first: Int!, $after: String) { repository(owner: $owner, name: $name) { issues(first: $first, after: $after) { nodes { number } pageInfo { hasNextPage endCursor } } } }';

test('GraphQL IssuesPage official REST setup paginates 25 issues in a second repository without duplicates or gaps', async t => {
  const call = await fixture(t);
  for (const name of ['primary', 'issues-pagination']) {
    assert.equal((await call('/api/v3/user/repos', 'POST', { name })).status, 201);
  }
  assert.equal((await call('/api/v3/repos/alice/primary/issues', 'POST', { title: 'Unrelated issue' })).status, 201);
  const base = '/api/v3/repos/alice/issues-pagination';
  const numbers: number[] = [];
  for (let i = 0; i < 25; i++) {
    const created = await call(`${base}/issues`, 'POST', { title: `Seed ${i}` });
    assert.equal(created.status, 201);
    numbers.push(created.data.number);
  }
  const variables = { owner: 'alice', name: 'issues-pagination', first: 5, after: null };
  const read = async (overrides = {}, query = issuesPageQuery) => {
    const result = await call('/api/graphql', 'POST', { query, variables: { ...variables, ...overrides } });
    assert.equal(result.status, 200);
    return result.data.data.repository.issues;
  };
  const first = await read();
  assert.deepEqual(first.nodes, numbers.slice(0, 5).map(number => ({ number })));
  assert.equal(first.pageInfo.hasNextPage, true);
  assert.equal(typeof first.pageInfo.endCursor, 'string');
  assert.ok(first.pageInfo.endCursor.length > 0);
  for (const query of [issuesPageQuery, issuesPageQuery.replace(/\s+/g, '\t\r\n'), issuesPageQuery.replace(/\s*([{}():,!])\s*/g, '$1')]) {
    assert.deepEqual(await read({ owner: 'ALICE', name: 'ISSUES-PAGINATION' }, query), first);
  }
  const second = await read({ first: 20, after: first.pageInfo.endCursor });
  assert.deepEqual(second.nodes, numbers.slice(5).map(number => ({ number })));
  assert.equal(second.pageInfo.hasNextPage, false);
  assert.equal(typeof second.pageInfo.endCursor, 'string');
  assert.ok(second.pageInfo.endCursor.length > 0);
  const combined = [...first.nodes, ...second.nodes].map(node => node.number);
  assert.equal(new Set(combined).size, 25);
  assert.deepEqual(combined, numbers);
  assert.deepEqual(await read({ first: 1, after: first.pageInfo.endCursor }), {
    nodes: [{ number: numbers[5] }],
    pageInfo: { hasNextPage: true, endCursor: (await read({ first: 6 })).pageInfo.endCursor },
  });
  // State/title edits do not change ordering or invalidate the cursor's issue identity.
  assert.equal((await call(`${base}/issues/5`, 'PATCH', { state: 'closed', title: 'Changed' })).status, 200);
  assert.deepEqual(await read(), first);
  assert.deepEqual(await read({ first: 20, after: first.pageInfo.endCursor }), second);
  assert.deepEqual(await read({ after: second.pageInfo.endCursor }), {
    nodes: [], pageInfo: { hasNextPage: false, endCursor: null },
  });
  for (const after of [null, first.pageInfo.endCursor]) {
    assert.deepEqual(await read({ first: 0, after }), { nodes: [], pageInfo: { hasNextPage: true, endCursor: null } });
  }
  for (const size of [25, 26, 2147483647]) {
    const all = await read({ first: size, after: undefined });
    assert.deepEqual(all.nodes, numbers.map(number => ({ number })));
    assert.deepEqual(all.pageInfo, second.pageInfo);
  }
  assert.equal((await call('/api/v3/user/repos', 'POST', { name: 'empty-page' })).status, 201);
  assert.deepEqual(await read({ name: 'empty-page' }), { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } });
  const foreign = await read({ name: 'primary' });
  for (const after of ['', 'not-base64!', '1', Buffer.from('IssuesPage:999:999').toString('base64'),
    first.pageInfo.endCursor + '\n', first.pageInfo.endCursor + '=', foreign.pageInfo.endCursor]) {
    assert.deepEqual(await call('/api/graphql', 'POST', { query: issuesPageQuery, variables: { ...variables, after } }), {
      status: 404, data: { message: 'Not Found' },
    });
  }
});

test('GraphQL IssuesPage validates variables and exact documents, handles missing repositories and authenticates first', async t => {
  const call = await fixture(t);
  const query = issuesPageQuery;
  const variables = { owner: 'alice', name: 'pages', first: 5, after: null };
  const notFound = { status: 404, data: { message: 'Not Found' } };
  for (const lookup of [variables, { ...variables, owner: 'unknown' }]) {
    assert.deepEqual(await call('/api/graphql', 'POST', { query, variables: lookup }), {
      status: 200, data: { data: { repository: null } },
    });
  }
  assert.equal((await call('/api/v3/user/repos', 'POST', { name: 'pages' })).status, 201);
  for (const invalid of [undefined, null, [], 'invalid', {},
    { name: 'pages', first: 5 }, { owner: 'alice', first: 5 }, { owner: 'alice', name: 'pages' },
    ...[null, 1, true, [], {}].flatMap(value => [{ ...variables, owner: value }, { ...variables, name: value }]),
    ...[-1, 2147483648, 1.5, '5', true, null, [], {}].map(first => ({ ...variables, first })),
    ...[0, true, [], {}].map(after => ({ ...variables, after }))]) {
    assert.deepEqual(await call('/api/graphql', 'POST', { query, variables: invalid }), notFound);
  }
  for (const document of [null, 1, query.replace('IssuesPage', 'Other'), query.replace('query ', 'mutation '),
    query.replace('$after: String)', '$after: String!)'), query.replace('Int!', 'Int'),
    query.replace('first: $first', 'first: 5'), query.replace('after: $after', 'after: null'),
    query.replace('number }', 'number title }'), query.replace('nodes', 'edges'),
    query.replace('hasNextPage endCursor', 'hasNextPageendCursor'), query.replace('hasNextPage endCursor', 'endCursor hasNextPage'),
    query.replace('query IssuesPage', 'queryIssuesPage'), query.slice(0, -1), `${query} ${query}`]) {
    assert.deepEqual(await call('/api/graphql', 'POST', { query: document, variables }), notFound);
  }
  for (const auth of [null, '', 'Bearer wrong', 'token test-token', 'Bearer test-token extra']) {
    for (const body of [{ query, variables }, { query, variables: { ...variables, after: 'bad' } }, '{', null]) {
      assert.deepEqual(await call('/api/graphql', 'POST', body, auth), { status: 401, data: { message: 'Bad credentials' } });
    }
  }
  const noToken = await fixture(t, '');
  for (const body of [{ query, variables }, '{']) {
    assert.deepEqual(await noToken('/api/graphql', 'POST', body), { status: 401, data: { message: 'Bad credentials' } });
  }
  assert.deepEqual(await call('/api/graphql', 'POST', '{'), { status: 400, data: { message: 'Problems parsing JSON' } });
  assert.deepEqual(await call('/api/graphql', 'POST', null), { status: 422, data: { message: 'Validation Failed' } });
});

const addCommentQuery = `mutation AddComment($input: AddCommentInput!) {
  addComment(input: $input) {
    commentEdge {
      node {
        id
        body
      }
    }
  }
}`;

async function addCommentSetup(t: any) {
  const call = await fixture(t);
  const repo = (await call('/api/v3/user/repos', 'POST', { name: 'comments' })).data;
  const base = '/api/v3/repos/alice/comments';
  const issue = (await call(`${base}/issues`, 'POST', { title: 'Comment target', body: 'Issue body' })).data;
  const subjectId = Buffer.from(`Issue:${issue.id}`).toString('base64');
  return { call, repo, base, issue, subjectId };
}

test('REST issues.comment-create validates, authenticates and stores comments per issue', async t => {
  const { call, base, issue } = await addCommentSetup(t);
  const path = `${base}/issues/${issue.number}`;
  const other = (await call(`${base}/issues`, 'POST', { title: 'Other issue' })).data;
  await call('/api/v3/user/repos', 'POST', { name: 'other-comments' });
  const otherBase = '/api/v3/repos/alice/other-comments';
  const foreign = (await call(`${otherBase}/issues`, 'POST', { title: 'Other repository' })).data;
  const body = '  Exact comment\nwith unicode: café ☃  ';
  const result = await call(`${path}/comments`, 'POST', { body });
  assert.equal(result.status, 201);
  assert.ok(Number.isInteger(result.data.id) && result.data.id > 0);
  assert.equal(result.data.body, body);
  assert.deepEqual(await call(`${path}/comments`), { status: 200, data: [result.data] });
  const after = (await call(path)).data;
  assert.equal(after.comments, 1);
  assert.deepEqual({ ...after, comments: 0, updated_at: issue.updated_at }, issue);
  for (const missing of [`${base}/issues/999/comments`, `${base}/issues/nope/comments`, '/api/v3/repos/alice/missing/issues/1/comments']) {
    assert.deepEqual(await call(missing, 'POST', { body }), { status: 404, data: { message: 'Not Found' } });
  }
  for (const payload of [null, [], {}, ...[null, 0, true, {}, [], '', ' \n\t '].map(body => ({ body })), { body, extra: true }]) {
    assert.deepEqual(await call(`${path}/comments`, 'POST', payload), { status: 422, data: { message: 'Validation Failed' } });
  }
  assert.deepEqual(await call(`${path}/comments`, 'POST', '{'), { status: 400, data: { message: 'Problems parsing JSON' } });
  const unauthorized = { status: 401, data: { message: 'Bad credentials' } };
  for (const auth of [null, '', 'Bearer wrong', 'token test-token', 'Bearer test-token extra']) {
    for (const target of [`${path}/comments`, `${base}/issues/999/comments`, '/api/v3/repos/alice/missing/issues/1/comments']) {
      for (const payload of [{ body }, '{', null]) assert.deepEqual(await call(target, 'POST', payload, auth), unauthorized);
    }
    assert.deepEqual(await call(`${path}/comments`, 'GET', undefined, auth), unauthorized);
  }
  const noToken = await fixture(t, '');
  assert.deepEqual(await noToken(`${path}/comments`, 'POST', { body }), unauthorized);
  assert.deepEqual((await call(path)).data, after);
  assert.deepEqual((await call(`${path}/comments`)).data, [result.data]);
  for (const target of [`${base}/issues/${other.number}`, `${otherBase}/issues/${foreign.number}`]) {
    assert.deepEqual((await call(`${target}/comments`)).data, []);
    assert.equal((await call(target)).data.comments, 0);
  }
  const second = await call(`${path}/comments`, 'POST', { body: 'Second comment' });
  assert.equal(second.status, 201);
  assert.equal(second.data.id, result.data.id + 1);
  assert.deepEqual((await call(`${path}/comments`)).data, [result.data, second.data]);
  assert.equal((await call(path)).data.comments, 2);
});

test('GraphQL AddComment official mutation shares REST storage, preserves issue state and paginates comments', async t => {
  const { call, base, issue, subjectId } = await addCommentSetup(t);
  const path = `${base}/issues/${issue.number}`;
  const closed = (await call(path, 'PATCH', { state: 'closed' })).data;
  assert.deepEqual((await call(`${path}/comments`)).data, []);
  const ids: string[] = [];
  const bodies = ['Exact body\nwith unicode: café', 'Second comment'];
  for (const body of bodies) {
    const result = await call('/api/graphql', 'POST', { query: addCommentQuery, variables: { input: { subjectId, body } } });
    assert.equal(result.status, 200);
    const node = result.data.data.addComment.commentEdge.node;
    assert.equal(typeof node.id, 'string');
    assert.ok(node.id.length > 0);
    assert.deepEqual(result.data, { data: { addComment: { commentEdge: { node: { id: node.id, body } } } } });
    ids.push(node.id);
  }
  assert.equal(new Set(ids).size, 2);
  const comments = (await call(`${path}/comments`)).data;
  assert.deepEqual(comments.map((c: any) => c.body), bodies);
  assert.deepEqual(comments.map((c: any) => Buffer.from(`IssueComment:${c.id}`).toString('base64')), ids);
  for (const page of [1, 2, 3]) {
    assert.deepEqual((await call(`${path}/comments?per_page=1&page=${page}`)).data, comments.slice(page - 1, page));
  }
  const after = (await call(path)).data;
  assert.deepEqual({ ...after, updated_at: closed.updated_at, comments: 0 }, closed);
  assert.equal(after.comments, 2);
  const other = (await call(`${base}/issues`, 'POST', { title: 'Other issue' })).data;
  assert.deepEqual((await call(`${base}/issues/${other.number}/comments`)).data, []);
  assert.equal((await call(`${base}/issues/999/comments`)).status, 404);
  assert.equal((await call(`${path}/comments?page=0`)).status, 422);
});

test('GraphQL AddComment rejects malformed inputs and foreign identifiers without mutation', async t => {
  const { call, base, issue, repo, subjectId } = await addCommentSetup(t);
  await call('/api/v3/orgs/foreign/repos', 'POST', { name: 'comments' });
  const foreign = (await call('/api/v3/repos/foreign/comments/issues', 'POST', { title: 'Foreign' })).data;
  const encode = (s: string) => Buffer.from(s).toString('base64');
  const input = { subjectId, body: 'Comment' };
  const invalidInputs = [null, [], 'bad', {}, { body: 'Missing ID' }, { subjectId },
    ...[null, 0, true, {}, [], '', '  '].map(body => ({ ...input, body })),
    ...[null, 0, {}, [], '', 'not-base64!', subjectId + '\n', subjectId + '=',
      encode(`Issue:0${issue.id}`), encode(`Repository:${repo.id}`), encode(`IssueComment:${issue.id}`),
      encode('Issue:999999'), encode(`Issue:${foreign.id}`)].map(subjectId => ({ ...input, subjectId }))];
  const rejected = { status: 404, data: { message: 'Not Found' } };
  for (const invalid of invalidInputs) {
    assert.deepEqual(await call('/api/graphql', 'POST', { query: addCommentQuery, variables: { input: invalid } }), rejected);
  }
  for (const variables of [null, [], 'bad', {}]) {
    assert.deepEqual(await call('/api/graphql', 'POST', { query: addCommentQuery, variables }), rejected);
  }
  for (const query of [addCommentQuery.replace('AddComment(', 'Other('), addCommentQuery.replace('id\n        body', 'id'),
    addCommentQuery.slice(0, -1), `${addCommentQuery} ${addCommentQuery}`]) {
    assert.deepEqual(await call('/api/graphql', 'POST', { query, variables: { input } }), rejected);
  }
  assert.deepEqual((await call(`${base}/issues/${issue.number}`)).data, issue);
  assert.deepEqual((await call(`${base}/issues/${issue.number}/comments`)).data, []);
  assert.deepEqual((await call('/api/v3/repos/foreign/comments/issues/1/comments')).data, []);
  const next = (await call(`${base}/issues`, 'POST', { title: 'No IDs consumed' })).data;
  assert.equal(next.id, foreign.id + 1);
});

test('GraphQL AddComment and REST readback authenticate first', async t => {
  const { call, base, issue, subjectId } = await addCommentSetup(t);
  const operation = { query: addCommentQuery, variables: { input: { subjectId, body: 'Authorized only' } } };
  const unauthorized = { status: 401, data: { message: 'Bad credentials' } };
  for (const auth of [null, '', 'Bearer wrong', 'token test-token', 'Bearer test-token extra']) {
    for (const body of [operation, '{', null, { query: addCommentQuery, variables: null }]) {
      assert.deepEqual(await call('/api/graphql', 'POST', body, auth), unauthorized);
    }
    assert.deepEqual(await call(`${base}/issues/${issue.number}/comments`, 'GET', undefined, auth), unauthorized);
  }
  const noToken = await fixture(t, '');
  for (const body of [operation, '{']) assert.deepEqual(await noToken('/api/graphql', 'POST', body), unauthorized);
  assert.deepEqual((await call(`${base}/issues/${issue.number}`)).data, issue);
  assert.deepEqual((await call(`${base}/issues/${issue.number}/comments`)).data, []);
});

async function branchesSetup(t: any) {
  const call = await fixture(t);
  const repo = (await call('/api/v3/user/repos', 'POST', { name: 'branches', private: true })).data;
  const base = '/api/v3/repos/alice/branches';
  assert.deepEqual(await call(`${base}/branches`), { status: 200, data: [] });
  const initial = await call(`${base}/contents/seed.txt`, 'PUT', {
    message: 'Initial commit', content: Buffer.from('seed').toString('base64'),
  });
  assert.equal(initial.status, 201);
  return { call, base, repo, sha: initial.data.commit.sha, blob: initial.data.content.sha };
}

test('repos.branches creates a branch at the initial commit and lists it with the default branch', async t => {
  const { call, base, repo, sha } = await branchesSetup(t);
  const main = { name: repo.default_branch, commit: { sha } };
  assert.deepEqual(await call(`${base}/branches`), { status: 200, data: [main] });
  const ref = 'refs/heads/feature/nested-branches';
  assert.deepEqual(await call(`${base}/git/refs`, 'POST', { ref, sha }), {
    status: 201, data: { ref, object: { sha } },
  });
  const expected = [{ name: 'feature/nested-branches', commit: { sha } }, main];
  assert.deepEqual(await call(`${base}/branches`), { status: 200, data: expected });
  assert.deepEqual((await call(`${base}/branches`)).data, expected);
  // Existing contents writes advance only the default branch.
  const next = await call(`${base}/contents/next.txt`, 'PUT', { message: 'Next', content: 'bmV4dA==' });
  assert.equal(next.status, 201);
  assert.deepEqual((await call(`${base}/branches`)).data, [expected[0], { name: repo.default_branch, commit: { sha: next.data.commit.sha } }]);
});

test('repos.branches rejects malformed refs, non-commit SHAs and duplicate or conflicting names without mutation', async t => {
  const { call, base, repo, sha, blob } = await branchesSetup(t);
  const ref = 'refs/heads/topic';
  const rejected = async (body: unknown, status = 422) => {
    assert.equal((await call(`${base}/git/refs`, 'POST', body)).status, status);
  };
  for (const value of [undefined, null, 1, {}, [], '', 'topic', 'refs/tags/topic', 'refs/heads/',
    ...['a/', '/a', 'a//b', '.a', 'a/.b', 'a..b', 'a.lock', 'a.lock/b', 'a.', 'a b', 'a\tb', 'a\nb', 'a\x7fb', 'a~b', 'a^b', 'a:b', 'a?b', 'a*b', 'a[b', 'a\\b', 'a@{b'].map(n => `refs/heads/${n}`)]) {
    await rejected({ ref: value, sha });
  }
  const tree = createHash('sha1').update(Buffer.concat([
    Buffer.from('tree 35\0'), Buffer.from('100644 seed.txt\0'), Buffer.from(blob, 'hex'),
  ])).digest('hex');
  for (const value of [undefined, null, 1, {}, [], '', 'main', sha.slice(0, 39), 'g'.repeat(40), '0'.repeat(40), blob, tree]) {
    await rejected({ ref, sha: value });
  }
  for (const body of [null, [], {}]) await rejected(body);
  await rejected('{', 400);
  await rejected({ ref: `refs/heads/${repo.default_branch}`, sha });
  assert.deepEqual((await call(`${base}/branches`)).data, [{ name: repo.default_branch, commit: { sha } }]);
  assert.equal((await call(`${base}/git/refs`, 'POST', { ref, sha })).status, 201);
  for (const name of ['topic', 'topic/child']) await rejected({ ref: `refs/heads/${name}`, sha });
  assert.equal((await call(`${base}/git/refs`, 'POST', { ref: 'refs/heads/nested/child', sha })).status, 201);
  await rejected({ ref: 'refs/heads/nested', sha });
  assert.equal((await call(`${base}/branches`)).data.length, 3);
  await call('/api/v3/user/repos', 'POST', { name: 'empty' });
  assert.equal((await call('/api/v3/repos/alice/empty/git/refs', 'POST', { ref, sha })).status, 422);
  assert.deepEqual((await call('/api/v3/repos/alice/empty/branches')).data, []);
});

test('repos.branches preserves missing-repository, authentication and unsupported-route behavior', async t => {
  const { call, base, sha } = await branchesSetup(t);
  const body = { ref: 'refs/heads/topic', sha };
  for (const target of ['/api/v3/repos/alice/absent', '/api/v3/repos/bob/branches']) {
    assert.deepEqual(await call(`${target}/branches`), { status: 404, data: { message: 'Not Found' } });
    for (const payload of [body, '{']) assert.deepEqual(await call(`${target}/git/refs`, 'POST', payload), { status: 404, data: { message: 'Not Found' } });
  }
  for (const auth of [null, '', 'Bearer wrong', 'token test-token']) {
    for (const target of [base, '/api/v3/repos/alice/absent']) {
      assert.equal((await call(`${target}/branches`, 'GET', undefined, auth)).status, 401);
      for (const payload of [body, '{', null]) assert.equal((await call(`${target}/git/refs`, 'POST', payload, auth)).status, 401);
    }
  }
  const noToken = await fixture(t, '');
  assert.equal((await noToken(`${base}/branches`)).status, 401);
  assert.equal((await noToken(`${base}/git/refs`, 'POST', body)).status, 401);
  for (const [path, method] of [['git/refs', 'GET'], ['git/refs/heads/topic', 'POST'], ['git/commits', 'POST'], ['branches', 'POST'], ['branches/topic', 'GET'], ['commits', 'POST'], ['commits/topic', 'GET'], ['pulls', 'POST']]) {
    assert.equal((await call(`${base}/${path}`, method, method === 'POST' ? body : undefined)).status, 404);
  }
  assert.deepEqual((await call(`${base}/branches`)).data, [{ name: 'main', commit: { sha } }]);
});

test('repos.commits lists branch history with exact messages and preserves the default snapshot', async t => {
  const { call, base, sha, blob } = await branchesSetup(t);
  const branch = 'feature/nested-commits';
  assert.equal((await call(`${base}/git/refs`, 'POST', { ref: `refs/heads/${branch}`, sha })).status, 201);
  const seed = await call(`${base}/contents/seed.txt`);
  const message = '  Exact café message\nsecond line (commits)  ';
  const write = await call(`${base}/contents/branch.txt`, 'PUT', { branch, message, content: 'YnJhbmNo' });
  assert.equal(write.status, 201);
  const s1 = write.data.commit.sha;
  assert.match(s1, /^[0-9a-f]{40}$/);
  assert.notEqual(s1, sha);
  const initial = { sha, commit: { message: 'Initial commit' } };
  const first = { sha: s1, commit: { message } };
  const historyURL = `${base}/commits?sha=${encodeURIComponent(branch)}`;
  assert.deepEqual(await call(historyURL), { status: 200, data: [first, initial] });
  assert.deepEqual(await call(`${base}/commits`), { status: 200, data: [initial] });
  assert.deepEqual(await call(`${base}/commits?sha=main`), await call(`${base}/commits`));
  assert.deepEqual((await call(`${base}/branches`)).data, [
    { name: branch, commit: { sha: s1 } }, { name: 'main', commit: { sha } },
  ]);
  assert.deepEqual(await call(`${base}/contents/seed.txt`), seed);
  assert.equal((await call(`${base}/contents/branch.txt`)).status, 404);
  // A default write after the fork must not become a parent of a branch write.
  const main = await call(`${base}/contents/default.txt`, 'PUT', { message: 'Default only', content: 'ZGVmYXVsdA==' });
  assert.equal(main.status, 201);
  const second = await call(`${base}/contents/seed.txt`, 'PUT', { branch, message: 'Branch update', content: 'dXBkYXRl', sha: blob });
  assert.equal(second.status, 201);
  assert.deepEqual((await call(historyURL)).data, [
    { sha: second.data.commit.sha, commit: { message: 'Branch update' } }, first, initial,
  ]);
  assert.deepEqual((await call(`${base}/commits`)).data, [
    { sha: main.data.commit.sha, commit: { message: 'Default only' } }, initial,
  ]);
  assert.deepEqual(await call(`${base}/contents/seed.txt`), seed);
  assert.deepEqual((await call(`${base}/branches`)).data, [
    { name: branch, commit: { sha: second.data.commit.sha } }, { name: 'main', commit: { sha: main.data.commit.sha } },
  ]);
  // A ref can reuse an older snapshot even after both branches advance.
  assert.equal((await call(`${base}/git/refs`, 'POST', { ref: 'refs/heads/old', sha: s1 })).status, 201);
  assert.deepEqual((await call(`${base}/commits?sha=old`)).data, [first, initial]);
  assert.equal((await call(`${base}/contents/branch.txt`, 'PUT', { branch: 'old', message: 'Needs SHA', content: 'eA==' })).status, 409);
  // Default DELETE and explicit default PUT also remain part of default history.
  const deleted = await call(`${base}/contents/seed.txt`, 'DELETE', { message: 'Delete default', sha: blob });
  assert.equal(deleted.status, 200);
  const restored = await call(`${base}/contents/seed.txt`, 'PUT', { branch: 'main', message: 'Restore default', content: 'c2VlZA==' });
  assert.equal(restored.status, 201);
  assert.deepEqual((await call(`${base}/commits`)).data.slice(0, 2), [
    { sha: restored.data.commit.sha, commit: { message: 'Restore default' } },
    { sha: deleted.data.commit.sha, commit: { message: 'Delete default' } },
  ]);
  assert.deepEqual((await call(`${base}/commits?sha=old`)).data, [first, initial]);
});

test('repos.commits rejects invalid branches before mutation and preserves authentication and 404 behavior', async t => {
  const { call, base, sha } = await branchesSetup(t);
  const branches = await call(`${base}/branches`);
  const history = await call(`${base}/commits`);
  const seed = await call(`${base}/contents/seed.txt`);
  const body = { message: 'Rejected', content: 'eA==', branch: 'missing' };
  for (const branch of [null, 1, true, {}, [], '', 'missing', 'MAIN', sha]) {
    assert.equal((await call(`${base}/contents/rejected.txt`, 'PUT', { ...body, branch })).status, 422);
    assert.equal((await call(`${base}/contents/seed.txt`, 'PUT', { ...body, branch, sha: seed.data.sha })).status, 422);
  }
  for (const branch of ['', 'missing', 'MAIN', sha]) {
    assert.deepEqual(await call(`${base}/commits?sha=${branch}`), { status: 404, data: { message: 'Not Found' } });
  }
  for (const target of [base, '/api/v3/repos/alice/absent', '/api/v3/repos/bob/branches']) {
    for (const auth of [null, '', 'Bearer wrong', 'token test-token', 'Bearer test-token extra']) {
      assert.deepEqual(await call(`${target}/commits?sha=missing`, 'GET', undefined, auth), { status: 401, data: { message: 'Bad credentials' } });
      for (const payload of [body, '{', null]) {
        assert.equal((await call(`${target}/contents/rejected.txt`, 'PUT', payload, auth)).status, 401);
      }
    }
    if (target !== base) {
      assert.deepEqual(await call(`${target}/commits`), { status: 404, data: { message: 'Not Found' } });
      assert.equal((await call(`${target}/contents/rejected.txt`, 'PUT', body)).status, 404);
    }
  }
  const noToken = await fixture(t, '');
  assert.equal((await noToken(`${base}/commits`)).status, 401);
  assert.deepEqual(await call(`${base}/branches`), branches);
  assert.deepEqual(await call(`${base}/commits`), history);
  assert.deepEqual(await call(`${base}/contents/seed.txt`), seed);
  assert.equal((await call(`${base}/contents/rejected.txt`)).status, 404);
  assert.equal((await call(`${base}/contents/seed.txt?ref=main`)).status, 404);
  assert.equal((await call(`${base}/contents/seed.txt`, 'DELETE', { message: 'Unsupported', sha: seed.data.sha, branch: 'main' })).status, 422);
});
