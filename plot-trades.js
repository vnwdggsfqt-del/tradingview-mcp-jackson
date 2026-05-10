#!/usr/bin/env node
/**
 * Plot backtest trades on TradingView chart
 *
 * Reads a backtest-YYYY-MM-DD.json file and draws entry/exit markers
 * on the chart using the MCP drawing tools.
 *
 * Usage:
 *   node plot-trades.js backtest-2026-05-03.json
 *   node plot-trades.js backtest-2026-05-03.json --clear
 */

import { readFileSync } from "fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const file = process.argv[2];
if (!file) {
  console.error("Usage: node plot-trades.js <backtest-file.json> [--clear]");
  process.exit(1);
}

const clearFirst = process.argv.includes("--clear");
const report = JSON.parse(readFileSync(file, "utf8"));
const trades = report.trades || [];

if (trades.length === 0) {
  console.log("No trades to plot.");
  process.exit(0);
}

let client;

async function connect() {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["src/server.js"],
  });
  client = new Client({ name: "trade-plotter", version: "1.0.0" });
  await client.connect(transport);
}

async function call(tool, params = {}) {
  const result = await client.callTool({ name: tool, arguments: params });
  const text = result.content?.find((c) => c.type === "text")?.text;
  if (!text) return result;
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function run() {
  console.log(`Plotting ${trades.length} trades from ${file}...\n`);

  await connect();

  if (clearFirst) {
    console.log("Clearing existing drawings...");
    await call("draw_clear");
    await sleep(500);
  }

  // Get current OHLCV to map bar indices to timestamps
  // We need the bar timestamps to place drawings correctly
  const ohlcv = await call("data_get_ohlcv", { count: 500 });
  const bars = ohlcv?.bars || [];

  // Build a price→approximate time lookup from available bars
  // Since backtest stores entryBar/exitBar indices, we need the start date
  const startDate = new Date(report.date + "T00:00:00Z");
  const timeframeMs = 15 * 60 * 1000; // 15m bars

  for (let i = 0; i < trades.length; i++) {
    const t = trades[i];
    const entryTime = Math.floor(startDate.getTime() / 1000) + (t.entryBar * 15 * 60);
    const exitTime = Math.floor(startDate.getTime() / 1000) + (t.exitBar * 15 * 60);

    const isBuy = t.direction === "buy";
    const isWin = t.pnl >= 0;

    // Entry marker
    const entryColor = isBuy ? "#2196F3" : "#FF5722"; // blue=buy, red=sell
    const entryLabel = `${isBuy ? "▲ BUY" : "▼ SELL"} @ ${t.entryPrice}\n[${t.type}]`;

    await call("draw_shape", {
      shape: "text",
      point: { time: entryTime, price: t.entryPrice },
      text: entryLabel,
      overrides: JSON.stringify({
        color: entryColor,
        fontsize: 10,
        bold: true,
      }),
    });

    // Exit marker
    const exitColor = isWin ? "#4CAF50" : "#F44336"; // green=win, red=loss
    const exitLabel = `${isWin ? "✓" : "✗"} EXIT @ ${t.exitPrice}\n${t.exitReason} | ${t.pnl >= 0 ? "+" : ""}${t.pnl}`;

    await call("draw_shape", {
      shape: "text",
      point: { time: exitTime, price: t.exitPrice },
      text: exitLabel,
      overrides: JSON.stringify({
        color: exitColor,
        fontsize: 10,
        bold: true,
      }),
    });

    // Connect entry to exit with a trend line
    await call("draw_shape", {
      shape: "trend_line",
      point: { time: entryTime, price: t.entryPrice },
      point2: { time: exitTime, price: t.exitPrice },
      overrides: JSON.stringify({
        linecolor: isWin ? "#4CAF50" : "#F44336",
        linewidth: 2,
        linestyle: isWin ? 0 : 2, // solid=win, dashed=loss
      }),
    });

    // Target line (if target was set)
    if (t.target) {
      await call("draw_shape", {
        shape: "trend_line",
        point: { time: entryTime, price: t.target },
        point2: { time: exitTime, price: t.target },
        overrides: JSON.stringify({
          linecolor: "#4CAF50",
          linewidth: 1,
          linestyle: 2,
        }),
      });
    }

    // Stop line (if stop was set)
    if (t.stop) {
      await call("draw_shape", {
        shape: "trend_line",
        point: { time: entryTime, price: t.stop },
        point2: { time: exitTime, price: t.stop },
        overrides: JSON.stringify({
          linecolor: "#F44336",
          linewidth: 1,
          linestyle: 2,
        }),
      });
    }

    const icon = isWin ? "✓" : "✗";
    console.log(`  ${icon} Trade ${i + 1}: ${t.direction.toUpperCase()} ${t.entryPrice} → ${t.exitPrice} (${t.pnl >= 0 ? "+" : ""}${t.pnl})`);

    await sleep(300);
  }

  // Summary text at the last trade
  const lastTrade = trades[trades.length - 1];
  const summaryTime = Math.floor(startDate.getTime() / 1000) + (lastTrade.exitBar * 15 * 60) + 3600;
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const wins = trades.filter((t) => t.pnl > 0).length;

  await call("draw_shape", {
    shape: "text",
    point: { time: summaryTime, price: lastTrade.exitPrice },
    text: `Backtest: ${trades.length} trades | ${wins}W/${trades.length - wins}L | P&L: ${totalPnl >= 0 ? "+" : ""}${Math.round(totalPnl * 100) / 100}`,
    overrides: JSON.stringify({
      color: totalPnl >= 0 ? "#4CAF50" : "#F44336",
      fontsize: 12,
      bold: true,
    }),
  });

  console.log(`\n  Plotted ${trades.length} trades on chart.`);
  console.log(`  Use "node plot-trades.js ${file} --clear" to remove drawings.\n`);

  await client.close();
}

run().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
