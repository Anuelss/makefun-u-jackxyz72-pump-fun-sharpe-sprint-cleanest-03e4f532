# STRATEGY.md — Sharpe Sprint dip scalper

## Objective

Maximise the **hourly Sharpe ratio** (mean / sample stdev of hourly equity
returns, not annualised) on a 6-hour forward window of fresh pump.fun data,
subject to: ≥20 distinct mints with round trips ≥0.01 SOL, max drawdown ≤50%,
net PnL > 0 to be prize-eligible. Everything is paper trading on a 10 SOL
account; the bot never sends a live transaction.

## Shipped parameters (`strategy.ts` DEFAULT_PARAMS)

| param | value | why |
|---|---|---|
| highWindow | 2500 slots (~17 min) | recent high for the dip |
| ddMin / ddMax | 0.30 / 0.45 | dip band: a real dip, not noise, not a collapse |
| flowTrades / minBuys | 6 / 4 | buyers stepping back in |
| lastMustBeBuy | true | the dip is being bought |
| minNetFlow | 0 lamports | net SOL flow not negative |
| bounceMin | 0.10 | price ≥10% above its window low (no falling knives) |
| minRealSol / maxRealSol | 3 / 70 SOL | liquid enough to size, not near graduation |
| minAge | 50 slots | skip the first seconds after creation |
| stake | 0.25 SOL | capped by the 1%-of-real-reserve rule |
| minBuy | 0.01 SOL | the guardrail floor for a counted round trip |
| takeProfit / stopLoss | +15% / −8% | value vs cost (fees included in cost) |
| trailArm / trail | +10% / 5% | lock in gains once running |
| maxHoldSlots | 900 (~6 min) | quick exits keep hourly marks smooth |
| cooldownSlots | 300 | no re-entry spam |
| maxEntries / maxEntriesPerBatch | 2 / 2 | breadth over size |
| buySlippageBps / sellSlippageBps | 500 / 10000 | entries protected from latency spikes; exits always land |
| maxExposure | 1.50 SOL | caps one bad hour |
| brakeDd / brakeResumeDd / brakeSlots | 0 / 0.005 / 0 | circuit breaker OFF in the shipped config |

## What was tried (local simulator + kit grade-local, dev window)

A faithful local replay simulator (`sim.mjs`, task dir only — not shipped)
replicates the harness market model (curve math, 2-slot latency, fees,
slippage, failed-tx draws) and was calibrated against grade-local (V1: sim
Sharpe −0.44 vs grade-local −0.40; same win rate and trade counts within ~10%).
30+ variants were swept through it, then the finalists were confirmed with
the kit's own `grade-local --driver process`:

- Dip band, bounce confirmation, flow strictness, TP/SL grid (10–25% / 5–10%),
  stake (0.10–0.25 SOL), hold times, trailing stops, tight slippage on both
  sides — all variants lose money on dev after the ~2.7% round-trip fees.
- Momentum (buy strength), whale-following (single buys ≥1–5 SOL),
  creator-following, buy-early (first real-SOL crossing), slow momentum
  (+5–15% over 30 min) — all lose; momentum is the worst (median forward
  return −19% over 5 min after a +20% spike).
- The key structural finding: dip wicks are largely unexecutable. Entering at
  a dip print (idealised, no latency) wins ~58–71% of trades; with the
  2-slot fill latency the same signal wins ~34%, because the wick reverts
  before the order fills. Bounce confirmation makes it worse, not better
  (it enters after the easy money is gone).
- A drawdown circuit breaker improves dev Sharpe by cutting losing streaks
  (Sharpe −0.20 at a 1% brake), but without a time-based resume it stops the
  run after the first drawdown and would fail the 20-mint guardrail on a
  6-hour window; with a time resume it barely engages. It ships OFF.
- A launch-entry variant (buy in the first 3–12 slots after creation, only
  when the creator bought ≥0.3–1.0 SOL, has not sold, and ≤0–1 other buyers
  had bought) was tested in the sim with 6 parameter sets: all lose badly
  (Sharpe −0.77 to −0.94, PnL −1.2 to −2.2 SOL, win rate 22–28%, ~610 round
  trips). Stricter filters barely change the trade count — a creator buying
  at launch is the norm on this dataset, not a signal. Rejected.
- The shipped config is the best **guardrail-safe** Sharpe found
  (grade-local −0.226, 116 round trips / 97 coins / 24 h ≈ 29 per 6 h, max
  drawdown 4.7%), not the best raw PnL (the 0.10 SOL stake loses less money
  but scores a worse Sharpe, −0.308).

## Out-of-sample honesty

No separate out-of-sample window exists in the kit: the dev set is one frozen
24 h window and the final set is recorded after entries close. To avoid
overfitting, only mechanism-level choices were kept (dip + flow + bounce
filters, quick exits, breadth), and single-parameter tweaks that moved Sharpe
by <0.05 were treated as noise. A stress run (20 rebuilt copies of the dev
window) is in the task logs. No dev-window number is a promise about the
final window.
