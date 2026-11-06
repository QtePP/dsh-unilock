# DSH 团队能力包协议（Pack Protocol）v0.1

本目录实现一层**不侵入 DeepSeek Harness 运行时**的团队资产协议。`packages/` 下任何代码都不读取本协议的产物；DSH 只照常读取它自己的 profile 目录。协议由本仓库 `bin/` 与 `src/` 下的零依赖 Node.js 工具执行。

## 1. 要解决的问题

调研归档 `docs/plugin-archive-protocol-research.zh.md`（调研归档，位于上游 harness 仓库） 的结论：

- bundle 层有 npm 版本，但 `cordis.patch.yml` 层**没有版本、来源、hash，不进任何可重建组合的 lock**；
- `pnpm-lock.yaml` 只锁 npm 依赖树，不锁 patch 层、`dsh.profile.bundles` 顺序、`compatibility.json`；
- profile 位于 `$DSH_HOME/profiles/<name>`，**不在版本库中**，`--from-default-profile` 明确不建立继承关系；
- `package.json.dsh` 只有 `manifestVersion` / `bundle` / `profile` / `client`，没有 `requires` / `provides`；
- 能力名（tool / command / skill）在运行时 `register()` 才产生，包与包之间没有可校验的依赖声明；
- 凭据名没有机器可读的声明位置（`MCP_SEARCH_TOKEN` 只出现在 `!!js process.env.*` 字符串里）。

本协议把这四件东西变成**一个可提交 Git 的产物**：声明、内容摘要、能力闭包、凭据名清单。

## 2. 四层模型

| 层 | 文件 | 谁写 | 作用 |
|---|---|---|---|
| 单元层 | `units/<id>/unit.json` + 载荷文件 | 人 | 单一职责的可分发能力单元：`provides` / `requires` / `contents` / `integrity` |
| 组合层 | `composition.json` | 人 | 团队意图：选哪些单元、哪些有序 patch 层、目标 profile、显式绑定 |
| 锁定层 | `pack.lock.json` | `pack lock` 生成 | 每个单元与每个 patch 层的精确内容摘要 + 解析后的能力闭包 |
| 落地层 | `$DSH_HOME/profiles/<name>/` | `pack materialize` 生成 | DSH 实际读取的 profile 骨架（不进 Git） |

分层对应调研结论：**不造第二套归档格式、不造第二个 registry**。npm / Git 包仍由 `dsh plugin add` 安装；本协议只负责「团队上下文」这一层。

## 3. `unit.json`（format 1）

| 字段 | 类型 | 含义 |
|---|---|---|
| `format` | `1` | 协议格式版本 |
| `id` | 反向 DNS | 如 `com.example.search`；多团队分发不撞名 |
| `name` / `description` | string | 显示信息 |
| `version` | SemVer | 单元版本；`requires.constraints` 对它求值 |
| `roles` | `command \| cli \| skill \| mcp \| tool` 子集 | 该单元承担的入口类型，非空不重复 |
| `provides.capabilities` | string[] | 抽象能力名，如 `search.web` |
| `provides.services` / `tools` / `commands` | string[] | 该单元在 DSH 中注册的名字（展示与文档用） |
| `requires.capabilities` | string[] | 依赖的抽象能力；**不写具体包名** |
| `requires.constraints` | map | 能力名 → SemVer 范围（`^1.0.0` / `~1.2` / `>=1.0.0 <2.0.0`） |
| `requires.credentials` | 数组 | `{ name, description, optional }`；`name` 是 POSIX 环境变量名 |
| `contents.sources` | 数组 | 单元携带的文件 / 目录，`path` 不得逃出单元目录 |
| `contents.skills` / `commands` / `mcpServers` | string[] | 载荷清单（展示与 materialize 用） |
| `integrity` | `{ algorithm: "sha256", digest }` | `contents.sources` 的确定性摘要 |

**单一职责的判定**：一个单元只提供一个（或一组紧密内聚的）`capabilities`，消费方通过能力名而非包坐标依赖它。示例里 `com.example.review-workflow` 只声明 `requires: ["search.web"]`，把 provider 换成别的包不需要改它。

**解耦点**：`composition.bindings` 可以在能力名有多个 provider 或需要显式指定时，把能力名绑到某个单元 id；这正是「从 mcp 换成 cli 而不改消费方」的实现方式。

### 3.1 内容摘要算法

`integrity.digest` 与 lock 中的 `units[].digest` 使用同一算法：

1. 展开 `contents.sources`：`file` 取该文件，`directory` 递归取全部普通文件；
2. 路径转成相对单元根目录的 `/` 分隔形式，去重后按字典序排序；
3. 每个文件依次写入：`路径`、`\0`、文件字节、`\0`；
4. 文本字节先做 **CRLF → LF** 归一化，保证 macOS / Windows / Linux 同一摘要；
5. 取 sha256 小写十六进制。

`unit.json` **自身不进入该摘要**，否则写 `integrity.digest` 会改变它所声明的值（自引用）。lock 另用 `units[].unitDigest` 记录 `unit.json` 原始字节的 sha256，因此清单本身的改动仍可被 `verify` 发现。

## 4. `composition.json`（format 1）

| 字段 | 含义 |
|---|---|
| `id` / `description` | 组合标识 |
| `profile.name` | 目标 DSH profile 名 |
| `profile.bundles` | 有序 bundle 名单，写进生成的 `package.json.dsh.profile.bundles` |
| `units` | `{ id, version }` 数组；id 不重复，版本必须与 `unit.json` 一致 |
| `patches` | 有序 `{ id, file, description }`；`file` 不得逃出仓库 |
| `bindings` | 能力名 → 单元 id 的显式绑定 |
| `credentialBindings` | 保留位：凭据名到本地来源的说明（值永不入文件） |

## 5. `pack.lock.json`（format 1，生成物，必须提交）

| 字段 | 含义 |
|---|---|
| `id` / `generatedBy` | 组合标识与工具版本 |
| `digest` | 除 `digest` 自身外全部字段的 `canonicalJson` sha256；`canonicalJson` 递归排序对象键 |
| `units[]` | `id` / `version` / `digest`（载荷）/ `unitDigest`（清单原文） |
| `patches[]` | `id` / `file` / `digest`（单文件 sha256，含 CRLF 归一化） |
| `bindings` | 解析后的能力闭包 |
| `credentialBindings` | 组合层声明的凭据绑定 |

`pack verify` 从磁盘重算全部内容，与 lock 逐项比较；任何字节变动、任何隐藏 Unicode 字符、任何能力闭包变化都会失败。

## 6. 命令

```sh
node bin/pack.mjs init <target>             # 生成可跑通的骨架（自动算好 digest）
node bin/pack.mjs sync       --repo <dir>   # 改了单元文件后回填 integrity.digest
node bin/pack.mjs compositions --repo <dir> # 列出全部组合及各自锁状态
node bin/pack.mjs validate  --repo <dir> [--composition <name>]
node bin/pack.mjs lock       --repo <dir> [--composition <name>] [--all]
node bin/pack.mjs verify     --repo <dir> [--composition <name>] [--all]
node bin/pack.mjs doctor     --repo <dir> [--composition <name>] [--strict]
node bin/pack.mjs materialize --repo <dir> --home ~/.dsh [--composition <name>]
```

### 6.1 一个 unit 属于多份组合

`composition.json` 是默认组合；`compositions/<name>.json` 是具名组合，各自对应 `compositions/<name>.lock.json`。所有组合共享同一份 `units/` 与 `patches/`，**不得为了某一组合修改 unit 文件**：组合只做「选择子集 + 有序 patch 层 + 显式绑定」。

`--composition <name>` 选择具名组合；`--all` 对全部组合执行 `lock` / `verify`；`compositions` 命令列出每份组合的单元数与锁状态（`MATCH` / `STALE` / `no lockfile`）。

`pack verify` 从磁盘重算全部内容，与 lock 逐项比较；任何字节变动、任何隐藏 Unicode 字符、任何能力闭包变化都会失败。由于摘要按单元计算，篡改一个共享单元只会让**选中该单元的组合**失败，影响面被限制在组合边界内。实例见 [unilock/README.md](unilock/README.md)。

`materialize` 写出 `package.json` / `pnpm-workspace.yaml` / `cordis.patch.yml` / `pack.json`，并拷贝 `target: skills` 的目录。它**拒绝覆盖已存在的 `cordis.patch.yml`**，避免抹掉同事的本地改动。

## 7. 安全与边界（刻意不做）

- **凭据只声明名字**：`doctor` 只检查 `process.env[name] !== undefined`，从不读取、存储、打印值；`.gitignore` 排除 `.env*`。
- **隐藏 Unicode**：`SKILL.md` / patch 是模型可读文本；`validate` 与 `verify` 扫描零宽字符、bidi 控制符、BOM 并报出行列。
- **不执行载荷**：工具只做读、哈希、拷贝；不 `import` 单元代码，不跑 hook，不执行 install 脚本。
- **不做第二套 registry**：单元包仍由 npm / Git + `dsh plugin add` 分发；本工具不解析 install spec、不解析传递依赖、不改写 DSH 源码。
- **不替代 DSH 的运行时校验**：能力名与 `ctx` key 的稳定性仍由 DSH 自己负责；本协议的 `provides.services` 只是声明，不参与 Cordis `inject`。
- **不克隆 profile**：遵守 DSH 2026-08-05 profile/bundle 决策（位于上游 harness 仓库），不记录继承关系、不复制机器本地状态。

## 8. 与仓库内待评提案的关系

DSH `dsh.unit` 待评提案（位于上游 harness 仓库） 提议在 `package.json.dsh.unit` 中由 launcher 读取 `provides` / `requires`，并在 `prepareProfilePatches` 做能力闭包校验。那份提案**尚未实现**，且自列风险包括「`ctx` key 一旦成为跨包契约面，重命名即 manifest-breaking」。

本协议是**不等待该提案、也不修改 DSH 源码**的可行路径：把同样的语义外置到 `unit.json`，由 `pack verify` 在**进入 DSH 之前**校验。若提案日后落地且 `ctx` key 稳定性承诺确立，本协议的 `provides.services` 可映射过去；但本协议不依赖那一天。

## 9. 验收判据

| 判据 | 由谁保证 |
|---|---|
| 同事 clone 一份清单 + 注入自己的 key，一键复现同一工作范式 | `verify` + `materialize` + `doctor` |
| 任一单元升级或回滚不影响其他单元，当前生效版本可打印、可比对 | `composition.units[].version` + `unit.json.integrity` + `lock.units[]` |
| 团队共享唯一口径源，资产变更与口径变更同一提交 | `composition.json` / `pack.lock.json` / `units/` / `patches/` 全在同一仓库 |
| 手改 patch 或 skill 立刻暴露 | `verify` 摘要比对 + 隐藏 Unicode 扫描 |
| 换 provider 不改消费方 | `requires.capabilities` + `bindings` + `constraints` |

测试：`node --test tests/*.test.mjs`（33 项：14 项协议 + 10 项 unilock 解耦 + 9 项全局注册，含篡改负例）。

## 10. 全局 CLI 与工作区注册

后续所有 CLI 遵循同一站规：**全局可用 → 各工作区 harness 注册 → 适用时才组合**。完整定义见 [GLOBAL-CLI.md](GLOBAL-CLI.md)。

三个状态严格分离：installed（`~/.local/bin/dsh-pack` 一份）、registered（`$DSH_HOME/cli/workspaces/<name>.json`）、composed（`<workspace>/.dsh-pack/composition.json`）。`workspace add` 不写组合文件；`compose` 仅在存在适用 CLI 时生成，且只选入工作区 `requires` 命中的 unit 与对应 patch 层。组合产物自包含，可直接 `lock` / `verify` / `materialize`。
