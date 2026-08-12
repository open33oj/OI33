import {
    Context, ForbiddenError, Handler, NotFoundError, PRIV, Types, UserModel, ValidationError,
    param,
} from 'hydrooj';
import { oi33Model } from '../model';
import { checkUserFlag } from './utils';

function field(body: any, name: string): string {
    const value = body?.[name];
    return String(Array.isArray(value) ? value[0] : value ?? '').trim();
}

class ContractListHandler extends Handler {
    async get(domainId: string) {
        const uid = this.user._id;
        const [incoming, outgoing, resolved, sellable, oi33Data] = await Promise.all([
            oi33Model.contractListIncoming(uid),
            oi33Model.contractListOutgoing(uid),
            oi33Model.contractListRecentResolved(uid),
            oi33Model.contractListSellableAwards(uid),
            oi33Model.getUserDataByUids([uid]),
        ]);
        const achievementIds = [...new Set([
            ...incoming.map((contract) => contract.achievementId),
            ...outgoing.map((contract) => contract.achievementId),
            ...resolved.map((contract) => contract.achievementId),
        ])];
        const achievements = achievementIds.length ? await oi33Model.achievementList() : [];
        const achievementDict = Object.fromEntries(
            achievements.map((achievement) => [achievement._id, achievement]),
        );
        const uids = [...new Set([
            ...incoming.map((contract) => contract.seller),
            ...outgoing.map((contract) => contract.buyer),
            ...resolved.flatMap((contract) => [contract.seller, contract.buyer]),
        ])];
        const udict = uids.length ? await UserModel.getList(domainId, uids) : {};
        const oi33Dict = uids.length ? await oi33Model.getUserDataByUids(uids) : {};
        for (const id of uids) {
            if (udict[id] && oi33Dict[id]) oi33Model.mergeOi33Fields(udict[id], oi33Dict[id]);
        }
        this.response.template = 'oi33_contracts.html';
        this.response.body = {
            incoming, outgoing, resolved, sellable,
            achievementDict, udict,
            viewerFood: Number(oi33Data[uid]?.cat_food) || 0,
            verified: (oi33Data[uid]?.realname_flag ?? 0) >= 1,
        };
    }
}

class ContractCreateHandler extends Handler {
    async post(domainId: string) {
        if ((await checkUserFlag(this.user._id)) < 1) {
            throw new ForbiddenError('只有通过认证的用户才能创建交易合同。');
        }
        const body = this.request.body as any;
        const achievementId = field(body, 'achievementId');
        const buyer = Number(field(body, 'buyer'));
        const price = Number(field(body, 'price'));
        if (!Number.isSafeInteger(buyer) || buyer <= 0) throw new ValidationError('买家 UID 无效。');
        if (!(await UserModel.getById(domainId, buyer))) throw new NotFoundError(buyer);
        await oi33Model.contractCreate({
            achievementId, seller: this.user._id, buyer, price,
        });
        this.response.redirect = this.url('oi33_contracts', {
            query: { notification: '交易合同已创建，等待对方接受' },
        });
    }
}

class ContractAcceptHandler extends Handler {
    @param('id', Types.String)
    async post(domainId: string, id: string) {
        if ((await checkUserFlag(this.user._id)) < 1) {
            throw new ForbiddenError('只有通过认证的用户才能接受交易合同。');
        }
        await oi33Model.contractAccept(id, this.user._id);
        this.response.redirect = this.url('oi33_contracts', {
            query: { notification: '合同已成交，成就已转入你的账户' },
        });
    }
}

class ContractDeclineHandler extends Handler {
    @param('id', Types.String)
    async post(domainId: string, id: string) {
        await oi33Model.contractDecline(id, this.user._id);
        this.response.redirect = this.url('oi33_contracts', {
            query: { notification: '已拒绝该合同' },
        });
    }
}

class ContractCancelHandler extends Handler {
    @param('id', Types.String)
    async post(domainId: string, id: string) {
        await oi33Model.contractCancel(id, this.user._id);
        this.response.redirect = this.url('oi33_contracts', {
            query: { notification: '合同已取消' },
        });
    }
}

export async function apply(ctx: Context) {
    ctx.Route('oi33_contracts', '/oi33/contracts', ContractListHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_contract_create', '/oi33/contracts/create', ContractCreateHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_contract_accept', '/oi33/contracts/:id/accept', ContractAcceptHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_contract_decline', '/oi33/contracts/:id/decline', ContractDeclineHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_contract_cancel', '/oi33/contracts/:id/cancel', ContractCancelHandler, PRIV.PRIV_USER_PROFILE);
}
