# @fanvue/ui → shadcn migration checklist

File-by-file mapping. Use this when replacing components.

## globals.css
- Remove: `@source "../../node_modules/@fanvue/ui";`
- Remove: `@import "@fanvue/ui/styles/theme.css";`
- Remove or adapt: `.typography-*` overrides (lines ~83–102) once fanvue typography is gone.
- Keep: `:root` font vars, body, terminal, scrollbar, `.animate-fade-in`, `prefers-reduced-motion`.

## constants.ts
- Remove: `import type { BadgeVariant } from "@fanvue/ui";`
- Add: local type e.g. `export type BadgeVariant = "default" | "secondary" | "destructive" | "outline" | "success" | "warning" | "info";` (or match shadcn Badge variants + custom class names for success/warning/info).
- Keep: STATUS_BADGE_VARIANT, TASK_STATUS_BADGE_VARIANT, etc., mapping status strings to BadgeVariant.

## Views

### Login.tsx
- Alert → shadcn `Alert` (variant destructive for error).
- Button → shadcn `Button` (variant default/primary, full width, disabled when loading).
- PasswordField → shadcn `Input` type="password" + `Label`; optional visibility toggle.

### MessageFeed.tsx
- Badge, BadgeVariant → shadcn `Badge`; map TYPE_BADGE to shadcn variants or custom classes.
- Button → shadcn `Button`.
- TextField → shadcn `Input` + `Label`.

### TasksView.tsx
- Badge → shadcn `Badge`; use TASK_STATUS_BADGE_VARIANT from constants.

### AgentView.tsx
- Badge → shadcn `Badge` (STATUS_BADGE_VARIANT).
- Button → shadcn `Button`.

### Dashboard.tsx
- No fanvue imports; no change.

## Components

### Sidebar.tsx
- Badge → shadcn `Badge` (status variant); keep leftDot-style indicator via custom class or small span.

### AgentCard.tsx
- Badge → shadcn `Badge` (STATUS_BADGE_VARIANT).

### RiskBadge.tsx
- Badge, BadgeVariant → shadcn `Badge`; RISK_VARIANT maps to variant or className.

### PromptInput.tsx
- Button → shadcn `Button`.

## Settings

### repositories.tsx
- Alert, Button, TextField → shadcn Alert, Button, Input+Label.

### apikey.tsx
- Alert, Button, PasswordField → shadcn Alert, Button, Input type="password" + Label.

### config.tsx
- Button, TextField → shadcn Button, Input+Label.

### context.tsx
- Button, TextField → shadcn Button, Input+Label.

### guardrails.tsx
- Alert, Button → shadcn Alert, Button.

### GuardrailField.tsx
- TextField → shadcn Input+Label.

## Badge variant mapping (fanvue → shadcn/custom)

| fanvue | shadcn/custom |
|--------|----------------|
| default | variant="secondary" or "outline" |
| success | custom variant or className (e.g. green border/bg) |
| warning | custom or destructive with amber classes |
| info | custom or outline + blue |
| error | variant="destructive" |

Add shadcn Badge variants in components.json or extend in your theme if needed for success/warning/info.
