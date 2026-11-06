# dsh-unilock

本机实践的落地组合：把 **command / cli / skill / tool / mcp** 拆成 5 个**职责单一、互不引用**的能力单元，再用 3 份不同组合复用同一批单元文件。

它验证的是协议里最难的一条：**每个 unit 可以形成不同的组合**，且任何一份组合都不需要修改 unit。

## 五个独立单元

| 目录（`units/` 下） | role | provides | 载荷 |
|---|---|---|---|
| `io.github.dsh-unilock.command` | `command` | `unilock.command` | `commands/unilock.md`，只管 slash command plane |
| `io.github.dsh-unilock.cli` | `cli` | `unilock.cli` | `bin/unilock.mjs`，纯 node 脚本，无 DSH import |
| `io.github.dsh-unilock.skill` | `skill` | `unilock.skill` | `skills/unilock-guide/SKILL.md`，模型可读指令 |
| `io.github.dsh-unilock.tool` | `tool` | `unilock.tool` | `tools/unilock-echo.json`，一个模型工具定义 |
| `io.github.dsh-unilock.mcp` | `mcp` | `unilock.mcp` | `mcp/unilock.patch.yml` 模板 + 凭据名 `UNILOCK_MCP_TOKEN` |

**解耦保证**（由 [tests/unilock.test.mjs](../tests/unilock.test.mjs) 机械校验）：

- 每个 unit 恰好 1 个 `role`、1 个 `provides.capabilities`、`requires.capabilities` 为空；
- 任何 unit 的全部载荷文本里**不出现其他 4 个 unit 的 id**；
- 凭据只声明名字，值不进仓库。

## 三份组合，同一批 unit

| 组合 | 选中的 unit | profile | 需要 `UNILOCK_MCP_TOKEN` |
|---|---|---|---|
| `composition.json`（default） | 全部 5 个 | `unilock-all` | 是 |
| `compositions/minimal.json` | skill + tool | `unilock-minimal` | **否** |
| `compositions/remote.json` | command + cli + mcp | `unilock-remote` | 是 |

每个 unit 都出现在 **2 份**组合里，且**没有为任何组合改过一个 unit 文件**。`minimal` 不需要 MCP token——凭据需求跟着单元走，不是组合的全局属性。

三份组合有各自独立的锁文件：`pack.lock.json`、`compositions/minimal.lock.json`、`compositions/remote.lock.json`，摘要互不相同。

## 本机实践命令

```sh
# 在 dsh-unilock 仓库根目录执行
node bin/dsh-pack.mjs compositions --repo unilock
node bin/dsh-pack.mjs lock --all --repo unilock
node bin/dsh-pack.mjs verify --all --repo unilock

# 单组合操作
node bin/dsh-pack.mjs doctor --repo unilock --composition minimal
node bin/dsh-pack.mjs materialize --repo unilock --composition minimal --home ~/.dsh
```

`--composition <name>` 读 `compositions/<name>.json` 与 `compositions/<name>.lock.json`；不带则读根目录的 `composition.json` / `pack.lock.json`。`--all` 对全部组合执行 `lock` / `verify`。

## 验证「解耦」的负例

篡改 `skill` 单元的 `SKILL.md` 后运行 `verify --all`：

- `default` 与 `minimal` **失败**（都选了 skill）；
- `remote` **仍然 OK**（没选 skill）。

这条由测试 `tampering a shared unit breaks every composition that selects it` 固定。它证明影响面被限制在选中该单元的组合内，而不是全局。

## 与 profile 的关系

`compose` 与 `materialize` 都只在使用者显式执行时才创建 DSH profile。本协议不假设、也不修改任何本机已有的 profile；多 profile 的取舍由使用者按自己的 `$DSH_HOME` 决定。
