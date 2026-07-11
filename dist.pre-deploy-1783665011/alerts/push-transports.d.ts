export interface Transport {
    name: string;
    /** Returns true when configured well enough to attempt. */
    available: () => boolean;
    send: (message: string) => Promise<void>;
}
export declare function matrixMessageTransport(): Transport;
export declare function hookRelayTransport(): Transport;
export declare function pushNotificationTransport(): Transport;
/** Try each transport in order; resolve on first success, throw if all fail. */
export declare function sendThroughChain(message: string, transports?: Transport[]): Promise<string>;
//# sourceMappingURL=push-transports.d.ts.map