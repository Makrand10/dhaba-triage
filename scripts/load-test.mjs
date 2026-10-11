import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { triageResponseSchema } from "../dist/src/schemas/triage-schema.js";

const defaults = {
  url: process.env.LOAD_TEST_URL ?? "http://127.0.0.1:3000",
  rate: Number(process.env.LOAD_TEST_RATE ?? 50),
  duration: Number(process.env.LOAD_TEST_DURATION_SECONDS ?? 10),
  concurrency: Number(process.env.LOAD_TEST_CONCURRENCY ?? 32),
  timeoutMs: Number(process.env.LOAD_TEST_TIMEOUT_MS ?? 5000),
  replayCheck: true,
};

function parseArgs(args) {
  const config = { ...defaults };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help") {
      console.log("Usage: npm run loadtest -- [--url URL] [--rate RPS] [--duration SECONDS] [--concurrency N] [--timeout-ms MS] [--skip-replay-check]");
      process.exit(0);
    }
    if (arg === "--skip-replay-check") {
      config.replayCheck = false;
      continue;
    }
    const value = args[index + 1];
    if (!value) throw new Error(`Missing value for ${arg}`);
    if (arg === "--url") config.url = value;
    else if (arg === "--rate") config.rate = Number(value);
    else if (arg === "--duration") config.duration = Number(value);
    else if (arg === "--concurrency") config.concurrency = Number(value);
    else if (arg === "--timeout-ms") config.timeoutMs = Number(value);
    else throw new Error(`Unknown option: ${arg}`);
    index += 1;
  }

  if (!Number.isFinite(config.rate) || config.rate < 1 || config.rate > 1000) {
    throw new Error("Rate must be from 1 to 1000 requests per second.");
  }
  if (!Number.isFinite(config.duration) || config.duration <= 0 || config.duration > 120) {
    throw new Error("Duration must be greater than 0 and at most 120 seconds.");
  }
  if (!Number.isInteger(config.concurrency) || config.concurrency < 1 || config.concurrency > 64) {
    throw new Error("Concurrency must be an integer from 1 to 64.");
  }
  if (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 100 || config.timeoutMs > 30000) {
    throw new Error("Timeout must be from 100 to 30000 milliseconds.");
  }
  return config;
}

function makeSyntheticTicket(id, sequence = 0) {
  const now = new Date().toISOString();
  return {
    id,
    received_at: now,
    subject: `Synthetic load-test request ${sequence}`,
    body: "Synthetic content for measuring fixture-mode API throughput.",
    purchases: [],
    app_opens_since_renewal: 0,
  };
}

async function sendTicket(url, ticket, timeoutMs) {
  const startedAt = performance.now();
  try {
    const response = await fetch(`${url.replace(/\/$/, "")}/triage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ticket),
      signal: AbortSignal.timeout(timeoutMs),
    });
    let payload;
    try {
      payload = await response.json();
    } catch {
      payload = undefined;
    }
    const latencyMs = performance.now() - startedAt;
    if (response.status < 200 || response.status >= 300) {
      return { kind: "http_error", status: response.status, latencyMs, completedAt: performance.now() };
    }
    if (!triageResponseSchema.safeParse(payload).success) {
      return { kind: "schema_failure", status: response.status, latencyMs, completedAt: performance.now() };
    }
    return { kind: "success", status: response.status, payload, latencyMs, completedAt: performance.now() };
  } catch (error) {
    return {
      kind: "network_failure",
      errorName: error instanceof Error ? error.name : "UnknownError",
      latencyMs: performance.now() - startedAt,
      completedAt: performance.now(),
    };
  }
}

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return Number(sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)].toFixed(2));
}

async function runLoadTest(config) {
  const runId = randomUUID();
  const scheduled = Math.floor(config.rate * config.duration);
  const pending = new Set();
  const outcomes = [];
  let sent = 0;
  let skippedAtConcurrencyLimit = 0;
  let maxObservedInFlight = 0;
  const startedAt = performance.now();

  for (let sequence = 0; sequence < scheduled; sequence += 1) {
    const scheduledAt = startedAt + (sequence * 1000) / config.rate;
    const waitMs = scheduledAt - performance.now();
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));

    if (pending.size >= config.concurrency) {
      skippedAtConcurrencyLimit += 1;
      continue;
    }

    const ticket = makeSyntheticTicket(`load-${runId}-${sequence}`, sequence);
    sent += 1;
    const task = sendTicket(config.url, ticket, config.timeoutMs).then((outcome) => outcomes.push(outcome));
    pending.add(task);
    maxObservedInFlight = Math.max(maxObservedInFlight, pending.size);
    void task.finally(() => pending.delete(task));
  }

  await Promise.allSettled([...pending]);
  const endedAt = performance.now();
  const elapsedSeconds = (endedAt - startedAt) / 1000;
  const successes = outcomes.filter((outcome) => outcome.kind === "success").length;
  const httpErrors = outcomes.filter((outcome) => outcome.kind === "http_error").length;
  const networkFailures = outcomes.filter((outcome) => outcome.kind === "network_failure").length;
  const schemaFailures = outcomes.filter((outcome) => outcome.kind === "schema_failure").length;
  const networkFailureTypes = Object.fromEntries(
    Object.entries(
      outcomes
        .filter((outcome) => outcome.kind === "network_failure")
        .reduce((counts, outcome) => {
          counts[outcome.errorName] = (counts[outcome.errorName] ?? 0) + 1;
          return counts;
        }, {}),
    ).sort(([left], [right]) => left.localeCompare(right)),
  );
  const latencies = outcomes.map((outcome) => outcome.latencyMs);
  const completed = outcomes.length;
  const completedRps = elapsedSeconds > 0 ? completed / elapsedSeconds : 0;
  const successfulRps = elapsedSeconds > 0 ? successes / elapsedSeconds : 0;
  const measurementWindowEnd = startedAt + config.duration * 1000;
  const completedByWindowEnd = outcomes.filter((outcome) => outcome.completedAt <= measurementWindowEnd).length;
  const successfulByWindowEnd = outcomes.filter(
    (outcome) => outcome.kind === "success" && outcome.completedAt <= measurementWindowEnd,
  ).length;
  const successfulRpsDuringWindow = successfulByWindowEnd / config.duration;
  const targetSustained =
    skippedAtConcurrencyLimit === 0 &&
    sent === scheduled &&
    successes === sent &&
    completedRps >= config.rate * 0.95 &&
    successfulByWindowEnd >= Math.ceil(scheduled * 0.95);

  return {
    runId,
    scheduled,
    sent,
    completed,
    successes,
    httpErrors,
    networkFailures,
    networkFailureTypes,
    schemaFailures,
    skippedAtConcurrencyLimit,
    targetRateRps: config.rate,
    configuredDurationSeconds: config.duration,
    elapsedSeconds: Number(elapsedSeconds.toFixed(3)),
    completedRequestsPerSecond: Number(completedRps.toFixed(2)),
    successfulResponsesPerSecond: Number(successfulRps.toFixed(2)),
    successfulResponsesCompletedWithinWindow: successfulByWindowEnd,
    completedWithinWindow: completedByWindowEnd,
    successfulResponsesPerSecondDuringWindow: Number(successfulRpsDuringWindow.toFixed(2)),
    latencyMs: {
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
    },
    sustainedTargetRate: targetSustained,
    concurrencyLimit: config.concurrency,
    maxObservedInFlight,
  };
}

async function runReplayCheck(config) {
  const ticket = makeSyntheticTicket(`replay-${randomUUID()}`, "replay-check");
  const first = await sendTicket(config.url, ticket, config.timeoutMs);
  const second = await sendTicket(config.url, ticket, config.timeoutMs);
  return {
    requests: 2,
    firstResult: first.kind,
    secondResult: second.kind,
    responsesIdentical:
      first.kind === "success" &&
      second.kind === "success" &&
      first.status === second.status &&
      JSON.stringify(first.payload) === JSON.stringify(second.payload),
  };
}

try {
  const config = parseArgs(process.argv.slice(2));
  const loadResult = await runLoadTest(config);
  const replayResult = config.replayCheck ? await runReplayCheck(config) : undefined;
  console.log(JSON.stringify({ mode: "synthetic fixture load; ensure server has TRIAGE_MODE=fixture", load: loadResult, replayCheck: replayResult }, null, 2));
  if (!loadResult.sustainedTargetRate) process.exitCode = 1;
  if (replayResult && !replayResult.responsesIdentical) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : "Load test configuration failed.");
  process.exitCode = 1;
}
