# SignalStart browser to MT5

The MT5 connection is currently unavailable in the extension. The instructions below describe the bridge in version 1.2.1.

## Install or update — no command required

1. Reload the unpacked extension and reload its SignalStart analysis tabs. Open the extension popup and copy the **Extension ID** under **MT5 connection**.
2. Double-click **SetupBridge.exe** in this directory. Paste the ID and click **Install / update helper**. Administrator access and PowerShell are not needed. Setup registers only that extension for the current Windows user, using Chrome, Brave and Edge native-messaging keys.
3. Click **Open EA folder** in setup. In your MT5 terminal, select **File → Open Data Folder → MQL5 → Experts**. Copy the supplied **SignalStartBridge.ex5** into that folder, replacing the old EA, then refresh MT5's Navigator and reattach the EA to a spare chart. The installer does not attach an EA or enable trading.
4. Reload the extension again so Chrome starts the updated helper. Choose the signal under **Send this signal to MT5** and keep its analysis tab open. **Local helper ready** confirms the file write; the EA panel confirms MT5 received it.
5. After the EA has received its first snapshot, press **Test MT5 alert** in the extension. Check MT5's panel, alert window and Experts log.

Setup embeds both the helper and compiled EA. Installed components are placed under `%LOCALAPPDATA%\SignalStartBridge` in a versioned directory. Updating does not overwrite an executable that an existing browser connection is using; reload the extension after updating. The helper writes only the bridge snapshot under `%APPDATA%\MetaQuotes\Terminal\Common\Files\SignalStartBridge` during normal operation. There is no listening network port, HTTP server, WebRequest requirement or DLL import.

Selecting **Not sending**, pausing the selected signal or removing it stops forwarding. Select another enabled signal to resume.

## Closing the browser or MT5

Closing the last normal/popup browser window pauses monitoring, cancels pending signal fetches, clears the poll alarm, closes the audio document and disconnects the native helper. It does not rely on Chrome's background-app preference. A remaining browser window, including a minimized window, keeps monitoring active. Closing only the extension popup does not stop alerts.

While MT5 forwarding is selected, the helper checks for a running `terminal64.exe` or `terminal.exe` in the current Windows session on each bridge update. When none remains, it writes a disabled snapshot and exits. The extension stops its page observers, polling and reconnect timers, preserving saved signals/settings. Detection normally takes up to the configured bridge interval (five seconds by default), plus scheduling. Multiple open terminals keep the bridge active until the last detected terminal closes; renamed terminal executables are not detected.

Opening a browser window resumes monitoring. After closing MT5 while leaving the browser open, start MT5 and reopen the extension popup to resume. There is no background process continually checking whether MT5 has restarted. Reopening the popup while MT5 remains closed pauses it again. Browser-only monitoring (no MT5 signal selected) requires an open browser window but does not require MT5.

Closing/ending **SignalStartNativeHost.exe** also pauses monitoring and cancels all reconnect timers. The extension will not automatically start another copy; reopen the extension popup when you want to resume. If the browser cannot start the helper, its actual error is displayed and no background retry loop runs. Directly opening the helper EXE without a redirected browser input pipe exits immediately; use **SetupBridge.exe** for setup. To replace/delete an installed helper, keep the extension popup closed after stopping it, because reopening the popup explicitly resumes the connection.

To apply this change, reload the extension and SignalStart tabs, then run **SetupBridge.exe → Install / update helper** again and reload the extension to use the rebuilt helper. The EA itself is unchanged. These shutdown rules stop this extension's work; an MT5 terminal left open still runs its own EA receiver timer, and the extension does not terminate unrelated browser or terminal processes.

## Five-second checks

Both defaults are **5 seconds**:

- In the extension: **MT5 receiver check, seconds**, from 1 to 60. This also controls the selected tab's unchanged-data heartbeat.
- In MT5: **ReceiverCheckSeconds**, from 1 to 60.

**UseBrowserCheckInterval=true** makes the EA adopt the browser value after its next successful read. Set it to **false** to use the MT5 input instead. The panel title shows the effective interval. Changing either setting does not require reinstalling the helper. A browser interval change is noticed on the EA's next check, using its previous interval.

The browser still detects page changes and queues alerts as they happen. Incoming changes are sent immediately through the existing native connection. The receiver intentionally waits for its next configured check, so a five-second setting can add up to roughly five seconds, plus scheduling and processing. It cannot make SignalStart publish data sooner. Short trades or transitions entirely between receiver checks may be missed for entry purposes; the bounded browser alert queue preserves recent alerts.

## Automatic symbol, lots, SL and TP

The reader uses **only the selected signal's live Open Trades table**. It never borrows trade sizes, symbols or stops from History, account totals or pending orders.

The browser forwards the row's **Symbol**, **Lots**, and **SL/TP prices**. A visible dash or zero means no SL or TP. Missing, locked or unreadable values are unavailable, not zero. Required unavailable fields block entries and show the reason in the browser/EA; alerts continue. A subscription lock cannot be bypassed by this extension.

Northgate's supplied page was flat during verification. Its description and history identify US30; the EA must not assume XAUUSD from the chart it happens to be attached to. Live values are read when an open row appears. The related public Forexline page provided a real Open Trades table with subscription-locked fields, which the reader correctly refuses to turn into order parameters.

Broker mapping first uses a chart whose name matches the source instrument, then an exact broker symbol, then a unique symbol with a punctuation suffix such as `US30.r`. An ambiguous or unavailable mapping blocks entry and explains why; it never substitutes an unrelated chart symbol. Unsupported broker volume steps or invalid source stop prices also block entry rather than silently changing the source values. Lots are copied as a volume, not adjusted for differing broker contract sizes.

There are no manual **TradingSymbol**, **Lots**, **StopLossPoints**, **TakeProfitPoints** or spread-limit inputs in this EA. SL and TP are optional. When present, their absolute source prices are used at entry and must satisfy the receiving broker's requirements. Later SL/TP changes are displayed/forwarded but are not automatically applied to an already opened position.

## Trading behavior

Trading starts **disabled**. Enable **EnableTrading** and MT5's Algo Trading controls when ready to test on a demo account. **AllowLiveAccount=false** restricts entries to demo accounts; a live account requires explicitly changing that input. Missing browser values do not make EA initialization fail; the panel waits for them while continuing to monitor alerts.

The EA must first observe fresh browser data showing **both zero Floating PL and zero open trades**, then a move away from zero. It does not enter halfway through an existing trade, after stale/disconnected data, or from background-poll data.

When the live row exposes Buy/Sell, the EA uses that actual direction. If direction alone is unavailable but the required trade values are visible, it can estimate exposure by comparing PL changes with the matched MT5 symbol's midpoint price: matching signs suggest Buy and opposite signs suggest Sell. **ConfirmingMoves=2** requires two consecutive matching comparisons, using at least three PL samples. This fallback remains an estimate; website latency, conversion and costs can mislead it.

Multiple or unknown open-trade counts block entries. If multiple trades were observed at any point in the browser's current cycle, the block lasts until the signal becomes flat again, even if the count subsequently falls to one or MT5 missed the intermediate update. Alerts continue.

At most one entry attempt is made per observed cycle. Existing positions or pending orders on the resolved symbol block entry. An entry lock prevents simultaneous bridge instances with the same account/magic from submitting together. Rejections show the broker result and are not retried during that cycle.

With **CloseWhenSignalFlat=true**, fresh browser data showing both zero PL and zero open trades closes positions matching this EA's magic number and the selected signal's `SS-<ID>` comment. This also works after reattaching the EA to a different chart. Returning to break-even with a trade still open does not close it. Selecting another signal does not manage the former signal's position. Losing the browser connection pauses entries; any existing broker-side SL/TP remains in force.

## Alerts and iPhone push

All watched signals' browser alert decisions are mirrored, including signals with multiple trades. Existing alert rules, percentage filter, custom loss threshold and master notification switch still apply. MT5 can receive an alert even if Windows rejects its desktop notification.

Up to 100 recent alert events are buffered for two minutes. The EA ignores existing events at first attachment and deduplicates later events. Start it before relying on alerts. Phone push is separately queued and limited to one message per seven seconds, with three attempts for errors and a two-minute expiry. Heavy alert traffic can exceed this queue; use one push-enabled instance to avoid duplicates.

For iPhone, obtain the **MetaQuotes ID** in the MT5 app, configure it in desktop **Tools → Options → Notifications**, enable push and test there, then set the EA's **PhonePush=true**. Allow MT5 notifications in iOS. This uses [MT5's push service](https://www.metatrader5.com/en/mobile-trading/iphone/help/push), so Pushover or ntfy is unnecessary. Browser and desktop MT5 must stay running. Actual push errors appear by number in the EA panel and Experts log. See [SendNotification limits](https://www.mql5.com/en/docs/network/sendnotification).

## Performance and verification

The receiver checks only at the configured interval. It reads a short header and skips body parsing when the snapshot has not changed. Chart objects are created once; only changed text/colors are updated, and the chart is redrawn only when needed. Browser reads batch relevant DOM changes without an unbounded debounce, cache relevant elements, and reuse storage-change data instead of requesting the entire state on every update. Repeated helper status writes are suppressed. Slow desktop notifications or sound do not hold the signal-write queue or incoming MT5 data.

The persistent helper starts once per browser connection. Requests are serialized and coalesced with bounded queues; files are atomically replaced. `tests/mt5-performance.json` records 300 warm request-to-write measurements: median approximately 12.5 ms and 95th percentile approximately 19.5 ms in the measured run. There was a 364 ms outlier. This measures the local helper under that run's load, not Chrome DOM processing, MT5 polling, broker execution or phone delivery. It is not a guarantee of zero overhead or maximum latency.

Automated checks cover the real helper, installer using simulated registration only, source-table parsing including a real locked row, optional stops, interval configuration, delayed notifications and the production MQL direction/cycle/order-validation headers through shared C++ syntax. The EA compiles in the installed MetaEditor. No EA was attached, real registry registration performed, broker order sent or phone push sent during verification. Actual chart operation, unlocked live trade delivery, broker execution and phone delivery still need a configured terminal test.

To rebuild the EA, keep the `.mq5` and all `.mqh` files together and compile in MetaEditor. `Install-Bridge.ps1 -BuildOnly` is retained for development builds; users can use SetupBridge.exe directly. Normal setup uses [Chrome native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging) and [MT5's common-files directory](https://www.mql5.com/en/docs/files/fileopen) on the same Windows user/computer. It does not automatically bridge another computer or MetaQuotes-hosted VPS.
