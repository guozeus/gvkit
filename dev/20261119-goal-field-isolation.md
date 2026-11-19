# 未确认返回目标的字段隔离（2026-11-19）

本轮仅制作补丁，不发布、不修改正式 Vault 或同步设置。基线为 0.6.76。未知的 `dailyGoal.returnedId` 只影响昨日目标返回展示，不作为事项完成或奖励结算的凭据。

## 行为

- YAML 与核心配置仍须有效。只有返回目标字段不完整时，保留磁盘原值及原目标 day/id，投影中不使用无法确认的身份；不猜补、不重置。
- 普通新增、完成、钉住及其他无关配置可保存，沿用最新字段范围更新和并发保护。目标设置、任何 dailyGoal 变更及自动跨天被阻止。正常目标选择和跨天保持原行为。
- 复用配置异常的按指纹一次提示，指纹只取目标块，普通保存不会重置提示。页内保留轻量待确认提示。Trace 仅记录异常类别、触发及指纹，不记录原字段或事项正文。不把不完整投影缓存为完整有效配置。

## 定向验收

`npx tsc --noEmit --skipLibCheck` 通过。

`node --experimental-strip-types --test tests/arrangeGoalIsolation.test.ts tests/arrangeTrace.test.ts tests/arrangeIntegration.test.ts tests/arrangeRewards.test.ts tests/arrangeViewport.test.ts`：13 项通过，0 失败。

新增测试使用真实 Store、隔离 Vault 和严格 YAML 解析器（yaml 2.9.1 仅 devDependency），合成身份与正文，覆盖：裸排序断行加重复空键的损坏形状；只补排序仍不可解析；两处结构修正后返回目标单字段隔离；新增/钉住/完成、重复完成不再发奖励、旧奖励记录保留；未知目标不跨天且不能替换；正常目标选择/跨天；保存期间并发到达的新目标和无关设置保留。既有 Store/View Trace 测试检查轻量提示和普通保存。

未跑全量、未做本补丁的真实设备或真实 Sync 验收。隔离 Vault 的并发注入不是跨设备 Sync 的证明。

## 未应用的生产候选

私有忽略目录 `.local/arrange-production-candidate-20261119/` 保存 preimage、candidate 和 receipt；文件权限 0600、目录 0700，不提交真实配置。候选只修复一条已由历史独立证实的排序 UUID 断行，并删除第二个同值空 id 键；截断 returnedId、目标 day/id、重复排序及其他所有字节保留。receipt 记录原件与候选 SHA-256、两处差异及字节数。未来应用必须重新读取并精确匹配原件 SHA，变化就停止并重新审查，不用旧候选覆盖。

正式配置仍未修正语法，因此本次源码提交不等于正式环境已经恢复编辑。此补丁也不解决 Markdown 多端字符合并的长期根因。
