import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Duplex } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { createApp } from './app.ts';
import { directChild, initialSnapshot, pkt, ZERO_OID, MAX_PUSH_BYTES } from './git-initial.ts';

const hash = (b: Buffer) => createHash('sha1').update(b).digest('hex');
const object = (type: string, payload: Buffer) => ({ type, payload, oid: hash(Buffer.concat([Buffer.from(`${type} ${payload.length}\0`), payload])) });
function seed(depth = 1, mode = '100644', name = 'café.txt', extraHeaders = '') {
  const blob = object('blob', Buffer.from('fixture café 🌍\n'));
  const objects = [blob];
  let child = blob.oid;
  for (let i = 0; i < depth; i++) {
    const tree = object('tree', Buffer.concat([Buffer.from(`${i ? '40000' : mode} ${i ? 'docs' : name}\0`), Buffer.from(child, 'hex')]));
    objects.push(tree);
    child = tree.oid;
  }
  const commit = object('commit', Buffer.from(`tree ${child}\n${extraHeaders}author Fixture <fixture@example.invalid> 1700000000 +0000\ncommitter Fixture <fixture@example.invalid> 1700000000 +0000\n\nOriginal message\n`));
  objects.push(commit);
  return { objects, commit, blob, tree: child, path: 'docs/'.repeat(depth - 1) + name };
}
function pack(objects: ReturnType<typeof object>[], version = 2, typeOverride?: number) {
  const header = Buffer.alloc(12);
  header.write('PACK'); header.writeUInt32BE(version, 4); header.writeUInt32BE(objects.length, 8);
  const raw = Buffer.concat([header, ...objects.map(o => {
    let size = o.payload.length;
    const bytes = [(typeOverride ?? ({ commit: 1, tree: 2, blob: 3 } as any)[o.type]) * 16 + (size & 15)];
    size = Math.floor(size / 16);
    while (size) { bytes[bytes.length - 1] |= 128; bytes.push(size & 127); size = Math.floor(size / 128); }
    return Buffer.concat([Buffer.from(bytes), deflateSync(o.payload)]);
  })]);
  return Buffer.concat([raw, Buffer.from(hash(raw), 'hex')]);
}
function push(s = seed(), old = ZERO_OID, ref = 'refs/heads/main', packed = pack(s.objects), second = '') {
  return Buffer.concat([Buffer.from(pkt(`${old} ${s.commit.oid} ${ref}\0report-status\n`) + second + '0000'), packed]);
}
function client(token = 'test-token', owner = 'alice') {
  const server = createApp({ token, owner });
  return async (path: string, method = 'GET', body?: Buffer | object, auth: string | null = 'Bearer test-token', contentType?: string) => {
    const output: Buffer[] = [];
    const socket = new Duplex({ read() {}, write(chunk, _encoding, callback) { output.push(Buffer.from(chunk)); callback(); } });
    const req = new IncomingMessage(socket as any);
    req.url = path; req.method = method;
    req.headers = { 'content-type': contentType ?? (Buffer.isBuffer(body) ? 'application/x-git-receive-pack-request' : 'application/json') };
    if (auth !== null) req.headers.authorization = auth;
    if (body !== undefined) req.push(Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body)));
    req.push(null); req.complete = true;
    const res = new ServerResponse(req); res.assignSocket(socket as any);
    await new Promise<void>((resolve, reject) => { res.on('finish', resolve); res.on('error', reject); server.emit('request', req, res); });
    const bytes = Buffer.concat(output);
    const raw = bytes.toString();
    const split = raw.indexOf('\r\n\r\n');
    assert.ok(split > 0);
    const type = /^content-type: ([^\r\n]+)/im.exec(raw.slice(0, split))?.[1];
    const text = raw.slice(split + 4);
    socket.destroy();
    return { status: res.statusCode, bytes: bytes.subarray(bytes.indexOf('\r\n\r\n') + 4), text, data: type?.startsWith('application/json') ? JSON.parse(text) : null, type };
  };
}
const base = '/api/v3/repos/alice/seed';
const endpoint = '/alice/seed.git/git-receive-pack';

test('initial push preserves original Git objects and default-branch REST views at all fixture depths', async () => {
  for (const depth of [1, 2, 3]) {
    const call = client(); const s = seed(depth);
    const created = await call('/api/v3/user/repos', 'POST', { name: 'seed' });
    for (const service of ['git-upload-pack', 'git-receive-pack', 'git-receive-pack']) {
      const result = await call(`/alice/seed.git/info/refs?service=${service}`);
      assert.equal(result.status, 200); assert.equal(result.type, `application/x-${service}-advertisement`);
      assert.match(result.text, /capabilities\^\{\}/);
      assert.doesNotMatch(result.text, /ofs-delta|delete-refs|version 2/);
      if (service === 'git-receive-pack') assert.doesNotMatch(result.text, /side-band/);
    }
    const snapshot = initialSnapshot(pack(s.objects), s.commit.oid, 'main');
    for (const o of s.objects) assert.deepEqual(snapshot.objects.get(o.oid), Buffer.concat([Buffer.from(`${o.type} ${o.payload.length}\0`), o.payload]));
    assert.equal(snapshot.tree, s.tree);
    const result = await call(endpoint, 'POST', push(s));
    assert.equal(result.status, 200);
    assert.equal(result.text, pkt('unpack ok\n') + pkt('ok refs/heads/main\n') + '0000');
    assert.deepEqual((await call(base)).data, created.data);
    assert.deepEqual((await call(base + '/branches')).data, [{ name: 'main', commit: { sha: s.commit.oid } }]);
    assert.deepEqual((await call(base + '/commits')).data, [{ sha: s.commit.oid, commit: { message: 'Original message' } }]);
    const file = (await call(base + '/contents/' + encodeURI(s.path))).data;
    assert.equal(file.sha, s.blob.oid); assert.equal(file.content, s.blob.payload.toString('base64'));
    // A later REST update builds on the received commit, proving shared history storage.
    const update = await call(base + '/contents/' + encodeURI(s.path), 'PUT', { message: 'REST continuation', sha: s.blob.oid, content: Buffer.from('new').toString('base64') });
    assert.equal(update.status, 201);
    assert.deepEqual((await call(base + '/commits')).data.map((c: any) => c.sha), [update.data.commit.sha, s.commit.oid]);
    assert.match((await call(endpoint, 'POST', push(s))).text, /ng refs\/heads\/main/);
    const discovery = await call('/alice/seed.git/info/refs?service=git-upload-pack');
    assert.equal(discovery.status, 200);
    assert.ok(discovery.text.includes(`${update.data.commit.sha} HEAD\0side-band-64k no-progress symref=HEAD:refs/heads/main\n`));
    assert.ok(discovery.text.includes(`${update.data.commit.sha} refs/heads/main\n`));
  }
});

test('malformed and unsupported initial pushes never mutate repository state', async () => {
  const s = seed(); const goodPack = pack(s.objects);
  const corrupt = Buffer.from(goodPack); corrupt[corrupt.length - 1] ^= 1;
  const repack = (bytes: Buffer) => Buffer.concat([bytes, Buffer.from(hash(bytes), 'hex')]);
  const wrongSize = Buffer.from(goodPack.subarray(0, -20)); wrongSize[12] ^= 1;
  const badZlib = Buffer.from(goodPack.subarray(0, -20)); badZlib[14] ^= 255;
  const highBitHeader = Buffer.from(goodPack.subarray(0, -20)); highBitHeader[0] |= 128;
  const wrongHead = { ...s, commit: { ...s.commit, oid: s.blob.oid } };
  const orphan = object('tree', Buffer.from(''));
  const invalid: [string, Buffer][] = [
    ['update', push(s, '1'.repeat(40))], ['tag', push(s, ZERO_OID, 'refs/tags/v1')],
    ['other branch', push(s, ZERO_OID, 'refs/heads/topic')],
    ['delete', Buffer.from(pkt(`${ZERO_OID} ${ZERO_OID} refs/heads/main\0report-status\n`) + '0000')],
    ['multiple refs', push(s, ZERO_OID, 'refs/heads/main', goodPack, pkt(`${ZERO_OID} ${s.commit.oid} refs/heads/topic\n`))],
    ['parent', push(seed(1, '100644', 'file', `parent ${s.commit.oid}\n`))],
    ['version', push(s, ZERO_OID, 'refs/heads/main', pack(s.objects, 3))],
    ...[0, 4, 5, 6, 7].map(type => [`type ${type}`, push(s, ZERO_OID, 'refs/heads/main', pack(s.objects, 2, type))] as [string, Buffer]),
    ...['100755', '120000', '160000', '040000'].map(mode => [mode, push(seed(1, mode))] as [string, Buffer]),
    ...['..', '.git', 'a/b', 'a\\b'].map(name => [name, push(seed(1, '100644', name))] as [string, Buffer]),
    ['too deep', push(seed(4))], ['checksum', push(s, ZERO_OID, 'refs/heads/main', corrupt)],
    ['wrong object size', push(s, ZERO_OID, 'refs/heads/main', repack(wrongSize))],
    ['bad zlib', push(s, ZERO_OID, 'refs/heads/main', repack(badZlib))],
    ['non-ASCII pack header', push(s, ZERO_OID, 'refs/heads/main', repack(highBitHeader))],
    ['non-commit target', push(wrongHead)],
    ['truncated', push(s).subarray(0, -1)], ['trailing', Buffer.concat([push(s), Buffer.from('x')])],
    ['orphan', push(s, ZERO_OID, 'refs/heads/main', pack([...s.objects, orphan]))],
    ['duplicate object', push(s, ZERO_OID, 'refs/heads/main', pack([...s.objects, s.blob]))],
    ['missing blob', push(s, ZERO_OID, 'refs/heads/main', pack(s.objects.filter(o => o !== s.blob)))],
    ['bad pkt', Buffer.from('zzzz')], ['short pkt', Buffer.from('0003')], ['no commands', Buffer.from('0000')],
    ['unknown capability', Buffer.from(pkt(`${ZERO_OID} ${s.commit.oid} refs/heads/main\0side-band-64k\n`) + '0000')],
    ['oversized', Buffer.alloc(MAX_PUSH_BYTES + 1)],
  ];
  for (const [name, body] of invalid) {
    const call = client();
    const before = (await call('/api/v3/user/repos', 'POST', { name: 'seed' })).data;
    const response = await call(endpoint, 'POST', body);
    assert.ok(response.status >= 400 || /ng refs\//.test(response.text), name);
    assert.doesNotMatch(response.text, /unpack ok|\bok refs\/heads/, name);
    assert.deepEqual((await call(base)).data, before, name);
    assert.deepEqual((await call(base + '/branches')).data, [], name);
    assert.equal((await call(base + '/commits')).status, 404, name);
    assert.equal((await call(base + '/contents/caf%C3%A9.txt')).status, 404, name);
    assert.match((await call(endpoint, 'POST', push(s))).text, /unpack ok/, name);
    // No ids consumed by Git parsing or rejected requests.
    assert.equal((await call(base + '/issues', 'POST', { title: name })).data.id, before.id + 1);
  }
});

test('initial Git routes retain bearer auth, missing repository isolation and unsupported route behavior', async () => {
  const call = client();
  await call('/api/v3/user/repos', 'POST', { name: 'seed', private: true });
  for (const auth of [null, '', 'Bearer wrong', 'token test-token', 'Basic dGVzdA==']) {
    assert.equal((await call(endpoint, 'POST', push(), auth)).status, 401);
    assert.equal((await call('/alice/seed.git/info/refs?service=git-receive-pack', 'GET', undefined, auth)).status, 401);
    assert.equal((await call(base, 'GET', undefined, auth)).status, 401);
    assert.equal((await call('/api/graphql', 'POST', { query: '{ viewer { login } }' }, auth)).status, 401);
  }
  assert.equal((await client('')(endpoint, 'POST', push())).status, 401);
  for (const remote of ['/bob/seed.git', '/alice/missing.git']) {
    assert.equal((await call(remote + '/git-receive-pack', 'POST', push())).status, 404);
    for (const service of ['git-upload-pack', 'git-receive-pack']) assert.equal((await call(remote + '/info/refs?service=' + service)).status, 404);
  }
  assert.equal((await call(endpoint, 'POST', push(), 'Bearer test-token', 'application/json')).status, 400);
  assert.equal((await call(endpoint + '?x=1', 'POST', push())).status, 400);
  assert.equal((await call('/alice/seed.git/info/refs?service=other')).status, 400);
  assert.equal((await call('/alice/seed.git/git-upload-pack', 'POST', Buffer.from('0000'))).status, 400);
  assert.equal((await call('/healthz')).status, 200);
  assert.equal((await call('/api/v3/user')).data.login, 'alice');
  assert.equal((await call('/api/v3/user/repos')).data.length, 1);
  assert.match((await call(endpoint, 'POST', push())).text, /unpack ok/);
});

test('official GitClient initial push, empty-pack branch creation and v0 clone over real HTTP', { skip: !process.env.OFFICIAL_KIT }, async t => {
  const source = pathToFileURL(process.env.OFFICIAL_KIT! + '/program/env/src/').href;
  const { GitClient, buildTree, buildCommit, hashObject, writePack } = await import(source + 'git-client.ts');
  const { buildScenario } = await import(source + 'wire.ts');
  const scenario = buildScenario();
  const server = createApp({ token: 'test-token', owner: scenario.viewer.login });
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const git = new GitClient({ baseUrl, token: 'test-token', timeoutMs: 8000 });
  const owner = scenario.viewer.login;
  const repo = 'gitconf-push-first-commit';
  await git.createRepo(owner, repo);
  const objects: { type: 'blob' | 'tree' | 'commit'; data: Buffer }[] = [];
  const put = (type: 'blob' | 'tree' | 'commit', data: Buffer): string => {
    objects.push({ type, data });
    return hashObject(type, data);
  };
  const file = scenario.blobs[0];
  let tree = put('blob', Buffer.from(file.content, 'utf8'));
  const segments = file.path.split('/').reverse();
  for (const [index, name] of segments.entries()) {
    tree = put('tree', buildTree([{ mode: index === 0 ? '100644' : '40000', name, oid: tree }]));
  }
  const meta = scenario.commits[0];
  const author = `${scenario.viewer.name} <${scenario.viewer.email}>`;
  const tip = put('commit', buildCommit({ tree, parents: [], author, committer: author,
    timestamp: meta.epochSec, message: meta.message.endsWith('\n') ? meta.message : `${meta.message}\n` }));
  const command = { oldOid: ZERO_OID, newOid: tip, ref: 'refs/heads/main' };
  const pushed = await git.push(owner, repo, [command], { objects });
  assert.equal(pushed.report?.unpackOk, true);
  assert.equal(pushed.report.refs.find((ref: any) => ref.ref === command.ref)?.ok, true);

  for (const service of ['git-upload-pack', 'git-receive-pack']) {
    const response = await fetch(`${baseUrl}/${owner}/${repo}.git/info/refs?service=${service}`, {
      headers: { authorization: 'Bearer test-token' },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), `application/x-${service}-advertisement`);
    const caps = service === 'git-receive-pack' ? 'report-status ' : 'side-band-64k no-progress ';
    assert.equal(await response.text(), pkt(`# service=${service}\n`) + '0000' +
      pkt(`${tip} HEAD\0${caps}symref=HEAD:refs/heads/main\n`) + pkt(`${tip} refs/heads/main\n`) + '0000');
  }
  const after = await git.lsRefs(owner, repo);
  assert.equal(after.protocol, 0);
  assert.equal(after.refs.find((ref: any) => ref.name === 'refs/heads/main')?.oid, tip);
  assert.equal(after.refs.find((ref: any) => ref.name === 'HEAD')?.oid, tip);
  assert.equal(after.refs.find((ref: any) => ref.name === 'HEAD')?.symrefTarget, 'refs/heads/main');

  // Nonempty secondary packs must not enable subsequent receive-pack mutations.
  for (const commands of [
    [{ ...command, oldOid: tip }], [{ ...command, oldOid: tip, newOid: ZERO_OID }],
    [{ ...command, ref: 'refs/tags/v1' }], [{ ...command, ref: 'refs/heads/topic' }],
    [command, { ...command, ref: 'refs/heads/topic' }],
  ]) {
    const refused = await git.push(owner, repo, commands, { objects });
    assert.equal(refused.report?.unpackOk, false);
    assert.ok(refused.report.refs.every((ref: any) => !ref.ok));
    assert.deepEqual((await git.lsRefs(owner, repo)).refs, after.refs);
  }
  const feature = { ...command, ref: 'refs/heads/feature' };
  const created = await git.push(owner, repo, [feature], { objects: [] });
  assert.equal(created.report?.unpackOk, true);
  assert.equal(created.report.refs.find((ref: any) => ref.ref === feature.ref)?.ok, true);
  const listed = await git.lsRefs(owner, repo);
  assert.equal(listed.refs.find((ref: any) => ref.name === feature.ref)?.oid, tip);
  const cloned = await git.clone(owner, repo);
  assert.equal(cloned.protocol, 0);
  assert.equal(cloned.checksumOk, true);
  assert.equal(cloned.deltaCount, 0);
  assert.equal(cloned.refs.find((ref: any) => ref.name === feature.ref)?.oid, tip);
  assert.equal(cloned.objects.size, objects.length);
  for (const original of objects) {
    const actual = cloned.objects.get(hashObject(original.type, original.data));
    assert.equal(actual?.type, original.type);
    assert.deepEqual(actual?.data, original.data);
  }

  // Exercise the complete official fixture itself, including its reachability-based
  // empty-pack selection, with the unmodified client and a real local HTTP server.
  // Delete-only GitClient requests carry no pack; recreate uses the original root objects.
  const removal = { oldOid: tip, newOid: ZERO_OID, ref: feature.ref };
  const deleted = await git.push(owner, repo, [removal]);
  assert.equal(deleted.report?.unpackOk, true);
  assert.equal(deleted.report.refs.find((ref: any) => ref.ref === feature.ref)?.ok, true);
  assert.deepEqual((await git.lsRefs(owner, repo)).refs, after.refs);
  const afterDelete = await git.clone(owner, repo);
  assert.equal(afterDelete.checksumOk, true);
  assert.deepEqual(afterDelete.objects, cloned.objects);
  assert.equal((await git.push(owner, repo, [feature], { objects: [] })).report?.unpackOk, true);
  assert.deepEqual((await git.lsRefs(owner, repo)).refs, listed.refs);

  const { GIT_CHECKS } = await import(source + 'checks-git.ts');
  const context = { baseUrl, token: 'test-token', scenario, signal: AbortSignal.timeout(10000),
    deadlineMs: performance.now() + 10000, timeoutMs: 10000, log() {} };
  const result = await GIT_CHECKS.find((check: any) => check.id === 'git.push-create-branch').fn(context);
  assert.equal(result.ok, true, JSON.stringify(result));
  t.diagnostic(JSON.stringify(result));
  const updated = await GIT_CHECKS.find((check: any) => check.id === 'git.push-update-ref').fn(context);
  assert.equal(updated.ok, true, JSON.stringify(updated));
  const updatedClone = await git.clone(owner, 'gitconf-push-update-ref');
  const childObjects: { type: 'blob' | 'tree' | 'commit'; data: Buffer }[] = [];
  const childPut = (type: 'blob' | 'tree' | 'commit', data: Buffer) => {
    childObjects.push({ type, data }); return hashObject(type, data);
  };
  const childFile = scenario.blobs[1];
  let childTree = childPut('blob', Buffer.from(childFile.content));
  for (const [index, name] of childFile.path.split('/').reverse().entries()) {
    childTree = childPut('tree', buildTree([{ mode: index === 0 ? '100644' : '40000', name, oid: childTree }]));
  }
  const childMeta = scenario.commits[1];
  const childTip = childPut('commit', buildCommit({ tree: childTree, parents: [tip], author, committer: author,
    timestamp: childMeta.epochSec + 1, message: `${childMeta.message}\n\nrevision 1\n` }));
  const expected = new Map([...objects, ...childObjects].map(o => [hashObject(o.type, o.data), o]));
  assert.equal(updatedClone.checksumOk, true);
  assert.equal(updatedClone.deltaCount, 0);
  assert.equal(updatedClone.objects.size, expected.size);
  assert.equal(updatedClone.refs.find((ref: any) => ref.name === 'refs/heads/main')?.oid, childTip);
  for (const [oid, original] of expected) {
    assert.equal(updatedClone.objects.get(oid)?.type, original.type);
    assert.deepEqual(updatedClone.objects.get(oid)?.data, original.data);
  }
  for (const id of ['git.push-delete-branch']) {
    const deleted = await GIT_CHECKS.find((check: any) => check.id === id).fn(context);
    assert.equal(deleted.ok, true, JSON.stringify(deleted));
  }

  const emptyPack = writePack([]);
  const badChecksum = Buffer.from(emptyPack); badChecksum[31] ^= 1;
  const badCountHeader = Buffer.from(emptyPack.subarray(0, 12)); badCountHeader.writeUInt32BE(1, 8);
  const badCount = Buffer.concat([badCountHeader, Buffer.from(hash(badCountHeader), 'hex')]);
  const badMagic = Buffer.from(emptyPack.subarray(0, 12)); badMagic[0] |= 128;
  for (const invalidPack of [Buffer.alloc(0), pack([], 3), badChecksum, badCount,
    Buffer.concat([badMagic, Buffer.from(hash(badMagic), 'hex')]),
    emptyPack.subarray(0, 31), Buffer.concat([emptyPack, Buffer.from('x')]), writePack(objects)]) {
    const refused = await git.push(owner, repo, [{ ...feature, ref: 'refs/heads/rejected' }], { pack: invalidPack });
    assert.equal(refused.report?.unpackOk, false);
    assert.ok(refused.report.refs.every((ref: any) => !ref.ok));
    assert.deepEqual((await git.lsRefs(owner, repo)).refs, listed.refs);
  }
  for (const commands of [
    [feature], [command], [{ ...feature, oldOid: tip }], [{ ...command, oldOid: tip, newOid: ZERO_OID }],
    [{ ...feature, newOid: '1'.repeat(40), ref: 'refs/heads/unknown' }],
    [{ ...feature, newOid: tree, ref: 'refs/heads/tree' }],
    [{ ...feature, ref: 'refs/tags/v1' }], [feature, { ...feature, ref: 'refs/heads/two' }],
    ...['', '.hidden', 'a..b', 'a.lock', 'a//b', 'a/', 'a.', 'feature/child', 'main/child'].map(name =>
      [{ ...feature, ref: `refs/heads/${name}` }]),
  ]) {
    const refused = await git.push(owner, repo, commands, { objects: [] });
    assert.equal(refused.report?.unpackOk, false);
    assert.ok(refused.report.refs.every((ref: any) => !ref.ok));
    assert.deepEqual((await git.lsRefs(owner, repo)).refs, listed.refs);
  }
  // Generic names and collisions in both directions, not a feature-name special case.
  const nested = { ...feature, ref: 'refs/heads/topic/child' };
  assert.equal((await git.push(owner, repo, [nested], { objects: [] })).report?.unpackOk, true);
  assert.equal((await git.push(owner, repo, [{ ...nested, ref: 'refs/heads/topic' }], { objects: [] })).report?.unpackOk, false);

  const remote = `${baseUrl}/${owner}/${repo}.git`;
  const uploadBody = pkt(`want ${tip} side-band-64k no-progress\n`) + '0000' + pkt('done\n') + '0000';
  const post = (path: string, body: string | Buffer, token = 'test-token', contentType = 'application/x-git-upload-pack-request') =>
    fetch(path, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': contentType }, body });
  const stable = (await git.lsRefs(owner, repo)).refs;
  for (const body of [
    'zzzz', '0000', uploadBody.slice(0, -4), uploadBody + '0000',
    uploadBody.replace(tip, '1'.repeat(40)), uploadBody.replace(tip, tree),
    uploadBody.replace('no-progress', 'thin-pack'),
    pkt(`want ${tip} side-band-64k\n`) + pkt(`want ${tip}\n`) + '0000' + pkt('done\n') + '0000',
    pkt(`want ${tip} side-band-64k\n`) + pkt('deepen 1\n') + '0000' + pkt('done\n') + '0000',
    uploadBody.replace(pkt('done\n'), pkt(`have ${tip}\n`) + pkt('done\n')),
  ]) assert.equal((await post(remote + '/git-upload-pack', body)).status, 400);
  for (const service of ['git-upload-pack', 'git-receive-pack']) {
    const type = `application/x-${service}-request`;
    assert.equal((await post(remote + '/' + service, uploadBody, 'wrong', type)).status, 401);
    assert.equal((await post(`${baseUrl}/${owner}/missing.git/${service}`, uploadBody, 'test-token', type)).status, 404);
    assert.equal((await post(remote + '/' + service, uploadBody, 'test-token', 'application/json')).status, 400);
    assert.equal((await post(remote + '/' + service + '?x=1', uploadBody, 'test-token', type)).status, 400);
  }
  assert.equal((await post(remote + '/git-receive-pack', 'zzzz', 'test-token', 'application/x-git-receive-pack-request')).status, 400);
  assert.deepEqual((await git.lsRefs(owner, repo)).refs, stable);
  assert.deepEqual((await git.clone(owner, repo)).objects, cloned.objects);

  // Binary data crossing a sideband packet boundary must survive unchanged.
  const largeObjects: { type: 'blob' | 'tree' | 'commit'; data: Buffer }[] = [];
  const addLarge = (type: 'blob' | 'tree' | 'commit', data: Buffer) => {
    largeObjects.push({ type, data }); return hashObject(type, data);
  };
  const largeBlob = addLarge('blob', randomBytes(70000));
  const largeTree = addLarge('tree', buildTree([{ mode: '100644', name: 'binary.bin', oid: largeBlob }]));
  const largeTip = addLarge('commit', buildCommit({ tree: largeTree, parents: [], author, committer: author,
    timestamp: meta.epochSec, message: 'Binary root\n' }));
  await git.createRepo(owner, 'large-root');
  assert.equal((await git.push(owner, 'large-root', [{ ...command, newOid: largeTip }], { objects: largeObjects })).report?.unpackOk, true);
  const largeClone = await git.clone(owner, 'large-root');
  assert.ok(largeClone.packBytes > 65515);
  assert.equal(largeClone.checksumOk, true);
  assert.equal(largeClone.objects.size, largeObjects.length);
  for (const original of largeObjects) assert.deepEqual(largeClone.objects.get(hashObject(original.type, original.data))?.data, original.data);
  // Checksum refusal on an empty repository still leaves it eligible for its first push.
  const empty = 'corrupt-initial';
  await git.createRepo(owner, empty);
  const corrupt = writePack(objects);
  corrupt[corrupt.length - 1] ^= 1;
  assert.equal((await git.push(owner, empty, [command], { pack: corrupt })).report?.unpackOk, false);
  assert.deepEqual((await git.lsRefs(owner, empty)).refs, []);
  assert.equal((await git.push(owner, empty, [command], { objects })).report?.unpackOk, true);
});

// Run against the unmodified official kit when its location is provided; never vendor the harness.
test('official graphql.repository-fields check with official initial-push adapter', { skip: !process.env.OFFICIAL_KIT }, async t => {
  const source = pathToFileURL(process.env.OFFICIAL_KIT! + '/program/env/src/').href;
  const { GRAPHQL_CHECKS, configureGraphQLGit } = await import(source + 'checks-graphql.ts');
  const { createGitFixture } = await import(source + 'main.ts');
  const { buildScenario } = await import(source + 'wire.ts');
  const scenario = buildScenario();
  const call = client('test-token', scenario.viewer.login);
  const baseUrl = 'http://official-fixture.test';
  const gitRequests: string[] = [];
  // Exercise the unchanged official check and adapter through real HTTP request/response
  // objects without requiring permission to bind a TCP socket in the test sandbox.
  t.mock.method(globalThis, 'fetch', async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    assert.equal(url.origin, baseUrl);
    const headers = new Headers(init.headers);
    const path = url.pathname + url.search;
    if (url.pathname.includes('.git/')) gitRequests.push(`${init.method ?? 'GET'} ${path}`);
    const response = await call(path, init.method ?? 'GET', init.body === undefined ? undefined : Buffer.from(init.body as any),
      headers.get('authorization'), headers.get('content-type') ?? undefined);
    return new Response(response.text, { status: response.status, headers: { 'content-type': response.type! } });
  });
  t.after(() => configureGraphQLGit(null));
  configureGraphQLGit(createGitFixture({ baseUrl, token: 'test-token' }));
  const result = await GRAPHQL_CHECKS.find((c: any) => c.id === 'graphql.repository-fields').fn({
    baseUrl, token: 'test-token', scenario, signal: AbortSignal.timeout(10000), deadlineMs: performance.now() + 10000, timeoutMs: 10000, log() {},
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(gitRequests.map(request => request.replace(/ \/[^/]+\/[^/]+\.git\//, ' /repo.git/')), [
    'GET /repo.git/info/refs?service=git-upload-pack',
    'GET /repo.git/info/refs?service=git-receive-pack',
    'GET /repo.git/info/refs?service=git-receive-pack',
    'POST /repo.git/git-receive-pack',
  ]);
  t.diagnostic(JSON.stringify(result));
});


test('direct child resolves retained objects and rejects malformed or unrelated incoming objects', () => {
  const root = seed();
  const child = seed(1, '100644', 'new.txt', `parent ${root.commit.oid}\n`);
  const missing = child.objects.filter(o => !root.objects.some(old => old.oid === o.oid));
  const result = directChild(pack(missing), child.commit.oid, 'main', pack(root.objects), root.commit.oid);
  assert.equal(result.parent, root.commit.oid);
  assert.equal(result.files.size, 1);
  assert.equal(result.path, 'new.txt');
  assert.equal(result.objects.size, root.objects.length + missing.length);
  assert.equal(result.pack.readUInt32BE(8), result.objects.size);
  assert.equal(hash(result.pack.subarray(0, -20)), result.pack.subarray(-20).toString('hex'));
  for (const o of [...root.objects, ...missing]) assert.deepEqual(result.objects.get(o.oid),
    Buffer.concat([Buffer.from(`${o.type} ${o.payload.length}\0`), o.payload]));
  // A commit-only pack can reuse the entire validated root tree/blob closure.
  const same = seed(1, '100644', 'café.txt', `parent ${root.commit.oid}\n`);
  assert.equal(directChild(pack([same.commit]), same.commit.oid, 'main', pack(root.objects), root.commit.oid).tree, root.tree);
  const corrupt = pack(missing); corrupt[corrupt.length - 1] ^= 1;
  for (const bad of [corrupt, pack(missing, 3), pack(missing, 2, 6),
    pack([...missing, missing[0]]), pack([...missing, object('blob', Buffer.from('unused'))]),
    pack([child.commit]), Buffer.concat([pack(missing), Buffer.from('x')])]) {
    assert.throws(() => directChild(bad, child.commit.oid, 'main', pack(root.objects), root.commit.oid));
  }
  for (const bad of [seed(4, '100644', 'file', `parent ${root.commit.oid}\n`),
    seed(1, '120000', 'file', `parent ${root.commit.oid}\n`),
    seed(1, '100644', '.git', `parent ${root.commit.oid}\n`)]) {
    assert.throws(() => directChild(pack(bad.objects.filter(o => !root.objects.some(r => r.oid === o.oid))),
      bad.commit.oid, 'main', pack(root.objects), root.commit.oid));
  }
});

test('single root update is atomic and excludes stale, non-FF, merge and branch compositions', async () => {
  const call = client(); const root = seed();
  await call('/api/v3/user/repos', 'POST', { name: 'seed' });
  assert.match((await call(endpoint, 'POST', push(root))).text, /unpack ok/);
  const child = seed(1, '100644', 'new.txt', `parent ${root.commit.oid}\n`);
  const missingPack = (s: ReturnType<typeof seed>) => pack(s.objects.filter(o => !root.objects.some(r => r.oid === o.oid)));
  const before = async () => Promise.all(['/branches', '/commits', '/contents/caf%C3%A9.txt'].map(p => call(base + p)));
  const original = await before();
  const unrelated = seed(1, '100644', 'new.txt');
  const wrongParent = seed(1, '100644', 'new.txt', `parent ${'1'.repeat(40)}\n`);
  const merge = seed(1, '100644', 'new.txt', `parent ${root.commit.oid}\nparent ${root.commit.oid}\n`);
  for (const body of [
    push(child, '1'.repeat(40), 'refs/heads/main', missingPack(child)),
    ...[unrelated, wrongParent, merge].map(s => push(s, root.commit.oid, 'refs/heads/main', missingPack(s))),
    push(child, root.commit.oid, 'refs/heads/topic', missingPack(child)),
    push(child, root.commit.oid, 'refs/heads/main', missingPack(child), pkt(`${ZERO_OID} ${child.commit.oid} refs/heads/topic\n`)),
    push(root, root.commit.oid),
  ]) {
    assert.match((await call(endpoint, 'POST', body)).text, /ng refs/);
    assert.deepEqual(await before(), original);
  }
  assert.match((await call(endpoint, 'POST', push(child, root.commit.oid, 'refs/heads/main', missingPack(child)))).text, /unpack ok/);
  assert.deepEqual((await call(base + '/commits')).data.map((c: any) => c.sha), [child.commit.oid, root.commit.oid]);
  assert.equal((await call(base + '/contents/caf%C3%A9.txt')).status, 404);
  assert.equal((await call(base + '/contents/new.txt')).data.sha, child.blob.oid);
  const clonePath = '/alice/seed.git/git-upload-pack';
  const cloneType = 'application/x-git-upload-pack-request';
  const cloneBody = Buffer.from(pkt(`want ${child.commit.oid} side-band-64k no-progress\n`) + '0000' + pkt('done\n') + '0000');
  assert.equal((await call(clonePath, 'POST', cloneBody, 'Bearer test-token', cloneType)).status, 200);
  const oldWant = Buffer.from(pkt(`want ${root.commit.oid} side-band-64k no-progress\n`) + '0000' + pkt('done\n') + '0000');
  assert.equal((await call(clonePath, 'POST', oldWant, 'Bearer test-token', cloneType)).status, 400);
  const after = await before();
  const grandchild = seed(1, '100644', 'third.txt', `parent ${child.commit.oid}\n`);
  for (const body of [push(child, root.commit.oid, 'refs/heads/main', missingPack(child)),
    push(grandchild, child.commit.oid), push(child, ZERO_OID, 'refs/heads/feature', pack([]))]) {
    assert.match((await call(endpoint, 'POST', body)).text, /ng refs/);
    assert.deepEqual(await before(), after);
  }
  const alias = client();
  await alias('/api/v3/user/repos', 'POST', { name: 'seed' });
  await alias(endpoint, 'POST', push(root));
  assert.match((await alias(endpoint, 'POST', push(root, ZERO_OID, 'refs/heads/feature', pack([])))).text, /unpack ok/);
  const refs = (await alias(base + '/branches')).data;
  assert.match((await alias(endpoint, 'POST', push(child, root.commit.oid, 'refs/heads/main', missingPack(child)))).text, /ng refs/);
  assert.deepEqual((await alias(base + '/branches')).data, refs);
});


test('official pack reader verifies the complete deduplicated direct-child history', { skip: !process.env.OFFICIAL_KIT }, async () => {
  const { readPack, collectReachable } = await import(pathToFileURL(process.env.OFFICIAL_KIT! + '/program/env/src/git-client.ts').href);
  const root = seed(3);
  const child = seed(2, '100644', 'next.txt', `parent ${root.commit.oid}\n`);
  const incoming = child.objects.filter(o => !root.objects.some(r => r.oid === o.oid));
  const result = directChild(pack(incoming), child.commit.oid, 'main', pack(root.objects), root.commit.oid);
  const decoded = readPack(result.pack);
  const expected = new Map([...root.objects, ...incoming].map(o => [o.oid, o]));
  assert.equal(decoded.objects.size, expected.size);
  assert.equal(collectReachable([child.commit.oid], (oid: string) => decoded.objects.get(oid)).size, expected.size);
  for (const [oid, o] of expected) {
    assert.equal(decoded.objects.get(oid)?.type, o.type);
    assert.deepEqual(decoded.objects.get(oid)?.data, o.payload);
  }
});


test('secondary root deletion validates before mutation, frames reports and permits recreation', async () => {
  const call = client(); const root = seed();
  await call('/api/v3/user/repos', 'POST', { name: 'seed' });
  await call(endpoint, 'POST', push(root));
  const create = (name = 'feature') => push(root, ZERO_OID, `refs/heads/${name}`, pack([]));
  const remove = (ref = 'refs/heads/feature', old = root.commit.oid, tail = Buffer.alloc(0), second = '') =>
    Buffer.concat([Buffer.from(pkt(`${old} ${ZERO_OID} ${ref}\0report-status\n`) + second + '0000'), tail]);
  assert.match((await call(endpoint, 'POST', create())).text, /unpack ok/);
  const clone = () => call('/alice/seed.git/git-upload-pack', 'POST',
    Buffer.from(pkt(`want ${root.commit.oid} side-band-64k no-progress\n`) + '0000' + pkt('done\n') + '0000'),
    'Bearer test-token', 'application/x-git-upload-pack-request');
  const state = () => Promise.all([call(base), call(base + '/branches'), call(base + '/commits'),
    call(base + '/contents/caf%C3%A9.txt'), clone()]);
  const before = await state();
  for (const body of [
    remove('refs/heads/main'), remove('refs/heads/missing'), remove('refs/tags/feature'),
    remove(undefined, ZERO_OID), remove(undefined, '1'.repeat(40)), remove(undefined, root.blob.oid),
    ...['', '.hidden', 'a..b', 'a.lock', 'a//b', 'a/', 'a.', 'feature/child', 'a@{b', 'a b'].map(n => remove(`refs/heads/${n}`)),
    ...[Buffer.from('x'), Buffer.from('0000'), pack([]), pack(root.objects)].map(tail => remove(undefined, undefined, tail)),
    remove(undefined, undefined, undefined, pkt(`${root.commit.oid} ${ZERO_OID} refs/heads/main\n`)),
    remove(undefined, undefined, undefined, pkt(`${root.commit.oid} ${ZERO_OID} refs/heads/feature\n`)),
    Buffer.from(remove().toString().replace('report-status', 'delete-refs  ')),
  ]) {
    const response = await call(endpoint, 'POST', body);
    assert.ok(response.status >= 400 || response.text.includes('ng refs/'), response.text);
    assert.doesNotMatch(response.text, /unpack ok/);
    assert.deepEqual(await state(), before);
  }
  for (const [path, auth, type, status] of [
    [endpoint, 'Bearer wrong', 'application/x-git-receive-pack-request', 401],
    ['/bob/seed.git/git-receive-pack', 'Bearer test-token', 'application/x-git-receive-pack-request', 404],
    ['/alice/missing.git/git-receive-pack', 'Bearer test-token', 'application/x-git-receive-pack-request', 404],
    [endpoint, 'Bearer test-token', 'application/json', 400],
    [endpoint + '?x=1', 'Bearer test-token', 'application/x-git-receive-pack-request', 400],
  ] as const) {
    assert.equal((await call(path, 'POST', remove(), auth, type)).status, status);
    assert.deepEqual(await state(), before);
  }
  const raced = await Promise.all([call(endpoint, 'POST', remove()), call(endpoint, 'POST', remove())]);
  const success = raced.filter(r => r.text.includes('unpack ok'));
  assert.equal(success.length, 1);
  assert.equal(success[0].status, 200);
  assert.equal(success[0].type, 'application/x-git-receive-pack-result');
  assert.equal(success[0].text, pkt('unpack ok\n') + pkt('ok refs/heads/feature\n') + '0000');
  assert.equal(raced.filter(r => r.text.includes('ng refs/heads/feature')).length, 1);
  assert.deepEqual((await call(base + '/branches')).data, [{ name: 'main', commit: { sha: root.commit.oid } }]);
  const after = await state();
  for (const i of [0, 2, 3, 4]) assert.deepEqual(after[i], before[i]);
  assert.equal(after[4].status, 200);
  assert.deepEqual(after[4].bytes, before[4].bytes);
  for (const name of ['feature', 'topic/child']) {
    assert.match((await call(endpoint, 'POST', create(name))).text, /unpack ok/);
    assert.match((await call(endpoint, 'POST', remove(`refs/heads/${name}`))).text, /unpack ok/);
    assert.deepEqual(await state(), after);
  }
  assert.match((await call(endpoint, 'POST', create())).text, /unpack ok/);
  assert.deepEqual(await state(), before);
});

test('secondary deletion refuses REST-only roots and repositories with later history', async () => {
  for (const kind of ['rest', 'main-history', 'alias-history', 'git-history']) {
    const call = client(); const root = seed();
    await call('/api/v3/user/repos', 'POST', { name: 'seed' });
    let tip = root.commit.oid;
    if (kind === 'rest') {
      tip = (await call(base + '/contents/file', 'PUT', { message: 'root', content: 'eA==' })).data.commit.sha;
    } else {
      await call(endpoint, 'POST', push(root));
    }
    if (kind === 'git-history') {
      const child = seed(1, '100644', 'next', `parent ${tip}\n`);
      const incoming = child.objects.filter(o => !root.objects.some(r => r.oid === o.oid));
      assert.match((await call(endpoint, 'POST', push(child, tip, 'refs/heads/main', pack(incoming)))).text, /unpack ok/);
      tip = child.commit.oid;
    }
    assert.equal((await call(base + '/git/refs', 'POST', { ref: 'refs/heads/feature', sha: tip })).status, 201);
    if (kind.endsWith('-history') && kind !== 'git-history') {
      const branch = kind === 'main-history' ? 'main' : 'feature';
      const update = await call(base + '/contents/caf%C3%A9.txt', 'PUT', {
        branch, message: 'later', sha: root.blob.oid, content: 'eA==',
      });
      assert.equal(update.status, 201);
      if (branch === 'feature') tip = update.data.commit.sha;
    }
    const state = () => Promise.all(['/branches', '/commits', '/contents/caf%C3%A9.txt', '/commits?sha=feature'].map(p => call(base + p)));
    const before = await state();
    const body = Buffer.from(pkt(`${tip} ${ZERO_OID} refs/heads/feature\0report-status\n`) + '0000');
    assert.match((await call(endpoint, 'POST', body)).text, /ng refs\/heads\/feature/);
    assert.deepEqual(await state(), before);
  }
});
