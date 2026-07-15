export interface SessionUser {
    userId: number;
    email: string;
}
export declare function userCount(): number;
/** Create a user. Throws { code: 'email_taken' } if the email already exists. */
export declare function createUser(email: string, password: string): SessionUser;
/** Verify credentials. Returns the user on success, null on failure. */
export declare function verifyCredentials(email: string, password: string): SessionUser | null;
/** Mint a session and return the raw token (only the hash is persisted). */
export declare function createSession(userId: number): string;
/** Resolve a session token to its user, or null if missing/expired. */
export declare function validateSession(token: string | undefined | null): SessionUser | null;
export declare function deleteSession(token: string | undefined | null): void;
//# sourceMappingURL=auth.d.ts.map