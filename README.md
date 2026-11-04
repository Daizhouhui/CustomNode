# 🚀 CustomNode 仓库及节点索引生成器

 一个文件索引页面的工具，支持文件扫描、分组展示、复制链接和删除管理，内置GitHub Actions自动化更新。![Update Index](https://github.com/DaiZhouHui/CustomNode/actions/workflows/update-index.yml/badge.svg)

## 私有仓库与 Cloudflare Worker 部署

`main` 分支部署到 Cloudflare Workers：Worker 同时提供管理页面和受签名保护的订阅入口；节点文件仍保留在私有 GitHub 仓库中。后续开发和 Worker 部署都使用 `main` 分支。不要把 Worker 的 Secrets 写入网页、构建产物或 GitHub 仓库变量。

### Cloudflare 配置

1. **连接 Cloudflare 前先检查并撤销仓库里曾公开过的会话 Cookie、Token 等凭据。**Workers Builds 会检出整个仓库；构建脚本虽然只发布页面、更新页和图标，但不能因此把仓库中的有效凭据视为安全。
2. 在 Cloudflare Workers Builds 中连接此私有仓库，并将生产分支设为 `main`。构建命令使用 `npm run build`，部署命令使用 `npm run deploy`。
3. 在 `wrangler.jsonc` 中将 `manager.example.com` 和 `sub.example.com` 替换为你自己 Cloudflare Zone 下的两个 HTTPS 子域名。保留 `GITHUB_REF` 为 `main`，让 Worker 从部署分支读取节点文件。
4. 在 Worker 设置中将两个子域名都绑定到这个 Worker。保持 `workers_dev` 和 Preview URLs 关闭；不要在订阅子域名上启用 Cloudflare Access。
5. 为管理子域名配置 Cloudflare Access，只允许你的账户登录。订阅客户端无法完成网页登录，因此订阅子域名由 Worker 自己验证签名 URL。
6. 在 Cloudflare Worker 的 Secrets 中设置：
   - `GITHUB_READ_TOKEN`：只读、仅授权 `DaiZhouHui/CustomNode` Contents 的 fine-grained GitHub Token。
   - `SUBSCRIPTION_SIGNING_KEY`：至少 32 个随机字节生成的长随机值。它是签发和校验订阅链接的服务端密钥，不是登录密码。

网页中的订阅按钮会向受 Access 保护的管理子域名请求签名链接。每条链接仅能读取一个仓库根目录文件；节点内容由 Worker 使用只读 Token 从私有仓库读取。轮换 `SUBSCRIPTION_SIGNING_KEY` 会使以前签发的订阅链接失效。订阅链接本身是 bearer 凭据，转发链接的人也能访问对应文件。

GitHub Actions 会在 `main` 分支的节点文件变更后更新索引；定时任务也更新 `main`。Cloudflare Worker 只发布索引页面、更新页面和图标，不会把仓库根目录整体作为静态资源发布。

---
旧的 GitHub Pages 链接仅作历史参考，不应再用于发布节点内容；静态页面无法在服务端保护订阅文件。

节点仓库（基于默认仓库设置 `DaiZhouHui/CustomNode`）：

- 仓库github地址 ：https://github.com/DaiZhouHui/CustomNode

节点生成页 一个Web工具，用于将CSV数据转换为Vless节点链接，生成Base64订阅，并与GitHub仓库同步。

- 节点生成网站首页 ：https://daizhouhui.github.io/NodeWeb

- 节点生成github地址:https://github.com/DaiZhouHui/NodeWeb
