# Contributing

Contributions are welcome. Fork the repo, make your changes, and open a pull request.

**Important:** The only supported way to run AgentManager for use is **Docker** (`npm run docker:local`). Running the server or UI outside Docker (e.g. `npm run dev`, `npm start`) is unsupported and unsafe. The commands below that start a dev server are for **developing the codebase only**—not for running the product.

## Finding work

- Browse [open issues](https://github.com/simonstaton/AgentManager/issues) labelled `good first issue` for approachable starting points.
- Check issues labelled `help wanted` for areas where maintainers are actively looking for contributors.
- Open an issue first for large changes so we can discuss the approach before you invest time.
- Comment on an issue before starting work to avoid duplication.

## Getting started

### Prerequisites

- Node.js 20+
- npm 10+
- An [OpenRouter](https://openrouter.ai) or Anthropic API key

### Clone and install

```bash
git clone https://github.com/simonstaton/AgentManager.git AgentManager
cd AgentManager

# Install server dependencies
npm install

# Install UI dependencies
npm install --prefix ui
```

### Environment setup

```bash
cp .env.example .env
```

Edit `.env` with your credentials:

```env
# Required
ANTHROPIC_BASE_URL=https://openrouter.ai/api
ANTHROPIC_AUTH_TOKEN=sk-or-v1-...   # OpenRouter key
ANTHROPIC_API_KEY=                   # Must be empty when using OpenRouter
API_KEY=use-this-password-to-access-the-ui
JWT_SECRET=any-random-string

# Optional - only needed for GitHub integration
GITHUB_TOKEN=github_pat_...
```

For **running the app** (to test your changes end-to-end), use Docker:

```bash
npm run docker:local
```

Then open `http://localhost:8080` and log in with your `API_KEY`. Do not use `npm run setup` or `npm run dev` to run the product.

For **UI development** (hot reload while editing frontend code), you may run `npm run setup` once to install deps and create shared-context, then `npm run dev` to start the dev server at `http://localhost:3000`. This is for development only and is not a supported way to run AgentManager.

## Development workflow

### Useful commands

| Command | Description |
|---------|-------------|
| `npm run docker:local` | **Run the app (supported).** Build and start via Docker at http://localhost:8080 |
| `npm run dev` | Dev server + Next.js (development only; do not use to run the product) |
| `npm run dev:server` | Server only (development only; do not use to run the product) |
| `npm test` | Run all tests once |
| `npm run test:watch` | Run tests in watch mode |
| `npm run lint` | Lint with Biome |
| `npm run lint:fix` | Lint and auto-fix |
| `npm run check` | Lint + typecheck + tests (run before submitting a PR) |
| `npm run typecheck` | TypeScript type check only |

### Project layout

```
server.ts          # Express server entry point
src/
  routes/          # Route handlers (agents, messages, context, config, mcp)
  utils/           # Shared utilities (express helpers, file ops, context dir)
  types.ts         # Shared TypeScript types
  agents.ts        # AgentManager - spawn/kill/message Claude CLI processes
  messages.ts      # MessageBus - inter-agent pub/sub
  guardrails.ts    # Safety limits (agent count, spawn depth, session TTL)
  kill-switch.ts   # Emergency stop logic
ui/                # Next.js App Router (Tailwind v4, Radix/shadcn)
  src/
    app/           # Next.js App Router pages and layouts
    components/    # Reusable UI components
    hooks/         # Custom React hooks
commands/          # Slash command skill definitions (Markdown)
docs/              # Architecture documentation
terraform/         # GCP infrastructure
```

### Running a single test file

```bash
npx vitest run src/auth.test.ts
```

## Submitting a PR

### Branch naming

Use one of these conventions:

- `feat/{short-description}` - new feature
- `fix/{short-description}` - bug fix
- `docs/{short-description}` - documentation only
- `refactor/{short-description}` - code changes without behaviour change
- `test/{short-description}` - test changes only

Examples: `feat/agent-pause`, `fix/sse-reconnect`, `docs/openapi-spec`

### PR description

Use this template when opening a PR:

```
## What

Brief description of what changed and why.

## How

Explain the approach taken - especially any non-obvious decisions.

## Testing

Describe how you tested the change.

Closes #<issue number>
```

### Issue references

Always reference the issue your PR resolves:

- `Closes #42` - automatically closes the issue when the PR is merged
- `Fixes #42` - same effect
- `Related to #42` - links without closing

### Before submitting

Run the full quality check. **CI should use `npm run check`**; do not rely on `npm start` or `npm run dev` to run the app.

```bash
npm run check
```

This runs Biome lint, TypeScript typecheck, and the Vitest test suite. PRs with failing checks will not be merged.

## Code review expectations

- Reviews typically happen within a few business days.
- All feedback is addressed before merging - if you disagree with a suggestion, say so and explain why.
- Maintainers may push minor fixup commits directly to your branch (formatting, typos) rather than leaving comments.
- Once approved, maintainers will merge using squash merge to keep history clean.

## Code style

The project uses [Biome](https://biomejs.dev/) for linting and formatting. Do not use ESLint or Prettier.

Key style rules (enforced by Biome):
- 2-space indentation
- Double quotes for strings
- Trailing commas in multi-line structures
- No unused variables or imports

Run `npm run lint:fix` to auto-fix most issues before committing.

## IDE setup

### VS Code

Install the [Biome extension](https://marketplace.visualstudio.com/items?itemName=biomejs.biome) for in-editor linting and formatting.

Recommended workspace settings (`.vscode/settings.json`):

```json
{
  "editor.defaultFormatter": "biomejs.biome",
  "editor.formatOnSave": true,
  "editor.codeActionsOnSave": {
    "source.organizeImports.biome": "explicit"
  },
  "[typescript]": {
    "editor.defaultFormatter": "biomejs.biome"
  },
  "[typescriptreact]": {
    "editor.defaultFormatter": "biomejs.biome"
  }
}
```

Disable any ESLint or Prettier extensions for this project to avoid conflicts.

### Other editors

Biome has plugins or LSP support for most editors. See the [Biome editor integrations](https://biomejs.dev/guides/editors/first-party-extensions/) page.
