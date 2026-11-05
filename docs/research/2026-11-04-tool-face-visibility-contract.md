# 工具面可见性契约：宿主读通道清单与 view 包装的影响

日期：2026-11-04（Asia/Shanghai）。范围：宿主源码静态核对（`deepseek-harness` checkout，`@deepseek-ai/dsh-tools` 版本 `0.2.2-alpha.3`，见 `packages/core/tools/package.json:4`）+ 本仓读点清点，不含运行期复现与真实 GUI 端到端验证。

> 路径约定：下文 `packages/...` 指宿主仓 `deepseek-harness` 的相对路径；`src/...` 指本仓（dsh-tool-activator）。

> 状态：本文记录的是 #23 修复**前**的状态（闸门包在宿主私有 `tools.view()` 出口）。修复后隐藏改在 step admission，`src/view-hiding.ts` 与 `src/hiding.ts` 已删除；下文对本仓现状的描述因此是历史快照，宿主侧的读通道清单与契约结论仍然有效。决定见 `docs/adr/0006-hide-at-admission-not-registry.md`。

## 问题

本插件在 `src/view-hiding.ts:190` 包装宿主 `ToolsService` 的**私有**方法 `view(scope)`，按「已启用工具白名单」过滤 `view(scope).visible`。副作用有两个：

1. `ctx.tools.schemas(agent)` 这条**公开**读通道在全进程被重定义为「模型当前看得见的工具面」，而不是「该 scope 的真实工具面」。
2. 过滤连 agent 自有层（own layer）的注册一起滤掉——而宿主契约里 own 层注册是豁免 restriction 的（`packages/core/tools/src/index.ts:219-224`）。

本笔记回答六个问题：① 宿主 `ToolsService` 的公开读通道清单与语义；② 是否存在能读到「某 agent scope 的未过滤真实工具面」的公开通道；③ per-agent（own scope）注册的可见性契约原文；④ 模型面在 dsh 0.2.2 上的产出路径，以及隐藏 own 层工具时 `view` 是否唯一杠杆；⑤ 宿主仓内会被 view 级白名单误导的读点清单；⑥ 宿主是否提供官方「探测豁免通道」。

## 结论（已确认）

1. **公开读通道只有五个读方法**：`schemas` / `definitions` / `get` / `executable` / `resolve`；`restrict` 是写方法（只写不读）。`view` 是 `private`（`packages/core/tools/src/index.ts:199`），且承载它的 `ToolView` 接口未导出（`packages/core/tools/src/index.ts:51-60`），宿主自己的公开 API 目录里也没有 `view`（`packages/extensions/tool-cordis/src/api-catalog.ts:9691`）。`schemas(scope, toolSet)` 与 `definitions(scope, toolSet)` 的差别**只在 toolSet 分支**：带 `toolSet` 读「本步 admission 集合（模型面）」，不带读「注册面（scope 面）」；两者最终都经过 `view`。

2. **没有**任何公开通道能读到「某 agent scope 的未过滤真实工具面」：全部公开读方法都经 `view`；`toolSet` 分支**不绕过** view——`ResolvedToolSet.view(scope)` 内部再次调用 `this.view(agent)`（`packages/core/tools/src/index.ts:287`）；`knownNames` / `restrictableNames` / `registrations` 只存在于 `view()` 的返回值里，没有第二出口。唯一可用的口子是**运行时可达的私有 `view()`**（TS `private` 只在编译期强制，本插件正是这样用的，`src/view-hiding.ts:190`），而且这条口子目前只还原了一半：本插件只过滤 `visible`，把 `knownNames` / `restrictableNames` / `registrations` 原样透传（`src/view-hiding.ts:156`），所以 `view(scope).knownNames` 仍是完整的前置名宇宙（含 own 层），`view(scope).registrations` 仍含 own 层注册——但这依赖私有 API + 本仓包装的实现细节，不是宿主契约。

3. **own 层豁免 restriction 是硬契约**：`view()` 的 own 分支无条件把 own 层注册写进 `visible` 与 `registrations`（`packages/core/tools/src/index.ts:219-224`），注释原文「the viewing scope's own registrations remain exempt」（`packages/core/tools/src/index.ts:193-195`）。`restrict()` 点不到 scope-local 名字有两处源码依据：`restrictableNames` 只收 inherited（global + 祖先 scope）名字（`packages/core/tools/src/index.ts:211-213`），own 层只进 `knownNames`（`packages/core/tools/src/index.ts:221`）；`restrict()` 用 `this.view(scope).restrictableNames` 校验，名字不在集合内直接抛错（`packages/core/tools/src/index.ts:179-183`），注释原文「scope-local names ... fail」（`packages/core/tools/src/index.ts:156-158`）。

4. **闸门对模型面是承重的、对 scope 面是撒谎的——两者共用 `view` 这一个出口**：本仓的闸门是「已启用白名单」，**不是**宿主的 `when` 条件——`resolve()` 的 `admitted` 集合是从 `view(agent).visible` 建的（`packages/core/tools/src/index.ts:267-280`），而 `view.visible` 已被本仓包装按白名单过滤过，所以**模型面的隐藏确实依赖 view 包装**（`when` 为假的工具「本来就不进 admitted」是另一回事，且 `when` 只能由注册方自己设置，第三方无法追加）。同时 `view` 是 scope 面读（`schemas(scope)` / `definitions(scope)` / `get(name, scope)`）的唯一出口，于是同一张过滤网既收窄了模型面，也扫过了所有 scope 面读者。对第三方插件而言，隐藏某个 agent **自有层注册**的工具，`view` 是唯一可用的 scope 面杠杆（`restrict` 点不到 scope-local 名字；`guard` 只管执行不管可见性）。**这正是本票的结构性张力：模型面与 scope 面共用同一个出口。**

5. **宿主仓内有一批 scope 面读点会被 view 级白名单误导**（含宿主自己的插件）：`packages/guard/timeout-policy/src/index.ts:57`（被闸门遮住的工具拿不到声明的 timeout 预算）、`packages/skill/tool-skill/src/index.ts:224`、`packages/fs/tool-fs/src/{read.ts:72,edit.ts:80,write.ts:66,apply-patch.ts:20}`、`packages/fs/tool-fs-search/src/{grep.ts:280,283,glob.ts:315}`、`packages/schedule/tool-schedule/src/index.ts:362-363`、`packages/subagent/tool-subagent/src/index.ts:365,378`、`packages/context/file-reference-local/src/index.ts:74`、`packages/extensions/cordis-host-runner/src/guard.ts:652-653`、`packages/experimental/browser-use-runtime/src/mcp.ts:118`、`packages/experimental/liveshare/src/host/fork-enforcement.ts:172,725`、`packages/fs/tool-fs-search/src/direct-call.ts:26`。带 `toolSet` 的读点读的是模型面本身（`packages/web/tool-web/src/fetch.ts:453`、`search.ts:355,357`、`packages/subagent/tool-subagent-control/src/index.ts:106,109`），语义上不算误伤。

6. **宿主没有官方「探测豁免通道」**：公开面上不存在 raw 注册表读取、也不存在提供工具面的 capability service；`tools/change` 事件无载荷（`packages/core/tools/src/events.ts:50-56`）；宿主自带的 `cordis_inspect` 的 `listTools` 走的也是同一条被包装的 `ctx.tools.schemas(context.agent)`（`packages/extensions/tool-cordis/src/providers.ts:78`）。唯一「官方但非公开」的口子就是 `view()` 本身。

## 证据

### 0. 版本与路径基线

- 宿主 checkout 的 `@deepseek-ai/dsh-tools` 版本为 `0.2.2-alpha.3`（`packages/core/tools/package.json:4`）。
- 工具服务实现文件：`packages/core/tools/src/index.ts`（`ToolsService` 类体 `:99-403`）。
- 本插件的包装入口：`src/view-hiding.ts:84-131`（安装）、`:148-188`（包装实现）、`:190`（替换原型上的 `view`）。

### 1. 公开读通道清单

| 成员 | 签名 | 语义 | 出处 |
| --- | --- | --- | --- |
| `schemas` | `schemas(scope?: ScopeKey, toolSet?: ResolvedToolSet): ToolSchema[]` | 投影成模型面字段（name/description/parameters/deferLoading）；带 toolSet 读 admission 集合，不带读 scope 注册面 | `packages/core/tools/src/index.ts:316-318`；字段白名单见 `packages/core/tools/src/schema.ts:641-646` |
| `definitions` | `definitions(scope?: ScopeKey, toolSet?: ResolvedToolSet): readonly ToolDefinition[]` | 完整定义（含 `execute`/`output`）；带 toolSet 走 `toolSet.view(scope)`（模型面），不带走 `view(scope).visible`（scope 面） | `packages/core/tools/src/index.ts:305-307` |
| `get` | `get(name: string, scope?: ScopeKey, toolSet?: ResolvedToolSet): ToolDefinition \| undefined` | 单名查；带 toolSet 走 admission，否则走 `view(scope).visible` | `packages/core/tools/src/index.ts:239-241` |
| `executable` | `executable(name: string, scope?: ScopeKey, toolSet?: ResolvedToolSet): ToolDefinition \| undefined` | 执行期查；不带 toolSet 时排除带 `when` 的条件注册 | `packages/core/tools/src/index.ts:251-255` |
| `resolve` | `resolve(context: ToolActivationContext): Promise<ResolvedToolSet>` | 本步 admission：按 `when` 条件求值，产出冻结的 `ResolvedToolSet` | `packages/core/tools/src/index.ts:264-297` |
| `restrict` | `restrict(filter: ToolRestriction): () => void` | **写**：只对 inherited 全局名加 allow/deny 掩码；不返回任何读结果 | `packages/core/tools/src/index.ts:162-189` |
| `view` | `private view(scope?: ScopeKey): ToolView` | **私有**：派生 scope 的完整视图（visible/registrations/knownNames/restrictableNames） | `packages/core/tools/src/index.ts:199-227` |

- `ToolView` 接口四个字段：`visible`（`:53`）、`registrations`（`:55`）、`knownNames`（`:57`，注释「Pre-restriction capability names used by prompt-order validation」）、`restrictableNames`（`:59`）；该接口**没有 `export`**（`packages/core/tools/src/index.ts:51`）。
- 私有面还有 `selectExecutor(scope?)`（`packages/core/tools/src/index.ts:357`）与四个私有字段 `layers` / `scoped` / `root` / `guards`（`:106-109`）。
- 宿主自己的公开 API 目录（生成文件，头部声明「Generated by scripts/gen-cordis-api.ts」，`packages/extensions/tool-cordis/src/api-catalog.ts:1-10`）列出的 `ToolsService` 公开契约只有 `register` / `restrict` / `get` / `executable` / `resolve` / `definitions` / `schemas` / `setExecutor` / `execute` / `guard` / `checkGuards`——**没有 `view`**（`packages/extensions/tool-cordis/src/api-catalog.ts:9690-9691`）。
- 宿主 README 对读通道的表述与源码一致：「`get(name, scope, toolSet)`, `definitions(scope, toolSet)`, and `schemas(scope, toolSet)` inspect an admitted set; omitting `toolSet` inspects registered definitions without evaluating conditions」（`packages/core/tools/README.md:73`）。

**`schemas(scope, toolSet)` 与 `toolSet` 的差别**：带 `toolSet` 时，结果是「本步 admission ∩ 当前仍可见」（`packages/core/tools/src/index.ts:284-295`），即**模型面**；不带时是「该 scope 的注册面」（`packages/core/tools/src/index.ts:306`），即**scope 面**，且条件注册（带 `when`）也在其中——`definitions(scope)` 不评估条件，只有 `executable(scope)` 会排除它们（`packages/core/tools/src/index.ts:254`）。

### 2. 是否存在「未过滤真实工具面」的公开通道

**结论：没有。** 逐项核对：

- `view` 的可见性修饰符是 `private`（`packages/core/tools/src/index.ts:199`），类型层面不可从插件侧调用；运行时可达（TS `private` 无运行时强制），本插件即通过 `Object.defineProperty(owner, 'view', ...)` 覆盖它（`src/view-hiding.ts:190`），并在宿主不暴露 `view` 时 fail closed 返回 `undefined`（`src/view-hiding.ts:89-90`）。
- `knownNames` / `restrictableNames` / `registrations` **没有读取出口**：`knownNames` 在宿主另有公开形态——`ToolProviderResult.knownNames`（`packages/core/system-prompt/src/index.ts:113-118`）——但那是**provider 自己要返回的字段**，不是注册表把名宇宙发给插件；`restrictableNames` 与 `registrations` 只存在于 `packages/core/tools/src/index.ts` 内部（声明 `:51-60`、填充 `:211-223`、消费 `:179`），而 `ToolView` 未导出，插件侧没有类型化入口。
- `tools.schemas(scope, toolSet)` 的 toolSet 分支**不绕过 view**：`definitions(scope, toolSet)` → `toolSet.view(scope)`（`packages/core/tools/src/index.ts:306`）→ `ResolvedToolSet.view` 的实现内部再次调用 `this.view(agent)` 复核（`packages/core/tools/src/index.ts:287`）。因此两条分支都被本插件的包装拦到。
- 旁路性质的「名字宇宙」只有两处，都不是 API：`restrict()` 抛错时把 `restrictableNames` 拼进错误消息（`packages/core/tools/src/index.ts:182`），以及 `view(scope).knownNames` 本身。

**本仓包装的具体影响面**：`src/view-hiding.ts:156` 的 `const copy: FilteredView = { ...original, visible: new Map(original.visible) }` 只替换 `visible`，`knownNames` / `restrictableNames` / `registrations` 原样透传。于是：

- `tools.view(scope).knownNames` 仍是**完整**的前置名宇宙（含 own 层注册名，且含被 `restrict()` deny 的全局名——`knownNames.add` 发生在 `admits` 判定之前，`packages/core/tools/src/index.ts:212` vs `:214`）。
- `tools.view(scope).registrations` 仍含 **own 层**注册（`packages/core/tools/src/index.ts:223`），但**不含**被 restriction 拒绝的 inherited 名（`:214-217` 只有 `admits` 通过才写入 `visible` 与 `registrations`）。
- 结论：**被 `restrict()` deny 掉的全局工具，其定义在任何通道都拿不到**（只有名字在 `knownNames` 里）；own 层注册的定义则仍可经私有 `view().registrations` 取回——但这条路径同时依赖私有 API 与本仓包装「只滤 visible」这一实现细节。

### 3. own 层豁免 restriction 的契约原文

- `view()` 文档注释：「Resolve visible tools and pre-restriction names. Restrictions across the scope chain intersect over inherited global and ancestor tools; **the viewing scope's own registrations remain exempt**. Nearer registrations shadow farther ones.」（`packages/core/tools/src/index.ts:191-197`）
- own 分支实现：own 层每个注册无条件写入 `knownNames`、`visible`、`registrations`（`packages/core/tools/src/index.ts:219-224`）。
- `restrict()` 文档注释：「Restrict global tools for the calling agent scope. **Empty filters, unknown names, scope-local names, and reserved transport names fail.** Restrictions intersect; scoped registrations remain visible.」（`packages/core/tools/src/index.ts:155-161`）
- `restrict()` 为何对 scope-local 名字无效（源码注释 + 实现）：
  - `restrictableNames` 只收 inherited 名字：`for (const [name, registration] of inherited) { knownNames.add(name); restrictableNames.add(name); ... }`（`packages/core/tools/src/index.ts:211-213`）；own 层只 `knownNames.add(name)`（`:221`）。
  - 校验：`const known = this.view(scope).restrictableNames; const unknown = [...].filter(name => !known.has(name)); if (unknown.length > 0) throw new Error('tools.restrict() names unknown global tool...')`（`packages/core/tools/src/index.ts:179-183`）。
  - 术语侧佐证：「restriction / scope-local registration — a restriction (`tools.restrict`) filters the GLOBAL tool set for one scope (compose by intersection); scope-local registrations are merged after that filter.」（宿主 `docs/glossary.md:19`）
- `ToolRestriction` 的字段语义同向：「Global tool names that stay visible / removed from visibility」（`packages/core/tools/src/contracts.ts:376-381`）。

### 4. 模型面在 dsh 0.2.2 上的产出路径

调用链（每跳给行号）：

1. `packages/core/agent-loop/src/agent.ts:292` — `const toolSet = await this.loopCtx.tools.resolve({ agent: this, modelSelection: selection, signal })`。
2. `packages/core/tools/src/index.ts:264-297` — `resolve()`：
   - `:267` `const view = this.view(agent)`（**经过本插件包装**）；
   - `:268-280` 逐个注册求 `registration.when`（`:273`），为真才进 `admitted`（`:279`）；
   - `:282-296` 返回冻结对象，其 `view(scope)`（`:284-295`）在 `scope !== agent` 时返回空（`:286`），否则用 `this.view(agent)` 复核（`:287`）并与 `admitted` 取交集（`:288-292`）。
3. `packages/core/agent-loop/src/agent.ts:294` — `systemPrompt.assemble({ ...assembleContextFor(this, signal), modelSelection: selection, toolSet })`。
4. `packages/core/system-prompt/src/index.ts:620` `assemble()` → `:640-643` 收集 global + scope 链上的 tool providers → `:646-657` 逐个调用 provider（`:647`）并收集 `schemas`（`:655`）与 `knownNames`（`:656`）。
5. 宿主自己的 provider 在 `packages/core/tools/src/index.ts:113-117`：`executor.describe(this.definitions(scope, toolSet))`（`:115`）+ `knownNames` 回退到 `[...this.view(scope).knownNames]`（`:116`）。
6. executor 的 `describe` 产出模型面：native 直接投影（`packages/core/tool-executor-native/src/index.ts:15-17`），PTC 只声明 `run_code` 并另渲染 SDK（`packages/core/tool-executor-ptc/src/index.ts:41-43`、`:45`）。
7. `packages/core/system-prompt/src/index.ts:674` `orderTools(collected, this.toolOrder, knownNames)`（`:232-246`），`:687` / `:689-694` 产出 `PromptAssembly.tools`（类型见 `:131-134`）。
8. `packages/core/agent-loop/src/agent.ts:479` — `buildRequest(config, preparedCall, assembly.tools, ...)`，即真正发给模型的声明集合；`:457` 另用 `assembly.tools` 判断工具面是否变化。

**「隐藏 own 层注册、尚未激活的工具，`view` 是不是唯一杠杆？」**

- `restrict` 点不到 scope-local 名字（结论 3），所以**不能用 `restrict`**。
- `guard` 只在执行期拒绝调用（`packages/core/tools/src/index.ts:384-401`），不改变可见性。
- `when` 条件（`packages/core/tools/src/contracts.ts:115-124`）能隐藏工具，但只能由**注册方自己**在 `register(definition, { when })` 时设置，第三方无法追加。
- 因此：**对第三方插件，scope 面可见性的唯一可用杠杆就是 `view`**（本插件正是走这条路）。
- 精确区分：**本仓闸门不是 `when` 条件**。`when` 为假的工具本来就对模型面不可见（`admitted` 排除它们，`:268-280`），但本仓的白名单闸门与 `when` 无关——普通注册（无 `when`）的工具照样会进 `admitted`，是**我们的包装先把 `view.visible` 过滤了**，`admitted` 才随之变窄（`:267` → `:268-280`）。因此：模型面的隐藏是**承重**的，view 包装一旦撤掉，未激活工具会立刻回到模型面；而 scope 面读（`schemas(scope)` / `definitions(scope)` / `get(name, scope)`）被同一张过滤网扫到（本仓 `src/remote.ts:29-31` 与第三方 dsh-gitbash-shell 的 `faceNames(agent)` 正是这类读点）。**一处包装，两个语义。**
- **候选方向（未实现、未验证）**：把过滤从 `view` 挪到 admission——包装公开的 `resolve()`，在 `admitted` 上按白名单裁剪，由 `ResolvedToolSet.view` 用 `admitted ∩ view`（`:284-295`）产出模型面。这样模型面仍被隐藏，scope 面读恢复诚实。代价：① 无 toolSet 的执行路径（`executable` → `packages/core/tools/src/pipeline.ts:70-73`）不再自动拦住未激活工具；② 本仓 `ctx.tools.get(name, agent)` 的可见性判定随之改变（`src/host.ts:225`）。本条只是方向，尚未写代码、尚未验证。

### 5. 宿主仓内会被 view 级白名单误导的读点

以下读点都走 `ctx.tools.*`；「读的面」列区分它们本来想要的语义。

**A. scope 面读（不带 `toolSet`）——被白名单直接误导**

| 读点 | 想要什么 | 被闸门遮住后的后果 |
| --- | --- | --- |
| `packages/guard/timeout-policy/src/index.ts:57` `ctx.tools.get(exec.name, exec.agent)?.timeoutMs` | 该工具声明的协作式超时预算 | 取不到 → 该工具的超时策略**静默失效** |
| `packages/skill/tool-skill/src/index.ts:224` `ctx.tools.get(skillTool.name, agent) === skillTool` | 该 agent 是否真的拥有 skill 工具 | 判定为不可见 → 技能快照不再加载 |
| `packages/fs/tool-fs/src/read.ts:72`、`edit.ts:80`、`write.ts:66`、`apply-patch.ts:20` | 该 scope 是否可见 `read`/`edit`/`write`/`apply_patch` | 「用 read 而不是 cat」这类指引文案整段消失 |
| `packages/fs/tool-fs-search/src/grep.ts:280,283`、`glob.ts:315` | 同上（grep/glob） | 同上 |
| `packages/schedule/tool-schedule/src/index.ts:362-363` | 该 scope 是否可见 schedule 工具 | 管理授权段消失 |
| `packages/subagent/tool-subagent/src/index.ts:365,378` | 委派工具对该 scope 是否可见 | 委派工具介绍与授权文案消失 |
| `packages/context/file-reference-local/src/index.ts:74` | `read` 是否可见 | 文件引用指引消失 |
| `packages/extensions/cordis-host-runner/src/guard.ts:652-653` | 该 scope 的工具名清单（沙箱 runner 映射） | runner 看到的工具面与真实执行面不一致 |
| `packages/experimental/browser-use-runtime/src/mcp.ts:118` | 父 agent 继承来的 browser 前缀工具名 | 用它生成 `restrict({ deny })` 名单（`:121`）→ 名单不完整 |
| `packages/experimental/liveshare/src/host/fork-enforcement.ts:172,725` | 「该 Session 不带本层时本应执行的那个定义」 | 拿不到 → 守卫锚点缺失，该次调用被拒 |
| `packages/fs/tool-fs-search/src/direct-call.ts:26` `ctx.tools.get(exec.name, exec.agent) !== tool` | 身份比对（确认执行的就是这个定义） | 判定不等 → 直接调用优化被跳过（退化但不致命） |

**B. 模型面读（带 `toolSet`，或语义上就是「模型看得见什么」）**

- `packages/web/tool-web/src/fetch.ts:453`、`packages/web/tool-web/src/search.ts:355,357` — `ctx.tools.get(name, scope, toolSet)`，读本步 admission。
- `packages/subagent/tool-subagent-control/src/index.ts:106,109` — 同上，用于身份段落里的工具指引。
- `packages/extensions/tool-cordis/src/providers.ts:78` — `ctx.tools.schemas(context.agent)`，`listTools` 自省接口（供模型查询工具目录）。
- `packages/core/tools/src/pipeline.ts:70-73` — 执行期查找：有 `toolSet` 时用 admission；无 `toolSet` 时退化为 `executable(name, scope)` 的 scope 面语义。
- `packages/core/agent-loop/src/agent.ts:292` — 模型面来源本身。
- `packages/core/tools/src/index.ts:116` — `knownNames` 取自 `view(scope).knownNames`；本仓包装未过滤该字段，故 toolOrder 校验仍能看到完整名字宇宙。

### 6. 官方「探测豁免通道」

**结论：没有。** 逐项核对：

- 公开面（`packages/extensions/tool-cordis/src/api-catalog.ts:9690-9691`）只有 `register` / `restrict` / `get` / `executable` / `resolve` / `definitions` / `schemas` / `setExecutor` / `execute` / `guard` / `checkGuards`，没有任何 raw 注册表读取方法。
- 事件面：`packages/core/tools/src/events.ts` 只声明 `tools/pre-execute`（`:18`）、`tools/execute`（`:29`）、`tools/post-execute`（`:41`）、`tools/result`（`:49`）与 `tools/change`（`:56`）；`tools/change` 的载荷是空的 `(): void`（`:56`），注释只说「A tool was registered or unregistered, or a scoped restriction changed」（`:50-53`），不含名字集合。
- capability service 面：宿主有 `ctx.web` / `ctx.subprocess` / `ctx.ssh` / `ctx.credentials` / `ctx.authorization` 等 seam，但**没有**提供工具面的 capability service；全仓 `capabilit|Capability` 检索命中的都是这些无关 seam 与文案。
- 模型侧自省面：`cordis_inspect` 的 `listTools` 走 `ctx.tools.schemas(context.agent)`（`packages/extensions/tool-cordis/src/providers.ts:78`），与其它读点同一条被包装的通道。
- 结论：唯一「官方但非公开」的口子就是 `view()`；若要一个不受闸门影响的读点，只能继续用私有 `view()`，或等待宿主把 raw/known-names 读面提升为公开 API。

## 仍未确认

- **版本落差**：宿主 checkout 的 `@deepseek-ai/dsh-tools` 是 `0.2.2-alpha.3`（`packages/core/tools/package.json:4`），线上 dsh 为 `0.2.2`；本机没有 0.2.2 正式版对应的 `dsh-tools` 源码可比对，因此「0.2.2 正式版与 alpha.3 的 tools 包一致」未核实。
- **`view` 名字的跨版本稳定性**：本插件依赖宿主把私有方法命名为 `view`（`src/view-hiding.ts:138-141` 取 descriptor）。已安装的 0.2.2 发行版是否仍叫 `view` 未逐一核对；改名会让包装 fail closed（`src/view-hiding.ts:89-90`）。
- **祖先 scope 注册的可见性语义**：`view()` 的 `inherited` 会把 scope 链上的祖先层注册也算进来（`packages/core/tools/src/index.ts:202-206`，链顺序见 `packages/core/scope/src/store.ts:192-199`），因此祖先注册**不在**本 scope 的 `own` 里、可被本 scope 的 restriction 命中（`:214`）。这与宿主术语表「scoped registrations do not inherit down to subagents」（宿主 `docs/glossary.md:13`）的关系未厘清，也未做实机验证——可能只是术语里「subagent」与 scope parent 不同义。
- **`knownNames` 透传是否应长期依赖**：本仓包装只滤 `visible`（`src/view-hiding.ts:156`），因此 `view(scope).knownNames` / `registrations` 仍是完整/半完整的真实面。这是否可作为正式依赖（而非偶然副作用）需另作设计决定。
- 未做真实 GUI 端到端复现：本笔记全部结论来自源码静态核对，没有运行期观测数据。

## 相关票

- GitHub issue：[#23](https://github.com/hyperion2144/dsh-tool-activator/issues/23) —— 本笔记是 #23 的前置事实核对：确立「宿主没有未过滤真实工具面的公开读通道，`view` 是第三方唯一可用的 scope 面杠杆」这一结论，从而界定 #23 里「闸门误伤 own 层注册」的修复边界（只能改闸门范围，不能靠宿主公开 API 绕开）。
