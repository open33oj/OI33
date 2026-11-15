import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    nextCatCanBuyPrice, SALE_MAX_MULTIPLE, SALE_MAX_TICK_PERCENT,
    SALE_MIN_SPREAD_PERCENT, SALE_TARGET_ALPHA_PERCENT,
} from './can-price-rules.ts';

test('默认参数与截图一致：231/1803、上一期 243，先走 10% 到 268', () => {
    const result = nextCatCanBuyPrice({
        sellPrice: 231,
        ammPrice: 1803,
        previousBuyPrice: 243,
    });
    assert.deepEqual(result, {
        buyPrice: 268,
        targetSale: 624,
        minSale: 255,
        maxSale: 1155,
        previousSale: 243,
        alphaPercent: 25,
        maxTickPercent: 10,
        maxMultiple: 5,
    });
    assert.equal(SALE_TARGET_ALPHA_PERCENT, 25);
    assert.equal(SALE_MAX_TICK_PERCENT, 10);
    assert.equal(SALE_MAX_MULTIPLE, 5);
    assert.equal(SALE_MIN_SPREAD_PERCENT, 10);
});

test('每 8 小时最多变动 10%，下一期从 255 到 281', () => {
    const result = nextCatCanBuyPrice({
        sellPrice: 231,
        ammPrice: 1803,
        previousBuyPrice: 255,
    });
    assert.equal(result.buyPrice, 281);
});

test('到达目标后不再继续上涨', () => {
    const result = nextCatCanBuyPrice({
        sellPrice: 231,
        ammPrice: 1803,
        previousBuyPrice: 624,
    });
    assert.equal(result.targetSale, 624);
    assert.equal(result.buyPrice, 624);
});

test('目标下降时按 10% 回落', () => {
    const result = nextCatCanBuyPrice({
        sellPrice: 231,
        ammPrice: 1803,
        previousBuyPrice: 700,
    });
    assert.equal(result.targetSale, 624);
    assert.equal(result.buyPrice, 630);
});

test('最低价差 10%，超储时买入价也不会低于卖出价', () => {
    const result = nextCatCanBuyPrice({
        sellPrice: 200,
        ammPrice: 150,
        previousBuyPrice: 220,
    });
    assert.equal(result.minSale, 220);
    assert.equal(result.maxSale, 220);
    assert.equal(result.targetSale, 220);
    assert.equal(result.buyPrice, 220);
});

test('最高不超过卖出价 5 倍，也不超过 AMM', () => {
    const result = nextCatCanBuyPrice({
        sellPrice: 231,
        ammPrice: 5000,
        previousBuyPrice: 1100,
    });
    assert.equal(result.maxSale, 1155);
    assert.equal(result.targetSale, 1155);
    assert.equal(result.buyPrice, 1155);
});

test('alpha=0 只保留最低价差，alpha=100 直接取上限', () => {
    const floor = nextCatCanBuyPrice({
        sellPrice: 231, ammPrice: 1803, previousBuyPrice: 500, alphaPercent: 0,
    });
    assert.equal(floor.targetSale, floor.minSale);
    const cap = nextCatCanBuyPrice({
        sellPrice: 231, ammPrice: 1803, previousBuyPrice: 500, alphaPercent: 100,
    });
    assert.equal(cap.targetSale, cap.maxSale);
});

test('没有上一期价格时从最低价差开始', () => {
    const result = nextCatCanBuyPrice({ sellPrice: 231, ammPrice: 1803 });
    assert.equal(result.previousSale, 255);
    assert.equal(result.buyPrice, 281);
});

test('脏数据被夹到安全范围', () => {
    const result = nextCatCanBuyPrice({
        sellPrice: 0, ammPrice: 0, previousBuyPrice: -1,
    });
    assert.equal(result.minSale, 2);
    assert.equal(result.maxSale, 2);
    assert.equal(result.targetSale, 2);
    assert.equal(result.buyPrice, 2);
});
