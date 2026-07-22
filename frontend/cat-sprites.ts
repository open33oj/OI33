/**
 * 小猫像素精灵定义。
 *
 * 每个动作是一张 8×8 图：
 * 0 = 透明，1 = #000000，2 = #FAF235。
 *
 * CAT_SPRITE_ROWS 的每一行依次横向拼接 CAT_FRAME_NAMES 中的动作。
 * 后续新增动作时，在 CAT_FRAME_NAMES 末尾添加名称，并在下面每一行末尾
 * 追加该动作对应的一行 8 位像素数据即可。
 */
export const CAT_PIXEL_COLORS: Record<string, string | null> = {
    0: null,
    1: '#000000',
    2: '#FAF235',
};

export const CAT_FRAME_NAMES = ['sit', 'sit-tail', 'walk-a', 'walk-b'] as const;

export const CAT_SPRITE_ROWS = [
    '00101000001010000101000001010000',
    '01111100011111001111100011111001',
    '01212100012121001212100112121001',
    '01111100011111001111100111111011',
    '00111100001111010111111101111110',
    '00111100001111010111111101111110',
    '01111100001111010111111111111110',
    '11111111011111110101010100101010',
] as const;

export const CAT_FRAMES = CAT_FRAME_NAMES.map((_name, frameIndex) => (
    CAT_SPRITE_ROWS.map((row) => row.slice(frameIndex * 8, frameIndex * 8 + 8))
));
