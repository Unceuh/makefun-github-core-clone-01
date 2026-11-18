// mcp.ts — MCP over streamable HTTP (revision 2026-07-28, with the
// 2025-11-25 initialize handshake as a fallback).
//
// The suite speaks to this endpoint with two protocol eras (see
// spec-mcp-bench.md): a modern `server/discover` first, and, when that
// fails, a legacy `initialize` + `notifications/initialized` handshake.
// Both must work, and both must answer the same tools. The tools act on
// the same store as REST: a repository or issue created here reads back
// over REST with unchanged ids.
//
// Tool contracts (the arguments github-mcp-server documents):
// - create_repo {name, description?, private?}
// - get_repo {owner, repo}
// - create_issue {owner, repo, title, body?}
// - list_issues {owner, repo, state?}
// - create_pull_request {owner, repo, title, body?, head, base}
// - merge_pull_request {owner, repo, pull_number}
// Unknown tool -> JSON-RPC -32602 (never HTTP 500). A missing required
// argument -> isError:true (never HTTP 500). A non-JSON body -> HTTP 400
// with -32700. No Authorization -> 401 (handled by app.ts, before this).

import { viewerLogin } from './scenario.ts';
import {
  fixedNowIso,
  type Issue,
  type PullRequest,
  type Repo,
  type Store,
} from './store.ts';

export const MCP_SERVER_NAME = 'makefun-git-forge';
export const MCP_SERVER_VERSION = '1.0.0';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The name of the repository.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function findTool(name: string): ToolDef | null {
  const wanted = normalizeName(name);
  for (const tool of TOOLS) {
    const candidate = normalizeName(tool.name);
    if (candidate === wanted || wanted.endsWith(candidate)) return tool;
  }
  return null;
}

// -- serialisers (the same shapes REST returns) -----------------------------

function repoObject(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: Buffer.from(`Repository:${repo.id}`, 'utf8').toString('base64'),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: 1000, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://github.example/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: fixedNowIso(),
    updated_at: fixedNowIso(),
    pushed_at: fixedNowIso(),
    has_issues: true,
  };
}

function issueObject(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: Buffer.from(`Issue:${repo.id}:${issue.number}`, 'utf8').toString('base64'),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name, color: '000000' })),
    user: { login: repo.owner, id: 1000, type: 'User' },
    created_at: fixedNowIso(),
    updated_at: fixedNowIso(),
    html_url: `https://github.example/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    comments: (repo.comments.get(issue.number) ?? []).length,
  };
}

function pullObject(store: Store, repo: Repo, pull: PullRequest): Record<string, unknown> {
  const headSha = store.branchTip(repo, pull.headRef) ?? pull.headShaAtCreate;
  const baseSha = store.branchTip(repo, pull.baseRef) ?? pull.baseShaAtCreate;
  return {
    id: pull.id,
    node_id: Buffer.from(`PullRequest:${repo.id}:${pull.number}`, 'utf8').toString('base64'),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseSha, label: `${repo.owner}:${pull.baseRef}` },
    user: { login: repo.owner, id: 1000, type: 'User' },
    created_at: fixedNowIso(),
    updated_at: fixedNowIso(),
    html_url: `https://github.example/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    mergeable: !pull.merged && !store.mergeConflict(repo, pull),
  };
}

// -- tool execution ----------------------------------------------------------

type ToolResult = { ok: true; value: unknown } | { ok: false; message: string };

function executeTool(store: Store, name: string, args: Record<string, unknown>): ToolResult {
  switch (name) {
    case 'create_repo': {
      const repoName = String(args.name ?? '');
      if (store.getRepo(viewerLogin(), repoName) !== null) {
        return { ok: false, message: 'Repository already exists' };
      }
      const repo = store.createRepo(
        viewerLogin(),
        repoName,
        typeof args.description === 'string' ? args.description : '',
        args.private === true,
      );
      return { ok: true, value: repoObject(repo) };
    }
    case 'get_repo': {
      const repo = store.getRepo(String(args.owner ?? ''), String(args.repo ?? ''));
      if (repo === null) return { ok: false, message: 'Not Found' };
      return { ok: true, value: repoObject(repo) };
    }
    case 'create_issue': {
      const repo = store.getRepo(String(args.owner ?? ''), String(args.repo ?? ''));
      if (repo === null) return { ok: false, message: 'Not Found' };
      repo.issueSeq += 1;
      store.issueIdSeq += 1;
      const issue: Issue = {
        id: store.issueIdSeq,
        number: repo.issueSeq,
        title: String(args.title ?? ''),
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        labels: [],
        seq: repo.issueSeq,
      };
      repo.issues.push(issue);
      return { ok: true, value: issueObject(repo, issue) };
    }
    case 'list_issues': {
      const repo = store.getRepo(String(args.owner ?? ''), String(args.repo ?? ''));
      if (repo === null) return { ok: false, message: 'Not Found' };
      const state = typeof args.state === 'string' ? args.state.toLowerCase() : 'open';
      const issues = repo.issues
        .filter((i) => state === 'all' || i.state === state)
        .sort((a, b) => b.number - a.number)
        .map((i) => issueObject(repo, i));
      return { ok: true, value: { issues } };
    }
    case 'create_pull_request': {
      const repo = store.getRepo(String(args.owner ?? ''), String(args.repo ?? ''));
      if (repo === null) return { ok: false, message: 'Not Found' };
      const headRef = String(args.head ?? '');
      const baseRef = String(args.base ?? '');
      const headTip = store.branchTip(repo, headRef);
      const baseTip = store.branchTip(repo, baseRef);
      if (headTip === null || baseTip === null) {
        return { ok: false, message: 'head or base branch not found' };
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
        title: String(args.title ?? ''),
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        headRef,
        baseRef,
        headShaAtCreate: headTip,
        baseShaAtCreate: baseTip,
        files,
        seq: repo.pullSeq,
      };
      repo.pulls.push(pull);
      return { ok: true, value: pullObject(store, repo, pull) };
    }
    case 'merge_pull_request': {
      const repo = store.getRepo(String(args.owner ?? ''), String(args.repo ?? ''));
      if (repo === null) return { ok: false, message: 'Not Found' };
      const number = Number(args.pull_number);
      const pull = repo.pulls.find((p) => p.number === number);
      if (pull === undefined) return { ok: false, message: 'Not Found' };
      if (pull.merged) {
        return { ok: true, value: { merged: true, sha: pull.mergeCommitSha, message: 'already merged' } };
      }
      const result = store.squashMerge(repo, pull);
      if (result.conflict) return { ok: false, message: 'Merge conflict' };
      store.setRef(repo, store.refForBranch(repo, pull.baseRef), result.commitOid);
      pull.merged = true;
      pull.state = 'closed';
      pull.mergedAt = fixedNowIso();
      pull.mergeCommitSha = result.commitOid;
      return {
        ok: true,
        value: { merged: true, sha: result.commitOid, message: `${pull.title} (#${pull.number})`, number: pull.number, state: 'closed' },
      };
    }
    default:
      return { ok: false, message: `Unknown tool: ${name}` };
  }
}

// -- JSON-RPC ----------------------------------------------------------------

export interface McpResponse {
  status: number;
  body: unknown | null;
}

function rpcResult(id: unknown, result: unknown): McpResponse {
  return { status: 200, body: { jsonrpc: '2.0', id: id ?? null, result } };
}

function rpcError(id: unknown, code: number, message: string, status = 200): McpResponse {
  return { status, body: { jsonrpc: '2.0', id: id ?? null, error: { code, message } } };
}

/**
 * Handle one POST /mcp request body. Auth is checked by the caller.
 * Returns the HTTP status and the JSON body (null for a 202 notification).
 */
export function handleMcp(store: Store, body: Buffer): McpResponse {
  let request: Record<string, unknown>;
  try {
    request = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
  } catch {
    return rpcError(null, -32700, 'Parse error', 400);
  }
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    return rpcError(null, -32700, 'Parse error', 400);
  }
  const method = typeof request.method === 'string' ? request.method : '';
  const id = request.id ?? null;
  const params = (request.params ?? {}) as Record<string, unknown>;

  // Notifications carry no id and get an empty 202.
  if (id === null && method.startsWith('notifications/')) {
    return { status: 202, body: null };
  }

  if (method === 'server/discover') {
    return rpcResult(id, {
      protocolVersion: '2026-07-28',
      supportedVersions: ['2026-07-28'],
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
      _meta: {
        'io.modelcontextprotocol/serverInfo': { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
      },
    });
  }

  if (method === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const protocolVersion = /^\d{4}-\d{2}-\d{2}$/.test(offered) ? offered : '2025-11-25';
    return rpcResult(id, {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    });
  }

  if (method.startsWith('notifications/')) {
    return { status: 202, body: null };
  }

  if (method === 'tools/list') {
    return rpcResult(id, { tools: TOOLS });
  }

  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const tool = findTool(name);
    if (tool === null) {
      return rpcError(id, -32602, `Unknown tool: ${name}`);
    }
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const missing = tool.inputSchema.required.filter((key) => args[key] === undefined || args[key] === null);
    if (missing.length > 0) {
      return rpcResult(id, {
        content: [{ type: 'text', text: `Missing required argument: ${missing.join(', ')}` }],
        isError: true,
      });
    }
    const result = executeTool(store, tool.name, args);
    if (!result.ok) {
      return rpcResult(id, {
        content: [{ type: 'text', text: result.message }],
        isError: true,
      });
    }
    const text = JSON.stringify(result.value);
    return rpcResult(id, {
      content: [{ type: 'text', text }],
      structuredContent: result.value,
    });
  }

  return rpcError(id, -32601, `Method not found: ${method}`);
}
