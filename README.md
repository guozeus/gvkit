# Guozhousi Tools

Private Obsidian plugin for the `guozhousi` external information library.

## V0.1 scope

The first version intentionally solves only one daily-use problem: fast blue/purple text and background coloring.

Desktop editing flow:

1. Select text in a Markdown note.
2. A small floating toolbar appears near the selection.
3. Choose `蓝字`, `紫字`, `蓝底`, `紫底`, or `清除`.

The same actions are also exposed as Obsidian commands for hotkeys and later mobile integration.

## Stored markup

The plugin writes semantic inline HTML classes into the Markdown source instead of hard-coding RGB values:

```html
<span class="gzt-text-blue">blue text</span>
<span class="gzt-text-purple">purple text</span>
<mark class="gzt-bg-blue">blue background</mark>
<mark class="gzt-bg-purple">purple background</mark>
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
