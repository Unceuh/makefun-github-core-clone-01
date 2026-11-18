# makefun-git-forge

A GitHub-compatible git forge in Node 22, standard library only, no
install step, no git binary, no network in the trial. It runs as
`node --experimental-strip-types main.ts` (see `main.ts` for the
entry <-> env lifecycle: listen on an ephemeral port, register it with
the env, poll `/done`).

## Layout

- `main.ts` — lifecycle only (as the starter ships it).
- `app.ts` — the HTTP server: REST v3 under `/api/v3`, GraphQL at
  `/api/graphql`, MCP at `/mcp`, git smart HTTP at
  `/<owner>/<repo>.git/`, plus `GET /healthz`.
- `store.ts` — the in-memory store: repositories, refs, git objects,
  issues, comments, labels and pull requests; the git object machinery
  (trees, commits, ancestry, merge-base, three-way merge).
- `gitproto.ts` — the git wire protocol by hand (pkt-lines, packfiles,
  protocol v2 `ls-refs`/`fetch`, v0 fetch, v0 receive-pack with
  per-ref fast-forward enforcement), on `node:zlib` + `node:crypto`.
- `graphql.ts` — a small GraphQL parser and executor for the documents
  the suite sends (viewer, repository, node, `__type` introspection,
  the five mutations).
- `mcp.ts` — MCP over streamable HTTP (revision 2026-07-28, with the
  2025-11-25 `initialize` handshake): six tools on the same store as
  REST.
- `scenario.ts` — the viewer's login, derived from the suite's one
  fixed seed, so a repository under another owner is 404, never 403.

## Notes

- Auth: when `MAKEFUN_SHOP_TOKEN` is set, every protected call needs
  a non-empty `Authorization: Bearer ...` header; a missing token is
  401.
- Determinism: every id and ordering comes from monotonic counters,
  and every stored timestamp is one fixed instant, so a replayed trial
  leaves the same state export.
- Local test: start the server, then
  `node --experimental-strip-types <kit>/sdk/run.ts --url
  http://127.0.0.1:PORT --token "$TOKEN" [--perf] [--json]`.
