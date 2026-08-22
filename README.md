# Top-1 Calculator

A static, self-contained calculator (no backend) for testing the "Top-1 of
the S&P 500" strategy from [`top1_live_bot`](../top1_live_bot) — same
sibling folder, separate deployable project — before trusting it with real
money.

Enter an initial investment, a recurring contribution (weekly/monthly/yearly),
and a time period, and it simulates: every week, all capital sits in
whichever company currently has the largest market cap in the S&P 500; if
the leader changes, the old position is sold and the new one bought with
everything. Shows the result against buy-and-hold SPY, with a chart, summary
cards, and a year-by-year returns table.

**Live at:** https://fvrivaslopez.github.io/top1-calculator/

## How it works

- `data/top1_history.json` holds daily close prices (since 1985) for every
  ticker that's ever been #1, plus SPY. `scripts/refresh_data.py` (Python +
  yfinance) regenerates it; `.github/workflows/refresh-data.yml` runs that
  weekly and commits the result, so the site stays current without any
  server running 24/7.
- `app.js` does the actual simulation **in the browser**, against that JSON
  file — a client-side port of `top1_live_bot/backtest.py`'s
  `simulate_strategy()` / `simulate_spy()` / `calculate_metrics()`,
  generalized to weekly/monthly/yearly contributions (the Python version
  only supported monthly). Verified against the Python engine directly: same
  inputs (\$10,000 initial, \$500/month, 15 years) produce identical output
  to the dollar (\$883,583 vs \$395,143 final value, 15.7% vs 9.6% CAGR).
- **Spanish capital-gains tax** (checkbox, on by default): every time the
  strategy switches leaders, that's a full sale of the old position, and the
  realized gain is taxed under Spain's 2026 *base imponible del ahorro*
  scale (19% / 21% / 23% / 27% / 30%, nationwide, no regional variation) —
  the tax is deducted before the proceeds get reinvested in the new leader.
  A calendar year that closes with a net loss becomes a carryforward that
  can offset gains in the following 4 years ("compensación de pérdidas
  patrimoniales"), applied automatically. SPY never sells in this
  simulation, so it never realizes a gain and accrues zero tax — that gap is
  the actual point of the toggle: it's what "worth switching even after
  taxes" costs in practice. Implemented in `createSpanishTaxTracker()` in
  `app.js`, unit-verified against hand-computed bracket/carryforward math
  and a small synthetic 2-trade scenario before being trusted against the
  real 40-year dataset.
  **Known simplifications:** bracket thresholds are EUR amounts applied
  directly to USD figures (no FX conversion — this calculator has no
  currency conversion anywhere); dividends aren't taxed separately since
  the price data already folds them into price appreciation
  (`auto_adjust=True`); tax is deducted at the moment of each sale rather
  than literally on the following year's filing date, which changes *when*
  the cash leaves but not the total owed for a closed year.
- The "who was #1 and when" table (`TOP1_HISTORICAL` in both
  `scripts/refresh_data.py` and `app.js`) is copied from
  `backtest.py` — same approximation, same source of truth. If that table
  gains a new entry there, copy the new row to both places here.
- No build step. `index.html` + `styles.css` + `app.js`, Chart.js loaded
  from a CDN. Hosted on GitHub Pages (free, no server, works identically
  on desktop and mobile browsers).

## Local development

```
python -m http.server 8000
```

then open `http://localhost:8000` — the calculator fetches
`data/top1_history.json` over HTTP, so opening `index.html` directly via
`file://` won't work (browsers block that fetch).

To pull fresh prices locally instead of waiting for the weekly Action:

```
pip install yfinance pandas
python scripts/refresh_data.py
```

## Deploying

Pushes to `main` publish automatically via GitHub Pages (Settings → Pages →
source: `main` / root — already configured on this repo). No separate build
or deploy step.

## Scope note

This is the *testing* layer only — a way to sanity-check the strategy and
see how it would have performed, matching the "not now, later" framing the
live-trading side was built under. It does not read from or write to the
live bot's Alpaca account, database, or `.env` — those stay entirely in
`top1_live_bot`, untouched by this project.
