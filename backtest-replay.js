#!/usr/bin/env node
/**
 * VWAP + Volume Profile Replay Backtester
 *
 * Steps through TradingView replay bar-by-bar, runs the analyzer
 * at each bar, takes trades when setups trigger, and logs results.
 *
 * Usage:
 *   node backtest-replay.js --date 2025-05-01
 *   node backtest-replay.js --date 2025-05-01 --bars 100
 *   node backtest-replay.js --date 2025-05-01 --bars 50 --speed fast
 */

import { readFileSync, writeFileSync } from "fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const rules = JSON.parse(
  readFileSync(new URL("rules.json", import.meta.url), "utf8")
);

// ── CLI args ────────────────────────────────────────────────────
const args = process.argv.slice(2);
function flag(name) {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : null;
}

const START_DATE = flag("date") || "2025-05-01";
const MAX_BARS = parseInt(flag("bars") || "80", 10);
const SPEED = flag("speed") || "normal"; // "fast" = skip bars without setups
const WAIT_MS = SPEED === "fast" ? 500 : 1500;

// ── MCP client ──────────────────────────────────────────────────
let client;

async function connect() {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["src/server.js"],
  });
  client = new Client({ name: "backtester", version: "1.0.0" });
  await client.connect(transport);
}

async function call(tool, params = {}) {
  const result = await client.callTool({ name: tool, arguments: params });
  const text = result.content?.find((c) => c.type === "text")?.text;
  if (!text) return result;
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ── Analyzer (inlined from intraday-analyzer) ───────────────────
function parseNum(s) {
  return Number(String(s).replace(/,/g, "").replace(/[^\d.\-]/g, ""));
}

function analyzeBar(quote, studyValues, pineTables, pineLabels) {
  const price = quote?.last ?? quote?.close;

  // VWAP
  let vwap = null, ub1 = null, lb1 = null, ub2 = null, lb2 = null;
  for (const study of (studyValues?.studies || [])) {
    const nameLower = (study.name || "").toLowerCase();
    const vals = study.values || {};
    const keysLower = Object.keys(vals).map((k) => k.toLowerCase());
    if (nameLower.includes("vwap") || nameLower.includes("anchored") ||
        keysLower.some((k) => k.includes("vwap"))) {
      for (const [k, v] of Object.entries(vals)) {
        const kl = k.toLowerCase();
        const n = parseNum(v);
        if (isNaN(n)) continue;
        if (kl.includes("vwap")) vwap = n;
        else if ((kl.includes("inner") || kl.includes("1")) && kl.includes("upper")) ub1 = n;
        else if ((kl.includes("inner") || kl.includes("1")) && kl.includes("lower")) lb1 = n;
        else if ((kl.includes("outer") || kl.includes("2")) && kl.includes("upper")) ub2 = n;
        else if ((kl.includes("outer") || kl.includes("2")) && kl.includes("lower")) lb2 = n;
      }
    }
  }

  let vwapPosition = "unknown";
  if (vwap && price) {
    if (ub2 && price >= ub2) vwapPosition = "extended_above_2σ";
    else if (ub1 && price >= ub1) vwapPosition = "above_1σ";
    else if (price > vwap) vwapPosition = "above_vwap";
    else if (lb2 && price <= lb2) vwapPosition = "extended_below_2σ";
    else if (lb1 && price <= lb1) vwapPosition = "below_1σ";
    else vwapPosition = "below_vwap";
  }

  // Volume Profile from tables
  let poc = null, vah = null, val = null, vpTrend = null, priceZone = null;
  if (pineTables?.studies) {
    for (const study of Object.values(pineTables.studies)) {
      for (const table of (study.tables || (Array.isArray(study) ? study : []))) {
        for (const row of (table.rows || [])) {
          const [key, v] = String(row).split("|").map((s) => s.trim());
          if (!key || !v) continue;
          const kl = key.toLowerCase();
          if (kl === "poc") poc = parseNum(v);
          else if (kl === "vah") vah = parseNum(v);
          else if (kl === "val") val = parseNum(v);
          else if (kl === "trend") vpTrend = v;
          else if (kl === "price zone") priceZone = v;
        }
      }
    }
  }

  // Fallback: labels
  if (!poc || !vah || !val) {
    if (pineLabels?.studies) {
      for (const study of Object.values(pineLabels.studies)) {
        const labels = study.labels || (Array.isArray(study) ? study : []);
        for (const label of labels) {
          const txt = (label.text || "").toUpperCase();
          const p = label.price ?? label.y;
          if (!poc && txt.includes("POC") && !txt.includes("YPOC")) poc = p;
          else if (!vah && txt.includes("VAH")) vah = p;
          else if (!val && txt.includes("VAL") && !txt.includes("VALUE")) val = p;
        }
      }
    }
  }

  // Bias
  let bullish = 0, bearish = 0;
  if (["above_vwap", "above_1σ"].includes(vwapPosition)) bullish += 2;
  if (["below_vwap", "below_1σ"].includes(vwapPosition)) bearish += 2;
  if (vwapPosition === "extended_above_2σ") bearish += 1;
  if (vwapPosition === "extended_below_2σ") bullish += 1;
  if (poc && price > poc) bullish += 1; else if (poc) bearish += 1;

  const diff = bullish - bearish;
  let bias;
  if (diff >= 3) bias = "strongly_bullish";
  else if (diff >= 1) bias = "bullish";
  else if (diff <= -3) bias = "strongly_bearish";
  else if (diff <= -1) bias = "bearish";
  else bias = "neutral";

  // Setups
  const setups = [];
  if (!price) return { price, vwap, vwapPosition, poc, vah, val, bias, setups, vpTrend, priceZone };

  // Trend continuation
  if (bias.includes("bullish") && vwapPosition === "above_vwap") {
    setups.push({ type: "trend_continuation", direction: "buy", target: vah, stop: val || vwap });
  }
  if (bias.includes("bearish") && vwapPosition === "below_vwap") {
    setups.push({ type: "trend_continuation", direction: "sell", target: val, stop: vah || vwap });
  }

  // Mean reversion
  if (vwapPosition === "extended_below_2σ" && !bias.includes("strongly_bearish")) {
    setups.push({ type: "mean_reversion", direction: "buy", target: vwap, stop: lb2 ? lb2 - (ub2 - lb2) * 0.2 : null });
  }
  if (vwapPosition === "extended_above_2σ" && !bias.includes("strongly_bullish")) {
    setups.push({ type: "mean_reversion", direction: "sell", target: vwap, stop: ub2 ? ub2 + (ub2 - lb2) * 0.2 : null });
  }

  // Breakout
  if (vah && price > vah * 0.998 && price < vah * 1.005) {
    setups.push({ type: "breakout", direction: "buy", target: vah + (vah - (val || vwap)), stop: vah });
  }
  if (val && price < val * 1.002 && price > val * 0.995) {
    setups.push({ type: "breakout", direction: "sell", target: val - ((vah || vwap) - val), stop: val });
  }

  return { price, vwap, vwapPosition, poc, vah, val, bias, setups, vpTrend, priceZone };
}

// ── Trade management ────────────────────────────────────────────
const trades = [];
let position = null; // { direction, entryPrice, entryBar, type, target, stop }
let consecutiveLosses = 0;

function shouldEnter(analysis, barNum) {
  if (position) return null;
  if (consecutiveLosses >= 3) return null;
  if (barNum < 5) return null; // skip first 5 bars (let indicators settle)
  if (analysis.bias === "neutral") return null;
  if (analysis.setups.length === 0) return null;

  // Pick best setup (prefer trend continuation > breakout > mean reversion)
  const priority = { trend_continuation: 3, breakout: 2, mean_reversion: 1 };
  const sorted = [...analysis.setups].sort((a, b) => (priority[b.type] || 0) - (priority[a.type] || 0));
  return sorted[0];
}

function shouldExit(analysis, barNum) {
  if (!position) return null;
  const barsHeld = barNum - position.entryBar;
  const price = analysis.price;

  // Stop loss
  if (position.direction === "buy" && position.stop && price <= position.stop) {
    return { reason: "stop_loss", price };
  }
  if (position.direction === "sell" && position.stop && price >= position.stop) {
    return { reason: "stop_loss", price };
  }

  // Target hit
  if (position.direction === "buy" && position.target && price >= position.target) {
    return { reason: "target_hit", price };
  }
  if (position.direction === "sell" && position.target && price <= position.target) {
    return { reason: "target_hit", price };
  }

  // Time stop: 30 bars without progress → exit
  if (barsHeld >= 30) {
    return { reason: "time_stop", price };
  }

  // Bias flip
  if (position.direction === "buy" && analysis.bias.includes("bearish")) {
    return { reason: "bias_flip", price };
  }
  if (position.direction === "sell" && analysis.bias.includes("bullish")) {
    return { reason: "bias_flip", price };
  }

  return null;
}

// ── Main loop ───────────────────────────────────────────────────
async function run() {
  console.log("═══════════════════════════════════════════════════════");
  console.log("  VWAP + VP Replay Backtester");
  console.log(`  Start: ${START_DATE}  |  Bars: ${MAX_BARS}  |  Speed: ${SPEED}`);
  console.log("═══════════════════════════════════════════════════════\n");

  await connect();

  // Start replay
  console.log(`Starting replay from ${START_DATE}...`);
  const startResult = await call("replay_start", { date: START_DATE });
  if (!startResult.success) {
    console.error("Failed to start replay:", startResult.error || startResult);
    await client.close();
    return;
  }
  console.log(`Replay started. Date: ${startResult.current_date || START_DATE}\n`);

  await sleep(2000); // let indicators settle

  for (let bar = 0; bar < MAX_BARS; bar++) {
    // Step forward
    const stepResult = await call("replay_step");
    if (!stepResult.success) {
      console.log(`Bar ${bar}: step failed — ${stepResult.error}`);
      break;
    }

    await sleep(WAIT_MS);

    // Gather data
    const [quote, studyValues, pineTables, pineLabels] = await Promise.all([
      call("quote_get"),
      call("data_get_study_values"),
      call("data_get_pine_tables", { study_filter: "Willy" }),
      call("data_get_pine_labels"),
    ]);

    const analysis = analyzeBar(quote, studyValues, pineTables, pineLabels);

    // Check exit first
    const exitSignal = shouldExit(analysis, bar);
    if (exitSignal) {
      const pnl = position.direction === "buy"
        ? exitSignal.price - position.entryPrice
        : position.entryPrice - exitSignal.price;

      await call("replay_trade", { action: "close" });

      const trade = {
        ...position,
        exitPrice: exitSignal.price,
        exitBar: bar,
        exitReason: exitSignal.reason,
        pnl: Math.round(pnl * 100) / 100,
        barsHeld: bar - position.entryBar,
      };
      trades.push(trade);

      const icon = pnl >= 0 ? "✓" : "✗";
      console.log(`  ${icon} EXIT ${position.direction.toUpperCase()} @ ${exitSignal.price} | ${exitSignal.reason} | P&L: ${pnl >= 0 ? "+" : ""}${trade.pnl} | Held ${trade.barsHeld} bars`);

      if (pnl < 0) consecutiveLosses++;
      else consecutiveLosses = 0;

      if (consecutiveLosses >= 3) {
        console.log("\n  ⚠ 3 consecutive losses — stopping per risk rules\n");
      }

      position = null;
    }

    // Check entry
    const setup = shouldEnter(analysis, bar);
    if (setup) {
      await call("replay_trade", { action: setup.direction });

      position = {
        direction: setup.direction,
        entryPrice: analysis.price,
        entryBar: bar,
        type: setup.type,
        target: setup.target,
        stop: setup.stop,
      };

      console.log(`\n  Bar ${bar} | ${analysis.price} | Bias: ${analysis.bias} | VWAP: ${analysis.vwapPosition}`);
      console.log(`  → ENTER ${setup.direction.toUpperCase()} [${setup.type}] @ ${analysis.price}`);
      console.log(`    Target: ${setup.target || "N/A"} | Stop: ${setup.stop || "N/A"}`);
    } else if (bar % 10 === 0) {
      // Progress update every 10 bars
      console.log(`  Bar ${bar} | ${analysis.price || "?"} | Bias: ${analysis.bias} | VWAP: ${analysis.vwapPosition}${position ? ` | IN ${position.direction.toUpperCase()}` : ""}`);
    }
  }

  // Close any open position
  if (position) {
    const quote = await call("quote_get");
    const exitPrice = quote?.last ?? quote?.close;
    await call("replay_trade", { action: "close" });
    const pnl = position.direction === "buy"
      ? exitPrice - position.entryPrice
      : position.entryPrice - exitPrice;
    trades.push({
      ...position,
      exitPrice,
      exitBar: MAX_BARS,
      exitReason: "session_end",
      pnl: Math.round(pnl * 100) / 100,
      barsHeld: MAX_BARS - position.entryBar,
    });
    console.log(`  ⏹ CLOSE ${position.direction.toUpperCase()} @ ${exitPrice} | session_end | P&L: ${pnl >= 0 ? "+" : ""}${Math.round(pnl * 100) / 100}`);
    position = null;
  }

  // Stop replay
  await call("replay_stop");

  // ── Results ─────────────────────────────────────────────────
  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  BACKTEST RESULTS");
  console.log("═══════════════════════════════════════════════════════\n");

  if (trades.length === 0) {
    console.log("  No trades taken.\n");
  } else {
    const wins = trades.filter((t) => t.pnl > 0);
    const losses = trades.filter((t) => t.pnl <= 0);
    const totalPnl = trades.reduce((sum, t) => sum + t.pnl, 0);
    const avgWin = wins.length ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
    const avgLoss = losses.length ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;
    const avgBarsHeld = trades.reduce((s, t) => s + t.barsHeld, 0) / trades.length;

    console.log(`  Total Trades:   ${trades.length}`);
    console.log(`  Wins:           ${wins.length} (${((wins.length / trades.length) * 100).toFixed(0)}%)`);
    console.log(`  Losses:         ${losses.length}`);
    console.log(`  Total P&L:      ${totalPnl >= 0 ? "+" : ""}${Math.round(totalPnl * 100) / 100}`);
    console.log(`  Avg Win:        +${Math.round(avgWin * 100) / 100}`);
    console.log(`  Avg Loss:       ${Math.round(avgLoss * 100) / 100}`);
    if (avgLoss !== 0) {
      console.log(`  Win/Loss Ratio: ${Math.abs(Math.round((avgWin / avgLoss) * 100) / 100)}`);
    }
    console.log(`  Avg Bars Held:  ${Math.round(avgBarsHeld)}`);
    console.log();

    // Trade log
    console.log("  ── Trade Log ──────────────────────────────────────");
    for (const t of trades) {
      const icon = t.pnl >= 0 ? "✓" : "✗";
      console.log(`  ${icon} ${t.direction.toUpperCase()} [${t.type}] Entry: ${t.entryPrice} → Exit: ${t.exitPrice} | ${t.exitReason} | P&L: ${t.pnl >= 0 ? "+" : ""}${t.pnl} (${t.barsHeld} bars)`);
    }
  }

  // Save results
  const report = {
    date: START_DATE,
    bars: MAX_BARS,
    symbol: rules.watchlist[0],
    trades,
    summary: trades.length ? {
      total: trades.length,
      wins: trades.filter((t) => t.pnl > 0).length,
      losses: trades.filter((t) => t.pnl <= 0).length,
      totalPnl: Math.round(trades.reduce((s, t) => s + t.pnl, 0) * 100) / 100,
    } : null,
    timestamp: new Date().toISOString(),
  };
  const filename = `backtest-${START_DATE}.json`;
  writeFileSync(filename, JSON.stringify(report, null, 2));
  console.log(`\n  Results saved to ${filename}`);
  console.log("═══════════════════════════════════════════════════════\n");

  await client.close();
}

run().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
