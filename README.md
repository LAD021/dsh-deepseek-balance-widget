# dsh-deepseek-balance-widget

> **Fork 说明**：本仓库 fork 自 [crazy-L118/dsh-deepseek-balance-widget](https://github.com/crazy-L118/dsh-deepseek-balance-widget)（MIT，感谢原作者），在其基础上新增 **New API（new-api 网关中转站）** 与 **Command Code（GOAT 订阅）** 两类平台，并携带了平台限流退避修复。上游架构与凭据存储方式保持不变。

[English](README_EN.md) | 中文

在 dsh Web 侧边栏显示 AI 余额的多平台插件：内置 **DeepSeek**，可添加 **MiMo（小米）**、**New API（中转站，如 Pezayo 等 new-api 部署）**、**Command Code（GOAT）**，每 30 秒自动刷新。

每家平台只显示自己**真实存在**的字段（见下方各平台说明），没有对应接口的字段不会出现。

## 安装（只发 GitHub Release，不发 npm）

前置：已装 dsh（`dsh --version` 能跑）。

```bash
curl -LO https://github.com/LAD021/dsh-deepseek-balance-widget/releases/download/v2.4.3--0.2/dsh-deepseek-balance-widget-2.4.3--0.2.tgz
mkdir -p ~/plugins && tar -xzf dsh-deepseek-balance-widget-2.4.3--0.2.tgz -C ~/plugins
dsh plugin add --profile web ~/plugins/package    # 桌面 App 用 --profile desktop
```

再把 `"dsh-deepseek-balance-widget"` 加进 `~/.dsh/profiles/<profile>/package.json` 的 `dsh.profile.bundles`，重启 dsh。侧栏出现余额胶囊后：点余额 →「+ 添加」→ 选 **Command Code（GOAT）** → 粘贴登录 api.commandcode.ai 后的 Cookie。

> 本 fork **不发布 npm 包**（不污染 npm 社区），只发 GitHub Release。上游 npm 包 `dsh-deepseek-balance-widget@2.4.3` 不含 New API / Command Code。

### 让 Agent 自己装（把这段直接发给同学那边的 Agent）

> 帮我装 dsh 余额插件（LAD021 fork，带 New API 与 Command Code GOAT）：
> 1. 下载 https://github.com/LAD021/dsh-deepseek-balance-widget/releases/download/v2.4.3--0.2/dsh-deepseek-balance-widget-2.4.3--0.2.tgz ，解压到 `~/plugins`
> 2. `dsh plugin add --profile web ~/plugins/package`（桌面版用 `--profile desktop`）
> 3. 把 `"dsh-deepseek-balance-widget"` 加进该 profile 的 `package.json` 的 `dsh.profile.bundles`
> 4. 重启 dsh，再帮我把 Command Code（GOAT）的 Cookie 配进插件（登录 api.commandcode.ai 后复制 `__Secure-commandcode_prod_.session_token`）

## New API 平台（本 fork 新增）

- 数据来源：站点的管理端接口（`GET /api/user/self` 余额、`GET /api/data/self` 今日用量），鉴权用控制台「安全与访问 → 系统访问令牌」（account_access_token，非 sk- 模型密钥），配 `New-Api-User: <userId>` 头
- 换算：new-api 标准 `$1 = 500000 quota`；显示 余额 / 累计已用 / 今日消费 / 今日 Token / 今日请求 / 今日模型明细
- 令牌仅存本机 `~/.dsh/ai-balances.json`，不上传

## Command Code（GOAT）平台（本 fork 新增）

- 数据来源：Command Code 后台内部接口（会话 Cookie 鉴权，域名 `api.commandcode.ai`）
  - `/internal/billing/credits` → 月额度上限、剩余额度、5 小时 / 每周窗口
  - `/internal/usage/summary` → 计费周期内的消费、Token、请求数
  - `/internal/billing/subscriptions` → 订阅状态（GOAT）
- 侧边栏胶囊：余额 / 本周期已用 / 本周期 Token
- 详情面板：余额、月额度上限、本周期已用 / Token / 请求、**计费周期起止**、**5 小时窗口（$14）**、**每周窗口（$35）** 与重置时间、套餐
- **没有「今日」口径**：Command Code 只提供计费周期汇总，所以不显示今日消费 / 今日 Token（早期版本显示 0.00 是错的，本 fork 起移除）
- **金额单位：美元（$）**。官方 Usage Limits：GOAT 每月 $70 额度、5 小时窗口 $14、每周窗口 $35；满额度模型上 1 credit ≈ $1 用量（DeepSeek V4.1 Flash 的按模型额度是 $80）
- 订阅价格 $10/月，由 Stripe 按本地货币扣款（本机这单支付宝 ¥74.79），所以「账单是人民币、额度是美元」，插件里一律按美元显示
- Cookie 仅存本机 `~/.dsh/ai-balances.json`；会话 Cookie 约 30 天过期，过期后重新登录复制 `__Secure-commandcode_prod_.session_token`

## 版本号约定

本 fork 的版本 = **上游版本 + 两杠 + 我们的修订**，例如 `2.4.3--0.2`：

- 前半 `2.4.3` 跟随上游发版（上游最新 tag 就是 v2.4.3）
- 后半 `0.2` 是本 fork 自己的修订号：`0.2` = 在 2.4.3 基础上新增 **New API** 与 **Command Code** 两个平台
- fork 构建不会提示「更新到上游」（版本比较里对带 `--` 的版本直接跳过）

## 功能

![AI 余额侧边栏展示](assets/screenshot.png)

**侧边栏入口**
- 实时显示当前平台的余额与可用用量（DeepSeek / MiMo / New API 为今日口径，Command Code 为本周期口径），每 30 秒自动刷新
- 数值随弹窗内切换的平台联动

**详情弹窗**
- 顶部显示当前平台，点「**更换**」下拉在已添加平台间切换，点「**×**」移除（带确认）
- 右上角「**+ 添加**」：加入 MiMo 或 DeepSeek
- DeepSeek 详情：余额、累计消费、今日消费、今日 Token、本月消耗（本月消费 / Tokens）
- MiMo 详情：余额、累计消费、今日消费 / 今日 Token、本月消耗、**每日消耗表**（日期 / Token / 请求 / 消费）
- DeepSeek 显示时段徽章（繁忙 / 空闲，GMT+8：工作日 09-12 / 14-18 为繁忙时段，周末全天空闲）

**用量统计**
- DeepSeek：需可选配置 `DEEPSEEK_PLATFORM_TOKEN`（对 AI 说「帮我配置用量统计」即可）；未配置时仅显示余额
- MiMo：余额与用量均用登录 Cookie 查询，自动推算消费金额（按官方单价）

**AI 帮我配置**
- 弹窗内一键复制提示语，发给智能体后 AI 读取本机教程文件、一步步引导你抓取凭证并写入插件
- MiMo 支持两种方式：AI 引导向导（打开余额页 → 复制提示语），或手动粘贴 Cookie / cURL（自动提取 Cookie）
- 数据仅存本机，不上传

**版本与更新**
- 弹窗底部显示当前版本，有新版本时显示 `vX → vY 更新`，一键自动更新
- 更新失败时显示错误详情面板（可复制错误信息），并引导前往 GitHub 自行安装
- 界面语言随 dsh 设置自动切换中 / EN

**皮肤与第三方插件兼容（v2.4.3 起）**
- 与 maid-atelier 等会重建侧栏 DOM 的皮肤插件共存时，余额入口依然稳定显示
- 插入采用「安全插入」策略：锚点被皮肤 / React 搬走时自动退化为追加，绝不抛异常、绝不中断重试
- 放置成功后下一帧自动复查，被搬走会在下一轮变化时自动归位
- 识别常见皮肤标记（如 `[data-maid-sidebar-footer]`）作为侧栏兜底锚点

## 安装

见文首「安装（只发 GitHub Release，不发 npm）」。

## 配置

插件首次使用会自动创建 DeepSeek 条目，读取你本机的 `DEEPSEEK_API_KEY`。

要加入 MiMo，打开弹窗点右上角「+ 添加」，再点「AI 帮我配置」，把提示语发给智能体；也可以直接对 AI 说：

> 帮我配置 dsh-deepseek-balance-widget。

AI 会接管全部：问 API Key / 引导获取平台 Cookie → 读取本机教程写入配置 → 提醒重启 `dsh web`。

| 平台 | 凭据 | 备注 |
| --- | --- | --- |
| DeepSeek | `DEEPSEEK_API_KEY` | 必填，余额 |
| DeepSeek 用量 | `DEEPSEEK_PLATFORM_TOKEN` | 可选，统计累计 / 本月 / 今日 |
| MiMo（小米） | 登录 Cookie | AI 引导获取 |

凭据保存在你本机的 `~/.dsh/ai-balances.json`，不随插件分发、不上传。

## 更新

本 fork 不发 npm，所以弹窗的「一键更新」不适用于这份；版本检查对 fork 构建会直接跳过（不会误报「有新版本」）。

升级 = 下载新 Release 的 tgz 覆盖安装：

```bash
# 版本号换成新 Release 的
curl -LO https://github.com/LAD021/dsh-deepseek-balance-widget/releases/download/v2.4.3--0.2/dsh-deepseek-balance-widget-2.4.3--0.2.tgz
mkdir -p ~/plugins && tar -xzf dsh-deepseek-balance-widget-2.4.3--0.2.tgz -C ~/plugins
dsh plugin add --profile web ~/plugins/package
```

装完**彻底重启 dsh**（退出桌面端再重开，仅刷新浏览器页面无效）。

> 如果你的环境里弹窗/命令行的更新一直失败（提示版本没变），通常是 Agent 主机（如 WorkBuddy）通过 `NODE_OPTIONS` 注入了文件删除拦截导致 pnpm/npm 更新中断。此时在**普通终端**（不通过 Agent 运行）里执行上面的命令即可成功；或先执行 `set NODE_OPTIONS=`（PowerShell）再重试。

## 更新日志

### v2.4.3

- **修复**：与 maid-atelier 等皮肤插件共存时，余额卡片完全不显示、控制台持续抛 `Uncaught NotFoundError: insertBefore` 的问题
- 侧栏 / 底栏插入统一改用安全插入 helper：插入前校验锚点是否仍为目标容器的已连接子节点，否则退化为 `appendChild`，永不抛异常
- `tryPlace()` 整体容错，单次失败不再中断后续重试；放置成功后在下一帧复查，自动纠正被皮肤 / React 同帧搬走的入口
- `sidebarRoot()` 增加 `[data-maid-sidebar-footer]` 皮肤标记兜底
- 感谢用户「朱鹭咲泽」提交的详细根因分析与修复补丁

### v2.4.2 及更早

见 [GitHub Releases](https://github.com/crazy-L118/dsh-deepseek-balance-widget/releases)。

## 卸载

```bash
dsh plugin --profile web rm dsh-deepseek-balance-widget
```

或者直接对 AI 说：

> 帮我用 npm 卸载 dsh-deepseek-balance-widget 插件。

## 联系

有问题或建议，欢迎联系：

- 邮箱：crazy_l118@icloud.com

## 赞助

如果这个插件对你有帮助，可以给我的晚餐加一根火腿肠 🍗

![赞赏码](assets/sponsor.jpg)

## License

[MIT](LICENSE)
