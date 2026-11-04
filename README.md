# 🚀 CustomNode 仓库及节点索引生成器

 一个文件索引页面的工具，支持文件扫描、分组展示、复制链接和删除管理，内置GitHub Actions自动化更新。![Update Index](https://github.com/DaiZhouHui/CustomNode/actions/workflows/update-index.yml/badge.svg)

## 私有仓库与 Cloudflare Worker 部署

使用 Cloudflare Workers Free 和自定义域名 `manager.knny.dpdns.org`，不使用 Zero Trust Access。管理页和订阅链接共用该域名。私有仓库仍是唯一源码；Worker 使用服务端 GitHub Secret 按请求读取 `main` 中的管理页和节点文件，不会把节点文件打进公开静态资源。

如果仓库历史中曾提交过真实 Cookie、Token 或其他凭据，请先撤销并重新生成；删除文件或把仓库设为私有不能使旧凭据自动失效。

### 首次部署

1. 在 Cloudflare 控制台的 Workers & Pages 中，为 `customnode-private` Worker 添加自定义域名 `manager.knny.dpdns.org`。确认该主机名没有已有 DNS 记录或其他服务绑定；不要使用已占用的 `sub.knny.dpdns.org`。不需要启用 `workers.dev` 或配置 Access。
2. 在本机仓库切换到并更新 `main` 分支，然后在项目目录运行：

   ```powershell
   npm install
   npx wrangler login
   ```

   如果 Wrangler 已登录，可跳过登录命令。
3. 在本机终端设置管理员密码。密码至少 24 个字符，建议使用密码管理器生成随机密码并保存；不要发到聊天或提交到仓库：

   ```powershell
   npx wrangler secret put ADMIN_PASSWORD
   ```

4. 设置独立的订阅签名密钥。执行下面的命令，在本机生成至少 32 个随机字节；将输出复制到 Wrangler 的密钥输入提示中，不要把输出保存到仓库：

   ```powershell
   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
   npx wrangler secret put SUBSCRIPTION_SIGNING_KEY
   ```

5. 确认 `.env` 中 `GITHUB_TOKEN` 对 `DaiZhouHui/CustomNode` 有 `Contents: Read and write` 权限；如果没有，请创建仅授权该仓库的 Fine-grained personal access token。运行命令后，将 Token 粘贴到 Wrangler 的隐藏输入提示中；不要把 Token 发到聊天、写进 `wrangler.jsonc` 或网页代码：

   ```powershell
   npx wrangler secret put GITHUB_TOKEN
   ```

   `.env` 只存在于本机，Cloudflare Worker 无法直接读取；此步骤将 Token 安全保存为 Cloudflare Worker Secret。读取节点需要 Contents 读取权限，管理页删除节点还需要写入权限。
6. 确认完成自定义域名绑定后部署 Worker：

   ```powershell
   npm run deploy
   ```

   命令会部署 Worker 与登录页，不会打包节点文件。打开 `https://manager.knny.dpdns.org`，使用管理员密码登录；管理页登录态有效 12 小时。

### 后续更新

后续开发仍在 `main`。节点文件内容由 Worker 在订阅请求时从 GitHub 读取；管理页每次打开时也会读取 GitHub `main` 上的最新 `index.html`。节点新增或删除后，现有 GitHub Actions 会更新索引，完成后重新打开管理页即可看到更新，不需要为节点文件变化重新部署 Worker。管理页的删除按钮由 Worker 使用服务端 Token 调用 GitHub API，不再要求在网页里输入 Token。

`GITHUB_OWNER`、`GITHUB_REPOSITORY` 和 `GITHUB_REF` 在 [wrangler.jsonc](./wrangler.jsonc) 中固定为 `DaiZhouHui/CustomNode` 的 `main`。Worker 只允许读取有效节点文件名或 `.yaml` 文件，不会将 GitHub Token 发给浏览器。GitHub Token 作为 Worker Secret 保存在 Cloudflare 中，具有仓库内容读写权限；保护好 Cloudflare 账号，并在不再需要时撤销该 Token。

管理页密码以 Worker Secret 保存。`SUBSCRIPTION_SIGNING_KEY` 用于签发订阅链接和保护短期登录会话；轮换后，已有登录态及旧订阅链接都会失效。修改管理员密码也会使已有登录态失效。订阅 URL 是 bearer 凭据：收到链接的人都能访问对应的单个节点文件，避免在公开页面展示链接，但无法阻止已获授权的用户复制或转发。

管理页删除节点文件会直接提交到 GitHub `main`。现有索引生成 GitHub Actions 完成后，重新打开管理页即可看到变化；订阅文件删除后，已有签名订阅链接也会因 GitHub 返回文件不存在而失效。

Cloudflare Free 有请求和 CPU 配额，具体限制以账号当前方案为准；这适合轻量个人使用，不是无限量或抗滥用的商业托管。

---
旧的 GitHub Pages 链接仅作历史参考，不应再用于发布节点内容；静态页面无法在服务端保护订阅文件。

节点仓库（基于默认仓库设置 `DaiZhouHui/CustomNode`）：

- 仓库github地址 ：https://github.com/DaiZhouHui/CustomNode

节点生成页 一个Web工具，用于将CSV数据转换为Vless节点链接，生成Base64订阅，并与GitHub仓库同步。

- 节点生成网站首页 ：https://daizhouhui.github.io/NodeWeb

- 节点生成github地址:https://github.com/DaiZhouHui/NodeWeb
