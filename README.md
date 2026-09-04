# gvkit

A lightweight Obsidian toolkit focused on fast, native-feeling editing actions.

## 0.1 scope

The first version solves one daily-use problem: fast blue/purple text and background coloring on desktop and mobile.

### Desktop

1. Select text in a Markdown note.
2. A compact floating toolbar appears near the selection.
3. Choose `蓝字`, `紫字`, `蓝底`, `紫底`, or `清除`.

### Mobile

1. Add the gvkit formatting commands to Obsidian's native mobile editor toolbar once.
2. Select text in a Markdown note.
3. Tap the corresponding gvkit toolbar action. Tap the same active color again to remove only that color layer.

## Formatting model

Color is an independent formatting layer. Markdown bold, italic, links, and other inline formatting remain Markdown and can coexist with gvkit colors.

Text color uses lightweight gvkit source markers that are hidden in Live Preview:

```md
~={gv-blue}blue text=~
~={gv-purple}purple text=~
```

Background color follows Obsidian's colored-highlight syntax introduced in Obsidian 1.14:

```md
==🔵blue background==
==🟣purple background==
```

For compatibility with Obsidian 1.13, gvkit also renders these colored highlights itself. Existing 0.1.0 HTML color markup remains readable/removable, but new formatting no longer writes HTML wrappers.

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

Do not develop or test unverified builds directly in a production vault. Use an isolated test vault first.
