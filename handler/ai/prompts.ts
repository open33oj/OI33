import { oi33Model } from '../../model';
import { checkUserFlag } from '../utils';

export const STATUS_NAMES: Record<number, string> = {
    0: 'Pending',
    1: 'Accepted',
    2: 'Wrong Answer',
    3: 'Time Limit Exceeded',
    4: 'Memory Limit Exceeded',
    5: 'Output Limit Exceeded',
    6: 'Runtime Error',
    7: 'Compile Error',
    8: 'System Error',
    9: 'Canceled',
};

export const DEFAULT_STUDENT_SYSTEM_PROMPT = [
    '你是 OI/NOIP 算法竞赛教练，正在指导小学生分析自己的代码。',
    '输入包含：精简题意、评测状态、测试点通过情况汇总、代码。',
    '要求：',
    '1. 先判断整体思路是否可行，再定位具体错误（行号、变量名）。',
    '2. 只引导不给答案：用提问和提示代替直接陈述，禁止给出完整代码或题解。',
    '3. 结合测试点汇总说明问题（如大量 TLE 说明复杂度过高）。',
    '4. 语气鼓励，控制在 300 字以内。',
    '5. 全程使用中文，包括内部推理（reasoning）过程；思考简明扼要、直击关键，禁止长篇推理。',
].join('\n');

export const DEFAULT_TEACHER_SYSTEM_PROMPT = [
    '你是算法竞赛辅导专家，帮助 OI 教练分析学生代码。',
    '输入包含：精简题意、评测状态、测试点通过情况汇总、代码。',
    '要求：',
    '1. 先给结论：思路/算法是否可行（复杂度是否满足数据范围）。',
    '2. 再定位：具体行号、变量、错误原因，结合测试点汇总佐证。',
    '3. 给出修改方向，但不要重写完整代码。',
    '4. 控制在 500 字以内。',
    '5. 全程使用中文，包括内部推理（reasoning）过程；思考简明扼要、直击关键，禁止长篇推理。',
].join('\n');

export const SUMMARY_SYSTEM_PROMPT = [
    '你是信息学竞赛题目整理助手。请把题目描述压缩为「精简题意」，供 AI 分析代码时快速理解题目。',
    '规则：',
    '1. 保留：问题的精确定义、输入格式、输出格式、数据范围与约束、需要特判的情况。',
    '2. 完整优先于简短：题目涉及的规则、映射关系、边界条件必须一条不漏地列全（例如猜拳题中每种手势的胜负关系都要写全）。',
    '3. 删除：背景故事、样例及样例解释、提示与备注、来源信息。',
    '4. 数学符号和变量名保持原样（保留 $...$ LaTeX）。',
    '5. 直接输出精简后的题意（markdown），不要任何额外评论。一般控制在 600 字以内，但以不遗漏关键信息为前提。',
].join('\n');

export const DIFFICULTY_SYSTEM_PROMPT = [
    '你是信息学竞赛题目难度评判专家。根据给出的精简题意，评判该题在洛谷难度体系中的等级。',
    '等级定义（输出 1-8 的整数）：',
    '1 = 入门：基本语句、简单模拟、简单数学，CSP-J 第一题水平。',
    '2 = 普及−：简单枚举、贪心、基础递推，CSP-J 前两题水平。',
    '3 = 普及：基础数据结构、简单动态规划、二分、简单图论，CSP-J 后两题水平。',
    '4 = 普及+/提高−：较复杂的动态规划、搜索剪枝、并查集、最短路，CSP-S 前两题水平。',
    '5 = 提高：线段树/树状数组、较难的动态规划与图论、数学推导，CSP-S 后两题水平。',
    '6 = 提高+/省选−：高级数据结构、动态规划优化、网络流等，省选较易题水平。',
    '7 = 省选/NOI−：高级算法综合、复杂构造与证明，省选/NOI 中等题水平。',
    '8 = NOI/NOI+/CTS：NOI 及以上级别的难题。',
    '综合考虑：所需算法与数据结构、思维难度、实现复杂度、数据范围。',
    '只输出 JSON：{"difficulty": N}，N 为 1-8 的整数，不要输出任何其他内容。',
].join('\n');

// Combined generation: the model writes the condensed statement first, then a
// trailing marker line with the difficulty, so one call returns both. The
// marker is stripped before saving; it never lands in the cached summary.
// Note: a custom difficulty_prompt from /oi33/ai/models only applies to the
// difficulty-only path; combined generation uses this fixed tail.
// Only the values DeepSeek's thinking mode accepts;
// empty = provider default (high), param omitted from requests.
export function validEffort(v?: string): string {
    return ['low', 'high', 'max'].includes(v || '') ? v! : '';
}

export const DIFFICULTY_MARKER = '[[难度]]';
export const SUMMARY_DIFFICULTY_TAIL = [
    '输出完精简题意后，在最后一行单独输出一行难度标记：[[难度]]N，N 为 1-8 的整数，不要输出任何其他内容。',
    '等级定义（洛谷难度体系）：',
    '1 = 入门：基本语句、简单模拟、简单数学，CSP-J 第一题水平。',
    '2 = 普及−：简单枚举、贪心、基础递推，CSP-J 前两题水平。',
    '3 = 普及：基础数据结构、简单动态规划、二分、简单图论，CSP-J 后两题水平。',
    '4 = 普及+/提高−：较复杂的动态规划、搜索剪枝、并查集、最短路，CSP-S 前两题水平。',
    '5 = 提高：线段树/树状数组、较难的动态规划与图论、数学推导，CSP-S 后两题水平。',
    '6 = 提高+/省选−：高级数据结构、动态规划优化、网络流等，省选较易题水平。',
    '7 = 省选/NOI−：高级算法综合、复杂构造与证明，省选/NOI 中等题水平。',
    '8 = NOI/NOI+/CTS：NOI 及以上级别的难题。',
    '综合考虑：所需算法与数据结构、思维难度、实现复杂度、数据范围。',
].join('\n');

function stripHtml(html: string): string {
    return html
        .replace(/<[^>]*>/g, '')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

export function optimizeProblemContent(html: string): string {
    const text = stripHtml(html);
    try {
        const obj = JSON.parse(text);
        if (obj.zh && typeof obj.zh === 'string') return obj.zh;
        if (obj.en && typeof obj.en === 'string') return obj.en;
    } catch {}
    return text;
}

// Compact aggregate instead of per-testcase lines: keeps the prompt small.
function formatTestResults(testCases: any[], status: number, score: number): string {
    if (!testCases || testCases.length === 0) {
        return `评测结果：${STATUS_NAMES[status] || status}（无测试点明细）`;
    }
    const counts: Record<string, number> = {};
    for (const tc of testCases) {
        const name = STATUS_NAMES[tc.status] || `S${tc.status}`;
        counts[name] = (counts[name] || 0) + 1;
    }
    const summary = Object.entries(counts).map(([k, v]) => `${k}×${v}`).join(', ');
    return `共 ${testCases.length} 个测试点：${summary}`;
}

function optimizeCode(code: string): string {
    return code.replace(/\n{3,}/g, '\n\n').trim();
}

// realname_flag: 1 = student, 2 = teacher, 3 = admin. Teachers (and above)
// get unlimited quota (usage still recorded) and the teacher prompt.
export async function isTeacherUser(uid: number): Promise<boolean> {
    return (await checkUserFlag(uid)) >= 2;
}

function isContestId(contest: any): boolean {
    if (!contest) return false;
    const hex = typeof contest.toHexString === 'function' ? contest.toHexString() : String(contest);
    return !hex.startsWith('0'.repeat(23));
}

// Contest/homework submissions are never AI-analyzable by students, even
// after the contest ends; teachers can analyze anyone's code at any time.
export function contestBlockReason(rdoc: any, isTeacher: boolean): string | null {
    if (!isContestId(rdoc.contest) || isTeacher) return null;
    return '比赛提交仅老师可以使用 AI 分析。';
}

export function formatMoney(v: number): string {
    return `¥${v.toFixed(4)}`;
}

export function buildPrompts(
    rdoc: any, brief: string, isTeacher: boolean, langDisplay: string,
    overrides?: { student_prompt?: string; teacher_prompt?: string },
) {
    const statusName = STATUS_NAMES[rdoc.status] || `Status ${rdoc.status}`;
    const resultsText = formatTestResults(rdoc.testCases || [], rdoc.status, rdoc.score);
    const systemPrompt = (isTeacher
        ? overrides?.teacher_prompt || DEFAULT_TEACHER_SYSTEM_PROMPT
        : overrides?.student_prompt || DEFAULT_STUDENT_SYSTEM_PROMPT);
    const userPrompt = [
        '## 题意',
        brief,
        '',
        '## 评测状态',
        `Status: ${statusName}, Score: ${rdoc.score}, Time: ${rdoc.time}ms, Memory: ${rdoc.memory}KB, Lang: ${langDisplay}`,
        '',
        '## 测试点汇总',
        resultsText,
        '',
        '## 代码',
        '```' + (rdoc.lang || ''),
        optimizeCode(rdoc.code),
        '```',
    ].join('\n');
    return { resultsText, systemPrompt, userPrompt };
}

export interface AccessState {
    isTeacher: boolean;
    allowed: boolean;
    unlimited: boolean;
    balance: number; // meaningless when unlimited/isTeacher
}

export async function getAccessState(uid: number): Promise<AccessState> {
    const isTeacher = await isTeacherUser(uid);
    if (isTeacher) {
        return {
            isTeacher, allowed: true, unlimited: true, balance: 0,
        };
    }
    const acc = await oi33Model.aiGetAccess(uid);
    if (!acc) {
        return {
            isTeacher, allowed: false, unlimited: false, balance: 0,
        };
    }
    return {
        isTeacher,
        allowed: acc.unlimited || acc.balance > 0,
        unlimited: !!acc.unlimited,
        balance: acc.balance || 0,
    };
}
