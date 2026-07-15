/** Pure: true when the error is a recoverable network transport failure that
 *  should not crash the process (vs. a programming bug, which should). */
export declare function isTransportError(err: unknown): boolean;
export type ProcessErrorDecision = 'swallow' | 'fatal';
/** Pure: swallow transport errors, treat everything else as fatal. */
export declare function classifyProcessError(err: unknown): ProcessErrorDecision;
export interface SafetyNetHooks {
    log?: (...args: unknown[]) => void;
    exit?: (code: number) => void;
    /** Set false to skip registering process.on() handlers (e.g. in test environments
     *  or runtimes that do not expose a Node process). Default: true. */
    hasProcessHooks?: boolean;
}
/** Decide and act on a process-level error. Returns the decision so callers and
 *  tests can assert behavior. `fatal` exits 1 (preserving Node's default
 *  fail-fast); `swallow` logs and lets the process continue. */
export declare function handleProcessError(kind: 'uncaughtException' | 'unhandledRejection', err: unknown, hooks?: SafetyNetHooks): ProcessErrorDecision;
/** Install the global handlers once. Idempotent. Call as early as possible at
 *  boot (before the server starts taking traffic). Pass `hasProcessHooks: false`
 *  to skip handler registration without changing other hook behaviour. */
export declare function installProcessSafetyNet(hooks?: SafetyNetHooks): void;
//# sourceMappingURL=process-safety-net.d.ts.map