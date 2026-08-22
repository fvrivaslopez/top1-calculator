/*
 * Client-side port of top1_live_bot/backtest.py's simulate_strategy() /
 * simulate_spy() / calculate_metrics(). Same weekly-Friday rebalancing, same
 * 0.1% transaction cost, same "who was #1 and when" table — generalized here
 * to accept weekly/monthly/yearly contributions instead of monthly-only.
 * Keep this in sync with backtest.py if that file's simulation math changes.
 */

const TRANSACTION_COST = 0.001;
const DATA_URL = "data/top1_history.json";

let DATA = null; // loaded top1_history.json

// ---- Spanish capital-gains tax (base imponible del ahorro, 2026 state scale) ----
// Applies nationwide, no regional variation, to gains realized when a position
// is sold (unrealized/mark-to-market gains are never taxed). Simplification:
// bracket thresholds are EUR amounts applied directly to USD figures with no
// FX conversion (this calculator has no currency conversion anywhere), and
// dividends aren't modeled separately since the price data folds them into
// price appreciation (yfinance auto_adjust=True) rather than paying them out
// as separate taxable cash distributions.
const ES_SAVINGS_TAX_BRACKETS = [
  [0, 6000, 0.19],
  [6000, 50000, 0.21],
  [50000, 200000, 0.23],
  [200000, 300000, 0.27],
  [300000, Infinity, 0.30],
];

function progressiveTax(amount) {
  if (amount <= 0) return 0;
  let tax = 0;
  for (const [lo, hi, rate] of ES_SAVINGS_TAX_BRACKETS) {
    if (amount <= lo) break;
    tax += (Math.min(amount, hi) - lo) * rate;
  }
  return tax;
}

/**
 * Tracks realized gains/losses per calendar year and applies Spain's rule
 * that a year's net capital loss can offset gains in the following 4 years
 * ("compensación de pérdidas patrimoniales", base del ahorro). Tax owed on
 * each sale is the marginal change in that year's bracket-taxed total, so
 * a same-year loss after an already-taxed gain naturally nets back out
 * (mirrors real annual settlement) instead of requiring a separate
 * "amend last quarter's tax" step.
 */
function createSpanishTaxTracker() {
  let carryforward = []; // [{year, remaining}], usable for year+1..year+4
  const yearGain = {}; // year -> cumulative signed realized gain so far
  const yearCF = {}; // year -> available carryforward, snapshotted when the year opens
  let openYear = null;
  let totalTaxPaid = 0;

  function closeYear(y) {
    const net = yearGain[y] || 0;
    if (net < 0) {
      carryforward.push({ year: y, remaining: -net });
    } else if (net > 0) {
      let toConsume = Math.min(yearCF[y] || 0, net);
      for (const e of carryforward) {
        if (toConsume <= 0) break;
        if (y - e.year >= 1 && y - e.year <= 4 && e.remaining > 0) {
          const take = Math.min(e.remaining, toConsume);
          e.remaining -= take;
          toConsume -= take;
        }
      }
      carryforward = carryforward.filter((e) => e.remaining > 1e-6);
    }
  }

  function openYearIfNeeded(y) {
    if (openYear === null) {
      openYear = y;
    } else if (y !== openYear) {
      for (let yy = openYear; yy < y; yy++) closeYear(yy);
      openYear = y;
    }
    if (!(y in yearGain)) {
      yearGain[y] = 0;
      carryforward = carryforward.filter((e) => y - e.year <= 4);
      yearCF[y] = carryforward.reduce((s, e) => s + e.remaining, 0);
    }
  }

  function taxableForYear(cum, cf) {
    return cum <= 0 ? 0 : Math.max(0, cum - cf);
  }

  return {
    // Realizes a gain/loss on `date` (YYYY-MM-DD) and returns the tax due on
    // this specific transaction (can be negative: a same-year loss handing
    // back part of the tax already paid on an earlier gain that year).
    realize(gain, date) {
      const y = parseInt(date.slice(0, 4), 10);
      openYearIfNeeded(y);
      const prevCum = yearGain[y];
      const newCum = prevCum + gain;
      yearGain[y] = newCum;
      const cf = yearCF[y] || 0;
      const tax = progressiveTax(taxableForYear(newCum, cf)) - progressiveTax(taxableForYear(prevCum, cf));
      totalTaxPaid += tax;
      return tax;
    },
    totalTaxPaid() {
      return totalTaxPaid;
    },
  };
}

async function loadData() {
  const res = await fetch(DATA_URL, { cache: "no-store" });
  if (!res.ok) throw new Error(`No se pudo cargar data/top1_history.json (HTTP ${res.status})`);
  return res.json();
}

// ---- date/grouping helpers ------------------------------------------------

function mondayOf(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay(); // 0=Sun..6=Sat
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

function weekKey(dateStr) {
  return mondayOf(new Date(dateStr + "T00:00:00Z"));
}
function monthKey(dateStr) {
  return dateStr.slice(0, 7);
}
function yearKey(dateStr) {
  return dateStr.slice(0, 4);
}

// First/last trading day within each group, keyed by the grouping function.
function groupBoundaryDays(dates, keyFn, which) {
  const seen = new Map(); // key -> first or last date in that group
  for (const d of dates) {
    const k = keyFn(d);
    if (which === "first") {
      if (!seen.has(k)) seen.set(k, d);
    } else {
      seen.set(k, d);
    }
  }
  return new Set(seen.values());
}

// ---- Top-1 calendar ---------------------------------------------------------

function buildTop1Calendar(top1Historical, dates) {
  const events = [...top1Historical].sort((a, b) => a.date.localeCompare(b.date));
  const cal = new Array(dates.length).fill(null);
  let ei = 0;
  for (let i = 0; i < dates.length; i++) {
    while (ei + 1 < events.length && events[ei + 1].date <= dates[i]) ei++;
    cal[i] = dates[i] >= events[0].date ? events[ei].ticker : events[0].ticker;
  }
  return cal;
}

// ---- simulation -------------------------------------------------------------

function contributionDaySet(dates, frequency) {
  if (frequency === "none") return new Set();
  if (frequency === "weekly") return groupBoundaryDays(dates, weekKey, "first");
  if (frequency === "yearly") return groupBoundaryDays(dates, yearKey, "first");
  return groupBoundaryDays(dates, monthKey, "first"); // monthly (default)
}

/**
 * Simulates the Top-1 strategy: weekly rebalancing into whoever's #1 that
 * week, plus recurring contributions at the chosen cadence.
 * prices: { TICKER: [close, close, ...] } aligned to `dates`, null = no data that day.
 */
function simulateStrategy(dates, prices, calTop1, initialCapital, contribAmount, contribFrequency, applyTax) {
  const rebalanceDays = groupBoundaryDays(dates, weekKey, "last");
  const contribDays = contributionDaySet(dates, contribFrequency);
  const tax = applyTax ? createSpanishTaxTracker() : null;

  let capital = initialCapital;
  let currentTicker = null;
  let shares = 0;
  let costBasis = 0; // net amount actually invested in the current position (for gain-on-sale)
  let totalInvested = initialCapital;
  const values = new Array(dates.length);
  const tickers = new Array(dates.length);

  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    const newTicker = calTop1[i];

    // Recurring contribution (skip day 0 — already counted as initial capital).
    if (i > 0 && contribAmount > 0 && contribDays.has(date)) {
      if (currentTicker && shares > 0) {
        const p = prices[currentTicker] ? prices[currentTicker][i] : null;
        if (p != null && p > 0) {
          const invested = contribAmount * (1 - TRANSACTION_COST);
          shares += invested / p;
          costBasis += invested;
          totalInvested += contribAmount;
        } else {
          capital += contribAmount; // no valid price today, hold as cash
          totalInvested += contribAmount;
        }
      } else {
        capital += contribAmount;
        totalInvested += contribAmount;
      }
    }

    let currentPrice = null;
    if (currentTicker) {
      const p = prices[currentTicker] ? prices[currentTicker][i] : null;
      if (p != null && p > 0) currentPrice = p;
    }

    // Weekly rebalance.
    if (rebalanceDays.has(date) && newTicker !== currentTicker) {
      const newPrice = prices[newTicker] ? prices[newTicker][i] : null;
      if (newPrice != null && newPrice > 0) {
        if (currentTicker && shares > 0) {
          const sellPrice = currentPrice || newPrice;
          const proceeds = shares * sellPrice * (1 - TRANSACTION_COST);
          if (tax) {
            const gain = proceeds - costBasis;
            const owed = tax.realize(gain, date);
            capital = proceeds - owed;
          } else {
            capital = proceeds;
          }
        }
        const netCapital = capital * (1 - TRANSACTION_COST);
        shares = netCapital / newPrice;
        costBasis = netCapital;
        capital = 0;
        currentTicker = newTicker;
      }
    }

    let value;
    if (currentTicker) {
      const pToday = prices[currentTicker] ? prices[currentTicker][i] : null;
      if (pToday != null && pToday > 0) value = shares * pToday;
      else if (currentPrice) value = shares * currentPrice;
      else value = capital;
    } else {
      value = capital;
    }
    values[i] = value;
    tickers[i] = currentTicker;
  }

  return { values, tickers, totalInvested, totalTaxPaid: tax ? tax.totalTaxPaid() : 0 };
}

function simulateBenchmark(dates, benchPrices, initialCapital, contribAmount, contribFrequency) {
  const contribDays = contributionDaySet(dates, contribFrequency);
  let shares = (initialCapital * (1 - TRANSACTION_COST)) / benchPrices[0];
  let totalInvested = initialCapital;
  const values = new Array(dates.length);

  for (let i = 0; i < dates.length; i++) {
    const price = benchPrices[i];
    if (i > 0 && contribAmount > 0 && contribDays.has(dates[i]) && price != null && price > 0) {
      shares += (contribAmount * (1 - TRANSACTION_COST)) / price;
      totalInvested += contribAmount;
    }
    values[i] = shares * (price != null ? price : benchPrices[i - 1]);
  }
  return { values, totalInvested };
}

// ---- metrics ------------------------------------------------------------

function calculateMetrics(values, totalInvested) {
  const n = values.length;
  const nYears = n / 252;
  const finalValue = values[n - 1];
  const totalReturn = values[0] > 0 ? finalValue / values[0] - 1 : 0;
  const cagr = nYears > 0 && totalInvested > 0 ? Math.pow(finalValue / totalInvested, 1 / nYears) - 1 : 0;

  const returns = [];
  for (let i = 1; i < n; i++) {
    if (values[i - 1] > 0) returns.push(values[i] / values[i - 1] - 1);
  }
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / (returns.length - 1);
  const annualVol = Math.sqrt(variance) * Math.sqrt(252);

  const rfDaily = Math.pow(1.02, 1 / 252) - 1;
  const excess = returns.map((r) => r - rfDaily);
  const excessMean = excess.reduce((a, b) => a + b, 0) / excess.length;
  const excessVar = excess.reduce((a, b) => a + (b - excessMean) ** 2, 0) / (excess.length - 1);
  const sharpe = excessVar > 0 ? (excessMean / Math.sqrt(excessVar)) * Math.sqrt(252) : NaN;

  let peak = values[0];
  let maxDD = 0;
  for (const v of values) {
    if (v > peak) peak = v;
    const dd = (v - peak) / peak;
    if (dd < maxDD) maxDD = dd;
  }

  return { finalValue, totalReturn, cagr, annualVol, sharpe, maxDrawdown: maxDD };
}

function annualReturns(dates, values) {
  const lastOfYear = new Map();
  for (let i = 0; i < dates.length; i++) lastOfYear.set(dates[i].slice(0, 4), values[i]);
  const years = [...lastOfYear.keys()].sort();
  const out = {};
  for (let j = 1; j < years.length; j++) {
    const prev = lastOfYear.get(years[j - 1]);
    const cur = lastOfYear.get(years[j]);
    out[years[j]] = prev > 0 ? (cur / prev - 1) * 100 : 0;
  }
  return out;
}

// ---- formatting -----------------------------------------------------------

const fmtUSD = (x) => "$" + Math.round(x).toLocaleString("en-US");
const fmtUSDSigned = (x) => (x >= 0 ? "+" : "") + fmtUSD(x).replace("$", "$");
const fmtPct = (x) => (x >= 0 ? "+" : "") + (x * 100).toFixed(1) + "%";

// ---- UI wiring --------------------------------------------------------------

let chartInstance = null;

function sliceFromStart(dates, startDate) {
  let idx = dates.findIndex((d) => d >= startDate);
  if (idx === -1) idx = dates.length - 1;
  return idx;
}

function runSimulation(cfg) {
  const allDates = DATA.dates;
  const startIdx = sliceFromStart(allDates, cfg.startDate);
  const dates = allDates.slice(startIdx);
  if (dates.length < 20) throw new Error("El periodo elegido es demasiado corto para simular.");

  const prices = {};
  for (const t of Object.keys(DATA.prices)) prices[t] = DATA.prices[t].slice(startIdx);

  const calTop1 = buildTop1Calendar(DATA.top1Historical, dates);
  const strat = simulateStrategy(dates, prices, calTop1, cfg.initialCapital, cfg.contribAmount, cfg.contribFrequency, cfg.applyTax);

  const bench = prices[DATA.benchmarkTicker];
  const spy = simulateBenchmark(dates, bench, cfg.initialCapital, cfg.contribAmount, cfg.contribFrequency);

  const metricsStrat = calculateMetrics(strat.values, strat.totalInvested);
  const metricsSpy = calculateMetrics(spy.values, spy.totalInvested);

  return { dates, strat, spy, metricsStrat, metricsSpy };
}

function downsampleWeekly(dates, ...seriesList) {
  const rebalanceDays = groupBoundaryDays(dates, weekKey, "last");
  const idxs = [];
  for (let i = 0; i < dates.length; i++) {
    if (rebalanceDays.has(dates[i]) || i === dates.length - 1) idxs.push(i);
  }
  return {
    dates: idxs.map((i) => dates[i]),
    series: seriesList.map((s) => idxs.map((i) => s[i])),
  };
}

function tickerEraBands(dates, tickers) {
  const bands = [];
  let start = 0;
  for (let i = 1; i <= dates.length; i++) {
    if (i === dates.length || tickers[i] !== tickers[start]) {
      bands.push({ from: dates[start], to: dates[i - 1], ticker: tickers[start] });
      start = i;
    }
  }
  return bands;
}

const TICKER_COLORS = {
  IBM: "#1f77b4",
  GE: "#9467bd",
  XOM: "#e05e00",
  AAPL: "#a8b8c8",
  MSFT: "#00a4ef",
  NVDA: "#76b900",
};

function eraBandPlugin(bands, allDates) {
  return {
    id: "eraBands",
    beforeDatasetsDraw(chart) {
      const { ctx, chartArea, scales } = chart;
      if (!chartArea) return;
      ctx.save();
      for (const band of bands) {
        const xFrom = scales.x.getPixelForValue(band.from);
        const xTo = scales.x.getPixelForValue(band.to);
        ctx.fillStyle = (TICKER_COLORS[band.ticker] || "#888888") + "22";
        ctx.fillRect(xFrom, chartArea.top, Math.max(xTo - xFrom, 1), chartArea.bottom - chartArea.top);
      }
      ctx.restore();
    },
  };
}

function renderChart(dates, stratValues, spyValues, investedValues, tickers) {
  const ds = downsampleWeekly(dates, stratValues, spyValues, investedValues);
  const dsTickers = downsampleWeekly(dates, tickers).series[0];
  const bands = tickerEraBands(ds.dates, dsTickers);

  const ctx = document.getElementById("value-chart").getContext("2d");
  if (chartInstance) chartInstance.destroy();

  chartInstance = new Chart(ctx, {
    type: "line",
    data: {
      labels: ds.dates,
      datasets: [
        {
          label: "Estrategia Top-1",
          data: ds.series[0],
          borderColor: "#00d4aa",
          backgroundColor: "#00d4aa22",
          fill: true,
          borderWidth: 2.4,
          pointRadius: 0,
          tension: 0.15,
        },
        {
          label: "S&P 500 completo (SPY)",
          data: ds.series[1],
          borderColor: "#6366f1",
          backgroundColor: "#6366f100",
          fill: false,
          borderWidth: 1.8,
          pointRadius: 0,
          tension: 0.15,
        },
        {
          label: "Dinero aportado",
          data: ds.series[2],
          borderColor: "#8a90a3",
          borderDash: [4, 3],
          fill: false,
          borderWidth: 1.2,
          pointRadius: 0,
          tension: 0,
        },
      ],
    },
    plugins: [eraBandPlugin(bands, ds.dates)],
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: "index", intersect: false },
      scales: {
        x: {
          ticks: { color: "#8a90a3", maxTicksLimit: 8 },
          grid: { color: "#1e2230" },
        },
        y: {
          ticks: {
            color: "#8a90a3",
            callback: (v) => "$" + Number(v).toLocaleString("en-US"),
          },
          grid: { color: "#1e2230" },
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (item) => `${item.dataset.label}: ${fmtUSD(item.parsed.y)}`,
          },
        },
      },
    },
  });
}

function investedSeries(dates, initialCapital, contribAmount, contribFrequency) {
  const contribDays = contributionDaySet(dates, contribFrequency);
  const out = new Array(dates.length);
  let total = initialCapital;
  for (let i = 0; i < dates.length; i++) {
    if (i > 0 && contribAmount > 0 && contribDays.has(dates[i])) total += contribAmount;
    out[i] = total;
  }
  return out;
}

function cardRow(label, valStrat, valSpy, tagStrat, tagSpy) {
  return `<div class="card">
    <div class="label">${label}</div>
    <div class="row"><span class="tag" style="color:var(--accent1)">${tagStrat || "Top-1"}</span><span class="val top1">${valStrat}</span></div>
    <div class="row"><span class="tag" style="color:var(--accent2)">${tagSpy || "SPY"}</span><span class="val spy">${valSpy}</span></div>
  </div>`;
}

function renderResults(result, cfg) {
  const { dates, strat, spy, metricsStrat, metricsSpy } = result;
  const invested = investedSeries(dates, cfg.initialCapital, cfg.contribAmount, cfg.contribFrequency);

  renderChart(dates, strat.values, spy.values, invested, strat.tickers);

  const gainStrat = metricsStrat.finalValue - strat.totalInvested;
  const gainSpy = metricsSpy.finalValue - spy.totalInvested;

  const cards = [
    cardRow("Dinero invertido", fmtUSD(strat.totalInvested), fmtUSD(spy.totalInvested)),
    cardRow(cfg.applyTax ? "Valor final (neto de impuestos)" : "Valor final", fmtUSD(metricsStrat.finalValue), fmtUSD(metricsSpy.finalValue)),
    cardRow("Ganancia neta", fmtUSDSigned(gainStrat), fmtUSDSigned(gainSpy)),
    cardRow("Rendimiento anual medio (CAGR)", fmtPct(metricsStrat.cagr), fmtPct(metricsSpy.cagr)),
    cardRow("Mayor caída temporal", fmtPct(metricsStrat.maxDrawdown), fmtPct(metricsSpy.maxDrawdown)),
    cardRow("Volatilidad anual", fmtPct(metricsStrat.annualVol), fmtPct(metricsSpy.annualVol)),
  ];
  if (cfg.applyTax) {
    cards.push(`<div class="card">
      <div class="label">Impuestos pagados (IRPF, plusvalías)</div>
      <div class="row"><span class="tag" style="color:var(--accent1)">Top-1</span><span class="val top1">${fmtUSD(strat.totalTaxPaid)}</span></div>
      <div class="row"><span class="tag" style="color:var(--accent2)">SPY</span><span class="val spy">$0 (nunca vende)</span></div>
    </div>`);
  }
  document.getElementById("summary-cards").innerHTML = cards.join("");

  const rs = annualReturns(dates, strat.values);
  const rb = annualReturns(dates, spy.values);
  const years = Object.keys(rs).sort();
  const tbody = years
    .map((y) => {
      const vs = rs[y];
      const vb = rb[y] ?? 0;
      return `<tr>
        <td>${y}</td>
        <td class="${vs >= 0 ? "pos" : "neg"}">${vs >= 0 ? "+" : ""}${vs.toFixed(1)}%</td>
        <td class="${vb >= 0 ? "pos" : "neg"}">${vb >= 0 ? "+" : ""}${vb.toFixed(1)}%</td>
      </tr>`;
    })
    .join("");
  document.getElementById("annual-tbody").innerHTML = tbody;

  const eras = tickerEraBands(dates, strat.tickers).filter((b) => b.ticker);
  document.getElementById("era-legend").innerHTML = eras
    .map(
      (b) =>
        `<span><span class="swatch" style="background:${TICKER_COLORS[b.ticker] || "#888"}"></span>${b.ticker} (${b.from} → ${b.to})</span>`
    )
    .join("");

  document.getElementById("results").classList.add("visible");
}

function setStartDateFromPreset() {
  const preset = document.getElementById("period-preset").value;
  const customField = document.getElementById("custom-date-field");
  if (preset === "custom") {
    customField.classList.add("visible");
    return null;
  }
  customField.classList.remove("visible");
  if (preset === "all") return DATA.dates[0];
  const years = parseInt(preset, 10);
  const today = new Date(DATA.dates[DATA.dates.length - 1]);
  today.setUTCFullYear(today.getUTCFullYear() - years);
  return today.toISOString().slice(0, 10);
}

function readConfig() {
  const initialCapital = parseFloat(document.getElementById("initial-capital").value.replace(/,/g, ""));
  const contribAmount = parseFloat(document.getElementById("contrib-amount").value.replace(/,/g, "")) || 0;
  const contribFrequency = document.getElementById("contrib-frequency").value;
  const preset = document.getElementById("period-preset").value;
  const applyTax = document.getElementById("apply-tax").checked;
  let startDate;
  if (preset === "custom") {
    startDate = document.getElementById("custom-date").value;
    if (!startDate) throw new Error("Elige una fecha de inicio.");
  } else {
    startDate = setStartDateFromPreset();
  }
  if (!(initialCapital > 0)) throw new Error("El capital inicial debe ser mayor que 0.");
  if (contribAmount < 0) throw new Error("La aportación no puede ser negativa.");
  if (startDate < DATA.dates[0]) startDate = DATA.dates[0];
  return { initialCapital, contribAmount, contribFrequency, startDate, applyTax };
}

function showError(msg) {
  const box = document.getElementById("error-box");
  box.textContent = msg;
  box.style.display = "block";
}
function hideError() {
  document.getElementById("error-box").style.display = "none";
}

async function init() {
  const minDateEl = document.getElementById("custom-date");
  const statusLine = document.getElementById("status-line");
  try {
    DATA = await loadData();
    minDateEl.min = DATA.dates[0];
    minDateEl.max = DATA.dates[DATA.dates.length - 1];
    minDateEl.value = "2015-01-01";
    const genDate = new Date(DATA.generatedAt).toLocaleDateString("es-ES");
    statusLine.textContent = `Datos hasta ${DATA.dates[DATA.dates.length - 1]} (actualizados ${genDate})`;
    document.getElementById("calc-btn").disabled = false;
  } catch (e) {
    showError("No se pudieron cargar los datos históricos: " + e.message);
    return;
  }

  document.getElementById("period-preset").addEventListener("change", setStartDateFromPreset);
  setStartDateFromPreset();

  document.getElementById("calc-form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    hideError();
    try {
      const cfg = readConfig();
      const result = runSimulation(cfg);
      renderResults(result, cfg);
    } catch (e) {
      showError(e.message);
    }
  });

  // Auto-run once with sensible defaults so the page shows something immediately.
  try {
    const cfg = readConfig();
    renderResults(runSimulation(cfg), cfg);
  } catch (e) {
    /* ignore — user can still hit "Calcular" manually */
  }
}

document.addEventListener("DOMContentLoaded", init);
