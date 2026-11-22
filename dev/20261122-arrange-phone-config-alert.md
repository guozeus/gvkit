# 2026-11-22 自御手机“配置异常 · 每日目标暂不可确认”现场核查

状态：09:42 首轮核查正式配置有效；10:11 官方同步端接收损坏版本；12:26 在制作人再次提供截图后复查发现真实损坏并精确修复。正式端修复且上传成功；手机端尚待实机确认。未更改 GVKit 源码或版本。

## 发生与本轮证据（北京时间）
- 制作人约 09:41 反馈手机再次提示“配置异常 · 每日目标暂不可确认”，要求先恢复并定位原因。
- 09:42 通过正式 Vault 受控接口读取 `settings/gvkit/arrange.md`：SHA-256 `f3d0367e5713e20a94f6b2afc7e8936c49f5a754d3f3a97a3111ebc72dd5527f`，12,735 bytes / 337 lines。
- Git 独立快照 `9d4b552` 的同路径文件 SHA 与实时读取一致；使用项目已安装 `yaml` 包进行独立 YAML 解析：0 errors / 0 warnings，51 个顶层字段，`order` 共 263 个不重复、格式有效 UUID；`gvkit_arrange_state: 1`；`achievedDays` 数组正常。
- `dailyGoal: {day: '2026-11-22', id: null, returnedId: '01a1f680-290a-7322-be44-6ca78877a947'}`。GVKit 当前源码 `src/arrangeStore.ts` 的 `validateConfig` 明确允许每日目标 `id === null`。其 `day_rollover` 在前一日目标未完成时正会产生今天 id=null、returnedId=前一日事项的形态；所以该形态不是错误。
- 事项 `安排/待执行/01a1f680-290a-7322-be44-6ca78877a947.md` 仍存在，标题《完全完成一版家园特快原型用户首天体验必须我设计的部分》，`date: 2026-11-22`、未完成。09:38:13 官方 headless Sync 接受了该事项的更新。
- 官方 `obsidian-headless-sync.service` 最后一条配置变更记录为 **11-22 00:00:32** `Push/Downloaded/Accepted settings/gvkit/arrange.md`；截至 09:42:56 服务重复报告 Fully synced。只能说明开发机端同步状态，不能证明手机端实际收到、解析了相同字节，也不能归因于某台设备。
- 已审 `src/arrangeView.ts` 文案来自 `store.configIssue`；`src/arrangeStore.ts` 仅在缺配置、前置解析或校验失败时设置该异常。当前云端原文不满足上述错误条件。因此可能是手机本地仍持有坏/旧版本、版本未同步完成、视图缓存尚未刷新、或手机插件版本/解析器差异；**以上均未在手机端取到原文、版本、Trace，因此不可以选定具体单一原因**。

## 最小恢复路径及边界
- 正式共享配置当前有效，没有进行覆盖性写入、旧版本回滚或重置 `dailyGoal.id`，否则可能破坏今天新数据并再次制造文本合并冲突。
- 手机前台等待 Obsidian Sync 完成后，退出自御视图并重新打开；仍不正常则关闭并重新打开 Obsidian。避免先在手机/iPad对坏配置写入、清空 Vault、卸载重装或恢复整个旧版。
- 若仍报警，先从手机端读取同一路径的实际原文/同步状态/GVKit 版本与已有脱敏 Trace 的 config.invalid 错误阶段，再只修复损坏处；设备侧异常没有本次远程直接读写权限。

## 关联的已证长期结构性风险
- `dev/20261120-arrange-config-recovery.md` 及 `dev/20261119-arrange-sync-resilience.md`：旧故障已证明共享 Markdown YAML 的非语义化合并存在 UUID 断裂风险；真实哪个设备生成当前手机故障未经证实。
- `dev/20261121-arrange-v2-storage-proposal.md`：不可变操作记录/领域状态分离为候选；**尚未实施**，本轮没有扩项改架构。
## 12:25 手机截图与第二次核查、恢复（北京时间）
- 截图证实手机 12:25 仍显示「配置异常 · 每日目标暂不可确认」，并且首行「选择今天特产产出基础目标」；用户此前已执行同步及重新打开建议，单纯重启无效。
- 12:26 正式 Vault 再读 SHA-256 `8eee7278c1317c1328cdd1e8dd2d6921cac00e101a0606e78ef6c295dd912221`、12,848 bytes / 341 lines：`order` 出现 UUID 字符串拼接 `01a1fc89-...-027c8a-1f6d-...` 和两个重复的 UUID，`dailyGoal` 内出现 `id:\n  2\n  id:`，覆盖了先前完整的 `returnedId`。独立备份 Git 快照 `1251d61`（10:20）已保存该损坏版本，具备故障取证。
- 官方 headless Sync 日志表明 10:11:22 收到并接受了此路径的更新。09:42 正常、12:26 损坏，已将损坏时间窗口缩至 09:42–10:11；日志未标识来源设备及合并主体，不能直接推断是 iPad、手机或服务器的具体逻辑制造了损坏。
- 12:26 以精确 SHA 并发保护，通过正式 `obsidian_write` 只做必要修复：删除一条无效拼接 UUID；去除重复排序 ID 并保留最新位于顶部的顺序；恢复 `dailyGoal` 为 `day: 2026-11-22; id: null; returnedId: 01a1f680-290a-7322-be44-6ca78877a947`。其他配置保留，特别是今日新增的 `specialReminderDay: 2026-11-22`。修复后 263 个有效唯一 ID，SHA `1935909fd859d9409f87911f91bc738b96f7f14b80fbc6832e283bb5b0ae02ed`、12,735 bytes / 337 lines；写入记录 `previous_version_id=20261122T042645Z-a7e3a4cab1e3`。
- 12:26:45 官方 headless Sync 日志确认 Upload complete，随后 Fully synced。手机端是否已完成下载、视图是否刷新仍无远程直接证据，需制作人验收。
- 手机最短验收路径：待 Obsidian Sync 下载后，点击自御界面**放大镜右侧**的小省略号（不是 Obsidian 右上角的三点）→「刷新」，核对头部状态与每日目标可选。若恢复后再次损坏，先抓取当时的配置版本、云端 Sync 事件及手机「复制交互诊断（含配置 Trace）」；后台现已有完整坏版本快照及历史对比，避免误认为仅手机缓存。
- 结构性后续仍参考 `dev/20261121-arrange-v2-storage-proposal.md`；方案尚未实施，本次不扩展代码或改数据存储架构。
