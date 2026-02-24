# UI navigation and instant-transition audit

Recommendations for client-side navigation and instant feel. Implement after review.

## Current navigation patterns

| Location | Trigger | Current behavior | Recommendation |
|----------|---------|------------------|----------------|
| Dashboard.tsx | After create agent | `window.location.href = \`/agents/${newest.id}/\`` | Use `router.push(\`/agents/${id}\`)` so shell stays; no full reload. |
| Dashboard / AgentCard | Click agent card | `onClick={() => window.location.href = \`/agents/${id}/\`}` | Use `<Link href={\`/agents/${id}\`}>` or `router.push()` for client nav. |
| Header | Logo, nav links | `router.push("/")`, `router.push(href)` | Keep as-is (already client-side). |
| Sidebar | Agent link | Next `<Link href={\`/agents/${id}\`}>` | Already correct. |
| Other in-app links | Settings, Tasks, etc. | Various | Prefer `<Link>` or `router.push`; avoid `window.location.href` for same-origin routes. |

## High-impact change

**Agent create flow:** In `Dashboard.tsx`, after `refreshAgents()` and getting the new agent id, replace:

```ts
window.location.href = `/agents/${newest.id}/`;
```

with:

```ts
router.push(`/agents/${newest.id}/`);
```

Ensure `useRouter()` from `next/navigation` is used. This gives an instant transition without full page reload.

## Optional instant-transition ideas

1. **Layout wrapper:** Add a shared layout (e.g. in `protected-shell` or main layout) with a short opacity or slide transition when the route segment changes (e.g. 200ms). Requires consistent layout structure across dashboard and agent pages.
2. **Skeleton for agent page:** While loading agent details in AgentView, show a skeleton for the header/terminal area so the shell appears immediately and content fills in (already partially there; ensure no layout jump).

## Summary

- Prefer `router.push()` and `<Link>` for all in-app routes; remove `window.location.href` for same-origin navigation.
- Highest impact: Dashboard agent create and AgentCard click → client-side navigation.
- Optional: layout-level transition and skeleton polish for perceived speed.
