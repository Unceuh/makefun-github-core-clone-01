// graphql.ts — the GitHub GraphQL v4 surface the suite exercises.
//
// Only the documents gh and github-mcp-server send are in scope (see
// spec-graphql.md §4 for the 18 verbatim documents): viewer, repository
// (fields, issue, issues with CREATED_AT DESC ordering and cursor
// pagination, pullRequests, pullRequest with files), node with inline
// fragments, __type introspection (Issue / PullRequest / Repository fields,
// SearchType enum values), and the five mutations (createIssue,
// closeIssue, createPullRequest, mergePullRequest, addComment). A request
// body may also be a JSON array of operation documents; the answer is
// then an array of results in the same order.
//
// This is a small recursive-descent parser plus a resolver over the
// store — no external GraphQL library exists in the trial, and the
// documents are a fixed, simple subset (named operations, variables,
// aliases, inline fragments, enum/object/list argument values).
// Unknown fields are errors (HTTP 200 with an errors array naming the
// field), exactly as the invalid-field check expects.

import { viewerLogin } from './scenario.ts';
import {
  fixedNowIso,
  type Issue,
  type PullRequest,
  type Repo,
  type Store,
} from './store.ts';

// -- global ids ------------------------------------------------------------

/** Opaque, stable ids: base64 of "Kind:repoId:number" (never the bare number). */
export function nodeId(kind: string, repoId: number, number: number): string {
  return Buffer.from(`${kind}:${repoId}:${number}`, 'utf8').toString('base64');
}

export function repoNodeId(repoId: number): string {
  return Buffer.from(`Repository:${repoId}`, 'utf8').toString('base64');
}

export function commentNodeId(repoId: number, commentId: number): string {
  return Buffer.from(`IssueComment:${repoId}:${commentId}`, 'utf8').toString('base64');
}

interface DecodedId {
  kind: string;
  repoId: number;
  number: number;
}

export function decodeNodeId(id: string): DecodedId | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const parts = text.split(':');
    if (parts.length < 2) return null;
    const kind = parts[0] as string;
    const repoId = Number.parseInt(parts[1] as string, 10);
    if (Number.isNaN(repoId)) return null;
    const number = parts.length >= 3 ? Number.parseInt(parts[2] as string, 10) : 0;
    return { kind, repoId, number: Number.isNaN(number) ? 0 : number };
  } catch {
    return null;
  }
}

export function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

export function cursorNumber(cursor: string | null | undefined): number | null {
  if (cursor === null || cursor === undefined) return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const n = Number.parseInt(text.slice(7), 10);
    return Number.isNaN(n) ? null : n;
  } catch {
    return null;
  }
}

// -- schema (fields per type, for validation and introspection) ------------

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef',
    'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest',
  ],
  Issue: ['id', 'number', 'title', 'state', 'body'],
  PullRequest: ['id', 'number', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files'],
  IssueConnection: ['nodes', 'pageInfo'],
  PullRequestConnection: ['nodes', 'pageInfo'],
  PullRequestChangedFileConnection: ['nodes'],
  PullRequestChangedFile: ['path'],
  PageInfo: ['hasNextPage', 'endCursor'],
  Ref: ['name'],
  __Type: ['name', 'kind', 'fields', 'enumValues'],
  __Field: ['name'],
  __EnumValue: ['name'],
  Node: ['id'],
  CreateIssuePayload: ['issue'],
  CloseIssuePayload: ['issue'],
  CreatePullRequestPayload: ['pullRequest'],
  MergePullRequestPayload: ['pullRequest'],
  AddCommentPayload: ['commentEdge', 'subject'],
  IssueCommentEdge: ['node'],
  IssueComment: ['id', 'body'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['COMMIT', 'DISCUSSION', 'ISSUE', 'MARKETPLACE', 'REPOSITORY', 'USER'],
};

// -- parser ----------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

interface FieldSelection {
  kind: 'field';
  alias: string | null;
  name: string;
  args: { name: string; value: ValueNode }[];
  selections: Selection[];
}

interface InlineFragmentSelection {
  kind: 'inline';
  typeCondition: string | null;
  selections: Selection[];
}

interface FragmentSelection {
  kind: 'fragment';
  name: string;
}

type Selection = FieldSelection | InlineFragmentSelection | FragmentSelection;

interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  variables: { name: string }[];
  selections: Selection[];
}

interface Document {
  operations: Operation[];
  fragments: Map<string, { typeCondition: string | null; selections: Selection[] }>;
}

type Token =
  | { type: 'name'; value: string }
  | { type: 'int'; value: string }
  | { type: 'float'; value: string }
  | { type: 'string'; value: string }
  | { type: 'punct'; value: string }
  | { type: 'eof' };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ type: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@&|'.includes(ch)) {
      tokens.push({ type: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1] as string;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += source[j] as string;
          j += 1;
        }
      }
      tokens.push({ type: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < source.length && /[0-9.]/.test(source[j] as string)) j += 1;
      const text = source.slice(i, j);
      tokens.push(text.includes('.') ? { type: 'float', value: text } : { type: 'int', value: text });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j] as string)) j += 1;
      tokens.push({ type: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  tokens.push({ type: 'eof' });
  return tokens;
}

class Parser {
  #tokens: Token[];
  #pos = 0;

  constructor(source: string) {
    this.#tokens = tokenize(source);
  }

  #peek(): Token {
    return this.#tokens[this.#pos] as Token;
  }

  #next(): Token {
    const token = this.#tokens[this.#pos] as Token;
    this.#pos += 1;
    return token;
  }

  #expectPunct(value: string): void {
    const token = this.#next();
    if (token.type !== 'punct' || token.value !== value) {
      throw new Error(`expected ${value} in GraphQL document`);
    }
  }

  #expectName(): string {
    const token = this.#next();
    if (token.type !== 'name') throw new Error('expected a name in GraphQL document');
    return token.value;
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, { typeCondition: string | null; selections: Selection[] }>();
    while (this.#peek().type !== 'eof') {
      const token = this.#peek();
      if (token.type === 'punct' && token.value === '{') {
        operations.push({ type: 'query', name: null, variables: [], selections: this.#parseSelections() });
        continue;
      }
      if (token.type === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        this.#next();
        const type = token.value as 'query' | 'mutation';
        let name: string | null = null;
        const next = this.#peek();
        if (next.type === 'name') name = this.#next().value as string;
        const variables: { name: string }[] = [];
        if (this.#peek().type === 'punct' && (this.#peek() as { value: string }).value === '(') {
          this.#next();
          while (!(this.#peek().type === 'punct' && (this.#peek() as { value: string }).value === ')')) {
            if (this.#peek().type === 'punct' && (this.#peek() as { value: string }).value === '$') {
              this.#next();
              variables.push({ name: this.#expectName() });
            }
            // Skip the variable type (and any default value) up to the
            // next '$' or the closing paren.
            let depth = 0;
            while (true) {
              const t = this.#peek();
              if (t.type === 'eof') break;
              if (depth === 0 && t.type === 'punct' && (t.value === ')' || t.value === '$')) break;
              if (t.type === 'punct' && (t.value === '[' || t.value === '(' || t.value === '{')) depth += 1;
              if (t.type === 'punct' && (t.value === ']' || t.value === ')' || t.value === '}')) {
                if (depth === 0) break;
                depth -= 1;
              }
              this.#next();
            }
          }
          this.#expectPunct(')');
        }
        operations.push({ type, name, variables, selections: this.#parseSelections() });
        continue;
      }
      if (token.type === 'name' && token.value === 'fragment') {
        this.#next();
        const name = this.#expectName();
        let typeCondition: string | null = null;
        if (this.#peek().type === 'name' && (this.#peek() as { value: string }).value === 'on') {
          this.#next();
          typeCondition = this.#expectName();
        }
        fragments.set(name, { typeCondition, selections: this.#parseSelections() });
        continue;
      }
      throw new Error(`unexpected token in GraphQL document: ${JSON.stringify(token)}`);
    }
    return { operations, fragments };
  }

  #parseSelections(): Selection[] {
    this.#expectPunct('{');
    const selections: Selection[] = [];
    while (!(this.#peek().type === 'punct' && (this.#peek() as { value: string }).value === '}')) {
      if (this.#peek().type === 'eof') throw new Error('unterminated selection set');
      selections.push(this.#parseSelection());
    }
    this.#expectPunct('}');
    return selections;
  }

  #parseSelection(): Selection {
    const token = this.#peek();
    if (token.type === 'punct' && token.value === '...') {
      this.#next();
      const next = this.#peek();
      if (next.type === 'name' && next.value === 'on') {
        this.#next();
        const typeCondition = this.#expectName();
        return { kind: 'inline', typeCondition, selections: this.#parseSelections() };
      }
      if (next.type === 'name') {
        return { kind: 'fragment', name: this.#next().value as string };
      }
      return { kind: 'inline', typeCondition: null, selections: this.#parseSelections() };
    }
    if (token.type !== 'name') throw new Error('expected a field name in GraphQL document');
    let name = this.#next().value as string;
    let alias: string | null = null;
    if (this.#peek().type === 'punct' && (this.#peek() as { value: string }).value === ':') {
      this.#next();
      alias = name;
      name = this.#expectName();
    }
    const args: { name: string; value: ValueNode }[] = [];
    if (this.#peek().type === 'punct' && (this.#peek() as { value: string }).value === '(') {
      this.#next();
      while (!(this.#peek().type === 'punct' && (this.#peek() as { value: string }).value === ')')) {
        const argName = this.#expectName();
        this.#expectPunct(':');
        args.push({ name: argName, value: this.#parseValue() });
      }
      this.#expectPunct(')');
    }
    // Directives (none of the suite's documents use any) are skipped.
    while (this.#peek().type === 'punct' && (this.#peek() as { value: string }).value === '@') {
      this.#next();
      this.#expectName();
      if (this.#peek().type === 'punct' && (this.#peek() as { value: string }).value === '(') {
        this.#next();
        let depth = 1;
        while (depth > 0) {
          const t = this.#next();
          if (t.type === 'punct' && t.value === '(') depth += 1;
          if (t.type === 'punct' && t.value === ')') depth -= 1;
        }
      }
    }
    let selections: Selection[] = [];
    if (this.#peek().type === 'punct' && (this.#peek() as { value: string }).value === '{') {
      selections = this.#parseSelections();
    }
    return { kind: 'field', alias, name, args, selections };
  }

  #parseValue(): ValueNode {
    const token = this.#next();
    if (token.type === 'punct' && token.value === '$') {
      return { kind: 'variable', name: this.#expectName() };
    }
    if (token.type === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.#peek().type === 'punct' && (this.#peek() as { value: string }).value === ']')) {
        values.push(this.#parseValue());
      }
      this.#expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.type === 'punct' && token.value === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (!(this.#peek().type === 'punct' && (this.#peek() as { value: string }).value === '}')) {
        const name = this.#expectName();
        this.#expectPunct(':');
        fields.push({ name, value: this.#parseValue() });
      }
      this.#expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.type === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.type === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.type === 'string') return { kind: 'string', value: token.value };
    if (token.type === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error('unexpected value in GraphQL document');
  }
}

// -- execution ---------------------------------------------------------------

export interface GraphQLContext {
  store: Store;
  errors: { message: string }[];
}

type Resolver = (parent: NodeValue, args: Record<string, unknown>, ctx: GraphQLContext) => unknown;

interface NodeValue {
  __typename: string;
  [key: string]: unknown;
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name] ?? null;
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((v) => resolveValue(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function repoNode(repo: Repo): NodeValue {
  return { __typename: 'Repository', repo };
}

function issueNode(repo: Repo, issue: Issue): NodeValue {
  return { __typename: 'Issue', repo, issue };
}

function pullNode(repo: Repo, pull: PullRequest): NodeValue {
  return { __typename: 'PullRequest', repo, pull };
}

function findRepoById(store: Store, repoId: number): Repo | null {
  for (const repo of store.repos.values()) {
    if (repo.id === repoId) return repo;
  }
  return null;
}

function nodeForId(store: Store, id: string): NodeValue | null {
  const decoded = decodeNodeId(id);
  if (decoded === null) return null;
  const repo = findRepoById(store, decoded.repoId);
  if (repo === null) return null;
  if (decoded.kind === 'Repository') return repoNode(repo);
  if (decoded.kind === 'Issue') {
    const issue = repo.issues.find((i) => i.number === decoded.number);
    return issue === undefined ? null : issueNode(repo, issue);
  }
  if (decoded.kind === 'PullRequest') {
    const pull = repo.pulls.find((p) => p.number === decoded.number);
    return pull === undefined ? null : pullNode(repo, pull);
  }
  return null;
}

function paginate<T extends { number: number }>(
  items: T[],
  args: Record<string, unknown>,
  descending: boolean,
): { nodes: T[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } {
  const sorted = [...items].sort((a, b) => (descending ? b.number - a.number : a.number - b.number));
  const after = cursorNumber(typeof args.after === 'string' ? args.after : null);
  let start = 0;
  if (after !== null) {
    const idx = sorted.findIndex((item) => item.number === after);
    start = idx === -1 ? 0 : idx + 1;
  }
  const first = typeof args.first === 'number' ? args.first : sorted.length;
  const page = sorted.slice(start, start + first);
  const hasNextPage = start + page.length < sorted.length;
  const endCursor = page.length > 0 ? cursorFor((page[page.length - 1] as T).number) : null;
  return { nodes: page, pageInfo: { hasNextPage, endCursor } };
}

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => ({ __typename: 'User', login: viewerLogin() }),
    repository: (_parent, args, ctx) => {
      const repo = ctx.store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
      return repo === null ? null : repoNode(repo);
    },
    node: (_parent, args, ctx) => nodeForId(ctx.store, String(args.id ?? '')),
    __type: (_parent, args) => {
      const name = String(args.name ?? '');
      if (name === 'SearchType') {
        return {
          __typename: '__Type',
          name,
          kind: 'ENUM',
          fields: null,
          enumValues: ENUM_VALUES.SearchType?.map((v) => ({ __typename: '__EnumValue', name: v })) ?? null,
        };
      }
      const fields = TYPE_FIELDS[name];
      if (fields === undefined) return null;
      return {
        __typename: '__Type',
        name,
        kind: 'OBJECT',
        fields: fields.map((f) => ({ __typename: '__Field', name: f })),
        enumValues: null,
      };
    },
  },
  Mutation: {
    createIssue: (_parent, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeNodeId(String(input.repositoryId ?? ''));
      if (decoded === null) return { __typename: 'CreateIssuePayload', issue: null };
      const repo = findRepoById(ctx.store, decoded.repoId);
      if (repo === null) return { __typename: 'CreateIssuePayload', issue: null };
      repo.issueSeq += 1;
      ctx.store.issueIdSeq += 1;
      const issue: Issue = {
        id: ctx.store.issueIdSeq,
        number: repo.issueSeq,
        title: String(input.title ?? ''),
        body: typeof input.body === 'string' ? input.body : '',
        state: 'open',
        labels: Array.isArray(input.labels) ? (input.labels as string[]) : [],
        seq: repo.issueSeq,
      };
      repo.issues.push(issue);
      return { __typename: 'CreateIssuePayload', issue: issueNode(repo, issue) };
    },
    closeIssue: (_parent, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const node = nodeForId(ctx.store, String(input.issueId ?? ''));
      if (node === null || node.__typename !== 'Issue') return { __typename: 'CloseIssuePayload', issue: null };
      const issue = node.issue as Issue;
      issue.state = 'closed';
      return { __typename: 'CloseIssuePayload', issue: node };
    },
    createPullRequest: (_parent, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeNodeId(String(input.repositoryId ?? ''));
      if (decoded === null) return { __typename: 'CreatePullRequestPayload', pullRequest: null };
      const repo = findRepoById(ctx.store, decoded.repoId);
      if (repo === null) return { __typename: 'CreatePullRequestPayload', pullRequest: null };
      const headRef = String(input.headRefName ?? '');
      const baseRef = String(input.baseRefName ?? '');
      const headTip = ctx.store.branchTip(repo, headRef);
      const baseTip = ctx.store.branchTip(repo, baseRef);
      if (headTip === null || baseTip === null) {
        return { __typename: 'CreatePullRequestPayload', pullRequest: null };
      }
      repo.pullSeq += 1;
      ctx.store.pullIdSeq += 1;
      const headCommit = ctx.store.getCommit(repo, headTip);
      const baseCommitObj = ctx.store.getCommit(repo, baseTip);
      const files = headCommit !== null && baseCommitObj !== null
        ? ctx.store.diffTrees(repo, baseCommitObj.tree, headCommit.tree)
        : [];
      const pull: PullRequest = {
        id: ctx.store.pullIdSeq,
        number: repo.pullSeq,
        title: String(input.title ?? ''),
        body: typeof input.body === 'string' ? input.body : '',
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
      return { __typename: 'CreatePullRequestPayload', pullRequest: pullNode(repo, pull) };
    },
    mergePullRequest: (_parent, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const node = nodeForId(ctx.store, String(input.pullRequestId ?? ''));
      if (node === null || node.__typename !== 'PullRequest') {
        return { __typename: 'MergePullRequestPayload', pullRequest: null };
      }
      const repo = node.repo as Repo;
      const pull = node.pull as PullRequest;
      if (!pull.merged) {
        const result = ctx.store.squashMerge(repo, pull);
        if (!result.conflict) {
          ctx.store.setRef(repo, ctx.store.refForBranch(repo, pull.baseRef), result.commitOid);
          pull.merged = true;
          pull.state = 'closed';
          pull.mergedAt = fixedNowIso();
          pull.mergeCommitSha = result.commitOid;
        }
      }
      return { __typename: 'MergePullRequestPayload', pullRequest: node };
    },
    addComment: (_parent, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const node = nodeForId(ctx.store, String(input.subjectId ?? ''));
      if (node === null || node.__typename !== 'Issue') {
        return { __typename: 'AddCommentPayload', commentEdge: null, subject: null };
      }
      const repo = node.repo as Repo;
      const issue = node.issue as Issue;
      repo.commentSeq += 1;
      ctx.store.commentIdSeq += 1;
      const comment = { id: ctx.store.commentIdSeq, body: String(input.body ?? '') };
      const list = repo.comments.get(issue.number) ?? [];
      list.push(comment);
      repo.comments.set(issue.number, list);
      return {
        __typename: 'AddCommentPayload',
        commentEdge: {
          __typename: 'IssueCommentEdge',
          node: { __typename: 'IssueComment', id: commentNodeId(repo.id, comment.id), body: comment.body },
        },
        subject: node,
      };
    },
  },
  User: {
    login: (parent) => String(parent.login ?? ''),
  },
  Repository: {
    id: (parent) => repoNodeId((parent.repo as Repo).id),
    databaseId: (parent) => (parent.repo as Repo).id,
    name: (parent) => (parent.repo as Repo).name,
    nameWithOwner: (parent) => {
      const repo = parent.repo as Repo;
      return `${repo.owner}/${repo.name}`;
    },
    owner: (parent) => ({ __typename: 'User', login: (parent.repo as Repo).owner }),
    defaultBranchRef: (parent, _args, ctx) => {
      const repo = parent.repo as Repo;
      if (ctx.store.branchTip(repo, repo.defaultBranch) === null) return null;
      return { __typename: 'Ref', name: repo.defaultBranch };
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    issue: (parent, args) => {
      const repo = parent.repo as Repo;
      const issue = repo.issues.find((i) => i.number === args.number);
      return issue === undefined ? null : issueNode(repo, issue);
    },
    issues: (parent, args) => {
      const repo = parent.repo as Repo;
      let items = [...repo.issues];
      if (Array.isArray(args.states) && args.states.length > 0) {
        const wanted = new Set((args.states as string[]).map((s) => s.toLowerCase()));
        items = items.filter((i) => wanted.has(i.state));
      }
      let descending = true;
      const orderBy = args.orderBy as Record<string, unknown> | undefined;
      if (orderBy !== undefined) {
        const direction = String(orderBy.direction ?? 'DESC').toUpperCase();
        descending = direction !== 'ASC';
      }
      const page = paginate(items, args, descending);
      return {
        __typename: 'IssueConnection',
        nodes: page.nodes.map((i) => issueNode(repo, i)),
        pageInfo: { __typename: 'PageInfo', ...page.pageInfo },
      };
    },
    pullRequests: (parent, args) => {
      const repo = parent.repo as Repo;
      const page = paginate([...repo.pulls], args, true);
      return {
        __typename: 'PullRequestConnection',
        nodes: page.nodes.map((p) => pullNode(repo, p)),
        pageInfo: { __typename: 'PageInfo', ...page.pageInfo },
      };
    },
    pullRequest: (parent, args) => {
      const repo = parent.repo as Repo;
      const pull = repo.pulls.find((p) => p.number === args.number);
      return pull === undefined ? null : pullNode(repo, pull);
    },
  },
  Issue: {
    id: (parent) => nodeId('Issue', (parent.repo as Repo).id, (parent.issue as Issue).number),
    number: (parent) => (parent.issue as Issue).number,
    title: (parent) => (parent.issue as Issue).title,
    state: (parent) => ((parent.issue as Issue).state === 'open' ? 'OPEN' : 'CLOSED'),
    body: (parent) => (parent.issue as Issue).body,
  },
  PullRequest: {
    id: (parent) => nodeId('PullRequest', (parent.repo as Repo).id, (parent.pull as PullRequest).number),
    number: (parent) => (parent.pull as PullRequest).number,
    state: (parent) => ((parent.pull as PullRequest).state === 'open' ? 'OPEN' : 'CLOSED'),
    merged: (parent) => (parent.pull as PullRequest).merged,
    headRefName: (parent) => (parent.pull as PullRequest).headRef,
    baseRefName: (parent) => (parent.pull as PullRequest).baseRef,
    mergeable: (parent, _args, ctx) => {
      const repo = parent.repo as Repo;
      const pull = parent.pull as PullRequest;
      if (pull.merged) return 'UNKNOWN';
      return ctx.store.mergeConflict(repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
    },
    files: (parent, args) => {
      const pull = parent.pull as PullRequest;
      const first = typeof args.first === 'number' ? args.first : pull.files.length;
      return {
        __typename: 'PullRequestChangedFileConnection',
        nodes: pull.files.slice(0, first).map((f) => ({ __typename: 'PullRequestChangedFile', path: f.path })),
      };
    },
  },
  IssueConnection: {
    nodes: (parent) => parent.nodes as unknown[],
    pageInfo: (parent) => parent.pageInfo as NodeValue,
  },
  PullRequestConnection: {
    nodes: (parent) => parent.nodes as unknown[],
    pageInfo: (parent) => parent.pageInfo as NodeValue,
  },
  PullRequestChangedFileConnection: {
    nodes: (parent) => parent.nodes as unknown[],
  },
  PullRequestChangedFile: {
    path: (parent) => String(parent.path ?? ''),
  },
  PageInfo: {
    hasNextPage: (parent) => Boolean((parent as { hasNextPage: boolean }).hasNextPage),
    endCursor: (parent) => (parent as { endCursor: string | null }).endCursor,
  },
  Ref: {
    name: (parent) => String(parent.name ?? ''),
  },
  __Type: {
    name: (parent) => String(parent.name ?? ''),
    kind: (parent) => String(parent.kind ?? ''),
    fields: (parent) => (parent.fields as NodeValue[] | null) ?? null,
    enumValues: (parent) => (parent.enumValues as NodeValue[] | null) ?? null,
  },
  __Field: {
    name: (parent) => String(parent.name ?? ''),
  },
  __EnumValue: {
    name: (parent) => String(parent.name ?? ''),
  },
  CreateIssuePayload: {
    issue: (parent) => parent.issue as NodeValue | null,
  },
  CloseIssuePayload: {
    issue: (parent) => parent.issue as NodeValue | null,
  },
  CreatePullRequestPayload: {
    pullRequest: (parent) => parent.pullRequest as NodeValue | null,
  },
  MergePullRequestPayload: {
    pullRequest: (parent) => parent.pullRequest as NodeValue | null,
  },
  AddCommentPayload: {
    commentEdge: (parent) => parent.commentEdge as NodeValue | null,
    subject: (parent) => parent.subject as NodeValue | null,
  },
  IssueCommentEdge: {
    node: (parent) => parent.node as NodeValue,
  },
  IssueComment: {
    id: (parent) => String(parent.id ?? ''),
    body: (parent) => String(parent.body ?? ''),
  },
};

function resolveSelections(
  parent: NodeValue | null,
  parentType: string,
  selections: Selection[],
  variables: Record<string, unknown>,
  ctx: GraphQLContext,
  doc: Document,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (parent === null) return out;
  for (const selection of selections) {
    if (selection.kind === 'inline') {
      if (selection.typeCondition === null || selection.typeCondition === parent.__typename) {
        Object.assign(out, resolveSelections(parent, parentType, selection.selections, variables, ctx, doc));
      }
      continue;
    }
    if (selection.kind === 'fragment') {
      const fragment = doc.fragments.get(selection.name);
      if (fragment !== undefined && (fragment.typeCondition === null || fragment.typeCondition === parent.__typename)) {
        Object.assign(out, resolveSelections(parent, parentType, fragment.selections, variables, ctx, doc));
      }
      continue;
    }
    const responseKey = selection.alias ?? selection.name;
    if (selection.name === '__typename') {
      out[responseKey] = parent.__typename;
      continue;
    }
    const fields = TYPE_FIELDS[parentType];
    const resolver = RESOLVERS[parentType]?.[selection.name];
    if (fields === undefined || !fields.includes(selection.name) || resolver === undefined) {
      ctx.errors.push({ message: `Cannot query field "${selection.name}" on type "${parentType}".` });
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const arg of selection.args) args[arg.name] = resolveValue(arg.value, variables);
    let value: unknown;
    try {
      value = resolver(parent, args, ctx);
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
      out[responseKey] = null;
      continue;
    }
    out[responseKey] = resolveFieldValue(value, selection.selections, variables, ctx, doc);
  }
  return out;
}

function resolveFieldValue(
  value: unknown,
  selections: Selection[],
  variables: Record<string, unknown>,
  ctx: GraphQLContext,
  doc: Document,
): unknown {
  if (value === null || value === undefined) return null;
  if (selections.length === 0) return value;
  if (Array.isArray(value)) {
    return value.map((item) =>
      item !== null && typeof item === 'object' && '__typename' in item
        ? resolveSelections(item as NodeValue, (item as NodeValue).__typename, selections, variables, ctx, doc)
        : item,
    );
  }
  if (typeof value === 'object' && '__typename' in (value as Record<string, unknown>)) {
    const node = value as NodeValue;
    return resolveSelections(node, node.__typename, selections, variables, ctx, doc);
  }
  return value;
}

function executeOperation(
  store: Store,
  body: Record<string, unknown>,
): Record<string, unknown> {
  const ctx: GraphQLContext = { store, errors: [] };
  const query = typeof body.query === 'string' ? body.query : '';
  const variables = (body.variables ?? {}) as Record<string, unknown>;
  let doc: Document;
  try {
    doc = new Parser(query).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  const operationName = typeof body.operationName === 'string' ? body.operationName : null;
  let operation: Operation | undefined;
  if (operationName !== null) {
    operation = doc.operations.find((op) => op.name === operationName);
  }
  if (operation === undefined) operation = doc.operations[0];
  if (operation === undefined) {
    return { data: null, errors: [{ message: 'No operation provided.' }] };
  }
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const root: NodeValue = { __typename: rootType };
  const data = resolveSelections(root, rootType, operation.selections, variables, ctx, doc);
  if (ctx.errors.length > 0) return { data, errors: ctx.errors };
  return { data };
}

/**
 * Execute a GraphQL request body: one operation document, or an array of
 * them (batched — the answers come back in the same order).
 */
export function executeGraphQL(store: Store, body: unknown): unknown {
  if (Array.isArray(body)) {
    return body.map((item) =>
      item !== null && typeof item === 'object'
        ? executeOperation(store, item as Record<string, unknown>)
        : { data: null, errors: [{ message: 'Invalid GraphQL operation.' }] },
    );
  }
  if (body !== null && typeof body === 'object') {
    return executeOperation(store, body as Record<string, unknown>);
  }
  return { data: null, errors: [{ message: 'Invalid GraphQL request body.' }] };
}
