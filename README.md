# gvkit

A lightweight Obsidian toolkit focused on fast, native-feeling editing actions.

## 协作板发布（2026-10-22 首轮本地候选）

- Obsidian 设置 → gvkit → 协作板：为当前 Vault 生成/填写跨设备共享命名空间；在协作板网页「我的机器凭据」签发本人的 `publication_device`，使用 Obsidian 原生机密控件存放/选择该凭据，不要将 Token 写进笔记、聊天或仓库。
- 打开 `项目/**` 或 `安排/**` 下合规单篇 Markdown，点击标题栏「发布」→「发布到协作板」→「确认发布」。首次成功仅进入协作板全局管理池，默认**零业务项目授权**；然后在 <https://grealm.net/collab-board/> 管理页勾选策划所在项目。与宙游文档中心的独立同步/业务发布完全无关。
- 正常保存原路径、已绑定的已协作文档会在 GVKit 运行时自动推送变更，重启仅核对已绑定单篇；未知或冲突回执保留操作 ID，不会静默新建。移到禁发位置时会尝试立即撤回，离线的待撤回由下次启动重试。
- **现状**：协作板功能已完成代码构建及自动化测试，尚未完成个人真实设备和实际业务凭据的联调验收；目前不承诺其已达到完整长期协作状态。

## 0.5.1 宙游文档发布试用

1. 在 BRAT 更新 `guozeus/gvkit`，重新加载插件。
2. 打开 Obsidian 设置 → gvkit → 宙游文档中心，在每台设备自行填写获授权的业务接口地址和个人凭据。
3. 打开一篇 Markdown，从顶部「发布」或 `··· → 发布` 选择「宙游文档中心」，选择获授权产品。
4. 「同步保存」只保存当前稿；修改后可再次同步。「发布业务版本」需填写说明，才新增业务版本。
5. 每次发送前确认源文件和产品；服务端返回并读回核对后才显示完成。可到产品管理系统文档中心检查正文和版本。

仅发送当前确认的单篇文档。研究所入口暂未接入。Key 使用 Obsidian 本机 SecretStorage，不写入同步设置；需支持该能力的 Obsidian 版本。网络结果未确认时保留原操作，避免重复发布。

本版完成生产代码与模拟接口链路验证；真实账号发布、电脑和 iPhone 操作需要本人设备试用确认。

## 0.4 block links

- `块链接` inserts `[[^^]]` and leaves the cursor inside the link so Obsidian's native vault-wide block suggestions can take over.
- `块引用` inserts `![[^^]]` the same way for embedded block references.
- Both are normal gvkit editor commands, so they can be added to Obsidian's native mobile editor toolbar.
- gvkit does not build a second block index or search UI; block discovery remains native Obsidian behavior.
- Mobile acceptance passed on 2026-09-08: both toolbar actions opened native block suggestions and produced the expected link/embed results.

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
3. The floating toolbar groups common native operations: **粗体 / 斜体 / 删除线 / 行内代码 / 内部链接 / Markdown 链接**, **无序列表 / 有序列表 / 待办项**, followed by the original `蓝字`, `紫字`, `蓝底`, `紫底`. The toolbar scrolls horizontally when a note pane is narrow.
4. It resolves the editor's actual selection (including Live Preview checkbox items) instead of requiring a matching browser DOM selection. Bold and gvkit colors retain the text selection for consecutive clicks; link and list commands follow Obsidian's native selection behavior.

### Mobile

1. Add the gvkit formatting commands to Obsidian's native mobile editor toolbar once.
2. Select text in a Markdown note.
3. Tap the corresponding gvkit toolbar action. Tap the same active color again to remove only that color layer.

## Formatting model

Color is an independent formatting layer. Markdown bold, italic, links, and other inline formatting remain Markdown and can coexist with gvkit colors. Applying bold and then text/background color to the same selected text preserves native bold, including inside continuous Chinese sentences. Repeating a color action removes only that color layer.

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

## AI-safe batch moves

For AI-planned vault reorganizations, gvkit executes a reviewed source-to-destination list from the fixed control file `settings/gvkit/ai-safe-move-plan.md`. The Markdown file intentionally contains raw JSON: a non-empty array of `{ "from": "...", "to": "..." }` entries. Using a Markdown file keeps the control entry available through normal Obsidian Sync on every device without requiring `Sync all other types`. Before moving anything, gvkit rejects unsafe paths, duplicate sources or destinations, missing source files, occupied destinations, and target paths blocked by files. Missing destination folders are created inside Obsidian before the moves begin. Actual moves use Obsidian `FileManager.renameFile()` so Obsidian's native safe rename/move and internal-link update behavior is preserved. gvkit does not classify files, maintain a second migration database, or implement a rollback transaction layer.

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
