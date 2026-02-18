# Figma Integration

**Try MCP tools first** — Figma MCP is configured with token auth and should be available as native tools in your session (e.g. `mcp__figma__...`). Only use the REST API examples below as a fallback if MCP tools aren't loading.

## Quick Start

Use this Node.js helper to call any Figma REST API endpoint:

```bash
node -e "
if (!process.env.FIGMA_TOKEN) { console.error('ERROR: FIGMA_TOKEN is not set. Ask your admin to add it to the deployment config.'); process.exit(1); }
const https = require('node:https');
const endpoint = process.argv[1];
const req = https.request({
  hostname: 'api.figma.com', path: endpoint, method: 'GET',
  headers: { 'X-FIGMA-TOKEN': process.env.FIGMA_TOKEN }
}, res => {
  let b=''; res.on('data', c => b+=c); res.on('end', () => {
    if (res.statusCode !== 200) { console.error('HTTP', res.statusCode, b.slice(0, 500)); process.exit(1); }
    try { console.log(JSON.stringify(JSON.parse(b), null, 2)); } catch { console.error('Invalid JSON:', b.slice(0, 500)); }
  });
});
req.on('error', e => { console.error('Request failed:', e.message); process.exit(1); });
req.end();
" '/v1/me'
```

## Common Operations

### Get current user info

```bash
node -e "
if (!process.env.FIGMA_TOKEN) { console.error('ERROR: FIGMA_TOKEN is not set.'); process.exit(1); }
const https = require('node:https');
const req = https.request({
  hostname: 'api.figma.com', path: '/v1/me', method: 'GET',
  headers: { 'X-FIGMA-TOKEN': process.env.FIGMA_TOKEN }
}, res => {
  let b=''; res.on('data', c => b+=c); res.on('end', () => {
    if (res.statusCode !== 200) { console.error('HTTP', res.statusCode, b.slice(0, 500)); process.exit(1); }
    try { console.log(JSON.stringify(JSON.parse(b), null, 2)); } catch { console.error('Invalid JSON:', b.slice(0, 500)); }
  });
});
req.on('error', e => { console.error('Request failed:', e.message); process.exit(1); });
req.end();
"
```

### Get a Figma file

Extract the file key from a Figma URL: `https://www.figma.com/file/FILE_KEY/...`

```bash
node -e "
if (!process.env.FIGMA_TOKEN) { console.error('ERROR: FIGMA_TOKEN is not set.'); process.exit(1); }
const https = require('node:https');
const fileKey = process.argv[1];
const req = https.request({
  hostname: 'api.figma.com', path: '/v1/files/' + fileKey, method: 'GET',
  headers: { 'X-FIGMA-TOKEN': process.env.FIGMA_TOKEN }
}, res => {
  let b=''; res.on('data', c => b+=c); res.on('end', () => {
    if (res.statusCode !== 200) { console.error('HTTP', res.statusCode, b.slice(0, 500)); process.exit(1); }
    try {
      const data = JSON.parse(b);
      console.log('Name:', data.name);
      console.log('Last modified:', data.lastModified);
      console.log('Version:', data.version);
      console.log('Pages:', (data.document?.children || []).map(p => p.name).join(', '));
    } catch { console.error('Invalid JSON:', b.slice(0, 500)); }
  });
});
req.on('error', e => { console.error('Request failed:', e.message); process.exit(1); });
req.end();
" 'FILE_KEY_HERE'
```

### Get a specific node/frame

```bash
node -e "
if (!process.env.FIGMA_TOKEN) { console.error('ERROR: FIGMA_TOKEN is not set.'); process.exit(1); }
const https = require('node:https');
const fileKey = process.argv[1];
const nodeId = process.argv[2];
const req = https.request({
  hostname: 'api.figma.com', path: '/v1/files/' + fileKey + '/nodes?ids=' + encodeURIComponent(nodeId), method: 'GET',
  headers: { 'X-FIGMA-TOKEN': process.env.FIGMA_TOKEN }
}, res => {
  let b=''; res.on('data', c => b+=c); res.on('end', () => {
    if (res.statusCode !== 200) { console.error('HTTP', res.statusCode, b.slice(0, 500)); process.exit(1); }
    try { console.log(JSON.stringify(JSON.parse(b), null, 2)); } catch { console.error('Invalid JSON:', b.slice(0, 500)); }
  });
});
req.on('error', e => { console.error('Request failed:', e.message); process.exit(1); });
req.end();
" 'FILE_KEY' 'NODE_ID'
```

### Export images from a file

```bash
node -e "
if (!process.env.FIGMA_TOKEN) { console.error('ERROR: FIGMA_TOKEN is not set.'); process.exit(1); }
const https = require('node:https');
const fileKey = process.argv[1];
const nodeIds = process.argv[2];
const format = process.argv[3] || 'png';
const scale = process.argv[4] || '2';
const req = https.request({
  hostname: 'api.figma.com',
  path: '/v1/images/' + fileKey + '?ids=' + encodeURIComponent(nodeIds) + '&format=' + format + '&scale=' + scale,
  method: 'GET',
  headers: { 'X-FIGMA-TOKEN': process.env.FIGMA_TOKEN }
}, res => {
  let b=''; res.on('data', c => b+=c); res.on('end', () => {
    if (res.statusCode !== 200) { console.error('HTTP', res.statusCode, b.slice(0, 500)); process.exit(1); }
    try { console.log(JSON.stringify(JSON.parse(b), null, 2)); } catch { console.error('Invalid JSON:', b.slice(0, 500)); }
  });
});
req.on('error', e => { console.error('Request failed:', e.message); process.exit(1); });
req.end();
" 'FILE_KEY' 'NODE_ID1,NODE_ID2' 'svg' '1'
```

### Get file comments

```bash
node -e "
if (!process.env.FIGMA_TOKEN) { console.error('ERROR: FIGMA_TOKEN is not set.'); process.exit(1); }
const https = require('node:https');
const fileKey = process.argv[1];
const req = https.request({
  hostname: 'api.figma.com', path: '/v1/files/' + fileKey + '/comments', method: 'GET',
  headers: { 'X-FIGMA-TOKEN': process.env.FIGMA_TOKEN }
}, res => {
  let b=''; res.on('data', c => b+=c); res.on('end', () => {
    if (res.statusCode !== 200) { console.error('HTTP', res.statusCode, b.slice(0, 500)); process.exit(1); }
    try {
      const data = JSON.parse(b);
      for (const c of data.comments || []) {
        console.log('[' + c.created_at + '] ' + (c.user?.handle || 'Unknown') + ': ' + c.message);
      }
    } catch { console.error('Invalid JSON:', b.slice(0, 500)); }
  });
});
req.on('error', e => { console.error('Request failed:', e.message); process.exit(1); });
req.end();
" 'FILE_KEY'
```

### Get component styles (design tokens)

```bash
node -e "
if (!process.env.FIGMA_TOKEN) { console.error('ERROR: FIGMA_TOKEN is not set.'); process.exit(1); }
const https = require('node:https');
const fileKey = process.argv[1];
const req = https.request({
  hostname: 'api.figma.com', path: '/v1/files/' + fileKey + '/styles', method: 'GET',
  headers: { 'X-FIGMA-TOKEN': process.env.FIGMA_TOKEN }
}, res => {
  let b=''; res.on('data', c => b+=c); res.on('end', () => {
    if (res.statusCode !== 200) { console.error('HTTP', res.statusCode, b.slice(0, 500)); process.exit(1); }
    try {
      const data = JSON.parse(b);
      const styles = data.meta?.styles || [];
      for (const s of styles) {
        console.log(s.style_type + ': ' + s.name + ' (key: ' + s.key + ')');
      }
    } catch { console.error('Invalid JSON:', b.slice(0, 500)); }
  });
});
req.on('error', e => { console.error('Request failed:', e.message); process.exit(1); });
req.end();
" 'FILE_KEY'
```

## Parsing Figma URLs

Figma URLs contain the file key and optionally a node ID:

- **File**: `https://www.figma.com/file/ABC123/Design-System` → file key is `ABC123`
- **Design**: `https://www.figma.com/design/ABC123/Design-System` → file key is `ABC123`
- **With node**: `...?node-id=1-234` → node ID is `1:234` (replace `-` with `:`)
- **Prototype**: `https://www.figma.com/proto/ABC123/...` → file key is `ABC123`

## Tips

- **Authentication**: Uses `FIGMA_TOKEN` env var (pre-configured). If you get auth errors, check `printenv FIGMA_TOKEN | head -c 10` to verify it's set.
- **Rate limits**: Figma API has rate limits. Add short delays between batch requests.
- **Large files**: Use the `?depth=1` or `?ids=NODE_ID` parameters to avoid downloading entire file trees.
- **Figma API docs**: https://www.figma.com/developers/api

$ARGUMENTS
