# 2026-11-22 自御手机“配置异常 · 每日目标暂不可确认”现场核查

状态：正式共享 Vault 配置核实有效；本轮没有理由执行回滚或写入；手机端是否恢复需要真机确认。仅诊断记录，未实施新版架构、未改源码、未部署。

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
