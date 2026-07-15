export interface Config {
    port: number | string;
    host: string;
    dbPath: string | null;
    dashboardOrigins: string[];
    clientDist: string | null;
    proxyRateLimitRpm: number;
    nodeEnv: string;
    serveStaticAssets: boolean;
}
export declare function loadConfig(): Config;
//# sourceMappingURL=config.d.ts.map