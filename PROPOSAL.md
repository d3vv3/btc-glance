# BTCPP: Bitcoin forecasts people can understand and verify

Status: exploration; no product direction selected yet.  
Research date: October 1, 2026.

## Challenge

> Build a Bitcoin price forecast people can trust, using Glimpse prediction market data. Use the Glimpse API or the glimpse-markets Python package to make a visualization, app, bot, or alert that turns market probabilities into a forecast anyone can read.

The opportunity is to translate market prices into understandable uncertainty, make the evidence inspectable, and record forecasts before outcomes are known. A game could make that experience accessible and give users a reason to return.

## What we verified about Glimpse

Documentation, Python package metadata, and public HTTP endpoints were inspected during the initial research. Streaming and SDK capabilities below are documented capabilities, not integrations we have tested ourselves.

| Capability | Finding | Product use |
| --- | --- | --- |
| Public market data | Batch, active-market, quote, and resolved-market requests worked without an API key | Start a read-only prototype immediately |
| Hourly Bitcoin markets | Active feed reported 168 markets; sampled market used 500 buckets of $200, spanning $25,000-$125,000 | Near-term forecasts and recurring game rounds |
| Daily Bitcoin markets | Active feed reported 159 markets; sampled market used 500 buckets of $1,000, spanning $0-$500,000 | Daily outlooks and forecasts across dates |
| Outcome quotes | YES/NO prices, outcome IDs, range labels, and share counts | Build and inspect market-implied distributions |
| Activity and liquidity | Lifetime and 24-hour volume, locked liquidity, and subsidy fields | Show the evidence supporting a forecast |
| Resolved markets | Winning outcome IDs; daily feed reported 62 resolved markets | Evaluate forecasts captured before resolution |
| Python package | `glimpse-markets` 0.2.0, Python 3.10+, sync/async clients | Data collection and backend integration |
| Live stream | SDK documents a public WebSocket feed | Live charts, recording, and alerts |
| Forecast helpers | SDK documents `MarketRecorder`, probability helpers, and optional TimesFM integration | Collect history and optionally compare independent models |

Counts and quotes are observations from research, not permanent API guarantees. Market availability does not establish useful liquidity at every horizon.

### Example observed snapshot

Daily market `7134`, ending October 2, 2026 at 00:00 UTC, returned the following leading buckets:

| Closing-price bucket | Quoted YES price on the 0-100 scale |
| --- | ---: |
| $81,000-$82,000 | 8 |
| $82,000-$83,000 | 14 |
| $83,000-$84,000 | 21 |
| $84,000-$85,000 | 29 |
| $85,000-$86,000 | 21 |
| $86,000-$87,000 | 3 |

These selected rows do not show all outcomes. The full market's YES quotes summed to 100. Subject to validating quote semantics, a readable interpretation would be:

> The market favors a Bitcoin close between $84,000 and $85,000. Approximately 71% of the quoted probability sits between $83,000 and $86,000.

This is an illustrative interpretation of an observed snapshot, not a current forecast or evidence of accuracy. No exact retrieval time was retained for this example, so it should not be used as a scored historical forecast.

### Integration findings and unresolved semantics

- Base URL: `https://main.bpmapi.io`.
- Daily Bitcoin batch: `4eb65bd2-5f0f-4071-b8b0-4a8127848d1d`.
- Hourly Bitcoin batch: `c6dd0be7-b9b8-4a8a-b735-623660c38982`.
- Discover markets through `/api/v1/nmarket/batches` and `/api/v1/nmarket/v2/batches/{batch_id}/active-markets`.
- Fetch pricing through `/api/v1/nmarket/markets/{topic_id}/quotes` and results through `/api/v1/nmarket/v2/batches/{batch_id}/resolved-markets`.
- The documented `page`/`page_size` query parameters did not control page size in our tests. `limit`/`offset` worked.
- The hourly batch metadata's end time was earlier than the end times of individual active markets returned. Validate individual market timestamps and flags rather than relying solely on batch metadata.
- The sampled daily YES quotes summed to 100; hourly market `4278` summed to 98, and its YES/NO pairs also summed to 98. Confirm pricing, rounding, fees or other adjustments, and settlement units before interpreting quotes as probabilities. The cause of the difference is not established.
- The sampled millisat quote fields did not add precision beyond the whole-unit YES prices. Do not assume those fields recover rounded-away probabilities.
- The SDK says no historical/candle endpoint is currently available. Resolved outcomes cannot reconstruct historical forecasts. Begin recording early.
- The SDK says quote updates are event-driven and that there is no separate market-resolved stream event. Poll for resolution and handle reconnects and stale data.
- The SDK describes client throttling for a 60-requests-per-60-seconds-per-key limit. Confirm applicable public-access limits; use caching and backoff.
- Confirm the settlement price source, bucket boundary rules, and treatment of prices outside the offered range.

## Product options

| Concept | Experience | Strength | Relative effort |
| --- | --- | --- | --- |
| Bitcoin Weather | Select a closing time and see favored ranges, upside/downside odds, and a short explanation | Most accessible interpretation of the challenge | Medium |
| What Are the Odds? | Move a threshold or range slider to explore closing-price probabilities | Interactive and easy to demonstrate | Low-medium |
| Probability-shift alerts | Receive notifications when market-implied odds change materially | Recurring utility | Medium |
| Forecast report card | Inspect forecasts recorded before close and their eventual results | Direct evidence for trust | Medium, plus collection time |
| Crowd vs. model | Compare Glimpse with an independent statistical forecast | Technical depth and visible disagreement | High |

### Bitcoin Weather

The leading non-game concept combines a readable forecast, an interactive distribution, and a public forecast history.

Core screen:

1. Exact closing time and market identity.
2. Most favored bucket and a broader probability range.
3. Interactive histogram with selectable contiguous buckets.
4. Above, below, and between threshold questions.
5. Retrieval time, activity, liquidity, and data-quality context.
6. Previously recorded forecasts and outcomes.

Initially snap controls to bucket boundaries. Estimates inside buckets require an explicit assumption about the distribution within each bucket. Display distinct closing-time distributions without implying that they establish the probability of an entire future price path.

### Probability-shift alerts

Example message: "The market-implied chance of closing below $82,000 rose from 15% to 28%." These figures are illustrative.

Compare the same target market across snapshots. Add minimum change thresholds, cooldowns, and stale-data checks. Every notification should retain the closing time and link to the supporting forecast.

### Crowd vs. model

The SDK offers an optional TimesFM forecasting integration. An independent model would need underlying BTC price history, aligned horizons, and its own evaluation. Forecasting a prediction-market quote series is a different task from forecasting Bitcoin's settlement price.

This is a possible extension, with more modeling and data-source assumptions than the initial market-based product needs.

## Game concepts

A game should help players understand probabilities and preserve a visible Bitcoin forecast. Competitive scoring should reward honest uncertainty and use the same rules for players and the market benchmark.

| Game | Player action | Glimpse's role | Appeal |
| --- | --- | --- | --- |
| Beat the Market | Allocate probabilities across closing-price ranges | Submit a benchmark distribution for the same close | Compete against the crowd |
| Forecast Golf | Choose an interval, balancing width against the cost of a miss | Show market probability inside the selected interval | Simple visual daily challenge |
| 100 Futures | Distribute 100 tokens across possible closing-price ranges | Reveal a comparable market distribution | Makes probability tangible |
| Probability Detective | Answer questions about a market snapshot and its uncertainty | Supply the evidence and eventual outcome | Learn to read forecasts |
| Forecast League | Join recurring prediction rounds with friends | Appear as a benchmark in the league | Social retention |
| Crowd Shift | Predict how market odds will change over the next hour | Quote changes determine the outcome | Faster play; less direct focus on BTC's closing price |

## Leading game proposal: 100 Futures

Pitch: **Can you forecast Bitcoin better than the market?**

Prompt:

> Imagine 100 possible versions of tomorrow. How many end with Bitcoin in each range?

Players allocate 100 tokens across approximately five to seven readable ranges. These aggregate the underlying market buckets, with outer groups retaining all offered outcomes. Handling prices outside the market's offered support depends on confirmed settlement rules.

### Round flow

1. Select a specific market close and a defined submission window.
2. Allocate 100 tokens, producing a probability distribution.
3. Lock the forecast and save the contemporaneous Glimpse quote snapshot, grouping boundaries, and transformation version.
4. Reveal player and market distributions side by side.
5. Explore disagreements through the original buckets and source information.
6. Resolve using Glimpse's winning outcome and score both distributions identically.
7. Update personal history and, optionally, a league table.

Illustrative reveal: "You assigned 40% above $85,000. The market assigned 24%."

Competitive mode can reveal Glimpse after submission to reduce copying within the app. Public market data remains accessible elsewhere, so this does not establish a controlled test of independent forecasting skill. Practice mode can show the market immediately.

### Scoring and fairness

Use a multiclass Brier score for the complete grouped distribution:

`Brier = sum((p_i - y_i)^2)`

Here `p_i` is the assigned probability and `y_i` is 1 for the winning group and 0 otherwise. Lower is better. For this unnormalized multiclass convention, a possible display transformation is `points = 100 * (1 - Brier / 2)`.

Use identical groups, scoring, and comparable snapshot times for the player and market. Keep raw probabilities and scores available for audit. Avoid ranking forecasts made at very different lead times as though they were equivalent.

Emphasize performance over many rounds, disclose completed-round counts, and avoid calling a single win evidence of skill. Explain results using the whole score; assigning more probability to the winning group alone does not always imply a better multiclass Brier score.

### Why it fits

The game attracts participation, the distribution explorer explains the forecast, and the recorded results allow users to evaluate performance. The core forecast remains useful to visitors who do not play.

## Simpler game: Forecast Golf

Players drag two handles to choose a closing-price interval. The interface reports its market-implied probability and explains the tradeoff between a narrow interval and a missed result.

Example: "Your interval covers $82,000-$86,000. The market assigns approximately 79% inside it." These numbers are illustrative.

Choose a fixed target coverage, such as 80%, and use a standard interval score that penalizes both width and misses. Lower scores are better. This rewards useful intervals rather than arbitrary tight guesses.

Implementation constraint: Glimpse's resolved feed identifies the winning bucket, which may not provide the exact settlement price needed for distance-based interval penalties. Confirm access to that price before choosing standard interval scoring. A bucket-based alternative would need explicit, separately documented rules.

Forecast Golf is a strong mobile-friendly alternative or later quick-play mode. Building it alongside 100 Futures is optional, not an initial requirement.

## Immediate play and replay

Hourly markets provide recurring rounds, but a demonstration should show the entire experience without waiting for a close.

- Live rounds use current markets and real resolutions.
- Replay rounds use snapshots genuinely captured before resolution.
- A clearly labeled tutorial can use illustrative data until enough history exists.

Do not manufacture a historical forecast from a resolved outcome or present a tutorial as a live result. Start the recorder before investing heavily in the interface.

## Trust and evaluation requirements

1. **Validate probability conversion.** Check nonnegative values, outcome coverage, quote totals, and engine semantics. If normalization is justified, disclose it and preserve the raw values. Reject or visibly degrade inconsistent inputs. A quoted zero need not mean an impossible event.
2. **Keep provenance.** Store market ID, closing time, retrieval time, raw quotes, derived probabilities, and transformation version. Distinguish data retrieval time from the age of the latest market activity.
3. **Preserve forecast meaning.** Closing above a threshold is different from touching it at any time before close. Keep exact timestamps and settlement conditions visible.
4. **Separate activity from accuracy.** Show volume, liquidity, and subsidies without inventing a numeric trust score. Narrow distributions do not establish reliable forecasts.
5. **Evaluate prospectively.** Freeze forecasts at predefined lead times. Score all eligible recorded forecasts, retaining failures and misses. Do not use post-resolution information to reconstruct predictions.
6. **Use complementary metrics.** Report Brier scores for aligned outcomes, range coverage, and range width. Show sample counts and evaluation periods. Calibration claims require enough observations and appropriate grouping by horizon.
7. **Explain assumptions.** Disclose bin aggregation, any within-bin interpolation, normalization, and boundary handling. Do not promise precision the data does not provide.
8. **Handle unavailable data visibly.** Mark stale quotes, unresolved markets, and missing results. Avoid silently displaying old data as a fresh forecast.

## Implementation options

### Fast prototype

- Python and `glimpse-markets` for collection and API access.
- Streamlit and Plotly for exploration and a playable proof of concept.
- SQLite for raw snapshots, player forecasts, and results.
- A persistent collector plus resolution polling.
- Deterministic forecast templates with every number traceable to stored data.

### Polished submission

- React frontend for charts and token-allocation interaction.
- Python API and background collector.
- SQLite initially; a server database if concurrent multiplayer requires it.
- Shared validation and scoring logic across live forecasts, games, and replays.
- Optional notification delivery after the core forecast and history work.

Suggested core records: market metadata, timestamped quote snapshots, derived forecast versions, round definitions, locked player forecasts, resolutions, and scores.

## Proposed sequence

1. Confirm quote-to-probability semantics and settlement rules; validate live response shapes.
2. Record hourly and daily snapshots, carrying selected markets through resolution.
3. Build a distribution explorer with exact closing times and provenance.
4. Choose Bitcoin Weather, 100 Futures, or Forecast Golf as the primary experience.
5. Add prospective scoring and history using recorded data.
6. Prepare a complete demo with live data and clearly identified recorded replays or tutorials.
7. Add leagues, alerts, or model comparisons only if time permits.

## Decisions still open

- Challenge deadline, judging criteria, and expected deployment format.
- Casual daily puzzle versus competitive game with friends.
- Visual app versus recurring alert utility.
- Primary game mechanic: token allocation or interval selection.
- Available time for collecting a credible prospective track record.
- Verified probability conversion, settlement source, and API limits.

Current recommendation: explore **100 Futures** as the leading game direction, using the same distribution explorer and forecast history proposed for **Bitcoin Weather**. Final scope has not been selected.

## Sources

- [Glimpse introduction](https://docs.glimpse.markets/index)
- [Documentation index for LLMs](https://docs.glimpse.markets/llms.txt)
- [API introduction](https://docs.glimpse.markets/api-reference/introduction)
- [Market quotes](https://docs.glimpse.markets/api-reference/nmarket/market-quotes)
- [Active markets](https://docs.glimpse.markets/api-reference/nmarket/active-markets-v2)
- [Resolved markets](https://docs.glimpse.markets/api-reference/nmarket/resolved-markets-v2)
- [Market statistics](https://docs.glimpse.markets/api-reference/nmarket/market-stats)
- [Python package](https://pypi.org/project/glimpse-markets/)
- [Package metadata and README](https://pypi.org/pypi/glimpse-markets/json)
- [Live batches endpoint](https://main.bpmapi.io/api/v1/nmarket/batches)
