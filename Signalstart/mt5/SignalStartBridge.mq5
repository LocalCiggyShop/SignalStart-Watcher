#property strict
#property version "1.00"
#property description "Local SignalStart panel, mirrored alerts and optional inferred-direction trading."
#include <Trade/Trade.mqh>
#include "DirectionEstimator.mqh"
#include "SignalCycle.mqh"
#include "AutoTradeRules.mqh"

input group "Panel and alerts"
input bool   TerminalAlerts=true;
input bool   PhonePush=false;
input int    MaxDataAgeSeconds=30;
input int    ReceiverCheckSeconds=5;
input bool   UseBrowserCheckInterval=true; // False uses ReceiverCheckSeconds instead.
input int    PanelX=10;
input int    PanelY=30;
input group "Direction estimate (single-symbol signals only)"
input int    ConfirmingMoves=2; // Consecutive matching PL/price changes; 2 requires 3 PL samples.
input double MinimumPLMove=0.01;
input double MinimumPriceMovePoints=2;
input group "Optional trading - disabled until configured"
input bool   EnableTrading=false;
input bool   AllowLiveAccount=false;
input int    SlippagePoints=10;
input ulong  MagicNumber=94731079;
input bool   CloseWhenSignalFlat=true; // Requires BOTH zero PL and zero open trades.

struct BridgeSignal
{
   string id,name,display,source,error;
   double pl;
   int open_trades;
   long sample_at;
   bool cycle_multiple;
   bool trade_ready;
   string source_symbol,trade_reason,trade_identity;
   double source_lots,source_sl,source_tp;
   int source_side;
};
struct BridgeAlert { string id,title,message; long at; };

CTrade trade;
DirectionEstimator estimator;
SignalCycle cycle;
BridgeSignal current;
string prefix="SSB_PANEL_", selected_id="", bridge_symbol="";
string seen[], push_messages[];
long push_created[];
int push_failures[];
bool first_snapshot=true, selected=false, master_alerts=true;
long received_at=0, last_sample=0;
string entry_lock="";
string last_read_key="",mapped_source="",cycle_identity="";
bool symbol_ready=false;
ulong last_map_attempt=0,last_draw=0;
string panel_text[11];
color panel_ink[11];
bool panel_changed=false;
bool panel_created[11];
bool panel_background=false;
int active_check_seconds=5;
ulong last_push=0;
int inferred=0;
string trade_status="Trading disabled", alert_status="Waiting for an alert", connection="Waiting for browser bridge";

long NowMs() { return (long)TimeGMT()*1000; }
bool NearZero(const double value) { return MathAbs(value)<0.005; }
int FreshnessSeconds() { return (int)MathMax(MaxDataAgeSeconds,active_check_seconds*3); }
bool Fresh(const long at) { const long age=NowMs()-at; return at>0 && age>=-5000 && age<=(long)FreshnessSeconds()*1000; }

void ResetCycle()
{
   cycle.Reset(); inferred=0; estimator.Reset(); cycle_identity="";
}

bool Seen(const string id)
{
   for(int i=0;i<ArraySize(seen);i++) if(seen[i]==id) return true;
   int n=ArraySize(seen);
   if(n>=256) { ArrayRemove(seen,0,1); n--; }
   ArrayResize(seen,n+1); seen[n]=id;
   return false;
}

void Notify(const string text)
{
   alert_status=StringSubstr(text,0,90);
   Print(text);
   if(TerminalAlerts) Alert(text);
   if(!PhonePush) return;
   int n=ArraySize(push_messages);
   if(n>=100) { Print("Phone queue full; MT5 received the alert but push was not queued."); return; }
   ArrayResize(push_messages,n+1); ArrayResize(push_created,n+1); ArrayResize(push_failures,n+1);
   push_messages[n]=StringSubstr(text,0,255); push_created[n]=NowMs(); push_failures[n]=0;
}

void DropPush()
{
   ArrayRemove(push_messages,0,1); ArrayRemove(push_created,0,1); ArrayRemove(push_failures,0,1);
}

void ProcessPush()
{
   if(ArraySize(push_messages)==0 || (last_push>0 && GetTickCount64()-last_push<7000)) return;
   if(NowMs()-push_created[0]>120000) { Print("Phone alert expired in queue: ",push_messages[0]); DropPush(); return; }
   last_push=GetTickCount64();
   ResetLastError();
   if(!TerminalInfoInteger(TERMINAL_NOTIFICATIONS_ENABLED))
   { alert_status="Phone push disabled in MT5 Options > Notifications"; Print(alert_status); DropPush(); return; }
   if(SendNotification(push_messages[0])) { alert_status="MT5 accepted phone push"; DropPush(); }
   else
   {
      alert_status="Phone push error "+IntegerToString(GetLastError()); Print(alert_status);
      push_failures[0]++;
      if(push_failures[0]>=3) DropPush();
   }
}

int ReadSnapshot(BridgeSignal &signal, BridgeAlert &alerts[], bool &enabled, bool &notifications, long &written,int &check_seconds)
{
   int file=FileOpen("SignalStartBridge\\snapshot.tsv",FILE_READ|FILE_TXT|FILE_ANSI|FILE_COMMON|FILE_SHARE_READ|FILE_SHARE_WRITE,0,CP_UTF8);
   if(file==INVALID_HANDLE) return -1;
   string fields[];
   int count=StringSplit(FileReadString(file),'\t',fields);
   if(count!=7 || !((fields[0]=="SSB1" && fields[1]=="1") || (fields[0]=="SSB2" && fields[1]=="2"))) { FileClose(file); return -1; }
   const bool automatic=fields[1]=="2";
   written=(long)StringToInteger(fields[2]); enabled=fields[3]=="1"; notifications=fields[4]=="1";
   string request_id=fields[5]; int expected=(int)StringToInteger(fields[6]);
   const string key=fields[2]+"|"+request_id;
   if(key==last_read_key) { FileClose(file); return 0; }
   if(expected<0 || expected>100) { FileClose(file); return -1; }
   bool found=false,ended=false,details_found=false,control_found=false; int actual=0;
   signal.trade_ready=false; signal.source_symbol=""; signal.source_lots=0; signal.source_sl=0; signal.source_tp=0; signal.source_side=0; signal.trade_identity="";
   signal.trade_reason="Update the helper and extension for automatic trade details.";
   ArrayResize(alerts,expected);
   while(!FileIsEnding(file))
   {
      count=StringSplit(FileReadString(file),'\t',fields);
      if(count==2 && fields[0]=="END") { ended=fields[1]==request_id; break; }
      if(count==2 && fields[0]=="C" && automatic && !control_found)
      {
         control_found=true; check_seconds=(int)StringToInteger(fields[1]);
         if(check_seconds<1 || check_seconds>60) { FileClose(file); return -1; }
      }
      else if(count==10 && fields[0]=="S" && !found)
      {
         signal.id=fields[1]; signal.name=fields[2]; signal.pl=StringToDouble(fields[3]);
         signal.display=fields[4]; signal.open_trades=(int)StringToInteger(fields[5]);
         signal.sample_at=StringToInteger(fields[6]); signal.source=fields[7]; signal.error=fields[8]=="-" ? "" : fields[8]; found=true;
         signal.cycle_multiple=fields[9]=="1";
      }
      else if(count==9 && fields[0]=="T" && automatic && found && !details_found)
      {
         details_found=true; signal.trade_ready=fields[1]=="ready";
         signal.source_symbol=fields[2]=="-" ? "" : fields[2];
         signal.source_lots=StringToDouble(fields[3]); signal.source_sl=StringToDouble(fields[4]); signal.source_tp=StringToDouble(fields[5]);
         signal.source_side=(int)StringToInteger(fields[6]); signal.trade_identity=fields[7];
         signal.trade_reason=fields[8]=="-" ? "" : fields[8];
         if(signal.trade_ready && (signal.open_trades!=1 || signal.source_symbol=="" || signal.source_lots<=0 ||
            signal.source_sl<0 || signal.source_tp<0 || MathAbs(signal.source_side)>1 ||
            !MathIsValidNumber(signal.source_lots) || !MathIsValidNumber(signal.source_sl) || !MathIsValidNumber(signal.source_tp)))
         { FileClose(file); return -1; }
      }
      else if(count==6 && fields[0]=="A" && actual<expected)
      {
         alerts[actual].id=fields[1]; alerts[actual].at=StringToInteger(fields[2]);
         alerts[actual].title=fields[4]; alerts[actual].message=fields[5]; actual++;
      }
      else { FileClose(file); return -1; }
   }
   FileClose(file);
   if(!ended || found!=enabled || actual!=expected || (automatic && !control_found) || (enabled && (!MathIsValidNumber(signal.pl) || (automatic && !details_found)))) return -1;
   last_read_key=key;
   return 1;
}

bool RelatedSymbol(string broker,string source)
{
   StringToUpper(broker); StringToUpper(source);
   if(broker==source) return true;
   if(StringFind(broker,source)!=0) return false;
   const string suffix=StringSubstr(broker,StringLen(source),1);
   return suffix=="." || suffix=="_" || suffix=="#" || suffix=="-";
}

bool ResolveBrowserSymbol()
{
   if(mapped_source==current.source_symbol && symbol_ready) return true;
   if(mapped_source==current.source_symbol && GetTickCount64()-last_map_attempt<5000) return false;
   if(mapped_source!=current.source_symbol) estimator.Reset();
   mapped_source=current.source_symbol; last_map_attempt=GetTickCount64(); symbol_ready=false;
   string match="";
   // An already matching chart is an unambiguous user-selected broker contract.
   if(RelatedSymbol(_Symbol,mapped_source)) match=_Symbol;
   else if(SymbolSelect(mapped_source,true) && SymbolInfoInteger(mapped_source,SYMBOL_TRADE_MODE)!=SYMBOL_TRADE_MODE_DISABLED) match=mapped_source;
   else
   {
      int candidates=0;
      for(int i=0;i<SymbolsTotal(false);i++)
      {
         const string candidate=SymbolName(i,false);
         if(RelatedSymbol(candidate,mapped_source) && SymbolInfoInteger(candidate,SYMBOL_TRADE_MODE)!=SYMBOL_TRADE_MODE_DISABLED)
         { match=candidate; candidates++; }
      }
      if(candidates!=1)
      { trade_status=candidates==0 ? "No broker symbol matches "+mapped_source : "Ambiguous broker symbol: attach to the matching "+mapped_source+" chart"; return false; }
   }
   if(!SymbolSelect(match,true)) { trade_status="Broker symbol unavailable: "+match; return false; }
   bridge_symbol=match; symbol_ready=true; trade.SetTypeFillingBySymbol(bridge_symbol);
   return true;
}

bool OwnPosition(const ulong ticket, const string id)
{
   return PositionSelectByTicket(ticket) && (ulong)PositionGetInteger(POSITION_MAGIC)==MagicNumber &&
      PositionGetString(POSITION_COMMENT)=="SS-"+id;
}

void CloseOwned()
{
   if(!EnableTrading || !CloseWhenSignalFlat || !MQLInfoInteger(MQL_TRADE_ALLOWED) || !TerminalInfoInteger(TERMINAL_TRADE_ALLOWED)) return;
   for(int i=PositionsTotal()-1;i>=0;i--)
   {
      ulong ticket=PositionGetTicket(i);
      if(!OwnPosition(ticket,current.id)) continue;
      trade.SetTypeFillingBySymbol(PositionGetString(POSITION_SYMBOL));
      bool sent=trade.PositionClose(ticket,(ulong)SlippagePoints);
      uint code=trade.ResultRetcode();
      if(!sent || (code!=TRADE_RETCODE_DONE && code!=TRADE_RETCODE_DONE_PARTIAL))
      { trade_status="Close failed: "+trade.ResultRetcodeDescription(); Print(trade_status); }
      else trade_status="Signal flat; EA position closed";
   }
}

void EnterLocked(const int direction, const MqlTick &tick)
{
   if(!MQLInfoInteger(MQL_TRADE_ALLOWED) || !TerminalInfoInteger(TERMINAL_TRADE_ALLOWED))
   { trade_status="Entry blocked: Algo Trading is disabled"; return; }
   if(!AllowLiveAccount && AccountInfoInteger(ACCOUNT_TRADE_MODE)!=ACCOUNT_TRADE_MODE_DEMO)
   { trade_status="Entry blocked: live account not enabled"; return; }
   double point=SymbolInfoDouble(bridge_symbol,SYMBOL_POINT);
   if(!SourceVolumeValid(current.source_lots,SymbolInfoDouble(bridge_symbol,SYMBOL_VOLUME_MIN),
      SymbolInfoDouble(bridge_symbol,SYMBOL_VOLUME_MAX),SymbolInfoDouble(bridge_symbol,SYMBOL_VOLUME_STEP)))
   { trade_status="Source lot size is not valid for broker symbol "+bridge_symbol; return; }
   if(!SourceStopsValid(direction,tick.bid,tick.ask,current.source_sl,current.source_tp,
      SymbolInfoInteger(bridge_symbol,SYMBOL_TRADE_STOPS_LEVEL)*point))
   { trade_status="Source SL/TP is not valid at the current broker price"; return; }
   if(PositionSelect(bridge_symbol)) { trade_status="Entry blocked: a position already exists on this symbol"; return; }
   for(int i=0;i<OrdersTotal();i++)
      if(OrderGetTicket(i)>0 && OrderGetString(ORDER_SYMBOL)==bridge_symbol)
      { trade_status="Entry blocked: an order already exists on this symbol"; return; }
   int digits=(int)SymbolInfoInteger(bridge_symbol,SYMBOL_DIGITS);
   double step=SymbolInfoDouble(bridge_symbol,SYMBOL_TRADE_TICK_SIZE);
   double sl=current.source_sl,tp=current.source_tp;
   if(step>0 && ((sl>0 && MathAbs(sl/step-MathRound(sl/step))>0.000001) ||
      (tp>0 && MathAbs(tp/step-MathRound(tp/step))>0.000001)))
   { trade_status="Source SL/TP does not match the broker price tick"; return; }
   sl=NormalizeDouble(sl,digits); tp=NormalizeDouble(tp,digits);
   trade.SetTypeFillingBySymbol(bridge_symbol);
   bool sent=direction>0 ? trade.Buy(current.source_lots,bridge_symbol,0,sl,tp,"SS-"+current.id)
                         : trade.Sell(current.source_lots,bridge_symbol,0,sl,tp,"SS-"+current.id);
   uint code=trade.ResultRetcode();
   if(sent && (code==TRADE_RETCODE_DONE || code==TRADE_RETCODE_DONE_PARTIAL))
      trade_status="Opened inferred "+(direction>0 ? "BUY" : "SELL");
   else if(sent && code==TRADE_RETCODE_PLACED) trade_status="Entry accepted; awaiting broker execution";
   else trade_status="Entry failed: "+trade.ResultRetcodeDescription();
   Print(trade_status);
}

void TryEntry(const int direction,const MqlTick &tick)
{
   if(!EnableTrading || !cycle.CanEnter() || direction==0 || !current.trade_ready || !symbol_ready) return;
   cycle.MarkAttempted();
   if(!GlobalVariableSetOnCondition(entry_lock,(double)GetTickCount64()+1,0))
   { trade_status="Entry blocked: another bridge instance is placing an order"; return; }
   EnterLocked(direction,tick);
   GlobalVariableSet(entry_lock,0);
}

void ObserveSignal()
{
   if(current.source!="live" || !Fresh(current.sample_at) || current.error!="")
   { ResetCycle(); last_sample=0; trade_status="Waiting for fresh data from the open browser tab"; return; }
   if(current.sample_at==last_sample) return;
   long previous_sample=last_sample; last_sample=current.sample_at;
   if(previous_sample>0 && current.sample_at-previous_sample>(long)FreshnessSeconds()*1000) ResetCycle();
   cycle.Observe(current.pl,current.cycle_multiple ? 2 : current.open_trades);
   if(current.open_trades==0 && NearZero(current.pl))
   {
      CloseOwned(); estimator.Reset(); inferred=0;
      trade_status=EnableTrading ? "Ready; waiting for PL to leave zero" : "Trading disabled; monitoring";
      return;
   }
   if(cycle.Blocked()) { estimator.Reset(); inferred=0; trade_status="Multiple/unknown trades: alerts only until the signal is flat"; return; }
   if(!cycle.Active()) { trade_status="Waiting to observe a flat-to-active transition"; return; }
   if(current.open_trades!=1) { estimator.Reset(); inferred=0; trade_status="Waiting for exactly one reported open trade"; return; }
   if(!current.trade_ready) { trade_status=current.trade_reason; return; }
   if(!ResolveBrowserSymbol()) return;
   if(cycle_identity!="" && cycle_identity!=current.trade_identity)
   { cycle.Observe(current.pl,2); trade_status="Open-trade row changed; waiting for a new flat cycle"; return; }
   cycle_identity=current.trade_identity;
   MqlTick tick;
   if(!TerminalInfoInteger(TERMINAL_CONNECTED) || !SymbolInfoTick(bridge_symbol,tick) || tick.bid<=0 || tick.ask<=0 || MathAbs((double)(TimeTradeServer()-tick.time))>5)
   { estimator.Reset(); inferred=0; trade_status="Waiting for a fresh MT5 quote"; return; }
   inferred=current.source_side!=0 ? current.source_side : estimator.Observe(current.pl,(tick.bid+tick.ask)/2,current.sample_at,MinimumPLMove,
      MinimumPriceMovePoints*SymbolInfoDouble(bridge_symbol,SYMBOL_POINT),FreshnessSeconds(),ConfirmingMoves);
   if(!cycle.Attempted()) trade_status=inferred==0 ? "Comparing PL with MT5 price; matching moves: "+IntegerToString(estimator.Votes())
      : (current.source_side!=0 ? "Source " : "Estimated ")+(inferred>0 ? "BUY" : "SELL")+(EnableTrading ? "" : "; trading disabled");
   TryEntry(inferred,tick);
}

void Label(const string key, const string text, const int row, const color ink=clrWhite)
{
   string name=prefix+key;
   const string clipped=StringSubstr(text,0,90);
   bool created=!panel_created[row];
   if(created)
   {
      ObjectCreate(0,name,OBJ_LABEL,0,0,0);
      ObjectSetInteger(0,name,OBJPROP_XDISTANCE,PanelX+12); ObjectSetInteger(0,name,OBJPROP_YDISTANCE,PanelY+10+row*23);
      ObjectSetInteger(0,name,OBJPROP_FONTSIZE,10); ObjectSetInteger(0,name,OBJPROP_SELECTABLE,false);
      ObjectSetString(0,name,OBJPROP_FONT,"Segoe UI"); panel_created[row]=true;
   }
   if(created || panel_text[row]!=clipped)
   { ObjectSetString(0,name,OBJPROP_TEXT,clipped); panel_text[row]=clipped; panel_changed=true; }
   if(created || panel_ink[row]!=ink)
   { ObjectSetInteger(0,name,OBJPROP_COLOR,ink); panel_ink[row]=ink; panel_changed=true; }
}

void DrawPanel()
{
   if(last_draw>0 && GetTickCount64()-last_draw<250) return;
   last_draw=GetTickCount64();
   string name=prefix+"background";
   if(!panel_background)
   {
      ObjectCreate(0,name,OBJ_RECTANGLE_LABEL,0,0,0);
      ObjectSetInteger(0,name,OBJPROP_XDISTANCE,PanelX); ObjectSetInteger(0,name,OBJPROP_YDISTANCE,PanelY);
      ObjectSetInteger(0,name,OBJPROP_XSIZE,630); ObjectSetInteger(0,name,OBJPROP_YSIZE,267);
      ObjectSetInteger(0,name,OBJPROP_BGCOLOR,C'35,43,52'); ObjectSetInteger(0,name,OBJPROP_BORDER_TYPE,BORDER_FLAT);
      ObjectSetInteger(0,name,OBJPROP_SELECTABLE,false); panel_background=true; panel_changed=true;
   }
   Label("title","SIGNALSTART / MT5 | Check every "+IntegerToString(active_check_seconds)+"s",0,clrAquamarine);
   Label("connection",connection,1,Fresh(received_at) ? clrAquamarine : clrOrange);
   Label("signal",selected ? current.name+"  ["+current.id+"]" : "Select a signal in the browser extension",2);
   Label("pl",selected ? "Floating PL: "+current.display : "Floating PL: --",3,selected && current.pl<0 ? clrSalmon : clrWhite);
   Label("trades",selected ? "Open trades: "+(current.open_trades<0 ? "unknown" : IntegerToString(current.open_trades)) : "Open trades: --",4);
   Label("price","Source: "+current.source_symbol+" | MT5: "+bridge_symbol+" | "+(inferred==0 ? "unconfirmed" : (current.source_side!=0 ? "source " : "estimated ")+(inferred>0 ? "BUY" : "SELL")),5);
   Label("mode",(EnableTrading ? "Trading ON" : "Trading OFF")+(current.trade_ready ? " | Lots "+DoubleToString(current.source_lots,4)+" | SL "+DoubleToString(current.source_sl,5)+" | TP "+DoubleToString(current.source_tp,5) : " | Waiting for browser trade details"),6,EnableTrading ? clrOrange : clrAquamarine);
   Label("trade_status",trade_status,7);
   Label("alerts",alert_status,8);
   Label("push","Phone push: "+(PhonePush ? "ON" : "OFF")+" | queued: "+IntegerToString(ArraySize(push_messages)),9);
   Label("note","Trade values come from Open Trades. Locked fields block entries; alerts continue.",10,clrSilver);
   if(panel_changed) { ChartRedraw(); panel_changed=false; }
}

int OnInit()
{
   ResetCycle();
   if(MaxDataAgeSeconds<5 || ReceiverCheckSeconds<1 || ReceiverCheckSeconds>60 || ConfirmingMoves<1 || MinimumPLMove<=0 || MinimumPriceMovePoints<=0 || SlippagePoints<0 || (EnableTrading && MagicNumber==0)) return INIT_PARAMETERS_INCORRECT;
   trade.SetExpertMagicNumber(MagicNumber); trade.SetDeviationInPoints((ulong)SlippagePoints);
   entry_lock="SSB_ENTRY_"+IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN))+"_"+IntegerToString((long)MagicNumber);
   if(EnableTrading && !GlobalVariableCheck(entry_lock) && !GlobalVariableTemp(entry_lock)) return INIT_FAILED;
   active_check_seconds=ReceiverCheckSeconds;
   if(!EventSetTimer(active_check_seconds)) return INIT_FAILED;
   ObjectsDeleteAll(0,prefix);
   DrawPanel();
   return INIT_SUCCEEDED;
}

void OnTimer()
{
   BridgeSignal signal; BridgeAlert alerts[]; bool enabled=false, notifications=false; long written=0;
   int requested_seconds=ReceiverCheckSeconds;
   const int result=ReadSnapshot(signal,alerts,enabled,notifications,written,requested_seconds);
   if(result==1 && Fresh(written))
   {
      received_at=written;
      if(UseBrowserCheckInterval && requested_seconds!=active_check_seconds && EventSetTimer(requested_seconds)) active_check_seconds=requested_seconds;
      bool changed=enabled && selected_id!=signal.id;
      if(changed || !enabled) { ResetCycle(); last_sample=0; }
      selected=enabled; master_alerts=notifications;
      if(enabled) { current=signal; selected_id=signal.id; }
      for(int i=0;i<ArraySize(alerts);i++)
      {
         bool old=Seen(alerts[i].id);
         long age=NowMs()-alerts[i].at;
         if(!old && !first_snapshot && notifications && age>=-5000 && age<120000)
            Notify(alerts[i].title+" | "+alerts[i].message);
      }
      first_snapshot=false;
      if(!notifications) { ArrayResize(push_messages,0); ArrayResize(push_created,0); ArrayResize(push_failures,0); }
   }
   if(result<0 || !Fresh(received_at)) { connection="Bridge unavailable or stale; entries paused"; ResetCycle(); last_sample=0; }
   else
   {
      connection=selected ? "Browser bridge received | "+current.source+" | sample age "+IntegerToString((int)MathMax(0,(NowMs()-current.sample_at)/1000))+"s" : "Browser forwarding paused";
      if(selected) ObserveSignal();
   }
   ProcessPush(); DrawPanel();
}

void OnDeinit(const int reason)
{
   EventKillTimer(); ObjectsDeleteAll(0,prefix); ChartRedraw();
}
