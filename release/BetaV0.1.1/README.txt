DBAgent BetaV0.1.1 测试包

文件说明：
- DBAgent-BetaV0.1.1-Setup.exe：Windows 安装包。
- DBAgent-BetaV0.1.1-win-unpacked.zip：免安装解压包，解压后运行 DBAgent.exe。
- SHA256SUMS.txt：文件 SHA256 校验和。

本轮重点：
- Python 环境配置支持 system、venv、conda 三种模式，支持自动检测、目录选择和创建环境入口。
- 底部面板增加多终端管理，可以新增、关闭、切换终端并执行命令。
- 右侧 Agent 面板改为单一对话入口，顶部仅保留历史、设置、新对话三个动作。
- 账号模块新增注册、账密登录、验证码登录、忘记密码重置密码的本地流程。
- 账号数据使用 PostgreSQL 存储，启动前需要配置 DBAGENT_AUTH_DATABASE_URL。
- 插件市场增加官方插件注册表雏形，支持安装、卸载和状态持久化。

本地账号测试前提：
- 先准备一个 PostgreSQL 数据库。
- 启动应用前设置环境变量 DBAGENT_AUTH_DATABASE_URL，例如：
  postgresql://postgres:postgres@127.0.0.1:5432/dbagent_auth
- 当前本地验证码会在界面中返回开发测试码，后续接入云端短信/邮箱服务后不会暴露验证码。

已知限制：
- 终端当前是命令执行型多会话，不是完整 PTY 交互终端；下一轮需要接入 node-pty 才能达到 VS Code/JetBrains 级终端体验。
- 密码哈希当前为本地开发实现，正式云端账号服务前需要升级为 argon2/bcrypt。
