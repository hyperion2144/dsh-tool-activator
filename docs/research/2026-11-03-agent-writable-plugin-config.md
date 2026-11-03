# 初查：agent 可在运行期改写插件自身配置（`groups` → `<available_tools>`）

日期：2026-11-03（Asia/Shanghai）。范围：DSH 核心源码 `/Users/mutou/vault/projects/deepseek-harness`（`@deepseek-ai/dsh-root` 0.2.2-alpha.3，commit `8bd073392eef6f54e921a093b95076248eb08cbb`）与本插件源码的静态交叉核对；不含真实 GUI 端到端复现。

## 问题

dsh-tool-activator 想新增一个「agent 可调用的工具」，让模型在会话中直接把插件自己的配置字段 `groups` 改写掉，从而重组 `<available_tools>` 目录。需要确证五件事：

1. 宿主插件能否在运行期写自己的 Config：`ctx.settings` 的 `update` / `mutate` / `replace` 分别是什么签名、有什么写入门槛（是否要求字段落在 `.volatile()` 那部分）、revision 冲突如何拒绝。
2. 一个插件如何拿到自己对应的 profile entry id（也就是 settings 的 `ns`）。
3. `.volatile()` 的 Config 被写入后，是否热更新到插件自己的 `config.get()`、是否需要 reload 或重启；`loader/volatile-update`、`app-boot/config-reload`、`settings/document-updated` 分别在什么时机触发、谁订阅、传播到插件配置的链路。
4. 写入之后，插件依赖该配置重建的提示词（`<available_tools>` 工具目录）会在下一个 step 的装配里生效吗。
5. 从「工具执行（tool execute）」的调用栈里写配置有没有限制。

## 结论（已确认）

**结论 1（能写，但只有 `.volatile()` 覆盖的字段能通过 `ctx.settings` 写）**：`ctx.settings` 提供三个异步写入口 —— `update(ns, patch, expectedRevision?)`、`replace(ns, section, expectedRevision?)`、`mutate(ns, ops, expectedRevision?)`；写入门槛是「条目必须存在且当前 ACTIVE」＋「目标字段必须落在 schema 的 `.volatile()` 之下」，不满足时抛 `Config field "…" is not volatile`；revision 冲突抛 `SettingsConflictError`（`code = 'SETTINGS_CONFLICT'`，带 `expected` / `actual`），且 `expectedRevision` 是可选参数 —— 不传即无条件写、不会被冲突拒绝。

**结论 2（能可靠拿到，路径是 `ctx.fiber.entry?.options.id`）**：settings 的 `ns` 就是 Loader 条目的 `options.id`（不是带前缀的 `entry.id`）；宿主插件 `plugin-market` 就是用 `ctx.fiber.entry?.options.id` 拿到自己的 ns 并 `settings.update()` 写自己的配置，因此这条路径是宿主认可的用法；`ctx.loader.locate()` 返回的是带前缀的 `entry.id`（如 `include:xxx`），**不能**直接当 `ns` 用。

**结论 3（会热更新，不需要 reload 或重启）**：写入沿 Loader 的 volatile 通道把新值就地 `updateVolatile` 进插件手里**同一个**引用对象，插件 fiber 不重启，下一次 `config.get()` 直接拿到新值；宿主仓库自带测试断言了「写入后 fiber 对象不变、消费者即时可见」。

**结论 4（会在下一个 step 生效）**：系统提示词在**每个 step** 装配一次，且本插件在装配瀑布里现读 `config.get()`，所以下一个 step 的 `<available_tools>` 就是重组后的目录。

**结论 5（没有 session/agent 归属限制，也没有会被并发写打断的机制）**：`ctx.settings` 的写入路径里完全没有 session / agent 概念，写的是 profile 级条目、对该 profile 的所有会话生效；并发写被文件锁与 HMR 独占串行化，但**同一 revision 的并发写有一方会被 revision 冲突拒绝**，不传 `expectedRevision` 时则是后写覆盖。

## 证据

### 1. `ctx.settings` 的三个写入口与写入门槛

三个公开写方法（同文件、同一个类）：

| 方法 | 签名 | 合并基线 | 用途 |
| --- | --- | --- | --- |
| `update` | `update(ns: string, patch: object, expectedRevision?: number): Promise<void>`（`packages/settings/settings/src/index.ts:348`） | 当前用户段：`mergeLayers(current, patch)`（`packages/settings/settings/src/index.ts:350`） | 局部改写字段 |
| `replace` | `replace(ns: string, section: object, expectedRevision?: number): Promise<void>`（`packages/settings/settings/src/index.ts:358`） | 继承层：`mergeLayers(base, section)`（`packages/settings/settings/src/index.ts:360`） | 整段重置，普通字段保留 |
| `mutate` | `mutate(ns: string, ops: readonly SettingsPathOp[], expectedRevision?: number): Promise<void>`（`packages/settings/settings/src/index.ts:368`） | 当前用户段逐路径应用（`packages/settings/settings/src/index.ts:369-375`） | 按路径 `set` / `unset`，不重述被脱敏的 secret |

- `SettingsPathOp` 只有两种：`{ op: 'set'; path; value }` 与 `{ op: 'unset'; path }`（`packages/settings/settings/src/index.ts:81-83`）。
- 三个方法都收敛到私有 `write(ns, change, expected?, paths?)`（`packages/settings/settings/src/index.ts:378-424`），门槛都在这里：
  - 条目必须能按 `options.id === ns` 找到，否则 `No configurable plugin entry "${ns}"`（`packages/settings/settings/src/index.ts:383-385`）。
  - 条目必须有 schemastery `Config`（`packages/settings/settings/src/index.ts:426-429`）且其中至少有一个 volatile 字段，否则 `Plugin entry "${ns}" has no volatile fields`（`packages/settings/settings/src/index.ts:386-387`，判定见 `packages/settings/settings/src/schema.ts:37-47`）。
  - `mutate` 的每条路径必须在 volatile 之下，否则 `Config field "${path}" is not volatile`（`packages/settings/settings/src/index.ts:388-390`，判定见 `packages/settings/settings/src/schema.ts:74-79`）。
  - 写入结果里的每个键还会在 `validatePaths` 里再查一次 volatile，否则同样抛 `not volatile`（`packages/settings/settings/src/index.ts:400-410`）；普通字段由 `strip` 从写入结果里剔除，保证普通配置不被覆盖（`packages/settings/settings/src/index.ts:411-421`）。
- revision 冲突：`expected !== undefined && descriptor.revision !== expected` 时抛 `SettingsConflictError`（`packages/settings/settings/src/index.ts:394-396`），该错误 `code = 'SETTINGS_CONFLICT'` 且带 `expected` / `actual`（`packages/settings/settings/src/index.ts:45-64`）。冲突判定用的是**写入时刻**现读的 revision（`packages/settings/settings/src/index.ts:392`）。
- 更底层还有一层拒绝：`ConfigEditor.edit` 要求条目仍在、fiber 仍 ACTIVE（`packages/boot/config-editor/src/index.ts:94`、`:102`），并用 `fiber.resolveConfig(next)` 做 schema 校验（`packages/boot/config-editor/src/index.ts:103`），被更高层的 home patch / 命令行覆盖时抛 `Configuration for "…" is overridden by a home patch or command-line overlay`（`packages/boot/config-editor/src/index.ts:138-139`）。
- 远程线路上的等价封装（客户端配置页走的就是它）：`packages/api/settings-controller/src/index.ts:115-158`，拒绝被归类为 `settings/conflict` 或 `settings/rejected`（`packages/api/settings-controller/src/index.ts:257-268`）。
- 对本插件而言门槛已满足：`Config` 是 `Schema.object({ … }).default({}).volatile()`，即**根节点就是 volatile**（`src/config.ts:20`），因此 `groups` 及其兄弟字段全部可写（宿主对「volatile 根」的同款写法有测试覆盖：`packages/settings/settings/tests/configuration.spec.ts:142-148`）。

### 2. 插件如何拿到自己的 `ns`

- settings 的 `ns` 取值就是条目的 `options.id`：写入 revision 表时 `ns: entry.options.id`（`packages/settings/settings/src/index.ts:315`），描述符里同样（`packages/settings/settings/src/index.ts:327`），反查条目时也按 `row.options.id === ns`（`packages/settings/settings/src/index.ts:383`）。
- `Fiber` 上有可读的 `entry`（`vendor/loader/src/index.ts:52-54`）；Loader 在 `internal/plugin` 事件里把它挂上：`fiber.entry = fiber.parent[Entry.key]`（`vendor/loader/src/index.ts:128-134`）。该事件在插件回调执行之前发出（`vendor/cordis/src/fiber.ts:308`，回调在 `_reload` → `_execute` 中才跑，`vendor/cordis/src/fiber.ts:254-266`），所以插件 `apply` 里 `ctx.fiber.entry` 已经就绪。
- 宿主插件的既有用法（直接证据）：`this.entryId = ctx.fiber.entry?.options.id`（`packages/boot/plugin-market/src/index.ts:136`），随后 `await settings.update(this.entryId, { indexes: normalized })`（`packages/boot/plugin-market/src/index.ts:210-214`）。另一个宿主插件走更底层的门：`editor.edit(entry, …)`，其中 `entry = this.ownerContext.fiber.entry`（`packages/core/agent-default-model/src/index.ts:85-96`）。
- **不能用** `ctx.loader.locate()`：它返回 `fiber.entry.id`（`vendor/loader/src/index.ts:194-202`），而 `Entry.id` 是带父前缀的（`vendor/loader/src/config/entry.ts:67-73`），与 `ns` 不是同一个字符串。
- `ctx.settings` 的可达性：服务在 `Context` 上声明为 `settings: SettingsForms`（`packages/settings/settings/src/index.ts:38-43`），由 `super(ownerContext, 'settings')` 注册（`packages/settings/settings/src/index.ts:231`）；基础组合里有挂载记录（`apps/cli/composition.md:234`）。插件可以 `inject(['settings'])`（`packages/core/agent-default-model/src/index.ts:61`）或 `ctx.get('settings')`（`packages/boot/plugin-market/src/index.ts:210`）取得它。

### 3. `.volatile()` 写入的热更新链路与三个事件

完整链路（每一步都有源码位置）：

1. `SettingsForms.write` → `configEditor.edit(entry, change)`（`packages/settings/settings/src/index.ts:391`）。
2. `ConfigEditor.edit` → 取文件锁（`packages/boot/config-editor/src/index.ts:93`）→ 校验条目仍在 / fiber ACTIVE（`:94`、`:102`）→ schema 校验（`:103`）→ 改写 profile patch 文档（`:119-127`）→ 原子落盘（`:141`）→ `reconcileProfilePatches(root, patches, 'dsh', [entry.options.id])`（`:143`）。
3. `reconcileProfilePatches` → `recompose`（`packages/boot/app-boot/src/index.ts:320-323`、`:326`）→ 根 Include 条目 `entry.update({ config: { …includeConfig, patches: prepared } })`（`packages/boot/app-boot/src/index.ts:390`）。Include 自己在 `internal/update` 上拦截并接管（不调用 `next()`，因此不触发 fiber 重启），转而 `_scheduleApply()`（`vendor/include/src/index.ts:126-132`）→ `this.root.update(tree)`（`vendor/include/src/index.ts:456`）。
4. `EntryGroup.update` 对每一行 `this.create(newMap[id])`（`vendor/loader/src/config/group.ts:49-60`）→ `entry.update(options, true, true)`（`vendor/loader/src/config/group.ts:27`）。
5. `Entry.update` 判定这是「只有 volatile 变化」：`changes` 只有 `config`、fiber ACTIVE、上下文原型未变、`equalExceptVolatile` 成立（`vendor/loader/src/config/entry.ts:146-151`）→ 走 `_commitVolatile()`（`vendor/loader/src/config/entry.ts:153`、`:167`）。本插件的 Config 根就是 volatile（`src/config.ts:20`），`equalExceptVolatile` 在根节点直接判等（`vendor/loader/src/config/diff.ts:17-18`），所以任何配置改动都算 volatile-only。
6. `_commitVolatile` 解析候选配置，比对快照后 `updateVolatile(ref, source)`（`vendor/loader/src/config/entry.ts:184-189`）—— `updateVolatile` 就是把**目标引用**的当前值换成来源值（`vendor/cosmokit/src/volatile.ts:84-86`）。这里的 `ref` 就是插件 `apply` 拿到的那个 `config` 对象本身（volatile 根由 `createVolatile` 包装，`vendor/schemastery/src/index.ts:521-527`），因此**插件的 `config.get()` 立刻返回新值，无需 reload**。
7. 随后 `fiber.ctx.emit(self, 'loader/volatile-update', paths)`（`vendor/loader/src/config/entry.ts:191-194`）；该 `thisArg` 带 `Context.filter` 过滤，只有**该 fiber 自己的**监听者会收到（`vendor/cordis/src/events.ts:168-170`）。事件声明见 `vendor/loader/src/index.ts:29-34`。宿主内订阅者示例：`packages/boot/plugin-market/src/index.ts:159`、`packages/mcp/mcp-manager/src/index.ts:252`、`packages/llm/llm-deepseek/src/host.ts:83`。本插件目前**没有**订阅它 —— 它是「用到时现读 `config.get()`」的写法（`src/host.ts:306-310`），因此不需要订阅也能拿到新值。
8. `recompose` 收尾发 `app-boot/config-reload`（`packages/boot/app-boot/src/index.ts:407`，事件声明 `:50-57`）；settings 服务订阅它并 `invalidate()`（`packages/settings/settings/src/index.ts:234`、`:279-287`），下次 `describe()` 时若 raw 变了就 `revision + 1` 并发 `settings/document-updated`（`packages/settings/settings/src/index.ts:314-318`），条目消失时也发一次（`:334-339`）。事件声明见 `packages/settings/settings/src/types.ts:66-76`，并经远程事件桥接到客户端（`packages/api/remotes/src/remote-events.ts:55`）。
9. 宿主自带测试直接断言了「写入后不重挂载、消费者即时可见」：`packages/settings/settings/tests/configuration.spec.ts:9-20`（同一 `fiber` 对象 + 消费者立即读到新值）。

### 4. `<available_tools>` 是否在下一个 step 生效

- 装配时机：每个 step 的 `preStep` 里先解析本步工具集、再装配提示词（`packages/core/agent-loop/src/agent.ts:292`、`:294`），`assemble` 内部跑 `system-prompt/assemble` 瀑布（`packages/core/system-prompt/src/index.ts:620`、`:683-686`）。
- 插件在瀑布里现读配置：`const policy = policySnapshot()`（`src/host.ts:205-207`），而 `policySnapshot()` 就是 `config.get()`（`src/host.ts:306-310`）。
- 目录由 `policy.groups` 重建（`src/catalog.ts:34-35`），文本由 `availableToolsPrompts` 产出 `<available_tools>`（`src/prompt.ts:13-18`），经 `activationPrompt` 放入变量 `tool_activator_context`（`src/prompt.ts:41-63`、`:91`），而运行时上下文 `{{tool_activator_context}}` 在渲染期插值（`src/host.ts:199-204`；渲染见 `packages/core/system-prompt/src/index.ts:336-343`）。
- 提交到会话：每步 `renderPrompt(assembly)` 后由 `systemPrompt.project` 决定是否落一条新的 system 消息 —— 能力允许的续写序列追加新节点，否则改写首节点（`packages/core/agent-loop/src/agent.ts:442`、`:453`；判定见 `packages/core/agent-loop/src/runtime-context.ts:93-108`）。
- 同一 step 内的工具视图也在装配前一刻读配置：隐藏闸门的 resolver 现取 `policySnapshot()`（`src/host.ts:156-162`），而工具集在 `preStep` 里先于装配解析（`packages/core/agent-loop/src/agent.ts:292`）。因此**写入若在本步装配前完成**，本步即可见；若在本步装配后才完成，则下一个 step 可见。

### 5. 从 tool execute 调用栈写配置的限制

- 工具体就是在普通异步调用里跑的：`const returned = await tool.execute(exec.arguments, exec)`（`packages/core/tools/src/pipeline.ts:275`），外面包着 `tools/pre-execute` 闸门、审批与 guard（`packages/core/tools/src/pipeline.ts:190-233`）。这条路径上**没有**任何禁止写配置的检查。
- **没有 session / agent 归属校验**：`SettingsForms.write(ns, change, expected?, paths?)` 的入参里没有 session / agent（`packages/settings/settings/src/index.ts:378-382`），`ConfigEditor.edit(entry, change)` 同样没有（`packages/boot/config-editor/src/index.ts:87-90`）。写的是 profile 级条目，对该 profile 的所有会话与 agent 生效 —— 也就是说宿主**不提供**归属隔离，若需要只能由插件自己加。
- **没有「调用方必须在某个 fiber 生命周期内」的要求**：门槛落在**被写条目**上 —— 条目必须仍在 `configEditor.entries()` 里且 fiber 为 ACTIVE（`packages/boot/config-editor/src/index.ts:94`、`:102`）。调用方从任意工具执行栈发起都可以。
- **并发写不会被「打断」**：写入全程在 profile 目录的文件锁内（`packages/boot/config-editor/src/index.ts:93`），并与 HMR 独占（`:151-152`）。但同一 `expectedRevision` 的并发写会有一方被拒（`packages/settings/settings/src/index.ts:394-396`；宿主测试：`packages/settings/settings/tests/configuration.spec.ts:48-61`）；不传 `expectedRevision` 时是后写覆盖。
- **写入失败会回滚，不会留下半份配置**：profile patch 文件原子落盘（`packages/boot/config-editor/src/index.ts:141`），随后 reconcile 失败时把文件写回旧内容并重新 reconcile 旧 patch，然后才把错误抛出（`packages/boot/config-editor/src/index.ts:142-148`）。
- **写入期间会等待整个 profile 收敛**：`recompose` 会 `await Promise.allSettled(previousFibers.map(fiber => fiber.await()))` 与 `ctx.loader.await()`（`packages/boot/app-boot/src/index.ts:395-396`），因此工具必须 `await` 这个写入，写入耗时受其它插件 fiber 收敛影响。
- **写入不消费工具的取消信号**：`ConfigEditor.edit` 不接受 signal，被中止的 step 不会撤销已经发出的配置写入。

## 仍未确认

- 没有在真实 GUI 里跑通「模型调用工具 → 写配置 → 下一个 step 的 `<available_tools>` 变化」这条端到端链路；本笔记结论全部来自源码与仓库内测试。
- 未在本次运行的 profile 里核实 `settings` 服务是否已挂载（`apps/cli/composition.md:234` 只记录基础组合的挂载关系）。
- 模型自由写 `groups` 时会同时撞上两层约束：宿主 schema 要求 `identifier` 非空且匹配 `/^[\w.-]+$/u`（`src/config.ts:6`、`:10-20`），本插件 `validatePolicy` 还要求 identifier 不重复、每组至少一个工具、工具不跨组重复（`src/config.ts:24-40`）。这两层约束在「模型自由写」场景下的错误呈现与可恢复性未实测 —— 这正是上一份笔记里「空标识符被宿主拒绝」的同一条路径（见相关票 #1）。
- 写入 `groups` 后，本插件已激活工具的隐藏闸门如何与「组定义变化」交互（例如某工具从 A 组移到 B 组后，旧的激活记录是否仍生效）未验证。

## 相关票

- 无开放票对应本需求；本笔记是实现前的事实核查记录。
- 相邻已关闭票（仅作约束参考）：[#1 会话在 0.2.2 崩溃（瀑布不再含 tools）＋ 配置页新增分组被拒（空标识符）](https://github.com/hyperion2144/dsh-tool-activator/issues/1)、[#6 配置页优化：写入防竞态、工具单分组归属、卡片折叠与过滤](https://github.com/hyperion2144/dsh-tool-activator/issues/6)、[#7 状态层：页面草稿 + 串行写队列，根除快速勾选竞态](https://github.com/hyperion2144/dsh-tool-activator/issues/7)。
