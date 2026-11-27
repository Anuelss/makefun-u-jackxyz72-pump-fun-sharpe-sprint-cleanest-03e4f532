// Sharpe-first dip scalper — entrypoint for the pump.fun replay (agent-fun/replay/v2).
//
// The grader runs `node /bot/main.ts` with this directory mounted at /bot.
// Strategy: see strategy.ts. Wire: the kit's SDK shim (vendor/makefun-bot.ts)
// owns the protocol; this file only feeds it batches and returns orders.
//
// Deterministic by construction: the strategy reads nothing but the batches the
// harness sends — no clock, no randomness, no environment, no I/O.

import { runBot } from './vendor/makefun-bot.ts';
import { DEFAULT_PARAMS, DipScalper } from './strategy.ts';

const bot = new DipScalper(DEFAULT_PARAMS);

await runBot({
  onBatch(state, batch) {
    bot.observe(batch);
    return bot.decide(state, batch);
  },
});
