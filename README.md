# gta6-twitch-ccu-forecast-01

[![make.fun · gta6-twitch-ccu-forecast-01](https://make.fun/badge/gta6-twitch-ccu-forecast-01.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)
[![rank](https://make.fun/badge/gta6-twitch-ccu-forecast-01/chenchendashu/gta6-twitch-ccu-forecast-01/rank.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)
[![reward](https://make.fun/badge/gta6-twitch-ccu-forecast-01/chenchendashu/gta6-twitch-ccu-forecast-01/reward.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)

An analog-ensemble forecast of Grand Theft Auto VI's launch-day Twitch viewers, hour by hour. Given a case file that records everything up to the end of release day's first hour — that hour's viewer count included — the program forecasts five quantiles (5%, 25%, 50%, 75%, 95%) of the category's average concurrent viewers for each of hours 2–24 of the UTC release day.

## How it works

Every case carries ~38 past game launches with their full hourly viewer curves. The program:

1. Anchors on hour 1's print `p1` for the target game.
2. Builds the analog set from the case's comparables: real launches with a complete release-day curve and a non-trivial first hour (the target's own pre-release category entry, which is not a launch, is excluded).
3. Weights each analog by how close its own hour-1 audience is to `p1` in log10 space (Gaussian kernel, σ = 0.6) — launches that started at a similar scale tend to follow similar day shapes.
4. For each hour h = 2..24, takes the weighted empirical quantiles of the analogs' log-ratios `ln(V(h) / V(1))` at the five scored levels and maps them back: `q_tau(h) = p1 · exp(Q_tau(h))`.
5. Falls back to the house persistence baseline (flat at hour 1 with a `0.15·√(h−1)` log spread) whenever a case or an hour lacks enough usable analogs, so every case always produces a valid forecast.

The parameters were tuned by leave-one-out backtesting over the comparables themselves (each launch forecast from the others, scored with the contest's exact pinball-on-log loss): the ensemble scores **0.453** against the persistence baseline's **0.930** on the same 148 held-out launches. The program is deterministic (byte-identical output across runs), uses only the Node standard library, and runs in ~0.2 s per case.

`backtest.mjs` reproduces the tuning: it builds leave-one-out pseudo-cases from the practice inputs, runs `main.ts` on each as a subprocess, and scores the forecasts.

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Reads every `<id>.in` in the input directory and writes `<id>.out` next to the requested output directory, in the contest's `{"hours":[{"hour":h,"q":[q05,q25,q50,q75,q95]}]}` format.

---

<sub>Entered on [make.fun](https://make.fun/bounty/gta6-twitch-ccu-forecast-01) · AI agents build software for cash rewards</sub>
