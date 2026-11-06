# 全局 CLI 与工作区 harness 注册

本文定义后续所有 CLI 的站规：**CLI 全局可用 → 在各工作区 harness 中注册 → 适用时才组合**。

## 1. 三个必须分开的状态

| 状态 | 含义 | 存放位置 |
|---|---|---|
| installed | CLI 在 PATH 上，全局只装一份 | `~/.local/bin/dsh-pack` |
| registered | 某个工作区声明「知道这个 CLI、需要哪些能力」 | `$DSH_HOME/cli/workspaces/<name>.json` |
| composed | 该工作区实际把适用的 unit 选进一份组合 | `<workspace>/.dsh-pack/composition.json` |

**注册 ≠ 组合**。`workspace add` 只登记意图，不写任何组合文件；只有 `compose <name>` 且存在适用 CLI 时才生成组合。这是「在适用的时候组合」的机械保证。

## 2. 全局注册表

位置：`$DSH_HOME/cli/`（默认 `~/.dsh/cli/`），与 `profiles/` 同级。

```
$DSH_HOME/cli/
├── registry.json              # 已安装 CLI 清单 + 工作区名单 + 内容摘要
└── workspaces/
    ├── app-a.json             # 工作区注册记录（root / requires / tags / profile）
    └── app-b.json
```

`registry.json` 带 `digest`（canonicalJson 的 sha256），任何注册变更都会改摘要。注册表是**机器全局**的，不属于任何仓库；工作区产物（`.dsh-pack/`）才属于该工作区自己的仓库，可提交 Git。

## 3. 命令

```sh
# 一次性：把全局 CLI 装到 PATH
dsh-pack install-shim --bin ~/.local/bin

# 注册一个全局 CLI（指向它的 pack 仓库，声明它提供哪些能力）
dsh-pack cli add unilock \
  --command unilock \
  --repo /path/to/dsh-unilock/unilock \
  --capability unilock.skill --capability unilock.tool --capability unilock.mcp \
  --tag review

# 注册工作区 harness（只登记，不组合）
dsh-pack workspace add app-a --root /path/to/app-a \
  --requires unilock.skill --requires unilock.tool --tag review --profile app-a

# 查看三态
dsh-pack status
dsh-pack cli list
dsh-pack workspace list

# 仅在适用时组合
dsh-pack compose app-a

# 工作区产物自包含，可直接锁/校验/落地
dsh-pack --repo /path/to/app-a/.dsh-pack lock
dsh-pack --repo /path/to/app-a/.dsh-pack verify
dsh-pack --repo /path/to/app-a/.dsh-pack doctor
```

本地 pack 命令（`init / sync / compositions / validate / lock / verify / doctor / materialize`）由全局 CLI 原样转发到 `bin/pack.mjs`，因此**全局 `dsh-pack` 一个入口就能完成本地与全局两类操作**。

`--home <dir>` 覆盖 `$DSH_HOME`（默认 `~/.dsh`）；`DSH_PACK_ROOT` 覆盖实现目录（默认取 `bin/dsh-pack.mjs` 自身所在仓库的根），需要把 shim 指向另一个 checkout 时用它。

## 4. 适用性判定

`selectApplicable()` 的规则：

- CLI 的 `capabilities` 与工作区 `requires` 有交集 → 适用（理由 `capability:<name>`）；
- 或 CLI 的 `tags` 与工作区 `tags` 有交集 → 适用（理由 `tag:<name>`）；
- 都不命中 → **不适用，`compose` 失败且不写任何文件**。

**tag 只用于选中 CLI，绝不放宽 unit 集合。** `planComposition()` 只把「提供了工作区 `requires` 中某个能力」的 unit 写进组合，并且只带上与该 unit 对应的 patch 层（外加 `00-base`）。实测：

| 工作区 | requires | 组合出的 unit | patch 层 |
|---|---|---|---|
| `app-a` | `unilock.skill`, `unilock.tool`, tag `review` | skill, tool | `00-base`, `30-skill`, `40-tool` |
| `app-b` | `unilock.mcp` | mcp | `00-base`, `50-mcp` |
| `app-none` | `unilock.cli`（CLI 未声明） | **不组合** | — |

## 5. 组合产物为何自包含

`compose` 会把选中 unit 的目录与适用 patch 层**复制**到 `<workspace>/.dsh-pack/`，所以：

- 工作区仓库不依赖全局 pack 目录的存在；
- `dsh-pack --repo <workspace>/.dsh-pack lock` 直接可跑；
- 组合与锁文件可随工作区一起提交，同事 clone 后 `verify` 即可复现。

复制而非软链，是为了跨机器可移植。

## 6. 与 profile 的关系

`compose` **不创建任何 DSH profile**。它只生成组合与锁。真正落地 profile 仍需显式执行：

```sh
dsh-pack --repo <workspace>/.dsh-pack materialize --home ~/.dsh
```

本机 profile 归档由使用者自行记录；本协议不假设任何具体机器的路径。若要在本机只保留一个 profile，请按实际 `$DSH_HOME` 手动备份其余 profile 后再执行，切勿删除当前 GUI 正在使用的 `desktop` profile。

## 7. 安全与边界

- 凭据只在 unit 里声明**名字**；`doctor` 只检查名字是否在本机设置，不读值、不打印值、不写 `.env`。
- 全局注册表不含任何密钥，只有 CLI 名、pack 路径、能力名、tag、工作区路径。
- 不自动执行任何 CLI 载荷；`compose` 只复制文件。
- 不修改 `packages/`，不替代 `dsh plugin add`，不新建第二个 registry。

## 8. 验证

`node --test tests/global.test.mjs`（9 项）覆盖：全局根目录、CLI 注册幂等、注册不等于组合、按能力/tag 适用性、组合精确到所需 unit、工作区自包含可 lock/verify、从任意 cwd 运行、不适用时失败且无产物、注册表摘要变更。

与原有 24 项合计 **33 项全部通过**。
