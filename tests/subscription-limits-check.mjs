import assert from "node:assert/strict";

function normalizeCodexUsageWindow(window) {
  if (!window || typeof window !== "object" || Array.isArray(window)) return undefined;
  let resetAt = typeof window.reset_at === "number" ? window.reset_at : undefined;
  if (resetAt === undefined && typeof window.reset_after_seconds === "number") {
    resetAt = Math.floor(Date.now() / 1000) + window.reset_after_seconds;
  }
  return {
    usedPercent: typeof window.used_percent === "number" ? window.used_percent : 0,
    windowSeconds: typeof window.limit_window_seconds === "number" ? window.limit_window_seconds : 0,
    resetAt,
  };
}

function matchesUsageWindow(window, expectedSeconds) {
  if (!window) return false;
  return Math.abs(window.windowSeconds - expectedSeconds) <= 120;
}

function normalizePercent(val) {
  if (typeof val === "number" && Number.isFinite(val)) {
    if (val > 0 && val < 1 && !Number.isInteger(val)) return val * 100;
    if (val >= 0 && val <= 100) return val;
  }
  return undefined;
}

function findPercentCandidate(values) {
  for (const val of values) {
    const norm = normalizePercent(val);
    if (norm !== undefined) return norm;
  }
  return undefined;
}

function findResetAtCandidate(absoluteCandidates, relativeSecondsCandidates) {
  for (const val of absoluteCandidates) {
    if (typeof val === "number" && Number.isFinite(val) && val > 0) {
      return val;
    }
    if (typeof val === "string") {
      const parsed = Date.parse(val);
      if (Number.isFinite(parsed)) {
        return Math.floor(parsed / 1000);
      }
    }
  }
  for (const val of relativeSecondsCandidates) {
    if (typeof val === "number" && Number.isFinite(val) && val >= 0) {
      return Math.floor(Date.now() / 1000) + val;
    }
  }
  return undefined;
}

function getRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value;
}

function parseCodexUsageSnapshot(data) {
  const raw = getRecord(data);

  // Try limits[] array format first
  const limitArrays = [raw?.data?.limits, raw?.limits, raw?.quota?.limits, raw?.data?.quota?.limits];
  const limits = limitArrays.find((arr) => Array.isArray(arr));
  if (limits) {
    const SESSION_TYPES = new Set(["TIME_LIMIT", "SESSION_LIMIT", "REQUEST_LIMIT", "RPM_LIMIT", "RPD_LIMIT"]);
    const WEEKLY_TYPES = new Set(["TOKENS_LIMIT", "TOKEN_LIMIT", "WEEK_LIMIT", "WEEKLY_LIMIT", "TPM_LIMIT", "DAILY_LIMIT"]);
    const sessionEntry = limits.find((l) => SESSION_TYPES.has(String(l?.type || "").toUpperCase()));
    const weeklyEntry = limits.find((l) => WEEKLY_TYPES.has(String(l?.type || "").toUpperCase()));

    const readLimitPercent = (entry) => {
      if (!entry) return undefined;
      for (const key of ["percentage", "utilization", "used_percent", "usedPercent"]) {
        const val = entry[key];
        if (typeof val === "number" && Number.isFinite(val)) {
          if (val > 0 && val < 1 && !Number.isInteger(val)) return val * 100;
          if (val >= 0 && val <= 100) return val;
        }
      }
      const current = typeof entry.currentValue === "number" ? entry.currentValue : undefined;
      const remaining = typeof entry.remaining === "number" ? entry.remaining : undefined;
      if (current !== undefined && remaining !== undefined && current + remaining > 0) {
        return (current / (current + remaining)) * 100;
      }
      return undefined;
    };

    const sessionPct = readLimitPercent(sessionEntry);
    const weeklyPct = readLimitPercent(weeklyEntry);

    if (sessionPct !== undefined || weeklyPct !== undefined) {
      const sessionResetAt = findResetAtCandidate(
        [sessionEntry?.resetAt, sessionEntry?.reset_at],
        [sessionEntry?.resetAfterSeconds, sessionEntry?.reset_after_seconds]
      );
      const weeklyResetAt = findResetAtCandidate(
        [weeklyEntry?.resetAt, weeklyEntry?.reset_at],
        [weeklyEntry?.resetAfterSeconds, weeklyEntry?.reset_after_seconds]
      );

      const fiveHour = sessionPct !== undefined
        ? { usedPercent: sessionPct, windowSeconds: 5 * 60 * 60, resetAt: sessionResetAt }
        : undefined;
      const weekly = weeklyPct !== undefined
        ? { usedPercent: weeklyPct, windowSeconds: 7 * 24 * 60 * 60, resetAt: weeklyResetAt }
        : undefined;
      return {
        planType: typeof raw?.plan_type === "string" ? raw.plan_type : "unknown",
        email: typeof raw?.email === "string" ? raw.email : "",
        fiveHour,
        weekly,
      };
    }
  }

  let fiveHour = undefined;
  let weekly = undefined;

  // Legacy rate_limit format check with duration-aware matching
  const rateLimit = getRecord(raw?.rate_limit);
  if (rateLimit) {
    const primary = normalizeCodexUsageWindow(rateLimit.primary_window);
    const secondary = normalizeCodexUsageWindow(rateLimit.secondary_window);

    if (primary || secondary) {
      const candidateWindows = [primary, secondary].filter((w) => Boolean(w));
      const matchedSession = candidateWindows.find((w) => w.windowSeconds > 0 && w.windowSeconds <= 12 * 60 * 60);
      const matchedWeekly = candidateWindows.find((w) => w.windowSeconds > 12 * 60 * 60);

      if (matchedSession) {
        fiveHour = matchedSession;
      }
      if (matchedWeekly) {
        weekly = matchedWeekly;
      }

      if (!fiveHour && !weekly) {
        if (primary) {
          fiveHour = { ...primary, windowSeconds: primary.windowSeconds || 5 * 60 * 60 };
        }
        if (secondary) {
          weekly = { ...secondary, windowSeconds: secondary.windowSeconds || 7 * 24 * 60 * 60 };
        }
      } else {
        if (fiveHour && !weekly) {
          const remaining = candidateWindows.find((w) => w !== fiveHour);
          if (remaining) {
            weekly = { ...remaining, windowSeconds: remaining.windowSeconds || 7 * 24 * 60 * 60 };
          }
        } else if (weekly && !fiveHour) {
          const remaining = candidateWindows.find((w) => w !== weekly);
          if (remaining) {
            fiveHour = { ...remaining, windowSeconds: remaining.windowSeconds || 5 * 60 * 60 };
          }
        }
      }
    }
  }

  // Fallback to flat candidates if still missing
  if (!fiveHour) {
    const sessionPct = findPercentCandidate([
      raw?.session,
      raw?.sessionPercent,
      raw?.session_percent,
      raw?.five_hour?.utilization,
      raw?.five_hour?.used_percent,
      raw?.limits?.session?.utilization,
      raw?.usage?.session,
      raw?.data?.session,
      raw?.data?.sessionPercent,
      raw?.data?.session_percent,
      raw?.data?.usage?.session,
      raw?.quota?.session?.percentage,
      raw?.data?.quota?.session?.percentage,
    ]);
    if (sessionPct !== undefined) {
      const sessionResetAt = findResetAtCandidate(
        [
          raw?.five_hour?.reset_at,
          raw?.sessionResetAt,
        ],
        [
          raw?.five_hour?.reset_after_seconds,
        ]
      );
      const sessionWindowSecs = typeof raw?.five_hour?.window_seconds === "number"
        ? raw.five_hour.window_seconds
        : 5 * 60 * 60;
      fiveHour = {
        usedPercent: sessionPct,
        windowSeconds: sessionWindowSecs,
        resetAt: sessionResetAt,
      };
    }
  }

  if (!weekly) {
    const weeklyPct = findPercentCandidate([
      raw?.weekly,
      raw?.weeklyPercent,
      raw?.weekly_percent,
      raw?.seven_day?.utilization,
      raw?.seven_day?.used_percent,
      raw?.limits?.weekly?.utilization,
      raw?.usage?.weekly,
      raw?.data?.weekly,
      raw?.data?.weeklyPercent,
      raw?.data?.weekly_percent,
      raw?.data?.usage?.weekly,
      raw?.quota?.weekly?.percentage,
      raw?.data?.quota?.weekly?.percentage,
      raw?.quota?.daily?.percentage,
      raw?.data?.quota?.daily?.percentage,
    ]);
    if (weeklyPct !== undefined) {
      const weeklyResetAt = findResetAtCandidate(
        [
          raw?.seven_day?.reset_at,
          raw?.weeklyResetAt,
        ],
        [
          raw?.seven_day?.reset_after_seconds,
        ]
      );
      const weeklyWindowSecs = typeof raw?.seven_day?.window_seconds === "number"
        ? raw.seven_day.window_seconds
        : 7 * 24 * 60 * 60;
      weekly = {
        usedPercent: weeklyPct,
        windowSeconds: weeklyWindowSecs,
        resetAt: weeklyResetAt,
      };
    }
  }

  return {
    planType: typeof raw?.plan_type === "string" ? raw.plan_type : "unknown",
    email: typeof raw?.email === "string" ? raw.email : "",
    fiveHour,
    weekly,
  };
}

function getCodexWindowRemaining(window) {
  if (!window) return undefined;
  return Math.max(0, Math.min(100, 100 - window.usedPercent));
}

function classifyCodexQuotaKind(snapshot) {
  const values = [getCodexWindowRemaining(snapshot.fiveHour), getCodexWindowRemaining(snapshot.weekly)]
    .filter((value) => value !== undefined);
  if (values.length === 0) return { kind: "error", score: 0 };
  const bottleneck = Math.min(...values);
  if (bottleneck <= 6) return { kind: "blocked", score: bottleneck };
  if (bottleneck <= 15) return { kind: "low", score: bottleneck };
  if (bottleneck <= 30) return { kind: "watch", score: bottleneck };
  return { kind: "ready", score: bottleneck };
}

function normalizeGoogleRemainingPercent(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.min(100, Math.round(value * 100)));
}

function parseIsoTimestampSeconds(value) {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.floor(parsed / 1000);
}

function updateGoogleQuotaModel(modelsByName, model, remainingPercent, resetAt) {
  const existing = modelsByName.get(model);
  if (!existing) {
    modelsByName.set(model, { model, remainingPercent, resetAt });
    return;
  }

  let next = existing;
  if (remainingPercent !== undefined) {
    if (existing.remainingPercent === undefined || remainingPercent < existing.remainingPercent) {
      next = { ...next, remainingPercent };
    }
  }
  if (resetAt !== undefined) {
    if (next.resetAt === undefined || resetAt < next.resetAt) {
      next = { ...next, resetAt };
    }
  }
  if (next !== existing) {
    modelsByName.set(model, next);
  }
}

function buildGoogleQuotaSnapshot(endpoint, projectId, modelsByName) {
  const models = [...modelsByName.values()];
  const remainingPercents = models
    .map((model) => model.remainingPercent)
    .filter((value) => value !== undefined);
  const worstRemainingPercent = remainingPercents.length > 0
    ? Math.min(...remainingPercents)
    : undefined;

  return { endpoint, projectId, models, worstRemainingPercent };
}

function getGoogleGeminiModelLabel(modelId) {
  if (!modelId) return "unknown";
  const normalized = modelId.toLowerCase();
  if (normalized.includes("pro")) return "Pro";
  if (normalized.includes("flash")) return "Flash";
  return modelId;
}

function parseGoogleGeminiQuotaSnapshot(data, projectId) {
  const buckets = Array.isArray(data?.buckets) ? data.buckets : [];
  const modelsByName = new Map();

  for (const bucket of buckets) {
    const model = getGoogleGeminiModelLabel(typeof bucket?.modelId === "string" ? bucket.modelId : undefined);
    const remainingPercent = normalizeGoogleRemainingPercent(bucket?.remainingFraction);
    const resetAt = typeof bucket?.resetTime === "string"
      ? parseIsoTimestampSeconds(bucket.resetTime)
      : undefined;
    if (remainingPercent === undefined && resetAt === undefined) continue;
    updateGoogleQuotaModel(modelsByName, model, remainingPercent, resetAt);
  }

  return buildGoogleQuotaSnapshot(
    "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota",
    projectId,
    modelsByName,
  );
}

const GOOGLE_ANTIGRAVITY_HIDDEN_MODELS = new Set(["tab_flash_lite_preview"]);

function parseGoogleAntigravityQuotaSnapshot(data, endpoint, projectId) {
  const rawModels = data?.models && typeof data.models === "object" ? data.models : {};
  const modelsByName = new Map();

  for (const [modelKey, modelValue] of Object.entries(rawModels)) {
    if (modelValue?.isInternal === true) continue;
    if (GOOGLE_ANTIGRAVITY_HIDDEN_MODELS.has(modelKey.toLowerCase())) continue;

    const displayName = typeof modelValue?.displayName === "string" && modelValue.displayName.length > 0
      ? modelValue.displayName
      : typeof modelValue?.model === "string" && modelValue.model.length > 0
        ? modelValue.model
        : modelKey;

    if (GOOGLE_ANTIGRAVITY_HIDDEN_MODELS.has(displayName.toLowerCase())) continue;

    const quotaInfo = modelValue?.quotaInfo || {};
    const remainingPercent = normalizeGoogleRemainingPercent(quotaInfo.remainingFraction);
    const resetAt = typeof quotaInfo.resetTime === "string"
      ? parseIsoTimestampSeconds(quotaInfo.resetTime)
      : undefined;
    if (remainingPercent === undefined && resetAt === undefined) continue;
    updateGoogleQuotaModel(modelsByName, displayName, remainingPercent, resetAt);
  }

  return buildGoogleQuotaSnapshot(endpoint, projectId, modelsByName);
}

function classifyGoogleQuotaKind(snapshot) {
  const bottleneck = snapshot.worstRemainingPercent;
  if (bottleneck === undefined) return { kind: "error", score: 0 };
  if (bottleneck <= 5) return { kind: "blocked", score: bottleneck };
  if (bottleneck <= 15) return { kind: "low", score: bottleneck };
  if (bottleneck <= 30) return { kind: "watch", score: bottleneck };
  return { kind: "ready", score: bottleneck };
}

function subDisplayName(entry) {
  const providerNames = {
    "openai-codex": "ChatGPT Plus/Pro (Codex)",
    anthropic: "Anthropic (Claude Pro/Max)",
  };
  const providerName = `${providerNames[entry.provider] || entry.provider} #${entry.index}`;
  if (!entry.label) return providerName;
  return `${entry.label} — ${providerName}`;
}

function runWindowClassificationChecks() {
  const resetAt = Math.floor(Date.now() / 1000) + 3600;
  const snapshot = parseCodexUsageSnapshot({
    plan_type: "pro",
    email: "test@example.com",
    rate_limit: {
      // Intentionally reversed from the human-friendly order.
      primary_window: {
        used_percent: 35,
        limit_window_seconds: 7 * 24 * 60 * 60,
        reset_at: resetAt + 6 * 24 * 60 * 60,
      },
      secondary_window: {
        used_percent: 10,
        limit_window_seconds: 5 * 60 * 60,
        reset_at: resetAt,
      },
    },
  });

  assert.equal(snapshot.planType, "pro");
  assert.equal(snapshot.email, "test@example.com");
  assert.equal(snapshot.fiveHour.windowSeconds, 5 * 60 * 60);
  assert.equal(snapshot.weekly.windowSeconds, 7 * 24 * 60 * 60);
  assert.equal(getCodexWindowRemaining(snapshot.fiveHour), 90);
  assert.equal(getCodexWindowRemaining(snapshot.weekly), 65);
}

function runSeverityChecks() {
  assert.equal(
    classifyCodexQuotaKind({ fiveHour: { usedPercent: 20 }, weekly: { usedPercent: 40 } }).kind,
    "ready",
  );
  assert.equal(
    classifyCodexQuotaKind({ fiveHour: { usedPercent: 75 }, weekly: { usedPercent: 20 } }).kind,
    "watch",
  );
  assert.equal(
    classifyCodexQuotaKind({ fiveHour: { usedPercent: 88 }, weekly: { usedPercent: 15 } }).kind,
    "low",
  );
  assert.equal(
    classifyCodexQuotaKind({ fiveHour: { usedPercent: 97 }, weekly: { usedPercent: 10 } }).kind,
    "blocked",
  );
  assert.equal(classifyCodexQuotaKind({}).kind, "error");
}

function runGoogleGeminiQuotaParsingChecks() {
  const snapshot = parseGoogleGeminiQuotaSnapshot({
    buckets: [
      {
        modelId: "Gemini 2.5 Pro",
        remainingFraction: 0.82,
        resetTime: "2026-03-21T12:00:00Z",
      },
      {
        modelId: "Gemini 2.5 Flash",
        remainingFraction: 0.25,
        resetTime: "2026-03-20T18:30:00Z",
      },
      {
        modelId: "Gemini 2.5 Pro",
        remainingFraction: 0.61,
      },
    ],
  }, "project-123");

  assert.equal(snapshot.projectId, "project-123");
  assert.equal(snapshot.endpoint, "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota");
  assert.equal(snapshot.models.length, 2);
  assert.equal(snapshot.models.find((model) => model.model === "Pro")?.remainingPercent, 61);
  assert.equal(snapshot.models.find((model) => model.model === "Flash")?.remainingPercent, 25);
  assert.ok(snapshot.models.find((model) => model.model === "Pro")?.resetAt > 0);
  assert.equal(snapshot.worstRemainingPercent, 25);
}

function runGoogleAntigravityQuotaParsingChecks() {
  const snapshot = parseGoogleAntigravityQuotaSnapshot({
    models: {
      "gemini-3-pro-high": {
        displayName: "G3 Pro",
        quotaInfo: {
          remainingFraction: 0.7,
          resetTime: "2026-03-21T10:00:00Z",
        },
      },
      duplicate: {
        displayName: "G3 Pro",
        quotaInfo: {
          remainingFraction: 0.42,
        },
      },
      hidden: {
        displayName: "tab_flash_lite_preview",
        quotaInfo: { remainingFraction: 0.99 },
      },
      internal: {
        displayName: "Internal",
        isInternal: true,
        quotaInfo: { remainingFraction: 0.01 },
      },
      flash: {
        model: "G3 Flash",
        quotaInfo: {
          remainingFraction: 0.88,
          resetTime: "2026-03-20T18:30:00Z",
        },
      },
    },
  }, "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:fetchAvailableModels", "project-456");

  assert.equal(snapshot.projectId, "project-456");
  assert.equal(snapshot.models.length, 2);
  assert.equal(snapshot.models.find((model) => model.model === "G3 Pro")?.remainingPercent, 42);
  assert.equal(snapshot.models.find((model) => model.model === "G3 Flash")?.remainingPercent, 88);
  assert.ok(snapshot.models.find((model) => model.model === "G3 Flash")?.resetAt > 0);
  assert.equal(snapshot.worstRemainingPercent, 42);
}

function runGoogleClassificationChecks() {
  assert.equal(classifyGoogleQuotaKind({ worstRemainingPercent: 80 }).kind, "ready");
  assert.equal(classifyGoogleQuotaKind({ worstRemainingPercent: 25 }).kind, "watch");
  assert.equal(classifyGoogleQuotaKind({ worstRemainingPercent: 10 }).kind, "low");
  assert.equal(classifyGoogleQuotaKind({ worstRemainingPercent: 3 }).kind, "blocked");
  assert.equal(classifyGoogleQuotaKind({ worstRemainingPercent: undefined }).kind, "error");
}

function runDisplayNameChecks() {
  assert.equal(
    subDisplayName({ provider: "openai-codex", index: 2 }),
    "ChatGPT Plus/Pro (Codex) #2",
  );
  assert.equal(
    subDisplayName({ provider: "openai-codex", index: 3, label: "Outlook" }),
    "Outlook — ChatGPT Plus/Pro (Codex) #3",
  );
}

function runLimitsArrayParsingChecks() {
  // Test 1: limits[] array with TIME_LIMIT + TOKENS_LIMIT
  const snapshot1 = parseCodexUsageSnapshot({
    plan_type: "plus",
    limits: [
      { type: "TIME_LIMIT", percentage: 99 },
      { type: "TOKENS_LIMIT", percentage: 33 },
    ],
  });
  assert.equal(snapshot1.planType, "plus");
  assert.ok(snapshot1.fiveHour, "Should parse session from TIME_LIMIT");
  assert.equal(snapshot1.fiveHour.usedPercent, 99);
  assert.ok(snapshot1.weekly, "Should parse weekly from TOKENS_LIMIT");
  assert.equal(snapshot1.weekly.usedPercent, 33);

  const kind1 = classifyCodexQuotaKind(snapshot1);
  assert.equal(kind1.kind, "blocked", "1% remaining should be blocked");
  assert.equal(kind1.score, 1);

  // Test 2: limits[] inside data.data.limits
  const snapshot2 = parseCodexUsageSnapshot({
    data: {
      limits: [
        { type: "SESSION_LIMIT", utilization: 0.85 },
        { type: "WEEKLY_LIMIT", utilization: 0.40 },
      ],
    },
  });
  assert.ok(snapshot2.fiveHour, "Should parse session from data.data.limits");
  assert.equal(snapshot2.fiveHour.usedPercent, 85);
  assert.ok(snapshot2.weekly);
  assert.equal(snapshot2.weekly.usedPercent, 40);

  // Test 3: limits[] with currentValue/remaining fallback
  const snapshot3 = parseCodexUsageSnapshot({
    limits: [
      { type: "REQUEST_LIMIT", currentValue: 80, remaining: 20 },
      { type: "WEEK_LIMIT", currentValue: 30, remaining: 70 },
    ],
  });
  assert.ok(snapshot3.fiveHour);
  assert.equal(snapshot3.fiveHour.usedPercent, 80);
  assert.ok(snapshot3.weekly);
  assert.equal(snapshot3.weekly.usedPercent, 30);

  // Test 4: No limits[] → falls back to legacy format
  const snapshot4 = parseCodexUsageSnapshot({
    rate_limit: {
      primary_window: { used_percent: 50, limit_window_seconds: 5 * 60 * 60 },
      secondary_window: { used_percent: 25, limit_window_seconds: 7 * 24 * 60 * 60 },
    },
  });
  assert.ok(snapshot4.fiveHour, "Should fall back to legacy format");
  assert.equal(snapshot4.fiveHour.usedPercent, 50);
  assert.ok(snapshot4.weekly);
  assert.equal(snapshot4.weekly.usedPercent, 25);

  console.log("limits-array parsing checks passed");
}

function runUsageBarsCacheChecks() {
  // Mirror the logic from multi-sub.ts tryBuildFromUsageBarsCache
  function tryBuildFromCache(session, weekly, ageMs) {
    const TTL = 30_000;
    if (ageMs > TTL) return null;

    const sessionLeft = Math.max(0, Math.min(100, 100 - session));
    const weeklyLeft = Math.max(0, Math.min(100, 100 - weekly));
    const bottleneck = Math.min(sessionLeft, weeklyLeft);

    let kind;
    if (bottleneck <= 6) kind = "blocked";
    else if (bottleneck <= 15) kind = "low";
    else if (bottleneck <= 30) kind = "watch";
    else kind = "ready";

    return { kind, score: bottleneck, sessionLeft, weeklyLeft };
  }

  // Test 1: session 100%, weekly 35% → blocked (session bottleneck = 0%)
  const r1 = tryBuildFromCache(100, 35, 0);
  assert.equal(r1.kind, "blocked");
  assert.equal(r1.score, 0);

  // Test 2: session 10%, weekly 35% → ready (bottleneck = 65%)
  const r2 = tryBuildFromCache(10, 35, 0);
  assert.equal(r2.kind, "ready");
  assert.equal(r2.score, 65);
  assert.equal(r2.sessionLeft, 90);
  assert.equal(r2.weeklyLeft, 65);

  // Test 3: session 90%, weekly 50% → low (bottleneck = 10%)
  const r3 = tryBuildFromCache(90, 50, 0);
  assert.equal(r3.kind, "low");
  assert.equal(r3.score, 10);

  // Test 4: stale cache (> 30s) → returns null
  const r4 = tryBuildFromCache(50, 50, 31_000);
  assert.equal(r4, null);

  // Test 5: session 75%, weekly 80% → watch (bottleneck = 20%)
  const r5 = tryBuildFromCache(75, 80, 5_000);
  assert.equal(r5.kind, "watch");
  assert.equal(r5.score, 20);

  // Test 6: session 94%, weekly 94% → blocked (bottleneck = 6%)
  const r6 = tryBuildFromCache(94, 94, 0);
  assert.equal(r6.kind, "blocked");
  assert.equal(r6.score, 6);

  // Test 7: session 85%, weekly 85% → low (bottleneck = 15%)
  const r7 = tryBuildFromCache(85, 85, 0);
  assert.equal(r7.kind, "low");
  assert.equal(r7.score, 15);

  console.log("usage-bars cache checks passed");
}


runWindowClassificationChecks();
runSeverityChecks();
runLimitsArrayParsingChecks();
runGoogleGeminiQuotaParsingChecks();
runGoogleAntigravityQuotaParsingChecks();
runGoogleClassificationChecks();
runDisplayNameChecks();
runUsageBarsCacheChecks();
console.log("subscription limit checks passed");
