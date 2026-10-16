const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Base58 (Bitcoin alphabet), as Solana encodes transaction signatures. Avoids another SDK dependency. */
export function encodeBase58(bytes: Uint8Array): string {
    let value = BigInt(`0x${Buffer.from(bytes).toString('hex') || '0'}`);
    let encoded = '';
    while (value > 0n) {
        encoded = ALPHABET[Number(value % 58n)] + encoded;
        value /= 58n;
    }
    // Each leading zero byte is a leading '1'.
    for (const byte of bytes) {
        if (byte !== 0) break;
        encoded = '1' + encoded;
    }
    return encoded;
}
