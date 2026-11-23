// Momentum-confirmed trend hold for the make.fun 24h BTC bars-replay race.
//
// Why this shape: a round trip costs roughly 30 bps in fees, slippage and
// price impact, so a bot that trades every wiggle donates its stack to the
// pool. This bot trades rarely and on purpose:
//
//   - Entry: while flat, it waits for a real move to prove itself: the close
//     must be up at least 0.3% over the last 90 one-minute bars (a trailing
//     90-bar return read off closes). One strong hour, not one lucky minute.
//     It then stakes 99% of the cash on hand, once.
//   - Hold: it does nothing while the trend lives. No rebalancing, no
//     profit-taking into chop, no second-guessing: the position rides.
//   - Exit: the whole position is sold only when the close falls 2.5% under
//     the highest close marked since the position appeared (a peak-drawdown
//     guard), which is far outside this market's ordinary minute noise but
//     well inside the 25% drawdown guardrail. The signal is re-sent every
//     bar while it holds, so a sell refused on slippage is retried, not lost.
//   - After an exit it cools down for 30 bars before a fresh 90-bar move may
//     re-enter it, so one reversal cannot whip it in and out twice.
//
// Slippage caps: 150 bps on the buy, 250 bps on the sell (leaving matters
// more than the last few bps). All maths is float64 + - * / on the bars
// alone: no clock, no randomness, no environment, so the two graded runs
// agree byte for byte.

import { runBars, type Bar, type BarsState, type OrderInput } from './vendor/makefun-bars.ts';

const LOOKBACK_BARS = 90;
const ENTRY_RETURN = 0.003;
const EXIT_DRAWDOWN = 0.025;
const COOLDOWN_BARS = 30;
const BUY_SLIPPAGE_BPS = 150;
const SELL_SLIPPAGE_BPS = 250;

interface Track {
  /** The last LOOKBACK_BARS + 1 closes, oldest first. */
  closes: number[];
  barsSeen: number;
  /** True while the account holds the symbol (as last seen). */
  holding: boolean;
  /** Highest close marked since the position appeared. */
  peakClose: number;
  /** barsSeen before which no new entry may fire after an exit. */
  cooldownUntil: number;
}

const tracks = new Map<string, Track>();

function track(symbol: string): Track {
  let t = tracks.get(symbol);
  if (t === undefined) {
    t = { closes: [], barsSeen: 0, holding: false, peakClose: 0, cooldownUntil: -1 };
    tracks.set(symbol, t);
  }
  return t;
}

function observe(t: Track, bar: Bar): void {
  t.barsSeen += 1;
  t.closes.push(Number(bar.c));
  if (t.closes.length > LOOKBACK_BARS + 1) t.closes.shift();
}

await runBars({
  onBatch(state: BarsState, batch) {
    const orders: OrderInput[] = [];
    const fresh = new Set<string>();
    for (const bar of batch.bars) {
      observe(track(bar.symbol), bar);
      fresh.add(bar.symbol);
    }
    if (state.warmingUp) return orders;

    const { caps, fees } = state.hello;
    const minNotional = BigInt(fees.min_notional_quote_units);

    for (const { symbol } of state.hello.symbols) {
      if (!fresh.has(symbol)) continue;
      const t = track(symbol);
      const held = state.positions.get(symbol);
      const close = state.close(symbol);
      if (close === null) continue;
      const closeNum = Number(close);

      if (held !== undefined) {
        if (!t.holding) {
          t.holding = true;
          t.peakClose = closeNum;
        }
        if (closeNum > t.peakClose) t.peakClose = closeNum;
        if (closeNum < t.peakClose * (1 - EXIT_DRAWDOWN)) {
          if (orders.length < caps.max_orders_per_bar) {
            orders.push({ side: 'sell', symbol, qty: held.qty, max_slippage_bps: SELL_SLIPPAGE_BPS });
          }
        }
        continue;
      }

      if (t.holding) {
        // The position is gone (the exit filled): start the cooldown.
        t.holding = false;
        t.peakClose = 0;
        t.cooldownUntil = t.barsSeen + COOLDOWN_BARS;
      }
      if (t.barsSeen <= t.cooldownUntil) continue;
      if (t.closes.length < LOOKBACK_BARS + 1) continue;
      const then = t.closes[0]!;
      if (then <= 0) continue;
      if (closeNum / then - 1 <= ENTRY_RETURN) continue;
      const room = state.weightRoom(symbol);
      let stake = (state.cash * 99n) / 100n;
      if (room < stake) stake = room;
      if (stake < minNotional) continue;
      if (orders.length >= caps.max_orders_per_bar) break;
      orders.push({ side: 'buy', symbol, notional_quote_units: stake, max_slippage_bps: BUY_SLIPPAGE_BPS });
    }
    return orders;
  },
});
