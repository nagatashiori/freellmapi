import { z } from 'zod';
import type { Platform } from '@freellmapi/shared/types.js';
export declare const samplingParamSchemaFields: {
    readonly top_k: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    readonly min_p: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    readonly seed: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    readonly presence_penalty: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    readonly frequency_penalty: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    readonly repetition_penalty: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    readonly logit_bias: z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodNumber>>>;
    readonly logprobs: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
    readonly top_logprobs: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    readonly response_format: z.ZodOptional<z.ZodNullable<z.ZodObject<{
        type: z.ZodEnum<["text", "json_object", "json_schema"]>;
        json_schema: z.ZodOptional<z.ZodObject<{
            name: z.ZodOptional<z.ZodString>;
            strict: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
            schema: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
            name: z.ZodOptional<z.ZodString>;
            strict: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
            schema: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
            name: z.ZodOptional<z.ZodString>;
            strict: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
            schema: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.ZodTypeAny, "passthrough">>>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        type: z.ZodEnum<["text", "json_object", "json_schema"]>;
        json_schema: z.ZodOptional<z.ZodObject<{
            name: z.ZodOptional<z.ZodString>;
            strict: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
            schema: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
            name: z.ZodOptional<z.ZodString>;
            strict: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
            schema: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
            name: z.ZodOptional<z.ZodString>;
            strict: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
            schema: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.ZodTypeAny, "passthrough">>>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        type: z.ZodEnum<["text", "json_object", "json_schema"]>;
        json_schema: z.ZodOptional<z.ZodObject<{
            name: z.ZodOptional<z.ZodString>;
            strict: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
            schema: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
            name: z.ZodOptional<z.ZodString>;
            strict: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
            schema: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
            name: z.ZodOptional<z.ZodString>;
            strict: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
            schema: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.ZodTypeAny, "passthrough">>>;
    }, z.ZodTypeAny, "passthrough">>>>;
    readonly max_completion_tokens: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
};
export interface ResponseFormat {
    type: 'json_object' | 'json_schema';
    json_schema?: {
        name?: string;
        strict?: boolean | null;
        schema?: Record<string, unknown>;
    } & Record<string, unknown>;
}
export interface ExtendedSamplingOptions {
    top_k?: number;
    min_p?: number;
    seed?: number;
    presence_penalty?: number;
    frequency_penalty?: number;
    repetition_penalty?: number;
    logit_bias?: Record<string, number>;
    logprobs?: boolean;
    top_logprobs?: number;
    response_format?: ResponseFormat;
}
export declare const EXTENDED_SAMPLING_KEYS: readonly ["top_k", "min_p", "seed", "presence_penalty", "frequency_penalty", "repetition_penalty", "logit_bias", "logprobs", "top_logprobs", "response_format"];
export type ExtendedSamplingKey = typeof EXTENDED_SAMPLING_KEYS[number];
type ParsedSamplingBody = {
    [K in ExtendedSamplingKey]?: unknown;
};
/**
 * Turn a schema-parsed request body into the extended CompletionOptions
 * fields: nulls dropped, `response_format: {type:'text'}` dropped (it is the
 * default and some providers 400 on receiving it explicitly), everything else
 * forwarded as-is.
 */
export declare function pickSamplingParams(body: ParsedSamplingBody): ExtendedSamplingOptions;
export interface PlatformParamPolicy {
    drop?: readonly ExtendedSamplingKey[];
    rename?: Readonly<Partial<Record<ExtendedSamplingKey, string>>>;
    jsonObjectToSchema?: boolean;
}
export declare const PLATFORM_PARAM_POLICIES: Partial<Record<Platform, PlatformParamPolicy>>;
/**
 * Build the extended wire-body fields for one platform: policy droplist
 * applied, renames applied, undefined skipped. Adapters spread the result
 * into their OpenAI-shaped request bodies.
 */
export declare function extendedBodyParams(platform: string, options: ExtendedSamplingOptions | undefined): Record<string, unknown>;
/** True when this platform's policy strips response_format before send — the
 *  router uses it to skip such platforms for structured-output requests. */
export declare function platformDropsResponseFormat(platform: string): boolean;
/** The advertised parameter list for a model on `platform` — the base set
 *  every surface supports, plus tools when the model does, minus the
 *  platform's droplist. */
export declare function supportedParametersFor(platform: string, caps?: {
    tools?: boolean;
}): string[];
/** For a model served by several platforms (a unify group): the INTERSECTION
 *  of the members' supported sets — a param is only advertised when every
 *  platform the router might pick honors it. */
export declare function supportedParametersForPlatforms(platforms: string[], caps?: {
    tools?: boolean;
}): string[];
export {};
//# sourceMappingURL=sampling-params.d.ts.map