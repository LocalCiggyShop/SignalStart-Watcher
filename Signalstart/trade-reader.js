// Loaded in Chrome's isolated content-script world, and shared with the background validator.
globalThis.SignalStartTradeReader = (() => {
  const text = value => String(value ?? "").replace(/\s+/g, " ").trim();
  const number = value => {
    const raw = text(value);
    if (!/^(?:\d+(?:\.\d+)?|\d{1,3}(?:,\d{3})+(?:\.\d+)?)$/.test(raw)) return null;
    const result = Number(raw.replace(/,/g, ""));
    return Number.isFinite(result) ? result : null;
  };
  const unavailable = reason => ({ status: "unavailable", reason });
  function validate(details, count) {
    if (count === 0) return { status: "flat", reason: "Waiting for a new open trade." };
    if (count > 1) return { status: "multiple", reason: "Multiple open trades: alerts only." };
    if (count !== 1) return unavailable("Open-trade count is unavailable.");
    if (details?.status !== "ready") return unavailable(text(details?.reason || "Waiting for visible open-trade details.").slice(0, 180));
    const symbol = text(details.symbol);
    if (!/^[A-Za-z0-9][A-Za-z0-9._#& -]{0,39}$/.test(symbol)) return unavailable("The open-trade symbol is unavailable.");
    if (!Number.isFinite(details.lots) || details.lots <= 0) return unavailable("The open-trade lot size is unavailable.");
    if (![details.sl, details.tp].every(value => Number.isFinite(value) && value >= 0))
      return unavailable("SL/TP are hidden or unavailable; they cannot be assumed absent.");
    return { status: "ready", reason: "", symbol, lots: details.lots, sl: details.sl, tp: details.tp,
      side: details.side === 1 || details.side === -1 ? details.side : 0,
      identity: text(details.identity).slice(0, 120) };
  }
  function read(doc, count) {
    if (count !== 1) return validate(null, count);
    // Never consult History, aggregate Lots, or Open Orders for a live position.
    const section = doc.getElementById("openTradesListData");
    const table = section?.querySelector("#openTradesTable");
    if (!table) return unavailable("The live Open Trades table is unavailable.");
    const headers = [...table.querySelectorAll("thead th")].map(cell => text(cell.textContent).toLowerCase().replace(/[^a-z0-9]/g, ""));
    const rows = [...table.querySelectorAll("tbody tr")].filter(row => row.querySelectorAll("td").length > 1);
    if (rows.length !== 1) return unavailable("Waiting for one complete Open Trades row matching the counter.");
    const cells = [...rows[0].querySelectorAll("td")];
    function cell(names) {
      const index = headers.findIndex(header => names.includes(header));
      if (index < 0 || !cells[index]) return null;
      const element = cells[index];
      if (element.querySelector(".fa-lock, .glyphicon-lock, [data-content*='subscription']")) return null;
      return text(element.textContent);
    }
    const symbol = cell(["symbol"]), lots = number(cell(["lots", "volumelots"]));
    if (!symbol) return unavailable("SignalStart has hidden the open-trade symbol.");
    if (lots == null || lots <= 0) return unavailable("SignalStart has hidden the lot size. The page must expose it to copy a trade.");
    const slText = cell(["sl", "stoploss"]), tpText = cell(["tp", "takeprofit"]);
    const stop = value => value != null && /^(?:-|—|–|none)$/i.test(value) ? 0 : number(value);
    const action = cell(["action", "type"]);
    return validate({ status: "ready", symbol, lots, sl: stop(slText), tp: stop(tpText),
      side: /^buy$/i.test(action || "") ? 1 : /^sell$/i.test(action || "") ? -1 : 0,
      identity: [cell(["opendate"]), symbol, action, lots].join("|") }, count);
  }

  function validateOpenTradeKeys(keys, count) {
    if (count === 0) return [];
    if (!Array.isArray(keys) || keys.length !== count || keys.length > 1000 ||
        keys.some(key => typeof key !== "string" || !key.length || key.length > 180)) return null;
    return [...keys].sort();
  }

  function openTradeKeysFromRows(headers, rows, count) {
    if (count === 0) return [];
    if (!Number.isSafeInteger(count) || count <= 0) return null;
    const columns = headers.map(header => text(header).toLowerCase().replace(/[^a-z0-9]/g, ""));
    const date = columns.findIndex(header => header === "opendate" || header === "opentime");
    const symbol = columns.indexOf("symbol");
    if (date < 0 || symbol < 0) return null;

    const keys = [];
    for (const cells of rows) {
      if (cells.length <= 1) continue;
      const openedAt = text(cells[date]);
      const instrument = text(cells[symbol]).toUpperCase();
      if (!openedAt || !instrument) return null;
      keys.push(JSON.stringify([openedAt, instrument]));
    }
    return validateOpenTradeKeys(keys, count);
  }

  function readOpenTradeKeys(doc, count) {
    if (count === 0) return [];
    if (!Number.isSafeInteger(count) || count <= 0) return null;
    const table = doc.getElementById("openTradesListData")?.querySelector("#openTradesTable");
    if (!table) return null;
    const headers = [...table.querySelectorAll("thead th")].map(cell => cell.textContent);
    const rows = [...table.querySelectorAll("tbody tr")].map(
      row => [...row.querySelectorAll("td")].map(cell => cell.textContent)
    );
    return openTradeKeysFromRows(headers, rows, count);
  }

  return Object.freeze({ read, validate, readOpenTradeKeys, openTradeKeysFromRows, validateOpenTradeKeys });
})();
