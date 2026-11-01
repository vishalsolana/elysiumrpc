import { describe, expect, it } from 'vitest';
import { decodeFunctionData, keccak256, type Hex } from 'viem';
import { encodeSignedTxMessage, l2TxHash } from '../src/encoding.js';
import { encodeFunctionData } from 'viem';
import { inboxAbi } from '../src/inbox.js';
import { signTx } from './helpers.js';

describe('L2 message encoding', () => {
  it('prefixes the raw signed tx with the signedTx kind byte 0x04, bytes otherwise untouched', async () => {
    const raw = await signTx();
    expect(raw.startsWith('0x02')).toBe(true); // EIP-1559 typed tx
    const msg = encodeSignedTxMessage(raw);
    expect(msg.slice(0, 4)).toBe('0x04');
    expect(`0x${msg.slice(4)}`).toBe(raw.toLowerCase());
    expect((msg.length - 2) / 2).toBe((raw.length - 2) / 2 + 1);
  });

  it('works on a fixed vector', () => {
    expect(encodeSignedTxMessage('0x02f8abcdef')).toBe('0x0402f8abcdef');
    expect(encodeSignedTxMessage('0xF86C')).toBe('0x04f86c'); // legacy RLP list, normalized to lowercase
  });

  it('rejects non-hex and odd-length input', () => {
    expect(() => encodeSignedTxMessage('0x' as Hex)).toThrow();
    expect(() => encodeSignedTxMessage('0x123' as Hex)).toThrow();
    expect(() => encodeSignedTxMessage('02f8' as Hex)).toThrow();
  });

  it('L2 tx hash is keccak256 of the raw signed tx (not of the 0x04 message)', async () => {
    const raw = await signTx({ nonce: 7 });
    expect(l2TxHash(raw)).toBe(keccak256(raw));
    expect(l2TxHash(raw)).not.toBe(keccak256(encodeSignedTxMessage(raw)));
  });

  it('round-trips through sendL2Message(bytes) calldata with selector 0xb75436bb', async () => {
    const raw = await signTx();
    const data = encodeFunctionData({ abi: inboxAbi, functionName: 'sendL2Message', args: [encodeSignedTxMessage(raw)] });
    expect(data.slice(0, 10)).toBe('0xb75436bb');
    const dec = decodeFunctionData({ abi: inboxAbi, data });
    expect(dec.args[0]).toBe(encodeSignedTxMessage(raw));
  });
});
