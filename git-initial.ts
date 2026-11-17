import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

// Single-file root snapshots, root branch aliases, or one direct-child update; bounded v0 clone.
export const ZERO_OID = '0'.repeat(40);
export const MAX_PUSH_BYTES = 1_048_576;
export const pkt = (text: string) => (Buffer.byteLength(text) + 4).toString(16).padStart(4, '0') + text;
const reject = (): never => { throw new Error('unsupported or malformed initial push'); };
const sha1 = (bytes: Buffer) => createHash('sha1').update(bytes).digest('hex');
export function emptyPack(pack: Buffer): boolean {
  return pack.length === 32 && pack.subarray(0, 4).equals(Buffer.from('PACK')) &&
    pack.readUInt32BE(4) === 2 && pack.readUInt32BE(8) === 0 &&
    sha1(pack.subarray(0, 12)) === pack.subarray(12).toString('hex');
}

export function newBranch(ref: string, existing: Iterable<string>): string {
  if (!ref.startsWith('refs/heads/')) reject();
  const name = ref.slice('refs/heads/'.length);
  if (!name || name.endsWith('.') || /[\x00-\x20\x7f~^:?*\[\\]/.test(name) ||
      name.includes('..') || name.includes('@{') ||
      name.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.lock'))) reject();
  for (const branch of existing) {
    if (branch === name || branch.startsWith(`${name}/`) || name.startsWith(`${branch}/`)) reject();
  }
  return name;
}

export function cloneSnapshot(body: Buffer, head: string, pack: Buffer): Buffer {
  // GitClient deduplicates main and branch aliases into one want. No have rounds,
  // shallow requests, extra wants, or unadvertised capabilities are supported.
  const requests = ['side-band-64k no-progress', 'side-band-64k'].map(caps =>
    Buffer.from(pkt(`want ${head} ${caps}\n`) + '0000' + pkt('done\n') + '0000'));
  if (!requests.some(request => request.equals(body))) reject();
  const chunks = [Buffer.from(pkt('NAK\n'))];
  for (let offset = 0; offset < pack.length; offset += 65515) {
    const payload = pack.subarray(offset, offset + 65515);
    chunks.push(Buffer.from((payload.length + 5).toString(16).padStart(4, '0')), Buffer.from([1]), payload);
  }
  chunks.push(Buffer.from('0000'));
  return Buffer.concat(chunks);
}
const utf8 = (bytes: Buffer): string => {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text).equals(bytes)) reject();
  return text;
};

export function pushCommands(body: Buffer) {
  let offset = 0;
  const commands: { old: string; head: string; ref: string }[] = [];
  for (;;) {
    const header = body.subarray(offset, offset + 4).toString('utf8');
    if (!/^[0-9a-f]{4}$/.test(header)) reject();
    const size = parseInt(header, 16);
    offset += 4;
    if (!size) break;
    if (size < 5 || size > 1024 || offset + size - 4 > body.length || commands.length >= 16) reject();
    const text = utf8(body.subarray(offset, offset + size - 4));
    offset += size - 4;
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (refs\/[A-Za-z0-9._/-]+)(?:\0([^\n\0]*))?\n?$/.exec(text);
    if (!match || (commands.length && match[4] !== undefined)) reject();
    // Only report-status is advertised, so no sideband, push-options or delta negotiation.
    if (!commands.length && match[4] !== 'report-status') reject();
    commands.push({ old: match[1], head: match[2], ref: match[3] });
  }
  if (!commands.length) reject();
  return { commands, pack: body.subarray(offset) };
}

export function initialSnapshot(pack: Buffer, head: string, branch: string) {
  return readSnapshot(pack, head, branch);
}

// Exactly one update of a validated root; no general history or branch sequencing.
export function directChild(pack: Buffer, head: string, branch: string, rootPack: Buffer, rootHead: string) {
  const root = initialSnapshot(rootPack, rootHead, branch);
  if (head === rootHead || head === ZERO_OID) reject();
  return readSnapshot(pack, head, branch, root);
}

// Re-encode validated raw objects, preserving every hashed byte in one complete pack.
function historyPack(objects: Map<string, Buffer>): Buffer {
  if (objects.size > 10) reject();
  const header = Buffer.alloc(12);
  header.write('PACK'); header.writeUInt32BE(2, 4); header.writeUInt32BE(objects.size, 8);
  const parts = [header];
  let total = 0;
  for (const [oid, raw] of objects) {
    const nul = raw.indexOf(0);
    const match = /^(commit|tree|blob) (0|[1-9][0-9]*)$/.exec(raw.subarray(0, nul).toString());
    if (!match || sha1(raw) !== oid) reject();
    const payload = raw.subarray(nul + 1);
    if (Number(match[2]) !== payload.length || (total += payload.length) > 2 * MAX_PUSH_BYTES) reject();
    let size = payload.length;
    let byte = ({ commit: 1, tree: 2, blob: 3 } as Record<string, number>)[match[1]] * 16 + (size & 15);
    const bytes: number[] = [];
    size = Math.floor(size / 16);
    while (size) { bytes.push(byte | 128); byte = size & 127; size = Math.floor(size / 128); }
    bytes.push(byte);
    parts.push(Buffer.from(bytes), deflateSync(payload));
  }
  const body = Buffer.concat(parts);
  if (body.length + 20 > 2 * MAX_PUSH_BYTES) reject();
  return Buffer.concat([body, Buffer.from(sha1(body), 'hex')]);
}

function readSnapshot(pack: Buffer, head: string, branch: string, root?: { head: string; objects: Map<string, Buffer> }) {
  if (pack.length < 32 || pack.length > MAX_PUSH_BYTES || !pack.subarray(0, 4).equals(Buffer.from('PACK')) ||
      pack.readUInt32BE(4) !== 2 || sha1(pack.subarray(0, -20)) !== pack.subarray(-20).toString('hex')) reject();
  const count = pack.readUInt32BE(8);
  if (count < (root ? 1 : 3) || count > 5) reject();
  const objects = new Map<string, Buffer>();
  const decoded = new Map<string, { type: string; payload: Buffer }>();
  let offset = 12;
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (offset >= pack.length - 20) reject();
    let byte = pack[offset++];
    const type = ({ 1: 'commit', 2: 'tree', 3: 'blob' } as Record<number, string>)[(byte >> 4) & 7];
    if (!type) reject();
    let size = byte & 15;
    let multiplier = 16;
    while (byte & 128) {
      if (offset >= pack.length - 20 || multiplier > MAX_PUSH_BYTES) reject();
      byte = pack[offset++];
      size += (byte & 127) * multiplier;
      multiplier *= 128;
    }
    total += size;
    if (total > MAX_PUSH_BYTES) reject();
    const inflated = inflateSync(pack.subarray(offset, -20), { info: true, maxOutputLength: Math.max(1, size) });
    const payload = inflated.buffer;
    if (payload.length !== size || !inflated.engine.bytesWritten) reject();
    offset += inflated.engine.bytesWritten;
    const raw = Buffer.concat([Buffer.from(`${type} ${size}\0`), payload]);
    const oid = sha1(raw);
    if (objects.has(oid)) reject();
    objects.set(oid, raw);
    decoded.set(oid, { type, payload });
  }
  if (offset !== pack.length - 20 || [...decoded.values()].filter(o => o.type === 'commit').length !== 1 ||
      [...decoded.values()].filter(o => o.type === 'blob').length > 1 ||
      (!root && [...decoded.values()].filter(o => o.type === 'blob').length !== 1)) reject();
  const incoming = new Set(objects.keys());
  if (root) for (const [oid, raw] of root.objects) {
    if (objects.has(oid)) reject(); // The fixture sends only missing objects.
    const nul = raw.indexOf(0);
    objects.set(oid, raw);
    decoded.set(oid, { type: raw.subarray(0, nul).toString().split(' ')[0], payload: raw.subarray(nul + 1) });
  }
  const commit = decoded.get(head);
  if (commit?.type !== 'commit') reject();
  // Strict headers exclude parents, signatures and extensions. Store all original bytes unchanged.
  let text = utf8(commit.payload);
  if (root) {
    const parent = /^tree [0-9a-f]{40}\nparent ([0-9a-f]{40})\n/.exec(text);
    if (!incoming.has(head) || !parent || parent[1] !== root.head) reject();
    // Strip only for grammar checking; stored commit bytes remain untouched.
    text = text.replace(`parent ${root.head}\n`, '');
  }
  const match = /^tree ([0-9a-f]{40})\nauthor ([^<>\n\0]+) <([^<>\n\0]+)> (\d+) ([+-]\d{4})\ncommitter ([^<>\n\0]+) <([^<>\n\0]+)> (\d+) ([+-]\d{4})\n\n([^\0]*)$/.exec(text);
  if (!match) reject();
  const tree = match[1];
  const used = new Set([head]);
  const files = new Map<string, { file: Buffer; blob: string }>();
  const walk = (oid: string, prefix: string, depth: number): void => {
    const object = decoded.get(oid);
    if (depth > 3 || used.has(oid) || object?.type !== 'tree') reject();
    used.add(oid);
    const bytes = object.payload;
    const nul = bytes.indexOf(0);
    // Exactly one entry per tree: a chain ending in the fixture's single regular file.
    if (nul < 0 || nul + 21 !== bytes.length) reject();
    const entry = /^(40000|100644) ([^/\\\x00-\x1f\x7f]+)$/.exec(utf8(bytes.subarray(0, nul)));
    if (!entry || ['.', '..', '.git'].includes(entry[2].toLowerCase())) reject();
    const target = bytes.subarray(nul + 1).toString('hex');
    const path = prefix + entry[2];
    if (entry[1] === '40000') walk(target, path + '/', depth + 1);
    else {
      const blob = decoded.get(target);
      if (blob?.type !== 'blob' || used.has(target)) reject();
      used.add(target);
      files.set(path, { file: blob.payload, blob: target });
    }
  };
  walk(tree, '', 1);
  if ([...incoming].some(oid => !used.has(oid)) || files.size !== 1) reject();
  const [path, entry] = [...files][0];
  return { files, path, file: entry.file, blob: entry.blob, objects, tree, head, branch, pack: root ? historyPack(objects) : Buffer.from(pack), parent: root?.head, message: match[10].replace(/\n$/, '') };
}
