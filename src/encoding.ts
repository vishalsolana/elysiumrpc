import { concatHex, isHex, keccak256, type Hex } from 'viem';

/** Arbitrum Nitro L2 message kind for a signed transaction (arbos/incomingmessage: L2MessageKind_SignedTx). */
export const L2_MESSAGE_KIND_SIGNED_TX = 0x04;

/**
 * Builds the payload for `Inbox.sendL2Message(bytes)`:
 *   messageData = 0x04 ++ <raw signed tx bytes>
 * `rawTx` is exactly the eth_sendRawTransaction parameter (e.g. 0x02 || rlp(...) for EIP-1559).
 */
export function encodeSignedTxMessage(rawTx: Hex): Hex {
  if (!isHex(rawTx, { strict: true }) || rawTx.length < 4 || rawTx.length % 2 !== 0) {
    throw new Error('raw transaction must be a non-empty, even-length 0x hex string');
  }
  return concatHex(['0x04', rawTx.toLowerCase() as Hex]);
}

/** The L2 transaction hash is keccak256 of the raw signed transaction bytes. */
export function l2TxHash(rawTx: Hex): Hex {
  return keccak256(rawTx);
}

/** Byte length of a 0x hex string. */
export function hexByteLength(hex: Hex): number {
  return (hex.length - 2) / 2;
}
