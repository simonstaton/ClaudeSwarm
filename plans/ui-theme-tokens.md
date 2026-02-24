# UI theme and design tokens (shadcn alignment)

Current app uses a dark-only zinc palette. Use this when running `npx shadcn@latest init` and theming.

## Current values (from ui/src/app)

- **Background:** `bg-zinc-950` (#09090b)
- **Surface / cards:** `bg-zinc-900/30`, `bg-zinc-900/50`, `bg-zinc-800`
- **Foreground / text:** `text-zinc-100`, `text-zinc-200`, `text-zinc-300`, `text-zinc-400`, `text-zinc-500`
- **Borders:** `border-zinc-800`, `border-zinc-700`, `border-zinc-600`
- **Accent (primary actions):** indigo (e.g. `bg-indigo-600`, `border-indigo-700`)
- **Destructive:** red (e.g. `bg-red-700`, `text-red-400`)
- **Muted:** `text-zinc-500`, `bg-zinc-800/60`

## shadcn init recommendations

- **Style:** New York
- **Base color:** Zinc
- **CSS variables:** Yes
- **Dark mode:** Set as default (or class-based dark); app is dark-only today.

## Variable mapping (shadcn → current)

After init, align shadcn’s CSS variables in `globals.css` (or the file shadcn adds) with the above:

| shadcn variable | Map to / value |
|-----------------|----------------|
| --background | zinc-950 |
| --foreground | zinc-100 |
| --muted | zinc-500 / zinc-800 |
| --muted-foreground | zinc-400 |
| --border | zinc-800 |
| --ring | zinc-500 or zinc-400 |
| --primary | indigo-600 (if you use primary for main actions) |
| --destructive | red-600/700 |

This keeps the existing look while using shadcn’s token system for new components.
