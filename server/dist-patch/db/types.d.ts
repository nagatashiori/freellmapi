export interface DbStatement {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): {
        lastInsertRowid?: number | bigint;
        changes: number;
    };
}
export interface Db {
    prepare(sql: string): DbStatement;
    exec(sql: string): void;
    transaction<F extends (...args: any[]) => unknown>(fn: F): F;
    pragma(source: string): unknown;
    readonly name?: string;
    readonly memory?: boolean;
}
/** Factory that opens (or creates) a database at the given resolved path and
 *  returns it as a Db. Pragmas and migrations are applied by the caller. */
export type DbFactory = (resolvedPath: string) => Db;
//# sourceMappingURL=types.d.ts.map