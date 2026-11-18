// store.ts — the forge's in-memory store and its git object machinery.
//
// Everything the suite checks reads or writes lives here: repositories,
// refs, git objects (commits/trees/blobs/tags), issues, comments, labels
// and pull requests. All ordering comes from monotonic counters, never
// from the wall clock: the final trials are replayed and the state export
// must match byte for byte.
//
// Git model notes (the conformance suite checks all of these):
// - Objects are addressed by SHA-1 over "type len\0data" (sha1, not sha256).
// - Trees are stored as raw entries "mode name\0<20-byte oid>"; entry order
//   is git's tree sort (names compared as bytes, directories as name+'/').
// - Commits the server creates (contents PUT, squash merges) use a fixed
//   author/committer identity and a fixed epoch unless the trial sets
//   MAKEFUN_TRIAL_NOW; the checks assert messages and trees, not times.
// - Merge-base is the first common commit found by walking both histories
//   newest first; histories here are short, so a plain walk is fast enough.

import { createHash } from 'node:crypto';
import { viewerIdentity } from './scenario.ts';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

export function sha1Of(buffer: Buffer): string {
  return createHash('sha1').update(buffer).digest('hex');
}

/** The git object id of a (type, data) pair. */
export function hashObject(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return sha1Of(Buffer.concat([header, data]));
}

export const ZERO_OID = '0000000000000000000000000000000000000000';

export type IssueState = 'open' | 'closed';
export type PullState = 'open' | 'closed';

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: IssueState;
  labels: string[];
  seq: number;
}

export interface Comment {
  id: number;
  body: string;
}

export interface PullFile {
  path: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: PullState;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headShaAtCreate: string;
  baseShaAtCreate: string;
  files: PullFile[];
  seq: number;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  labels: Map<string, { name: string; color: string }>;
  issues: Issue[];
  comments: Map<number, Comment[]>;
  pulls: PullRequest[];
  issueSeq: number;
  pullSeq: number;
  commentSeq: number;
  seq: number;
}

export interface ParsedCommit {
  tree: string;
  parents: string[];
  message: string;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** The fixed instant every stored timestamp uses (see the module note). */
export function fixedNowIso(): string {
  const trial = process.env.MAKEFUN_TRIAL_NOW;
  if (trial !== undefined && trial !== '') return trial;
  return '2026-11-14T00:00:00Z';
}

/** Epoch seconds for server-authored git commits. */
export function fixedNowEpoch(): number {
  const iso = fixedNowIso();
  const ms = Date.parse(iso);
  if (Number.isFinite(ms)) return Math.floor(ms / 1000);
  return 1735689600;
}

/** Compare two git tree entry names the way git sorts them. */
export function compareTreeNames(a: string, b: string): number {
  const aa = a.endsWith('/') ? a : a;
  const bb = b.endsWith('/') ? b : b;
  return Buffer.compare(Buffer.from(aa, 'utf8'), Buffer.from(bb, 'utf8'));
}

/** Parse a raw commit object. */
export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  return { tree, parents, message };
}

/** Parse a raw tree object into its entries. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) break;
    const nul = data.indexOf(0x00, space + 1);
    if (nul === -1) break;
    const mode = data.subarray(offset, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Serialise tree entries in git tree order. */
export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((x, y) => {
    const xn = x.mode === '40000' ? `${x.name}/` : x.name;
    const yn = y.mode === '40000' ? `${y.name}/` : y.name;
    return Buffer.compare(Buffer.from(xn, 'utf8'), Buffer.from(yn, 'utf8'));
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** The lines of a file's text, without the trailing-newline artifact. */
export function linesOf(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts;
}

export class Store {
  repos = new Map<string, Repo>();
  repoSeq = 0;
  issueIdSeq = 0;
  commentIdSeq = 0;
  pullIdSeq = 0;

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | null {
    return this.repos.get(this.key(owner, name)) ?? null;
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean, defaultBranch = 'main'): Repo {
    this.repoSeq += 1;
    const repo: Repo = {
      id: this.repoSeq,
      name,
      owner,
      description,
      isPrivate,
      defaultBranch,
      refs: new Map<string, string>(),
      objects: new Map<string, GitObject>(),
      labels: new Map<string, { name: string; color: string }>(),
      issues: [],
      comments: new Map<number, Comment[]>(),
      pulls: [],
      issueSeq: 0,
      pullSeq: 0,
      commentSeq: 0,
      seq: this.repoSeq,
    };
    // Labels do not exist beforehand: the suite creates each label it
    // uses via POST /labels, and an issue naming a label that was never
    // created is rejected. Do not pre-seed the default set.
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  // -- git objects -------------------------------------------------------

  putObject(repo: Repo, type: ObjType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | null {
    return repo.objects.get(oid) ?? null;
  }

  getCommit(repo: Repo, oid: string): ParsedCommit | null {
    const obj = this.getObject(repo, oid);
    if (obj === null || obj.type !== 'commit') return null;
    return parseCommit(obj.data);
  }

  /** Set (or delete) a ref. */
  setRef(repo: Repo, ref: string, oid: string | null): void {
    if (oid === null) repo.refs.delete(ref);
    else repo.refs.set(ref, oid);
  }

  /** The ref a branch name resolves to. */
  refForBranch(repo: Repo, branch: string): string {
    return `refs/heads/${branch}`;
  }

  branchTip(repo: Repo, branch: string): string | null {
    return repo.refs.get(this.refForBranch(repo, branch)) ?? null;
  }

  /** Every commit reachable from an oid (newest first, deduped). */
  commitWalk(repo: Repo, tip: string, limit = 10000): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const queue: string[] = [tip];
    while (queue.length > 0 && out.length < limit) {
      const oid = queue.shift() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const commit = this.getCommit(repo, oid);
      if (commit === null) continue;
      out.push(oid);
      for (const parent of commit.parents) {
        if (!seen.has(parent)) queue.push(parent);
      }
    }
    return out;
  }

  /** The first common commit of two tips (walk both histories newest first). */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    if (a === b) return a;
    const aSet = new Set(this.commitWalk(repo, a));
    const bWalk = this.commitWalk(repo, b);
    for (const oid of bWalk) {
      if (aSet.has(oid)) return oid;
    }
    return null;
  }

  isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
    if (ancestor === tip) return true;
    const walk = this.commitWalk(repo, tip);
    return walk.includes(ancestor);
  }

  /** Flatten a tree to path -> {oid, mode}. */
  flattenTree(repo: Repo, treeOid: string | null, prefix = ''): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    if (treeOid === null) return out;
    const obj = this.getObject(repo, treeOid);
    if (obj === null || obj.type !== 'tree') return out;
    for (const entry of parseTree(obj.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') {
        for (const [p, v] of this.flattenTree(repo, entry.oid, path)) out.set(p, v);
      } else {
        out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    }
    return out;
  }

  /** The blob oid at a path in a commit's tree, or null. */
  fileAt(repo: Repo, commitOid: string, path: string): { oid: string; data: Buffer } | null {
    const commit = this.getCommit(repo, commitOid);
    if (commit === null) return null;
    const flat = this.flattenTree(repo, commit.tree);
    const entry = flat.get(path);
    if (entry === undefined) return null;
    const obj = this.getObject(repo, entry.oid);
    if (obj === null || obj.type !== 'blob') return null;
    return { oid: entry.oid, data: obj.data };
  }

  /** The subtree oid at a path in a tree (null when the path is not a tree). */
  subtreeAt(repo: Repo, treeOid: string | null, segments: string[]): string | null {
    if (treeOid === null) return null;
    if (segments.length === 0) return treeOid;
    const obj = this.getObject(repo, treeOid);
    if (obj === null || obj.type !== 'tree') return null;
    for (const entry of parseTree(obj.data)) {
      if (entry.name === segments[0] && entry.mode === '40000') {
        return this.subtreeAt(repo, entry.oid, segments.slice(1));
      }
    }
    return null;
  }

  /**
   * Return a new tree oid equal to treeOid with the file at `segments`
   * replaced by blobOid (or removed when blobOid is null). Creates the
   * intermediate directories as needed.
   */
  setPath(repo: Repo, treeOid: string | null, segments: string[], blobOid: string | null): string {
    const entries: TreeEntry[] = [];
    if (treeOid !== null) {
      const obj = this.getObject(repo, treeOid);
      if (obj !== null && obj.type === 'tree') entries.push(...parseTree(obj.data));
    }
    const [head, ...rest] = segments as [string, ...string[]];
    const idx = entries.findIndex((e) => e.name === head);
    if (rest.length === 0) {
      if (blobOid === null) {
        if (idx !== -1) entries.splice(idx, 1);
      } else if (idx !== -1) {
        entries[idx] = { mode: '100644', name: head, oid: blobOid };
      } else {
        entries.push({ mode: '100644', name: head, oid: blobOid });
      }
    } else {
      const childTree = idx !== -1 && entries[idx]?.mode === '40000' ? entries[idx].oid : null;
      const next = this.setPath(repo, childTree, rest, blobOid);
      const empty = this.isTreeEmpty(repo, next);
      if (empty) {
        if (idx !== -1) entries.splice(idx, 1);
      } else if (idx !== -1) {
        entries[idx] = { mode: '40000', name: head, oid: next };
      } else {
        entries.push({ mode: '40000', name: head, oid: next });
      }
    }
    const data = buildTree(entries);
    return this.putObject(repo, 'tree', data);
  }

  isTreeEmpty(repo: Repo, treeOid: string): boolean {
    const obj = this.getObject(repo, treeOid);
    if (obj === null || obj.type !== 'tree') return false;
    return parseTree(obj.data).length === 0;
  }

  /**
   * A three-way diff between baseTree and headTree (both possibly null).
   * Returns per-path change records with git line counts.
   */
  diffTrees(repo: Repo, baseTree: string | null, headTree: string | null): PullFile[] {
    const base = this.flattenTree(repo, baseTree);
    const head = this.flattenTree(repo, headTree);
    const paths = new Set<string>([...base.keys(), ...head.keys()]);
    const out: PullFile[] = [];
    for (const path of [...paths].sort()) {
      const b = base.get(path);
      const h = head.get(path);
      if (b !== undefined && h === undefined) {
        const data = this.getObject(repo, b.oid)?.data ?? Buffer.alloc(0);
        const deletions = linesOf(data.toString('utf8')).length;
        out.push({ path, status: 'removed', additions: 0, deletions, changes: deletions });
      } else if (b === undefined && h !== undefined) {
        const data = this.getObject(repo, h.oid)?.data ?? Buffer.alloc(0);
        const additions = linesOf(data.toString('utf8')).length;
        out.push({ path, status: 'added', additions, deletions: 0, changes: additions });
      } else if (b !== undefined && h !== undefined && b.oid !== h.oid) {
        const oldData = this.getObject(repo, b.oid)?.data ?? Buffer.alloc(0);
        const newData = this.getObject(repo, h.oid)?.data ?? Buffer.alloc(0);
        const oldLines = linesOf(oldData.toString('utf8'));
        const newLines = linesOf(newData.toString('utf8'));
        const oldSet = new Set(oldLines);
        const newSet = new Set(newLines);
        let additions = 0;
        for (const line of newLines) if (!oldSet.has(line)) additions += 1;
        let deletions = 0;
        for (const line of oldLines) if (!newSet.has(line)) deletions += 1;
        if (additions === 0 && deletions === 0) additions = 1;
        out.push({ path, status: 'modified', additions, deletions, changes: additions + deletions });
      }
    }
    return out;
  }

  /** Create a server-authored commit (contents PUT / squash merge). */
  makeServerCommit(repo: Repo, tree: string, parents: string[], message: string): string {
    const me = viewerIdentity();
    const epoch = fixedNowEpoch();
    const stamp = `${epoch} +0000`;
    const lines = [`tree ${tree}`];
    for (const parent of parents) lines.push(`parent ${parent}`);
    lines.push(`author ${me.name} <${me.email}> ${stamp}`);
    lines.push(`committer ${me.name} <${me.email}> ${stamp}`);
    lines.push('');
    lines.push(message);
    const data = Buffer.from(`${lines.join('\n')}\n`, 'utf8');
    return this.putObject(repo, 'commit', data);
  }

  /**
   * Whether a squash merge of the pull request would conflict: a path the
   * head changed (against the merge base) that the base also changed to a
   * different result. Pure — it creates no objects.
   */
  mergeConflict(repo: Repo, pull: PullRequest): boolean {
    const baseTip = this.branchTip(repo, pull.baseRef);
    const headTip = this.branchTip(repo, pull.headRef);
    if (baseTip === null || headTip === null) return true;
    const baseCommit = this.getCommit(repo, baseTip);
    const headCommit = this.getCommit(repo, headTip);
    if (baseCommit === null || headCommit === null) return true;
    const mergeBase = this.mergeBase(repo, baseTip, headTip);
    if (mergeBase === null) return true;
    const baseBase = this.getCommit(repo, mergeBase);
    if (baseBase === null) return true;
    const baseFlat = this.flattenTree(repo, baseCommit.tree);
    const headFlat = this.flattenTree(repo, headCommit.tree);
    const ancestorFlat = this.flattenTree(repo, baseBase.tree);
    const paths = new Set<string>([...ancestorFlat.keys(), ...headFlat.keys()]);
    for (const path of paths) {
      const a = ancestorFlat.get(path);
      const h = headFlat.get(path);
      const b = baseFlat.get(path);
      const changedInHead = (a?.oid ?? null) !== (h?.oid ?? null);
      const changedInBase = (a?.oid ?? null) !== (b?.oid ?? null);
      if (changedInHead && changedInBase && (b?.oid ?? null) !== (h?.oid ?? null)) return true;
    }
    return false;
  }

  /** Create a squash-merge commit on the base branch from a pull request. */
  squashMerge(repo: Repo, pull: PullRequest): { commitOid: string; conflict: boolean } {
    if (this.mergeConflict(repo, pull)) return { commitOid: '', conflict: true };
    const baseTip = this.branchTip(repo, pull.baseRef) as string;
    const headTip = this.branchTip(repo, pull.headRef) as string;
    const baseCommit = this.getCommit(repo, baseTip) as ParsedCommit;
    const headCommit = this.getCommit(repo, headTip) as ParsedCommit;
    const mergeBase = this.mergeBase(repo, baseTip, headTip) as string;
    const baseBase = this.getCommit(repo, mergeBase) as ParsedCommit;
    const baseFlat = this.flattenTree(repo, baseCommit.tree);
    const headFlat = this.flattenTree(repo, headCommit.tree);
    const ancestorFlat = this.flattenTree(repo, baseBase.tree);
    const paths = new Set<string>([...ancestorFlat.keys(), ...headFlat.keys()]);
    let tree = baseCommit.tree;
    for (const path of paths) {
      const a = ancestorFlat.get(path);
      const h = headFlat.get(path);
      const changedInHead = (a?.oid ?? null) !== (h?.oid ?? null);
      if (!changedInHead) continue;
      tree = this.setPath(repo, tree, path.split('/'), h?.oid ?? null);
    }
    const message = `${pull.title} (#${pull.number})\n`;
    const commitOid = this.makeServerCommit(repo, tree, [baseTip], message);
    return { commitOid, conflict: false };
  }
}
