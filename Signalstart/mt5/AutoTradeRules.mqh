#ifndef SIGNALSTART_AUTO_TRADE_RULES
#define SIGNALSTART_AUTO_TRADE_RULES
bool SourceVolumeValid(const double lots,const double minimum,const double maximum,const double step)
{
   return lots>0 && step>0 && lots>=minimum && lots<=maximum && MathAbs(lots/step-MathRound(lots/step))<0.000001;
}
bool SourceStopsValid(const int side,const double bid,const double ask,const double sl,const double tp,const double distance)
{
   if((side!=1 && side!=-1) || bid<=0 || ask<bid || sl<0 || tp<0 || distance<0) return false;
   // Zero explicitly means the provider has no stop/target. Hidden fields never reach this function.
   if(side>0) return (sl==0 || (sl<bid && bid-sl>=distance)) && (tp==0 || (tp>bid && tp-bid>=distance));
   return (sl==0 || (sl>ask && sl-ask>=distance)) && (tp==0 || (tp<ask && ask-tp>=distance));
}
#endif
