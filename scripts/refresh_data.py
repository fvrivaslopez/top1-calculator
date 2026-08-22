"""
Refreshes data/top1_history.json — daily close prices (since 1985) for every
ticker that has ever been the S&P 500's #1 by market cap, plus SPY as the
passive benchmark. The calculator page (index.html) does all the simulation
math client-side against this file, so it never needs a live backend.

Run manually:
    python scripts/refresh_data.py

Run automatically: .github/workflows/refresh-data.yml runs this weekly and
commits the result if it changed.

The "who was #1 and when" table below is copied from the live bot's
backtest.py (../top1_live_bot/backtest.py, TOP1_HISTORICAL) — same
approximation, same source of truth. If that table gains a new entry there
(e.g. a new company overtakes #1), copy the new row here too.
"""

import json
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd
import yfinance as yf

BASE_DIR = Path(__file__).resolve().parent.parent
OUTPUT_PATH = BASE_DIR / "data" / "top1_history.json"

TOP1_HISTORICAL = [
    ("1985-01-01", "IBM", "IBM"),
    ("1990-01-01", "XOM", "ExxonMobil"),
    ("1993-01-01", "GE", "General Electric"),
    ("1996-01-01", "XOM", "ExxonMobil"),
    ("1997-01-01", "GE", "General Electric"),
    ("1999-01-01", "MSFT", "Microsoft"),
    ("2000-01-01", "GE", "General Electric"),
    ("2002-01-01", "XOM", "ExxonMobil"),
    ("2005-01-01", "GE", "General Electric"),
    ("2006-01-01", "XOM", "ExxonMobil"),
    ("2011-10-01", "AAPL", "Apple"),
    ("2012-08-01", "XOM", "ExxonMobil"),
    ("2012-09-01", "AAPL", "Apple"),
    ("2019-01-01", "MSFT", "Microsoft"),
    ("2019-07-01", "AAPL", "Apple"),
    ("2021-11-01", "MSFT", "Microsoft"),
    ("2022-01-01", "AAPL", "Apple"),
    ("2024-01-01", "MSFT", "Microsoft"),
    ("2024-07-01", "AAPL", "Apple"),
    ("2024-10-01", "NVDA", "NVIDIA"),
    ("2025-01-01", "AAPL", "Apple"),
]

BENCHMARK_TICKER = "SPY"
START_DATE = "1985-01-01"


def main():
    tickers = list(dict.fromkeys(row[1] for row in TOP1_HISTORICAL)) + [BENCHMARK_TICKER]
    end_date = datetime.today().strftime("%Y-%m-%d")

    print(f"Downloading daily closes for {tickers} from {START_DATE} to {end_date}...")
    raw = yf.download(tickers, start=START_DATE, end=end_date, auto_adjust=True, progress=False)["Close"]
    if isinstance(raw, pd.Series):
        raw = raw.to_frame(name=tickers[0])
    raw = raw.dropna(how="all")

    dates = [d.strftime("%Y-%m-%d") for d in raw.index]
    prices = {}
    for ticker in tickers:
        if ticker not in raw.columns:
            print(f"  WARNING: no data returned for {ticker}, skipping.")
            continue
        # NaN -> null; the client fills gaps by holding the last known price.
        prices[ticker] = [None if pd.isna(v) else round(float(v), 4) for v in raw[ticker]]

    payload = {
        "generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "benchmarkTicker": BENCHMARK_TICKER,
        "top1Historical": [{"date": d, "ticker": t, "name": n} for d, t, n in TOP1_HISTORICAL],
        "dates": dates,
        "prices": prices,
    }

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(payload, indent=None, separators=(",", ":")), encoding="utf-8")
    print(f"Wrote {OUTPUT_PATH} ({len(dates)} trading days, {len(prices)} tickers).")


if __name__ == "__main__":
    main()
