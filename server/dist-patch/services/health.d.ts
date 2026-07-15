import type { KeyStatus } from '@freellmapi/shared/types.js';
import type { Scheduler } from '../lib/scheduler.js';
export declare function checkKeyHealth(keyId: number): Promise<KeyStatus>;
export declare function checkAllKeys(): Promise<void>;
export declare function startHealthChecker(scheduler: Scheduler): void;
export declare function stopHealthChecker(): void;
//# sourceMappingURL=health.d.ts.map