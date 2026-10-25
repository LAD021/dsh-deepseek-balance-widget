# dsh-deepseek-balance-widget

English | [中文](README.md)

A multi-provider AI balance widget for the dsh web sidebar. **DeepSeek** is built in; add **MiMo (Xiaomi)**, **New API** relays, or **Command Code (GOAT)** from the popover. Auto-refreshes every 30 seconds.

Each provider only shows the fields its API actually exposes.

## Install (for labmates)

```bash
curl -LO https://github.com/LAD021/dsh-deepseek-balance-widget/releases/download/v2.4.3--0.2/dsh-deepseek-balance-widget-2.4.3--0.2.tgz
mkdir -p ~/plugins && tar -xzf dsh-deepseek-balance-widget-2.4.3--0.2.tgz -C ~/plugins
dsh plugin add --profile web ~/plugins/package   # or --profile desktop
```

Then add `"dsh-deepseek-balance-widget"` to `dsh.profile.bundles` in `~/.dsh/profiles/<profile>/package.json`, restart dsh, and add your Command Code cookie from the "+ Add" button. (npm still has upstream 2.4.3 without GOAT.)

## Versioning

This fork's version is **upstream version + `--` + our revision**, e.g. `2.4.3--0.2`: the first part follows upstream (latest upstream tag is v2.4.3), the second is our revision — `0.2` = New API + Command Code added on top of 2.4.3. Fork builds never prompt "update to upstream".

## Command Code (GOAT) (added in this fork)

- Data source: Command Code internal endpoints, authenticated with the browser session cookie on `api.commandcode.ai`
  - `/internal/billing/credits` → monthly cap, remaining credits, 5-hour / weekly windows
  - `/internal/usage/summary` → spend, tokens and requests for the billing period
  - `/internal/billing/subscriptions` → subscription status (GOAT)
- Sidebar pill: balance / spent this billing period / period tokens
- Details: balance, monthly cap, period spend / tokens / requests, billing period range, 5-hour window ($14), weekly window ($35) with reset times, plan
- **No "today" metric**: Command Code only reports a billing-period summary, so today spend / tokens are not shown (older build showed a wrong 0.00; removed in v2.5.1)
- **Amounts are in USD ($)**: official Usage Limits give GOAT $70 monthly credits, $14 per 5-hour window, $35 per week; on full-allowance models 1 credit ≈ $1 of usage (DeepSeek V4.1 Flash has an $80 per-model allowance)
- The $10/month subscription is charged by Stripe in your local currency (Alipay ¥74.79 on this machine), so the invoice is CNY while the credits are USD; the widget always shows USD
- Cookie stays local in `~/.dsh/ai-balances.json`; the session cookie expires after ~30 days

## Features

![AI balance sidebar](assets/screenshot-en.png)

**Sidebar entry**
- Live Balance / Today Spend / Today Tokens for the current provider, auto-refresh every 30 s
- Values follow the provider selected in the popover

**Detail popover**
- Header shows the current provider: a "**Switch**" menu lets you change to another added provider, and "**×**" removes it (with confirmation)
- "**+ Add**" button (top right): add MiMo or DeepSeek
- DeepSeek details: balance, cumulative spend, today spend, today tokens, monthly usage (monthly spend / tokens)
- MiMo details: balance, cumulative spend, today spend / today tokens, monthly usage, and a **daily usage table** (date / tokens / requests / spend)
- DeepSeek shows a peak / off-peak badge (GMT+8: weekdays 09-12 / 14-18 are peak, weekends off-peak all day)

**Usage stats**
- DeepSeek: optional `DEEPSEEK_PLATFORM_TOKEN` (just tell your AI "help me configure usage stats"); balance-only otherwise
- MiMo: balance and usage both come from the login cookie; spend is computed at official unit prices

**AI-guided setup**
- One click in the popover copies a prompt; the AI reads the local guide file and walks you through capturing and writing credentials
- MiMo supports two paths: an AI wizard (open balance page → copy prompt), or pasting the Cookie / cURL manually (Cookie auto-extracted)
- Everything stays on your machine; nothing is uploaded

**Version & updates**
- The footer shows the current version; when a newer one exists it reads `vX → vY Update` with one-click auto-update
- On update failure an error panel shows the details (copyable) and points you to GitHub for a manual install
- UI follows dsh's language setting (中文 / EN)

**Skin & third-party plugin compatibility (since v2.4.3)**
- Coexists safely with skins like maid-atelier that rebuild the sidebar DOM — the balance entry stays visible
- Inserts use a "safe insert" strategy: when the anchor is moved by the skin / React, it falls back to appending; it never throws and never breaks the retry loop
- After placement, a next-frame check re-places the entry if it was moved away
- Recognizes common skin markers (e.g. `[data-maid-sidebar-footer]`) as fallback sidebar anchors

## Install (GitHub Release only — this fork is not published to npm)

Requires dsh installed (`dsh --version` works).

```bash
curl -LO https://github.com/LAD021/dsh-deepseek-balance-widget/releases/download/v2.4.3--0.2/dsh-deepseek-balance-widget-2.4.3--0.2.tgz
mkdir -p ~/plugins && tar -xzf dsh-deepseek-balance-widget-2.4.3--0.2.tgz -C ~/plugins
dsh plugin add --profile web ~/plugins/package    # use --profile desktop for the desktop app
```

Then add `"dsh-deepseek-balance-widget"` to `dsh.profile.bundles` in `~/.dsh/profiles/<profile>/package.json` and restart dsh. Open the balance pill → "+ Add" → **Command Code (GOAT)** → paste your api.commandcode.ai cookie.

> This fork deliberately **does not publish to npm** — GitHub Releases only. The upstream npm package `dsh-deepseek-balance-widget@2.4.3` has neither New API nor Command Code.

### Let your agent install it

> Install the dsh balance widget (LAD021 fork, with New API and Command Code GOAT):
> 1. Download https://github.com/LAD021/dsh-deepseek-balance-widget/releases/download/v2.4.3--0.2/dsh-deepseek-balance-widget-2.4.3--0.2.tgz and extract it to `~/plugins`
> 2. `dsh plugin add --profile web ~/plugins/package` (use `--profile desktop` for the desktop app)
> 3. Add `"dsh-deepseek-balance-widget"` to `dsh.profile.bundles` in that profile's `package.json`
> 4. Restart dsh, then configure my Command Code (GOAT) cookie (`__Secure-commandcode_prod_.session_token` from a signed-in api.commandcode.ai session)

## Configuration

On first use the plugin creates a DeepSeek entry and reads your local `DEEPSEEK_API_KEY`.

To add MiMo, open the popover, click "+ Add", then "AI Configure", and send the copied prompt to your AI. Or just tell your AI:

> Configure dsh-deepseek-balance-widget for me.

The AI takes care of everything: asks for your API key / guides you through getting the platform cookie → writes the local config → reminds you to **restart `dsh web`**.

| Provider | Credential | Notes |
| --- | --- | --- |
| DeepSeek | `DEEPSEEK_API_KEY` | Required, balance |
| DeepSeek usage | `DEEPSEEK_PLATFORM_TOKEN` | Optional, cumulative / monthly / today stats |
| MiMo (Xiaomi) | Login cookie | Guided by your AI |

Credentials are stored locally in `~/.dsh/ai-balances.json`; nothing is shipped with the plugin and nothing is uploaded.

## Update

This fork is not on npm, so the popover's one-click update does not apply, and version checks are skipped for fork builds (no false "new version" prompts).

To upgrade, install the newer release tarball:

```bash
# replace the version with the new release
curl -LO https://github.com/LAD021/dsh-deepseek-balance-widget/releases/download/v2.4.3--0.2/dsh-deepseek-balance-widget-2.4.3--0.2.tgz
mkdir -p ~/plugins && tar -xzf dsh-deepseek-balance-widget-2.4.3--0.2.tgz -C ~/plugins
dsh plugin add --profile web ~/plugins/package
```

Then **fully restart dsh** (quit the desktop app and reopen; refreshing the browser tab is not enough).

> If the popover / command-line update keeps failing (version never changes), an agent host (e.g. WorkBuddy) is likely injecting a file-deletion guard via `NODE_OPTIONS`, which makes pnpm/npm abort during updates. Run the command in a **plain terminal** (not through the agent), or unset `NODE_OPTIONS` first (PowerShell: `set NODE_OPTIONS=`) and retry.

## Changelog

### v2.4.3

- **Fixed**: the balance card not showing at all (with constant `Uncaught NotFoundError: insertBefore` in the console) when running alongside skins such as maid-atelier
- Sidebar / toolbar insertion now goes through a safe-insert helper: it verifies the anchor is still a connected child of the target and falls back to `appendChild` otherwise — it never throws
- `tryPlace()` is fully guarded, so a single failure no longer kills retries; a next-frame check re-places the entry if the skin / React moved it in the same tick
- `sidebarRoot()` gained a `[data-maid-sidebar-footer]` skin-marker fallback
- Thanks to user「朱鹭咲泽」for the detailed root-cause analysis and fix patch

### v2.4.2 and earlier

See [GitHub Releases](https://github.com/crazy-L118/dsh-deepseek-balance-widget/releases).

## Uninstall

```bash
dsh plugin --profile web rm dsh-deepseek-balance-widget
```

Or just tell your AI:

> Uninstall the dsh-deepseek-balance-widget plugin for me via npm.

## Contact

Questions or suggestions? Feel free to reach out:

- Email: crazy_l118@icloud.com

## Sponsor

If this plugin helped you, consider buying me a ham sausage for dinner 🍗

![WeChat reward QR](assets/sponsor.jpg)

## License

[MIT](LICENSE)
