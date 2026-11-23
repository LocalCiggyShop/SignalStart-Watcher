#include <cassert>
#include <cmath>
#include <cstdint>
#include <cstdio>
// Compile the actual MQL headers using their shared C++ syntax, with MQL's 64-bit long.
#define MathAbs std::abs
#define MathRound std::round
#define long int64_t
#include "../mt5/DirectionEstimator.mqh"
#include "../mt5/SignalCycle.mqh"
#include "../mt5/AutoTradeRules.mqh"
#undef long

int main() {
    DirectionEstimator estimate;
    estimate.Reset();
    assert(estimate.Observe(-10,100,1000,.01,.1,30,2)==0);
    assert(estimate.Observe(-8,101,2000,.01,.1,30,2)==0);
    assert(estimate.Observe(-7,102,3000,.01,.1,30,2)==1);
    estimate.Reset();
    assert(estimate.Observe(-10,100,1000,.01,.1,30,2)==0);
    assert(estimate.Observe(-8,99,2000,.01,.1,30,2)==0);
    assert(estimate.Observe(-7,98,3000,.01,.1,30,2)==-1);
    // A conflicting direction starts a fresh confirmation sequence.
    assert(estimate.Observe(-6,99,4000,.01,.1,30,2)==0);
    assert(estimate.Votes()==1);
    // A gap, tiny price move or non-increasing timestamp cannot confirm a trade.
    assert(estimate.Observe(-5,100,35000,.01,.1,30,2)==0);
    assert(estimate.Observe(-4,100.001,36000,.01,.1,30,2)==0);
    assert(estimate.Observe(-3,101,35000,.01,.1,30,2)==0);
    assert(estimate.Votes()==0);
    estimate.Reset();
    assert(estimate.Observe(.03,1.10000,1000,.01,.00002,30,1)==0);
    assert(estimate.Observe(.04,1.10002,2000,.01,.00002,30,1)==1); // Decimal boundary tolerance.

    SignalCycle cycle; cycle.Reset();
    cycle.Observe(-10,1); assert(!cycle.CanEnter()); // Starting mid-trade isn't an entry.
    cycle.Observe(0,0); assert(!cycle.Active());
    cycle.Observe(-10,1); assert(cycle.CanEnter());
    cycle.MarkAttempted(); assert(!cycle.CanEnter());
    cycle.Observe(0,1); cycle.Observe(10,1); assert(!cycle.CanEnter()); // Break-even doesn't rearm.
    cycle.Observe(0,0); cycle.Observe(-10,2); assert(cycle.Blocked());
    cycle.Observe(-5,1); assert(!cycle.CanEnter()); // Reducing a basket doesn't make it trustworthy.
    cycle.Observe(0,0); cycle.Observe(0,3); cycle.Observe(-5,1); assert(!cycle.CanEnter());
    cycle.Observe(0,0); cycle.Observe(-5,-1); assert(!cycle.CanEnter()); // Hidden count blocks entry.
    cycle.Observe(0,0); cycle.Observe(5,1); assert(cycle.CanEnter());
    cycle.Reset(); cycle.Observe(6,1); assert(!cycle.CanEnter()); // Stale/disconnected feed must rearm.
    assert(SourceVolumeValid(.1,.01,100,.01));
    assert(!SourceVolumeValid(.015,.01,100,.01));
    assert(!SourceVolumeValid(0,.01,100,.01));
    assert(!SourceVolumeValid(101,.01,100,.01));
    assert(SourceStopsValid(1,100,100.5,0,0,1)); // No mandatory SL or TP.
    assert(SourceStopsValid(-1,100,100.5,0,0,1));
    assert(SourceStopsValid(1,100,100.5,98,103,1));
    assert(SourceStopsValid(-1,100,100.5,103,98,1));
    assert(!SourceStopsValid(1,100,100.5,101,0,0));
    assert(!SourceStopsValid(-1,100,100.5,0,102,0));
    std::puts("MT5 direction and trade-cycle logic: all assertions passed.");
}
