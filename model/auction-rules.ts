// Pure rules for user-initiated medal auctions: a fixed one-week listing, a
// 5% (ceiled) listing deposit and a 5% (ceiled) sale fee.
//
// The deposit is escrowed when the auction goes live: a sale refunds it in
// full, while an auction nobody bids on forfeits it to the market reserve.
// The sale fee is charged on top of the final price and burned on settlement,
// regardless of whether a deposit was collected.

export const AUCTION_LISTING_DEPOSIT_PERCENT = 5;
export const AUCTION_SELLER_FEE_PERCENT = 5;
export const AUCTION_USER_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

// Bumped when the listing rules change. Auctions created under older rules do
// not carry the stamp; the one-time migration uses it to delist only those
// legacy listings, never auctions created after the upgrade.
export const AUCTION_RULES_VERSION = 2;

/**
 * Listing deposit in cans: 5% of the starting price, ceiled. Always at least
 * one can, so even a 1-can starting price puts something at stake.
 */
export function auctionListingDeposit(startPrice: number): number {
    if (!Number.isFinite(startPrice) || startPrice <= 0) return 0;
    return Math.max(1, Math.ceil((startPrice * AUCTION_LISTING_DEPOSIT_PERCENT) / 100));
}

/** Sale fee in cans: 5% of the final price, ceiled. */
export function auctionSellerFee(price: number): number {
    if (!Number.isFinite(price) || price <= 0) return 0;
    return Math.max(1, Math.ceil((price * AUCTION_SELLER_FEE_PERCENT) / 100));
}

/** What the seller receives from the hammer price after the sale fee. */
export function auctionSellerProceeds(price: number): number {
    if (!Number.isFinite(price) || price <= 0) return 0;
    return Math.max(0, Math.floor(price) - auctionSellerFee(price));
}
