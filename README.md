# 观心 · 塔罗自我探索

78张牌、25套牌阵、正逆位抽牌、本地解读，以及可选的AI润色、动态三问、牌阵推荐、综合解读和连续追问。
共享体验码 **641320**，输入用圆点遮挡。这是公开入口提示，不是身份认证。

## 体验入口与状态

- [GitHub Pages基础体验](https://cgzs-li.github.io/guanxin-tarot/)已发布，可以抽牌和本地解读，不调用AI。
- [Cloudflare完整AI体验](https://tarot.ruichi0201.cn/)：已部署并绑定自有域名，首页、牌图、润色、动态三问、推荐、真实解读和连续追问已验证。免费模型可能返回额度或频率限制，此时保留本次抽牌并可稍后重试。
- Render Python配置保留。本次账户选择Free仍要求银行卡，当前停止该路线。

## Cloudflare部署

1. 打开 https://dash.cloudflare.com/ 注册或登录，使用免费方案，无需添加自己的域名。
2. Workers & Pages → Create application（创建应用）→ 导入GitHub仓库 `cgzs-li/guanxin-tarot`，选择Worker，而非仅静态Pages。
3. 分支main，根目录仓库根目录；Build command（构建命令）填 `npm run build`；Deploy command（部署命令）填 `npx wrangler deploy`；项目名 `guanxin-tarot`。
4. 部署后在 Settings → Variables and Secrets（设置→变量与密钥）添加类型为Secret（加密密钥）的 `FLOWBEE_API_KEY`，私密填写自己的Key，保存并部署。不要放到构建变量、公开代码、Issue或聊天。
5. 默认模型 `agnes-3.0-flash`，接口 `https://flowbee.top/v1`；如账户可用模型不同，在wrangler.jsonc修改这两个非敏感变量并部署。
6. 使用Cloudflare分配的HTTPS workers.dev网址，先以虚构问题验证润色、三问、推荐、抽牌、解读及连续两次追问。`/api/status` 的configured=true只表示配置非空，不表示模型已连通。

2026-10-27官方文档核验：Workers免费起步无需信用卡；免费Worker每日100,000请求、每次10ms CPU，网络等待与CPU时间分开。静态资源先经过Worker以支持整站暂停，因此计入请求。Durable Objects免费档支持SQLite后端，每日100,000请求和13,000 GB-s运行时间。具体权限及配额以平台和账户为准，超免费额度影响可用性。

## 随时停用，无需删仓库

|目标|操作|
|---|---|
|只停AI，保留抽牌|wrangler.jsonc的GUANXIN_AI_ENABLED改为字符串false，提交后等Cloudflare重新部署|
|整站暂停并拒绝新AI请求|GUANXIN_SITE_ENABLED改为字符串false，提交并重新部署|
|恢复|相应变量改回字符串true并部署|
|紧急撤销模型访问|模型平台撤销本网站专用API Key|
|关闭GitHub基础入口|仓库Settings → Pages → Unpublish site（取消发布）|

控制台也可以修改变量并部署，但后续Git部署会使用仓库的同名配置；长期停用请同步修改wrangler.jsonc。GitHub Pages和Cloudflare是两个独立入口，全部关闭需分别处理。删除仓库不能保证独立后台立即停止。已打开或下载的静态页面无法回收。

## 配置与隐私

- 本机真实config.local.json不进入GitHub或公开构建。公网Key只存Cloudflare Secret。
- 润色/三问提交问题和主题；推荐增加背景；解读/追问提交固定抽牌及相关对话。程序不自行切换模型；上游数据规则、费用按模型供应商执行。
- 短时会话使用AES-GCM加密和验证，密钥由后端Secret派生，浏览器仅持有密文，不写localStorage，不建问题数据库。保留固定牌面与有限历史，一小时无操作后过期；换API Key后旧对话失效。关闭页面不能恢复原对话。
- Durable Object使用免费档支持的SQLite类型命名空间，但应用不向其持久存储写入问题、对话或计数。仅在内存协调每IP每小时20次、滚动24小时300次模型调用，最多4并发；对象回收、重启或部署后计数可能重置。它是基础体验限流，不是账单硬上限。平台仍可能有独立访问记录。
- 请使用专用免费分组Key，并在模型平台设置分组、余额或预算约束；应用限流不能代替账户预算设置。

## 本机开发与验证

Python版：将llm-backend/config.example.json复制为config.local.json，私密配置后运行 `python llm-backend/server.py`，默认127.0.0.1:8790。

Workers版需Node.js 22+：

```sh
npm ci
npm run build
npm test
npx wrangler dev
```

Worker本机密钥用.dev.vars（已忽略）。构建从现有HTML提取78牌/25阵、从Python提取解读规则；public只包含index.html和assets。Pages独立构建仍关闭AI。

验证（2026-10-27）：12项Node接口测试通过、Wrangler预检通过、本地workerd模拟通过；GitHub云端真实五接口及连续两次追问通过。自有域名在本机网络首页、HTTPS、牌图、AI配置、真实润色/三问/推荐/解读及连续两次追问通过；初次追问遇上游429，间隔后的完整解读/追问复测均一次成功，相关记录保留。390像素手机布局无横向溢出，三张首页牌图加载正常。不代表所有地区网络或模型额度均已验证。

默认workers.dev地址在当前用户网络连接超时；当前正式分享入口使用上面的自有域名。域名注册仍在阿里云，DNS已接入Cloudflare；既有主域、www、bot三条A记录保留原地址且仅DNS，新增tarot子域绑定Worker。

历史backend目录为收费/激活码原型，当前体验不运行它、不连其数据库。牌图来源见牌图来源.json。塔罗及模型回复用于娱乐与自我反思，不代表他人真实想法或确定未来。

官方来源：
- https://www.cloudflare.com/products/workers/
- https://developers.cloudflare.com/workers/platform/pricing/
- https://developers.cloudflare.com/durable-objects/platform/pricing/
- https://developers.cloudflare.com/workers/static-assets/routing/worker-script/
- https://developers.cloudflare.com/workers/ci-cd/builds/configuration/
- https://developers.cloudflare.com/workers/configuration/secrets/
