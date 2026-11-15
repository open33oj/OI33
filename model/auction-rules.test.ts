import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    auctionListingDeposit, auctionSellerFee, auctionSellerProceeds,
} from './auction-rules.ts';

test('auctionListingDeposit is 5% of the starting price and rounds up', () => {
    assert.equal(auctionListingDeposit(1), 1);
    assert.equal(auctionListingDeposit(20), 1);
    assert.equal(auctionListingDeposit(21), 2);
    assert.equal(auctionListingDeposit(100), 5);
    assert.equal(auctionListingDeposit(101), 6);
    assert.equal(auctionListingDeposit(1000), 50);
});

test('auctionListingDeposit is zero for invalid prices', () => {
    assert.equal(auctionListingDeposit(0), 0);
    assert.equal(auctionListingDeposit(-5), 0);
    assert.equal(auctionListingDeposit(Number.NaN), 0);
    assert.equal(auctionListingDeposit(Number.POSITIVE_INFINITY), 0);
});

test('auctionSellerFee is 5% of the hammer price and rounds up', () => {
    assert.equal(auctionSellerFee(1), 1);
    assert.equal(auctionSellerFee(20), 1);
    assert.equal(auctionSellerFee(21), 2);
    assert.equal(auctionSellerFee(100), 5);
    assert.equal(auctionSellerFee(101), 6);
    assert.equal(auctionSellerFee(0), 0);
});

test('auctionSellerProceeds keeps the rest of the hammer price', () => {
    assert.equal(auctionSellerProceeds(100), 95);
    assert.equal(auctionSellerProceeds(101), 95);
    assert.equal(auctionSellerProceeds(1), 0);
    assert.equal(auctionSellerProceeds(20), 19);
});
