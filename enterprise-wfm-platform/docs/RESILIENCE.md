# Staying up

The aim is that no single failure takes the service down, and that when something does go wrong it says so and recovers by itself. This is what is built, what was tested by actually causing the failure, and what no software can promise.

## What happens when something is missing

| Failure | What the gateway does | Tested by |
|---|---|---|
| Event bus (NATS) not running at start | Starts and serves anyway; reports `degraded`; connects in the background, retrying with growing waits; holds up to 5,000 events published meanwhile and sends them once connected; starts its subscriptions and consumers when connected, and again after any full reconnect | Started a gateway with no bus: logins and writes worked; started the bus: found it in about 15 s |
| Event bus lost while running | Same: keeps serving, reconnects, restarts consumers | Reconnection logic only exercised at start-up |
| Database not reachable at start | Waits and logs, does not exit; starts normally when it appears. A real error (a bad migration) still stops start-up, loudly | Started with the database unreachable for 30 s: it waited, then came up healthy |
| Database lost while running | Requests fail with an error; workers log and try again on their next tick; the pool reconnects | Not drilled |
| Redis (cache, rate limits) down | Commands fail at once instead of queueing, every caller already treats Redis as optional; `degraded`. Sign-in went from 20 s to instant | Started with Redis unreachable: sign-in and reads answered in milliseconds |
| Engine down or an engine process dies | Requests to it return a clear 503; with several engines (`ENGINE_ADDR` list) work moves to the others; background jobs are re-queued | Stopped one of two engines mid-use |
| Uncaught exception / unhandled rejection anywhere | Logged with its stack, the process carries on. More than 25 in a minute means the process is in a bad state, so it exits for the supervisor to restart it clean | Injected one exception and 11 rejections: service stayed healthy |
| A webhook receiver, mail server or SMS provider failing, hanging up or answering nonsense | Reported as a reason for that message, retried with growing waits, never thrown into the request or the timer | Mock providers that refuse, hang up and return garbage |
| A browser connection dropping | Handled per socket | Reviewed |
| A screen's code failing to render | An error boundary shows a message for that screen, the rest of the app keeps working | Existing |

Health: `/health` answers 200 with `status: "ok"` when everything is up, `"degraded"` when it works but something it uses is missing (cache, event bus, engine), and 503 `"down"` only when the database is unreachable. A load balancer should send traffic to `degraded`.

## What no software can promise

- A process can still be killed from outside: the operating system running out of memory, a power cut, someone ending it. Run it under a supervisor that restarts it: the supplied `docker-compose.yml` uses `restart: unless-stopped`; on a server without Docker use systemd or a Windows service wrapper with restart on failure. On the test laptop the engine was killed twice by memory pressure; give the engine memory for its workers.
- A native library inside the engine (the solver, the numerical libraries) can crash its process. The engine turns on Python's fault handler to say where, and the gateway treats an engine that goes away as unavailable and moves work to another engine, so run more than one.
- Corruption or loss of the database is a backup question, not an uptime one. Keep `SECRETS_KEY` in a safe place that is backed up separately from the database: without it the encrypted secrets in a restored backup cannot be read.
- Running two separate deployments against one NATS server makes them take each other's events unless each sets `NATS_CONSUMER_PREFIX` (gateways of the same deployment leave it empty so they share the work). New webhook and alert consumers start from the next event, not from a week of old ones.
