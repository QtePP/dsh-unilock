# dsh-unilock

一个**全局 CLI 插件协议**与零依赖参考实现：把 command / cli / skill / tool / mcp 拆成职责单一的能力单元，全局安装一次，在各工作区 harness 中注册，**仅在适用时**按需组合成可复现、可校验、可提交 Git 的组合。

它不修改 DeepSeek Harness 运行时源码，也不引入第二套 registry。

## 为什么

DSH 的 bundle / profile / patch 分层已经承担安装、版本、平台与上架，但调研发现：

- `cordis.patch.yml` 层没有版本、来源、hash，也不进任何可重建组合的 lock；
- `pnpm-lock.yaml` 只锁 npm 依赖树，不锁 patch 层与 `dsh.profile.bundles` 顺序；
- profile 位于 `$DSH_HOME/profiles/<name>`，不在版本库中，换台机器要凭记忆重敲；
- `package.json.dsh` 没有 `requires` / `provides`，能力名在运行时 `register()` 才产生；
- 凭据名只出现在 `!!js process.env.*` 字符串里，没有机器可读的声明位置。

dsh-unilock 把「团队上下文」外置成一层**可提交 Git 的清单**，不等待任何上游提案落地。

## 三态模型

| 状态 | 含义 | 位置 |
|---|---|---|
| installed | CLI 全局只装一份 | `~/.local/bin/dsh-pack`（软链到本仓库 `bin/dsh-pack.mjs`） |
| registered | 工作区声明它需要哪些能力 | `$DSH_HOME/cli/workspaces/<name>.json` |
| composed | 适用时才生成组合 | `<workspace>/.dsh-pack/composition.json` |

**注册 ≠ 组合**。`compose` 只在 CLI 的 `capabilities` / `tags` 命中工作区 `requires` / `tags` 时生成组合，且只选入工作区实际需要的能力对应的 unit 与 patch 层。

## 快速开始

```sh
git clone https://github.com/QtePP/dsh-unilock.git
cd dsh-unilock

# 全局安装（软链到本仓库，PATH 上只出现一个 dsh-pack）
node bin/dsh-pack.mjs install-shim --bin ~/.local/bin

# 跑测试
node --test tests/*.test.mjs

# 注册一个 CLI 与一个工作区，适用时才组合
dsh-pack cli add unilock --command unilock \
  --repo "$(pwd)/unilock" \
  --capability unilock.skill --capability unilock.tool --capability unilock.mcp \
  --tag review
dsh-pack workspace add app-a --root /path/to/app --requires unilock.skill --tag review
dsh-pack status
dsh-pack compose app-a

# 工作区产物自包含，可直接锁 / 校验 / 落地
dsh-pack --repo /path/to/app/.dsh-pack lock
dsh-pack --repo /path/to/app/.dsh-pack verify
dsh-pack --repo /path/to/app/.dsh-pack doctor
```

Node.js ≥ 24（使用内置 `node:test`、`node:fs/promises`、ESM）。**零运行时依赖**。

## 仓库结构

```
bin/          dsh-pack（全局 CLI）与 pack（本地组合命令）
src/          unit / composition / registry / resolve 四个模块
scaffold/     init 生成的骨架（本身可跑通）
unilock/      实践示例：5 个解耦单元 + 3 份复用组合
tests/        33 项 node:test
README.md     本文件
PROTOCOL.md   协议 v0.1 全文
GLOBAL-CLI.md 全局注册与适用性站规
```

## 五个解耦单元

| unit | role | provides |
|---|---|---|
| `io.github.dsh-unilock.command` | command | `unilock.command` |
| `io.github.dsh-unilock.cli` | cli | `unilock.cli` |
| `io.github.dsh-unilock.skill` | skill | `unilock.skill` |
| `io.github.dsh-unilock.tool` | tool | `unilock.tool` |
| `io.github.dsh-unilock.mcp` | mcp | `unilock.mcp` |

每个 unit 恰好一个 role、一个 capability、`requires` 为空；任何 unit 的载荷都不引用其他 unit。三份组合（`default` / `minimal` / `remote`）复用同一批 unit 文件，没有为任何组合改过一个 unit。

## 安全性

- 凭据只声明**名字**（如 `UNILOCK_MCP_TOKEN`）；`doctor` 只检查名字是否在本机设置，不读值、不打印值、不写 `.env`。
- 每次 `validate` / `verify` 扫描 SKILL.md 与 patch 中的隐藏 Unicode（零宽字符、bidi 控制符、BOM）。
- 内容摘要按排序路径 + 原始字节计算，文本先做 CRLF→LF 归一化；任何字节漂移都会让 `verify` 失败。
- 不执行任何 unit 载荷，不解析 install spec，不修改 `packages/`。

## 文档

- [PROTOCOL.md](PROTOCOL.md) — 四层模型、字段、摘要算法、多组合、安全边界
- [GLOBAL-CLI.md](GLOBAL-CLI.md) — 全局注册三态、适用性判定、按需组合
- [unilock/README.md](unilock/README.md) — 五单元解耦实践与组合复用

## 许可

MIT
