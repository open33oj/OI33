import assert from 'node:assert/strict';
import { test } from 'node:test';
import { auctionSettleCanFlow } from './can-flow-rules.ts';

test('管理员拍卖成交：托管罐头回池并销毁等值储备粮', () => {
    assert.deepEqual(
        auctionSettleCanFlow({ type: 'auction', action: 'settle', amount: 120, foodBurn: 300 }),
        { otherBack: 120, feeBurned: 0, foodBurned: 300 },
    );
});

test('用户拍卖成交：成交价点对点给卖家，只有手续费销毁', () => {
    // 成交 120，5% 手续费 = 6：池子回池 0，销毁 6，卖家实收 114（+上架托管费）。
    assert.deepEqual(
        auctionSettleCanFlow({ type: 'auction', action: 'settle', amount: 120, fee: 6 }),
        { otherBack: 0, feeBurned: 6, foodBurned: 0 },
    );
});

test('旧管理员拍卖成交（无 foodBurn 字段）仍按全额回池统计', () => {
    assert.deepEqual(
        auctionSettleCanFlow({ type: 'auction', action: 'settle', amount: 80 }),
        { otherBack: 80, feeBurned: 0, foodBurned: 0 },
    );
});

test('出价 / 托管 / 退款 / 流拍等 auction 日志不进池子', () => {
    for (const action of ['bid', 'deposit_hold', 'deposit_refund', 'deposit_forfeit', 'refund', 'offer', 'create', 'cancel', 'settle_unsold', 'return']) {
        assert.deepEqual(
            auctionSettleCanFlow({ type: 'auction', action, amount: 50 }),
            { otherBack: 0, feeBurned: 0, foodBurned: 0 },
            `${action} 不应影响罐头流动`,
        );
    }
});

test('缺字段 / 负数脏数据被夹到 0', () => {
    assert.deepEqual(
        auctionSettleCanFlow({ type: 'auction', action: 'settle' }),
        { otherBack: 0, feeBurned: 0, foodBurned: 0 },
    );
    assert.deepEqual(
        auctionSettleCanFlow({ type: 'auction', action: 'settle', amount: -5, fee: -3, foodBurn: -1 }),
        { otherBack: 0, feeBurned: 0, foodBurned: 0 },
    );
});
