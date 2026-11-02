#!/usr/bin/env node
/**
 * 调整侧栏余额插件的 provider 显示顺序（给 AI 用的 CLI，等价于 POST /ai-balances-order）。
 *
 *   node scripts/order.mjs                  # 打印当前顺序（编号 + id + 标签）
 *   node scripts/order.mjs provider-b provider-a   # 把这几个 id 按给定顺序排到最前
 *   node scripts/order.mjs --all commandcode-goat   # 只动一个：提到最前，其余保持原序
 *
 * 顺序就是 ~/.dsh/ai-balances.json 里的数组顺序；没提到的 provider 保持原相对顺序排在后面，
 * 不会丢条目。写回前会校验 id，未知 id 直接退出码 2，不改文件。
 */
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

const STORE = resolve(homedir(), ".dsh", "ai-balances.json");
const argv = process.argv.slice(2);
const ids = argv.filter((arg) => !arg.startsWith("--"));
const store = JSON.parse(await readFile(STORE, "utf8"));
if (!Array.isArray(store)) {
  console.error("ai-balances.json 不是数组，什么都没改");
  process.exit(2);
}
if (ids.length === 0) {
  console.log(store.map((p, i) => `${i + 1}. ${p.id}\t${p.label ?? p.kind ?? ""}`).join("\n"));
  process.exit(0);
}
const byId = new Map(store.map((p) => [p.id, p]));
const unknown = ids.filter((id) => !byId.has(id));
if (unknown.length > 0) {
  console.error("未知 provider id：" + unknown.join(", "));
  console.error("现有 id：" + store.map((p) => p.id).join(", "));
  process.exit(2);
}
const next = [];
for (const id of ids) {
  const provider = byId.get(id);
  if (!next.includes(provider)) next.push(provider);
}
for (const provider of store) if (!next.includes(provider)) next.push(provider);
await writeFile(STORE, JSON.stringify(next, null, 2), "utf8");
console.log("新顺序：" + next.map((p) => p.id).join(" > "));
