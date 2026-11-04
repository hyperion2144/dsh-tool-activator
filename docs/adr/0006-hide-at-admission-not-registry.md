# 0006 未激活工具在 step admission 上隐藏，不在注册表出口隐藏

日期：2026-11-04。状态：已采纳（#23）。

## 背景

插件要把「未激活的工具」从模型面前藏起来。dsh 0.2.2 起，模型面的工具声明由 provider 从「本步 admission」产出（`tools.resolve()` → `ResolvedToolSet` → `definitions(scope, toolSet)`），而注册表本身还有另一条读法：`schemas(scope)` / `get(name, scope)`（不带 toolSet）读的是该 scope 的真实工具面。

早期实现包装了宿主私有的 `tools.view(scope)`，按「已启用集合」过滤 `visible`。这同时改掉了两条读法：

- 设置页（`src/remote.ts`）读 `schemas(agent)` 时看不到 per-agent 注册的工具；
- 第三方插件注册完自己的工具后回读 `schemas(agent)` 确认，读到的是被过滤后的面，于是判定「注册失败」并**把自己刚注册的工具撤回**（dsh-gitbash-shell 的 bash 就是这样消失的）；
- 宿主自己的插件（timeout-policy、tool-fs、tool-skill 等）也按 scope 面读，同样被误导。

## 决定

隐藏只发生在 **step admission**：包装公开的 `ctx.tools.resolve()`，在它返回的 `ResolvedToolSet.view(scope)` 上按「已启用集合」裁剪。注册表出口（`view` / `schemas` / `get`）保持原样，永远返回真实工具面。

宿主没有 admission 契约时（0.2.0-rc.2 / 0.2.1，装配自己带 `tools`）不装任何进程级过滤，隐藏交给已有的装配级过滤（`src/prompt.ts` 的 `preparePromptAssembly`）。

## 后果

- 设置页、第三方插件、宿主插件读到的工具面恢复真实；per-agent 注册的工具不再被误判。
- 模型面仍然只拿到已启用工具：provider 从 admission 取声明，裁剪后的 `toolSet.view` 就是它的输入。
- 代价一：不带 `toolSet` 的执行路径不再自动拦住未激活工具（模型调用仍被拦，模型的每一步都带 toolSet）。
- 代价二：不带 `toolSet` 的 scope 装配会看到完整工具面（agent 主循环永远带 toolSet，主路径不受影响）。
- 代价三：仓库测试宿主是 rc.2（没有 `resolve`），0.2.2 的 admission 路径靠 fixture 补一个 `resolve` 来覆盖。
- `src/view-hiding.ts` 与 `src/hiding.ts` 的 restrict 回退、`readAll` 抬门、`suppressed` 抑制递归一并退休。
