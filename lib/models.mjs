/**
 * Model catalog discovery, slug/display-name resolution, and Orchestrator detection
 * for `agy --output-format json models`.
 */

import { spawnSync } from "node:child_process";

/**
 * Returns true if the model string names an Orchestrator model (where `--effort` must be omitted).
 *
 * @param {string | null | undefined} modelStr
 * @returns {boolean}
 */
export function isOrchestratorModel(modelStr) {
  return /orchestrator/i.test(String(modelStr || ""));
}

function extractJsonValue(rawText) {
  const trimmed = String(rawText || "").trim();
  if (!trimmed) {
    return null;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    // Spinner frames (with \r) or warning lines may precede the JSON envelope.
  }

  const candidates = [];
  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    if (ch !== "{" && ch !== "[") {
      continue;
    }
    if (i === 0 || trimmed[i - 1] === "\n" || trimmed[i - 1] === "\r") {
      candidates.push(i);
    }
  }

  for (const idx of candidates) {
    try {
      return JSON.parse(trimmed.slice(idx));
    } catch {
      // Keep scanning candidate JSON boundaries.
    }
  }

  return null;
}

function normalizeModelEntry(entry) {
  if (typeof entry === "string") {
    const slug = entry.trim();
    return slug ? { slug, displayName: slug } : null;
  }
  if (!entry || typeof entry !== "object") {
    return null;
  }
  const slug = String(entry.slug ?? entry.id ?? entry.name ?? "").trim();
  if (!slug) {
    return null;
  }
  const displayName = String(
    entry.displayName ?? entry.display_name ?? entry.label ?? entry.title ?? slug
  ).trim();
  return { slug, displayName: displayName || slug };
}

function parseTabSeparatedModels(text) {
  const models = [];
  const seen = new Set();
  for (const line of String(text || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const tabIdx = trimmed.indexOf("\t");
    let slug;
    let displayName;
    if (tabIdx >= 0) {
      slug = trimmed.slice(0, tabIdx).trim();
      displayName = trimmed.slice(tabIdx + 1).trim() || slug;
    } else {
      slug = trimmed;
      displayName = trimmed;
    }
    if (slug && !seen.has(slug)) {
      seen.add(slug);
      models.push({ slug, displayName });
    }
  }
  return models;
}

/**
 * Parses stdout from `agy --output-format json models`.
 * Supports the live `JSONOutput` envelope (`response` with `<slug>\t<displayName>\n` lines),
 * `command.data.models`, `command.data` array, or a direct model array.
 *
 * @param {string} stdout
 * @returns {Array<{ slug: string, displayName: string }>}
 */
export function parseModelsJsonOutput(stdout) {
  const parsed = extractJsonValue(stdout);
  if (!parsed) {
    return [];
  }

  if (Array.isArray(parsed)) {
    return parsed.map(normalizeModelEntry).filter(Boolean);
  }

  if (typeof parsed === "object") {
    if (typeof parsed.response === "string" && parsed.response.trim()) {
      const fromResponse = parseTabSeparatedModels(parsed.response);
      if (fromResponse.length > 0) {
        return fromResponse;
      }
    }

    const fallbackList = Array.isArray(parsed.command?.data?.models)
      ? parsed.command.data.models
      : Array.isArray(parsed.command?.data)
        ? parsed.command.data
        : Array.isArray(parsed.models)
          ? parsed.models
          : Array.isArray(parsed.data)
            ? parsed.data
            : null;

    if (fallbackList) {
      return fallbackList.map(normalizeModelEntry).filter(Boolean);
    }
  }

  return [];
}

/**
 * Queries the local `agy` binary for available models.
 * Places `--output-format json` strictly before the `models` subcommand.
 *
 * @param {{ agyBin?: string, timeoutMs?: number, env?: NodeJS.ProcessEnv }} [opts]
 * @returns {{ ok: boolean, models: Array<{ slug: string, displayName: string }>, error: string | null }}
 */
export function fetchModelCatalog({
  agyBin = "agy",
  timeoutMs = 15000,
  env = process.env,
} = {}) {
  const res = spawnSync(agyBin, ["--output-format", "json", "models"], {
    encoding: "utf8",
    env,
    timeout: timeoutMs,
  });

  if (res.error) {
    return {
      ok: false,
      models: [],
      error: res.error.message || "Failed to execute agy models",
    };
  }

  if (res.status !== 0) {
    return {
      ok: false,
      models: [],
      error: (res.stderr || res.stdout || `agy models exited with status ${res.status}`).trim(),
    };
  }

  const models = parseModelsJsonOutput(res.stdout || "");
  if (models.length === 0) {
    const parsed = extractJsonValue(res.stdout || "");
    const errDetail =
      parsed && typeof parsed === "object" && typeof parsed.error === "string"
        ? parsed.error
        : "No models found in agy models output";
    return { ok: false, models: [], error: errDetail };
  }

  return { ok: true, models, error: null };
}

function damerauLevenshtein(a, b) {
  const la = a.length;
  const lb = b.length;
  if (la === 0) return lb;
  if (lb === 0) return la;

  const dp = Array.from({ length: la + 1 }, () => new Array(lb + 1).fill(0));
  for (let i = 0; i <= la; i += 1) dp[i][0] = i;
  for (let j = 0; j <= lb; j += 1) dp[0][j] = j;

  for (let i = 1; i <= la; i += 1) {
    for (let j = 1; j <= lb; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let val = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        val = Math.min(val, dp[i - 2][j - 2] + cost);
      }
      dp[i][j] = val;
    }
  }
  return dp[la][lb];
}

function suggestModels(query, catalog, limit = 5) {
  const q = query.toLowerCase();
  const qTokens = q.split(/[\s\-_()]+/).filter(Boolean);

  const scored = catalog.map((entry) => {
    const slugLower = entry.slug.toLowerCase();
    const dispLower = entry.displayName.toLowerCase();
    let score = Math.min(
      damerauLevenshtein(q, slugLower),
      damerauLevenshtein(q, dispLower)
    );
    if (slugLower.includes(q) || dispLower.includes(q)) {
      score -= 10;
    } else if (qTokens.length > 0) {
      const hits = qTokens.filter(
        (tok) => slugLower.includes(tok) || dispLower.includes(tok)
      ).length;
      score -= hits * 2;
    }
    return { slug: entry.slug, score };
  });

  scored.sort((a, b) => a.score - b.score || a.slug.localeCompare(b.slug));
  return scored.slice(0, limit).map((s) => s.slug);
}

/**
 * Resolves a requested model slug or display name against a catalog.
 * Passes through `requested` unvalidated when catalog is empty/unavailable.
 *
 * @param {string | null | undefined} requested
 * @param {Array<{ slug: string, displayName: string }> | null | undefined} catalog
 * @returns {{ ok: true, slug: string | null, displayName: string | null, isOrchestrator: boolean } | { ok: false, error: string, suggestions: string[] }}
 */
export function resolveModelSlug(requested, catalog) {
  if (typeof requested !== "string" || !requested.trim()) {
    return { ok: true, slug: null, displayName: null, isOrchestrator: false };
  }

  const query = requested.trim();
  if (!Array.isArray(catalog) || catalog.length === 0) {
    return {
      ok: true,
      slug: query,
      displayName: null,
      isOrchestrator: isOrchestratorModel(query),
    };
  }

  const qLower = query.toLowerCase();
  const match =
    catalog.find((m) => m.slug === query) ||
    catalog.find((m) => m.displayName === query) ||
    catalog.find((m) => m.slug.toLowerCase() === qLower) ||
    catalog.find((m) => m.displayName.toLowerCase() === qLower);

  if (match) {
    return {
      ok: true,
      slug: match.slug,
      displayName: match.displayName,
      isOrchestrator:
        isOrchestratorModel(match.slug) || isOrchestratorModel(match.displayName),
    };
  }

  const suggestions = suggestModels(query, catalog);
  const hint = suggestions.length > 0 ? ` Did you mean: ${suggestions.join(", ")}?` : "";
  return {
    ok: false,
    error: `Unknown model '${query}'.${hint}`,
    suggestions,
  };
}
