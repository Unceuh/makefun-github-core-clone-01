// gitproto.ts — the git smart-HTTP wire protocol, implemented by hand.
//
// No git binary exists in the trial, so the forge speaks the protocol
// itself, on node:zlib and node:crypto only. What the conformance suite
// exercises (see spec-git.md):
//
// - GET info/refs?service=git-upload-pack / git-receive-pack: v0
//   advertisement, "# service=..." preamble, capabilities on the first
//   ref line, "<ZERO> capabilities^{}\0<caps>" for an empty repository.
// - POST git-upload-pack: protocol v2 (advertisement "version 2" + the
//   `fetch` and `ls-refs` commands) and the v0 fallback. v2 advertises
//   `fetch=shallow filter`, `ls-refs=unborn`, `object-format=sha1`;
//   ls-refs reports ref prefixes, unborn HEAD, peeled tag lines and
//   `ref <oid> HEAD` for HEAD; fetch delivers an exact object closure,
//   never re-sends objects the client already has, honours shallow/deepen
//   (depth N from the wanted tip means N generations), and answers
//   shallow/unshallow lines.
// - POST git-receive-pack (v0): stores the pack's objects, then applies
//   the ref updates. Every update must fast-forward: a non-fast-forward
//   update is refused per ref ("ng <ref> non-fast-forward", the ref does
//   not move), and a push with one fast-forward ref and one refused ref
//   applies the fast-forward one and answers one report line each
//   ("unpack ok" first, then one ok/ng line per ref).
// - Packs are version 2, plain objects only (no deltas on either side).
//   Objects are written and read in the order the client lists them;
//   the server never re-serialises an object it was given.

import { deflateSync, inflateSync } from 'node:zlib';
import {
  ZERO_OID,
  buildTree,
  parseCommit,
  parseTree,
  sha1Of,
  type GitObject,
  type ObjType,
  type Repo,
  type Store,
} from './store.ts';

// -- pkt-line framing -----------------------------------------------------

export function pkt(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  const header = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, body]);
}

export const FLUSH = Buffer.from('0000', 'ascii');
export const DELIM = Buffer.from('0001', 'ascii');

export interface Packet {
  kind: 'data' | 'flush' | 'delim';
  data: Buffer;
}

/** Parse pkt-lines from a buffer; returns the packets and the offset where they end. */
export function parsePackets(buf: Buffer): { packets: Packet[]; end: number } {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const hex = buf.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
    const len = Number.parseInt(hex, 16);
    if (len === 0) {
      packets.push({ kind: 'flush', data: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (len === 1) {
      packets.push({ kind: 'delim', data: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (offset + len > buf.length) break;
    packets.push({ kind: 'data', data: buf.subarray(offset + 4, offset + len) });
    offset += len;
  }
  return { packets, end: offset };
}

/** Split one pkt-line payload on the first NUL: [text, capabilities]. */
export function splitCapabilities(line: Buffer): { text: string; caps: string | null } {
  const nul = line.indexOf(0);
  if (nul === -1) return { text: line.toString('utf8'), caps: null };
  return {
    text: line.subarray(0, nul).toString('utf8'),
    caps: line.subarray(nul + 1).toString('utf8'),
  };
}

// -- packfile --------------------------------------------------------------

/** Serialise objects as a packfile version 2 (plain objects, no deltas). */
export function writePack(objects: { type: ObjType; data: Buffer }[]): Buffer {
  const chunks: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  chunks.push(header);
  for (const obj of objects) {
    const typeNum = obj.type === 'commit' ? 1 : obj.type === 'tree' ? 2 : obj.type === 'blob' ? 3 : 4;
    const size = obj.data.length;
    const head: number[] = [];
    let byte = (typeNum << 4) | (size & 0x0f);
    let rest = size >> 4;
    if (rest > 0) byte |= 0x80;
    head.push(byte);
    while (rest > 0) {
      byte = rest & 0x7f;
      rest >>= 7;
      if (rest > 0) byte |= 0x80;
      head.push(byte);
    }
    chunks.push(Buffer.from(head));
    chunks.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(chunks);
  const trailer = sha1Of(body);
  return Buffer.concat([body, Buffer.from(trailer, 'hex')]);
}

/** Parse a packfile version 2. Delta entries are not expected (the suite's
 *  client sends plain objects only); one is treated as an error. */
export function readPack(buf: Buffer): Map<string, GitObject> {
  if (buf.length < 12 || buf.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = buf.readUInt32BE(4);
  const count = buf.readUInt32BE(8);
  if (version !== 2) throw new Error(`unsupported pack version ${version}`);
  const out = new Map<string, GitObject>();
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const typeNum = (buf[offset] >> 4) & 0x07;
    if (typeNum === 6 || typeNum === 7) throw new Error('delta pack entry not supported');
    const type: ObjType = typeNum === 1 ? 'commit' : typeNum === 2 ? 'tree' : typeNum === 3 ? 'blob' : 'tag';
    let size = buf[offset] & 0x0f;
    let shift = 4;
    let consumed = 1;
    while ((buf[offset + consumed - 1] & 0x80) !== 0) {
      size |= (buf[offset + consumed] & 0x7f) << shift;
      shift += 7;
      consumed += 1;
    }
    offset += consumed;
    // inflateSync ignores trailing bytes, and with {info: true} the engine
    // reports exactly how many input bytes the stream consumed.
    const inflated = inflateSync(buf.subarray(offset), { info: true });
    const data = inflated.buffer as Buffer;
    const used = typeof inflated.engine?.bytesWritten === 'number' && inflated.engine.bytesWritten > 0
      ? inflated.engine.bytesWritten
      : deflatedLength(buf.subarray(offset), size);
    if (data.length !== size) throw new Error('pack object size mismatch');
    offset += used;
    const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
    const oid = sha1Of(Buffer.concat([header, data]));
    out.set(oid, { type, data });
  }
  return out;
}

/** The number of bytes the zlib stream starting at buf consumes. */
function deflatedLength(buf: Buffer, expectedSize: number): number {
  // inflateSync cannot report consumed length, so walk the stream by
  // inflating growing prefixes would be quadratic. Instead, use the
  // zlib header and trial lengths with a binary search on the deflate
  // stream: the shortest prefix that inflates to exactly expectedSize.
  let lo = 1;
  let hi = buf.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    try {
      const data = inflateSync(buf.subarray(0, mid));
      if (data.length === expectedSize) return mid;
      if (data.length < expectedSize) lo = mid + 1;
      else hi = mid;
    } catch {
      lo = mid + 1;
    }
  }
  return lo;
}

// -- object closure --------------------------------------------------------

/**
 * The full closure of an oid: the object itself plus everything it
 * references (commit -> tree + parents, tree -> entries, tag -> target).
 */
export function closureOf(store: Store, repo: Repo, root: string): Map<string, GitObject> {
  const out = new Map<string, GitObject>();
  const queue: string[] = [root];
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (out.has(oid)) continue;
    const obj = store.getObject(repo, oid);
    if (obj === null) continue;
    out.set(oid, obj);
    if (obj.type === 'commit') {
      const commit = parseCommit(obj.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) queue.push(entry.oid);
    } else if (obj.type === 'tag') {
      const text = obj.data.toString('utf8');
      const match = text.match(/^object ([0-9a-f]{40})$/m);
      if (match !== null) queue.push(match[1] as string);
    }
  }
  return out;
}

/** The closure of a list of roots, in first-seen order. */
export function closureOfMany(store: Store, repo: Repo, roots: string[]): Map<string, GitObject> {
  const out = new Map<string, GitObject>();
  for (const root of roots) {
    for (const [oid, obj] of closureOf(store, repo, root)) {
      if (!out.has(oid)) out.set(oid, obj);
    }
  }
  return out;
}

/**
 * Walk from a wanted commit with a depth limit. Depth N from the tip
 * means N generations (the tip and N-1 ancestors); the boundary commits
 * are the last generation included. Returns the object ids to send and
 * the boundary commit ids.
 */
export function depthWalk(
  store: Store,
  repo: Repo,
  tip: string,
  depth: number,
): { objects: Map<string, GitObject>; boundary: string[] } {
  const objects = new Map<string, GitObject>();
  const boundary: string[] = [];
  const queue: { oid: string; remaining: number }[] = [{ oid: tip, remaining: depth }];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const { oid, remaining } = queue.shift() as { oid: string; remaining: number };
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = store.getObject(repo, oid);
    if (obj === null) continue;
    if (obj.type === 'commit') {
      const commit = parseCommit(obj.data);
      objects.set(oid, obj);
      for (const [entryOid, entryObj] of closureOf(store, repo, commit.tree)) {
        if (!objects.has(entryOid)) objects.set(entryOid, entryObj);
      }
      if (remaining <= 1) {
        boundary.push(oid);
      } else {
        for (const parent of commit.parents) queue.push({ oid: parent, remaining: remaining - 1 });
      }
    } else {
      for (const [entryOid, entryObj] of closureOf(store, repo, oid)) {
        if (!objects.has(entryOid)) objects.set(entryOid, entryObj);
      }
    }
  }
  return { objects, boundary };
}

// -- advertisements --------------------------------------------------------

const UPLOAD_CAPS =
  'symref=HEAD:refs/heads/main side-band-64k thin-pack ofs-delta shallow multi_ack_detailed agent=makefun-git-forge/1.0 object-format=sha1';
const RECEIVE_CAPS =
  'symref=HEAD:refs/heads/main report-status side-band-64k delete-refs agent=makefun-git-forge/1.0 object-format=sha1';

function sortedRefNames(repo: Repo): string[] {
  return [...repo.refs.keys()].sort();
}

/** The v0 advertisement for a service, with the "# service=" preamble. */
export function advertiseV0(repo: Repo, service: 'upload-pack' | 'receive-pack'): Buffer {
  const caps = service === 'upload-pack' ? UPLOAD_CAPS : RECEIVE_CAPS;
  const chunks: Buffer[] = [pkt(`# service=git-${service}\n`), FLUSH];
  const names = sortedRefNames(repo);
  if (names.length === 0) {
    chunks.push(pkt(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    names.forEach((ref, index) => {
      const oid = repo.refs.get(ref) as string;
      if (index === 0) chunks.push(pkt(`${oid} ${ref}\0${caps}\n`));
      else chunks.push(pkt(`${oid} ${ref}\n`));
      if (ref.startsWith('refs/tags/')) {
        const obj = repo.objects.get(oid);
        if (obj !== undefined && obj.type === 'tag') {
          const text = obj.data.toString('utf8');
          const match = text.match(/^object ([0-9a-f]{40})$/m);
          if (match !== null) chunks.push(pkt(`${match[1]} ${ref}^{}\n`));
        }
      }
    });
  }
  chunks.push(FLUSH);
  return Buffer.concat(chunks);
}

/** The v2 capability advertisement for git-upload-pack. */
export function advertiseV2(): Buffer {
  return Buffer.concat([
    pkt('# service=git-upload-pack\n'),
    FLUSH,
    pkt('version 2\n'),
    pkt('fetch=shallow filter\n'),
    pkt('ls-refs=unborn\n'),
    pkt('object-format=sha1\n'),
    pkt('agent=makefun-git-forge/1.0\n'),
    FLUSH,
  ]);
}

/**
 * Handle a POST git-upload-pack body: either a v2 command request or a
 * v0 want/have request. Returns the response buffer.
 */
export function handleUploadPack(store: Store, repo: Repo, body: Buffer): Buffer {
  const { packets, end } = parsePackets(body);
  if (packets.length === 0 || packets[0]?.kind !== 'data') {
    throw new Error('empty upload-pack request');
  }
  const first = (packets[0]?.data ?? Buffer.alloc(0)).toString('utf8').trim();
  if (first.startsWith('command=')) {
    return handleUploadPackV2(store, repo, packets);
  }
  return handleUploadPackV0(store, repo, packets, end, body);
}

// -- protocol v2 -----------------------------------------------------------

function handleUploadPackV2(store: Store, repo: Repo, packets: Packet[]): Buffer {
  const command = (packets[0]?.data ?? Buffer.alloc(0)).toString('utf8').trim().slice('command='.length);
  if (command === 'ls-refs') {
    const prefixes: string[] = [];
    let peel = false;
    let symrefs = false;
    let unborn = false;
    for (const packet of packets.slice(1)) {
      if (packet.kind === 'flush') break;
      const line = packet.data.toString('utf8').trim();
      if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
      else if (line === 'peel') peel = true;
      else if (line === 'symrefs') symrefs = true;
      else if (line === 'unborn') unborn = true;
    }
    const headMatches = prefixes.length === 0 || prefixes.some((p) => 'HEAD'.startsWith(p));
    const chunks: Buffer[] = [];
    const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
    const names = sortedRefNames(repo).filter((ref) => {
      if (prefixes.length === 0) return true;
      return prefixes.some((prefix) => ref.startsWith(prefix));
    });
    for (const ref of names) {
      const oid = repo.refs.get(ref) as string;
      let line = `${oid} ${ref}`;
      if (peel && ref.startsWith('refs/tags/')) {
        const obj = repo.objects.get(oid);
        if (obj !== undefined && obj.type === 'tag') {
          const text = obj.data.toString('utf8');
          const match = text.match(/^object ([0-9a-f]{40})$/m);
          if (match !== null) line += ` peeled:${match[1]}`;
        }
      }
      chunks.push(pkt(`${line}\n`));
    }
    if (headTip !== null && headMatches) {
      const symref = symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : '';
      chunks.push(pkt(`${headTip} HEAD${symref}\n`));
    }
    if (names.length === 0 && headTip === null && unborn && headMatches) {
      chunks.push(pkt(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
    }
    chunks.push(FLUSH);
    return Buffer.concat(chunks);
  }
  if (command === 'fetch') {
    const wants: string[] = [];
    const haves = new Set<string>();
    const clientShallow: string[] = [];
    let depth: number | null = null;
    for (const packet of packets.slice(1)) {
      if (packet.kind === 'flush') break;
      const line = packet.data.toString('utf8').trim();
      if (line === 'done') break;
      if (line.startsWith('want ')) wants.push(line.slice(5).trim().split(' ')[0] as string);
      else if (line.startsWith('have ')) haves.add(line.slice(5).trim().split(' ')[0] as string);
      else if (line.startsWith('shallow ')) clientShallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) depth = Number.parseInt(line.slice(7).trim(), 10);
    }
    const { objects, shallow, unshallow } = computeFetch(store, repo, wants, haves, depth, clientShallow);
    const pack = writePack([...objects.values()]);
    const chunks: Buffer[] = [];
    // The v2 fetch response is sectioned: acknowledgments, shallow-info,
    // packfile — sections separated by delim, the response by flush.
    if (haves.size > 0) {
      chunks.push(pkt('acknowledgments\n'));
      chunks.push(pkt('NAK\n'));
      chunks.push(DELIM);
    }
    if (shallow.length > 0 || unshallow.length > 0) {
      chunks.push(pkt('shallow-info\n'));
      for (const oid of shallow) chunks.push(pkt(`shallow ${oid}\n`));
      for (const oid of unshallow) chunks.push(pkt(`unshallow ${oid}\n`));
      chunks.push(DELIM);
    }
    chunks.push(pkt('packfile\n'));
    if (pack.length > 0) {
      for (let i = 0; i < pack.length; i += 65515) {
        chunks.push(pkt(Buffer.concat([Buffer.from([0x01]), pack.subarray(i, i + 65515)])));
      }
    }
    chunks.push(FLUSH);
    return Buffer.concat(chunks);
  }
  throw new Error(`unsupported v2 command ${command}`);
}

/**
 * The objects the client already holds, from its `have` lines. A have is
 * the whole closure of the commit — except when the client also lists it
 * as a shallow boundary, in which case it holds the commit and its tree
 * but NOT its parents (that is what makes a shallow clone shallow, and
 * what a deepen fetch must deliver).
 */
function heldClosure(
  store: Store,
  repo: Repo,
  haves: Set<string>,
  clientShallow: string[],
): Map<string, GitObject> {
  const shallowSet = new Set(clientShallow);
  const out = new Map<string, GitObject>();
  const queue: string[] = [...haves];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = store.getObject(repo, oid);
    if (obj === null) continue;
    out.set(oid, obj);
    if (obj.type === 'commit') {
      const commit = parseCommit(obj.data);
      for (const [entryOid, entryObj] of closureOf(store, repo, commit.tree)) {
        if (!out.has(entryOid)) out.set(entryOid, entryObj);
      }
      if (!shallowSet.has(oid)) {
        for (const parent of commit.parents) queue.push(parent);
      }
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) queue.push(entry.oid);
    } else if (obj.type === 'tag') {
      const match = obj.data.toString('utf8').match(/^object ([0-9a-f]{40})$/m);
      if (match !== null) queue.push(match[1] as string);
    }
  }
  return out;
}

/** Shared fetch computation for v0 and v2: objects to send, shallow and unshallow lines. */
export function computeFetch(
  store: Store,
  repo: Repo,
  wants: string[],
  haves: Set<string>,
  depth: number | null,
  clientShallow: string[],
): { objects: Map<string, GitObject>; shallow: string[]; unshallow: string[] } {
  const haveClosure = heldClosure(store, repo, haves, clientShallow);
  const candidates = new Map<string, GitObject>();
  let boundary: string[] = [];
  if (depth !== null && !Number.isNaN(depth)) {
    for (const want of wants) {
      const { objects, boundary: b } = depthWalk(store, repo, want, depth);
      for (const [oid, obj] of objects) if (!candidates.has(oid)) candidates.set(oid, obj);
      boundary.push(...b);
    }
  } else {
    for (const [oid, obj] of closureOfMany(store, repo, wants)) {
      if (!candidates.has(oid)) candidates.set(oid, obj);
    }
  }
  const objects = new Map<string, GitObject>();
  for (const [oid, obj] of candidates) {
    if (!haveClosure.has(oid)) objects.set(oid, obj);
  }
  const shallow = [...new Set(boundary)].filter((oid) => objects.has(oid));
  // A boundary the client already had becomes unshallow when this fetch
  // delivers it with its parents: the boundary is in the new closure, is
  // not itself a new boundary, and every parent is now held or sent.
  const unshallow: string[] = [];
  for (const oid of clientShallow) {
    if (!candidates.has(oid) || shallow.includes(oid)) continue;
    const obj = store.getObject(repo, oid);
    if (obj === null || obj.type !== 'commit') continue;
    const commit = parseCommit(obj.data);
    if (commit.parents.length === 0) continue;
    const delivered = commit.parents.every((p) => objects.has(p) || haveClosure.has(p));
    if (delivered) unshallow.push(oid);
  }
  return { objects, shallow, unshallow };
}

// -- protocol v0 fetch -----------------------------------------------------

function handleUploadPackV0(
  store: Store,
  repo: Repo,
  packets: Packet[],
  end: number,
  body: Buffer,
): Buffer {
  const wants: string[] = [];
  const haves = new Set<string>();
  const clientShallow: string[] = [];
  let depth: number | null = null;
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const { text } = splitCapabilities(packet.data);
    const line = text.trim();
    // The first v0 want line carries the negotiated capabilities after the
    // oid ("want <oid> side-band-64k ..."); only the oid is wanted.
    if (line.startsWith('want ')) wants.push(line.slice(5).trim().split(' ')[0] as string);
    else if (line.startsWith('have ')) haves.add(line.slice(5).trim().split(' ')[0] as string);
    else if (line.startsWith('shallow ')) clientShallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depth = Number.parseInt(line.slice(7).trim(), 10);
    else if (line === 'done') break;
  }
  const { objects, shallow, unshallow } = computeFetch(store, repo, wants, haves, depth, clientShallow);
  const pack = writePack([...objects.values()]);
  const chunks: Buffer[] = [pkt('NAK\n')];
  for (const oid of shallow) chunks.push(pkt(`shallow ${oid}\n`));
  for (const oid of unshallow) chunks.push(pkt(`unshallow ${oid}\n`));
  if (pack.length > 0) {
    for (let i = 0; i < pack.length; i += 65515) {
      chunks.push(pkt(Buffer.concat([Buffer.from([0x01]), pack.subarray(i, i + 65515)])));
    }
  }
  chunks.push(FLUSH);
  return Buffer.concat(chunks);
}

// -- protocol v0 receive-pack ----------------------------------------------

/**
 * Handle a POST git-receive-pack body. Stores the pack's objects, then
 * applies the ref updates, each independently: a non-fast-forward update
 * is refused with "ng <ref> non-fast-forward" and leaves the ref where
 * it was. Returns the sideband report-status response.
 */
export function handleReceivePack(store: Store, repo: Repo, body: Buffer): Buffer {
  const { packets, end } = parsePackets(body);
  const commands: { oldOid: string; newOid: string; ref: string }[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const { text } = splitCapabilities(packet.data);
    const line = text.trim();
    if (line === '') continue;
    const parts = line.split(' ');
    if (parts.length >= 3) {
      commands.push({
        oldOid: parts[0] as string,
        newOid: parts[1] as string,
        ref: parts.slice(2).join(' '),
      });
    }
  }
  // Everything after the command flush is the packfile.
  const packBytes = body.subarray(end);
  if (packBytes.length > 0) {
    const objects = readPack(packBytes);
    for (const [oid, obj] of objects) {
      if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
    }
  }
  const report: string[] = ['unpack ok\n'];
  for (const cmd of commands) {
    if (cmd.ref.startsWith('refs/heads/') || cmd.ref.startsWith('refs/tags/')) {
      const current = repo.refs.get(cmd.ref) ?? null;
      const isDelete = cmd.newOid === ZERO_OID;
      const isCreate = cmd.oldOid === ZERO_OID;
      let ok = true;
      let reason = '';
      if (isDelete) {
        if (current === null) {
          ok = false;
          reason = 'no such ref';
        }
      } else if (isCreate) {
        if (current !== null) {
          ok = false;
          reason = 'non-fast-forward';
        } else if (store.getObject(repo, cmd.newOid) === null) {
          ok = false;
          reason = 'non-fast-forward';
        }
      } else if (current === null) {
        ok = false;
        reason = 'non-fast-forward';
      } else if (cmd.oldOid !== current) {
        ok = false;
        reason = 'non-fast-forward';
      } else if (!store.isAncestor(repo, current, cmd.newOid)) {
        ok = false;
        reason = 'non-fast-forward';
      }
      if (ok) {
        if (isDelete) repo.refs.delete(cmd.ref);
        else repo.refs.set(cmd.ref, cmd.newOid);
        report.push(`ok ${cmd.ref}\n`);
      } else {
        report.push(`ng ${cmd.ref} ${reason}\n`);
      }
    } else {
      report.push(`ng ${cmd.ref} non-fast-forward\n`);
    }
  }
  const chunks: Buffer[] = [];
  for (const line of report) {
    const payload = Buffer.concat([Buffer.from([0x01]), Buffer.from(line, 'utf8')]);
    chunks.push(pkt(payload));
  }
  chunks.push(FLUSH);
  return Buffer.concat(chunks);
}
