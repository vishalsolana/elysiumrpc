# elysium-rpc-relay

This is a private JSON-RPC endpoint for **Elysium mainnet (chain 99901)**, an Arbitrum Orbit (Nitro) chain whose parent chain is HyperEVM (999).

- **Reads** are proxied to community RPCs, in order, with fallback.
- **`eth_sendRawTransaction`** is relayed through Elysium's **delayed Inbox on HyperEVM**. The relayer calls
  `Inbox.sendL2Message(0x04 ++ rawTx)` from its own EOA and pays HyperEVM gas only. The L2 sender pays
  L2 gas from their own L2 balance, as usual.

The server binds **127.0.0.1 only**. It never handles user keys and only accepts already-signed transactions.

> **Status:** Step 0 (finding and verifying the Inbox address) has **not** been done yet. See below.
> The server refuses to start until the configured Inbox verifies on chain.

## Quick start

```bash
npm ci && npm run build
cp .env.example .env    # fill in RELAYER_PRIVATE_KEY, ELYSIUM_INBOX, …
npm run find-inbox      # Step 0 discovery (optional if you already have the address)
npm run verify-inbox    # Step 0 verification (must print VERIFIED)
npm start
TEST_L2_PRIVATE_KEY=0x… npm run relay-test
npm test
```

## Step 0: Inbox discovery and verification

`ELYSIUM_INBOX` has no default. Nothing is hard-coded.

- **`npm run find-inbox -- [blocksBack] [chunk]`** scans HyperEVM logs for
  `InboxMessageDelivered(uint256,bytes)`. Every Orbit Inbox emits this event. For each emitter it resolves
  `inbox.bridge().rollup().chainId()` and reports only an Inbox whose rollup says `99901`.
- **`npm run verify-inbox -- <addr>`** reads and prints:
  - `inbox.bridge()`
  - `bridge.rollup()`, `bridge.sequencerInbox()` and `bridge.delayedMessageCount()`
  - `rollup.chainId()`, which must be 99901
  - `bridge.allowedDelayedInboxes(inbox)`
  - `sequencerInbox.bridge()`, which must point back at the bridge
  - `sequencerInbox.totalDelayedMessagesRead()`, giving the **delayed backlog**
  - `maxTimeVariation()`, giving the force-inclusion delay
  - `paused()`, `maxDataSize()` and `allowListEnabled()` (falls back to `isAllowListEnabled()`)

  If the allow-list is enabled, it also checks `isAllowed(relayer)`. A paused Inbox, or an enabled allow-list
  without our relayer on it, is a **hard failure**. Exit code 0 means verified; 2 means not verified.
- **At startup** the same verification runs. On failure the process exits with code 2, which the systemd unit
  won't restart-loop on. The check also re-runs every `INBOX_RECHECK_MINUTES`. If the Inbox becomes paused or
  allow-listed, relaying is disabled and sends get `relay disabled: …` until it passes again.

## API

| Method | Behaviour |
|---|---|
| `eth_sendRawTransaction` | Validate, dedupe, relay via Inbox, return `keccak256(raw)` |
| `eth_getTransactionCount(addr, "pending")` | upstream `latest` + our in-flight txs for `addr` |
| `eth_chainId`, `net_version` | answered locally (99901) |
| `eth_sendTransaction`, `eth_sign*`, `personal_*` | refused (`-32601`). No keys here. |
| everything else | proxied to `UPSTREAM_RPC_URLS` in order, 4 s timeout each |

The server accepts single and batch requests. If `API_KEY` is set, send it as `x-api-key`, `Authorization: Bearer`, or `?apikey=`.

- `GET /health` (no auth) returns:
  - upstream block heights and latency
  - relayer HyperEVM balance, and whether it is low
  - Inbox status and delayed backlog
  - in-flight count and oldest age
  - last relay time
  - last and average inclusion latency

  It answers 200 if healthy, otherwise 503.
- `GET /tx/<l2hash>` (auth) returns a tx's relay record: state, HyperEVM tx hash and gas cost, relay count and outcome.

### Send pipeline

1. **Stateless checks.** The size must be ≤ `MAX_TX_BYTES` (128 KB). The tx must decode as typed or EIP-155 legacy;
   blob txs are rejected. It must be signed, and `chainId` must be 99901. Then the sender is recovered.
2. **Per-sender lock.** Validation and the nonce reservation are atomic, so two concurrent sends can't take the same nonce.
3. **Dedupe by hash.**
   - A resend of a tx already relayed, or already mined, returns the same hash without relaying again.
   - If the tx has been unconfirmed for more than `DEDUPE_RESEND_AFTER_MINUTES` (2), the server first checks
     for a receipt and that the nonce is still unused, then relays it again.
4. **State checks**, read from the upstream:
   - `nonce == latest + in-flight(sender)`. Otherwise it rejects with `nonce too low` / `nonce too high`.
   - `balance ≥ gas × maxFeePerGas + value + sum of the sender's in-flight max costs`.
     Otherwise it rejects with `insufficient funds for gas * price + value`.
   - `maxFeePerGas ≥ current L2 base fee`.

   All rejections use `-32000` with geth-style messages.
5. **Relay.** The relayer queue does one HyperEVM tx at a time with a local nonce. It runs `estimateGas` first, so
   Inbox reverts (paused, allow-list, too large) cost nothing, and rejects anything above `RELAY_MAX_GAS`. It then
   sends `sendL2Message(0x04 ++ raw)`. On a nonce error it resyncs and retries once.
6. **Track.** Each in-flight entry records the hash, sender, nonce, relayed-at time and HyperEVM tx hash.
   Entries persist to `STATE_FILE`, so pending nonces survive restarts.

### Background loops

- **Every `RECEIPT_POLL_MS`, for each in-flight tx:**
  - Check the HyperEVM receipt. If the relay tx reverted, drop the entry.
  - Check the L2 receipt. If it has been mined, drop the entry and record the inclusion latency.
  - If the sender's L2 nonce moved past ours with no receipt, mark the tx dropped.
  - After `STUCK_AFTER_MINUTES` without inclusion, log a warning.
  - After `INFLIGHT_EXPIRY_MINUTES`, release the nonce reservation with a loud error.
- **Relayer balance**, every 30 s: logs `RELAYER HYPEREVM BALANCE LOW` below `RELAYER_BALANCE_WARN_HYPE`.

## Deploy (systemd)

```bash
sudo useradd --system --home /opt/elysium-rpc elysiumrpc
sudo mkdir -p /opt/elysium-rpc/data && sudo cp -r dist package*.json /opt/elysium-rpc/
(cd /opt/elysium-rpc && sudo npm ci --omit=dev)
sudo install -m 600 -o elysiumrpc .env /etc/elysium-rpc.env
sudo chown -R elysiumrpc:elysiumrpc /opt/elysium-rpc
sudo cp deploy/elysium-rpc.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now elysium-rpc
journalctl -u elysium-rpc -f
```

## Caveats and known risks

- **Inclusion depends on the sequencer.** A delayed message is only guaranteed to land after the force-inclusion
  delay (`maxTimeVariation`; on Arbitrum One that is ~24 h). The ~15–20 s seen with the old community relays means
  the sequencer was reading the delayed inbox promptly. If the delayed backlog in `verify-inbox` or `/health`
  grows, the sequencer has stopped doing that, and no relay can fix it.
- **Re-relaying after the dedupe window** delivers a second delayed message for the same tx. If the first one lands,
  the second fails L2 nonce validation and costs only relayer gas.
- **Replacement (speed-up) txs** with the same nonce are rejected as `nonce too low` while the original is in flight.
  The delayed inbox has no mempool replacement semantics.
- **HyperEVM small blocks are 2M gas.** Calldata costs ~16 gas/byte, so a relay of ~115 KB or more needs a big block.
  `RELAY_MAX_GAS` rejects those up front unless you raise it, which requires the relayer to use HyperEVM big blocks.
- In-flight state is a local JSON file. Run a single instance.
