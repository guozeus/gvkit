# 2026-11-20 GVKit 自御共享配置损坏及恢复

## 意图与结果
恢复制作人原来调整好的自御界面、详情操作按钮及勾选保存能力；保留全部事项原件，避免全库回退。已直接修复正式 Vault 的 settings/gvkit/arrange.md，未变更 GVKit 源码、发布版本、事项原件或其他设置。

## 运行证据（北京时间）
- 11月20日 04:09:41，官方 obsidian-headless-sync.service 收到并接受了 settings/gvkit/arrange.md 更新。对比 11月19日13:20 正常备份 0b0ecc5，该版本将详情默认操作 specialReminder 从 detailActions 删除，其余显示配置未见变化；无法仅凭日志确认写入设备/会话。
- 05:10:03，独立 Vault Git 快照 553ed77 配置有效：order 为256条、256个唯一有效 UUID；SHA-256 98dcdcad001348f2a2b3b94e18988f10be1cfb2dd5aacdf5cfc62ce50e9f58ab。
- 08:48:41，官方 headless Sync 日志记录 Push: settings/gvkit/arrange.md (updated) → Downloaded → Accepted。08:50:02 快照 35acedf 的该文件 SHA-256 9c8de5b4f96c39479af9ef9d7058fe4321e546a5f16a1068c9a5364362caeff8，YAML 无法解析。损坏集中在 order，含两个 UUID 粘连、一条无缩进 UUID 尾段、4个重复项；259个表面列表项仅255个唯一值，丢失两条原有效 UUID。与05:10快照相比，其他50个配置字段的原始文本一致。
- GVKit 0.6.77 ArrangeStore 配置不合法时回退本机默认/最后正常显示配置，并拒绝业务写入，因此会出现字体回到默认、勾选/界面设置无法保存；不等于事项原件已丢失。

## 已执行的最小恢复
1. 通过受控 Vault obsidian_replace、当前 SHA 乐观并发保护，只把08:50损坏的 order 替换为05:10快照的正常排序。先在隔离内存校验 YAML 可解析、无重复键、256个独立有效UUID及其余字段逐字不变；正式恢复后 SHA=98dcdcad001348f2a2b3b94e18988f10be1cfb2dd5aacdf5cfc62ce50e9f58ab。08:57:18 官方 headless Sync 日志确认成功上传。
2. 鉴于用户明确要求恢复原来默认显示的功能项，再使用 SHA 条件写入，精确恢复 11月19日13:20正常备份中的详情按钮 specialReminder（只增加此按钮，不改其他动作）。最终正式文件 SHA-256 d1f0039f70731b5d275d4432d9a275b34dad82fe7625a490260ad01fc0515ddf，12,373 bytes、327行；08:59:20 官方 Sync 日志确认成功上传。
3. 恢复前损坏文件已有 35acedf 独立 Git 快照，另有 obsidian_replace 返回的 previous_version_id。未对全 Vault 执行 checkout/restore。

## 原因边界、验收与后续
- 已证：正式配置在同步更新后损坏，而现行0.6.77的降级保护导致勾选/设置不可保存；恢复后正式配置有效，官方 headless Sync 已成功上传。此前11月19日开发记录对官方 headless 0.0.14 原样文本合并做过合成复现，证明它在特定三方合并中能够产生 UUID 断裂。
- 未证：本次究竟由哪一设备、哪个会话触发写入；断裂究竟发生在上游客户端、服务端合并还是后续传输。仅凭 Push/Accepted 不能归责或宣称跨设备根因已经永久修复。
- 待制作人在iPhone/iPad端完成真实体验：等待 Obsidian Sync 到达，重新打开自御，检查原先的字体、详情特别提醒及勾选保存。如果再次损坏，先核当前 SHA 和 Sync 版本历史/设备日志，再做同步根因专项，不反复盲目还原、不改事项原件。
