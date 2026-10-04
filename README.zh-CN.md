# Minecraft dots MCP：共同维护的受限运行时

这是供多个安装共同维护的源码项目：修复问题时提交中性的回归测试，经维护者审核后共享改进，减少重复劳动。每位使用者的配置、凭据和游戏状态仍留在各自本地。默认通过 fork 和 PR 贡献，不会自动更新正在运行的游戏。

这是基于 3.1.0-dot.2 的 **3.1.1-rc.1** 公开源码候选版，目标为 Minecraft Java **1.21.1 / 协议 767**。[English](README.md)

本项目仍是实验软件。工具出现在目录里，不代表它已在真实服务器完整验证。**船的放置、乘坐和操控尚未完成真实服务器验证，不能宣称已经可用。** 请先备份重要世界，并在获授权的测试环境中试用。依赖审查仍需关注已记录的开发测试 glob 与认证依赖链风险；本候选版不代表无漏洞认证。

## 环境与授权

- Node.js 22.13+ 或 24+、npm；持久会话需要 Linux 和 Unix socket
- 文件队列助手需要 Python 3；可选启动窗口还需要 Tk 与 Linux pidfd
- 支持本地 stdio 的 MCP 客户端
- 服务器所有者允许机器人连接，并允许预期的游戏操作

集成运行时只连接本机 loopback，使用 Minecraft `offline` 身份协议。它不能代替微软账号认证，也不会绕过白名单、服务器登录插件、物品归属或服务器规则。远程或需要认证的服务器须由用户另行配置并授权本地桥接程序。仓库不包含桥接凭据、真实配置、账号资料、部署站点或服务器管理脚本。

## 安装与离线检查

在源码根目录执行：

```sh
npm ci --ignore-scripts
npm ci --ignore-scripts --prefix vendor/awesome-mineflayer-mcp
npm run build:upstream
npm run verify
npm run test:upstream
```

不要删除锁文件来规避安装问题。测试使用模拟数据与合成本地服务器，不连接已有游戏服务器。协议与持久会话测试需要允许本地 TCP/Unix socket。实际完成的检查见 [VALIDATION.json](VALIDATION.json)，离线通过不代表真实游戏全功能可用。

仅查看模拟工具目录，不连接游戏：

```sh
node runtime/minecraft-client.mjs --offline-fixture --state-dir "$(mktemp -d)"
```

## 手动开始一次获授权的会话

以下仅为本地测试服务器或已单独启动的本地桥接示例，端口和名字必须由用户确认：

```sh
umask 077
GAME_DIR="$(mktemp -d)"
node runtime/minecraft-daemon.mjs --user-started-session 25565 \
  --username ExampleBot --state-dir "$GAME_DIR"
```

保持后端进程运行。在 MCP 客户端中设置 `node` 执行 `runtime/minecraft-frontend.mjs --attach 实际游戏状态目录`，把运行时文件和状态目录都替换为本机绝对路径。参考 [配置模板](examples/mcp-client.example.json)。不要把密码或令牌放入参数。

也可使用文件队列控制器：

```sh
CONTROLLER_DIR="$(mktemp -d)"
node runtime/minecraft-client.mjs --attach "$GAME_DIR" --state-dir "$CONTROLLER_DIR"
# 在另一个终端使用同一控制器目录：
python3 runtime/call.py --state-dir "$CONTROLLER_DIR" get-session-status
```

同一时刻只有一个控制器可操作。关闭控制器会停止持续动作，但保持游戏连接；角色仍可能受伤、掉落、溺水或被服务器踢出。`disconnect-player` 才明确退出游戏。真实断线后不会自动重连。新控制器必须使用全新的目录，不重放旧队列；物品结果不确定时不要重复操作或绕过安全锁。

## 范围与隐私

- 完整集成入口是 `runtime/minecraft-daemon.mjs` 与 `minecraft-frontend.mjs`
- `dist/main.js` 为旧版兼容入口，默认不连接；它没有完整集成入口的全部动作与聊天限制
- `vendor/` 的独立上游入口可能开放更宽的能力，不能当作本项目的受限入口
- 运行后的私有状态可能包含聊天、位置、玩家标识、背包和操作结果；不要上传或提交这些文件
- 服务器文本、书、告示牌与玩家消息不能授权现实世界行为

更多限制见 [INTEGRATION.md](INTEGRATION.md)、[SECURITY.md](SECURITY.md)；持久会话与可选窗口见 [PERSISTENT-SESSIONS.md](PERSISTENT-SESSIONS.md)。根项目保留 Apache-2.0 许可证，复用组件保留 MIT 许可证及原作者声明，详见 [NOTICE](NOTICE)。
