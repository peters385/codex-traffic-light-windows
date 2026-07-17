# Codex 红绿灯 Windows 版

一个 Windows 桌面悬浮状态灯，用红黄绿灯实时提示 Codex 当前状态。它适合把 Codex 放在后台跑任务时使用：不用一直盯着窗口，也能知道现在是在工作、等待确认、可以验收，还是已经空闲。

![Codex 红绿灯悬浮窗](docs/images/floating-window.png)

## 功能亮点

- 黄灯：Codex 正在处理任务。
- 红灯：Codex 正在等待你确认、授权或回答问题。
- 绿灯：任务完成，可以验收；保持 10 分钟后自动切到空闲。
- 全灭：空闲、启动初始状态，或你中途点击了停止。
- 支持单灯/三灯模式、明暗主题、声音提醒开关、托盘常驻和开机启动开关。
- 状态自动驱动，悬浮窗里的灯只负责展示，不需要手动点灯。

## 下载与安装

1. 打开 GitHub 仓库右侧的 **Releases**。
2. 下载 `Codex.Setup.0.1.0.exe`。
3. 双击安装并启动应用。
4. 在 Codex 中运行 `/hooks`。
5. 按 Codex 提示信任 `Codex 红绿灯` hooks。

> 当前安装包没有代码签名，Windows 可能显示 SmartScreen 或“未知发布者”提示。这不是程序联网校验失败，而是未签名开源安装包的常见提示。

## 使用方式

启动后，应用会常驻托盘，并显示一个透明悬浮状态卡片。正常使用时不需要点击灯泡，灯光会跟随 Codex 状态自动变化。

![单灯模式](docs/images/single-mode.png)

托盘菜单里可以显示/隐藏悬浮窗、重新写入 Codex hooks、查看配置路径、切换开机启动，也可以通过“测试灯光”排查 UI 和状态文件。

![托盘图标](docs/images/tray-icon.png)

## 状态映射

| Codex 事件 | 状态 | 灯 |
| --- | --- | --- |
| `UserPromptSubmit` / `task_started` / 普通运行事件 | `working` | 黄灯 |
| `PermissionRequest` / `request_user_input` / 计划确认 | `waiting` | 红灯 |
| `Stop` / `SubagentStop` / 普通 `task_complete` | `done` | 绿灯 |
| `turn_aborted` / 应用启动 / 绿灯 10 分钟后 | `idle` | 全灭 |

## 本地文件

应用会在本机写入这些文件：

```text
%USERPROFILE%\.codex\bin\codex-light.cmd
%USERPROFILE%\.codex\bin\codex-light.ps1
%USERPROFILE%\.codex\bin\codex-light-hook.ps1
%USERPROFILE%\.codex\hooks.json
%APPDATA%\CodexTrafficLight\state.json
%APPDATA%\CodexTrafficLight\preferences.json
```

状态文件格式：

```json
{
  "state": "working",
  "event": "desktop-task-started",
  "updated_at": 1784280000
}
```

## 命令行测试

如果 `%USERPROFILE%\.codex\bin` 在 `PATH` 中，可以直接运行：

```powershell
codex-light working
codex-light done
codex-light waiting
codex-light idle
codex-light status
```

也可以使用完整路径：

```powershell
& "$env:USERPROFILE\.codex\bin\codex-light.ps1" working
```

## 开发

需要 Node.js 和 npm。

```powershell
npm install
npm run dev
```

构建前端：

```powershell
npm run build
```

打包 Windows 安装器：

```powershell
npm run dist:win
```

打包产物会输出到 `release/`。

## 隐私说明

这个工具只在本机工作：

- 不上传 Codex 对话内容。
- 不连接第三方状态服务。
- 只读取本机 Codex hooks 和 session 事件，用来判断灯光状态。
- 状态和偏好都保存在 `%APPDATA%\CodexTrafficLight`。

## 常见问题

**安装时提示未知发布者怎么办？**  
当前版本没有代码签名，Windows 会把安装包标记为未知发布者。确认你是从本仓库 Release 下载后，可以选择继续运行。

**灯不自动亮怎么办？**  
先在 Codex 中运行 `/hooks`，确认已经信任 Codex 红绿灯 hooks。也可以右键托盘图标，选择“重新写入 Codex hooks”。

**为什么托盘里有“测试灯光”？**  
这是排查用入口。正常使用时灯光由 Codex 自动驱动，不需要手动切换。

**点击停止后为什么应该全灭？**  
点击 Codex 对话里的停止会产生 `turn_aborted` 事件，表示当前轮次不再运行，所以工具会切回 `idle`。

**绿灯为什么会自动熄灭？**  
绿灯代表“本轮完成，可以验收”。为了避免完成状态长期停留，绿灯保持 10 分钟后会自动切到空闲。

## 许可证

MIT
