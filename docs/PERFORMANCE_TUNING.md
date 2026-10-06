# Host & Container Performance Tuning

Guidelines for squeezing maximum low-latency performance out of Ubuntu on AWS EC2 / OCI instances running DRADIS in Docker.

---

## Kernel Network Stack

Add to `/etc/sysctl.conf`, then apply with `sudo sysctl -p`:

```bash
# Larger socket buffers for WebSocket throughput
net.core.rmem_max=134217728
net.core.wmem_max=134217728
net.ipv4.tcp_rmem=4096 87380 134217728
net.ipv4.tcp_wmem=4096 65536 134217728

# Reduce ACK latency
net.ipv4.tcp_low_latency=1
net.ipv4.tcp_nodelay=1          # set per-socket; this documents intent
net.ipv4.tcp_sack=1

# Faster TIME_WAIT recycling
net.ipv4.tcp_tw_reuse=1
net.ipv4.tcp_fin_timeout=15

# Larger connection backlog
net.core.somaxconn=65535
net.ipv4.tcp_max_syn_backlog=65535
```

---

## CPU Frequency Governor

Lock cores to maximum frequency — prevents the kernel from throttling mid-trade:

```bash
sudo apt install -y cpufrequtils
echo 'GOVERNOR="performance"' | sudo tee /etc/default/cpufrequtils
sudo systemctl restart cpufrequtils
# Verify
cpufreq-info | grep "current policy"
```

---

## CPU Affinity

Pin DRADIS to isolated cores, leaving cores 0–1 for the OS and kernel threads:

```bash
# Bare-metal / non-Docker
taskset -c 2,3 ./target/release/dradis

# Docker — pin container to cores 2–3, bind to local memory node
docker run -d --restart unless-stopped \
  --cpuset-cpus="2,3" \
  --cpuset-mems="0" \
  --name dradis-btc \
  --env-file .env \
  dradis
```

---

## IRQ Affinity

Route NIC interrupts away from the DRADIS cores so they stay interrupt-free:

```bash
# Find your NIC IRQs (replace eth0 with your interface, e.g. ens5 on EC2)
grep eth0 /proc/interrupts | awk '{print $1}' | tr -d ':'

# Route each IRQ to core 0 only
echo 1 | sudo tee /proc/irq/<IRQ_NUM>/smp_affinity
```

---

## Docker Ulimits

The deploy scripts (`deploy-demo.sh`, `deploy-live.sh`, `deploy-multi.sh.example`)
and the AMI's `deploy/ami/docker-compose.yml` already set `nofile` to 65536, so a
standard deployment needs nothing here. The recipe below is for a hand-rolled
`docker run`, and it adds the memory-lock limit on top.

Raising `nofile` is not optional tuning. Docker defaults a container to a 1024
open-file soft limit, and the engine holds a socket per venue connection while the
API listener needs one per inbound request. Past 1024, every accept fails with
`No file descriptors available (os error 24)`: the engine goes on trading, but the
Control Tower reports "DRADIS engine unreachable" on every view. The demo instance
reached that state after roughly 11 days of uptime on 2026-09-20.

Raise file descriptor and memory-lock limits for the container:

```bash
docker run -d --restart unless-stopped \
  --cpuset-cpus="2,3" \
  --ulimit nofile=65536:65536 \
  --ulimit memlock=-1:-1 \
  --name dradis-btc \
  --env-file .env \
  dradis
```

---

## Instance Selection

| Cloud | Recommended | Avoid |
|-------|-------------|-------|
| **AWS** | `c6i` / `c7i` (compute-optimized) | `t3.*` burstable — CPU credits cause latency spikes |
| **OCI** | `VM.Standard.E4.Flex` (dedicated OCPU) or `BM.Standard.E4.128` bare-metal | Shared-core shapes |

**Region placement:** put your instance in the same region as your primary Polymarket CLOB endpoint to minimise RTT. You need to research this yourself.

---

## Measuring the Effect

`GET /api/latency` returns, under `timing`, histograms measured on the trading path since the process started:

| Field | What it measures |
|-------|------------------|
| `tick_service` | Duration of each strategy-tick body, all squadrons of the process |
| `tick_lateness` | How long after its due time each tick started: a stall elsewhere in the loop shows up here |
| `tick_overruns` | Ticks whose body took longer than the tick interval |
| `placement_single` / `placement_batch` | Order POST round trip (request start to parsed reply) of acknowledged attempts, plus `failed` and `timed_out` counts |
| `resting_fill_event` | Resting (GTC/GTD) order placement → first fill event matched by order id (US and Kalshi fill feeds) |
| `resting_fill_poll` | Resting order placement → holding found by the reconcile poll; an upper bound, never mixed with feed timings |

Each histogram has a `count`, a `p50_ms`, a `p95_ms` and a `p99_ms`. It also has per-bucket `counts` aligned with `bucket_le_us`, which are inclusive upper bounds in microseconds plus one overflow bucket.

- **Percentiles are bucket bounds, not exact values.** A `null` percentile with a non-zero `count` means the rank is above 60 s.
- **Placement RTT is host-observed.** It is not the venue's matching time. Ghost orders never reach the venue, so they are not counted.
- **Counters reset on restart.** To measure a change, snapshot before and after an equal-length run under a similar market and squadron mix, and compare the deltas of the bucket counts.

### Slippage

`slippage.cohorts` in the same response compares each live fill with the price the strategy evaluated. There is one cohort per strategy × buy/sell × maker/taker intent, where intent is post-only or not, not the venue's liquidity role.

- **Units:** signed adverse bps, so positive costs money and negative is price improvement. `adverse_usd` totals the dollars.
- **What counts as measured:** only fills whose price the venue reported. Polymarket International reports matched amounts and Kalshi reports an average fill price; Polymarket US acknowledgements carry no execution price. Fills priced at the limit are counted in `unmeasured`, never as 0 bps.
- **Ghost fills** are simulated at the strategy's price and are not recorded.

Each measured or unmeasured live fill also writes a row to the `executions` table (`logs/<shard>-dradis.db`), with `intended_price`, `fill_price`, `price_source` and `order_id`, so slippage survives restarts and can be queried per strategy:

```sql
SELECT strategy, action, COUNT(*),
       AVG((CAST(fill_price AS REAL) - CAST(intended_price AS REAL))
           * CASE action WHEN 'buy' THEN 1 ELSE -1 END
           / CAST(intended_price AS REAL) * 10000) AS avg_adverse_bps
FROM executions WHERE price_source = 'venue' GROUP BY 1, 2;
```

