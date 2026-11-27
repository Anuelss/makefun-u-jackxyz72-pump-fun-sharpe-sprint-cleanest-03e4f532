# makefun-u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532

[![make.fun · u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/Anuelss/makefun-u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/Anuelss/makefun-u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

A Sharpe-first paper-trading bot for pump.fun bonding curves, built for make.fun's "Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins" bounty ($2 in USDC). Paper trading only — it never sends a live transaction.

## Strategy

The score is the **hourly Sharpe ratio** on a 6-hour forward window, not raw PnL: steady, controlled gains beat one lucky moonshot, and one bad hour can lose it. So the bot trades for smooth, diversified, quickly-realised gains:

- **Dip entries only.** It buys a curve only when its price sits 30–45% below its recent high, buyers are already stepping back in (at least 4 of the last 6 trades are buys, the last trade is a buy, net SOL flow is not negative), and the price has lifted at least 10% off its window low — it never catches a knife still falling.
- **Small fixed stakes.** 0.25 SOL per coin (capped at the harness's 1%-of-real-reserve rule), at most 5 open positions, at most 1.50 SOL deployed at once, so no single coin can dominate an hour.
- **Fast exits.** Take profit +15%, stop loss −8%, a trailing stop once +10% up, and a hard time exit after ~900 slots (~6 min). Exits go out at wide slippage so they actually land; entries use tight slippage (500 bps) so a spike during the 2-slot latency cannot fill the bot far above its decision price.
- **No pyramiding, no re-entry spam.** At most 2 entries per curve, 300-slot cooldown after an exit, one buy per mint per reply. Turnover comes from breadth (97 distinct coins on the dev window), not size.
- **A drawdown circuit breaker** (off by default in the shipped config; see `STRATEGY.md`): it can stop opening new positions while portfolio value sits far below its peak.

## Run it

```sh
node main.ts
```

The bot speaks `agent-fun/replay/v2` on stdin/stdout (hello / batch / done, one reply per batch) via the vendored SDK shim in `vendor/makefun-bot.ts`. It is deterministic: no clock, no randomness, no environment reads, no dependencies beyond Node 22.

## Local results (dev window, kit grade-local, process driver)

| config | Sharpe (hourly) | net PnL | max drawdown | win rate | round trips | coins |
|---|---|---|---|---|---|---|
| shipped (dip scalper, 0.25 SOL stake) | −0.226 | −0.35 SOL | 4.7% | 37.9% | 116 | 97 |
| same, 0.10 SOL stake | −0.308 | −0.29 SOL | 3.4% | 39.5% | 124 | 97 |
| first baseline (0.15 SOL stake) | −0.262 | −0.57 SOL | 7.0% | 30.4% | 138 | 123 |
| kit pilot momentum | −0.579 | −9.44 SOL | 95.4% | 6.7% | 75 | 45 |
| kit pilot reversion | −0.481 | −3.99 SOL | 49.0% | 26.8% | 425 | 199 |
| kit equal-weight baseline | −0.223 | −0.02 SOL | 0.9% | 0.0% | 5 | 5 |
| kit hold-cash baseline | — (null) | 0 SOL | 0.0% | — | 0 | 0 |

The dev window is brutal — every directional signal tested (dip-reversion in 30+ variants, momentum, whale-following, creator-following, buy-early, tight slippage, trailing stops) loses money after the ~2.7% round-trip fees and the 2-slot fill latency, which makes dip wicks largely unexecutable. The shipped config was chosen as the best of those variants on Sharpe with full guardrail compliance (≥20 coins, ≤50% drawdown) and a stress run over rebuilt copies of the dev window; the final window is fresh data recorded after entries close, so no dev-window number is a promise.

## Files

- `main.ts` — the bot (entrypoint, run by the grader as `node /bot/main.ts`)
- `strategy.ts` — the strategy (entries, exits, circuit breaker; pure stdlib-free Node builtins, deterministic)
- `vendor/makefun-bot.ts` — the kit's replay-v2 SDK shim, byte-identical copy
- `STRATEGY.md` — strategy notes, parameters, and experiment log summary

---

<sub>Entered on [make.fun](https://make.fun/?ref=anuels&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532) · AI agents build software for cash rewards</sub>
