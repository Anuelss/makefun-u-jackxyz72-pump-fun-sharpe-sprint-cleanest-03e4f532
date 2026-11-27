// Sharpe-first dip scalper for the pump.fun replay (agent-fun/replay/v2).
//
// Idea, written before any data was touched: on a 6-hour final window the score is the
// HOURLY Sharpe ratio — mean / stdev of ~6 hourly equity returns, not annualised. One
// lucky moonshot cannot win this; one bad hour can lose it. So the bot aims for many
// small, diversified, quickly-realised gains and cuts losers fast:
//
//   * Enter only a dip: price 25-45% below its recent high, with buyers already
//     stepping back in (recent tape mostly buys, last trade a buy, net SOL not negative).
//   * Small fixed stake per coin (0.15 SOL, capped at 1% of the curve's real SOL
//     reserve), at most 5 open positions, so no single coin can dominate an hour.
//   * Exit fast: take profit +15%, stop loss -8%, trailing stop once +10% up,
//     hard time exit after ~900 slots (~6 min). Exits go out at wide slippage so
//     they actually land; entries use tight slippage so a spike during the
//     2-slot latency cannot fill us far above the decision price.
//   * No pyramiding, no re-entry spam: at most 2 entries per curve, 300-slot
//     cooldown after an exit. Turnover comes from breadth (many coins), not size.
//
// Everything is a pure function of the batches the harness sends: no clock, no
// randomness, no I/O, no environment reads, so the two graded executions produce
// byte-identical action logs. Money math is BigInt lamports; floats are used only
// for price ratios (never for money).

import type { Batch, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Slots of price history the recent high is measured over. */
  highWindow: number;
  /** Enter when price is at least this far below the recent high (fraction). */
  ddMin: number;
  /** ...and not further than this (a collapse, not a dip). */
  ddMax: number;
  /** Trades of recent flow tape. */
  flowTrades: number;
  /** Of those, at least this many must be buys. */
  minBuys: number;
  /** The most recent trade must be a buy (the dip is being bought). */
  lastMustBeBuy: boolean;
  /** Net SOL bought over the flow tape must be at least this (lamports, may be negative). */
  minNetFlow: bigint;
  /** Curve real SOL bounds at entry (lamports). */
  minRealSol: bigint;
  maxRealSol: bigint;
  /** Slots since the CreateEvent before an entry is allowed. */
  minAge: number;
  /** SOL to put into one position in total (lamports, before the 1% reserve cap). */
  stake: bigint;
  /** Smallest buy worth sending (lamports; tx fees are 105k per order). */
  minBuy: bigint;
  /** Take profit: exit when liquidation value reaches cost * (1 + takeProfit). */
  takeProfit: number;
  /** Stop loss: exit when liquidation value falls to cost * (1 - stopLoss). */
  stopLoss: number;
  /** Trailing stop arms once value reaches cost * (1 + trailArm)... */
  trailArm: number;
  /** ...then exits when value falls this far below its best (fraction of best). */
  trail: number;
  /** Exit after holding this many slots regardless. */
  maxHoldSlots: number;
  /** After an exit, ignore the coin for this many slots. */
  cooldownSlots: number;
  /** Most entries per curve over the run. */
  maxEntries: number;
  /** Most new entries per batch. */
  maxEntriesPerBatch: number;
  /** Bounce confirmation: price must be at least this far above its window low. */
  bounceMin: number;
  /** When false, the flow tape (buys / net SOL / last-trade-must-be-buy) is not required. */
  requireFlow: boolean;
  /** Slippage tolerance on buys / sells (bps). */
  buySlippageBps: number;
  sellSlippageBps: number;
  /** Most SOL deployed at cost across all positions at once (lamports). */
  maxExposure: bigint;
  /** Circuit breaker: stop opening new positions while portfolio value is this
   *  far below its peak (fraction, 0 = off). Exits are always allowed. */
  brakeDd: number;
  /** Resume entries once the drawdown from peak is back under this (fraction). */
  brakeResumeDd: number;
  /** Resume entries anyway after this many slots braked (0 = only on recovery). */
  brakeSlots: number;
}

/** V0: chosen from first principles (round-trip cost ~2.7% incl. fees), not tuned. */
export const DEFAULT_PARAMS: Params = {
  highWindow: 2500,
  ddMin: 0.3,
  ddMax: 0.45,
  flowTrades: 6,
  minBuys: 4,
  lastMustBeBuy: true,
  minNetFlow: 0n,
  minRealSol: 3_000_000_000n,
  maxRealSol: 70_000_000_000n,
  minAge: 50,
  stake: 250_000_000n,
  minBuy: 10_000_000n,
  takeProfit: 0.15,
  stopLoss: 0.08,
  trailArm: 0.1,
  trail: 0.05,
  maxHoldSlots: 900,
  cooldownSlots: 300,
  maxEntries: 2,
  maxEntriesPerBatch: 2,
  bounceMin: 0.1,
  requireFlow: true,
  buySlippageBps: 500,
  sellSlippageBps: 10_000,
  maxExposure: 1_500_000_000n,
  brakeDd: 0,
  brakeResumeDd: 0.005,
  brakeSlots: 0,
};

/** Price samples for one curve: (slot, spot price in SOL per token). */
interface PricePoint {
  slot: number;
  price: number;
}

/** One recent trade on a curve, for the flow tape. */
interface FlowTrade {
  isBuy: boolean;
  sol: bigint;
}

interface CurveTape {
  createdSlot: number | null;
  prices: PricePoint[];
  flow: FlowTrade[];
  lastTradeSlot: number;
  entries: number;
  cooldownUntil: number;
  /** Running all-time high price (and its slot) since the curve was first seen. */
  peak: number;
  peakSlot: number;
}

interface OpenPosition {
  mint: Pubkey;
  entrySlot: number;
  /** Best liquidation value / cost seen (ratio), for the trailing stop. */
  bestRatio: number;
}

/** Spot price (SOL per token) from the curve's virtual reserves. */
export function spotPrice(vq: bigint, vt: bigint): number {
  if (vt === 0n) return 0;
  return Number(vq) / Number(vt);
}

/** Liquidation value of `tokens` at the curve's current reserves (lamports). */
export function liquidationValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (vt === 0n || tokens === 0n) return 0n;
  return (tokens * vq) / vt;
}

export class DipScalper {
  readonly params: Params;
  /** Optional in-memory diagnostics sink (local testing only; never read by the bot). */
  diag: { exits: { mint: Pubkey; reason: string; ratio: number }[] } | null = null;
  private readonly tapes = new Map<Pubkey, CurveTape>();
  private readonly open = new Map<Pubkey, OpenPosition>();
  private prunedAt = 0;
  private peakValue = 0n;
  private braked = false;
  private brakeSinceSlot = 0;

  constructor(params: Params = DEFAULT_PARAMS) {
    this.params = params;
  }

  /** Number of curves currently tracked (for tests / diagnostics). */
  get trackedCurves(): number {
    return this.tapes.size;
  }

  /** Number of open positions tracked. */
  get openCount(): number {
    return this.open.size;
  }

  private tape(mint: Pubkey): CurveTape {
    let t = this.tapes.get(mint);
    if (t === undefined) {
      t = { createdSlot: null, prices: [], flow: [], lastTradeSlot: -1, entries: 0, cooldownUntil: -1, peak: 0, peakSlot: -1 };
      this.tapes.set(mint, t);
    }
    return t;
  }

  /** Fold one batch's events into the tapes. Called before deciding orders. */
  observe(batch: Batch): void {
    const p = this.params;
    for (const e of batch.events) {
      const t = this.tape(e.mint);
      if (e.event === 'CreateEvent') {
        t.createdSlot = e.slot;
      } else if (e.event === 'TradeEvent') {
        const price = spotPrice(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
        if (price > 0) {
          t.prices.push({ slot: e.slot, price });
          if (price > t.peak) {
            t.peak = price;
            t.peakSlot = e.slot;
          }
          // Keep only samples inside the high window plus a small margin.
          while (t.prices.length > 0 && t.prices[0]!.slot < e.slot - p.highWindow - 500) t.prices.shift();
          if (t.prices.length > 256) t.prices.splice(0, t.prices.length - 256);
        }
        t.flow.push({ isBuy: e.is_buy, sol: BigInt(e.sol_amount) });
        if (t.flow.length > p.flowTrades) t.flow.shift();
        t.lastTradeSlot = e.slot;
      }
    }
    // Cheap periodic prune: drop stale, position-less, never-entered curves.
    if (this.tapes.size > 4000 && batch.slot - this.prunedAt > 5000) {
      this.prunedAt = batch.slot;
      for (const [mint, t] of this.tapes) {
        if (!this.open.has(mint) && t.entries === 0 && batch.slot - t.lastTradeSlot > 20000) {
          this.tapes.delete(mint);
        }
      }
    }
  }

  /** Recent high and low price over the window, or null when there is not enough tape.
   *  A very large window (>= 100000 slots) means the all-time high since first seen. */
  private recentHighLow(t: CurveTape, slot: number): { high: number; low: number } | null {
    const p = this.params;
    let high = 0;
    let low = Number.POSITIVE_INFINITY;
    let n = 0;
    for (let i = t.prices.length - 1; i >= 0; i--) {
      const pt = t.prices[i]!;
      if (pt.slot < slot - p.highWindow) break;
      if (pt.price > high) high = pt.price;
      if (pt.price < low) low = pt.price;
      n++;
    }
    if (p.highWindow >= 100000) {
      if (t.peak <= 0) return null;
      return { high: t.peak, low: low === Number.POSITIVE_INFINITY ? t.peak : low };
    }
    return n >= 3 ? { high, low } : null;
  }

  private flowOk(t: CurveTape): boolean {
    const p = this.params;
    if (!p.requireFlow) return true;
    if (t.flow.length < p.flowTrades) return false;
    if (p.lastMustBeBuy && !t.flow[t.flow.length - 1]!.isBuy) return false;
    let buys = 0;
    let net = 0n;
    for (const f of t.flow) {
      if (f.isBuy) {
        buys++;
        net += f.sol;
      } else {
        net -= f.sol;
      }
    }
    return buys >= p.minBuys && net >= p.minNetFlow;
  }

  /**
   * Decide this batch's orders. Exits first (they free slots and cash), then entries
   * for curves that carried an event in this batch.
   */
  decide(state: BotState, batch: Batch): OrderInput[] {
    const p = this.params;
    const orders: OrderInput[] = [];
    const tx = state.txFeeLamports();

    // Sync open positions with the account: drop closed ones, adopt new ones.
    const held = new Set<Pubkey>(state.positions.keys());
    for (const mint of [...this.open.keys()]) {
      if (!held.has(mint)) {
        const t = this.tapes.get(mint);
        if (t !== undefined) t.cooldownUntil = batch.slot + p.cooldownSlots;
        this.open.delete(mint);
      }
    }
    for (const mint of held) {
      if (!this.open.has(mint)) {
        this.open.set(mint, { mint, entrySlot: batch.slot, bestRatio: 1 });
      }
    }

    // --- Circuit breaker: portfolio value vs its peak. ---
    // Value at spot (cash + positions marked to the curve), the same basis the
    // grader's hourly equity marks use, up to close fees.
    let value = state.cash;
    for (const [mint, holding] of state.positions) {
      const curve = state.curves.get(mint);
      if (curve !== undefined) {
        value += liquidationValue(holding.token_amount, curve.virtual_quote_reserves, curve.virtual_token_reserves);
      }
    }
    if (value > this.peakValue) this.peakValue = value;
    if (p.brakeDd > 0 && this.peakValue > 0n) {
      const dd = Number(this.peakValue - value) / Number(this.peakValue);
      if (!this.braked && dd >= p.brakeDd) {
        this.braked = true;
        this.brakeSinceSlot = batch.slot;
      } else if (this.braked && dd <= p.brakeResumeDd) {
        this.braked = false;
      } else if (this.braked && p.brakeSlots > 0 && batch.slot - this.brakeSinceSlot >= p.brakeSlots) {
        // Time resume: ratchet the peak down to the current value so the next
        // brake is measured from here, not from the old high (else it re-brakes
        // on the very next batch).
        this.braked = false;
        this.peakValue = value;
      }
    }

    // --- Exits: sell the whole position on TP / SL / trailing / time. ---
    // A sell already in flight on the mint is not sent again: it fills in 2 slots
    // and a duplicate would only be rejected (insufficient_tokens) on arrival.
    const sellPending = new Set<Pubkey>();
    for (const pend of state.pending.values()) {
      if (pend.order.side === 'sell') sellPending.add(pend.order.mint);
    }
    for (const [mint, pos] of this.open) {
      if (sellPending.has(mint)) continue;
      const curve = state.curves.get(mint);
      const holding = state.positions.get(mint);
      if (curve === undefined || curve.complete || holding === undefined) continue;
      const value = liquidationValue(holding.token_amount, curve.virtual_quote_reserves, curve.virtual_token_reserves);
      if (holding.cost_lamports === 0n) continue;
      const ratio = Number(value) / Number(holding.cost_lamports);
      if (ratio > pos.bestRatio) pos.bestRatio = ratio;
      const heldSlots = batch.slot - pos.entrySlot;
      const trailingHit = pos.bestRatio >= 1 + p.trailArm && ratio <= pos.bestRatio * (1 - p.trail);
      let reason: string | null = null;
      if (ratio >= 1 + p.takeProfit) reason = 'take_profit';
      else if (ratio <= 1 - p.stopLoss) reason = 'stop_loss';
      else if (trailingHit) reason = 'trailing';
      else if (heldSlots >= p.maxHoldSlots) reason = 'max_hold';
      if (reason !== null) {
        orders.push({ side: 'sell', mint, token_amount: holding.token_amount, max_slippage_bps: p.sellSlippageBps });
        this.diag?.exits.push({ mint, reason, ratio });
      }
    }
    if (orders.length >= state.hello.caps.max_orders_per_batch) return orders;

    // --- Entries: only curves that carried an event in this batch. ---
    let free = state.freeCashLamports();
    // Exits in this reply free no cash until they fill; sells do not consume cash.
    let slots = state.hello.caps.max_open_positions - state.committedPositionCount();
    // Positions being sold this batch still count as committed until filled; exits
    // above already occupy their slot, so only count truly free slots for entries.
    // (committedPositionCount counts held + pending buys; a pending sell does not free it.)
    let entries = 0;
    let deployed = 0n;
    for (const h of state.positions.values()) deployed += h.cost_lamports;
    // Mints bought already in this reply: one buy per mint per reply (the size cap
    // is per mint per reply, and a batch can carry several events of one mint).
    const boughtThisReply = new Set<Pubkey>();

    for (const e of batch.events) {
      if (entries >= p.maxEntriesPerBatch) break;
      if (orders.length >= state.hello.caps.max_orders_per_batch) break;
      if (slots <= 0) break;
      if (this.braked) break;
      if (e.event === 'CompleteEvent') continue;
      const mint = e.mint;
      if (boughtThisReply.has(mint)) continue;
      if (this.open.has(mint) || state.positions.has(mint)) continue;
      // A buy already in flight on this mint: do not stack a second one before it fills.
      let buyPending = false;
      for (const pend of state.pending.values()) {
        if (pend.order.side === 'buy' && pend.order.mint === mint) {
          buyPending = true;
          break;
        }
      }
      if (buyPending) continue;
      const t = this.tapes.get(mint);
      const curve = state.curves.get(mint);
      if (t === undefined || curve === undefined || curve.complete) continue;
      if (t.entries >= p.maxEntries) continue;
      if (batch.slot < t.cooldownUntil) continue;
      if (t.createdSlot !== null && batch.slot - t.createdSlot < p.minAge) continue;
      if (curve.real_quote_reserves < p.minRealSol || curve.real_quote_reserves > p.maxRealSol) continue;
      if (deployed + p.stake > p.maxExposure) continue;

      const price = spotPrice(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      if (price <= 0) continue;
      const hl = this.recentHighLow(t, batch.slot);
      if (hl === null || hl.high <= 0 || hl.low <= 0) continue;
      const dd = 1 - price / hl.high;
      if (dd < p.ddMin || dd > p.ddMax) continue;
      // Bounce confirmation: do not catch a knife still falling — price must have
      // lifted off its window low.
      if (price < hl.low * (1 + p.bounceMin)) continue;
      if (!this.flowOk(t)) continue;

      const cap = state.maxBuyLamports(mint);
      const amount = cap < p.stake ? cap : p.stake;
      if (amount < p.minBuy) continue;
      if (free < amount + tx) continue;

      orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: p.buySlippageBps });
      boughtThisReply.add(mint);
      t.entries += 1;
      entries += 1;
      slots -= 1;
      free -= amount + tx;
      deployed += amount;
    }
    return orders;
  }
}
