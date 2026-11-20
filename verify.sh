#!/usr/bin/env bash
# 端到端验收：余额插件双 provider 同显 + 卡住修复
# 用法: bash verify.sh [base_url]
set -uo pipefail
BASE="${1:-http://127.0.0.1:3080}"
PASS=0; FAIL=0
ok(){ echo "  PASS  $1"; PASS=$((PASS+1)); }
no(){ echo "  FAIL  $1"; FAIL=$((FAIL+1)); }

echo "=== 1. 语法检查 ==="
cd "/Users/bbaa/WORK2026/auto/dsh-deepseek-balance-widget"
for f in lib/index.js lib/client.js; do
  if /opt/homebrew/bin/node --check "$f" >/dev/null 2>&1; then ok "node --check $f"; else no "node --check $f"; fi
done

echo "=== 2. DeepSeek 余额接口 ==="
DS=$(curl -s -m 25 "$BASE/deepseek-balance")
echo "  raw: $(echo "$DS" | head -c 200)"
if echo "$DS" | grep -q '"ok":true'; then ok "deepseek-balance ok:true"; else no "deepseek-balance 非 ok"; fi

echo "=== 3. New API 余额接口（只显示余额）==="
NA=$(curl -s -m 25 "$BASE/ai-provider-balance?provider=provider-b")
echo "  raw: $(echo "$NA" | head -c 300)"
if echo "$NA" | grep -q '"ok":true'; then ok "newapi balance ok:true"; else no "newapi balance 非 ok"; fi

echo "=== 4. /deepseek-usage 退避期仍返回可用数据（核心修复）==="
US=$(curl -s -m 40 "$BASE/deepseek-usage")
echo "  raw: $(echo "$US" | head -c 400)"
if echo "$US" | grep -q '平台限流中'; then
  no "/deepseek-usage 仍整段返回「平台限流中」（修复未生效）"
else
  ok "/deepseek-usage 不再整段报限流"
fi
if echo "$US" | grep -q '"ok":true'; then ok "/deepseek-usage ok:true"; else no "/deepseek-usage 非 ok:true"; fi
if echo "$US" | grep -qE '"todaySpend"'; then ok "今日消费字段存在"; else no "缺 todaySpend"; fi

echo "=== 5. provider 列表两家都在 ==="
PV=$(curl -s -m 20 "$BASE/ai-balances")
echo "  raw: $(echo "$PV" | head -c 300)"
if echo "$PV" | grep -q '"deepseek"'; then ok "列表含 deepseek"; else no "列表缺 deepseek"; fi
if echo "$PV" | grep -q '"newapi"'; then ok "列表含 newapi"; else no "列表缺 newapi"; fi

echo
echo "===== 结果: PASS=$PASS FAIL=$FAIL ====="
[ "$FAIL" -eq 0 ]
