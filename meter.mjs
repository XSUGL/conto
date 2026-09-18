// ═══════════════════════════════════════════════════════════════
// Счётчик. Оборачивает вызов модели и считает три вещи: токены,
// деньги и то, сколько из этого можно было не тратить.
//
// Кэш здесь не «оптимизация на будущее». Одинаковый запрос стоит
// одинаково каждый раз, и в любом конвейере, который перезапускают,
// таких повторов много: правка промпта, упавший прогон, перезапуск
// после ошибки на середине.
// ═══════════════════════════════════════════════════════════════

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const PRICES = JSON.parse(readFileSync(new URL("./prices.json", import.meta.url), "utf8"));

export const priceOf = (model) => PRICES.models[model] || null;
export const pricesUpdated = PRICES.updated;

/** Ключ запроса: модель, инструкция и вход. Температура и усилие тоже:
    один и тот же вопрос при разных настройках это разные запросы. */
export const keyOf = ({ model, system, prompt, effort, temperature }) =>
  createHash("sha256")
    .update(JSON.stringify([model, system, prompt, effort ?? null, temperature ?? null]))
    .digest("hex").slice(0, 32);

export function cost(model, usage) {
  const p = priceOf(model);
  if (!p) return null;                          // неизвестная цена это не ноль
  const u = usage || {};
  return ((u.in || 0) * p.in + (u.out || 0) * p.out
        + (u.cache_write || 0) * p.cache_write + (u.cache_read || 0) * p.cache_read) / 1e6;
}

export function createMeter({ cache = new Map(), log = [] } = {}) {
  const meter = {
    log, cache,

    /** Обернуть один вызов. call() должен вернуть { text, usage }. */
    async run(req, call) {
      const key = keyOf(req);
      const started = Date.now();

      if (cache.has(key)) {
        const hit = cache.get(key);
        log.push({ at: new Date().toISOString(), model: req.model, tag: req.tag || null,
                   key, cached: true, ms: Date.now() - started,
                   usage: hit.usage, cost: 0, saved: cost(req.model, hit.usage) ?? 0 });
        return { ...hit, cached: true };
      }

      const res = await call(req);
      const c = cost(req.model, res.usage);
      log.push({ at: new Date().toISOString(), model: req.model, tag: req.tag || null,
                 key, cached: false, ms: Date.now() - started,
                 usage: res.usage, cost: c ?? 0, saved: 0,
                 // Отдельно запоминаем, сколько из входа занимает общая
                 // инструкция: она повторяется в каждом запросе, и это
                 // самая большая статья, которую видно только в отчёте.
                 system_tokens: Math.round(String(req.system || "").length / 3.4),
                 unknownPrice: c === null });
      cache.set(key, res);
      return { ...res, cached: false };
    },
  };
  return meter;
}
