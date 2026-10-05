# Repository Guidelines

## Project Overview
DRADIS is a low-latency Rust trading engine for binary prediction markets: Polymarket International CLOB (self-custody), Polymarket US (custodial), and Kalshi. The engine runs strategies on a 50 ms tick and places **real-money orders**. It also serves an axum REST API that the Next.js **Control Tower** UI (`control-tower/`) and the read-only integrations (`integrations/mcp`, `integrations/openclaw`) consume. Licensed AGPL-3.0, with a commercial dual license sold as an AWS Marketplace AMI.

The code uses Battlestar Galactica names:
| Term | Meaning | Location |
|---|---|---|
| **Raptor** | Data scout (Binance price/funding/derivatives, Alpaca Tide/Horizon, Odds API sports, tennis). Fetches, normalizes, and broadcasts on `watch` channels. Contains no trading logic. | `src/raptors/` |
| **Viper** | Strategy that implements the `Strategy` trait | `src/vipers/*_impl.rs` |
| **Squadron** | One market plus its raptors and enabled vipers. Runs the `patrol()` tick loop. Lifecycle is STAGED → PATROLLING → RTB. | `src/squadron/` |
| **CAG** | Carrier Air Group: coordinator over all squadrons and per-asset loops, and owner of `SessionState` | `src/cag/` |
| **Ghost mode** | Paper trading: orders are simulated and no collateral moves | `helpers/dynamic_config.rs` (`ghosting_now()`), `helpers/ghost_quotes.rs` |
| **Helm** | Operator/LLM trading intents | `helpers/helm.rs`, `vipers/helm_impl.rs`, `api/helm.rs` |

## Architecture & Data Flow
```
Raptors (WS/REST) ──watch──┐
Venue WS orderbook → LocalBook/PriceState ─┴→ StrategyContext
  → orchestrator::executor (all vipers concurrently: tokio::join!(entry, exit) under tokio::time::timeout)
  → StrategySignal {Entry|Exit|MakerQuote|MakerCancel|NoSignal} carrying full OrderParams
  → gates (drawdown, OBI, liquidity, re-entry suppression) → squadron/patrol_tasks spawn orders
  → venue impl → fills → venues/lifecycle.rs reconciliation → SessionState + SQLite (helpers/db.rs)
  → api/server.rs (:9000 /api/*) → Control Tower / MCP / OpenClaw
```
- **Startup** (`src/main.rs`): env parsing (`ASSETS`, `CRYPTO_FILTER`, `TOKIO_WORKER_THREADS`) → tokio runtime → OS-thread watchdog → tracing with an ET timezone formatter → secrets and staged migration (`helpers/migration.rs`, which also checks the retired flag) → one `cag::run::run_market_loop` per asset. The `--build-venue` flag prints the compiled venue and exits.
- **Venue abstraction:** venue-neutral types live in `src/venues/core.rs` (`MarketId`, `OrderId`, `TimeInForce`, `OrderIntent`, `Fill`, `TokenResolution`). Order state is reconciled in `venues/lifecycle.rs`. SDK specifics (U256, nonces, signers, HMAC) stay private inside `venues/{intl,us,kalshi}/`. **Exactly one venue is compiled per build.**
- **Config has two layers:**
  - Compile-time constants in `src/config.rs`. This file is gitignored and copied from `src/config.{conservative,balanced,aggressive}.rs.example`.
  - Runtime `DynamicConfig` in `helpers/dynamic_config.rs`. It is broadcast over a `watch` channel, can be patched through `PATCH /api/config` or per-squadron, and its schema for the UI lives in `api/config_schema.rs`.
  - `src/profiles.json` is **generated** (embedded via `include_str!`). Do not edit it by hand.
- **Persistence:** one SQLite DB per asset/shard (`logs/<asset>-dradis.db`) via sqlx. Trades and positions carry a `ghost` flag. Ghost rows are garbage-collected on restart.
- **Safety nets:**
  - `helpers/watchdog.rs` is an OS thread outside tokio. It calls `process::exit(1)` after 300 s without a heartbeat, and the supervisor or Docker restarts the engine.
  - The per-strategy eval timeout skips a hung viper for that tick.
  - The `DRADIS_READ_ONLY=true` middleware rejects all non-GET requests.

## Key Directories
| Path | Purpose |
|---|---|
| `src/orchestrator/` | `strategy.rs` (trait, `StrategyContext`, shared gates), `executor.rs` (parallel eval), `registry.rs` (strategy registry; the single source of truth) |
| `src/vipers/` | Strategy implementations. `gboost_planb*` is the ML strategy (`perpetual` crate). `bookline_impl` runs in ghost mode only. `testdata/` holds fixtures. |
| `src/squadron/` | `patrol_impl.rs` (the huge tick loop), `patrol_tasks.rs` (spawned order/settlement/cleanup tasks), `local_book.rs`, `game_over.rs` |
| `src/cag/` | `mod.rs` (registry of squadrons, per-asset abort/cancel handles), `run.rs` (market loop and rotation), `session.rs` (`SessionState`) |
| `src/venues/` | `core.rs`, `lifecycle.rs`, `deployment.rs`, and the feature-gated `intl/`, `us/`, `kalshi/` |
| `src/api/` | `server.rs` (REST handlers), `setup.rs` (Setup wizard, `MANAGED_KEYS`, `RAPTOR_SOURCES`), `config_schema.rs` |
| `src/helpers/` | db, dynamic_config, balance, LLM advisor/policy/patch, redact, watchdog, notifications, and similar |
| `src/tasks/` | Background jobs (cleanup, collateral sweep, market monitor, venue income) |
| `control-tower/` | Next.js 15 / React 19 / Tailwind 3 dashboard |
| `integrations/` | `mcp/server.js` (read-only MCP server; `apiGet()` hardcodes GET) and `openclaw/SKILL.md` |
| `tools/` | Ops/analysis scripts (see `tools/README.md`) |
| `deploy/` | `entrypoint.sh` picks the venue binary at runtime (`data/venue` > `$DRADIS_VENUE` > single baked venue > intl). `ami/` holds the Marketplace AMI build. |

## Development Commands
```bash
cp src/config.balanced.rs.example src/config.rs   # required before any cargo build (gitignored)
cp .env.example .env

# Build: features are mutually exclusive; always pair non-default ones with --no-default-features
cargo build --release                                            # intl_clob (default)
cargo build --release --no-default-features --features us_retail
cargo build --release --no-default-features --features kalshi

# Local run: engine + Control Tower, per-instance binary/log/pid/data dir
./start-local.sh [btc|eth]          # intl: API :9002, UI :3004
VENUE=us ./start-local.sh           # API :9001, UI :3003
VENUE=kalshi ./start-local.sh       # API :9000, UI :3002
./stop-local.sh                     # INSTANCE=us ./stop-local.sh for one instance
# Logs: logs/dradis-<instance>.log

# Control Tower
cd control-tower && pnpm install && pnpm dev
cd control-tower && pnpm check && pnpm build   # required if touched (check = oxlint + tsc)

# Regenerate src/profiles.json after changing config templates or DynamicConfig
python3 tools/generate-profiles.py

# Docker (rust:1.91-alpine musl builder → alpine runtime; healthcheck GET /api/health)
DRADIS_VENUES="intl us kalshi" docker build -t dradis .
```
- No `rust-toolchain` file: CI uses latest stable.
- Release builds keep `debug = 1` line tables so stall dumps can be symbolized.

## Code Conventions & Common Patterns
- **Errors:** `anyhow::Result` throughout, with `?` propagation. Logging goes through `tracing` (`info!`/`warn!`/`debug!`), often with emoji prefixes. Hot-path gate logs are throttled with `gate_log_permitted(...)` / `reentry_log_permitted`, so never log unthrottled inside the 50 ms tick.
- **Money:** use `rust_decimal::Decimal` with `dec!()`, never `f64`, for prices, sizes, and P&L. Round prices with `floor_to_tick_size` / `round_to_tick_size` before returning `OrderParams`.
- **Concurrency:**
  - `Arc<RwLock<_>>` / `Arc<Mutex<_>>` for shared state, `DashMap` for registries, `watch` channels for feeds and config, and `CancellationToken`/`AbortHandle` for per-asset tasks.
  - **Never hold a lock guard across `.await`.**
  - Check-and-reserve of positions must happen in **one lock scope** (TOCTOU; see `tests/toctou.rs`).
  - Avoid `std::sync` locks inside `evaluate_*`: a blocking stall can't be interrupted by the timeout.
- **Strategies return complete `OrderParams`** (token, price, shares, fee bps, TIF, post_only). Callers in `main.rs` or patrol never do sizing or pricing arithmetic.
- **Feature gating:** venue-specific code goes behind `#[cfg(feature = "...")]` inside `venues/<venue>/` or gated squadron modules. Shared signatures must compile under all three features.
- **Ghost flag** is snapshotted at trade time, not at task spawn. Ghost paths must never move collateral or cancel real resting orders.
- **Raptors must never publish fabricated or stale data as current.** When unconfigured, a raptor reports disconnected. External services may observe, but must not gate live-money decisions.
- Strategy names in the registry use the `XxxStrategy` form (e.g., `"MomentumStrategy"`). Files are `snake_case_impl.rs`.

### Adding things
- **New viper:**
  1. Create `src/vipers/<name>_impl.rs` implementing `Strategy` (`evaluate_entry`, `evaluate_exit`, `name`, `status`).
  2. Add `pub mod` to `src/vipers/mod.rs`.
  3. Register in `orchestrator/registry.rs` in **both** `create_all_strategies()` and `strategy_names()`.
  4. Add any knobs to `DynamicConfig` and `api/config_schema.rs`.

  See `docs/CUSTOM_STRATEGY.md`.
- **New compile-time constant:** add it to **all three** `src/config.*.rs.example` templates. `tests/config_profiles_complete.rs` enforces this, and CI builds from the balanced template.
- **New credential/env var:**
  1. Register it in `MANAGED_KEYS` in `src/api/setup.rs`.
  2. If it is a raptor key, also add a `RAPTOR_SOURCES` entry with a `signup_url`.
  3. Update `.env.example`.

## Important Files
- `src/main.rs`: entry point. `src/lib.rs`: module tree.
- `src/state.rs`: `StrategySignal`, `OrderParams`, `MarketConfig`, `MarketSnapshot`, `PositionMap`, `TradeScope`.
- `src/orchestrator/{strategy,executor,registry}.rs`
- `src/squadron/patrol_impl.rs`: very large. Use `grep` or ranged reads, never a full read.
- `src/api/{server,setup,config_schema}.rs`: also very large.
- `src/helpers/{db,dynamic_config}.rs`
- `Cargo.toml`: features `intl_clob` (default), `us_retail`, `kalshi`.
- `.env.example`, `control-tower/.env.local.example`
- `control-tower/src/app/api/[...path]/route.ts`: request-time proxy to `DRADIS_API_URL` that injects `X-API-Key` server-side.
- `control-tower/src/middleware.ts`: Basic auth (`CT_USERNAME`/`CT_PASSWORD`).
- `control-tower/src/lib/{types,api,setupApi}.ts`: DTOs and fetch wrappers. Keep them in sync with `api/server.rs` responses.

## Runtime/Tooling Preferences
- **Rust:** stable toolchain, edition 2021, tokio multi-threaded runtime.
- **Control Tower:** **pnpm**, pinned via `packageManager` in `package.json` (use corepack). `pnpm-lock.yaml` and `pnpm-workspace.yaml` are tracked; Docker runs `pnpm install --frozen-lockfile`. Dependency overrides go in `pnpm-workspace.yaml`, not `package.json`. Lint is oxlint with `shadcn/no-arbitrary-values`: use theme tokens from `tailwind.config.ts` (`surface-*`, `text-2xs`…`text-5xs`), never `[#hex]`/`[Npx]`. It builds standalone output, and `NEXT_DIST_DIR` separates dev instances. Don't use Next `rewrites()` for the API: they are build-time only.
- **Python 3** for `tools/` scripts, stdlib-only style, DB opened read-only (`mode=ro`).
- **Never commit:**
  - Real-environment files: `.env`, `src/config.rs`, `data/`, `data-*/`, `logs/`.
  - Generated and build artifacts: `*.dSYM`, `deploy/ami/debuginfo/`.
  - Non-`.example` copies of `*.sh.example` scripts.
- Secrets precedence at boot: `data/secrets.env` (written by the Setup UI) > `.env`/container env > `config.rs` defaults.
- Commits: **no AI co-author trailers** (`Co-Authored-By: ...`). First-time contributors sign the CLA (`docs/CLA.md`).
- Never run two engines against the same wallet or account: order cancellation and position adoption collide.

## Testing & QA
```bash
cargo test --verbose                                               # intl_clob
cargo test --verbose --no-default-features --features us_retail
cargo test --verbose --no-default-features --features kalshi
cargo test toctou                     # filter by name
cargo test <name> -- --ignored --nocapture   # live/network tests (need keys, e.g. ODDS_API_KEY, KALSHI demo creds)
```
- **CI** (`.github/workflows/rust.yml`): a 3-venue matrix, `fail-fast: false`. It copies the balanced config, then runs `cargo check` and `cargo test`. There is no clippy or fmt gate, but run `cargo fmt` locally. `codeql.yml` runs security analysis.
- **Unit tests:**
  - Live in inline `#[cfg(test)]` modules. Async tests use `#[tokio::test]`.
  - Test names are descriptive sentences (e.g., `a_token_routes_by_the_shard_that_owns_it`).
  - DB tests use `helpers::db::memory_pool_for_tests()` (in-memory SQLite with schema). Use `register_pool_for_tests(asset, pool)` with a **unique asset name per test**.
  - No mocking library: write small trait impls (e.g., `CountingVenue`).
- **Integration tests** (`tests/`): config template completeness, TOCTOU atomicity.
- Control Tower and `tools/` have no test suites. Verify the UI with `pnpm check` + `pnpm build`, and by running it.
- **Execution-path changes** (order placement, fills, P&L) must be verified in ghost mode (`GHOST_MODE`, ghost-mode logs) or on Kalshi demo (`KALSHI_DEMO=1`). The PR must state what the venue actually returned. Strategy threshold changes need dated rationale comments in the config profiles.
