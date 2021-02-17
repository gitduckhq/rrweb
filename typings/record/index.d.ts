import { eventWithTime, recordOptions, listenerHandler } from '../types';

export declare class Recorder<T = eventWithTime> {
    constructor (
        onEmit: (e: T, isCheckout?: boolean) => void,
        options?: Exclude<recordOptions<T>, 'emit'>,
    );
    start(): listenerHandler | undefined;
    takeFullSnapshot(isCheckout?: boolean): void;
}
declare function record<T = eventWithTime>(options?: recordOptions<T>): listenerHandler | undefined;
declare namespace record {
    var addCustomEvent: <T>(tag: string, payload: T) => void;
    var freezePage: () => void;
}
export default record;
