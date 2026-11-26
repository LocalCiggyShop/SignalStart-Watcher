import "./trade-reader.js";

export const STORAGE_KEYS = {
  signals: "signals",
  settings: "settings"
};

export const DEFAULT_SETTINGS = {
  pollMinutes: 5,
  changePercent: 0,
  alertOnLeaveZero: true,
  alertOnAnyChange: true,
  alertOnOpenTrades: true,
  alertOnDrawdown: false,
  drawdownAmount: 100,
  playSound: true,
  notificationsEnabled: true
};

export const POLL_MINUTES_OPTIONS = [5, 15, 30, 60];

export function pollMinutesFromSettings(settings) {
  const minutes = Number(settings?.pollMinutes);
  return POLL_MINUTES_OPTIONS.includes(minutes) ? minutes : 5;
}

const ANALYSIS_RE =
  /(?:https?:\/\/(?:www\.)?signalstart\.com)?\/analysis\/([^/?#]+)\/(\d+)/i;
const LINK_RE =
  /href=["'](?:https?:\/\/(?:www\.)?signalstart\.com)?\/analysis\/([^/"'?#]+)\/(\d+)["'][^>]*>([^<]+)/gi;

export function parseAnalysisUrl(url) {
  if (!url) return null;
  const match = String(url).trim().match(ANALYSIS_RE);
  if (!match) return null;
  return {
    slug: match[1],
    id: match[2],
    url: `https://www.signalstart.com/analysis/${match[1]}/${match[2]}`
  };
}

export function decodeHtmlEntities(value) {
  return String(value)
    .replace(/&nbsp;/gi, " ")
    .replace(/&minus;/gi, "-")
    .replace(/&#36;/g, "$")
    .replace(/&#128;/g, "€")
    .replace(/&#8364;/g, "€")
    .replace(/&euro;/gi, "€")
    .replace(/&#163;/g, "£")
    .replace(/&pound;/gi, "£")
    .replace(/&#165;/g, "¥")
    .replace(/&yen;/gi, "¥")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16))
    )
    .replace(/&#(\d+);/g, (_, num) => {
      const code = Number(num);
      if (code === 128) return "€";
      return String.fromCharCode(code);
    })
    .replace(/&amp;/g, "&");
}

export function parseMoney(text) {
  if (text == null) return null;
  const decoded = decodeHtmlEntities(String(text)).replace(/\s+/g, " ").trim();
  if (!decoded) return null;
  const compact = decoded.replace(/\s+/g, "");
  const negative =
    /^\(.*\)$/.test(compact) ||
    /^[-−–]/.test(compact) ||
    /[-−–][$€£¥]/.test(compact) ||
    /[$€£¥][-−–]/.test(compact);
  const numeric = decoded
    .replace(/[()]/g, "")
    .replace(/[^\d,.]/g, "")
    .replace(/,/g, "");
  if (!numeric) return null;
  const value = Number(numeric);
  if (!Number.isFinite(value)) return null;
  return negative ? -Math.abs(value) : value;
}

function extractLabeledValue(html, label) {
  const re = new RegExp(
    `${label}\\s*:\\s*<span[^>]*>\\s*([\\s\\S]*?)</span>`,
    "i"
  );
  const match = html.match(re);
  if (!match) return null;
  const display = decodeHtmlEntities(match[1])
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return {
    display,
    value: parseMoney(display)
  };
}

function openTradeKeysFromHtml(html, count) {
  if (count === 0) return [];
  if (!Number.isSafeInteger(count) || count <= 0) return null;
  const table = html.match(/<table\b[^>]*\sid\s*=\s*["']openTradesTable["'][^>]*>([\s\S]*?)<\/table>/i)?.[1];
  const head = table?.match(/<thead\b[^>]*>([\s\S]*?)<\/thead>/i)?.[1];
  const body = table?.match(/<tbody\b[^>]*>([\s\S]*?)<\/tbody>/i)?.[1];
  if (!head || !body) return null;

  const cellText = ([, content]) => decodeHtmlEntities(content.replace(/<[^>]+>/g, ""));
  const headers = Array.from(head.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi), cellText);
  const rows = Array.from(body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi), ([, row]) =>
    Array.from(row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi), cellText)
  );
  return globalThis.SignalStartTradeReader.openTradeKeysFromRows(headers, rows, count);
}

export function parseStatsFromHtml(html) {
  if (!html) return null;
  const floating = extractLabeledValue(html, "Floating\\s*PL");
  if (!floating || floating.value == null) return null;

  const openTradesMatch = html.match(/Open\s*Trades\s*\((\d+)\)/i);
  const openTrades = openTradesMatch ? Number(openTradesMatch[1]) : null;
  const freshnessMatch = html.match(/caption-helper[^>]*>\s*([^<]+?ago)\s*</i);
  const nameMatch =
    html.match(/<h1[^>]*>\s*([^<]+?)\s*(?:Forex Signals)?\s*<\/h1>/i) ||
    html.match(/<title>\s*Forex Signals by ([^<]+?)\s*\|/i);

  let name = nameMatch ? decodeHtmlEntities(nameMatch[1]).trim() : "";
  name = name.replace(/\s*Forex Signals\s*$/i, "").trim();

  return {
    floatingDisplay: floating.display,
    floatingValue: floating.value,
    openTrades,
    openTradeKeys: openTradeKeysFromHtml(html, openTrades),
    freshness: freshnessMatch ? decodeHtmlEntities(freshnessMatch[1]).trim() : null,
    name: name || null
  };
}

export function parseSignalLinks(html) {
  const seen = new Set();
  const results = [];
  LINK_RE.lastIndex = 0;
  let match;
  while ((match = LINK_RE.exec(html))) {
    const id = match[2];
    if (seen.has(id)) continue;
    seen.add(id);
    const name = decodeHtmlEntities(match[3]).replace(/\s+/g, " ").trim();
    if (!name) continue;
    results.push({
      id,
      name,
      url: `https://www.signalstart.com/analysis/${match[1]}/${id}`
    });
  }
  return results;
}

export function tidyName(next, fallback) {
  const value = String(next || "")
    .replace(/\s*Forex Signals\s*/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return value || fallback || "Signal";
}

export function isZero(value) {
  return Math.abs(Number(value) || 0) < 0.005;
}

export function valuesEqual(a, b) {
  return Math.abs((Number(a) || 0) - (Number(b) || 0)) < 0.005;
}

export function percentChange(from, to) {
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  if (isZero(from)) return isZero(to) ? 0 : null;
  return ((to - from) / Math.abs(from)) * 100;
}

export function formatPercent(pct) {
  if (pct == null || !Number.isFinite(pct)) return null;
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(2)}%`;
}

export function evaluateAlert(previous, next, settings) {
  const merged = { ...DEFAULT_SETTINGS, ...settings };
  const floating = evaluateFloatingAlert(previous, next, merged);
  if (!merged.alertOnOpenTrades || !Number.isSafeInteger(previous?.openTrades) ||
      !Number.isSafeInteger(next?.openTrades)) return floating;

  const countIncrease = next.openTrades - previous.openTrades;
  let newEntries = 0;
  if (Array.isArray(previous.openTradeKeys) && Array.isArray(next.openTradeKeys)) {
    const existing = new Map();
    for (const key of previous.openTradeKeys) {
      existing.set(key, (existing.get(key) || 0) + 1);
    }
    for (const key of next.openTradeKeys) {
      const remaining = existing.get(key) || 0;
      if (remaining) existing.set(key, remaining - 1);
      else newEntries++;
    }
  }
  const opened = Math.max(countIncrease, newEntries);
  if (opened <= 0) return floating;

  const tradeMessage = countIncrease > 0
    ? `Open trades increased from ${previous.openTrades} to ${next.openTrades}.`
    : `${next.openTrades} open ${next.openTrades === 1 ? "trade" : "trades"} now.`;
  return {
    shouldAlert: true,
    kind: "open-trades",
    title: opened === 1 ? "New trade opened" : `${opened} new trades opened`,
    message: floating.shouldAlert ? `${tradeMessage} ${floating.message}` : tradeMessage
  };
}

function evaluateFloatingAlert(previous, next, settings) {
  if (!next || next.floatingValue == null) {
    return { shouldAlert: false, reason: "missing" };
  }
  if (previous == null || previous.floatingValue == null) {
    return { shouldAlert: false, reason: "baseline" };
  }

  const prevZero = isZero(previous.floatingValue);
  const nextZero = isZero(next.floatingValue);
  const plChanged = !valuesEqual(previous.floatingValue, next.floatingValue);
  const pct = percentChange(previous.floatingValue, next.floatingValue);
  const pctText = formatPercent(pct);
  const threshold = Number(settings.changePercent);
  const meetsPercent =
    !Number.isFinite(threshold) || threshold <= 0
      ? plChanged
      : pct != null && Math.abs(pct) >= threshold;
  const changeSuffix = pctText ? ` (${pctText} since last check)` : "";
  const drawdownAmount = Number(settings.drawdownAmount);
  if (
    settings.alertOnDrawdown &&
    Number.isFinite(drawdownAmount) &&
    drawdownAmount >= 0.01 &&
    Number.isFinite(previous.floatingValue) &&
    Number.isFinite(next.floatingValue) &&
    previous.floatingValue > -drawdownAmount &&
    next.floatingValue <= -drawdownAmount
  ) {
    return {
      shouldAlert: true,
      kind: "drawdown",
      title: "Floating PL loss threshold reached",
      message: `Floating PL moved from ${previous.floatingDisplay} to ${next.floatingDisplay}, reaching your loss threshold of ${drawdownAmount}.`
    };
  }

  if (prevZero && nextZero) {
    return { shouldAlert: false, reason: "still-zero" };
  }

  if (prevZero && !nextZero && settings.alertOnLeaveZero) {
    const wentNegative = next.floatingValue < 0;
    return {
      shouldAlert: true,
      kind: "left-zero",
      title: wentNegative ? "Floating PL went negative" : "Floating PL left $0",
      message: `Floating PL moved from ${previous.floatingDisplay} to ${next.floatingDisplay}`
    };
  }

  if (plChanged && settings.alertOnAnyChange && meetsPercent) {
    return {
      shouldAlert: true,
      kind: nextZero ? "returned-zero" : "changed",
      title: nextZero ? "Floating PL returned to $0" : "Floating PL changed",
      message: `Floating PL moved from ${previous.floatingDisplay} to ${next.floatingDisplay}${changeSuffix}`
    };
  }

  return { shouldAlert: false, reason: "unchanged" };
}

function unwrapSearchList(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.accounts)) return data.accounts;
  if (Array.isArray(data?.data?.accounts)) return data.data.accounts;
  if (Array.isArray(data?.content)) return data.content;
  if (Array.isArray(data?.content?.data)) return data.content.data;
  if (Array.isArray(data?.content?.accounts)) return data.content.accounts;
  return [];
}

function mapSearchItem(item) {
  if (!item || typeof item !== "object") return null;
  const parsedLink = parseAnalysisUrl(item.link || item.url || "");
  const id = String(parsedLink?.id || item.oid || item.id || "").replace(/^S/i, "");
  const slug = parsedLink?.slug;
  const name = String(item.name || item.label || slug || "").trim();
  if (!id || !name) return null;
  return {
    id,
    name,
    url: parsedLink?.url || (slug ? `https://www.signalstart.com/analysis/${slug}/${id}` : null),
    gain: item.gain
  };
}

export async function searchSignals(query) {
  const input = String(query || "").trim();
  if (!input) return [];

  const parsed = parseAnalysisUrl(input);
  if (parsed) {
    return [
      {
        id: parsed.id,
        name: parsed.slug.replace(/-/g, " "),
        url: parsed.url
      }
    ];
  }

  try {
    const response = await fetch("https://www.signalstart.com/autoCompleteSearch.json", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        Accept: "application/json"
      },
      body: new URLSearchParams({ input }),
      cache: "no-store",
      credentials: "include"
    });
    if (response.ok) {
      const data = await response.json();
      const mapped = unwrapSearchList(data).map(mapSearchItem).filter((item) => item && item.url);
      if (mapped.length) return mapped;
    }
  } catch {
    // Fall through to HTML search.
  }

  try {
    const response = await fetch("https://www.signalstart.com/paging.html", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8"
      },
      body: new URLSearchParams({
        pt: "1",
        st: "0",
        sb: "3",
        p: "1",
        ps: "40",
        searchVal: input
      }),
      cache: "no-store",
      credentials: "include"
    });
    if (response.ok) {
      const matches = parseSignalLinks(await response.text());
      if (matches.length) return matches;
    }
  } catch {
    // Fall through to the public catalog.
  }

  const catalogResponse = await fetch("https://www.signalstart.com/search-signals", {
    cache: "no-store",
    credentials: "include"
  });
  if (!catalogResponse.ok) return [];
  const needle = input.toLowerCase();
  return parseSignalLinks(await catalogResponse.text()).filter((item) =>
    item.name.toLowerCase().includes(needle)
  );
}

export async function fetchSignalStats(url, { signal } = {}) {
  const parsed = parseAnalysisUrl(url);
  if (!parsed) {
    throw new Error("Invalid SignalStart analysis URL");
  }
  const response = await fetch(parsed.url, {
    cache: "no-store",
    signal,
    credentials: "include",
    headers: { Accept: "text/html" }
  });
  if (!response.ok) {
    throw new Error(`Could not load signal page (${response.status})`);
  }
  const html = await response.text();
  const stats = parseStatsFromHtml(html);
  if (!stats) {
    throw new Error("Could not find Floating PL on that page");
  }
  return { ...parsed, ...stats };
}

export function createTrackedSignal({ id, name, url, slug }) {
  const parsed = parseAnalysisUrl(url) || { id, slug, url };
  return {
    id: String(parsed.id || id),
    name: tidyName(name, parsed.slug || String(id)),
    slug: parsed.slug || slug || "",
    url: parsed.url || url,
    enabled: true,
    floatingValue: null,
    floatingDisplay: "—",
    openTrades: null,
    freshness: null,
    lastCheckedAt: null,
    lastAlertAt: null,
    lastKind: null,
    lastSource: null,
    lastChangePercent: null,
    error: null
  };
}
