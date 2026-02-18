# Linear Integration

**Try MCP tools first** — Linear MCP is configured with token auth and should be available as native tools in your session. Only use the GraphQL API examples below as a fallback if MCP tools aren't loading.

## Quick Start

Use this Node.js helper to run any Linear GraphQL query:

```bash
node -e "
if (!process.env.LINEAR_API_KEY) { console.error('ERROR: LINEAR_API_KEY is not set. Ask your admin to add it to the deployment config.'); process.exit(1); }
const https = require('node:https');
const query = process.argv[1];
const vars = process.argv[2] ? JSON.parse(process.argv[2]) : {};
const data = JSON.stringify({ query, variables: vars });
const req = https.request({
  hostname: 'api.linear.app', path: '/graphql', method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Authorization': process.env.LINEAR_API_KEY, 'Content-Length': Buffer.byteLength(data) }
}, res => {
  let b=''; res.on('data', c => b+=c); res.on('end', () => {
    if (res.statusCode !== 200) { console.error('HTTP', res.statusCode, b.slice(0, 500)); process.exit(1); }
    try { console.log(JSON.stringify(JSON.parse(b), null, 2)); } catch { console.error('Invalid JSON:', b.slice(0, 500)); }
  });
});
req.on('error', e => { console.error('Request failed:', e.message); process.exit(1); });
req.write(data); req.end();
" 'YOUR_QUERY_HERE' '{}'
```

## Common Operations

### Get issue by identifier (e.g. ENG-7525)

```bash
node -e "
if (!process.env.LINEAR_API_KEY) { console.error('ERROR: LINEAR_API_KEY is not set.'); process.exit(1); }
const https = require('node:https');
const id = process.argv[1];
const data = JSON.stringify({
  query: 'query(\$id: String!) { issueSearch(filter: { identifier: { eq: \$id } }) { nodes { id identifier title description state { name } priority priorityLabel assignee { name } labels { nodes { name } } project { name } createdAt updatedAt comments { nodes { body createdAt user { name } } } } } }',
  variables: { id }
});
const req = https.request({
  hostname: 'api.linear.app', path: '/graphql', method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Authorization': process.env.LINEAR_API_KEY, 'Content-Length': Buffer.byteLength(data) }
}, res => {
  let b=''; res.on('data', c => b+=c); res.on('end', () => {
    if (res.statusCode !== 200) { console.error('HTTP', res.statusCode, b.slice(0, 500)); process.exit(1); }
    try { console.log(JSON.stringify(JSON.parse(b), null, 2)); } catch { console.error('Invalid JSON:', b.slice(0, 500)); }
  });
});
req.on('error', e => { console.error('Request failed:', e.message); process.exit(1); });
req.write(data); req.end();
" 'ENG-7525'
```

### Search issues

```bash
node -e "
if (!process.env.LINEAR_API_KEY) { console.error('ERROR: LINEAR_API_KEY is not set.'); process.exit(1); }
const https = require('node:https');
const term = process.argv[1];
const data = JSON.stringify({
  query: 'query(\$term: String!) { issueSearch(filter: { or: [{ title: { containsIgnoreCase: \$term } }, { description: { containsIgnoreCase: \$term } }] }, first: 10) { nodes { identifier title state { name } priority priorityLabel assignee { name } } } }',
  variables: { term }
});
const req = https.request({
  hostname: 'api.linear.app', path: '/graphql', method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Authorization': process.env.LINEAR_API_KEY, 'Content-Length': Buffer.byteLength(data) }
}, res => {
  let b=''; res.on('data', c => b+=c); res.on('end', () => {
    if (res.statusCode !== 200) { console.error('HTTP', res.statusCode, b.slice(0, 500)); process.exit(1); }
    try { console.log(JSON.stringify(JSON.parse(b), null, 2)); } catch { console.error('Invalid JSON:', b.slice(0, 500)); }
  });
});
req.on('error', e => { console.error('Request failed:', e.message); process.exit(1); });
req.write(data); req.end();
" 'search terms here'
```

### List my assigned issues

```bash
node -e "
if (!process.env.LINEAR_API_KEY) { console.error('ERROR: LINEAR_API_KEY is not set.'); process.exit(1); }
const https = require('node:https');
const data = JSON.stringify({
  query: '{ viewer { assignedIssues(filter: { state: { type: { nin: [\"completed\", \"canceled\"] } } }, first: 20) { nodes { identifier title state { name } priority priorityLabel project { name } updatedAt } } } }'
});
const req = https.request({
  hostname: 'api.linear.app', path: '/graphql', method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Authorization': process.env.LINEAR_API_KEY, 'Content-Length': Buffer.byteLength(data) }
}, res => {
  let b=''; res.on('data', c => b+=c); res.on('end', () => {
    if (res.statusCode !== 200) { console.error('HTTP', res.statusCode, b.slice(0, 500)); process.exit(1); }
    try { console.log(JSON.stringify(JSON.parse(b), null, 2)); } catch { console.error('Invalid JSON:', b.slice(0, 500)); }
  });
});
req.on('error', e => { console.error('Request failed:', e.message); process.exit(1); });
req.write(data); req.end();
"
```

### Add a comment to an issue

```bash
node -e "
if (!process.env.LINEAR_API_KEY) { console.error('ERROR: LINEAR_API_KEY is not set.'); process.exit(1); }
const https = require('node:https');
const issueId = process.argv[1];
const body = process.argv[2];
const data = JSON.stringify({
  query: 'mutation(\$issueId: String!, \$body: String!) { commentCreate(input: { issueId: \$issueId, body: \$body }) { success comment { id body createdAt } } }',
  variables: { issueId, body }
});
const req = https.request({
  hostname: 'api.linear.app', path: '/graphql', method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Authorization': process.env.LINEAR_API_KEY, 'Content-Length': Buffer.byteLength(data) }
}, res => {
  let b=''; res.on('data', c => b+=c); res.on('end', () => {
    if (res.statusCode !== 200) { console.error('HTTP', res.statusCode, b.slice(0, 500)); process.exit(1); }
    try { console.log(JSON.stringify(JSON.parse(b), null, 2)); } catch { console.error('Invalid JSON:', b.slice(0, 500)); }
  });
});
req.on('error', e => { console.error('Request failed:', e.message); process.exit(1); });
req.write(data); req.end();
" 'ISSUE_UUID' 'Comment text here'
```

Note: `commentCreate` requires the issue's UUID (not the identifier like ENG-7525). Get the UUID from the `id` field when fetching an issue.

### Update issue status

```bash
node -e "
if (!process.env.LINEAR_API_KEY) { console.error('ERROR: LINEAR_API_KEY is not set.'); process.exit(1); }
const https = require('node:https');
const issueId = process.argv[1];
const stateId = process.argv[2];
const data = JSON.stringify({
  query: 'mutation(\$id: String!, \$stateId: String!) { issueUpdate(id: \$id, input: { stateId: \$stateId }) { success issue { identifier title state { name } } } }',
  variables: { id: issueId, stateId }
});
const req = https.request({
  hostname: 'api.linear.app', path: '/graphql', method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Authorization': process.env.LINEAR_API_KEY, 'Content-Length': Buffer.byteLength(data) }
}, res => {
  let b=''; res.on('data', c => b+=c); res.on('end', () => {
    if (res.statusCode !== 200) { console.error('HTTP', res.statusCode, b.slice(0, 500)); process.exit(1); }
    try { console.log(JSON.stringify(JSON.parse(b), null, 2)); } catch { console.error('Invalid JSON:', b.slice(0, 500)); }
  });
});
req.on('error', e => { console.error('Request failed:', e.message); process.exit(1); });
req.write(data); req.end();
" 'ISSUE_UUID' 'STATE_UUID'
```

### List workflow states (for a team)

```bash
node -e "
if (!process.env.LINEAR_API_KEY) { console.error('ERROR: LINEAR_API_KEY is not set.'); process.exit(1); }
const https = require('node:https');
const data = JSON.stringify({ query: '{ workflowStates { nodes { id name type team { name key } } } }' });
const req = https.request({
  hostname: 'api.linear.app', path: '/graphql', method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Authorization': process.env.LINEAR_API_KEY, 'Content-Length': Buffer.byteLength(data) }
}, res => {
  let b=''; res.on('data', c => b+=c); res.on('end', () => {
    if (res.statusCode !== 200) { console.error('HTTP', res.statusCode, b.slice(0, 500)); process.exit(1); }
    try { console.log(JSON.stringify(JSON.parse(b), null, 2)); } catch { console.error('Invalid JSON:', b.slice(0, 500)); }
  });
});
req.on('error', e => { console.error('Request failed:', e.message); process.exit(1); });
req.write(data); req.end();
"
```

## Tips

- **Authentication**: Uses `LINEAR_API_KEY` env var (pre-configured). If you get auth errors, check `printenv LINEAR_API_KEY | head -c 10` to verify it's set.
- **Identifiers vs UUIDs**: Search/read operations use identifiers (e.g. `ENG-7525`). Mutations (update, comment) require the UUID from the `id` field.
- **Linear API docs**: https://developers.linear.app/docs/graphql/working-with-the-graphql-api
- **GraphQL schema explorer**: https://studio.apollographql.com/public/Linear-API/variant/current/explorer

$ARGUMENTS
