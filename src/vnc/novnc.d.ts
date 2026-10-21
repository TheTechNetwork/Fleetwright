// The part of noVNC's RFB that src/vnc/page.js uses, for the typecheck alone:
// noVNC ships JavaScript without declarations. docs/API.md in noVNC is the
// source for each of these.
declare module '@novnc/novnc' {
  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, urlOrChannel: string | object, options?: { shared?: boolean; credentials?: object });
    scaleViewport: boolean;
    resizeSession: boolean;
    background: string;
    sendKey(keysym: number, code: string | null, down?: boolean): void;
    sendCtrlAltDel(): void;
    disconnect(): void;
  }
}
