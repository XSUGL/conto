#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// Прогон по журналу. Настоящая модель не нужна: мы меряем не её,
// а свой конвейер - сколько он делает вызовов, сколько из них
// повторные и во что это обходится.
//
//   node replay.mjs                    # синтетический поток
//   node replay.mjs --no-cache         # то же без кэша, для сравнения
//   node replay.mjs --out run.json
//
// Поток похож на жизнь: один и тот же промпт возвращается, потому что
// прогон перезапускали, часть запросов одинакова по смыслу и по тексту,
// а часть отличается одной цифрой и кэшу не поддаётся.
// ═══════════════════════════════════════════════════════════════

import { writeFileSync } from "node:fs";
import { createMeter, cost, priceOf, pricesUpdated } from "./meter.mjs";

const args = process.argv.slice(2);
const has = (n) => args.includes("--" + n);
const flag = (n, d) => { const i = args.indexOf("--" + n); return i === -1 ? d : args[i + 1]; };

let seed = Number(flag("seed", 20260918));
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const pick = (a) => a[Math.floor(rnd() * a.length)];

const SITES = Array.from({ length: 40 }, (_, i) => `esempio-${i + 1}.it`);
// Инструкция длиной примерно в полторы тысячи токенов: столько и весит
// настоящий рабочий промпт с правилами и примерами. На короткой
// инструкции экономия от кэша префикса выглядела бы пустяком, и совет
// был бы верным, но неубедительным.
const SYSTEM = "Ты оцениваешь сайты небольших заведений в итальянской провинции. "
  + "Смотри на признаки, а не на слова владельца. ".repeat(40)
  + "Отвечай строго по схеме, без пояснений. ".repeat(40);

/** Поддельный вызов модели: токены считаются по длине, как в жизни
    примерно и бывает, а ответ нас не интересует вовсе. */
const fakeCall = async (req) => {
  const inTok = Math.round((req.system.length + req.prompt.length) / 3.4);
  return { text: "{}", usage: { in: inTok, out: int(180, 520), cache_write: 0, cache_read: 0 } };
};

/** Поток запросов: три прогона по одному и тому же списку сайтов,
    как бывает, когда правишь промпт и перезапускаешь. */
function traffic() {
  const reqs = [];
  for (let run = 1; run <= 3; run++) {
    for (const site of SITES) {
      // В третьем прогоне у десятой части сайтов данные обновились,
      // и текст запроса изменился: такие в кэш не попадут.
      const fresh = run === 3 && rnd() < 0.1;
      reqs.push({
        // Модель закреплена за сайтом, а не выбирается заново: иначе
        // повторный прогон того же списка давал бы другой ключ, и кэш
        // мерил бы не повторы, а случайность выбора.
        model: SITES.indexOf(site) % 4 === 0 ? "claude-sonnet-5" : "claude-opus-5",
        system: SYSTEM,
        // Признаки зависят от сайта, а не от броска монеты: повторный
        // прогон по тем же собранным данным обязан давать тот же текст,
        // иначе кэш не сработает ни разу и мы будем мерить случайность.
        prompt: `Адрес: ${site}\nПризнаки: viewport ${SITES.indexOf(site) % 3 === 0}, https true`
                + (fresh ? `\nОбновлено: ${int(1, 999)}` : ""),
        tag: `run${run}`,
      });
    }
  }
  return reqs;
}

const useCache = !has("no-cache");
const meter = createMeter({ cache: useCache ? new Map() : { has: () => false, set: () => {}, get: () => {} } });

const reqs = traffic();
for (const r of reqs) await meter.run(r, fakeCall);

const out = flag("out", useCache ? "run-cached.json" : "run-plain.json");
writeFileSync(out, JSON.stringify({ prices_updated: pricesUpdated, log: meter.log }, null, 1));

const spent = meter.log.reduce((a, r) => a + r.cost, 0);
const saved = meter.log.reduce((a, r) => a + r.saved, 0);
const hits = meter.log.filter((r) => r.cached).length;

console.log(`\nЗапросов:      ${meter.log.length}${useCache ? "" : "   (кэш выключен)"}`);
console.log(`Из кэша:       ${hits}  (${Math.round(hits / meter.log.length * 100)}%)`);
console.log(`Потрачено:     $${spent.toFixed(3)}`);
console.log(`Не потрачено:  $${saved.toFixed(3)}`);
console.log(`\n📄 ${out}\n   Дальше: node report.mjs ${out}\n`);
