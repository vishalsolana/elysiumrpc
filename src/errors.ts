/** JSON-RPC error codes. Tx-level rejections use -32000 like geth so clients parse them the usual way. */
export const ErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  Internal: -32603,
  TxRejected: -32000,
  Unauthorized: -32001,
  LimitExceeded: -32005,
} as const;

export class RpcError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = 'RpcError';
  }

  toJSON(): { code: number; message: string; data?: unknown } {
    return this.data === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, data: this.data };
  }
}
