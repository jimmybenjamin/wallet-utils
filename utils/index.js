const BigInt = require('big-integer');

const LATE_PENALTY_GRACE_DAYS = 14;
const LATE_PENALTY_SCALE_DAYS = 700;
const EARLY_PENALTY_MIN_DAYS = 90;
const bigZero = BigInt(0);

class Utils {
  static processDailyRangeData(data) {
    return data.map((sharesHearts) => {
      const asBig = BigInt(sharesHearts);
      return {
        dayStakeSharesTotal: asBig.shiftRight(128),
        dayPayoutTotal: asBig.and(BigInt('FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF', 16)),
      };
    });
  }

  static calcPayoutRewards(dailyPayoutData, stakeShares, beginDay, endDay) {
    let payout = bigZero;
    for (let day = beginDay; day < endDay; day += 1) {
      payout = payout.add(dailyPayoutData[day].dayPayoutTotal.mul(stakeShares)
        .div(dailyPayoutData[day].dayStakeSharesTotal));
    }
    return payout;
  }

  static estimatePayoutRewardsDay(dailyData, stakeSharesParam, sampleDay) {
    // This is materially different from the contract function because
    // it calculates on "live" data and we want to act on stored state data

    return dailyData[sampleDay].dayPayoutTotal.mul(stakeSharesParam)
      .div(dailyData[sampleDay].dayStakeSharesTotal.add(stakeSharesParam));
  }

  static calcLatePenalty(
    stakedDays,
    unpooledDays,
    rawStakeReturn,
  ) {
    /* Allow grace time before penalties accrue */
    const effectiveStakedDays = stakedDays + LATE_PENALTY_GRACE_DAYS;
    if (unpooledDays <= effectiveStakedDays) {
      return bigZero;
    }

    /* Calculate penalty as a percentage of stake return based on time */
    return rawStakeReturn.mul(unpooledDays - effectiveStakedDays).div(LATE_PENALTY_SCALE_DAYS);
  }

  static calcPayoutAndEarlyPenalty(
    dailyPayoutData,
    pooledDay,
    stakedDays,
    servedDays,
    stakeShares,
  ) {
    let payout = bigZero;
    let penalty = bigZero;

    const servedEndDay = pooledDay + servedDays;

    /* 50% of stakedDays (rounded up) with a minimum applied */
    let penaltyDays = stakedDays / 2 + (stakedDays % 2);
    if (penaltyDays < EARLY_PENALTY_MIN_DAYS) {
      penaltyDays = EARLY_PENALTY_MIN_DAYS;
    }

    if (servedDays === 0) {
      /* Fill penalty days with the estimated average payout */
      const expected = Utils.estimatePayoutRewardsDay(dailyPayoutData, stakeShares, pooledDay - 1);
      penalty = expected.mul(penaltyDays);
      return [payout, penalty]; // Actual payout was 0
    }

    if (penaltyDays < servedDays) {
      /*
              Simplified explanation of intervals where end-day is non-inclusive:

              penalty:    [pooledDay  ...  penaltyEndDay)
              delta:                      [penaltyEndDay  ...  servedEndDay)
              payout:     [pooledDay  .......................  servedEndDay)
          */
      const penaltyEndDay = pooledDay + penaltyDays;
      penalty = Utils.calcPayoutRewards(dailyPayoutData, stakeShares, pooledDay, penaltyEndDay);

      const delta = Utils.calcPayoutRewards(dailyPayoutData, stakeShares, penaltyEndDay,
        servedEndDay);
      payout = penalty.add(delta);
      return [payout, penalty];
    }

    /* penaltyDays >= servedDays  */
    payout = Utils.calcPayoutRewards(dailyPayoutData, stakeShares, pooledDay, servedEndDay);

    if (penaltyDays === servedDays) {
      penalty = payout;
    } else {
      /*
              (penaltyDays > servedDays) means not enough days served, so fill the
              penalty days with the average payout from only the days that were served.
          */
      penalty = payout.mul(penaltyDays).div(servedDays);
    }
    return [payout, penalty];
  }

  static calcStakeReturn(dailyData, st, servedDays) {
    let payout = bigZero;
    let penalty = bigZero;
    let stakeReturn = bigZero;
    let cappedPenalty = bigZero;

    if (servedDays < st.stakedDays) {
      [payout, penalty] = Utils.calcPayoutAndEarlyPenalty(
        dailyData,
        st.pooledDay,
        st.stakedDays,
        servedDays,
        st.stakeShares,
      );
      stakeReturn = st.stakedHearts.add(payout);
    } else {
      payout = Utils.calcPayoutRewards(st.stakeShares, st.pooledDay, st.pooledDay + servedDays);
      stakeReturn = st.stakedHearts.add(payout);

      penalty = Utils.calcLatePenalty(
        st.stakedDays,
        st.unpooledDay - st.pooledDay,
        stakeReturn,
      );
    }
    if (!bigZero.eq(penalty)) {
      if (penalty.gt(stakeReturn)) {
        /* Cannot have a negative stake return */
        // cappedPenalty = stakeReturn;
        stakeReturn = bigZero;
      } else {
        /* Remove penalty from the stake return */
        cappedPenalty = penalty;
        stakeReturn = stakeReturn.sub(cappedPenalty);
      }
    }
    return stakeReturn;
  }

  static extractSimplifiedApi(abi, relevantEvents, relevantFunctions) {
    const obj = { events: {}, functions: {} };
    const eventRelevant = evtName => !relevantEvents || relevantEvents.indexOf(evtName) > -1;
    const functionRelevant = fnName => !relevantFunctions || relevantFunctions.indexOf(fnName) > -1;
    abi.map((item) => {
      if (item.type && item.type === 'event' && eventRelevant(item.name)) {
        obj.events[item.name] = { fields: item.inputs };
      } else if (item.type && item.type === 'function' && functionRelevant(item.name)) {
        obj.functions[item.name] = { inputs: item.inputs, outputs: item.outputs };
      }
      return null;
    });
    return obj;
  }
}

module.exports = Utils;
