export interface RequestTicket {
  isCurrent: () => boolean;
}

export interface RequestGate {
  start: () => RequestTicket;
  invalidate: () => void;
}

// 只允许最后启动的异步请求提交结果。
export function createRequestGate(): RequestGate {
  let current = 0;
  return {
    start() {
      const id = ++current;
      return { isCurrent: () => id === current };
    },
    invalidate() {
      current++;
    },
  };
}
