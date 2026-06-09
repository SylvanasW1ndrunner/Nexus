# BetaV0.1.1 终端面板 VSCode 风格校准

## 背景

用户反馈底部控制台需要直接对齐 VSCode 的面板风格：上方是 `PROBLEMS / OUTPUT / DEBUG CONSOLE / TERMINAL / PORTS` 标签，右侧是当前终端和动作按钮，终端正文区域应保持低干扰、深色、紧凑的命令行体验。

## 本次调整

- 将终端会话选择、创建、分屏占位、清空、更多、最大化占位、关闭按钮合并到底部面板标题栏右侧，去掉旧版额外的第二行终端工具栏。
- 终端正文改为单一滚动区域，输出和当前命令输入行处于同一视觉区域内；空终端时 prompt 靠近顶部，更接近 VSCode 的空终端状态。
- 清理旧版依赖字体字符的按钮图标，改为 CSS 绘制的小图标，降低 Windows/Linux 字体差异导致乱码或风格不一致的风险。
- 终端标题栏按钮统一为 VSCode 风格的透明按钮、悬浮高亮、禁用弱化，减少按钮边框和色块对界面的干扰。

## 当前边界

- 当前终端仍是项目已有的 shell 会话封装，不是完整 PTY 组件；本次只校准前端结构和视觉表现。
- `Split Terminal`、`More Actions`、`Maximize Panel` 已按 VSCode 位置预留，但功能仍处于禁用占位状态，后续需要接入真正的分屏、动作菜单和面板最大化。
- 本地 Browser 和 Chrome 扩展本轮不可用，未完成自动截图校验；已完成类型检查、局部 lint、终端服务测试和桌面完整构建。

## 验证

- `tsc -p apps/desktop/tsconfig.json --noEmit`
- `eslint apps/desktop/src/renderer/src/App.tsx`
- `vitest run apps/desktop/src/main/terminal-service.test.ts`
- `apps/desktop` 完整构建链路：main、preload、renderer 均构建通过。
