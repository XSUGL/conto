#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// Отчёт по журналу: куда ушли деньги и что с этим можно сделать.
//
//   node report.mjs run-cached.json
//   node report.mjs run-cached.json run-plain.json    # сравнить
//
// Все советы ниже посчитаны по журналу, а не взяты из головы:
// каждый назван вместе с суммой, которую он даёт на этих данных.
// ═══════════════════════════════════════════════════════════════

import { readFileSync } from "node:fs";
import { priceOf, pricesUpdated } from "./meter.mjs";

const files = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (!files.length) {
  console.error(`\nУкажи журнал:  node report.mjs run-cached.json\n`);
  process.exit(1);
}

const money = (x) => `$${x.toFixed(3)}`;
const pc = (a, b) => b ? `${Math.round(a / b * 100)}%` : "0%";

/** Русский счёт: 1 токен, 2 токена, 5 токенов. Без этого отчёт
    выглядит машинным переводом ровно в том месте, где его читают. */
const plural = (n, one, few, many) => {
  const d = Math.abs(n) % 100, e = d % 10;
  return `${n} ${d > 10 && d < 20 ? many : e === 1 ? one : e >= 2 && e <= 4 ? few : many}`;
};

function analyse(file) {
  const { log } = JSON.parse(readFileSync(file, "utf8"));
  const spent = log.reduce((a, r) => a + r.cost, 0);
  const saved = log.reduce((a, r) => a + r.saved, 0);
  const hits = log.filter((r) => r.cached);
  const live = log.filter((r) => !r.cached);
  const unknown = log.filter((r) => r.unknownPrice);

  console.log(`\n═══ ${file}`);
  console.log(`   Запросов:        ${log.length}, из них из кэша ${hits.length} (${pc(hits.length, log.length)})`);
  console.log(`   Потрачено:       ${money(spent)}`);
  console.log(`   Кэш сберёг:      ${money(saved)}  (${pc(saved, spent + saved)} от того, что было бы)`);
  if (unknown.length)
    console.log(`   ⚠️  Цена неизвестна для ${unknown.length} запросов: их сумма не посчитана, а не принята за ноль.`);

  // ── по моделям ─────────────────────────────────────────────────
  const byModel = {};
  for (const r of live) {
    const m = (byModel[r.model] ??= { n: 0, in: 0, out: 0, cost: 0 });
    m.n++; m.in += r.usage.in || 0; m.out += r.usage.out || 0; m.cost += r.cost;
  }
  console.log(`\n   Модель                вызовов      вход     выход      деньги   доля`);
  for (const [m, v] of Object.entries(byModel).sort((a, b) => b[1].cost - a[1].cost))
    console.log(`   ${m.padEnd(20)} ${String(v.n).padStart(7)} ${String(v.in).padStart(9)} ${String(v.out).padStart(9)}` +
                `  ${money(v.cost).padStart(9)}  ${pc(v.cost, spent).padStart(4)}`);

  // ── что ещё можно сделать ──────────────────────────────────────
  console.log(`\n   Что видно по журналу:`);

  // 1. Кэш инструкции. Она одна на все запросы и оплачивается каждый раз.
  let cacheGain = 0, sysTokens = 0;
  const perModel = {};
  for (const r of live) {
    const p = priceOf(r.model); if (!p || !r.system_tokens) continue;
    (perModel[r.model] ??= []).push(r);
    sysTokens = Math.max(sysTokens, r.system_tokens);
  }
  for (const [m, rows] of Object.entries(perModel)) {
    const p = priceOf(m);
    const st = rows[0].system_tokens;
    const now = rows.length * st * p.in / 1e6;
    // При кэшировании префикса: одна запись и остальное по цене чтения.
    const then = (st * p.cache_write + (rows.length - 1) * st * p.cache_read) / 1e6;
    cacheGain += now - then;
  }
  if (cacheGain > 0)
    console.log(`     · Общая инструкция в ${plural(sysTokens, "токен", "токена", "токенов")} оплачивается в каждом запросе.` +
                `\n       Кэш префикса дал бы ${money(cacheGain)} (${pc(cacheGain, spent)} счёта).`);

  // 2. Выход дороже входа. Если он велик, дело в длине ответа.
  const inCost = live.reduce((a, r) => { const p = priceOf(r.model); return a + (p ? (r.usage.in || 0) * p.in / 1e6 : 0); }, 0);
  const outCost = spent - inCost;
  if (outCost > inCost)
    console.log(`     · Выход стоит ${money(outCost)} против ${money(inCost)} за вход: ` +
                `\n       дело в длине ответов, а не в размере промпта.`);
  else
    console.log(`     · Вход стоит ${money(inCost)} против ${money(outCost)} за выход: ` +
                `\n       дело в размере промпта, а не в длине ответов.`);

  // 3. Более дешёвая модель на части потока.
  const top = Object.entries(byModel).sort((a, b) => b[1].cost - a[1].cost)[0];
  if (top) {
    const [m, v] = top;
    const cheap = "claude-haiku-4-5";
    const pc2 = priceOf(cheap), p1 = priceOf(m);
    if (pc2 && p1 && p1.in > pc2.in) {
      const half = (v.in * (p1.in - pc2.in) + v.out * (p1.out - pc2.out)) / 2e6;
      console.log(`     · Половина потока ${m} на ${cheap} дала бы ${money(half)}.` +
                  `\n       Но только если качество это выдержит: мерить до, а не после.`);
    }
  }
  return { file, spent, saved, n: log.length };
}

const runs = files.map(analyse);
if (runs.length === 2) {
  const [a, b] = runs;
  const diff = b.spent - a.spent;
  console.log(`\n═══ Сравнение`);
  console.log(`   ${a.file}: ${money(a.spent)}`);
  console.log(`   ${b.file}: ${money(b.spent)}`);
  console.log(`   Разница: ${money(Math.abs(diff))}  (${pc(Math.abs(diff), Math.max(a.spent, b.spent))})`);
}
console.log(`\n   Цены из prices.json, обновлены ${pricesUpdated}. Проверь перед тем,`);
console.log(`   как показывать эти суммы кому-то ещё.\n`);
