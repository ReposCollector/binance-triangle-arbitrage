const CONFIG = require('../../config/config');

const CalculationNode = {

    cycleCount: 0,
    timings: [],

    cycle(relationships, depthCacheClone, errorCallback, executionCallback) {
        const startTime = new Date().getTime();

        let successCount = 0;
        let errorCount = 0;
        let results = {};

        relationships.forEach(relationship => {
            try {
                const depthSnapshot = {
                    ab: depthCacheClone[relationship.ab.ticker],
                    bc: depthCacheClone[relationship.bc.ticker],
                    ca: depthCacheClone[relationship.ca.ticker]
                };
                const calculated = CalculationNode.optimize(relationship, depthSnapshot);
                if (calculated) {
                    successCount++;
                    if (CONFIG.HUD.ENABLED) results[calculated.id] = calculated;
                    executionCallback(calculated);
                }
            } catch (error) {
                errorCount++;
                errorCallback(error.message);
            }
        });

        const calculationTime = new Date().getTime() - startTime;
        CalculationNode.timings.push(calculationTime);
        CalculationNode.cycleCount++;

        return { calculationTime, successCount, errorCount, results };
    },

    optimize(trade, depthSnapshot) {
        let quantity, calculation;
        let bestCalculation = null;

        for (quantity = CONFIG.INVESTMENT.MIN || CONFIG.INVESTMENT.STEP; quantity <= CONFIG.INVESTMENT.MAX; quantity += CONFIG.INVESTMENT.STEP) {
            calculation = CalculationNode.calculate(quantity, trade, depthSnapshot);
            if (!bestCalculation || calculation.percent > bestCalculation.percent) {
                bestCalculation = calculation;
            }
        }

        return bestCalculation;
    },

    calculate(investmentA, trade, depthSnapshot) {
        let calculated = {
            id: `${trade.symbol.a}-${trade.symbol.b}-${trade.symbol.c}`,
            trade: trade,
            ab: 0,
            bc: 0,
            ca: 0,
            depth: depthSnapshot,
            a: {
                spent: 0,
                earned: 0,
                delta: 0
            },
            b: {
                spent: 0,
                earned: 0,
                delta: 0
            },
            c: {
                spent: 0,
                earned: 0,
                delta: 0
            },
            ab_limit_buy_price: -1
        };

        if (trade.ab.method === 'Buy') {
            // Buying BA
            const dustedB = CalculationNode.orderBookConversion(calculated, investmentA, trade.symbol.a, trade.symbol.b, trade.ab.ticker, depthSnapshot.ab, "AB");
            calculated.b.earned = calculated.ab = CalculationNode.calculateDustless(trade.ab, dustedB);
            calculated.a.spent = CalculationNode.orderBookReverseConversion(calculated, calculated.b.earned, trade.symbol.b, trade.symbol.a, trade.ab.ticker, depthSnapshot.ab, "AB");
        } else {
            // Selling AB
            calculated.a.spent = calculated.ab = CalculationNode.calculateDustless(trade.ab, investmentA);
            calculated.b.earned = CalculationNode.orderBookConversion(calculated, calculated.a.spent, trade.symbol.a, trade.symbol.b, trade.ab.ticker, depthSnapshot.ab, "AB");
        }

        if (trade.bc.method === 'Buy') {
            // Buying CB
            const dustedC = CalculationNode.orderBookConversion(calculated, calculated.b.earned, trade.symbol.b, trade.symbol.c, trade.bc.ticker, depthSnapshot.bc, "BC");
            calculated.c.earned = calculated.bc = CalculationNode.calculateDustless(trade.bc, dustedC);
            calculated.b.spent = CalculationNode.orderBookReverseConversion(calculated, calculated.c.earned, trade.symbol.c, trade.symbol.b, trade.bc.ticker, depthSnapshot.bc, "BC");
        } else {
            // Selling BC
            calculated.b.spent = calculated.bc = CalculationNode.calculateDustless(trade.bc, calculated.b.earned);
            calculated.c.earned = CalculationNode.orderBookConversion(calculated, calculated.b.spent, trade.symbol.b, trade.symbol.c, trade.bc.ticker, depthSnapshot.bc, "BC");
        }

        if (trade.ca.method === 'Buy') {
            // Buying AC
            const dustedA = CalculationNode.orderBookConversion(calculated, calculated.c.earned, trade.symbol.c, trade.symbol.a, trade.ca.ticker, depthSnapshot.ca, "CA");
            calculated.a.earned = calculated.ca = CalculationNode.calculateDustless(trade.ca, dustedA);
            calculated.c.spent = CalculationNode.orderBookReverseConversion(calculated, calculated.a.earned, trade.symbol.a, trade.symbol.c, trade.ca.ticker, depthSnapshot.ca, "CA");
        } else {
            // Selling CA
            calculated.c.spent = calculated.ca = CalculationNode.calculateDustless(trade.ca, calculated.c.earned);
            calculated.a.earned = CalculationNode.orderBookConversion(calculated, calculated.c.spent, trade.symbol.c, trade.symbol.a, trade.ca.ticker, depthSnapshot.ca, "CA");
        }

        // Calculate deltas
        calculated.a.delta = calculated.a.earned - calculated.a.spent;
        calculated.b.delta = calculated.b.earned - calculated.b.spent;
        calculated.c.delta = calculated.c.earned - calculated.c.spent;

        calculated.percent = (calculated.a.delta / calculated.a.spent * 100) - (CONFIG.TRADING.TAKER_FEE * 3);
        if (!calculated.percent) calculated.percent = 0;

        return calculated;
    },

    recalculateTradeLeg(trade, quantityEarned, depthSnapshot) {
        const { base, quote, method, ticker } = trade;
        if (method.toUpperCase() === 'BUY') {
            const dustedQuantity = CalculationNode.orderBookConversion(quantityEarned, quote, base, ticker, depthSnapshot);
            return CalculationNode.calculateDustless(trade, dustedQuantity);
        } else {
            return CalculationNode.calculateDustless(trade, quantityEarned);
        }
    },

    //             bid_weight  ask_weight
    //         |---------------|--------|
    // askRate -------------------------- bidRate
    getWeightedRate(ask_weight, bid_weight, askRate, bidRate) {
        return (bid_weight * bidRate + ask_weight * askRate) / (ask_weight + bid_weight);
    },

    orderBookConversion(calculated, amountFrom, symbolFrom, symbolTo, ticker, depthSnapshot, phase) {
        if (amountFrom === 0) return 0;

        let amountTo = 0;
        let i, rate, quantity, exchangeableAmount;
        const bidRates = Object.keys(depthSnapshot.bids || {});
        const askRates = Object.keys(depthSnapshot.asks || {});

        if (parseFloat(bidRates[0]) > parseFloat(askRates[0])) throw new Error(`Spread does not exist for ${ticker}`);
        let trig = Boolean(CONFIG.TRADING.EXECUTION_STRATEGY.toLowerCase() === 'trigger' && phase == "AB");

        if (ticker === symbolFrom + symbolTo) {
            for (i=0; i<bidRates.length; i++) {
                rate = parseFloat(bidRates[i]);
                quantity = depthSnapshot.bids[bidRates[i]];
                exchangeableAmount = quantity * rate;
                if (quantity < amountFrom) {
                    amountFrom -= quantity;
                    amountTo += exchangeableAmount;
                } else {
                    // Last fill
                    return amountTo + (amountFrom * rate);
                }
            }

        } else {
            // AB - Buy
            for (i=0; i<askRates.length; i++) {
                if (trig) {
                    rate = CalculationNode.getWeightedRate(1, 9, askRates[0], bidRates[i])
                    //rate = parseFloat(bidRates[i]);
                    quantity = depthSnapshot.bids[bidRates[i]];
                    calculated.ab_limit_buy_price = rate;
                } else {
                    rate = parseFloat(askRates[i]);
                    quantity = depthSnapshot.asks[askRates[i]];
                }

                exchangeableAmount = quantity * rate;
                if (exchangeableAmount < amountFrom) {
                    amountFrom -= exchangeableAmount;
                    amountTo += quantity;
                } else {
                    // Last fill
                    return amountTo + (amountFrom / rate);
                }
            }
        }

        throw new Error(`Bid depth (${bidRates.length}) or ask depth (${askRates.length}) too shallow to convert ${amountFrom} ${symbolFrom} to ${symbolTo} using ${ticker}`);
    },

    orderBookReverseConversion(calculated, amountFrom, symbolFrom, symbolTo, ticker, depthSnapshot, phase) {
        if (amountFrom === 0) return 0;

        let amountTo = 0;
        let i, rate, quantity, exchangeableAmount;
        const bidRates = Object.keys(depthSnapshot.bids || {});
        const askRates = Object.keys(depthSnapshot.asks || {});

        if (parseFloat(bidRates[0]) > parseFloat(askRates[0])) throw new Error(`Spread does not exist for ${ticker}`);
        let trig = Boolean(CONFIG.TRADING.EXECUTION_STRATEGY.toLowerCase() === 'trigger' && phase == "AB");

        if (ticker === symbolFrom + symbolTo) {
            for (i=0; i<askRates.length; i++) {
                if (trig) {
                    rate = CalculationNode.getWeightedRate(1, 9, askRates[0], bidRates[i])
                    //rate = parseFloat(bidRates[i]);
                    quantity = depthSnapshot.bids[bidRates[i]];
                } else {
                    rate = parseFloat(askRates[i]);
                    quantity = depthSnapshot.asks[askRates[i]];
                }
                exchangeableAmount = quantity * rate;
                if (quantity < amountFrom) {
                    amountFrom -= quantity;
                    amountTo += exchangeableAmount;
                } else {
                    // Last fill
                    return amountTo + (amountFrom * rate);
                }
            }
        } else {
            for (i=0; i<bidRates.length; i++) {
                rate = parseFloat(bidRates[i]);
                quantity = depthSnapshot.bids[bidRates[i]];
                exchangeableAmount = quantity * rate;
                if (exchangeableAmount < amountFrom) {
                    amountFrom -= exchangeableAmount;
                    amountTo += quantity;
                } else {
                    // Last fill
                    return amountTo + (amountFrom / rate);
                }
            }
        }

        throw new Error(`Bid depth (${bidRates.length}) or ask depth (${askRates.length}) too shallow to reverse convert ${amountFrom} ${symbolFrom} to ${symbolTo} using ${ticker}`);
    },

    calculateDustless(trade, amount) {
        if (Number.isInteger(amount)) return amount;
        const amountString = amount.toFixed(12);
        const decimalIndex = amountString.indexOf('.');
        return parseFloat(amountString.slice(0, decimalIndex + trade.dustDecimals + 1));
    }

};

module.exports = CalculationNode;
