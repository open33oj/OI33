import Schema from 'schemastery';
import { db } from 'hydrooj';
import * as fs from 'fs';
import * as path from 'path';

// --- MongoDB ObjectId 工具 ---
let ObjectIdCtor: any;
try {
    const bson = require('bson');
    ObjectIdCtor = bson.ObjectId;
} catch {
    try {
        const mongodb = require('mongodb');
        ObjectIdCtor = mongodb.ObjectId;
    } catch {
        throw new Error('无法加载 bson 或 mongodb 模块来构造 ObjectId');
    }
}

function dateToMinObjectId(date: Date): any {
    const ts = Math.floor(date.getTime() / 1000).toString(16).padStart(8, '0');
    return new ObjectIdCtor(ts + '0000000000000000');
}

function dateToMaxObjectId(date: Date): any {
    const ts = Math.floor(date.getTime() / 1000).toString(16).padStart(8, '0');
    return new ObjectIdCtor(ts + 'ffffffffffffffff');
}

// --- 用户安全字段 ---
const SAFE_USER_FIELDS = {
    _id: 1,
    uname: 1,
    mail: 1,
    avatar: 1,
    regat: 1,
    loginat: 1,
    priv: 1,
    intro: 1,
    school: 1,
    gender: 1,
    displayName: 1,
};

// 判断是否为比赛提交（排除普通练习、pretest、generate）
function isContestRecord(contest: any): boolean {
    if (!contest) return false;
    const hex = contest.toString ? contest.toString() : String(contest);
    // 排除全零 ObjectId（普通练习）和特殊 ObjectId
    return hex !== '000000000000000000000000' && hex !== '000000000000000000000001';
}

export async function runExport(args: any, report: (data: any) => void) {
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!args.startDate || !dateRegex.test(args.startDate)) {
        throw new Error('startDate 格式错误，请使用 YYYY-MM-DD');
    }
    if (!args.endDate || !dateRegex.test(args.endDate)) {
        throw new Error('endDate 格式错误，请使用 YYYY-MM-DD');
    }

    const start = new Date(args.startDate + 'T00:00:00.000Z');
    const end = new Date(args.endDate + 'T23:59:59.999Z');
    if (start > end) {
        throw new Error('开始日期不能晚于结束日期');
    }

    const cfg = {
        startDate: args.startDate,
        endDate: args.endDate,
        outputDir: args.outputDir || '/tmp',
        includeCode: args.includeCode !== false,
        domainId: args.domainId || '',
    };

    await report({ message: `日期范围: ${cfg.startDate} ~ ${cfg.endDate}` });
    await report({ message: `输出目录: ${cfg.outputDir}` });
    await report({ message: `包含代码: ${cfg.includeCode}` });
    if (cfg.domainId) await report({ message: `限定域: ${cfg.domainId}` });

    const minOid = dateToMinObjectId(start);
    const maxOid = dateToMaxObjectId(end);
    const domainFilter = cfg.domainId ? { domainId: cfg.domainId } : {};

    // === 1. 查询 record（主要驱动）===
    await report({ message: '正在查询提交记录...' });
    const recordProject: any = {
        _id: 1, domainId: 1, uid: 1, pid: 1, status: 1,
        score: 1, time: 1, memory: 1, lang: 1,
        judgeAt: 1, contest: 1, source: 1, rejudged: 1,
    };
    if (cfg.includeRecordCode) recordProject.code = 1;

    const records = await db.collection('record').find({
        ...domainFilter,
        _id: { $gte: minOid, $lte: maxOid },
    }).project(recordProject).toArray();
    await report({ message: `提交记录: ${records.length} 条` });

    // === 2. 从 record 中提取关联 ID ===
    const uids = new Set<number>();
    const problemKeys = new Set<string>(); // "domainId/pid"
    const contestIds = new Set<string>();   // ObjectId hex string

    for (const r of records) {
        if (r.uid) uids.add(r.uid);
        if (r.domainId && r.pid !== undefined) problemKeys.add(`${r.domainId}/${r.pid}`);
        if (isContestRecord(r.contest)) contestIds.add(r.contest.toString());
    }

    // === 3. 查询关联用户（去敏）===
    await report({ message: '正在查询关联用户...' });
    const uidArray = Array.from(uids);
    const userDocs = uidArray.length
        ? await db.collection('user').find({ _id: { $in: uidArray } }).project(SAFE_USER_FIELDS).toArray()
        : [];
    await report({ message: `关联用户: ${userDocs.length} 条` });

    // === 4. 查询关联题目 ===
    await report({ message: '正在查询关联题目...' });
    const problems: any[] = [];
    for (const key of problemKeys) {
        const [domainId, pidStr] = key.split('/');
        const pid = +pidStr;
        const p = await db.collection('document').findOne({
            domainId,
            docType: 10,
            docId: pid,
        }, {
            projection: {
                _id: 1, domainId: 1, docType: 1, docId: 1, pid: 1,
                owner: 1, title: 1, content: 1, nSubmit: 1, nAccept: 1,
                tag: 1, difficulty: 1, hidden: 1, stats: 1,
            },
        });
        if (p) problems.push(p);
    }
    await report({ message: `关联题目: ${problems.length} 条` });

    // === 5. 查询关联比赛 ===
    await report({ message: '正在查询关联比赛...' });
    const contestArray = Array.from(contestIds).map(id => {
        try { return new ObjectIdCtor(id); } catch { return null; }
    }).filter(Boolean);

    const contests = contestArray.length
        ? await db.collection('document').find({
              docType: 30,
              _id: { $in: contestArray },
          }).project({
              _id: 1, domainId: 1, docType: 1, docId: 1, owner: 1,
              title: 1, content: 1, beginAt: 1, endAt: 1, attend: 1,
              rule: 1, pids: 1, rated: 1, assign: 1,
          }).toArray()
        : [];
    await report({ message: `关联比赛: ${contests.length} 条` });

    // === 6. 从 record 聚合比赛成绩 ===
    await report({ message: '正在聚合比赛成绩...' });
    const contestResultsMap = new Map<string, any>();

    for (const r of records) {
        if (!isContestRecord(r.contest)) continue;
        const key = `${r.domainId}/${r.contest.toString()}/${r.uid}`;
        if (!contestResultsMap.has(key)) {
            contestResultsMap.set(key, {
                domainId: r.domainId,
                contestId: r.contest.toString(),
                uid: r.uid,
                submissions: [],
                totalScore: 0,
                acCount: 0,
            });
        }
        const cr = contestResultsMap.get(key);
        cr.submissions.push({
            pid: r.pid,
            score: r.score,
            status: r.status,
            time: r.time,
            memory: r.memory,
            lang: r.lang,
            judgeAt: r.judgeAt,
            ...(cfg.includeCode && r.code ? { code: r.code } : {}),
        });
        cr.totalScore += (r.score || 0);
        // status === 1 为 AC (STATUS_ACCEPTED)
        if (r.status === 1) cr.acCount++;
    }

    const contestResults = Array.from(contestResultsMap.values()).map(cr => ({
        domainId: cr.domainId,
        contestId: cr.contestId,
        uid: cr.uid,
        totalScore: cr.totalScore,
        acCount: cr.acCount,
        problemCount: new Set(cr.submissions.map((s: any) => s.pid)).size,
        submissions: cr.submissions,
    }));
    await report({ message: `比赛成绩: ${contestResults.length} 条` });

    // === 7. 组装结果 ===
    const result = {
        meta: {
            version: '1.0',
            exportedAt: new Date().toISOString(),
            dateRange: { start: cfg.startDate, end: cfg.endDate },
            includeRecordCode: cfg.includeCode,
            domainId: cfg.domainId || null,
            recordCounts: {
                records: records.length,
                users: userDocs.length,
                problems: problems.length,
                contests: contests.length,
                contestResults: contestResults.length,
            },
        },
        records: records.map((r: any) => ({
            _id: r._id,
            domainId: r.domainId,
            uid: r.uid,
            pid: r.pid,
            status: r.status,
            score: r.score,
            time: r.time,
            memory: r.memory,
            lang: r.lang,
            judgeAt: r.judgeAt,
            contest: isContestRecord(r.contest) ? r.contest.toString() : null,
            source: r.source,
            rejudged: r.rejudged,
            ...(cfg.includeCode && r.code ? { code: r.code } : {}),
        })),
        users: userDocs.map((u: any) => ({
            uid: u._id,
            uname: u.uname || '',
            mail: u.mail || '',
            avatar: u.avatar || '',
            priv: u.priv || 0,
            ...(u.regat ? { regat: u.regat } : {}),
            ...(u.loginat ? { loginat: u.loginat } : {}),
            ...(u.intro ? { intro: u.intro } : {}),
            ...(u.school ? { school: u.school } : {}),
            ...(u.gender !== undefined ? { gender: u.gender } : {}),
            ...(u.displayName ? { displayName: u.displayName } : {}),
        })),
        problems: problems.map((p: any) => ({
            _id: p._id,
            domainId: p.domainId,
            docId: p.docId,
            pid: p.pid,
            owner: p.owner,
            title: p.title,
            content: p.content,
            nSubmit: p.nSubmit,
            nAccept: p.nAccept,
            tag: p.tag,
            difficulty: p.difficulty,
            hidden: p.hidden,
        })),
        contests: contests.map((c: any) => ({
            _id: c._id,
            domainId: c.domainId,
            docId: c.docId,
            title: c.title,
            content: c.content,
            beginAt: c.beginAt,
            endAt: c.endAt,
            attend: c.attend,
            rule: c.rule,
            pids: c.pids,
            rated: c.rated,
            assign: c.assign,
        })),
        contestResults,
    };

    // === 8. 写入文件 ===
    const filename = `hydro-export-${cfg.startDate}_to_${cfg.endDate}.json`;
    const filepath = path.resolve(cfg.outputDir, filename);
    fs.mkdirSync(cfg.outputDir, { recursive: true });
    fs.writeFileSync(filepath, JSON.stringify(result, null, 2));

    const stats = fs.statSync(filepath);
    await report({ message: `导出完成: ${filepath}` });
    await report({ message: `文件大小: ${(stats.size / 1024).toFixed(1)} KB` });

    return true;
}
