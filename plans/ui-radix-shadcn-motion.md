# UI: Radix + shadcn Migration & UX/Motion Plan

**Goal:** Strip @fanvue/ui, adopt Radix + shadcn, and deliver improved UX with clean motion and instant transitions.

**All findings and supporting docs live in this directory (`plans/`):** checklist, motion tokens, theme tokens, and navigation UX audit.

---

## 1. Design review (current state)

### Stack
- Next.js 15, React 19, App Router. Tailwind v4 (CSS-first). @fanvue/ui (Alert, Badge, Button, TextField, PasswordField) + custom ConfirmDialog, Toast, LinearWorkflowDialog, Skeleton. Dark theme (zinc).

### @fanvue/ui usage
- **constants.ts** – BadgeVariant type
- **Login.tsx** – Alert, Button, PasswordField
- **MessageFeed.tsx** – Badge, BadgeVariant, Button, TextField
- **TasksView.tsx** – Badge
- **AgentView.tsx** – Badge, Button
- **Sidebar.tsx**, **AgentCard.tsx**, **RiskBadge.tsx** – Badge
- **PromptInput.tsx** – Button
- **Settings:** repositories, apikey, config, context, guardrails, GuardrailField – Alert, Button, TextField, PasswordField

**globals.css:** `@source` and `@import "@fanvue/ui/styles/theme.css"` plus typography overrides.

### Motion (current)
- Mostly `transition-colors` / `transition-opacity`; one `animate-fade-in` (0.2s); `animate-pulse` / `animate-spin` for loading. No page or layout transitions.

### Gaps
- Single vendor (fanvue); no design tokens; full reload on agent create; minimal micro-interactions.

---

## 2. Migration: @fanvue/ui → Radix + shadcn

- **Mapping:** Alert → shadcn Alert; Badge → shadcn Badge (extend variants); Button → shadcn Button; TextField/PasswordField → shadcn Input + Label.
- **Steps:** (1) `npx shadcn@latest init` in ui/; (2) Add button, badge, input, label, alert; (3) Replace by area: Login → Settings → Sidebar/AgentCard/RiskBadge → MessageFeed → AgentView → PromptInput → TasksView; (4) Remove fanvue imports, theme.css, typography overrides; (5) Local BadgeVariant type in constants.ts.

---

## 3. UX and motion strategy

- **Tokens:** e.g. `--duration-fast: 150ms`, `--duration-normal: 200ms`; use for buttons (150ms), modals/toasts (200ms). Respect `prefers-reduced-motion`.
- **Instant feel:** Use `router.push` for post-create navigation instead of `window.location.href`; use Next `<Link>` where appropriate; optional layout opacity/slide for route changes.
- **Modals/Toasts:** 200ms enter/exit; keep focus trap and Escape.

---

## 4. Sub-agent tasks (5)

1. **Component audit & mapping** – File-by-file checklist: every @fanvue usage → shadcn replacement. Output: `plans/ui-fanvue-to-shadcn-checklist.md`.
2. **Motion & transition tokens** – Add duration/easing CSS variables in globals.css; document in `plans/ui-motion-tokens.md`.
3. **Theme & design tokens** – Align shadcn theme with dark zinc; document in `plans/ui-theme-tokens.md`.
4. **shadcn init + Login swap** – Run shadcn init in ui/, add button, input, label, alert; replace Login.tsx with shadcn only; verify build.
5. **UX audit: navigation** – List router.push vs window.location.href; recommend Link/router.push for SPA feel; document in `plans/ui-navigation-ux.md`.

Success: zero fanvue; shadcn/Radix everywhere; motion tokens used; agent create uses client nav; plans/ docs updated.
