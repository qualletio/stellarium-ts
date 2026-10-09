import type { Database } from "sqlite";
import type {
    ChainAccess,
    Signed,
    RelayAdvertisement,
} from "../protocol/types.js";
import { verifySigned } from "../protocol/typed-data.js";
import { advertisementSchema } from "../protocol/schema.js";
import { wireJson } from "../protocol/canonical.js";
import { ProtocolError, nowSeconds } from "../payment/validation.js";
export class RelayDiscovery {
    constructor(
        private readonly db: Database,
        private readonly chain: ChainAccess,
    ) {}
    async save(ad: Signed<RelayAdvertisement>): Promise<void> {
        const m = ad.message;
        const now = nowSeconds();
        if (
            m.issuedAt > now ||
            m.expiresAt <= now ||
            m.expiresAt <= m.issuedAt ||
            !(await verifySigned(
                "RelayAdvertisement",
                ad,
                m.relay,
                this.chain.relayDomain,
            )) ||
            !(await this.chain.isEligibleRelay(m.relay))
        )
            throw new ProtocolError("Invalid relay advertisement");
        const current = await this.db.get(
            "SELECT advertisement_json FROM relay_advertisement WHERE relay=?",
            m.relay.toLowerCase(),
        );
        if (current) {
            const old = advertisementSchema.parse(
                JSON.parse(current.advertisement_json),
            );
            if (m.nonce < old.message.nonce) return;
            if (m.nonce === old.message.nonce) {
                if (wireJson(old) === wireJson(ad)) return;
                throw new ProtocolError("Stale relay advertisement");
            }
        }
        await this.db.run(
            `INSERT INTO relay_advertisement(relay,advertisement_json,issued_at,nonce,expires_at) VALUES(?,?,?,?,?)
      ON CONFLICT(relay) DO UPDATE SET advertisement_json=excluded.advertisement_json,issued_at=excluded.issued_at,nonce=excluded.nonce,expires_at=excluded.expires_at`,
            m.relay.toLowerCase(),
            wireJson(ad),
            Number(m.issuedAt),
            m.nonce.toString(),
            Number(m.expiresAt),
        );
    }
    async list(): Promise<Signed<RelayAdvertisement>[]> {
        const rows = await this.db.all(
            "SELECT advertisement_json FROM relay_advertisement WHERE expires_at>?",
            Number(nowSeconds()),
        );
        return rows.map((row) =>
            advertisementSchema.parse(JSON.parse(row.advertisement_json)),
        );
    }
    async select(grossPrice: bigint): Promise<Signed<RelayAdvertisement>> {
        const candidates = [];
        for (const ad of await this.list())
            if (
                ad.message.available &&
                ad.message.relayFeeUsdc <= grossPrice &&
                (await this.chain.isEligibleRelay(ad.message.relay))
            )
                candidates.push({
                    ad,
                    score: await this.chain.relayScore(ad.message.relay),
                });
        candidates.sort((a, b) =>
            a.score !== b.score
                ? a.score > b.score
                    ? -1
                    : 1
                : a.ad.message.relayFeeUsdc !== b.ad.message.relayFeeUsdc
                  ? a.ad.message.relayFeeUsdc < b.ad.message.relayFeeUsdc
                      ? -1
                      : 1
                  : a.ad.message.relay
                        .toLowerCase()
                        .localeCompare(b.ad.message.relay.toLowerCase()),
        );
        if (!candidates.length)
            throw new ProtocolError("No eligible relay is available", 503);
        return candidates[0].ad;
    }
}
