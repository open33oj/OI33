import assert from 'node:assert/strict';
import { test } from 'node:test';
import { auctionSellerFee, auctionSellerProceeds } from './auction-rules.ts';

test('auctionSellerFee is 5% and always rounds up', () => {
    assert.equal(auctionSellerFee(1), 1);
    assert.equal(auctionSellerFee(20), 1);
    assert.equal(auctionSellerFee(21), 2);
    assert.equal(auctionSellerFee(100), 5);
    assert.equal(auctionSellerFee(101), 6);
    assert.equal(auctionSellerFee(0), 0);
});

test('auctionSellerProceeds keeps the rest of the winning bid', () => {
    assert.equal(auctionSellerProceeds(100), 95);
    assert.equal(auctionSellerProceeds(101), 95);
    assert.equal(auctionSellerProceeds(1), 0);
    assert.equal(auctionSellerProceeds(20), 19);
});
