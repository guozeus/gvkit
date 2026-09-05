# gvkit

A lightweight Obsidian toolkit focused on fast, native-feeling editing actions.

## 0.2 file identity

- New target Markdown files receive a stable `gvid` in frontmatter using UUID v7.
- Automatic assignment is registered only after Obsidian workspace startup is ready, so Vault initialization never becomes an ID scan.
- The plugin settings page provides one manual `补齐缺失 ID` action for existing notes.
- The real template source directory `settings/模板/` is excluded so template content cannot copy a file identity into newly created notes.
- A batch of 10,000 or more missing IDs requires explicit confirmation; large writes yield between small batches instead of blocking the UI continuously.

## 0.1 formatting scope

The first version solves one daily-use problem: fast blue/purple text and background coloring on desktop and mobile.

### Desktop

1. Select text in a Markdown note.
2. A compact floating toolbar appears near the selection.
3. The toolbar uses the same icon language as mobile, with `粗体` first, followed by `蓝字`, `紫字`, `蓝底`, `紫底`.
4. The selection and toolbar stay active after an action so multiple formats can be applied in sequence.

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

Background color uses a separate gvkit layer as well, so it never falls back to Obsidian's default yellow highlight:

```md
~={gv-bg-blue}blue background=bg~
~={gv-bg-purple}purple background=bg~
```

Existing 0.1.0 HTML color markup and the 0.1.1-0.1.3 `==🔵...==` / `==🟣...==` beta syntax remain removable and are converted when users interact with them. New formatting no longer relies on HTML wrappers or Obsidian's native yellow highlight layer.

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
