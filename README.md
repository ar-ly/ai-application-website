# AI App Builder

一个基于自然语言生成可交互网页应用的全栈工具。注册登录后输入一句话需求，后端调用大模型实时生成完整 HTML 应用，在右侧 iframe 中实时预览，支持多轮对话修改、版本管理、一键下载和独立分享链接。账号与会话数据持久化于云端数据库，换设备登录即可找回全部历史。

## 技术栈

| 层 | 技术 |
|---|---|
| 前端 | React 18 + Vite + Tailwind CSS |
| 后端 | Express (Node.js) |
| AI | DeepSeek API（支持流式输出与自动续写） |
| 数据库 | Neon PostgreSQL（云端持久化，免运维） |
| 鉴权 | scrypt 加盐密码哈希 + HMAC 签名令牌（30 天有效期） |
| 部署 | Render / Railway（支持从公开 Git 仓库一键部署） |

## 核心功能

- **注册登录**：账号体系 + 加密存储的密码凭证，数据按账号隔离，跨设备同步
- **自然语言生成应用**：输入需求描述，实时流式生成完整可运行的 HTML 应用
- **三栏工作台**：会话管理 / 对话交互 / iframe 实时预览
- **多轮迭代**：在已有应用基础上发送修改需求，自动续写并更新预览
- **版本管理**：每次生成的应用自动存为一个版本，可随时查看、预览历史版本并一键回滚
- **代码查看**：随时查看当前应用的完整源代码并复制
- **推荐 Prompt**：新会话预置创意方向卡片，支持"换一批"循环推荐
- **指令优化**：一键将简短想法扩写为结构化生成指令
- **文件上传**：支持上传 .txt / .md / .json / .csv 等文本材料作为生成参考
- **生成队列**：生成中可继续发送需求，自动排队顺序执行
- **停止保留成果**：中途停止生成时，自动抢救已生成的部分代码并展示进度
- **未读提醒**：新产物生成后左侧会话列表显示绿点，查看后消失
- **应用下载**：从服务端拉取最新通过完整性校验的完整 HTML 文件
- **演示模式**：内置已验证应用模板，无 API 配额时也可完整体验全部功能

## 快速开始

```bash
# 安装依赖
npm install

# 配置环境变量（在项目根目录创建 .env 文件）
# DEEPSEEK_API_KEY=your_key_here          # 可选：真实 AI 生成
# DATABASE_URL=postgresql://...neon.tech/neondb?sslmode=require   # Neon 云数据库
# AUTH_SECRET=any_random_string           # 令牌签名密钥

# 开发模式（前端 5173 + 后端 3001，同时启动）
npm run dev:all

# 生产模式（先构建，再启动单服务）
npm run build
npm start
```

## 部署到 Render（免费）

1. 将代码推送到 GitHub 公开仓库
2. 在 [Render](https://render.com) 创建 Web Service
3. 连接仓库（或使用公开仓库 URL），配置：
   - Build Command：`npm install && npm run build`
   - Start Command：`npm start`
4. 设置环境变量：
   - `DATABASE_URL`（Neon 连接字符串，见 https://neon.com ）
   - `AUTH_SECRET`（任意随机字符串）
   - `MOCK_MODE=true`（启用演示模式，详见下文）
   - `PORT=3001`
5. 部署后获得公开访问链接

## 演示模式（Mock Mode）

为保障部署环境的稳定性与可重复性，系统内置演示模式：设置环境变量 `MOCK_MODE=true`（或未配置 API Key）后，生成请求将从 `server/mock-products/` 目录加载预置的已验证应用模板，按关键词匹配返回并模拟流式输出，无需消耗 API 配额。适用于：

- 无 API 配额环境下的在线演示
- 功能回归测试与 CI 流水线
- 前端交互的独立开发与调试

代码中 DeepSeek 流式接入逻辑完整保留：配置 `DEEPSEEK_API_KEY` 并移除 `MOCK_MODE` 变量，即可切换为真实 AI 生成模式。

## 项目结构

```
├── src/
│   ├── App.jsx          # 主界面（登录门禁 + 三栏布局 + 全部交互逻辑）
│   ├── services/ai.js   # API 调用封装（凭证管理 + 流式 SSE 处理）
│   └── index.css        # Tailwind 入口
├── server/
│   ├── index.js         # Express 后端（鉴权 + API 路由 + SSE 流式 + Mock 模式）
│   ├── store.js         # Neon PostgreSQL 数据层（users / sessions / messages）
│   ├── mock-products/   # 预置演示应用
│   └── data/            # 本地运行数据（自动创建，gitignore）
├── dist/                # 前端构建产物（npm run build 生成）
├── vite.config.js       # Vite 配置（开发代理 /api → 3001）
└── package.json
```

## API 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | /api/auth/register | 注册（返回登录令牌） |
| POST | /api/auth/login | 登录（返回登录令牌） |
| GET | /api/auth/me | 校验令牌 / 恢复登录态 |
| GET | /api/sessions | 当前账号的会话列表（含未读状态） |
| POST | /api/sessions | 创建会话 |
| GET | /api/sessions/:id | 会话详情（含全部版本消息） |
| DELETE | /api/sessions/:id | 删除会话 |
| POST | /api/sessions/:id/read | 标记会话已读 |
| POST | /api/sessions/:id/rollback | 版本回滚（设为当前应用） |
| POST | /api/upload | 上传文本文件（白名单校验） |
| POST | /api/refine-prompt | 指令扩写（非流式） |
| POST | /api/generate | 生成应用（SSE 流式，支持 Mock） |
| POST | /api/generate/:taskId/stop | 停止指定生成任务 |
| GET | /api/health | 健康检查（含数据库状态） |
| GET | /apps/:sid/:mid | 生成的应用独立访问链接（可分享） |

## 扩展计划

- 图片 / Word / PDF 上传解析（目前仅支持文本类文件）
- 产物版本差异对比（当前支持预览与回滚）
- 多人协作会话（共享链接 + 协同编辑）
- 更长的上下文模型接入，减少截断续写次数
- 应用模板市场（用户可保存和分享模板）

## License

MIT
