# 观心 · 塔罗自我探索

78 张牌、25 套牌阵、正逆位抽牌、本地解读，以及可选的大模型润色、动态三问、牌阵推荐、综合解读和连续追问。

共享体验码为 **641320**，输入用圆点遮挡。它只是公开体验入口提示，不是用户身份认证。

## 两种运行方式

- [GitHub Pages 基础体验](https://cgzs-li.github.io/guanxin-tarot/)：抽牌、本地背景问题、规则推荐和本地解读可用。AI 尚未在此入口开放；页面不提交问题到模型。
- Render 完整体验：本仓库的 `render.yaml` 运行网页和 Python 后台，所有 AI 请求使用同一站点。首次部署完成后，Render 提供 HTTPS 体验网址。尚未部署时，不能把 GitHub Pages 当作 AI 已上线。

## 部署完整 AI 体验

1. 打开 [Render 部署入口](https://render.com/deploy?repo=https://github.com/cgzs-li/guanxin-tarot)，登录 Render 并连接本 GitHub 仓库。
2. 使用仓库中的 Blueprint 配置创建服务，确认是 **Free** 方案。
3. 在 Render 的 `FLOWBEE_API_KEY` 私密环境变量中填写模型 Key；不要写进代码、Issue 或聊天。
4. 默认模型为 `agnes-3.0-flash`，地址为 `https://flowbee.top/v1`。可以在环境变量里更换为自己可用的模型。
5. 等待服务 Live，使用 Render 分配的 HTTPS 网址。先用虚构问题验证润色、三问、推荐、解读和追问。

免费服务空闲 15 分钟会休眠，首次唤醒可能需要等待；每工作区每月有 750 免费实例小时（核验于 2026-10-27）。服务重启会清除内存对话，重新生成解读可恢复追问。具体平台权限、额度与资费以账户和当时规则为准。

## 随时暂停

| 目标 | 操作 |
| --- | --- |
| 只停 AI，网页仍可抽牌 | Render 环境变量 `GUANXIN_AI_ENABLED=false`，保存并应用变更 |
| 整站显示暂停页面，并拦截新 AI 请求 | `GUANXIN_SITE_ENABLED=false`，保存并应用变更 |
| 暂停完整服务 | 在 Render 服务页执行 Suspend，日后可恢复 |
| 关闭 GitHub Pages 基础入口 | 仓库 Settings → Pages 中取消发布（Unpublish site） |
| 停用对应模型凭证 | 在模型平台撤销专用 API Key |

**不必删除仓库。** GitHub Pages 和 Render 是两个独立入口，若要全部关闭，需要分别停止。删除仓库不能保证独立后台立即停止；暂停服务或关闭开关更直接。已打开或已下载的静态副本无法远程收回，但后台停用后不能继续调用 AI。

## 配置和数据

- 密钥只存 Render 环境变量；`config.local.json`、数据库和缓存不会进入仓库或 Pages 产物。
- 点击 AI 润色或进入背景步骤会发送问题和主题；进入牌阵步骤还会发送已填背景；AI 解读/追问发送本次抽牌和相关对话。模型服务的数据处理以其规则为准。
- 应用不记录问题和对话日志，仅用内存保存短时对话。托管平台仍可能有独立访问日志。
- 公开模式仅接受本服务域名和同源请求；限制每 IP 每小时 20 次、每实例滚动 24 小时 300 次 AI 请求，同时最多 4 个模型请求。计数和对话在进程重启后清除，属于基础体验限流，不是账户账单的硬上限。
- 请使用专用的免费分组 Key，在模型平台设置可用额度或预算约束。应用不会自行切换模型。

## 本机继续开发

将 `llm-backend/config.example.json` 复制为 `llm-backend/config.local.json`，填写自己的配置后运行：

```sh
python llm-backend/server.py
```

本机默认只监听 `127.0.0.1:8790`。Render 自动提供 `PORT` 和 `RENDER_EXTERNAL_URL`；公开模式监听 `0.0.0.0`，`/healthz` 用于健康检查。

`backend/` 是历史收费/激活码本地原型，保留供参考；当前免费体验和 Render 配置均不运行它，也不连接其数据库。

牌图来源见 `牌图来源.json`。塔罗与模型回答仅供娱乐和自我反思，不代表他人的真实想法或确定未来。

平台说明：[Render 免费服务](https://render.com/docs/free)、[Blueprint 配置](https://render.com/docs/blueprint-spec)。
