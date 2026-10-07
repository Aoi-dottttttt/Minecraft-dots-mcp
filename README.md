# Minecraft dots MCP：共同维护的受限运行时

简体中文 | [English](README_EN.md) | [更新日志](CHANGELOG.md)

这是供多个安装共同维护的源码项目：修复问题时保留中性的回归测试，经维护者审核后共享改进，减少重复劳动。每个安装的配置、凭据和游戏状态都留在各自本地。贡献采用 [fork 和 PR](CONTRIBUTING.md)；安装和游戏操作仍需各自用户授权。

本仓库面向 Minecraft Java **1.21.1 / 协议 767**。软件包与后端版本仍为基于 3.1.0-dot.2 的 **3.2.0-rc.3**。当前 `main` 已包含**受击自卫 V2**，以及经审查的**羊毛/床染色、放置转向时序、非完整高度方块到达判定修复**。这些改动记录在[更新日志](CHANGELOG.md)的 Unreleased 部分，不代表已发布新的版本号。源码更新不会升级正在运行的游戏后端，详见[兼容性说明](docs/COMPATIBILITY.md)和[审核后的升级流程](docs/UPGRADING.md)。

**本项目仍是实验软件。** 工具出现在目录里或通过离线测试，不代表其完整行为已在真实服务器验证。尤其是**船的放置、乘坐、操控，以及 V2 实战效果，仍未完成真实服务器验证**。请先备份重要世界，在获授权的测试环境中试用，并阅读[范围与限制](INTEGRATION.md)及[安全说明](SECURITY.md)。依赖审查仍须关注已记录的开发测试 glob 与可选认证依赖链风险；本候选版不代表无漏洞认证。

## 当前源码提供的能力

- **持久会话与可替换控制器**：一个游戏后端，同一时刻一个 MCP 或文件队列控制器，动作串行执行，不自动重连或重放
- **以服务器证据为准的物品操作**：背包、合成、精确堆叠装备、容器、进食和熔炉转移依赖新鲜的服务器确认；结果不确定的修改会锁住后续动作
- **受限游戏工具**：观察、移动/视角/寻路、挖掘/放置、方块交互、耕作、非玩家战斗、睡眠、钓鱼、工作站操作、聊天、告示牌/书本、事件和路标均有实现，离线覆盖深度各不相同。[能力矩阵](docs/CAPABILITY-MATRIX.md)区分专用测试与仅注册目录的条目；工具别名不等于独立能力
- **有明确边界的扩展**：干地寻路与当前玩家氧气保护、明确请求的上浮、分批采集/回仓/补给和简单方块蓝图、可选自卫 V2，以及默认关闭的只读观察

工具可调用不等于获准执行；仍须遵守效果确认要求、服务器/插件兼容范围及下述限制。

## 环境与授权

- Node.js 22.x（至少 22.13）或 24+、npm；持久 Unix socket 运行时需要 Linux
- 文件队列助手需要 Python 3；可选原生启动窗口还需要 Tk 与 Linux pidfd
- 支持本地 stdio 进程的 MCP 客户端
- 获准让机器人连接目标 Minecraft 服务器，并进行预期的世界修改

受限运行时只连接本机 loopback，使用 Minecraft `offline` 协议身份。它**不能**代替微软账号认证，也不会绕过白名单、服务器登录插件、归属规则或服务器政策。远程或需要认证的服务器，须另行提供并授权本地桥接程序或受支持的认证集成。仓库不包含桥接程序、账号、密码、令牌、真实服务器配置或服务器部署系统。不要把凭据放进 MCP 参数、聊天或命令行。

## 安装与离线检查

在仓库根目录执行：

```sh
npm ci --ignore-scripts
npm ci --ignore-scripts --prefix vendor/awesome-mineflayer-mcp
npm run build:upstream
npm run verify
npm run test:upstream
python3 scripts/publication-manifest.py --check
```

两份锁文件均已包含，安装时应保留。`verify` 会构建第一方代码，并执行类型、lint、单元、stdio、合成协议、队列、启动器生命周期、守护进程、观察界面、工作流和自卫检查。测试使用中性模拟数据与本机回环连接，不连接已有服务器或账号。本地 TCP/Unix socket 测试需要允许相应套接字的环境。

[GitHub Actions](https://github.com/Aoi-dottttttt/Minecraft-dots-mcp/actions) 在 Node 22 和 24 上执行离线套件，并另行运行合成浏览器与原生三维测试。请核对准备安装的确切提交所对应的结果。[VALIDATION.json](VALIDATION.json) 是带日期的 rc.3 历史验证快照，保留了当时的本地阻碍，不是此后每次提交的实时验证结果。CI 或本文都不代表真实服务器验收。

只查看离线模拟结果、不连接游戏：

```sh
node runtime/minecraft-client.mjs --offline-fixture --state-dir "$(mktemp -d)"
```

该命令启动模拟游戏后端，写入本地工具目录和模拟结果后退出，不能用于游玩 Minecraft。

## 手动开始一次获授权的本地会话

仅在服务器、身份和预期游戏动作均获批准后，明确启动守护进程。以下示例连接端口 25565 上的本地测试服务器，或已经单独启动的本地桥接程序：

```sh
umask 077
GAME_DIR="$(mktemp -d)"
node runtime/minecraft-daemon.mjs --user-started-session 25565 \
  --username ExampleBot --state-dir "$GAME_DIR"
```

保持该后端运行。在 MCP 客户端中配置 `node`，参数为 `runtime/minecraft-frontend.mjs --attach ABSOLUTE_GAME_DIR`，并将运行时文件和游戏状态目录替换为实际的绝对路径。参考[客户端配置模板](examples/mcp-client.example.json)。

也可让文件队列控制器连接同一个守护进程。新终端不会继承先前的 shell 变量，请在新终端中将 `GAME_DIR` 和 `CONTROLLER_DIR` 设为对应的实际目录路径：

```sh
CONTROLLER_DIR="$(mktemp -d)"
node runtime/minecraft-client.mjs --attach "$GAME_DIR" --state-dir "$CONTROLLER_DIR"
# 在另一个终端使用同一控制器目录：
python3 runtime/call.py --state-dir "$CONTROLLER_DIR" get-session-status
```

同一时刻只有一个控制器可操作。替换前先停止旧控制器，并使用全新的控制器目录。不要复用旧队列、重试结果不确定的物品操作或绕过不确定性安全锁。使用 `disconnect-player` 明确退出游戏。控制器脱离会停止持续控制，但保留后端连接；无人照看时角色仍可能受伤、坠落、溺水或被服务器踢出。真实断线后不会自动重连。

可选 Linux 启动窗口见[持久会话说明](PERSISTENT-SESSIONS.md)。它需要用户自行提供的外部桥接程序，点击 Start 之前不会读取桥接配置。

## 最近合入的改进

当前 `main` 已包含 [PR #9](https://github.com/Aoi-dottttttt/Minecraft-dots-mcp/pull/9) 和 [PR #10](https://github.com/Aoi-dottttttt/Minecraft-dots-mcp/pull/10) 中经审查的改动，完整记录见[更新日志](CHANGELOG.md)。

- **羊毛与床的染色配方**：Java 1.21.1 的配方查询与受验证合成使用一致的原版颜色替代配方，拒绝同色输入，保留材料/产物精确确认、取消和不自动重试规则。其他版本，以及覆盖原版配方的数据包或插件，不在本次修复范围
- **放置前的转向时序**：原生放置先朝向实际点击的方块面，等待一个原生物理 tick，再核对稳定姿态、距离、目标和手持物。瞄准期间收到 V2 防御请求，会停止尚未提交的放置；已经提交的放置则先完成关键确认。这不代表所有朝向方块、床或船的真实服务器放置行为已验证
- **非完整高度方块的到达判定**：包括原生 `goto` 在内的受验证移动，可依据已加载碰撞形状，识别站稳在受支持的耕地、下半砖和无遮挡楼梯低踏面上的到达。目标半径、干地/氧气保护和取消规则不变；这不会同时开放抬高/半砖门槛或任意非完整高度方块路线
- **受击自卫 V2**：加入可续期的被动举盾与朝向控制、有限的同高度移动请求，以及严格核验的非转移盔甲槽耐久损耗例外。启用准备和限制见下节

详细证据和边界见[兼容性说明](docs/COMPATIBILITY.md)。这些修复没有改变软件包版本、IPC 版本 1 或依赖锁文件。

## 有边界的游戏流程

[移动安全说明](docs/MOVEMENT-SAFETY.md)涵盖干地寻路、当前玩家氧气保护、明确请求的上浮与船只放置证据。意外入水会停止普通导航，但松开控制并不能让水下角色安全；没有无人值守救援或自动选岸。上浮要求已加载、畅通的水源柱和新鲜的当前玩家氧气证据，也不确认已抵达安全陆地。船只放置、乘坐和操控仍需单独获授权的真实服务器端到端验证。

[工作流说明](docs/WORKFLOWS.md)提供可先审阅的采集 → 回仓 → 补给计划和简单方块蓝图。`run-workflow` 每次使用当前 `expectedRevision`，只执行明确请求的 1–4 步，保留精确进度，不自动续跑或重试不确定步骤。采集仅支持限定的地形/物品集合，不涵盖通用矿石、伐木或农场循环。蓝图只接受有界的 `prismarine-schematic` JSON 和白名单内的无朝向方块，不支持任意二进制蓝图、清空区域或完整自主生存建筑。即使目标很近，也可能因不可达或看不到方块面而被拒绝。

## 可选的受击自卫 V2

[有限怪物自卫](docs/SELF-DEFENSE.md)已包含在当前源码中，**默认关闭，每次会话须明确启用**。请在安全时预先准备快捷栏内可用的斧/剑和副手盾牌；不会自动穿戴盔甲。`self-defense-enable`、`self-defense-status`、`self-defense-disable` 均使用 `{}` 参数；`stop-movement` 也会关闭防御，可用作紧急停止。

只有服务器发给本角色的受伤事件才会触发应对；反击须明确归因到允许的怪物，玩家、宠物、命名实体及身份不确定的目标均被拒绝。V2 持续朝向已归因的攻击者，并可通过新的受伤事件，或仍可见、仍有效的已归因威胁，续期八秒的被动防御时限。近战最多持续 12 秒/请求 16 次攻击，移动最多请求三次经过检查的同高度步进，且不超过受伤起点四格范围。被动防御续期不会重置这些主动动作预算，不会新增挖掘、放置、开门、跳跃、涉水或盲目追击。已提交的物品/放置操作会先完成其确认边界，再让防御占用动作队列；被中断的工作不会自动重放。

`shieldRequestActive` 只表示已请求举盾，**`shieldEffectConfirmed` 仍为 false**。缺盾/盾损坏、冷却、盔甲丢失、多名攻击者、未知伤害来源和没有可用逃生路线都会明确告警。V2 不会在战斗中从背包存储区换装。离线测试不证明举盾时机/效果、真实撤退、服务器/插件兼容性或生存能力，不能依赖它无人值守保命。已有后端须另行获准安装并开始新会话，才能加载这些变化。

## 可选的只读观察

仅在启动新的获授权守护进程会话时添加 `--observe-port 3100`，即可在 `http://127.0.0.1:3100/` 查看本地状态/背包面板和 Prismarine 三维重建。它复用现有机器人，不接收游戏操作，默认关闭；没有远程监听、认证或公网暴露配置。不要转发端口或通过反向代理公开它。详见[观察界面的架构、安全与测试](docs/READONLY-OBSERVER.md)。

原生状态/背包窗口可在同一桌面运行 `python3 runtime/observer-ui.py --state-dir "$GAME_DIR"`。它只读取现有私有文件，不提供三维，也不会绕过浏览器限制。当前玩家氧气来自原始服务器元数据，未知值会明确显示。

文件式原生三维重建使用另一个默认关闭的新会话参数 `--observe-world-files`，导出已加载的 17×13×17 格局部区域，每两秒最多一次。明确启动网格转换器并单独安装 Godot 视图后，可使用官方几何/纹理显示重建，并标注未知和过期数据。详见[原生启动方式、限制与资源测量](docs/WORLD-MESH-PROTOTYPE.md)。它不是原生 Minecraft 客户端截图，也不能无限查看世界。

## 入口与安全边界

- `runtime/minecraft-daemon.mjs` + `minecraft-frontend.mjs`：受限集成运行时
- `runtime/minecraft-client.mjs`：该运行时的私有文件队列控制器
- `dist/main.js`：旧版兼容入口，默认不连接；工具较少，**没有**应用受限集成入口的全部策略，包括聊天/命令限制
- `vendor/awesome-mineflayer-mcp`：复用的上游工具源码；其独立入口**不是**本项目的受限运行时，可能提供更宽的能力

不要将任何入口作为未认证的远程服务公开。所有游戏修改仍需用户授权。收到的游戏文本、名字、书本和告示牌都是不可信数据，不能授权外部行为。运行时文件可能包含聊天、位置、玩家标识、背包和动作结果，应保存在仓库之外并严格限制访问；不要上传完整状态或日志。

## 来源与许可证

- Yuniko Software 的 `minecraft-mcp-server` 2.0.4，源码提交 `240c8cec337ce152cc9e058ebdef511055808406`：Apache-2.0，保留于 [LICENSE](LICENSE) 和 [NOTICE](NOTICE)
- `awesome-mineflayer-mcp` 1.3.2，提交 `89a407ca18a4a39196c6ebe726d5208cff88a9e5`：MIT，保留于[上游 LICENSE](vendor/awesome-mineflayer-mcp/LICENSE) 和[上游 NOTICE](vendor/awesome-mineflayer-mcp/NOTICE)
- 第一方修改与验证范围：[RELEASE.md](RELEASE.md)

最初的公开源码树有意不包含私有 Git 历史。安装后的依赖包保留各自许可证。Minecraft 是 Mojang 的商标；本项目与 Mojang 或 Microsoft 无隶属关系。
