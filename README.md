# 🚀 CustomNode 仓库及节点索引生成器

 一个文件索引页面的工具，支持文件扫描、分组展示、复制链接和删除管理，内置GitHub Actions自动化更新。![Update Index](https://github.com/DaiZhouHui/CustomNode/actions/workflows/update-index.yml/badge.svg)

## 私有仓库与 Cloudflare Worker 部署

`main` 分支部署到 Cloudflare Workers：Worker 同时提供管理页面和受签名保护的订阅入口；节点文件仍保留在私有 GitHub 仓库中。后续开发和 Worker 部署都使用 `main` 分支。不要把 Worker 的 Secrets 写入网页、构建产物或 GitHub 仓库变量。

### Cloudflare 配置

1. **连接 Cloudflare 前先检查并撤销仓库里曾公开过的会话 Cookie、Token 等凭据。**Workers Builds 会检出整个仓库；构建脚本虽然只发布页面、更新页和图标，但不能因此把仓库中的有效凭据视为安全。
2. 在 Cloudflare Workers Builds 中连接此私有仓库，并将生产分支设为 `main`。构建命令使用 `npm run build`，部署命令使用 `npm run deploy`。
3. 当前单域名配置为 `manager.knny.dpdns.org`，管理页面使用 `/`，签名订阅接口使用 `/sub/<文件名>?sig=...`。此主机名必须属于 Cloudflare 上已激活的 Zone，且不能已有 CNAME；Worker Custom Domain 会创建 DNS 记录并签发证书。如果该域名不在你的 Cloudflare Zone 内，改用你已接入 Cloudflare 的域名或先完成域名接入。
4. 保持 `workers_dev` 和 Preview URLs 关闭。先在 Zero Trust > Access > Applications 添加整个主机 `manager.knny.dpdns.org`，配置只允许你的账户登录；再添加更具体的 `manager.knny.dpdns.org/sub/*` 应用，并设为 `Bypass` / `Everyone`。更具体的路径规则会优先于整站规则，因此订阅客户端不会遇到网页登录；订阅内容仍由 Worker 的签名校验保护。先配好 Access 再部署 Worker，避免管理页面在配置 Access 前短暂公开。
5. 保留 `GITHUB_REF` 为 `main`，让 Worker 从主分支读取节点文件。
6. 在 Cloudflare Worker 的 Secrets 中设置：
   - `GITHUB_READ_TOKEN`：只读、仅授权 `DaiZhouHui/CustomNode` Contents 的 fine-grained GitHub Token。
   - `SUBSCRIPTION_SIGNING_KEY`：至少 32 个随机字节生成的长随机值。它是签发和校验订阅链接的服务端密钥，不是登录密码。

网页中的订阅按钮会向受 Access 保护的管理页面请求签名链接。管理页面和订阅内容共用 `manager.knny.dpdns.org`，通过路径区分；每条链接仅能读取一个仓库根目录文件。节点内容由 Worker 使用只读 Token 从私有仓库读取。轮换 `SUBSCRIPTION_SIGNING_KEY` 会使以前签发的订阅链接失效。订阅链接本身是 bearer 凭据，转发链接的人也能访问对应文件。

GitHub Actions 会在 `main` 分支的节点文件变更后更新索引；定时任务也更新 `main`。Cloudflare Worker 只发布索引页面、更新页面和图标，不会把仓库根目录整体作为静态资源发布。

---
旧的 GitHub Pages 链接仅作历史参考，不应再用于发布节点内容；静态页面无法在服务端保护订阅文件。

节点仓库（基于默认仓库设置 `DaiZhouHui/CustomNode`）：

- 仓库github地址 ：https://github.com/DaiZhouHui/CustomNode

节点生成页 一个Web工具，用于将CSV数据转换为Vless节点链接，生成Base64订阅，并与GitHub仓库同步。

- 节点生成网站首页 ：https://daizhouhui.github.io/NodeWeb

- 节点生成github地址:https://github.com/DaiZhouHui/NodeWeb
