# gvkit

Obsidian plugin for fast blue/purple text and background coloring.

## V0.1 scope

The first version intentionally solves only one daily-use problem: fast blue/purple text and background coloring.

Desktop editing flow:

1. Select text in a Markdown note.
2. A small floating toolbar appears near the selection.
3. Choose `蓝字`, `紫字`, `蓝底`, `紫底`, or `清除`.

Mobile editing flow:

1. Add the gvkit formatting commands to Obsidian's native mobile editor toolbar once.
2. Select text in a Markdown note.
3. Tap the corresponding gvkit toolbar action to apply or clear the style.

The same formatting implementation is used on desktop and mobile; only the UI entry point differs.

## Stored markup

The plugin writes semantic inline HTML classes into the Markdown source instead of hard-coding RGB values:

```html
<span class="gvkit-text-blue">blue text</span>
<span class="gvkit-text-purple">purple text</span>
<mark class="gvkit-bg-blue">blue background</mark>
<mark class="gvkit-bg-purple">purple background</mark>
```

Colors are rendered from Obsidian's own `--color-blue` and `--color-purple` CSS variables. The source text remains intact even if the plugin is disabled.

## Development

```bash
npm install
npm test
npm run build
```

Build output required by Obsidian:

- `main.js`
- `manifest.json`
- `styles.css`

Do not develop or test unverified builds directly in the production vault. Use an isolated test vault first.
