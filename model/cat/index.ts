// Public API of the cat feature (猫咪地图 / 猫罐头经济 / 大猫世界). Handlers and the
// model barrel import from here; the modules below are implementation details.
//
// Layering: map.ts owns the pixel map and cell ownership, map-plan.ts drives
// queued walk plans, can.ts is the cat-can market, account.ts the cat-food
// ledger, school.ts the big-cat world (school-shared/player/transfer) and
// school-reward.ts the weekly settlement. `export *` makes any name collision
// between these modules a compile error instead of a silent overwrite in the
// barrel.
export * from './eligibility';
export * from './map';
export * from './map-player';
export * from './map-admin';
export * from './map-plan';
export * from './can';
export * from './account';
export * from './school';
export * from './school-reward';
