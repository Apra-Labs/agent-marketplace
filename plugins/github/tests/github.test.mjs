// Tests for skills/github/scripts/github.mjs against a local fake GitHub (REST + GraphQL) and a fake
// log-storage redirect host, both on 127.0.0.1 only. No real GitHub is ever contacted.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  resolveIdentity, tokenKind, mintAppJwt, lintMarkdown, parseFaqIndex, appendToIndex, parsePatch, compactRanges,
  validateReviewComments, suggestionBody, parseDispatchInputs, validateDispatchInputs, extractStepLog, diagnoseApiError,
  diagnoseGraphqlErrors, parseArgs, titleSimilarity, unifiedDiff, EXIT,
} from '../skills/github/scripts/github.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, '..', 'skills', 'github', 'scripts', 'github.mjs');
const SENTINEL = 'ghp_SENTINELaaaaBBBBccccDDDDeeee0123456789';
const CLI_TOKEN = 'gho_CLITOKENxxxxYYYYzzzz0123456789abcd';
const INST_TOKEN = 'ghs_INSTTOKENqqqqRRRRssss0123456789abcd';
const HEAD = 'c'.repeat(40);
const LOGINS = { [SENTINEL]: 'octo-bot', [CLI_TOKEN]: 'cli-user' };
const { publicKey: PUB, privateKey: PRIV } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIV_PEM = PRIV.export({ type: 'pkcs1', format: 'pem' });
const DURL = (n, repo = 'acme/app') => `https://github.com/${repo}/discussions/${n}`;

// ---------------------------------------------------------------- fake data
const CATS = [
  { id: 'CAT_QA', name: 'Q&A', slug: 'q-a', isAnswerable: true, emoji: ':pray:', description: 'Ask' },
  { id: 'CAT_GEN', name: 'General', slug: 'general', isAnswerable: false, emoji: ':speech_balloon:', description: 'Chat' },
];
const INDEX_BODY = [
  'Welcome to the FAQ.',
  '',
  '---',
  '',
  '### Setup',
  '',
  `- [How do I install it?](${DURL(2)})`,
  `- [Old title](${DURL(3)})`,
  '',
  '### Usage',
  '',
  `- [Other repo](${DURL(9, 'acme/other')})`,
  `- [How do I install it?](${DURL(2)})`,
  `- [Gone](${DURL(99)})`,
  '',
].join('\n');
function disc(n, title, cat, extra = {}) {
  return {
    id: `D_${n}`, number: n, title, body: extra.body || `Body of ${n}`, url: DURL(n), category: CATS.find((c) => c.id === cat),
    isAnswered: !!extra.answered, answer: extra.answered ? { id: `DC_a${n}`, url: `${DURL(n)}#a`, author: { login: 'bob' } } : null,
    closed: false, locked: false, createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-02T00:00:00Z', author: { login: 'alice' },
    comments: extra.answered ? [{ id: `DC_a${n}`, url: `${DURL(n)}#a`, body: 'Run npm i.', isAnswer: true, createdAt: '2026-11-01T01:00:00Z', author: { login: 'bob' }, replies: [] }] : [],
  };
}
const THREADS = [
  { id: 'T1', isResolved: false, isOutdated: false, path: 'src/a.js', line: 3, startLine: null, diffSide: 'RIGHT', viewerCanResolve: true, viewerCanUnresolve: false, comments: [{ author: { login: 'rev' }, body: 'Please rename this variable', url: 'u1' }, { author: { login: 'dev' }, body: 'done' }] },
  { id: 'T2', isResolved: true, isOutdated: true, path: 'src/a.js', line: 22, startLine: 21, diffSide: 'RIGHT', viewerCanResolve: false, viewerCanUnresolve: true, comments: [{ author: { login: 'rev' }, body: 'nit', url: 'u2' }] },
  { id: 'T3', isResolved: false, isOutdated: false, path: 'src/new.js', line: 1, startLine: null, diffSide: 'RIGHT', viewerCanResolve: false, viewerCanUnresolve: false, comments: [{ author: { login: 'rev' }, body: 'Why?', url: 'u3' }] },
];
const PATCH_A = '@@ -1,4 +1,5 @@\n line1\n-old2\n+new2\n+new3\n line3\n line4\n@@ -20,3 +21,4 @@ function x() {\n ctx20\n+add22\n ctx21\n ctx22';
const FILES_P1 = [
  { filename: 'src/a.js', status: 'modified', patch: PATCH_A },
  { filename: 'src/new.js', status: 'added', patch: '@@ -0,0 +1,3 @@\n+a\n+b\n+c' },
];
const FILES_P2 = [{ filename: 'img.png', status: 'added' }];
const daysAgo = (d) => new Date(Date.now() - d * 86400000).toISOString();
const RUNS = [
  { id: 500, workflow_id: 1, name: 'CI', path: '.github/workflows/ci.yml', head_sha: HEAD, conclusion: 'success', created_at: '2026-11-16T09:00:00Z', run_attempt: 1, html_url: 'https://github.com/acme/app/actions/runs/500' },
  { id: 501, workflow_id: 1, name: 'CI', path: '.github/workflows/ci.yml', head_sha: HEAD, conclusion: 'failure', created_at: '2026-11-16T10:00:00Z', run_attempt: 1, html_url: 'https://github.com/acme/app/actions/runs/501' },
  { id: 502, workflow_id: 2, name: 'Lint', path: '.github/workflows/lint.yml', head_sha: HEAD, conclusion: 'success', created_at: '2026-11-16T10:00:00Z', run_attempt: 1 },
  { id: 499, workflow_id: 3, name: 'Docs', path: '.github/workflows/docs.yml', head_sha: HEAD, conclusion: 'failure', created_at: '2026-11-16T08:00:00Z', run_attempt: 1 },
  { id: 503, workflow_id: 3, name: 'Docs', path: '.github/workflows/docs.yml', head_sha: HEAD, conclusion: 'success', created_at: '2026-11-16T11:00:00Z', run_attempt: 1 },
];
const JOBS_501 = [
  {
    id: 601, name: 'build', conclusion: 'failure', html_url: 'https://github.com/acme/app/actions/runs/501/job/601',
    steps: [
      { number: 1, name: 'Set up job', conclusion: 'success', started_at: '2026-11-16T10:00:58Z', completed_at: '2026-11-16T10:00:59Z' },
      { number: 2, name: 'Run npm test', conclusion: 'failure', started_at: '2026-11-16T10:01:00Z', completed_at: '2026-11-16T10:01:05Z' },
    ],
  },
  { id: 602, name: 'lint', conclusion: 'success', steps: [] },
];
const JOB_LOG = [
  '2026-11-16T10:00:58.1234567Z ##[group]Runner Image',
  '2026-11-16T10:00:58.2234567Z setup line ok',
  '2026-11-16T10:00:59.0000000Z ##[endgroup]',
  '2026-11-16T10:01:00.1000000Z ##[group]Run npm test',
  '2026-11-16T10:01:00.2000000Z npm test',
  '2026-11-16T10:01:00.3000000Z ##[endgroup]',
  ...Array.from({ length: 70 }, (_, i) => `2026-11-16T10:01:01.${String(i).padStart(7, '0')}Z test line ${i}`),
  '2026-11-16T10:01:03.0000000Z Error: expected 1 to equal 2',
  '2026-11-16T10:01:03.1000000Z Error: expected 1 to equal 2',
  '2026-11-16T10:01:04.0000000Z ##[error]Process completed with exit code 1.',
  '2026-11-16T10:01:10.0000000Z Post job cleanup.',
  '2026-11-16T10:01:10.1000000Z cleanup error ignored? no',
  '',
].join('\n');
const WORKFLOW_YAML = `name: Deploy
on:
  push:
    branches: [main]
  workflow_dispatch:
    inputs:
      environment:
        description: Target env
        type: choice
        required: true
        options:
          - staging
          - production # prod
      dry_run:
        type: boolean
        default: false
      replicas:
        type: number
        required: false
      note:
        description: |
          Free text
          note: with colon
        required: true
        default: "n/a"
jobs:
  deploy:
    runs-on: ubuntu-latest
`;

// ---------------------------------------------------------------- fake servers
let state;
const allLogs = [];
const outputs = [];
function fresh() {
  return {
    log: [], gql: [], storageLog: [], force: null, failMarkOnce: false, rateOnce: false, jwtChecks: [],
    discussions: {
      1: disc(1, 'FAQ', 'CAT_GEN', { body: INDEX_BODY }),
      2: disc(2, 'How do I install it?', 'CAT_QA', { answered: true }),
      3: disc(3, 'Renamed title', 'CAT_QA'),
      4: disc(4, 'General chat', 'CAT_GEN'),
      5: disc(5, 'Troubleshooting crashes', 'CAT_QA'),
    },
    nextComment: 1, threads: JSON.parse(JSON.stringify(THREADS)),
  };
}
function resetState() {
  if (state) allLogs.push(...state.log, ...state.storageLog);
  state = fresh();
}
resetState();

let BASE;
let STORAGE;
function send(res, status, obj, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(obj === undefined ? '' : typeof obj === 'string' ? obj : JSON.stringify(obj));
}
function verifyJwt(jwt) {
  const [h, p, s] = String(jwt).split('.');
  const ok = crypto.createVerify('RSA-SHA256').update(`${h}.${p}`).verify(PUB, Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
  return { ok, header: JSON.parse(Buffer.from(h, 'base64url').toString()), payload: JSON.parse(Buffer.from(p, 'base64url').toString()) };
}
const commentsOf = (d) => ({ totalCount: d.comments.length, nodes: d.comments.map((c) => ({ ...c, replies: { totalCount: c.replies.length, nodes: c.replies } })) });

function graphql(req, res, body, token) {
  const { query, variables: v = {} } = JSON.parse(body);
  const m = /^\s*(query|mutation)\s+(\w+)/.exec(query);
  const op = m ? m[2] : '?';
  state.gql.push({ op, mutation: m && m[1] === 'mutation', variables: v, at: Date.now(), token });
  const D = state.discussions;
  const ok = (data) => send(res, 200, { data });
  const nf = (data, what) => send(res, 200, { data, errors: [{ type: 'NOT_FOUND', message: `Could not resolve to ${what}` }] });
  const isUserRepo = v.owner === 'someuser';
  switch (op) {
    case 'RepoCategories': return ok({ repository: { id: 'R_app', nameWithOwner: `${v.owner}/${v.name}`, discussionCategories: { nodes: CATS } } });
    case 'ListDiscussions': {
      let list = Object.values(D);
      if (v.categoryId) list = list.filter((d) => d.category.id === v.categoryId);
      if (v.answered === true) list = list.filter((d) => d.isAnswered);
      if (v.answered === false) list = list.filter((d) => !d.isAnswered);
      return ok({ repository: { discussions: { totalCount: list.length, nodes: list.slice(0, v.first).map((d) => ({ ...d, comments: { totalCount: d.comments.length } })) } } });
    }
    case 'SearchDiscussions': return ok({ search: { discussionCount: Object.keys(D).length, nodes: Object.values(D).map((d) => ({ ...d, repository: { nameWithOwner: 'acme/app' } })) } });
    case 'GetDiscussion': case 'DiscussionBody': {
      const d = D[v.number];
      if (!d) return nf({ repository: { discussion: null } }, `a Discussion with the number ${v.number}`);
      return ok({ repository: { discussion: { ...d, comments: commentsOf(d) } } });
    }
    case 'DiscussionTitles': {
      const repo = {};
      const errors = [];
      for (const mm of query.matchAll(/d(\d+): discussion\(number: (\d+)\)/g)) {
        const d = D[Number(mm[2])];
        repo[`d${mm[1]}`] = d ? { number: d.number, title: d.title, url: d.url } : null;
        if (!d) errors.push({ type: 'NOT_FOUND', path: ['repository', `d${mm[1]}`], message: 'Could not resolve' });
      }
      return send(res, 200, { data: { repository: repo }, ...(errors.length ? { errors } : {}) });
    }
    case 'CreateDiscussion': {
      const n = Math.max(...Object.keys(D).map(Number)) + 1;
      const cat = CATS.find((c) => c.id === v.input.categoryId);
      D[n] = disc(n, v.input.title, cat.id, { body: v.input.body });
      return ok({ createDiscussion: { discussion: { id: D[n].id, number: n, url: D[n].url, title: D[n].title } } });
    }
    case 'AddDiscussionComment': {
      const d = Object.values(D).find((x) => x.id === v.input.discussionId);
      const c = { id: `DC_${state.nextComment++}`, url: `${d.url}#c`, body: v.input.body, isAnswer: false, createdAt: 'now', author: { login: LOGINS[token] || 'bot' }, replies: [] };
      d.comments.push(c);
      return ok({ addDiscussionComment: { comment: { id: c.id, url: c.url } } });
    }
    case 'MarkAnswer': {
      if (state.failMarkOnce) { state.failMarkOnce = false; return send(res, 200, { data: null, errors: [{ message: 'Something went wrong while executing your query.' }] }); }
      const d = Object.values(D).find((x) => x.comments.some((c) => c.id === v.input.id));
      for (const c of d.comments) c.isAnswer = c.id === v.input.id;
      d.isAnswered = true;
      d.answer = { id: v.input.id };
      return ok({ markDiscussionCommentAsAnswer: { discussion: { id: d.id, number: d.number, isAnswered: true } } });
    }
    case 'UpdateDiscussion': {
      const d = Object.values(D).find((x) => x.id === v.input.discussionId);
      if (v.input.body !== undefined) d.body = v.input.body;
      if (v.input.title !== undefined) d.title = v.input.title;
      return ok({ updateDiscussion: { discussion: { id: d.id, number: d.number, url: d.url, title: d.title } } });
    }
    case 'ReviewThreads': return ok({ repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: state.threads.map((t) => ({ ...t, firstComment: { totalCount: t.comments.length, nodes: [t.comments[0]] }, lastComment: { nodes: [t.comments[t.comments.length - 1]] } })) } } } });
    case 'ThreadNode': { const t = state.threads.find((x) => x.id === v.id); return ok({ node: t ? { id: t.id, isResolved: t.isResolved, viewerCanResolve: t.viewerCanResolve, viewerCanUnresolve: t.viewerCanUnresolve, path: t.path } : null }); }
    case 'ResolveThread': { const t = state.threads.find((x) => x.id === v.input.threadId); t.isResolved = true; return ok({ resolveReviewThread: { thread: { id: t.id, isResolved: true } } }); }
    case 'AddThreadReply': return ok({ addPullRequestReviewThreadReply: { comment: { id: 'PRRC_1', url: 'u' } } });
    case 'RepoOwnerIssue': return ok({ repository: { owner: { __typename: isUserRepo ? 'User' : 'Organization', login: v.owner }, issue: { id: `I_${v.number}`, number: v.number, title: 't', issueType: { id: 'IT_bug', name: 'Bug' } } } });
    case 'OrgIssueTypes': return ok({ organization: { issueTypes: { nodes: [{ id: 'IT_bug', name: 'Bug', isEnabled: true }, { id: 'IT_feat', name: 'Feature', isEnabled: true }, { id: 'IT_task', name: 'Task', isEnabled: false }] } } });
    case 'UpdateIssueType': return ok({ updateIssueIssueType: { issue: { number: 10, issueType: v.input.issueTypeId ? { name: 'x' } : null } } });
    case 'IssueIds': return ok({ dup: { issue: { id: `I_${v.a}`, number: v.a, state: 'OPEN', title: 'dup' } }, orig: { issue: { id: `I_${v.b}`, number: v.b, state: 'OPEN', title: 'orig' } } });
    case 'AddComment': return ok({ addComment: { commentEdge: { node: { id: 'IC_1', url: 'u' } } } });
    case 'CloseIssueDuplicate': return ok({ closeIssue: { issue: { number: 10, state: 'CLOSED', stateReason: 'DUPLICATE' } } });
    default: return send(res, 200, { errors: [{ message: `fake: unknown operation ${op}` }] });
  }
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const url = new URL(req.url, BASE);
    const p = decodeURIComponent(url.pathname);
    const auth = req.headers.authorization || '';
    state.log.push({ method: req.method, path: p, url: req.url, body, auth, at: Date.now() });
    if (state.force && state.force.match.test(p)) return send(res, state.force.status, state.force.body, state.force.headers || {});
    // App endpoints authenticate with the JWT
    let mm;
    if ((mm = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(p)) && req.method === 'POST') {
      const v = verifyJwt(auth.replace(/^Bearer /, ''));
      state.jwtChecks.push({ ...v, installation: mm[1], body: JSON.parse(body || '{}') });
      if (!v.ok) return send(res, 401, { message: 'A JSON web token could not be decoded' });
      return send(res, 201, { token: INST_TOKEN, expires_at: '2026-11-17T12:00:00Z' });
    }
    if (p === '/app' && req.method === 'GET') return verifyJwt(auth.replace(/^Bearer /, '')).ok ? send(res, 200, { slug: 'fleet-app' }) : send(res, 401, { message: 'bad jwt' });
    const tok = auth.replace(/^Bearer /, '');
    if (![SENTINEL, CLI_TOKEN, INST_TOKEN].includes(tok)) return send(res, 401, { message: 'Bad credentials' });
    if (p === '/graphql' && req.method === 'POST') return graphql(req, res, body, tok);
    const G = req.method === 'GET';
    if (G && p === '/user') return tok === INST_TOKEN ? send(res, 403, { message: 'Resource not accessible by integration' }) : send(res, 200, { login: LOGINS[tok], type: 'User' }, { 'X-OAuth-Scopes': 'repo, read:org' });
    if (G && p === '/rate_limit') return send(res, 200, { resources: { core: { limit: 5000, remaining: 4990, reset: 1800000000 }, graphql: { limit: 5000, remaining: 5000, reset: 1800000000 } } });
    if (G && p === '/installation/repositories') return send(res, 200, { total_count: 2, repositories: [{ full_name: 'acme/app' }, { full_name: 'acme/lib' }] });
    if (G && p === '/repos/acme/app') return send(res, 200, { full_name: 'acme/app', private: true, permissions: { admin: false, push: true, pull: true } });
    if (G && p === '/repos/acme/app/pulls/5') return send(res, 200, { number: 5, head: { sha: HEAD, ref: 'feat/x' } });
    if (G && p === '/repos/acme/app/pulls/5/files') {
      if (state.rateOnce) { state.rateOnce = false; return send(res, 403, { message: 'You have exceeded a secondary rate limit.' }, { 'Retry-After': '1' }); }
      if (url.searchParams.get('page') === '2') return send(res, 200, FILES_P2);
      return send(res, 200, FILES_P1, { Link: `<${BASE}/repos/acme/app/pulls/5/files?per_page=100&page=2>; rel="next"` });
    }
    if (req.method === 'POST' && p === '/repos/acme/app/pulls/5/reviews') return send(res, 200, { id: 900, state: JSON.parse(body).event ? 'CHANGES_REQUESTED' : 'PENDING', html_url: 'https://github.com/acme/app/pull/5#review-900' });
    if (req.method === 'POST' && p === '/repos/acme/app/pulls/5/requested_reviewers') return send(res, 201, { number: 5 });
    if (G && (mm = /^\/repos\/(acme\/(?:app|other))\/issues\/(\d+)$/.exec(p))) {
      const n = Number(mm[2]);
      return send(res, 200, { id: mm[1] === 'acme/other' ? 3000 + n : 1000 + n, node_id: `I_${n}`, number: n, title: `issue ${n}` });
    }
    if (req.method === 'POST' && p === '/repos/acme/app/issues/10/sub_issues') return send(res, 201, { id: 1010, number: 10 });
    if (req.method === 'PATCH' && p === '/repos/acme/app/issues/10/sub_issues/priority') return send(res, 200, { id: 1010 });
    if (req.method === 'DELETE' && p === '/repos/acme/app/issues/10/sub_issue') return send(res, 200, { id: 1010 });
    if (G && p === '/repos/acme/app/issues/10/sub_issues') return send(res, 200, [{ id: 1011, number: 11, title: 'child', state: 'open', html_url: 'u' }]);
    if (G && p === '/repos/acme/app/issues/11/parent') return send(res, 200, { id: 1010, number: 10, title: 'parent', state: 'open', html_url: 'u' });
    if (G && p === '/repos/acme/app/issues/12/parent') return send(res, 404, { message: 'Not Found' });
    if (G && p === '/repos/acme/app/actions/runs') {
      const sha = url.searchParams.get('head_sha');
      return send(res, 200, { total_count: RUNS.length, workflow_runs: sha === HEAD ? RUNS : [] });
    }
    if (G && p === '/repos/acme/app/actions/runs/501/jobs') return send(res, 200, { total_count: 2, jobs: JOBS_501 });
    if (G && p === '/repos/acme/app/actions/jobs/601/logs') { res.writeHead(302, { Location: `${STORAGE}/logs/601?sig=abc` }); return res.end(); }
    if (G && p === '/repos/acme/app/check-runs/601/annotations') return send(res, 200, [{ annotation_level: 'failure', path: 'test/a.test.js', start_line: 3, title: 'a.test.js', message: 'expected 1 to equal 2' }, { annotation_level: 'notice', message: 'fyi' }]);
    if (G && p === '/repos/acme/app/actions/runs/700') return send(res, 200, { id: 700, created_at: daysAgo(40), run_attempt: 1, conclusion: 'failure', path: '.github/workflows/ci.yml' });
    if (G && p === '/repos/acme/app/actions/runs/701') return send(res, 200, { id: 701, created_at: daysAgo(1), run_attempt: 2, conclusion: 'failure', path: '.github/workflows/ci.yml', html_url: 'u701' });
    if (G && p === '/repos/acme/app/actions/runs/702') return send(res, 200, { id: 702, created_at: daysAgo(1), run_attempt: 50, conclusion: 'failure' });
    if (req.method === 'POST' && /^\/repos\/acme\/app\/actions\/runs\/701\/(rerun|rerun-failed-jobs)$/.test(p)) return send(res, 201, {});
    if (G && p === '/repos/acme/app/contents/.github/workflows/deploy.yml') return send(res, 200, { encoding: 'base64', content: Buffer.from(WORKFLOW_YAML).toString('base64') });
    if (G && p === '/repos/acme/app/contents/.github/workflows/push-only.yml') return send(res, 200, { encoding: 'base64', content: Buffer.from('on: [push]\njobs: {}\n').toString('base64') });
    if (req.method === 'POST' && p === '/repos/acme/app/actions/workflows/deploy.yml/dispatches') return send(res, 200, { workflow_run_id: 801, run_url: `${BASE}/repos/acme/app/actions/runs/801`, html_url: 'https://github.com/acme/app/actions/runs/801' });
    return send(res, 404, { message: `Not Found (fake: ${req.method} ${p})` });
  });
});
const storage = http.createServer((req, res) => {
  state.storageLog.push({ path: req.url, auth: req.headers.authorization || '' });
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end(JOB_LOG);
});

const homes = [];
before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  BASE = `http://127.0.0.1:${server.address().port}`;
  await new Promise((r) => storage.listen(0, '127.0.0.1', r));
  STORAGE = `http://127.0.0.1:${storage.address().port}`;
});
after(async () => {
  await new Promise((r) => server.close(r));
  await new Promise((r) => storage.close(r));
  for (const h of homes) fs.rmSync(h, { recursive: true, force: true });
});
beforeEach(() => resetState());

function newHome() {
  // realpath: on macOS os.tmpdir() is under /var, a symlink to /private/var, and a child's cwd is the real path
  const h = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ghs-')));
  homes.push(h);
  return h;
}
const BASE_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(GH_|GITHUB_)/i.test(k)));
function run(home, args, env = {}, { gap = '0' } = {}) {
  return new Promise((resolve) => {
    const e = { ...BASE_ENV, GH_TOKEN: SENTINEL, GITHUB_SKILL_HOME: home, GITHUB_API_URL: BASE, ...env };
    if (gap !== null) e.GITHUB_SKILL_WRITE_GAP_MS = gap;
    for (const [k, v] of Object.entries(e)) if (v === undefined) delete e[k];
    execFile(process.execPath, [CLI, ...args], { cwd: home, env: e }, (err, stdout, stderr) => {
      outputs.push(stdout, stderr);
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr });
    });
  });
}
function writeFile(home, name, text) {
  const p = path.join(home, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  return p;
}
const json = (r) => JSON.parse(r.stdout);
const mutations = () => state.gql.filter((g) => g.mutation);
const restWrites = () => state.log.filter((e) => e.method !== 'GET' && e.path !== '/graphql' && !e.path.includes('/access_tokens'));
const ops = (name) => state.gql.filter((g) => g.op === name);
const R = ['-R', 'acme/app'];

// ---------------------------------------------------------------- unit: identity
test('identity selection order: --identity > repo exact > owner/* > default > implicit env; never a silent fallback', () => {
  const cfg = {
    exists: true,
    identities: { a: { source: 'env' }, b: { source: 'gh-cli' }, c: { source: 'env', env_var: 'X' }, d: { source: 'env' } },
    default_identity: 'd',
    repo_identity: { 'acme/app': 'b', 'acme/*': 'c' },
  };
  const env = { GH_TOKEN: 'x' };
  assert.equal(resolveIdentity(cfg, { flag: 'a', repo: 'acme/app', env }).name, 'a');
  assert.equal(resolveIdentity(cfg, { repo: 'acme/app', env }).name, 'b');
  assert.equal(resolveIdentity(cfg, { repo: 'ACME/App', env }).name, 'b');
  assert.equal(resolveIdentity(cfg, { repo: 'acme/lib', env }).name, 'c');
  assert.equal(resolveIdentity(cfg, { repo: 'other/x', env }).name, 'd');
  assert.equal(resolveIdentity(cfg, { env }).name, 'd');
  assert.throws(() => resolveIdentity(cfg, { flag: 'nope', env }), (e) => e.exitCode === EXIT.CONFIG && /not defined/.test(e.message));
  const none = { exists: false, identities: {}, repo_identity: {} };
  const imp = resolveIdentity(none, { env });
  assert.equal(imp.name, 'env');
  assert.equal(imp.def.source, 'env');
  assert.throws(() => resolveIdentity(none, { env: {} }), (e) => e.exitCode === EXIT.CONFIG && /--identity/.test(e.message) && /config map/.test(e.message));
  // a config file exists but selects nothing: GH_TOKEN is NOT used implicitly
  const noDefault = { exists: true, identities: { a: { source: 'env' } }, repo_identity: {} };
  assert.throws(() => resolveIdentity(noDefault, { env }), (e) => e.exitCode === EXIT.CONFIG);
});

test('token kind from prefix', () => {
  assert.equal(tokenKind('ghp_x'), 'classic-pat');
  assert.equal(tokenKind('github_pat_x'), 'fine-grained-pat');
  assert.equal(tokenKind('gho_x'), 'oauth');
  assert.equal(tokenKind('ghu_x'), 'app-user');
  assert.equal(tokenKind('ghs_x'), 'installation');
  assert.equal(tokenKind('abc'), 'unknown');
});

test('App JWT: RS256, iat = now-60, exp = now+540, iss = client_id || app_id, signature verifies', () => {
  const now = 1_800_000_000;
  let v = verifyJwt(mintAppJwt({ appId: '12345', privateKeyPem: PRIV_PEM, now }));
  assert.equal(v.ok, true);
  assert.deepEqual(v.header, { alg: 'RS256', typ: 'JWT' });
  assert.deepEqual(v.payload, { iat: now - 60, exp: now + 540, iss: 12345 });
  v = verifyJwt(mintAppJwt({ appId: 1, clientId: 'Iv23abc', privateKeyPem: PRIV_PEM, now }));
  assert.equal(v.payload.iss, 'Iv23abc');
});

test('parseArgs: inline bodies and tokens are guardrail refusals; unknown flags are usage errors', () => {
  assert.throws(() => parseArgs(['discussions', 'comment', '--body', 'hi']), (e) => e.exitCode === EXIT.GUARDRAIL && /shell quoting/.test(e.message));
  assert.throws(() => parseArgs(['--token', 'x']), (e) => e.exitCode === EXIT.GUARDRAIL);
  assert.throws(() => parseArgs(['--pat=x']), (e) => e.exitCode === EXIT.GUARDRAIL);
  assert.throws(() => parseArgs(['--bogus']), (e) => e.exitCode === EXIT.USAGE);
  const a = parseArgs(['actions', 'dispatch', '-R', 'o/r', 'x.yml', '--input', 'a=1', '--input=b=2']);
  assert.deepEqual(a.f.input, ['a=1', 'b=2']);
  assert.equal(a.f.R, 'o/r');
});

// ---------------------------------------------------------------- unit: linter
test('lint: wrapped paragraph, missing blank before list after lead-in, fenced block spacing, headings, quotes', () => {
  const lineMsgs = (t) => lintMarkdown(t).map((i) => `${i.line}:${i.message}`);
  let r = lineMsgs('This is a sentence that\nwas wrapped by the agent.\n');
  assert.equal(r.length, 1);
  assert.match(r[0], /^1:paragraph text wrapped across lines 1-2/);
  r = lineMsgs('Steps:\n- one\n- two\n');
  assert.ok(r.some((m) => /^2:missing blank line before list \(after the lead-in sentence\)/.test(m)), r.join('|'));
  r = lineMsgs('Run this:\n```sh\nnpm test\n```\nThen done.\n');
  assert.ok(r.some((m) => /^2:missing blank line before fenced code block/.test(m)), r.join('|'));
  assert.ok(r.some((m) => /^4:missing blank line after fenced code block/.test(m)), r.join('|'));
  r = lineMsgs('Intro.\n## Head\nText.\n');
  assert.ok(r.some((m) => /before heading/.test(m)) && r.some((m) => /after heading/.test(m)));
  r = lineMsgs('> quoted text that\n> is wrapped\n');
  assert.ok(r.some((m) => /blockquote paragraph wrapped/.test(m)), r.join('|'));
  r = lineMsgs('- a\n- b\nafter list\n');
  assert.ok(r.some((m) => /missing blank line after list/.test(m)));
  // clean document: lists, quotes, code, table, hard break, list continuation code
  const clean = '# Title\n\nOne paragraph on one line.\n\n- item one\n- item two\n  - nested\n\n> a quote on one line\n>\n> second quote paragraph\n\n```js\nconst a = 1;\nconst b = 2;\n```\n\n| a | b |\n| - | - |\n\nLine with hard break  \nnext line\n';
  assert.deepEqual(lintMarkdown(clean), []);
  assert.equal(lintMarkdown('```\nopen\n').length, 1);
});

// ---------------------------------------------------------------- unit: FAQ
test('faq index parse: groups, entries and problems (other repo, duplicate)', () => {
  const p = parseFaqIndex(INDEX_BODY, 'acme/app');
  assert.equal(p.intro, 'Welcome to the FAQ.');
  assert.deepEqual(p.groups.map((g) => [g.name, g.entries.length]), [['Setup', 2], ['Usage', 3]]);
  assert.ok(p.problems.some((x) => /another repository \(acme\/other\)/.test(x.problem)));
  assert.ok(p.problems.some((x) => /duplicate link to #2/.test(x.problem) && x.line === 13));
  const bad = parseFaqIndex('intro\n\n---\n\n### G\n\n- broken entry\n- [x](https://example.com/foo)\n', 'acme/app');
  assert.ok(bad.problems.some((x) => /broken entry/.test(x.problem)));
  assert.ok(bad.problems.some((x) => /not a discussion URL/.test(x.problem)));
  assert.equal(parseFaqIndex('no separator', 'a/b').has_separator, false);
});

test('faq index append: end of group, never reorders, no-op when linked, new group at the end', () => {
  const r = appendToIndex(INDEX_BODY, 'Setup', { title: 'New [thing]', url: DURL(7) });
  assert.equal(r.changed, true);
  const lines = r.body.split('\n');
  assert.equal(lines[8], `- [New \\[thing\\]](${DURL(7)})`);
  lines.splice(8, 1);
  assert.equal(lines.join('\n'), INDEX_BODY, 'only one line inserted, nothing reordered');
  assert.equal(appendToIndex(INDEX_BODY, 'Usage', { title: 'x', url: DURL(3) }).changed, false);
  const g = appendToIndex(INDEX_BODY, 'Troubleshooting', { title: 'T', url: DURL(8) });
  assert.equal(g.group_created, true);
  assert.ok(g.body.startsWith(INDEX_BODY.trimEnd()));
  assert.ok(g.body.endsWith(`\n\n### Troubleshooting\n\n- [T](${DURL(8)})\n`));
  assert.deepEqual(lintMarkdown(g.body), []);
  const empty = appendToIndex('intro\n\n---\n\n### Empty\n', 'empty', { title: 'E', url: DURL(4) });
  assert.equal(empty.body, `intro\n\n---\n\n### Empty\n\n- [E](${DURL(4)})\n`);
  assert.throws(() => appendToIndex('no sep', 'G', { title: 'x', url: DURL(1) }), (e) => e.exitCode === EXIT.GUARDRAIL);
  assert.match(unifiedDiff('a\nb', 'a\nx\nb'), /\n\+x\n/);
});

test('title similarity: normalised equality and near-duplicates >= 0.8', () => {
  assert.equal(titleSimilarity('How do I install it?', 'how do i INSTALL it'), 1);
  assert.ok(titleSimilarity('How do I configure SSH keys', 'How do I configure SSH key') >= 0.8);
  assert.ok(titleSimilarity('How do I configure SSH keys', 'Why does the build fail on Windows') < 0.3);
});

// ---------------------------------------------------------------- unit: PR review
test('patch parsing: multiple hunks, deletions, new file; compact ranges', () => {
  const p = parsePatch(PATCH_A);
  assert.equal(p.hunks.length, 2);
  assert.equal(compactRanges(p.right), '1-5,21-24');
  assert.equal(compactRanges(p.left), '1-4,20-22');
  const n = parsePatch('@@ -0,0 +1,3 @@\n+a\n+b\n+c');
  assert.equal(compactRanges(n.right), '1-3');
  assert.equal(compactRanges(n.left), '');
  const d = parsePatch('@@ -5,3 +4,0 @@\n-x\n-y\n-z');
  assert.equal(compactRanges(d.left), '5-7');
  assert.equal(compactRanges(d.right), '');
  assert.equal(compactRanges([3, 1, 2, 7, 9, 8, 12]), '1-3,7-9,12');
});

test('review validation: off-diff line, cross-hunk range, suggestion only RIGHT, position refused', () => {
  const files = [...FILES_P1, ...FILES_P2];
  const v = validateReviewComments([
    { path: 'src/a.js', line: 3, body: 'ok' },
    { path: 'src/a.js', line: 10, body: 'off' },
    { path: 'src/a.js', start_line: 4, line: 22, body: 'cross' },
    { path: 'src/a.js', line: 2, side: 'LEFT', suggestion: 'x' },
    { path: 'src/a.js', position: 3, line: 3, body: 'pos' },
    { path: 'img.png', line: 1, body: 'bin' },
    { path: 'nope.js', line: 1, body: 'x' },
    { path: 'src/a.js', start_line: 2, start_side: 'LEFT', line: 3, body: 'mixed sides in one hunk' },
  ], files);
  assert.equal(v.comments.length, 2);
  const e = v.errors.join('\n');
  assert.match(e, /line 10 is not commentable on RIGHT \(commentable: 1-5,21-24\)/);
  assert.match(e, /spans more than one diff hunk/);
  assert.match(e, /suggestion can only replace lines on the RIGHT/);
  assert.match(e, /"position" is not used/);
  assert.match(e, /img\.png has no diff hunk/);
  assert.match(e, /nope\.js" is not changed/);
  assert.equal(suggestionBody('Use this.', 'a\nb'), 'Use this.\n\n```suggestion\na\nb\n```');
  assert.equal(suggestionBody('', 'a'), '```suggestion\na\n```');
});

// ---------------------------------------------------------------- unit: actions
test('dispatch inputs: minimal YAML extraction and validation', () => {
  const s = parseDispatchInputs(WORKFLOW_YAML);
  assert.equal(s.dispatchable, true);
  assert.deepEqual(Object.keys(s.inputs), ['environment', 'dry_run', 'replicas', 'note']);
  assert.deepEqual(s.inputs.environment.options, ['staging', 'production']);
  assert.equal(s.inputs.environment.required, true);
  assert.equal(s.inputs.dry_run.type, 'boolean');
  assert.equal(s.inputs.note.default, 'n/a');
  assert.equal(parseDispatchInputs('on: [push, workflow_dispatch]\n').dispatchable, true);
  assert.equal(parseDispatchInputs('on: push\n').dispatchable, false);
  assert.equal(parseDispatchInputs('on:\n  workflow_dispatch:\njobs: {}\n').dispatchable, true);
  let v = validateDispatchInputs(s.inputs, { environment: 'qa', dry_run: 'maybe', replicas: 'abc', bogus: '1' });
  const e = v.errors.join('\n');
  assert.match(e, /unknown input "bogus"/);
  assert.match(e, /"environment" must be one of staging, production/);
  assert.match(e, /"dry_run" is boolean/);
  assert.match(e, /"replicas" must be a number/);
  v = validateDispatchInputs(s.inputs, {});
  assert.match(v.errors.join('\n'), /missing required input "environment"/);
  assert.doesNotMatch(v.errors.join('\n'), /note/);
  const many = Object.fromEntries(Array.from({ length: 26 }, (_, i) => [`i${i}`, { type: 'string' }]));
  assert.match(validateDispatchInputs(many, {}).errors[0], /at most 25/);
});

test('step log extraction by timestamps, with ##[group] fallback; tail and error lines deduped', () => {
  const r = extractStepLog(JOB_LOG, JOBS_501[0].steps[1]);
  assert.equal(r.extracted_by, 'timestamps');
  assert.equal(r.tail.length, 60);
  assert.ok(!r.tail.some((l) => /setup line|Post job cleanup/.test(l)));
  assert.ok(r.tail.some((l) => /##\[error\]Process completed/.test(l)));
  assert.deepEqual(r.matches, ['Error: expected 1 to equal 2', '##[error]Process completed with exit code 1.']);
  const g = extractStepLog(JOB_LOG, { name: 'Run npm test' });
  assert.equal(g.extracted_by, 'group-markers');
  assert.ok(g.tail.some((l) => /Error: expected/.test(l)));
  assert.ok(!g.tail.some((l) => /cleanup/.test(l)));
});

// ---------------------------------------------------------------- unit: diagnosis
test('diagnosis: 403 X-Accepted-GitHub-Permissions, SAML, 404, GraphQL FORBIDDEN/INSUFFICIENT_SCOPES', () => {
  let e = diagnoseApiError(403, JSON.stringify({ message: 'Resource not accessible by integration' }), { 'x-accepted-github-permissions': 'discussions=write' }, 'POST /graphql');
  assert.equal(e.exitCode, EXIT.AUTH);
  assert.match(e.message, /discussions=write/);
  assert.match(e.message, /App installation or fine-grained PAT/);
  e = diagnoseApiError(403, JSON.stringify({ message: 'Resource protected by organization SAML enforcement.' }), { 'x-github-sso': 'required; url=https://github.com/orgs/acme/sso?x=1' });
  assert.equal(e.exitCode, EXIT.AUTH);
  assert.match(e.message, /SAML SSO.*https:\/\/github\.com\/orgs\/acme\/sso/s);
  e = diagnoseApiError(404, '{"message":"Not Found"}', {});
  assert.equal(e.exitCode, EXIT.API);
  assert.match(e.message, /not found OR no access with this identity/);
  assert.equal(diagnoseApiError(401, '{"message":"Bad credentials"}', {}).exitCode, EXIT.AUTH);
  assert.equal(diagnoseGraphqlErrors([{ type: 'FORBIDDEN', message: 'nope' }]).exitCode, EXIT.AUTH);
  assert.match(diagnoseGraphqlErrors([{ type: 'INSUFFICIENT_SCOPES', message: 'needs read:org' }]).message, /read:org/);
  assert.equal(diagnoseGraphqlErrors([{ message: 'x' }]).exitCode, EXIT.API);
});

// ---------------------------------------------------------------- CLI: identity
test('implicit env identity: whoami reports identity, kind, login, rate limit and repo permissions', async () => {
  const home = newHome();
  const r = await run(home, ['auth', 'whoami', ...R]);
  assert.equal(r.code, 0, r.stderr);
  const w = json(r);
  assert.equal(w.identity, 'env');
  assert.equal(w.source, 'env');
  assert.equal(w.token_kind, 'classic-pat');
  assert.equal(w.actor.login, 'octo-bot');
  assert.equal(w.rate_limit.core.remaining, 4990);
  assert.deepEqual(w.repo.permissions, { admin: false, push: true, pull: true });
  assert.equal(w.oauth_scopes, 'repo, read:org');
});

test('no config and no token: CONFIG error listing the options; nothing is sent', async () => {
  const home = newHome();
  const r = await run(home, ['auth', 'whoami'], { GH_TOKEN: undefined });
  assert.equal(r.code, EXIT.CONFIG);
  assert.match(r.stderr, /--identity NAME/);
  assert.match(r.stderr, /config identity add/);
  assert.equal(state.log.length, 0);
});

test('a failing selected identity is an AUTH error and never falls back to GH_TOKEN', async () => {
  const home = newHome();
  let r = await run(home, ['config', 'identity', 'add', 'ci', '--source', 'env', '--env-var', 'CI_TOKEN']);
  assert.equal(r.code, 0, r.stderr);
  r = await run(home, ['config', 'default', 'ci']);
  assert.equal(r.code, 0, r.stderr);
  r = await run(home, ['auth', 'whoami']);
  assert.equal(r.code, EXIT.AUTH);
  assert.match(r.stderr, /CI_TOKEN/);
  assert.match(r.stderr, /Not falling back/);
  assert.equal(state.log.length, 0, 'GH_TOKEN was not used');
  // gh-cli identity that fails: also no fallback
  r = await run(home, ['config', 'identity', 'add', 'me', '--source', 'gh-cli']);
  const ghDir = newHome();
  const fakeGh = writeFile(ghDir, 'gh.mjs', "process.stderr.write('not logged in to github.com\\n'); process.exit(1);\n");
  r = await run(home, ['auth', 'whoami', '--identity', 'me'], { GITHUB_SKILL_GH_BIN: fakeGh });
  assert.equal(r.code, EXIT.AUTH);
  assert.match(r.stderr, /gh auth login/);
  assert.equal(state.log.length, 0);
});

test('gh-cli identity: runs gh auth token --hostname --user without shell and without GH_TOKEN; repo mapping selects it', async () => {
  const home = newHome();
  const ghDir = newHome();
  const logFile = path.join(ghDir, 'gh-args.json');
  const fakeGh = writeFile(ghDir, 'gh.mjs', `import fs from 'node:fs';\nfs.writeFileSync(process.env.FAKE_GH_LOG, JSON.stringify({ args: process.argv.slice(2), sawGhToken: !!(process.env.GH_TOKEN || process.env.GITHUB_TOKEN) }));\nprocess.stdout.write(process.env.FAKE_GH_TOKEN + '\\n');\n`);
  let r = await run(home, ['config', 'identity', 'add', 'me', '--source', 'gh-cli', '--user', 'cli-user']);
  assert.equal(r.code, 0, r.stderr);
  r = await run(home, ['config', 'map', 'acme/*', 'me']);
  assert.equal(r.code, 0, r.stderr);
  r = await run(home, ['auth', 'whoami', ...R], { GITHUB_SKILL_GH_BIN: fakeGh, FAKE_GH_LOG: logFile, FAKE_GH_TOKEN: CLI_TOKEN });
  assert.equal(r.code, 0, r.stderr);
  const w = json(r);
  assert.equal(w.identity, 'me');
  assert.equal(w.token_kind, 'oauth');
  assert.equal(w.actor.login, 'cli-user');
  assert.match(w.selected_via, /acme\/\*/);
  const g = JSON.parse(fs.readFileSync(logFile, 'utf8'));
  assert.deepEqual(g.args, ['auth', 'token', '--hostname', 'github.com', '--user', 'cli-user']);
  assert.equal(g.sawGhToken, false);
  assert.ok(state.log.every((e) => e.auth === `Bearer ${CLI_TOKEN}`));
});

test('app-key identity: JWT verified by the server, installation token minted with narrowing, acting_as names the app', async () => {
  const home = newHome();
  const keyDir = newHome();
  const keyPath = writeFile(keyDir, 'app.pem', PRIV_PEM);
  let r = await run(home, ['config', 'identity', 'add', 'bot', '--source', 'app-key', '--app-id', '12345', '--installation-id', '77', '--private-key-path', keyPath, '--repositories', 'app', '--permissions', 'issues=write,discussions=write']);
  assert.equal(r.code, 0, r.stderr);
  r = await run(home, ['auth', 'whoami', '--identity', 'bot']);
  assert.equal(r.code, 0, r.stderr);
  const w = json(r);
  assert.equal(w.token_kind, 'installation');
  assert.equal(w.actor.type, 'GitHub App installation');
  assert.equal(w.actor.repositories_count, 2);
  assert.equal(w.actor.app, 'fleet-app[bot]');
  const jc = state.jwtChecks[0];
  assert.equal(jc.ok, true);
  assert.equal(jc.installation, '77');
  assert.equal(jc.payload.iss, 12345);
  assert.equal(jc.payload.exp - jc.payload.iat, 600);
  assert.deepEqual(jc.body, { repositories: ['app'], permissions: { issues: 'write', discussions: 'write' } });
  assert.ok(!state.log.some((e) => e.path === '/user'), 'installation tokens are not asked for /user');
  // writes carry acting_as with the app
  const bodyFile = writeFile(home, 'c.md', 'A comment.\n');
  r = await run(home, ['discussions', 'comment', ...R, '3', '--body-file', bodyFile, '--identity', 'bot', '--dry-run']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(json(r).acting_as, { identity: 'bot', source: 'app-key', kind: 'installation', app: 'fleet-app[bot]' });
  // key inside a plugin dir is refused; config with a token is refused
  r = await run(home, ['config', 'identity', 'add', 'bad', '--source', 'app-key', '--app-id', '1', '--installation-id', '1', '--private-key-path', path.join(here, 'x.pem')]);
  assert.equal(r.code, EXIT.GUARDRAIL);
  assert.match(r.stderr, /plugin directory/);
  const h2 = newHome();
  fs.writeFileSync(path.join(h2, 'config.json'), JSON.stringify({ identities: { x: { source: 'env', token: SENTINEL } }, default_identity: 'x' }));
  r = await run(h2, ['auth', 'whoami']);
  assert.equal(r.code, EXIT.CONFIG);
  assert.match(r.stderr, /never holds tokens/);
  r = await run(home, ['config', 'show']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(json(r).identities.bot.private_key_path, keyPath);
});

// ---------------------------------------------------------------- CLI: guardrails, lint
test('inline --body is refused (exit 2) and lint blocks a wrapped body; nothing is written', async () => {
  const home = newHome();
  let r = await run(home, ['discussions', 'comment', ...R, '3', '--body', 'hello `world`']);
  assert.equal(r.code, EXIT.GUARDRAIL);
  assert.match(r.stderr, /shell quoting/);
  const f = writeFile(home, 'wrapped.md', 'This answer was wrapped\nat seventy columns.\n\nSteps:\n- a\n');
  r = await run(home, ['discussions', 'comment', ...R, '3', '--body-file', f]);
  assert.equal(r.code, EXIT.GUARDRAIL);
  assert.match(r.stderr, /line 1: paragraph text wrapped/);
  assert.match(r.stderr, /line 5: missing blank line before list/);
  assert.equal(mutations().length, 0);
  r = await run(home, ['lint', f]);
  assert.equal(r.code, EXIT.GUARDRAIL);
  assert.equal(json(r).issues.length, 2);
  r = await run(home, ['discussions', 'comment', ...R, '3', '--body-file', f, '--no-lint']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(ops('AddDiscussionComment').length, 1);
});

// ---------------------------------------------------------------- CLI: discussions
test('discussions categories/list/get', async () => {
  const home = newHome();
  let r = await run(home, ['discussions', 'categories', ...R]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(json(r).categories.map((c) => [c.name, c.isAnswerable]), [['Q&A', true], ['General', false]]);
  r = await run(home, ['discussions', 'list', ...R, '--category', 'q&a', '--unanswered', '--json']);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(!r.stdout.trim().includes('\n'), '--json is compact');
  assert.deepEqual(json(r).discussions.map((d) => d.number), [3, 5]);
  assert.equal(ops('ListDiscussions')[0].variables.categoryId, 'CAT_QA');
  r = await run(home, ['discussions', 'get', ...R, '2']);
  assert.equal(r.code, 0, r.stderr);
  const d = json(r);
  assert.equal(d.answer.id, 'DC_a2');
  assert.equal(d.comments[0].is_answer, true);
  r = await run(home, ['discussions', 'get', ...R, '42']);
  assert.equal(r.code, EXIT.API);
  assert.match(r.stderr, /not found OR no access/);
});

test('discussions create: dedupe guardrail, --allow-duplicate, long-title warning, dry-run sends nothing, acting_as', async () => {
  const home = newHome();
  const f = writeFile(home, 'q.md', 'How do I install it on Windows?\n');
  let r = await run(home, ['discussions', 'create', ...R, '--category', 'Q&A', '--title', 'How do I install it', '--body-file', f]);
  assert.equal(r.code, EXIT.GUARDRAIL);
  assert.match(r.stderr, /#2 How do I install it\?/);
  assert.equal(mutations().length, 0);
  const long = `How do I ${'really '.repeat(12)}upgrade`;
  r = await run(home, ['discussions', 'create', ...R, '--category', 'Q&A', '--title', long, '--body-file', f, '--dry-run']);
  assert.equal(r.code, 0, r.stderr);
  const plan = json(r);
  assert.equal(plan.dry_run, true);
  assert.equal(plan.method, 'POST');
  assert.equal(plan.headers.Authorization, 'Bearer [REDACTED]');
  assert.equal(plan.body.variables.input.categoryId, 'CAT_QA');
  assert.deepEqual(plan.acting_as, { identity: 'env', source: 'env', kind: 'classic-pat', login: 'octo-bot' });
  assert.match(plan.warnings[0], /> 80/);
  assert.equal(mutations().length, 0, 'dry-run sent no mutation');
  r = await run(home, ['discussions', 'create', ...R, '--category', 'Q&A', '--title', 'How do I install it', '--body-file', f, '--allow-duplicate']);
  assert.equal(r.code, 0, r.stderr);
  const c = json(r);
  assert.equal(c.created.number, 6);
  assert.equal(c.acting_as.login, 'octo-bot');
  assert.equal(ops('CreateDiscussion').length, 1);
});

test('discussions answer: refused on a non-answerable category and when already answered; otherwise comment + mark', async () => {
  const home = newHome();
  const f = writeFile(home, 'a.md', 'Use `npm i`.\n');
  let r = await run(home, ['discussions', 'answer', ...R, '4', '--body-file', f]);
  assert.equal(r.code, EXIT.GUARDRAIL);
  assert.match(r.stderr, /not answerable/);
  r = await run(home, ['discussions', 'answer', ...R, '2', '--body-file', f]);
  assert.equal(r.code, EXIT.GUARDRAIL);
  assert.match(r.stderr, /--replace-answer/);
  assert.equal(mutations().length, 0);
  r = await run(home, ['discussions', 'answer', ...R, '3', '--body-file', f, '--dry-run']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(json(r).steps.length, 2);
  assert.equal(mutations().length, 0);
  r = await run(home, ['discussions', 'answer', ...R, '3', '--body-file', f]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(mutations().map((m) => m.op), ['AddDiscussionComment', 'MarkAnswer']);
  assert.equal(state.discussions[3].isAnswered, true);
  assert.ok(json(r).acting_as);
});

test('discussions close/lock dry-runs and edit diff send nothing', async () => {
  const home = newHome();
  let r = await run(home, ['discussions', 'close', ...R, '3', '--reason', 'outdated', '--dry-run']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(json(r).body.variables.input.reason, 'OUTDATED');
  r = await run(home, ['discussions', 'lock', ...R, '3', '--reason', 'too_heated', '--dry-run']);
  assert.equal(json(r).body.variables.input.lockReason, 'TOO_HEATED');
  r = await run(home, ['discussions', 'lock', ...R, '3', '--reason', 'bogus', '--dry-run']);
  assert.equal(r.code, EXIT.USAGE);
  const f = writeFile(home, 'b.md', 'New body.\n');
  r = await run(home, ['discussions', 'edit', ...R, '3', '--body-file', f, '--dry-run']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(json(r).body_diff, /-Body of 3\n\+New body\./);
  assert.equal(mutations().length, 0);
});

// ---------------------------------------------------------------- CLI: FAQ
test('faq index: reports other-repo, duplicate, missing and retitled entries, and the pinning note', async () => {
  const home = newHome();
  const r = await run(home, ['faq', 'index', ...R, '1']);
  assert.equal(r.code, 0, r.stderr);
  const x = json(r);
  const probs = x.problems.map((p) => p.problem).join('\n');
  assert.match(probs, /another repository/);
  assert.match(probs, /duplicate link to #2/);
  assert.match(probs, /#99 is missing/);
  assert.match(probs, /title changed: index says "Old title", #3 is now "Renamed title"/);
  assert.match(x.pinning, /no API to pin/);
});

test('faq index-add: appends at the end of the group (dry-run diff first), no-op when linked, new group at the end', async () => {
  const home = newHome();
  let r = await run(home, ['faq', 'index-add', ...R, '1', '--entry', '4', '--group', 'Usage', '--dry-run']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(json(r).diff, /\+- \[General chat\]\(https:\/\/github\.com\/acme\/app\/discussions\/4\)/);
  assert.equal(mutations().length, 0);
  r = await run(home, ['faq', 'index-add', ...R, '1', '--entry', '4', '--group', 'Usage']);
  assert.equal(r.code, 0, r.stderr);
  const lines = state.discussions[1].body.split('\n');
  assert.equal(lines[14], `- [General chat](${DURL(4)})`);
  lines.splice(14, 1);
  assert.equal(lines.join('\n'), INDEX_BODY);
  r = await run(home, ['faq', 'index-add', ...R, '1', '--entry', '3', '--group', 'Usage']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(json(r).no_op, true);
  assert.equal(ops('UpdateDiscussion').length, 1);
  r = await run(home, ['faq', 'index-add', ...R, '1', '--entry', '5', '--group', 'Troubleshooting']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(json(r).indexed.group_created, true);
  assert.ok(state.discussions[1].body.endsWith(`### Troubleshooting\n\n- [Troubleshooting crashes](${DURL(5)})\n`));
});

test('faq add: dry-run plan, resume after a simulated failure without a second discussion, writes >= 1s apart', async () => {
  const home = newHome();
  const q = writeFile(home, 'q.md', 'How do I upgrade from 1.x?\n');
  const a = writeFile(home, 'a.md', 'Run the migration:\n\n```sh\nnpx migrate\n```\n');
  const args = ['faq', 'add', ...R, '--index', '1', '--category', 'Q&A', '--group', 'Setup', '--title', 'How do I upgrade?', '--question-file', q, '--answer-file', a];
  let r = await run(home, [...args, '--dry-run']);
  assert.equal(r.code, 0, r.stderr);
  const plan = json(r);
  assert.deepEqual(plan.plan.map((s) => s.step), ['dedupe', 'create', 'answer', 'mark-answer', 'index-add']);
  assert.match(plan.index_diff, /\+- \[How do I upgrade\?\]/);
  assert.equal(mutations().length, 0);
  state.failMarkOnce = true;
  r = await run(home, args);
  assert.equal(r.code, EXIT.API, r.stderr);
  const pfile = path.join(home, 'faq-progress', 'acme-app-how-do-i-upgrade.json');
  const prog = JSON.parse(fs.readFileSync(pfile, 'utf8'));
  assert.equal(prog.created.number, 6);
  assert.ok(prog.answer_comment.id);
  assert.ok(!prog.marked);
  r = await run(home, args, {}, { gap: null });
  assert.equal(r.code, 0, r.stderr);
  const done = json(r);
  assert.equal(done.resumed, true);
  assert.equal(done.added.number, 6);
  assert.ok(done.acting_as);
  assert.equal(ops('CreateDiscussion').length, 1, 'no second discussion');
  assert.equal(ops('AddDiscussionComment').length, 1, 'no second answer comment');
  assert.equal(ops('MarkAnswer').length, 2);
  assert.equal(state.discussions[6].isAnswered, true);
  const lines = state.discussions[1].body.split('\n');
  assert.equal(lines[8], `- [How do I upgrade?](${DURL(6)})`);
  const mt = mutations().filter((m) => m.at).slice(-2).map((m) => m.at);
  assert.ok(mt[1] - mt[0] >= 950, `writes ${mt[1] - mt[0]}ms apart`);
  r = await run(home, args);
  assert.equal(json(r).already_completed, true);
  assert.equal(ops('CreateDiscussion').length, 1);
});

// ---------------------------------------------------------------- CLI: PRs
test('prs lines: paginated files, RIGHT/LEFT ranges, binary file is file-level only; secondary rate limit retried once', async () => {
  const home = newHome();
  state.rateOnce = true;
  const r = await run(home, ['prs', 'lines', ...R, '5']);
  assert.equal(r.code, 0, r.stderr);
  const x = json(r);
  assert.deepEqual(x.files.map((f) => [f.path, f.right, f.left]), [['src/a.js', '1-5,21-24', '1-4,20-22'], ['src/new.js', '1-3', '']]);
  assert.deepEqual(x.file_level_only.map((f) => f.path), ['img.png']);
  assert.match(r.stderr, /secondary rate limit/);
  assert.equal(state.log.filter((e) => e.path === '/repos/acme/app/pulls/5/files').length, 3);
});

test('prs review: validated before sending; line/side not position; suggestion block; pending omits event; dry-run sends nothing', async () => {
  const home = newHome();
  writeFile(home, 'rv/r.md', 'Two issues below.\n');
  writeFile(home, 'rv/c1.md', 'Rename `new3`.\n');
  const spec = {
    event: 'REQUEST_CHANGES', body_file: 'r.md',
    comments: [
      { path: 'src/a.js', line: 3, body_file: 'c1.md' },
      { path: 'src/a.js', start_line: 21, line: 23, body: 'Use this.', suggestion: 'fixed21\nfixed22\nfixed23' },
      { path: 'src/a.js', line: 2, side: 'LEFT', body: 'Why removed?' },
    ],
  };
  const rf = writeFile(home, 'rv/review.json', JSON.stringify(spec));
  let r = await run(home, ['prs', 'review', ...R, '5', '--file', rf, '--dry-run']);
  assert.equal(r.code, 0, r.stderr);
  const plan = json(r);
  assert.equal(plan.url.endsWith('/repos/acme/app/pulls/5/reviews'), true);
  assert.equal(plan.body.commit_id, HEAD);
  assert.equal(plan.body.event, 'REQUEST_CHANGES');
  assert.equal(plan.body.body, 'Two issues below.');
  assert.deepEqual(plan.body.comments[0], { path: 'src/a.js', line: 3, side: 'RIGHT', body: 'Rename `new3`.' });
  assert.deepEqual(plan.body.comments[1], { path: 'src/a.js', line: 23, side: 'RIGHT', start_line: 21, start_side: 'RIGHT', body: 'Use this.\n\n```suggestion\nfixed21\nfixed22\nfixed23\n```' });
  assert.equal(plan.body.comments[2].side, 'LEFT');
  assert.ok(!JSON.stringify(plan.body).includes('position'));
  assert.ok(plan.acting_as.login);
  assert.equal(restWrites().length, 0);
  // pending: event omitted
  r = await run(home, ['prs', 'review', ...R, '5', '--file', rf, '--pending']);
  assert.equal(r.code, 0, r.stderr);
  const sent = JSON.parse(restWrites()[0].body);
  assert.equal('event' in sent, false);
  assert.equal(sent.comments.length, 3);
  // invalid: off-diff and cross-hunk -> refused, nothing sent
  const bad = writeFile(home, 'rv/bad.json', JSON.stringify({ event: 'COMMENT', body: 'x', comments: [{ path: 'src/a.js', line: 10, body: 'a' }, { path: 'src/a.js', start_line: 4, line: 22, body: 'b' }] }));
  const before = restWrites().length;
  r = await run(home, ['prs', 'review', ...R, '5', '--file', bad]);
  assert.equal(r.code, EXIT.GUARDRAIL);
  assert.match(r.stderr, /line 10 is not commentable/);
  assert.match(r.stderr, /more than one diff hunk/);
  assert.equal(restWrites().length, before);
  // COMMENT needs a body
  const nobody = writeFile(home, 'rv/nobody.json', JSON.stringify({ event: 'COMMENT', comments: [] }));
  r = await run(home, ['prs', 'review', ...R, '5', '--file', nobody]);
  assert.equal(r.code, EXIT.USAGE);
});

test('prs threads (--unresolved), resolve refused when viewerCanResolve is false, resolve/reply/rerequest', async () => {
  const home = newHome();
  let r = await run(home, ['prs', 'threads', ...R, '5', '--unresolved']);
  assert.equal(r.code, 0, r.stderr);
  const t = json(r);
  assert.equal(t.total, 3);
  assert.deepEqual(t.threads.map((x) => x.id), ['T1', 'T3']);
  assert.equal(t.threads[0].comments, 2);
  assert.equal(t.threads[0].last.author, 'dev');
  assert.match(t.threads[0].first.excerpt, /rename/);
  r = await run(home, ['prs', 'resolve', 'T3']);
  assert.equal(r.code, EXIT.GUARDRAIL);
  assert.match(r.stderr, /viewerCanResolve is false/);
  assert.equal(mutations().length, 0);
  r = await run(home, ['prs', 'resolve', 'T1']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(ops('ResolveThread')[0].variables.input.threadId, 'T1');
  const f = writeFile(home, 'reply.md', 'Fixed in the latest push.\n');
  r = await run(home, ['prs', 'reply', 'T1', '--body-file', f]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(ops('AddThreadReply')[0].variables.input.pullRequestReviewThreadId, 'T1');
  r = await run(home, ['prs', 'rerequest', ...R, '5', '--reviewers', 'a,b', '--teams', 'core', '--dry-run']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(json(r).body, { reviewers: ['a', 'b'], team_reviewers: ['core'] });
  assert.equal(restWrites().length, 0);
});

// ---------------------------------------------------------------- CLI: issues
test('issues sub add resolves the child id (cross-repo ref); list/parent; move needs before|after', async () => {
  const home = newHome();
  let r = await run(home, ['issues', 'sub', 'add', ...R, '10', 'acme/other#3', '--replace-parent']);
  assert.equal(r.code, 0, r.stderr);
  const w = restWrites()[0];
  assert.equal(w.path, '/repos/acme/app/issues/10/sub_issues');
  assert.deepEqual(JSON.parse(w.body), { sub_issue_id: 3003, replace_parent: true });
  assert.ok(json(r).acting_as);
  r = await run(home, ['issues', 'sub', 'list', ...R, '10']);
  assert.equal(json(r).sub_issues[0].number, 11);
  r = await run(home, ['issues', 'sub', 'parent', ...R, '11']);
  assert.equal(json(r).parent.number, 10);
  r = await run(home, ['issues', 'sub', 'parent', ...R, '12']);
  assert.equal(json(r).parent, null);
  r = await run(home, ['issues', 'sub', 'move', ...R, '10', '11', '--after', '13', '--dry-run']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(json(r).body, { sub_issue_id: 1011, after_id: 1013 });
  r = await run(home, ['issues', 'sub', 'remove', ...R, '10', '11', '--dry-run']);
  assert.equal(json(r).method, 'DELETE');
  assert.equal(restWrites().length, 1);
});

test('issues type: org type lookup (case-insensitive), clear with none, unknown lists available, user-owned refused', async () => {
  const home = newHome();
  let r = await run(home, ['issues', 'type', ...R, '10', 'feature']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(ops('UpdateIssueType')[0].variables.input, { issueId: 'I_10', issueTypeId: 'IT_feat' });
  r = await run(home, ['issues', 'type', ...R, '10', 'none']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(ops('UpdateIssueType')[1].variables.input.issueTypeId, null);
  r = await run(home, ['issues', 'type', ...R, '10', 'Epic']);
  assert.equal(r.code, EXIT.USAGE);
  assert.match(r.stderr, /Available: Bug, Feature/);
  r = await run(home, ['issues', 'type', '-R', 'someuser/proj', '10', 'Bug']);
  assert.equal(r.code, EXIT.GUARDRAIL);
  assert.match(r.stderr, /organization-owned/);
});

test('issues duplicate: closeIssue with stateReason DUPLICATE and duplicateIssueId, rationale comment first', async () => {
  const home = newHome();
  const f = writeFile(home, 'why.md', 'Same root cause as #11.\n');
  let r = await run(home, ['issues', 'duplicate', ...R, '10', '--of', '11', '--rationale-file', f, '--dry-run']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(json(r).steps.length, 2);
  assert.equal(mutations().length, 0);
  r = await run(home, ['issues', 'duplicate', ...R, '10', '--of', '11', '--rationale-file', f]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(mutations().map((m) => m.op), ['AddComment', 'CloseIssueDuplicate']);
  assert.deepEqual(ops('CloseIssueDuplicate')[0].variables.input, { issueId: 'I_10', stateReason: 'DUPLICATE', duplicateIssueId: 'I_11' });
});

// ---------------------------------------------------------------- CLI: actions
test('actions failures: newest run per workflow, failed steps with log tail + errors, annotations; redirect host never gets Authorization', async () => {
  const home = newHome();
  const r = await run(home, ['actions', 'failures', ...R, '--pr', '5', '--out', 'logs']);
  assert.equal(r.code, 0, r.stderr);
  const x = json(r);
  assert.equal(x.head.sha, HEAD);
  assert.deepEqual(x.failed_runs.map((f) => f.run_id), [501], 'docs.yml: newest run passed, so not reported');
  const job = x.failed_runs[0].failed_jobs[0];
  assert.equal(job.job_id, 601);
  assert.equal(job.failed_steps.length, 1);
  const step = job.failed_steps[0];
  assert.equal(step.name, 'Run npm test');
  assert.equal(step.extracted_by, 'timestamps');
  assert.equal(step.tail.length, 60);
  assert.deepEqual(step.matches, ['Error: expected 1 to equal 2', '##[error]Process completed with exit code 1.']);
  assert.deepEqual(job.annotations, [{ level: 'failure', path: 'test/a.test.js', line: 3, title: 'a.test.js', message: 'expected 1 to equal 2' }]);
  assert.equal(job.log_file, path.join(home, 'logs', '501-601.log'));
  assert.equal(fs.readFileSync(job.log_file, 'utf8'), JOB_LOG);
  assert.equal(state.storageLog.length, 1);
  assert.equal(state.storageLog[0].auth, '', 'redirect host got no Authorization');
  assert.ok(!r.stdout.includes('sig=abc'), 'the signed log URL is not printed');
  const runsReq = state.log.find((e) => e.path === '/repos/acme/app/actions/runs');
  assert.match(runsReq.url, /head_sha=c{40}/);
  assert.match(runsReq.url, /status=completed/);
  const jobsReq = state.log.find((e) => e.path.endsWith('/runs/501/jobs'));
  assert.match(jobsReq.url, /filter=latest/);
});

test('actions rerun: 30-day and 50-attempt guards; failed-only default, --all, --debug sets enable_debug_logging', async () => {
  const home = newHome();
  let r = await run(home, ['actions', 'rerun', ...R, '700']);
  assert.equal(r.code, EXIT.GUARDRAIL);
  assert.match(r.stderr, /30 days/);
  r = await run(home, ['actions', 'rerun', ...R, '702']);
  assert.equal(r.code, EXIT.GUARDRAIL);
  assert.match(r.stderr, /at most 50/);
  assert.equal(restWrites().length, 0);
  r = await run(home, ['actions', 'rerun', ...R, '701', '--dry-run']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(json(r).url, /\/actions\/runs\/701\/rerun-failed-jobs$/);
  assert.equal(restWrites().length, 0);
  r = await run(home, ['actions', 'rerun', ...R, '701', '--all', '--debug']);
  assert.equal(r.code, 0, r.stderr);
  const w = restWrites()[0];
  assert.equal(w.path, '/repos/acme/app/actions/runs/701/rerun');
  assert.deepEqual(JSON.parse(w.body), { enable_debug_logging: true });
  assert.match(r.stderr, /Authorization: Bearer \[REDACTED\]/);
});

test('actions dispatch: inputs validated against the workflow; return_run_details; non-dispatchable refused', async () => {
  const home = newHome();
  let r = await run(home, ['actions', 'dispatch', ...R, 'deploy.yml', '--ref', 'main', '--input', 'environment=qa', '--input', 'dry_run=maybe', '--input', 'bogus=1']);
  assert.equal(r.code, EXIT.GUARDRAIL);
  assert.match(r.stderr, /must be one of staging, production/);
  assert.match(r.stderr, /unknown input "bogus"/);
  r = await run(home, ['actions', 'dispatch', ...R, 'deploy.yml', '--ref', 'main']);
  assert.equal(r.code, EXIT.GUARDRAIL);
  assert.match(r.stderr, /missing required input "environment"/);
  r = await run(home, ['actions', 'dispatch', ...R, 'push-only.yml', '--ref', 'main']);
  assert.equal(r.code, EXIT.GUARDRAIL);
  assert.match(r.stderr, /no "on: workflow_dispatch"/);
  assert.equal(restWrites().length, 0);
  r = await run(home, ['actions', 'dispatch', ...R, 'deploy.yml', '--ref', 'main', '--input', 'environment=staging', '--input', 'dry_run=true', '--input', 'replicas=3']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(restWrites()[0].body), { ref: 'main', inputs: { environment: 'staging', dry_run: 'true', replicas: '3' }, return_run_details: true });
  const o = json(r);
  assert.equal(o.run_id, 801);
  assert.equal(o.run_url, 'https://github.com/acme/app/actions/runs/801');
  assert.ok(state.log.find((e) => e.path.endsWith('/contents/.github/workflows/deploy.yml')).url.includes('ref=main'));
});

// ---------------------------------------------------------------- CLI: error diagnosis
test('CLI diagnosis: 403 with X-Accepted-GitHub-Permissions, SAML SSO, 401', async () => {
  const home = newHome();
  state.force = { match: /^\/repos\/acme\/app\/pulls\/5$/, status: 403, body: { message: 'Resource not accessible by integration' }, headers: { 'X-Accepted-GitHub-Permissions': 'pull_requests=read' } };
  let r = await run(home, ['actions', 'failures', ...R, '--pr', '5']);
  assert.equal(r.code, EXIT.AUTH);
  assert.match(r.stderr, /pull_requests=read/);
  assert.match(r.stderr, /Resource not accessible by integration/);
  state.force = { match: /^\/repos\/acme\/app\/actions\/runs\/701$/, status: 403, body: { message: 'Resource protected by organization SAML enforcement. You must grant your Personal Access token access to this organization.' }, headers: { 'X-GitHub-SSO': 'required; url=https://github.com/orgs/acme/sso?authorization_request=abc' } };
  r = await run(home, ['actions', 'rerun', ...R, '701']);
  assert.equal(r.code, EXIT.AUTH);
  assert.match(r.stderr, /SAML SSO/);
  assert.match(r.stderr, /orgs\/acme\/sso/);
  state.force = null;
  r = await run(home, ['auth', 'whoami'], { GH_TOKEN: 'ghp_wrongTOKENvalue000000000000000000' });
  assert.equal(r.code, EXIT.AUTH);
  assert.match(r.stderr, /invalid, expired or revoked/);
  assert.ok(!r.stderr.includes('ghp_wrongTOKENvalue'));
});

// ---------------------------------------------------------------- secrets
test('tokens never appear in stdout, stderr, config/progress/log files, URLs or bodies', () => {
  allLogs.push(...state.log, ...state.storageLog);
  assert.ok(outputs.length > 60, 'collected CLI output');
  const toks = [SENTINEL, CLI_TOKEN, INST_TOKEN];
  for (const o of outputs) for (const t of toks) assert.ok(!o.includes(t), 'token leaked to output');
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const h of homes) {
    if (!fs.existsSync(h)) continue;
    for (const f of walk(h)) {
      if (/gh\.mjs$/.test(f)) continue;
      const t = fs.readFileSync(f, 'utf8');
      if (path.basename(f) === 'config.json' && t.includes('"token"')) continue; // the deliberately bad config in the refusal test
      for (const tok of toks) assert.ok(!t.includes(tok), `token in file ${f}`);
    }
  }
  for (const e of allLogs) {
    for (const t of toks) {
      assert.ok(!String(e.url || e.path).includes(t), 'token in URL');
      assert.ok(!String(e.body || '').includes(t), 'token in body');
    }
  }
});
