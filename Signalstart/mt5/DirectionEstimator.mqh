#ifndef SIGNALSTART_DIRECTION_ESTIMATOR
#define SIGNALSTART_DIRECTION_ESTIMATOR
// This estimates exposure, not a verified provider order direction.
class DirectionEstimator
{
private:
   bool have_sample;
   double previous_pl, previous_price;
   long previous_at;
   int direction, votes;
public:
   void Reset() { have_sample=false; direction=0; votes=0; previous_at=0; }
   int Votes() { return votes; }
   int Observe(const double pl, const double price, const long at,
               const double min_pl, const double min_price, const int max_gap_seconds,
               const int required_votes)
   {
      if(!have_sample || at-previous_at>(long)max_gap_seconds*1000)
      {
         Reset(); have_sample=true; previous_pl=pl; previous_price=price; previous_at=at;
         return 0;
      }
      if(at<=previous_at) return 0;
      const double pl_move=pl-previous_pl;
      if(MathAbs(pl_move)+min_pl*0.00000001<min_pl) return 0;
      const double price_move=price-previous_price;
      previous_pl=pl; previous_price=price; previous_at=at;
      if(MathAbs(price_move)+min_price*0.00000001<min_price) { direction=0; votes=0; return 0; }
      const int candidate=((pl_move>0)==(price_move>0)) ? 1 : -1;
      votes=(candidate==direction) ? votes+1 : 1;
      direction=candidate;
      return votes>=required_votes ? direction : 0;
   }
};
#endif
