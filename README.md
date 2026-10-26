# gvkit

A lightweight Obsidian toolkit focused on fast, native-feeling editing actions.

## 0.6.17 自御安排（A 阶段试用）

在 Obsidian 内随手记录、按父子关系组织，并按唯一扁平顺序从上往下执行。事项和顺序均保存在 Markdown，沿用当前 Vault 的同步。

1. 在 BRAT 更新 `guozeus/gvkit` 到 0.6.17，重新加载插件。新设备可用 BRAT 添加同一公开仓库，无需 GitHub Token。
2. 从侧边栏「自御安排」或命令面板「gvkit: 打开自御安排」进入。打开时不自动弹出键盘。
3. 使用已有的 `安排/待执行`、`安排/已完成`、`settings/gvkit` 目录。插件不会自动创建或改变一级、二级目录；新测试库须自行准备这三个目录。
4. 未选中时底部输入创建独立事项；点标题查看详情后，同一输入框连续创建其直接下级。收起详情恢复独立事项。完成框只完成本项，子项继续保留。
5. 长按事项标题调整全局顺序；置顶跳过钉住位置。所有操作均可从详情右侧更多进入，其中两列勾选分别配置列表和详情快捷图标。设置日期表示最晚必须在那天完成，详情返回右侧显示同一日期，不会改变顺序。
6. 点「今天达成 x/y」在同一列表上方显示今日未完成必做，下方按完成时间从早到晚显示今日全部完成；再点恢复原列表和滚动位置。已完成保留勾选、无删除线，可直接撤销；界面设置可选淡蓝底板或蓝色文字。x 是今日全部完成数；y 是今日必做总数；红蓝金判断不变。顶部更多保留逾期检查、基础特产投入确认和设置。
7. 手机入口：在安排更多中「复制手机快捷入口」，在 iPhone 快捷指令添加「打开 URL」并粘贴，再添加到主屏幕。入口形式为 `obsidian://gvkit-arrange?vault=<编码后的库名>`，同一入口复用安排视图。
8. 顶部搜索支持关键词、「包含已完成」及日／周／月／年范围组合，左右箭头切换时段、可清除日期条件。待办按必做日期，完成项按实际完成日筛选；周为周一至周日。无关键词时打开「包含已完成」可浏览全部历史并撤销完成；匹配片段浅紫高亮，关闭恢复之前筛选和滚动位置。选择上级时只用关键词，不受完成与日期条件影响。
9. 详情标题左侧可完成／撤销并继续编辑；标题直接按首次点击位置编辑，正文普通文本点击映射到原 Markdown 位置，链接仍可点击。复杂嵌入或渲染转换的文本可能只能定位到附近，需在实际手机验证。
10. 手机详情左右贴边，从整块顶部触摸带拖动；松手时剩余高度不大于关闭阈值（默认25%）则收起，达到全屏阈值（默认80%）则全屏，中间保持拖动高度。关闭前保存编辑；普通正文滚动不触发关闭。
11. 安排界面设置可调列表字号／行高／分隔线、拖动触摸带高度／横杠宽度、详情工具栏高度／上级字号，以及今天达成筛选选中蓝／紫／金强调色。设置即时生效并保存在原状态文件；强调色不改变成就红蓝金与 x/y 事实。
12. 列表字号／行高、详情标题／正文／上级／日期字号均可直接输入非负像素值，支持小数和0，不设产品上限，也不按字号自动抬高行高；实际呈现取决于设备WebView。每项可恢复默认：列表17、行高44、详情18、正文16、上级13、日期12px。标题仅首行为完成框留位，续行顶头。列表与详情勾框、操作图标随各自标题字号缩放，列表／详情图标间距分别可调，默认4／8px，约为原间距的三分之一。
13. 今天和逾期待办在行尾操作图标左边显示「今天」「昨天」「上周日」等相对日期；今天蓝色、逾期红色，未来／无日期不显示，已完成过去日期不冒充逾期。列表和详情共用日期提示字号。列表快捷始终遵从勾选配置，滑动不会再单独展开某行全部图标；完整操作从详情更多进入。

**数据格式**：新建事项使用 UUID v7 文件名与 `gvid`，属性含 `gvkit_arrange: true`、`title`、`parent`（直接上级 GVID 或 null）、`date`（YYYY-MM-DD 或 null）、`completed_at`（ISO 时间或 null）、`pinned`。正文仍为普通 Markdown，编辑不改变 GVID。全局顺序与设置位于 `settings/gvkit/arrange.md` 的 frontmatter：`gvkit_arrange_state: 1`、`order`、`achievedDays`、`timezone`、`fullscreenThreshold`、`rowActions`。只接管明确标记的新事项，不自动导入原有清单。外部编辑顺序时使用同一份 order，不另建局部顺序；多设备先完成现有同步再继续编辑。

**最少手机验收**：分别在 Obsidian 冷启动、后台、打开其他笔记时点主屏幕入口；创建父项和两个下级；核对键盘/语音输入时底部输入可见、切换详情不丢草稿；拖动半屏至全屏后返回；完成父项后下级仍在，重新进入后数据保持。电脑自动测试及窄屏模拟不能替代这些实机验收。

本轮没有重复、奖励点、后台提醒或批量多选；这些属于后续增量，继续保留既有可靠提醒。iPhone 快捷指令图标不支持 GVKit 实时设置数字角标，页面内可查看准确剩余必做数。本轮交互仍待真实 iPhone 验收，原有键盘布局保持。

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
