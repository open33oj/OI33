// 占格周奖励的纯规则：格子数 → 罐头数。
// 100 格 = 1 罐，200 格 = 2 罐，400 格 = 3 罐，800 格 = 4 罐……
// 即 floor(log2(cells / 100)) + 1；不足 100 格不发。
// 不依赖 hydrooj / DB，便于 node --test 单测。

export const CAT_CELL_REWARD_MIN_CELLS = 100;

export function catCellRewardCans(cells: unknown): number {
    const count = Math.max(0, Math.floor(Number(cells) || 0));
    if (count < CAT_CELL_REWARD_MIN_CELLS) return 0;
    return Math.floor(Math.log2(count / CAT_CELL_REWARD_MIN_CELLS)) + 1;
}

const SHANGHAI = 'Asia/Shanghai';

function shanghaiParts(now: Date) {
    return Object.fromEntries(new Intl.DateTimeFormat('en-US', {
        timeZone: SHANGHAI, year: 'numeric', month: '2-digit',
    }).formatToParts(now).map((part) => [part.type, part.value]));
}

// 当前自然月 `YYYY-MM`（Asia/Shanghai）。
export function cellRewardMonthKey(now: Date): string {
    const parts = shanghaiParts(now);
    return `${parts.year}-${parts.month}`;
}

// 上一个自然月 `YYYY-MM`；月初/月末都按上海时区计算。
export function previousCellRewardMonth(now: Date): string {
    const parts = shanghaiParts(now);
    const year = Number(parts.year);
    const month = Number(parts.month);
    const prevYear = month === 1 ? year - 1 : year;
    const prevMonth = month === 1 ? 12 : month - 1;
    return `${prevYear}-${String(prevMonth).padStart(2, '0')}`;
}
