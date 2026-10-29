// Pure rules for user-initiated medal auctions: a fixed one-week listing and a
// 5% seller fee, rounded up so every sale pays at least 1 can.

export const AUCTION_SELLER_FEE_PERCENT = 5;
export const AUCTION_USER_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

/** Intermediary fee in cans: 5% of the final price, ceiled. */
export function auctionSellerFee(price: number): number {
    if (!Number.isFinite(price) || price <= 0) return 0;
    return Math.ceil((price * AUCTION_SELLER_FEE_PERCENT) / 100);
}

/** What the seller actually receives after the fee. */
export function auctionSellerProceeds(price: number): number {
    if (!Number.isFinite(price) || price <= 0) return 0;
    return Math.max(0, Math.floor(price) - auctionSellerFee(price));
}
