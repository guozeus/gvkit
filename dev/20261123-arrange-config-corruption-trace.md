# 2026-11-23 自御仅手机打开仍复发：取证、恢复及阶段0 Trace

## 意图
制作人明确自上次正常打开后未再操作其他设备 Obsidian，手机又报配置异常。本次优先核查实际损坏、保存证据、精确修复，至少给下次问题补齐写入过程的本机诊断。不在因果证据不足时指责具体设备或 Sync 内部模块。

## 已证实的北京时间现场
- 00:10 有效 Vault Git 快照 edf4b17：settings/gvkit/arrange.md 内266个合法唯一排序ID，dailyGoal.day=2026-11-23，id=null，returnedId保留；specialReminderDay=2026-11-22。
- 07:15:46 正式 Headless Sync 接受一次该文件更新：Push(updated)→Downloading→Downloaded→Accepted→Fully synced。仅证明到达开发机，不署名哪台设备生成。
- 当前损坏 SHA-256：01e212c0610bff280641d4a07782c57754e202729eccffea4b950ede1f6fff00；13,340字节，351行。排序277条、267种字符串，其中10组重复有效ID与1个两个UUID粘连的非法字符串；dailyGoal未坏，specialReminderDay变为2026-11-23。
- 07:19:28 主动执行既有 Vault Git备份，完整损坏原件以 a5dc33a 保全，并核实其 SHA 与当前坏文件一致。路径：/var/lib/private/obsidian-git-backup/repo.git 中 a5dc33a:settings/gvkit/arrange.md。
- 损坏排序过滤非法项并去重后，剩余266项与00:10正常版本顺序逐条一致。将当前坏排序块替换成正常块后，相比00:10版本仅剩 specialReminderDay 从22日更新到23日。没有丢失事项身份，没修改事项正文。
- 07:19:43 对原损坏文件进行受控精确修复，只替换排序块，保留今天目标、特别提醒日及其余配置。修复 SHA-256：e0488337351eb9529dfb768a96d414229c703015af046d4f1c96932d3c483c12，12,858字节，340行，266个有效唯一ID。Headless Sync确认 Upload complete/Fully synced，事后再读仍有效。
- 本次原生0.6.77成功写入不记录Trace；iPhone Sync Activity不可直接取得。故不能精确证实非法拼接最早发生在手机插件写入还是 Sync 文本合并。当天首次进入自动更新 special_reminders 与顺序，属于重点诱因。用户未打开其他设备，不代表历史版本及 Sync 合并不存在。

## 阶段0诊断补丁（0.6.78）
依照 11/22 独立审核共识：先补必要关键日志，不修改旧YAML业务存储规则。
- src/arrangeTrace.ts：记录插件启动、配置读取成功指纹、运行起点、跨天/特别提醒启动、配置写入前源指纹、写入候选指纹、提交及写后实际读回、Vault修改通知与稍后观察到的内容指纹、具体异常阶段。含UTC/偏移、稳定匿名设备ID、会话ID、版本、run/seq和触发器；指纹为 FNV32+长度，是比对线索而非密码学SHA或设备来源证明。
- 设备本地最多240条滚动事件，独立冻结最近6次异常各自前36条证据；不写同步配置、用户原文、事项ID、凭据、错误原句；诊断失败不会影响用户数据写入。
- src/arrangeStore.ts：首次创建与普通process均覆盖成功候选/写回/读回，特别提醒自动运行增加起止事件。
- src/arrangeView.ts：无论是GVKit自身、第三方还是Sync的文件修改，都标明来源unknown，不伪造来源归属；配置指纹读回。保留自御内「复制交互诊断」，另增加 Obsidian 命令面板「复制自御配置诊断日志」，无须先成功打开自御视图。
- tests/arrangeTrace.test.ts 定向验证持久化、异常上下文保留、写入成功记录、坏文件不会被覆盖、11/23 同型UUID拼接、诊断不可用时业务仍可写。TypeScript生产构建及定向测试通过。

## 后续边界
阶段0不是根治；须按 dev/20261121-arrange-v2-storage-proposal.md 的已经审核共识推进 v2 阶段1（分领域＋不可变操作记录＋本地投影＋一次性切换权威），让旧YAML文本合并不能污染新权威。至少验收同机连续进入、跨天自动行为、迟到版本、真机iOS及旧端重新同步。新 Trace 只有 iPhone 通过 BRAT 升级0.6.78后才能捕捉后续成功写入，不能追补旧版历史。

发布核验：0.6.78 正式发布，Git提交/仓库master/tag均指向 c525a8e696cbd72d4477b09257dfd52e15360457。GitHub Release https://github.com/guozeus/gvkit/releases/tag/0.6.78 非草稿、非预发布、最新版本；匿名 GET 三安装资产 main.js / manifest.json / styles.css 均 HTTP 200 且 SHA-256 与本次实际生产构建逐字节相同。GitHub 仓库原 origin.pushurl 防误推封锁保持不变。手机端 BRAT 尚须制作人自行更新完成真机复验。
