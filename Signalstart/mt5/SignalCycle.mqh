#ifndef SIGNALSTART_SIGNAL_CYCLE
#define SIGNALSTART_SIGNAL_CYCLE
class SignalCycle
{
private:
   bool armed,active,blocked,attempted;
public:
   void Reset() { armed=false; active=false; blocked=false; attempted=false; }
   void Observe(const double pl,const int trades)
   {
      if(MathAbs(pl)<0.005 && trades==0) { Reset(); armed=true; return; }
      if(trades>1 || trades<0) blocked=true;
      if(armed && MathAbs(pl)>=0.005) active=true;
   }
   bool Active() { return active; }
   bool Blocked() { return blocked; }
   bool Attempted() { return attempted; }
   bool CanEnter() { return active && !blocked && !attempted; }
   void MarkAttempted() { attempted=true; }
};
#endif
