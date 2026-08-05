import os from 'os';
import path from 'path';
import { createGunzip } from 'zlib';
import {
    fs, ProblemModel, superagent,
} from 'hydrooj';

// 官方 luogu-import-problem（hydroac-client）会把洛谷 0-8 难度映射成 Hydro 0-10
// 刻度（{0:0,1:1,2:3,3:4,4:5,5:6,6:7,7:8,8:9}）后再写入，导致 OI33 按洛谷
// 原始难度渲染时全部错位。本脚本读取洛谷 problemset-open 的 ndjson，把目标域里
// 已存在题目的 difficulty 恢复为洛谷原始值（0-8）。
// 参数与官方导入脚本一致：{"path":"","domainId":"luogu","prefix":""}
// path 留空时自动从 CDN 下载最新数据包。

const SOURCE_URL = 'https://cdn.luogu.com.cn/problemset-open/latest.ndjson.gz';

async function downloadNdjson(report: (data: any) => void): Promise<string> {
    const tmp = path.join(os.tmpdir(), `oi33-luogu-${Date.now()}.ndjson`);
    await report({ message: `正在下载 ${SOURCE_URL} ...` });
    const stream = fs.createWriteStream(tmp);
    const unzip = createGunzip();
    unzip.pipe(stream);
    superagent.get(SOURCE_URL).pipe(unzip);
    await new Promise((resolve, reject) => {
        unzip.on('end', resolve);
        unzip.on('error', reject);
        stream.on('end', resolve);
        stream.on('error', reject);
    });
    await report({ message: `下载完成: ${tmp}` });
    return tmp;
}

export async function runFixLuoguDifficulty(args: any, report: (data: any) => void) {
    const domainId = (args?.domainId || 'luogu').trim();
    const prefix = (args?.prefix || '').trim();
    let filePath = (args?.path || '').trim();
    let downloaded = false;
    if (!filePath) {
        filePath = await downloadNdjson(report);
        downloaded = true;
    } else if (!fs.existsSync(filePath)) {
        throw new Error(`文件不存在: ${filePath}`);
    }

    await report({ message: `目标域: ${domainId}, 题号前缀: "${prefix}", 数据文件: ${filePath}` });

    const lines = fs.readFileSync(filePath, 'utf-8').replace(/\r/g, '').split('\n').filter((x) => x.trim());
    const stats = { total: 0, updated: 0, same: 0, missing: 0, invalid: 0 };
    for (const line of lines) {
        stats.total += 1;
        let rec: any;
        try {
            rec = JSON.parse(line);
        } catch {
            stats.invalid += 1;
            continue;
        }
        const { pid, difficulty } = rec;
        if (!pid || !Number.isSafeInteger(difficulty) || difficulty < 0 || difficulty > 8) {
            stats.invalid += 1;
            continue;
        }
        const pdoc = await ProblemModel.get(domainId, `${prefix}${pid}`);
        if (!pdoc) {
            stats.missing += 1;
            continue;
        }
        if ((pdoc.difficulty || 0) === difficulty) {
            stats.same += 1;
        } else {
            await ProblemModel.edit(domainId, pdoc.docId, { difficulty });
            stats.updated += 1;
        }
        if (stats.total % 500 === 0) {
            await report({
                message: `进度 ${stats.total}/${lines.length}: 修正 ${stats.updated}, 一致 ${stats.same}, 未导入 ${stats.missing}, 无效 ${stats.invalid}`,
            });
        }
    }
    if (downloaded) fs.rmSync(filePath, { force: true });
    await report({
        message: `完成：共 ${stats.total} 条，修正 ${stats.updated} 题，本就一致 ${stats.same} 题，域内未导入 ${stats.missing} 题，无效记录 ${stats.invalid} 条`,
    });
    return true;
}
