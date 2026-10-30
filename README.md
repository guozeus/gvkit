# gvkit

A lightweight Obsidian toolkit focused on fast, native-feeling editing actions.

## 0.6.39 iPhone 一键朗读当前文档

打开 Markdown 文档，点击标题栏的扬声器图标开始朗读，再点停止；切换文档或卸载插件也会停止。直接读取当前文档（包含尚未保存的编辑），略去属性和常见 Markdown 标记，按短段连续朗读，不修改原文。无需配置服务或 Key，使用设备提供的语音能力。

BRAT 更新 `guozeus/gvkit` 至 **0.6.39** 并重载插件。已完成自动化验证，**已发布待制作人真机体验**：iPhone 首次出声、中文可懂度、长文连续播放和停止效果尚需确认。第一版针对前台听读，锁屏或切到后台后的继续播放未验证。

## 0.6.37 自御安排（开发工程与主界面筛选）

- 事项操作增加“开发工程”，再次点击取消；使用独立 `development_project` 标记，与开发完成待验收分开。未完成的工程标题显示紫色，保留正式完成的原有外观。
- 默认主列表隐藏工程全部层级后代；详情仍显示真实直接下级，搜索、今日及逾期入口可查找后代。只改变显示，不修改父子关系或全局顺序。
- 搜索左侧筛选图标可选择全部、无上级、无下级，与搜索、日期条件叠加；按完整事项中的真实父引用和直接下级判断，包含已完成下级。

BRAT 更新 `guozeus/gvkit` 至 **0.6.37** 后重载插件体验。

## 0.6.31 GVKit（宙游文档中心一键发布接口联调）

- 将实际一键发布动作调整为先读 `read_current`，仅在明确返回 `PRODUCER_DOCUMENT_NOT_FOUND` 且本地没有已有文档绑定时执行首次创建；后续创建/更新统一使用 `sync_smart`，并独立读回验证。
- 源 ID 优先使用笔记已有的稳定 GVID（UUID）；旧绑定原样保留。统一正文换行符为 LF，执行 2MB 请求上限。请求发出前保存操作 ID、原地址、动作和完整 payload；断连或回执不确定先核对原操作，不用新操作代替。明确版本冲突才最多三轮重读。
- 对旧版遗留的、不具备完整请求的待确认操作，保留状态而不是自动清空或重新建档；如遇提示需先核对。
- 只修复宙游文档中心发布模块，未改协作板或自御安排。自动化本地模拟验证完成；真实服务首次发布/更新仍待设备实际联调。

在 BRAT 更新 `guozeus/gvkit` 到 **0.6.31** 并重载插件，先用独立测试笔记验证首次创建、修改更新、重复无变化和重启后绑定。

## 0.6.30 GVKit（完成反馈与多设备设置）

- 列表和详情勾选事项成功保存后，播放短促、轻柔的上扬音效；撤销完成、标记开发完成、同步或写入失败均不播放。
- 支持 Vibration API 的设备会尝试一次 18ms 短震。没有此接口的平台（包括常见 iPhone WebView）、系统静音或禁止震动时不保证触觉效果；实际音量、音色和震感需真机体验。
- 安排界面配置继续统一保存在 `settings/gvkit/arrange.md`。同一 Vault 的同步需包含该文件和 `settings` 目录；文件到达另一设备后，已打开的安排界面自动刷新，重新打开也会读取。沿用已有 Vault 同步，不增加服务或另存一份设备配置。离线设备须等待原同步工具完成同步。

在 BRAT 更新 `guozeus/gvkit` 到 **0.6.30** 并重载插件。两项开发完成待制作人验收，实体设备的声音、触觉及实际跨设备同步仍需确认。

## 0.6.28 GVKit（自御安排快捷操作和复制）

- 点击详情左上日期可直接打开原日期操作菜单。
- 自御事项操作移除「打开 Markdown」，新增「复制标题」，可沿用列表／详情快捷操作配置。
- 有附注时，在内容末尾间隔一个字宽显示与附注同字号的复制图标，点击复制当前标题、空行及附注原文；普通附注编辑与链接操作保持。

在 BRAT 更新 `guozeus/gvkit` 到 **0.6.28** 并重新加载插件。本批四项开发完成后仍需制作人实机验收。

## 0.6.27 GVKit（宙游发布配置简化）

宙游文档中心配置只保留「地址＋保存」「Key＋保存」两行。地址支持 HTTP 和 HTTPS，点击保存后生效；Key 直接输入并保存到本设备机密存储。移除机密引用选择器、刷新状态和启停按钮，已有发布绑定保留。

在 BRAT 更新 `guozeus/gvkit` 到 **0.6.27** 并重新加载插件。设备上的实际内网连接与发布效果需实机确认。

## 0.6.24 GVKit（已完成开发状态与快捷添加）

- 在现有「事项更多」中点亮或取消「已完成开发」，也可按原有方式设为列表／详情快捷动作。待验收事项在列表和详情均显示蓝色空框，取消恢复普通空框；此状态不改变正式完成、日期、排序或奖励，仍由制作人亲自勾选验收。
- GPT/Codex 可在原事项 Markdown frontmatter 设置 `development_completed: true`，取消设为 `false` 或删除此字段。不要填写 `completed_at` 或移动文件；旧事项缺少新字段时默认为未标记。
- 桌面底部输入区按 Ctrl+Enter（保留 Cmd+Enter）与点击添加使用同一入口；忽略按住键的重复事件，提交期间不会重复添加。普通回车、中文输入与手机点击行为保留。

在 BRAT 更新 guozeus/gvkit 到 **0.6.24** 并重新加载插件。

## 0.6.23 GVKit（协作板发布身份简化）

发布到 GRealm 协作板时仅使用已验证的本人账号与文档现有 GVID 识别来源，不再要求生成/同步 Vault 命名空间，设置界面移除了相关技术参数。旧版发布的文档及项目授权由服务端兼容读取，用户不需要撤回或重新发布。每台设备仍各自配置发布 Key；自动同步仍限已经本地绑定的文档，尚需跨设备真机验收。前版自御安排、PC 文字格式条和宙游文档中心不变。

在 BRAT 更新 guozeus/gvkit 到 **0.6.23** 并重新加载插件。

## 0.6.22 GVKit（PC 端选中文本浮动格式条修复）

在 PC 版 Obsidian 中选中 Markdown 文本时，修复实时预览中编辑器选区状态暂时不同步导致格式条偶发不显示的问题；当底层选区暂时无法定位时允许回退至有效的编辑器内原生选区。编辑器滚动或窗口缩放后重新定位工具栏，不再直接隐藏。格式按钮、文档内容和移动端界面不变。

在 BRAT 更新 `guozeus/gvkit` 到 **0.6.22** 并重新加载插件，在普通段落、列表和待办项中选择文字实机复验。PC 实际效果以制作人验收为准。

## 0.6.21 GVKit（自御安排：左滑动作、到顶下拉、单项归档）

在 Obsidian 内随手记录、按父子关系组织，并按唯一扁平顺序从上往下执行。事项和顺序均保存在 Markdown，沿用当前 Vault 的同步。

1. 在 BRAT 更新 `guozeus/gvkit` 到 0.6.26，重新加载插件。新设备可用 BRAT 添加同一公开仓库，无需 GitHub Token。
2. 从侧边栏「自御安排」或命令面板「gvkit: 打开自御安排」进入。打开时不自动弹出键盘。
3. 使用已有的 `安排/待执行`、`安排/已完成`、`安排/历史`、`settings/gvkit` 目录。插件不会自动创建或改变一级、二级目录；新测试库须自行准备这四个目录。归档时自动创建历史下缺失的年／月目录。
4. 未选中时底部输入创建独立事项；点标题查看详情后，同一输入框连续创建其直接下级。收起详情恢复独立事项。完成框只完成本项，子项继续保留。
5. 长按事项标题调整全局顺序；钉住保护当前位置，新增、普通置顶和拖动均跳过钉住位置。钉住后置顶图标继续保留，主动点击时在现有钉住位置之间排到最前；钉住、取消钉住本身不移动事项。完成项退出后顺序自然接续。所有操作均可从详情右侧更多进入，其中两列勾选分别配置列表和详情快捷图标。设置日期表示最晚必须在那天完成，详情返回右侧显示同一日期，不会改变顺序。
6. 点「今天达成 x/y」在同一列表上方显示今日未完成必做，下方按完成时间从早到晚显示今日全部完成；再点恢复原列表和滚动位置。已完成保留勾选、无删除线，可直接撤销；界面设置可选淡蓝底板或蓝色文字。x 是今日全部完成数；y 是今日必做总数；红蓝金判断不变。顶部更多保留逾期检查、基础特产投入确认和设置。
7. 手机入口：在安排更多中「复制手机快捷入口」，在 iPhone 快捷指令添加「打开 URL」并粘贴，再添加到主屏幕。入口形式为 `obsidian://gvkit-arrange?vault=<编码后的库名>`，同一入口复用安排视图。
8. 顶部搜索支持关键词、「包含已完成」及日／周／月／年范围组合，左右箭头切换时段、可清除日期条件。待办按必做日期，完成项按实际完成日筛选；周为周一至周日。无关键词时打开「包含已完成」可浏览尚未归档的已完成事项并撤销完成；匹配片段浅紫高亮，关闭恢复之前筛选和滚动位置。选择上级时只用关键词，不受完成与日期条件影响。
9. 详情标题左侧可完成／撤销并继续编辑；标题直接按首次点击位置编辑，正文普通文本点击映射到原 Markdown 位置，链接仍可点击。复杂嵌入或渲染转换的文本可能只能定位到附近，需在实际手机验证。
10. 手机详情左右贴边，从整块顶部触摸带拖动；松手时剩余高度不大于关闭阈值（默认25%）则收起，达到全屏阈值（默认80%）则全屏，中间保持拖动高度。正文滚动到顶并松手后，再明确下拉可关闭；打开时已在顶部也可下拉。界面设置中的「详情到顶下拉关闭」默认开启，关闭它不影响顶部抓取带。关闭前保存编辑，文字编辑／选择、普通滚动、下级操作不触发正文下拉关闭。
11. 安排界面设置可调列表字号／行高／分隔线、拖动触摸带高度／横杠宽度、详情工具栏高度／上级字号，以及今天达成筛选选中蓝／紫／金强调色。设置即时生效并保存在原状态文件；强调色不改变成就红蓝金与 x/y 事实。列表小树形标记表示存在直接下级（包括未归档的已完成下级）；钉住竖条默认金色，可选紫色或蓝色。勾选框默认原尺寸的80%，列表与详情共用比例设置；右侧日期／图标前默认留2个列表字宽，可配置留白字宽。
12. 列表字号／行高、详情标题／正文／上级／日期字号恢复滑条调节与原设置顺序，旁边保留精确输入；输入超出当前滑条范围时自动扩展，支持小数和0，不设产品上限，也不按字号自动抬高行高。实际呈现取决于设备WebView。每项可恢复默认：列表17、行高44、详情18、正文16、上级13、日期12px。标题仅首行为完成框留位，续行顶头。列表与详情勾框、操作图标随各自标题字号缩放，列表／详情图标间距分别可调，默认4／8px，约为原间距的三分之一。
13. 今天和逾期待办在行尾操作图标左边显示「今天」「昨天」「上周日」等相对日期；今天蓝色、逾期红色，未来／无日期不显示，已完成过去日期不冒充逾期。列表和详情共用日期提示字号；“今天与日期提示颜色”提供鲜亮蓝（默认）、电光蓝、亮青蓝，逾期红色与顶部成就状态不变。列表快捷始终遵从勾选配置，滑动不会再单独展开某行全部图标；完整操作从详情更多进入。

14. 向左滑动事项标题／主体，松手后执行一个快捷操作，默认打开原日期菜单；在「安排界面设置 → 事项左滑操作」可更换或关闭。主列表与详情直接下级共用，常驻图标勾选独立保留，右滑不执行操作。
15. 在事项更多点「归档」，将这一项原 Markdown 移到 `安排/历史/YYYY/MM/`（按归档当天与统一时区）；同名目标不会覆盖。归档可独立勾选列表／详情常驻，两处默认均隐藏，也可设为左滑动作。归档退出当前列表、搜索、排序与上级候选，父项归档不会带走子项。归档不产生或删除完成记录：今天完成的 x 保留，当前必做 y 排除归档项，因此数字不一定等于可见行数。暂不提供历史查看或恢复界面，原 MD 仍保留在历史目录。

**数据格式**：新建事项使用 UUID v7 文件名与 `gvid`，属性含 `gvkit_arrange: true`、`title`、`parent`（直接上级 GVID 或 null）、`date`（YYYY-MM-DD 或 null）、`completed_at`（ISO 时间或 null）、`pinned`。正文仍为普通 Markdown，编辑不改变 GVID。全局顺序与设置位于 `settings/gvkit/arrange.md` 的 frontmatter：`gvkit_arrange_state: 1`、`order`、`achievedDays`、`timezone`、`fullscreenThreshold`、`rowActions`、`detailActions`、`swipeAction`、`pullDownClose`。只接管明确标记的新事项，不自动导入原有清单。外部编辑顺序时使用同一份 order，不另建局部顺序；多设备先完成现有同步再继续编辑。

**最少手机验收**：分别在 Obsidian 冷启动、后台、打开其他笔记时点主屏幕入口；创建父项和两个下级；核对键盘/语音输入时底部输入可见、切换详情不丢草稿；拖动半屏至全屏后返回；完成父项后下级仍在，重新进入后数据保持。电脑自动测试及窄屏模拟不能替代这些实机验收。

本轮没有重复、奖励点、后台提醒或批量多选；这些属于后续增量，继续保留既有可靠提醒。iPhone 快捷指令图标不支持 GVKit 实时设置数字角标，页面内可查看准确剩余必做数。本轮交互仍待真实 iPhone 验收，原有键盘布局保持。

## 协作板发布（2026-10-22 首轮本地候选）

- 在协作板网站「我的机器凭据」生成本人发布 Key（默认永不过期，可随时撤销），复制到 Obsidian → gvkit →「发布到协作板」→「发布 Key」并点「保存」。Key 只进入本机 Obsidian SecretStorage，不写入笔记或共享插件数据。不同设备使用同一个发布者账号与 Markdown GVID 找到原协作关系，不再生成或配置额外的 Vault 命名空间。
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

## 0.6.25 自御安排移动布局

自御界面使用宿主的 `data-ignore-swipe` 标记隔离页面横滑，保留事项左滑和文字选择。底部输入随内容增高，默认最多六行，之后内部滚动；移动详情随输入区上移。附注默认留出三行，两项行数均可在现有「安排界面设置」调整。首次标题聚焦的键盘布局调整保留原滚动位置与光标；iPhone 原生手势和键盘效果待真机体验。
