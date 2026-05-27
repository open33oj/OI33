import { randomBytes } from 'crypto';
import { db } from 'hydrooj';
import { Oi33Paste } from './types';
import { addLog } from './log';

export const pasteColl = db.collection('oi33_paste');

export async function pasteAdd(owner: number, title: string, content: string, isprivate: boolean): Promise<string> {
    const pasteId = randomBytes(8).toString('hex') + Date.now().toString(36);
    await pasteColl.insertOne({
        _id: pasteId,
        updateAt: new Date(),
        title,
        owner,
        content,
        isprivate,
    });
    await addLog({ type: 'paste', owner, title, pasteId });
    return pasteId;
}

export async function pasteEdit(pasteId: string, owner: number, title: string, content: string, isprivate: boolean) {
    await pasteColl.updateOne(
        { _id: pasteId },
        { $set: { title, updateAt: new Date(), owner, content, isprivate } },
    );
}

export async function pasteGet(pasteId: string): Promise<Oi33Paste | null> {
    return await pasteColl.findOne({ _id: pasteId });
}

export async function pasteDel(pasteId: string) {
    return await pasteColl.deleteOne({ _id: pasteId });
}

export async function pasteCountUser(owner: number): Promise<number> {
    if (owner !== 0) return await pasteColl.countDocuments({ owner });
    return await pasteColl.countDocuments();
}

export async function pasteGetUser(owner: number, limit: number, page: number) {
    const query = owner !== 0 ? { owner } : {};
    return await pasteColl.find(query).sort({ updateAt: -1, _id: -1 }).limit(limit).skip((page - 1) * limit).toArray();
}
