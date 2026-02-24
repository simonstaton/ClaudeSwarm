# UI motion and transition tokens

Use these for consistent, fast-feeling motion. No new npm deps; CSS and Tailwind only.

## CSS variables (add to ui/src/app/globals.css)

```css
:root {
  /* existing --font-mono, --font-sans */
  --duration-instant: 100ms;
  --duration-fast: 150ms;
  --duration-normal: 200ms;
  --duration-slow: 300ms;
  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
  --ease-in: cubic-bezier(0.7, 0, 0.84, 0);
}
```

Keep existing `.animate-fade-in` and the `prefers-reduced-motion` block; use the same reduce rule for any new animation classes.

## Where to use

| Context | Duration | Easing | Notes |
|---------|----------|--------|--------|
| Buttons, links (hover/focus) | 150ms | ease-out | transition-colors, transition-opacity |
| Modals (ConfirmDialog, LinearWorkflowDialog) | 200ms | ease-out | overlay + content enter/exit (opacity + scale or translate) |
| Toasts | 200–300ms | ease-out | slide from edge or fade |
| Sidebar nav items | 150ms | ease-out | already transition-colors |
| Dropdowns / popovers | 200ms | ease-out | opacity + slight y |

## Components to update

1. **ConfirmDialog** – Add 200ms enter/exit on overlay and content; keep focus trap and Escape.
2. **LinearWorkflowDialog** – Same as ConfirmDialog.
3. **Toast** – Align with `--duration-slow`; optional slide-in.
4. **Primary buttons (Header, forms)** – Use `transition-colors duration-[150ms]` (or var).
5. **Sidebar links** – Already have transition-colors; ensure duration is 150ms if not default.

## prefers-reduced-motion

For every new animation or transition class, add:

```css
@media (prefers-reduced-motion: reduce) {
  .your-class { animation: none; transition: none; }
}
```

Or use a single utility that applies to all motion classes.
