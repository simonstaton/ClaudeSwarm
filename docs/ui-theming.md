# UI stack and theming

Short reference for the web UI after the shadcn migration.

## Stack

- **Framework**: Next.js 15 (App Router), React 19
- **Components**: [shadcn/ui](https://ui.shadcn.com/) (new-york style), built on [Radix UI](https://www.radix-ui.com/) via the `radix-ui` package and local primitives in `ui/src/components/ui/`
- **Styling**: Tailwind v4, class-variance-authority (CVA) for component variants, `cn()` for class merging
- **Icons**: Lucide React

## Theming

Theme is driven by **CSS custom properties** in `ui/src/app/globals.css`:

1. **Primitive tokens** (`:root`) – Raw palette and motion (e.g. `--palette-neutral-*`, `--radius`, `--duration-*`). No semantic meaning; single source for values.
2. **Semantic tokens** – Intent-based (e.g. `--background`, `--foreground`, `--sidebar`, `--sidebar-accent`). Components use these so a theme switch only updates this layer.
3. **Dark mode** – System preference only via `@custom-variant dark (prefers-color-scheme: dark)`. Semantic tokens are overridden in `@media (prefers-color-scheme: dark)`.
4. **Tailwind bridge** – `@theme inline { ... }` maps semantic vars to Tailwind color utilities (e.g. `--color-sidebar` → `bg-sidebar`, `text-sidebar-foreground`).

To change theme or add a manual light/dark toggle, edit only the semantic token blocks in `globals.css` (and optionally add a class-based dark variant and a toggle that sets it on `html`).

## Sidebar and semantic tokens

The sidebar uses semantic `sidebar-*` tokens (e.g. `bg-sidebar`, `border-sidebar-border`, `text-sidebar-foreground`) so it respects light/dark and stays consistent with the rest of the design system. Status indicators (e.g. agent status dots) keep semantic status colors (green/red/amber/blue) rather than theme tokens.

## Package size (lockfile)

The migration from `@fanvue/ui` to shadcn + Radix increased `ui/package-lock.json` size. This is expected. To reduce duplicates or audit deps, run from `ui/`: `npm dedupe`, `npm audit`.
