import { randomBytes, createHash } from 'crypto';
import { db } from 'hydrooj';
import { Oi33Token } from './types';

export const tokenColl = db.collection('oi33_token');

function generateRawToken(): string {
    return '33tok_' + randomBytes(32).toString('base64url');
}

function hashToken(raw: string): string {
    return createHash('sha256').update(raw).digest('hex');
}

export async function createToken(uid: number, name: string, domains: string[], expiresAt?: Date): Promise<{ _id: string; rawToken: string }> {
    const rawToken = generateRawToken();
    const _id = randomBytes(8).toString('hex') + Date.now().toString(36);
    await tokenColl.insertOne({
        _id,
        tokenHash: hashToken(rawToken),
        tokenPrefix: rawToken.slice(0, 20),
        uid,
        name,
        domains,
        createdAt: new Date(),
        lastUsedAt: new Date(),
        expiresAt,
        isActive: true,
    });
    return { _id, rawToken };
}

export async function getTokensByUid(uid: number): Promise<Oi33Token[]> {
    return await tokenColl.find({ uid, isActive: true }).sort({ createdAt: -1 }).toArray();
}

export async function getAllActiveTokens(): Promise<Oi33Token[]> {
    return await tokenColl.find({ isActive: true }).sort({ createdAt: -1 }).toArray();
}

export async function getTokenByHash(hash: string): Promise<Oi33Token | null> {
    return await tokenColl.findOne({ tokenHash: hash, isActive: true });
}

export async function deleteToken(_id: string): Promise<boolean> {
    const result = await tokenColl.updateOne(
        { _id },
        { $set: { isActive: false } },
    );
    return result.modifiedCount > 0;
}

export async function touchToken(_id: string) {
    await tokenColl.updateOne({ _id }, { $set: { lastUsedAt: new Date() } });
}
