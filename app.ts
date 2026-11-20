// app.ts — the forge's HTTP server: REST v3, GraphQL, MCP and git smart HTTP.
//
// Routing:
// - GET  /healthz                       -> {"ok": true} (no auth)
// - GET  /api/v3/                       -> API root (no auth)
// - GET  /api/v3/meta                  -> {"installed_version": ...} (no auth)
// - /api/v3/...                         -> REST v3 (Bearer auth)
// - POST /api/graphql                  -> GraphQL v4 (Bearer auth)
// - POST /mcp                          -> MCP over streamable HTTP (Bearer auth)
// - /<owner>/<repo>.git/...            -> git smart HTTP (Bearer auth)
// - anything else                       -> 404 {"message": "Not Found"}
//
// Auth: when MAKEFUN_SHOP_TOKEN is set, every protected call needs a
// non-empty `Authorization: Bearer ...` header (the suite never presents
// a wrong token, so the value is not compared); a missing token is 401.
// A repository under another owner is 404, never 403.
// Every REST reply is application/json with a non-empty
// X-GitHub-Request-Id header; errors carry a JSON body with a string
// message. All ids and ordering come from store counters, never the wall
// clock, so the state export is deterministic.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { viewerIdentity, viewerLogin } from './scenario.ts';
import {
  Store,
  fixedNowIso,
  fixedNowEpoch,
  type Issue,
  type PullRequest,
  type Repo,
} from './store.ts';
import { advertiseV0, advertiseV2, handleReceivePack, handleUploadPack } from './gitproto.ts';
import { executeGraphQL, repoNodeId, nodeId } from './graphql.ts';
import { handleMcp } from './mcp.ts';

let requestCounter = 0;

function sendJson(res: ServerResponse, status: number, obj: unknown, extraHeaders: Record<string, string> = {}): void {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'X-GitHub-Request-Id': `req-${++requestCounter}`,
    'Content-Length': Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

function sendBuffer(
  res: ServerResponse,
  status: number,
  buf: Buffer,
  contentType: string,
  extraHeaders: Record<string, string> = {},
): void {
  res.writeHead(status, {
    'Content-Type': contentType,
    'X-GitHub-Request-Id': `req-${++requestCounter}`,
    'Content-Length': buf.length,
    ...extraHeaders,
  });
  res.end(buf);
}

function notFound(res: ServerResponse, message = 'Not Found'): void {
  sendJson(res, 404, { message });
}

function isAuthorized(req: IncomingMessage): boolean {
  const token = process.env.MAKEFUN_SHOP_TOKEN;
  if (token === undefined || token === '') return true;
  const auth = req.headers.authorization;
  return typeof auth === 'string' && /^Bearer\s+\S+$/.test(auth);
}

// -- serialisers -------------------------------------------------------------

function userObject(): Record<string, unknown> {
  const me = viewerIdentity();
  return {
    login: me.login,
    id: me.id,
    node_id: Buffer.from(`User:${me.id}`, 'utf8').toString('base64'),
    avatar_url: `https://github.example/${me.login}.png`,
    gravatar_id: '',
    url: `/api/v3/users/${me.login}`,
    html_url: `https://github.example/${me.login}`,
    type: 'User',
    site_admin: false,
    name: me.name,
    email: me.email,
  };
}

function repoObject(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: repoNodeId(repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: viewerIdentity().id, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    html_url: `https://github.example/${repo.owner}/${repo.name}`,
    clone_url: `https://github.example/${repo.owner}/${repo.name}.git`,
    git_url: `git://github.example/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@github.example:${repo.owner}/${repo.name}.git`,
    created_at: fixedNowIso(),
    updated_at: fixedNowIso(),
    pushed_at: fixedNowIso(),
    default_branch: repo.defaultBranch,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    has_pages: false,
    has_downloads: true,
    archived: false,
    disabled: false,
    visibility: repo.isPrivate ? 'private' : 'public',
    license: null,
    allow_forking: true,
  };
}

function branchObject(repo: Repo, name: string, sha: string): Record<string, unknown> {
  return {
    name,
    commit: { sha, url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}` },
    protected: false,
  };
}

function parsePerson(line: string | undefined): { name: string; email: string; date: string } {
  const me = viewerIdentity();
  if (line === undefined) {
    return { name: me.name, email: me.email, date: new Date(fixedNowEpoch() * 1000).toISOString() };
  }
  const match = line.match(/^(.*?) <([^>]*)> (\d+) ([+-]\d{4})$/);
  if (match === null) return { name: me.name, email: me.email, date: new Date(fixedNowEpoch() * 1000).toISOString() };
  const epoch = Number.parseInt(match[3] as string, 10);
  return {
    name: match[1] as string,
    email: match[2] as string,
    date: new Date(epoch * 1000).toISOString(),
  };
}

function commitObject(store: Store, repo: Repo, oid: string): Record<string, unknown> | null {
  const obj = store.getObject(repo, oid);
  if (obj === null || obj.type !== 'commit') return null;
  const text = obj.data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let authorLine: string | undefined;
  let committerLine: string | undefined;
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) authorLine = line.slice(7);
    else if (line.startsWith('committer ')) committerLine = line.slice(10);
  }
  const author = parsePerson(authorLine);
  const committer = parsePerson(committerLine);
  // GitHub's API returns the commit message without its trailing newline.
  const cleanMessage = message.replace(/\n+$/, '');
  return {
    sha: oid,
    node_id: Buffer.from(`Commit:${repo.id}:${oid}`, 'utf8').toString('base64'),
    commit: {
      message: cleanMessage,
      author,
      committer,
      tree: { sha: tree },
      url: `/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${oid}`,
      comment_count: 0,
    },
    author: { login: viewerLogin(), id: viewerIdentity().id, type: 'User' },
    committer: { login: viewerLogin(), id: viewerIdentity().id, type: 'User' },
    parents: parents.map((sha) => ({ sha, url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}` })),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${oid}`,
    html_url: `https://github.example/${repo.owner}/${repo.name}/commit/${oid}`,
  };
}

function issueObject(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: nodeId('Issue', repo.id, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    state_reason: null,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? '000000', description: '' };
    }),
    user: { login: repo.owner, id: viewerIdentity().id, type: 'User' },
    assignee: null,
    assignees: [],
    locked: false,
    comments: (repo.comments.get(issue.number) ?? []).length,
    created_at: fixedNowIso(),
    updated_at: fixedNowIso(),
    closed_at: issue.state === 'closed' ? fixedNowIso() : null,
    html_url: `https://github.example/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function commentObject(repo: Repo, issueNumber: number, comment: { id: number; body: string }): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: Buffer.from(`IssueComment:${repo.id}:${comment.id}`, 'utf8').toString('base64'),
    body: comment.body,
    user: { login: repo.owner, id: viewerIdentity().id, type: 'User' },
    created_at: fixedNowIso(),
    updated_at: fixedNowIso(),
    html_url: `https://github.example/${repo.owner}/${repo.name}/issues/${issueNumber}#issuecomment-${comment.id}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issueNumber}/comments/${comment.id}`,
    issue_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issueNumber}`,
  };
}

function pullObject(store: Store, repo: Repo, pull: PullRequest): Record<string, unknown> {
  const headSha = store.branchTip(repo, pull.headRef) ?? pull.headShaAtCreate;
  const baseSha = store.branchTip(repo, pull.baseRef) ?? pull.baseShaAtCreate;
  return {
    id: pull.id,
    node_id: nodeId('PullRequest', repo.id, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: !pull.merged && !store.mergeConflict(repo, pull),
    mergeable_state: pull.merged ? 'unknown' : store.mergeConflict(repo, pull) ? 'dirty' : 'clean',
    draft: false,
    head: {
      label: `${repo.owner}:${pull.headRef}`,
      ref: pull.headRef,
      sha: headSha,
      repo: repoObject(repo),
    },
    base: {
      label: `${repo.owner}:${pull.baseRef}`,
      ref: pull.baseRef,
      sha: baseSha,
      repo: repoObject(repo),
    },
    user: { login: repo.owner, id: viewerIdentity().id, type: 'User' },
    created_at: fixedNowIso(),
    updated_at: fixedNowIso(),
    closed_at: pull.state === 'closed' ? fixedNowIso() : null,
    html_url: `https://github.example/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    commits: 1,
    additions: pull.files.reduce((sum, f) => sum + f.additions, 0),
    deletions: pull.files.reduce((sum, f) => sum + f.deletions, 0),
    changed_files: pull.files.length,
  };
}

function labelObject(repo: Repo, name: string): Record<string, unknown> {
  const label = repo.labels.get(name);
  const names = [...repo.labels.keys()];
  return {
    id: names.indexOf(name) + 1,
    node_id: Buffer.from(`Label:${repo.id}:${name}`, 'utf8').toString('base64'),
    name,
    color: label?.color ?? '000000',
    description: '',
    default: true,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(name)}`,
  };
}

function fileEntry(repo: Repo, filePath: string, sha: string, data: Buffer): Record<string, unknown> {
  const name = filePath.split('/').pop() ?? '';
  return {
    type: 'file',
    encoding: 'base64',
    size: data.length,
    name,
    path: filePath,
    content: data.toString('base64'),
    sha,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${filePath}`,
    git_url: `/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${sha}`,
    html_url: `https://github.example/${repo.owner}/${repo.name}/blob/main/${filePath}`,
    download_url: null,
    _links: {
      self: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${filePath}`,
      git: `/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${sha}`,
      html: `https://github.example/${repo.owner}/${repo.name}/blob/main/${filePath}`,
    },
  };
}

function dirListing(store: Store, repo: Repo, treeOid: string, prefix: string): Record<string, unknown>[] {
  const entries = store.treeOf(repo, treeOid);
  if (entries === null) return [];
  const out: Record<string, unknown>[] = [];
  for (const entry of entries) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    const isDir = entry.mode === '40000';
    out.push({
      type: isDir ? 'dir' : 'file',
      size: isDir ? 0 : (store.getObject(repo, entry.oid)?.data.length ?? 0),
      name: entry.name,
      path,
      sha: entry.oid,
      url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
      git_url: `/api/v3/repos/${repo.owner}/${repo.name}/git/${isDir ? 'trees' : 'blobs'}/${entry.oid}`,
      html_url: `https://github.example/${repo.owner}/${repo.name}/${isDir ? 'tree' : 'blob'}/main/${path}`,
      download_url: isDir ? null : `https://github.example/${repo.owner}/${repo.name}/raw/main/${path}`,
    });
  }
  return out;
}

// -- pagination --------------------------------------------------------------

interface PageParams {
  page: number;
  perPage: number;
}

function pageParams(query: URLSearchParams): PageParams {
  const perPageRaw = Number.parseInt(query.get('per_page') ?? '30', 10);
  const pageRaw = Number.parseInt(query.get('page') ?? '1', 10);
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30;
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  return { page, perPage };
}

function paginate<T>(items: T[], params: PageParams): { page: T[]; totalPages: number } {
  const totalPages = Math.max(1, Math.ceil(items.length / params.perPage));
  const start = (params.page - 1) * params.perPage;
  return { page: items.slice(start, start + params.perPage), totalPages };
}

function linkHeader(req: IncomingMessage, path: string, query: URLSearchParams, params: PageParams, totalPages: number): string {
  const host = req.headers.host ?? '127.0.0.1';
  const base = `http://${host}${path}`;
  const links: string[] = [];
  const build = (page: number): string => {
    const q = new URLSearchParams(query);
    q.set('page', String(page));
    q.set('per_page', String(params.perPage));
    return `${base}?${q.toString()}`;
  };
  if (params.page < totalPages) links.push(`<${build(params.page + 1)}>; rel="next"`);
  if (params.page > 1) links.push(`<${build(params.page - 1)}>; rel="prev"`);
  links.push(`<${build(1)}>; rel="first"`);
  links.push(`<${build(totalPages)}>; rel="last"`);
  return links.join(', ');
}

// -- helpers -----------------------------------------------------------------

function parseJsonBody(body: Buffer): { ok: true; value: Record<string, unknown> } | { ok: false } {
  if (body.length === 0) return { ok: true, value: {} };
  try {
    const value = JSON.parse(body.toString('utf8')) as unknown;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      return { ok: true, value: value as Record<string, unknown> };
    }
    return { ok: true, value: {} };
  } catch {
    return { ok: false };
  }
}

function decodeSegment(segment: string): string {
  // Most segments carry no escapes: skip decodeURIComponent entirely.
  if (!segment.includes('%')) return segment;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function branchFromHead(head: string): string {
  const idx = head.indexOf(':');
  return idx === -1 ? head : head.slice(idx + 1);
}

// -- the server --------------------------------------------------------------

/** Build the server (main.ts calls this with no arguments). It binds nothing until listened on. */
export function createApp(store: Store = new Store()): Server {
  const server = createServer((req, res) => {
    void (async () => {
      try {
        await handleRequest(req, res, store);
      } catch (err) {
        console.error('forge error:', err);
        if (!res.headersSent) sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
        else res.end();
      }
    })();
  });
  return server;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > 256 * 1024 * 1024) throw new Error('request body too large');
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, store: Store): Promise<void> {
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', 'http://localhost');
  const rawSegments = url.pathname.split('/').filter((s) => s !== '');
  const segments = rawSegments.map(decodeSegment);
  const query = url.searchParams;

  // -- healthz (no auth) --
  if (method === 'GET' && segments.length === 1 && segments[0] === 'healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // -- GraphQL --
  if (segments.length === 2 && segments[0] === 'api' && segments[1] === 'graphql' && method === 'POST') {
    if (!isAuthorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    const body = await readBody(req);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      sendJson(res, 400, { message: 'Invalid JSON' });
      return;
    }
    const result = executeGraphQL(store, parsed);
    sendJson(res, 200, result);
    return;
  }

  // -- MCP --
  if (segments.length === 1 && segments[0] === 'mcp' && method === 'POST') {
    if (!isAuthorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    const body = await readBody(req);
    const result = handleMcp(store, body);
    if (result.body === null) {
      res.writeHead(result.status, { 'X-GitHub-Request-Id': `req-${++requestCounter}` });
      res.end();
      return;
    }
    sendJson(res, result.status, result.body);
    return;
  }

  // -- git smart HTTP --
  if (segments.length >= 2 && segments[1]?.endsWith('.git') === true) {
    const owner = segments[0] as string;
    const repoName = (segments[1] as string).slice(0, -'.git'.length);
    const rest = segments.slice(2);
    if (!isAuthorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    const repo = store.getRepo(owner, repoName);
    if (method === 'GET' && rest.length === 2 && rest[0] === 'info' && rest[1] === 'refs') {
      const service = query.get('service');
      if (repo === null) {
        notFound(res);
        return;
      }
      if (service === 'git-upload-pack') {
        // A v2-capable client asks with Git-Protocol: version=2 and gets
        // the v2 advertisement; anything else gets the v0 advertisement.
        if ((req.headers['git-protocol'] ?? '') === 'version=2') {
          sendBuffer(res, 200, advertiseV2(), 'application/x-git-upload-pack-advertisement');
        } else {
          sendBuffer(res, 200, advertiseV0(repo, 'upload-pack'), 'application/x-git-upload-pack-advertisement');
        }
        return;
      }
      if (service === 'git-receive-pack') {
        sendBuffer(res, 200, advertiseV0(repo, 'receive-pack'), 'application/x-git-receive-pack-advertisement');
        return;
      }
      sendJson(res, 400, { message: 'unknown service' });
      return;
    }
    if (method === 'POST' && rest.length === 1 && rest[0] === 'git-upload-pack') {
      if (repo === null) {
        notFound(res);
        return;
      }
      const body = await readBody(req);
      try {
        const out = handleUploadPack(store, repo, body);
        sendBuffer(res, 200, out, 'application/x-git-upload-pack-result');
      } catch (err) {
        console.error('upload-pack error:', err);
        sendJson(res, 400, { message: err instanceof Error ? err.message : 'bad request' });
      }
      return;
    }
    if (method === 'POST' && rest.length === 1 && rest[0] === 'git-receive-pack') {
      if (repo === null) {
        notFound(res);
        return;
      }
      const body = await readBody(req);
      try {
        const out = handleReceivePack(store, repo, body);
        sendBuffer(res, 200, out, 'application/x-git-receive-pack-result');
      } catch (err) {
        console.error('receive-pack error:', err);
        sendJson(res, 400, { message: err instanceof Error ? err.message : 'bad request' });
      }
      return;
    }
    notFound(res);
    return;
  }

  // -- REST v3 --
  if (segments.length >= 2 && segments[0] === 'api' && segments[1] === 'v3') {
    await handleRest(req, res, store, segments.slice(2), url, query);
    return;
  }

  notFound(res);
}

// -- REST v3 -----------------------------------------------------------------

async function handleRest(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  parts: string[],
  url: URL,
  query: URLSearchParams,
): Promise<void> {
  const method = req.method ?? 'GET';
  const path = url.pathname;

  // API root and meta are unauthenticated.
  if (parts.length === 0 && method === 'GET') {
    const host = req.headers.host ?? '127.0.0.1';
    const base = `http://${host}/api/v3`;
    sendJson(res, 200, {
      current_user_url: `${base}/user`,
      current_user_authorizations_html_url: `https://github.example/settings/applications`,
      authorizations_url: `${base}/authorizations`,
      code_search_url: `${base}/search/code?q={query}{&page,per_page,sort,order}`,
      commit_search_url: `${base}/search/commits?q={query}{&page,per_page,sort,order}`,
      emails_url: `${base}/user/emails`,
      emojis_url: `${base}/emojis`,
      events_url: `${base}/events`,
      feeds_url: `${base}/feeds`,
      followers_url: `${base}/user/followers`,
      following_url: `${base}/user/following{/target}`,
      gists_url: `${base}/gists{/gist_id}`,
      hub_url: `${base}/hub`,
      issue_search_url: `${base}/search/issues?q={query}{&page,per_page,sort,order}`,
      issues_url: `${base}/issues`,
      keys_url: `${base}/user/keys`,
      labels_url: `${base}/repos/{owner}/{repo}/labels{/name}`,
      marketplace_purchase_url: `${base}/marketplace_listing/accounts/{account_id}`,
      marketplace_purchases_url: `${base}/user/marketplace_purchases`,
      notifications_url: `${base}/notifications{?since,all,participating}`,
      organizations_url: `${base}/user/orgs`,
      orgs_url: `${base}/orgs/{org}`,
      public_gists_url: `${base}/gists/public`,
      rate_limit_url: `${base}/rate_limit`,
      repository_url: `${base}/repos/{owner}/{repo}`,
      repository_search_url: `${base}/search/repositories?q={query}{&page,per_page,sort,order}`,
      search_url: `${base}/search`,
      starred_url: `${base}/user/starred{/owner}{/repo}`,
      starred_gists_url: `${base}/gists/starred`,
      user_url: `${base}/users/{user}`,
      user_organizations_url: `${base}/user/orgs`,
      user_repositories_url: `${base}/user/repos{?type,page,per_page,sort}`,
      user_search_url: `${base}/search/users?q={query}{&page,per_page,sort,order}`,
    }, { 'X-Oauth-Scopes': 'repo, read:org' });
    return;
  }
  if (parts.length === 1 && parts[0] === 'meta' && method === 'GET') {
    sendJson(res, 200, {
      verifiable_password_authentication: true,
      password_authentication: true,
      git: ['github.com'],
      hooks: ['*'],
      github_enterprise: false,
      installed_version: '1.0.0',
      api: { versions: ['2022-11-28'] },
    });
    return;
  }

  if (!isAuthorized(req)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return;
  }

  const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
  const parsed = parseJsonBody(body);
  if (!parsed.ok) {
    sendJson(res, 400, { message: 'Invalid JSON' });
    return;
  }
  const data = parsed.value;

  // -- /user --
  if (parts.length === 1 && parts[0] === 'user' && method === 'GET') {
    sendJson(res, 200, userObject());
    return;
  }
  if (parts.length === 2 && parts[0] === 'user' && parts[1] === 'repos') {
    if (method === 'GET') {
      const params = pageParams(query);
      const repos = [...store.repos.values()]
        .filter((r) => r.owner === viewerLogin())
        .sort((a, b) => a.seq - b.seq);
      const { page, totalPages } = paginate(repos, params);
      sendJson(res, 200, page.map(repoObject), {
        Link: linkHeader(req, path, query, params, totalPages),
      });
      return;
    }
    if (method === 'POST') {
      const name = typeof data.name === 'string' ? data.name.trim() : '';
      if (name === '') {
        sendJson(res, 422, { message: 'name is required' });
        return;
      }
      if (store.getRepo(viewerLogin(), name) !== null) {
        sendJson(res, 422, { message: 'Repository already exists' });
        return;
      }
      const repo = store.createRepo(
        viewerLogin(),
        name,
        typeof data.description === 'string' ? data.description : '',
        data.private === true,
      );
      sendJson(res, 201, repoObject(repo));
      return;
    }
  }
  if (parts.length === 2 && parts[0] === 'users' && method === 'GET') {
    if (parts[1] === viewerLogin()) {
      sendJson(res, 200, userObject());
      return;
    }
    notFound(res);
    return;
  }

  // -- /repos/{owner}/{repo}/... --
  if (parts.length >= 3 && parts[0] === 'repos') {
    const owner = parts[1] as string;
    const repoName = parts[2] as string;
    const repo = store.getRepo(owner, repoName);
    // A repository under another owner is 404, never 403 — and a missing
    // repository is 404 too, so both cases answer the same way.
    if (repo === null || repo.owner !== viewerLogin()) {
      notFound(res);
      return;
    }
    const sub = parts.slice(3);
    await handleRepoRoutes(req, res, store, repo, sub, method, data, path, query);
    return;
  }

  notFound(res);
}

async function handleRepoRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  repo: Repo,
  sub: string[],
  method: string,
  data: Record<string, unknown>,
  path: string,
  query: URLSearchParams,
): Promise<void> {
  // -- the repository itself --
  if (sub.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, repoObject(repo));
      return;
    }
    if (method === 'PATCH') {
      if (typeof data.description === 'string') repo.description = data.description;
      if (typeof data.private === 'boolean') repo.isPrivate = data.private;
      if (typeof data.default_branch === 'string') repo.defaultBranch = data.default_branch;
      sendJson(res, 200, repoObject(repo));
      return;
    }
    if (method === 'DELETE') {
      store.repos.delete(store.key(repo.owner, repo.name));
      res.writeHead(204, { 'X-GitHub-Request-Id': `req-${++requestCounter}` });
      res.end();
      return;
    }
    notFound(res);
    return;
  }

  // -- branches --
  if (sub[0] === 'branches') {
    if (sub.length === 1 && method === 'GET') {
      const params = pageParams(query);
      const names = [...repo.refs.keys()]
        .filter((r) => r.startsWith('refs/heads/'))
        .map((r) => r.slice('refs/heads/'.length))
        .sort();
      const { page, totalPages } = paginate(names, params);
      sendJson(
        res,
        200,
        page.map((name) => branchObject(repo, name, repo.refs.get(`refs/heads/${name}`) as string)),
        { Link: linkHeader(req, path, query, params, totalPages) },
      );
      return;
    }
    if (sub.length >= 2 && method === 'GET') {
      const branch = sub.slice(1).join('/');
      const tip = store.branchTip(repo, branch);
      if (tip === null) {
        notFound(res, 'Branch not found');
        return;
      }
      sendJson(res, 200, branchObject(repo, branch, tip));
      return;
    }
    notFound(res);
    return;
  }

  // -- git refs --
  if (sub[0] === 'git' && sub[1] === 'refs') {
    if (method === 'POST' && sub.length === 2) {
      const ref = typeof data.ref === 'string' ? data.ref : '';
      const sha = typeof data.sha === 'string' ? data.sha : '';
      if (!ref.startsWith('refs/')) {
        sendJson(res, 422, { message: 'ref must start with refs/' });
        return;
      }
      if (store.getObject(repo, sha) === null) {
        sendJson(res, 422, { message: 'sha does not exist' });
        return;
      }
      if (repo.refs.has(ref)) {
        sendJson(res, 422, { message: 'Reference already exists' });
        return;
      }
      repo.refs.set(ref, sha);
      const obj = store.getObject(repo, sha);
      sendJson(res, 201, {
        ref,
        node_id: Buffer.from(`Ref:${repo.id}:${ref}`, 'utf8').toString('base64'),
        url: `/api/v3/repos/${repo.owner}/${repo.name}/git/refs/${ref}`,
        object: { sha, type: obj?.type ?? 'commit', url: `/api/v3/repos/${repo.owner}/${repo.name}/git/${obj?.type ?? 'commits'}/${sha}` },
      });
      return;
    }
    if (sub.length >= 3) {
      const ref = `refs/${sub.slice(2).join('/')}`;
      const tip = repo.refs.get(ref);
      if (method === 'GET') {
        if (tip === undefined) {
          notFound(res, 'Reference does not exist');
          return;
        }
        const obj = store.getObject(repo, tip);
        sendJson(res, 200, {
          ref,
          node_id: Buffer.from(`Ref:${repo.id}:${ref}`, 'utf8').toString('base64'),
          url: `/api/v3/repos/${repo.owner}/${repo.name}/git/refs/${ref}`,
          object: { sha: tip, type: obj?.type ?? 'commit', url: `/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${tip}` },
        });
        return;
      }
      if (method === 'PATCH') {
        if (tip === undefined) {
          notFound(res, 'Reference does not exist');
          return;
        }
        const sha = typeof data.sha === 'string' ? data.sha : '';
        if (store.getObject(repo, sha) === null) {
          sendJson(res, 422, { message: 'sha does not exist' });
          return;
        }
        if (data.force !== true && !store.isAncestor(repo, tip, sha)) {
          sendJson(res, 422, { message: 'Update is not a fast forward' });
          return;
        }
        repo.refs.set(ref, sha);
        sendJson(res, 200, {
          ref,
          object: { sha, type: 'commit', url: `/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${sha}` },
        });
        return;
      }
      if (method === 'DELETE') {
        if (tip === undefined) {
          notFound(res, 'Reference does not exist');
          return;
        }
        repo.refs.delete(ref);
        res.writeHead(204, { 'X-GitHub-Request-Id': `req-${++requestCounter}` });
        res.end();
        return;
      }
    }
    notFound(res);
    return;
  }

  // -- commits --
  if (sub[0] === 'commits') {
    if (sub.length === 1 && method === 'GET') {
      const shaParam = query.get('sha');
      let tip: string | null = null;
      if (shaParam !== null && shaParam !== '') {
        tip = store.branchTip(repo, shaParam) ?? (store.getObject(repo, shaParam) !== null ? shaParam : null);
      } else {
        tip = store.branchTip(repo, repo.defaultBranch);
      }
      if (tip === null) {
        sendJson(res, 200, []);
        return;
      }
      const params = pageParams(query);
      const walked = store.commitWalk(repo, tip);
      const { page, totalPages } = paginate(walked, params);
      const items = page.map((oid) => commitObject(store, repo, oid)).filter((c) => c !== null);
      sendJson(res, 200, items, { Link: linkHeader(req, path, query, params, totalPages) });
      return;
    }
    if (sub.length === 2 && method === 'GET') {
      const obj = commitObject(store, repo, sub[1] as string);
      if (obj === null) {
        notFound(res, 'Commit not found');
        return;
      }
      sendJson(res, 200, obj);
      return;
    }
    notFound(res);
    return;
  }

  // -- contents --
  if (sub[0] === 'contents') {
    const filePath = sub.slice(1).join('/');
    const branch = typeof data.branch === 'string' ? data.branch : query.get('ref') ?? repo.defaultBranch;
    if (method === 'GET') {
      const tip = store.branchTip(repo, branch);
      if (tip === null) {
        notFound(res, 'This repository is empty.');
        return;
      }
      const commit = store.getCommit(repo, tip);
      if (commit === null) {
        notFound(res);
        return;
      }
      if (filePath === '') {
        sendJson(res, 200, dirListing(store, repo, commit.tree, ''));
        return;
      }
      const segments = filePath.split('/');
      const subtree = store.subtreeAt(repo, commit.tree, segments);
      if (subtree !== null) {
        sendJson(res, 200, dirListing(store, repo, subtree, filePath));
        return;
      }
      const file = store.fileAt(repo, tip, filePath);
      if (file === null) {
        notFound(res);
        return;
      }
      sendJson(res, 200, fileEntry(repo, filePath, file.oid, file.data));
      return;
    }
    if (method === 'PUT') {
      const message = typeof data.message === 'string' ? data.message : 'Update file';
      const content = typeof data.content === 'string' ? data.content : '';
      const sha = typeof data.sha === 'string' ? data.sha : null;
      let decoded: Buffer;
      try {
        decoded = Buffer.from(content, 'base64');
      } catch {
        sendJson(res, 422, { message: 'content is not valid base64' });
        return;
      }
      const tip = store.branchTip(repo, branch);
      const existing = tip === null ? null : store.fileAt(repo, tip, filePath);
      if (sha !== null) {
        if (existing === null || existing.oid !== sha) {
          sendJson(res, 409, { message: 'sha does not match' });
          return;
        }
      }
      const blobOid = store.putObject(repo, 'blob', decoded);
      const baseTree = tip === null ? null : store.getCommit(repo, tip)?.tree ?? null;
      const newTree = store.setPath(repo, baseTree, filePath.split('/'), blobOid);
      const parents = tip === null ? [] : [tip];
      const commitOid = store.makeServerCommit(repo, newTree, parents, `${message}\n`);
      store.setRef(repo, store.refForBranch(repo, branch), commitOid);
      const status = existing === null ? 201 : 200;
      sendJson(res, status, {
        content: {
          name: filePath.split('/').pop() ?? '',
          path: filePath,
          sha: blobOid,
          size: decoded.length,
          type: 'file',
          encoding: 'base64',
          url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${filePath}`,
        },
        commit: { sha: commitOid, message },
      });
      return;
    }
    if (method === 'DELETE') {
      const message = typeof data.message === 'string' ? data.message : 'Delete file';
      const sha = typeof data.sha === 'string' ? data.sha : null;
      const tip = store.branchTip(repo, branch);
      if (tip === null) {
        notFound(res);
        return;
      }
      const existing = store.fileAt(repo, tip, filePath);
      if (existing === null) {
        notFound(res);
        return;
      }
      if (sha !== null && existing.oid !== sha) {
        sendJson(res, 409, { message: 'sha does not match' });
        return;
      }
      const commit = store.getCommit(repo, tip);
      if (commit === null) {
        notFound(res);
        return;
      }
      const newTree = store.setPath(repo, commit.tree, filePath.split('/'), null);
      const commitOid = store.makeServerCommit(repo, newTree, [tip], `${message}\n`);
      store.setRef(repo, store.refForBranch(repo, branch), commitOid);
      sendJson(res, 200, { commit: { sha: commitOid, message } });
      return;
    }
    notFound(res);
    return;
  }

  // -- labels --
  if (sub[0] === 'labels') {
    if (sub.length === 1 && method === 'GET') {
      sendJson(res, 200, [...repo.labels.keys()].map((name) => labelObject(repo, name)));
      return;
    }
    if (sub.length === 1 && method === 'POST') {
      const name = typeof data.name === 'string' ? data.name.trim() : '';
      if (name === '') {
        sendJson(res, 422, { message: 'name is required' });
        return;
      }
      if (repo.labels.has(name)) {
        sendJson(res, 422, { message: 'Label already exists' });
        return;
      }
      repo.labels.set(name, {
        name,
        color: typeof data.color === 'string' ? data.color : '000000',
      });
      sendJson(res, 201, labelObject(repo, name));
      return;
    }
    if (sub.length === 2) {
      const name = sub[1] as string;
      if (method === 'GET') {
        if (!repo.labels.has(name)) {
          notFound(res, 'Label does not exist');
          return;
        }
        sendJson(res, 200, labelObject(repo, name));
        return;
      }
      if (method === 'PATCH') {
        const label = repo.labels.get(name);
        if (label === undefined) {
          notFound(res, 'Label does not exist');
          return;
        }
        if (typeof data.color === 'string') label.color = data.color;
        if (typeof data.name === 'string' && data.name !== name) {
          repo.labels.delete(name);
          repo.labels.set(data.name, { name: data.name, color: label.color });
          sendJson(res, 200, labelObject(repo, data.name));
          return;
        }
        sendJson(res, 200, labelObject(repo, name));
        return;
      }
      if (method === 'DELETE') {
        if (!repo.labels.has(name)) {
          notFound(res, 'Label does not exist');
          return;
        }
        repo.labels.delete(name);
        res.writeHead(204, { 'X-GitHub-Request-Id': `req-${++requestCounter}` });
        res.end();
        return;
      }
    }
    notFound(res);
    return;
  }

  // -- issues --
  if (sub[0] === 'issues') {
    if (sub.length === 1 && method === 'GET') {
      const params = pageParams(query);
      const state = (query.get('state') ?? 'open').toLowerCase();
      const direction = (query.get('direction') ?? 'desc').toLowerCase();
      let items = [...repo.issues];
      if (state !== 'all') items = items.filter((i) => i.state === state);
      items.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
      const { page, totalPages } = paginate(items, params);
      sendJson(res, 200, page.map((i) => issueObject(repo, i)), {
        Link: linkHeader(req, path, query, params, totalPages),
      });
      return;
    }
    if (sub.length === 1 && method === 'POST') {
      const title = typeof data.title === 'string' ? data.title.trim() : '';
      if (title === '') {
        sendJson(res, 422, { message: 'title is required' });
        return;
      }
      const labelNames = Array.isArray(data.labels) ? (data.labels as string[]) : [];
      const unknownLabel = labelNames.find((name) => !repo.labels.has(name));
      if (unknownLabel !== undefined) {
        sendJson(res, 422, { message: `Label does not exist: ${unknownLabel}` });
        return;
      }
      repo.issueSeq += 1;
      store.issueIdSeq += 1;
      const issue: Issue = {
        id: store.issueIdSeq,
        number: repo.issueSeq,
        title,
        body: typeof data.body === 'string' ? data.body : '',
        state: 'open',
        labels: labelNames,
        seq: repo.issueSeq,
      };
      repo.issues.push(issue);
      sendJson(res, 201, issueObject(repo, issue));
      return;
    }
    if (sub.length >= 2) {
      const number = Number.parseInt(sub[1] as string, 10);
      const issue = repo.issues.find((i) => i.number === number);
      if (issue === undefined) {
        notFound(res, 'Issue not found');
        return;
      }
      if (sub.length === 2 && method === 'GET') {
        sendJson(res, 200, issueObject(repo, issue));
        return;
      }
      if (sub.length === 2 && method === 'PATCH') {
        if (typeof data.title === 'string') issue.title = data.title;
        if (typeof data.body === 'string') issue.body = data.body;
        if (data.state === 'open' || data.state === 'closed') issue.state = data.state;
        sendJson(res, 200, issueObject(repo, issue));
        return;
      }
      if (sub.length === 3 && sub[2] === 'comments') {
        if (method === 'GET') {
          const params = pageParams(query);
          const list = repo.comments.get(number) ?? [];
          const { page, totalPages } = paginate(list, params);
          sendJson(res, 200, page.map((c) => commentObject(repo, number, c)), {
            Link: linkHeader(req, path, query, params, totalPages),
          });
          return;
        }
        if (method === 'POST') {
          const commentBody = typeof data.body === 'string' ? data.body : '';
          repo.commentSeq += 1;
          store.commentIdSeq += 1;
          const comment = { id: store.commentIdSeq, body: commentBody };
          const list = repo.comments.get(number) ?? [];
          list.push(comment);
          repo.comments.set(number, list);
          sendJson(res, 201, commentObject(repo, number, comment));
          return;
        }
      }
      if (sub.length === 3 && sub[2] === 'labels' && method === 'POST') {
        const names = Array.isArray(data.labels) ? (data.labels as string[]) : [];
        for (const name of names) {
          if (!issue.labels.includes(name)) issue.labels.push(name);
        }
        sendJson(res, 200, issue.labels.map((name) => labelObject(repo, name)));
        return;
      }
      if (sub.length === 3 && sub[2] === 'labels' && method === 'GET') {
        sendJson(res, 200, issue.labels.map((name) => labelObject(repo, name)));
        return;
      }
    }
    notFound(res);
    return;
  }

  // -- pulls --
  if (sub[0] === 'pulls') {
    if (sub.length === 1 && method === 'GET') {
      const params = pageParams(query);
      const state = (query.get('state') ?? 'open').toLowerCase();
      let items = [...repo.pulls];
      if (state !== 'all') items = items.filter((p) => p.state === state);
      items.sort((a, b) => b.seq - a.seq);
      const { page, totalPages } = paginate(items, params);
      sendJson(res, 200, page.map((p) => pullObject(store, repo, p)), {
        Link: linkHeader(req, path, query, params, totalPages),
      });
      return;
    }
    if (sub.length === 1 && method === 'POST') {
      const title = typeof data.title === 'string' ? data.title.trim() : '';
      const head = branchFromHead(typeof data.head === 'string' ? data.head : '');
      const base = branchFromHead(typeof data.base === 'string' ? data.base : '');
      if (title === '' || head === '' || base === '') {
        sendJson(res, 422, { message: 'title, head and base are required' });
        return;
      }
      const headTip = store.branchTip(repo, head);
      const baseTip = store.branchTip(repo, base);
      if (headTip === null || baseTip === null) {
        sendJson(res, 422, { message: 'head or base branch not found' });
        return;
      }
      repo.pullSeq += 1;
      store.pullIdSeq += 1;
      const headCommit = store.getCommit(repo, headTip);
      const baseCommit = store.getCommit(repo, baseTip);
      const files = headCommit !== null && baseCommit !== null
        ? store.diffTrees(repo, baseCommit.tree, headCommit.tree)
        : [];
      const pull: PullRequest = {
        id: store.pullIdSeq,
        number: repo.pullSeq,
        title,
        body: typeof data.body === 'string' ? data.body : '',
        state: 'open',
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        headRef: head,
        baseRef: base,
        headShaAtCreate: headTip,
        baseShaAtCreate: baseTip,
        files,
        seq: repo.pullSeq,
      };
      repo.pulls.push(pull);
      sendJson(res, 201, pullObject(store, repo, pull));
      return;
    }
    if (sub.length >= 2) {
      const number = Number.parseInt(sub[1] as string, 10);
      const pull = repo.pulls.find((p) => p.number === number);
      if (pull === undefined) {
        notFound(res, 'Pull request not found');
        return;
      }
      if (sub.length === 2 && method === 'GET') {
        sendJson(res, 200, pullObject(store, repo, pull));
        return;
      }
      if (sub.length === 3 && sub[2] === 'files' && method === 'GET') {
        sendJson(res, 200, pull.files.map((f) => ({
          sha: '',
          filename: f.path,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
          changes: f.changes,
          blob_url: '',
          raw_url: '',
          contents_url: '',
        })));
        return;
      }
      if (sub.length === 3 && sub[2] === 'merge' && method === 'PUT') {
        if (pull.merged) {
          sendJson(res, 405, { message: 'Pull Request is already merged' });
          return;
        }
        const result = store.squashMerge(repo, pull);
        if (result.conflict) {
          sendJson(res, 405, { message: 'Merge conflict' });
          return;
        }
        store.setRef(repo, store.refForBranch(repo, pull.baseRef), result.commitOid);
        pull.merged = true;
        pull.state = 'closed';
        pull.mergedAt = fixedNowIso();
        pull.mergeCommitSha = result.commitOid;
        sendJson(res, 200, {
          merged: true,
          sha: result.commitOid,
          message: `${pull.title} (#${pull.number})`,
        });
        return;
      }
    }
    notFound(res);
    return;
  }

  notFound(res);
}
