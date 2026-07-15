import { z } from 'zod';
import type { ChatMessage, ChatToolCall, ChatToolDefinition, ChatToolChoice } from '@freellmapi/shared/types.js';
export declare const responsesRouter: import("express-serve-static-core").Router;
declare const responsesRequestSchema: z.ZodObject<{
    text: z.ZodOptional<z.ZodNullable<z.ZodObject<{
        format: z.ZodOptional<z.ZodObject<{
            type: z.ZodEnum<["text", "json_object", "json_schema"]>;
            name: z.ZodOptional<z.ZodString>;
            strict: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
            schema: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
            type: z.ZodEnum<["text", "json_object", "json_schema"]>;
            name: z.ZodOptional<z.ZodString>;
            strict: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
            schema: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
            type: z.ZodEnum<["text", "json_object", "json_schema"]>;
            name: z.ZodOptional<z.ZodString>;
            strict: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
            schema: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.ZodTypeAny, "passthrough">>>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        format: z.ZodOptional<z.ZodObject<{
            type: z.ZodEnum<["text", "json_object", "json_schema"]>;
            name: z.ZodOptional<z.ZodString>;
            strict: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
            schema: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
            type: z.ZodEnum<["text", "json_object", "json_schema"]>;
            name: z.ZodOptional<z.ZodString>;
            strict: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
            schema: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
            type: z.ZodEnum<["text", "json_object", "json_schema"]>;
            name: z.ZodOptional<z.ZodString>;
            strict: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
            schema: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.ZodTypeAny, "passthrough">>>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        format: z.ZodOptional<z.ZodObject<{
            type: z.ZodEnum<["text", "json_object", "json_schema"]>;
            name: z.ZodOptional<z.ZodString>;
            strict: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
            schema: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
            type: z.ZodEnum<["text", "json_object", "json_schema"]>;
            name: z.ZodOptional<z.ZodString>;
            strict: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
            schema: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
            type: z.ZodEnum<["text", "json_object", "json_schema"]>;
            name: z.ZodOptional<z.ZodString>;
            strict: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
            schema: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.ZodTypeAny, "passthrough">>>;
    }, z.ZodTypeAny, "passthrough">>>>;
    top_k: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    min_p: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    seed: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    presence_penalty: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    frequency_penalty: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    repetition_penalty: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    logit_bias: z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodNumber>>>;
    logprobs: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
    top_logprobs: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    response_format: z.ZodOptional<z.ZodNullable<z.ZodObject<{
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
    max_completion_tokens: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    model: z.ZodOptional<z.ZodString>;
    instructions: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    input: z.ZodUnion<[z.ZodString, z.ZodArray<z.ZodUnion<[z.ZodObject<{
        type: z.ZodLiteral<"function_call">;
        call_id: z.ZodString;
        name: z.ZodString;
        arguments: z.ZodString;
        id: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        type: "function_call";
        name: string;
        arguments: string;
        call_id: string;
        id?: string | undefined;
    }, {
        type: "function_call";
        name: string;
        arguments: string;
        call_id: string;
        id?: string | undefined;
    }>, z.ZodObject<{
        type: z.ZodLiteral<"function_call_output">;
        call_id: z.ZodString;
        output: z.ZodUnion<[z.ZodString, z.ZodArray<z.ZodObject<{
            type: z.ZodString;
        }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
            type: z.ZodString;
        }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
            type: z.ZodString;
        }, z.ZodTypeAny, "passthrough">>, "many">, z.ZodRecord<z.ZodString, z.ZodUnknown>]>;
    }, "strip", z.ZodTypeAny, {
        output: string | Record<string, unknown> | z.objectOutputType<{
            type: z.ZodString;
        }, z.ZodTypeAny, "passthrough">[];
        type: "function_call_output";
        call_id: string;
    }, {
        output: string | Record<string, unknown> | z.objectInputType<{
            type: z.ZodString;
        }, z.ZodTypeAny, "passthrough">[];
        type: "function_call_output";
        call_id: string;
    }>, z.ZodObject<{
        type: z.ZodOptional<z.ZodLiteral<"message">>;
        role: z.ZodEnum<["system", "developer", "user", "assistant"]>;
        content: z.ZodUnion<[z.ZodString, z.ZodArray<z.ZodObject<{
            type: z.ZodString;
        }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
            type: z.ZodString;
        }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
            type: z.ZodString;
        }, z.ZodTypeAny, "passthrough">>, "many">]>;
    }, "strip", z.ZodTypeAny, {
        content: string | z.objectOutputType<{
            type: z.ZodString;
        }, z.ZodTypeAny, "passthrough">[];
        role: "system" | "user" | "assistant" | "developer";
        type?: "message" | undefined;
    }, {
        content: string | z.objectInputType<{
            type: z.ZodString;
        }, z.ZodTypeAny, "passthrough">[];
        role: "system" | "user" | "assistant" | "developer";
        type?: "message" | undefined;
    }>]>, "many">]>;
    stream: z.ZodOptional<z.ZodBoolean>;
    temperature: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    top_p: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    max_output_tokens: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    tools: z.ZodOptional<z.ZodArray<z.ZodObject<{
        type: z.ZodString;
        name: z.ZodOptional<z.ZodString>;
        description: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        parameters: z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>;
        strict: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        type: z.ZodString;
        name: z.ZodOptional<z.ZodString>;
        description: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        parameters: z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>;
        strict: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        type: z.ZodString;
        name: z.ZodOptional<z.ZodString>;
        description: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        parameters: z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>;
        strict: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
    }, z.ZodTypeAny, "passthrough">>, "many">>;
    tool_choice: z.ZodOptional<z.ZodUnion<[z.ZodEnum<["none", "auto", "required"]>, z.ZodObject<{
        type: z.ZodLiteral<"function">;
        name: z.ZodString;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        type: z.ZodLiteral<"function">;
        name: z.ZodString;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        type: z.ZodLiteral<"function">;
        name: z.ZodString;
    }, z.ZodTypeAny, "passthrough">>]>>;
    parallel_tool_calls: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    text: z.ZodOptional<z.ZodNullable<z.ZodObject<{
        format: z.ZodOptional<z.ZodObject<{
            type: z.ZodEnum<["text", "json_object", "json_schema"]>;
            name: z.ZodOptional<z.ZodString>;
            strict: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
            schema: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
            type: z.ZodEnum<["text", "json_object", "json_schema"]>;
            name: z.ZodOptional<z.ZodString>;
            strict: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
            schema: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
            type: z.ZodEnum<["text", "json_object", "json_schema"]>;
            name: z.ZodOptional<z.ZodString>;
            strict: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
            schema: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.ZodTypeAny, "passthrough">>>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        format: z.ZodOptional<z.ZodObject<{
            type: z.ZodEnum<["text", "json_object", "json_schema"]>;
            name: z.ZodOptional<z.ZodString>;
            strict: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
            schema: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
            type: z.ZodEnum<["text", "json_object", "json_schema"]>;
            name: z.ZodOptional<z.ZodString>;
            strict: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
            schema: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
            type: z.ZodEnum<["text", "json_object", "json_schema"]>;
            name: z.ZodOptional<z.ZodString>;
            strict: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
            schema: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.ZodTypeAny, "passthrough">>>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        format: z.ZodOptional<z.ZodObject<{
            type: z.ZodEnum<["text", "json_object", "json_schema"]>;
            name: z.ZodOptional<z.ZodString>;
            strict: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
            schema: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
            type: z.ZodEnum<["text", "json_object", "json_schema"]>;
            name: z.ZodOptional<z.ZodString>;
            strict: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
            schema: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
            type: z.ZodEnum<["text", "json_object", "json_schema"]>;
            name: z.ZodOptional<z.ZodString>;
            strict: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
            schema: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.ZodTypeAny, "passthrough">>>;
    }, z.ZodTypeAny, "passthrough">>>>;
    top_k: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    min_p: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    seed: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    presence_penalty: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    frequency_penalty: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    repetition_penalty: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    logit_bias: z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodNumber>>>;
    logprobs: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
    top_logprobs: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    response_format: z.ZodOptional<z.ZodNullable<z.ZodObject<{
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
    max_completion_tokens: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    model: z.ZodOptional<z.ZodString>;
    instructions: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    input: z.ZodUnion<[z.ZodString, z.ZodArray<z.ZodUnion<[z.ZodObject<{
        type: z.ZodLiteral<"function_call">;
        call_id: z.ZodString;
        name: z.ZodString;
        arguments: z.ZodString;
        id: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        type: "function_call";
        name: string;
        arguments: string;
        call_id: string;
        id?: string | undefined;
    }, {
        type: "function_call";
        name: string;
        arguments: string;
        call_id: string;
        id?: string | undefined;
    }>, z.ZodObject<{
        type: z.ZodLiteral<"function_call_output">;
        call_id: z.ZodString;
        output: z.ZodUnion<[z.ZodString, z.ZodArray<z.ZodObject<{
            type: z.ZodString;
        }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
            type: z.ZodString;
        }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
            type: z.ZodString;
        }, z.ZodTypeAny, "passthrough">>, "many">, z.ZodRecord<z.ZodString, z.ZodUnknown>]>;
    }, "strip", z.ZodTypeAny, {
        output: string | Record<string, unknown> | z.objectOutputType<{
            type: z.ZodString;
        }, z.ZodTypeAny, "passthrough">[];
        type: "function_call_output";
        call_id: string;
    }, {
        output: string | Record<string, unknown> | z.objectInputType<{
            type: z.ZodString;
        }, z.ZodTypeAny, "passthrough">[];
        type: "function_call_output";
        call_id: string;
    }>, z.ZodObject<{
        type: z.ZodOptional<z.ZodLiteral<"message">>;
        role: z.ZodEnum<["system", "developer", "user", "assistant"]>;
        content: z.ZodUnion<[z.ZodString, z.ZodArray<z.ZodObject<{
            type: z.ZodString;
        }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
            type: z.ZodString;
        }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
            type: z.ZodString;
        }, z.ZodTypeAny, "passthrough">>, "many">]>;
    }, "strip", z.ZodTypeAny, {
        content: string | z.objectOutputType<{
            type: z.ZodString;
        }, z.ZodTypeAny, "passthrough">[];
        role: "system" | "user" | "assistant" | "developer";
        type?: "message" | undefined;
    }, {
        content: string | z.objectInputType<{
            type: z.ZodString;
        }, z.ZodTypeAny, "passthrough">[];
        role: "system" | "user" | "assistant" | "developer";
        type?: "message" | undefined;
    }>]>, "many">]>;
    stream: z.ZodOptional<z.ZodBoolean>;
    temperature: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    top_p: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    max_output_tokens: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    tools: z.ZodOptional<z.ZodArray<z.ZodObject<{
        type: z.ZodString;
        name: z.ZodOptional<z.ZodString>;
        description: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        parameters: z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>;
        strict: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        type: z.ZodString;
        name: z.ZodOptional<z.ZodString>;
        description: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        parameters: z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>;
        strict: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        type: z.ZodString;
        name: z.ZodOptional<z.ZodString>;
        description: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        parameters: z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>;
        strict: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
    }, z.ZodTypeAny, "passthrough">>, "many">>;
    tool_choice: z.ZodOptional<z.ZodUnion<[z.ZodEnum<["none", "auto", "required"]>, z.ZodObject<{
        type: z.ZodLiteral<"function">;
        name: z.ZodString;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        type: z.ZodLiteral<"function">;
        name: z.ZodString;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        type: z.ZodLiteral<"function">;
        name: z.ZodString;
    }, z.ZodTypeAny, "passthrough">>]>>;
    parallel_tool_calls: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    text: z.ZodOptional<z.ZodNullable<z.ZodObject<{
        format: z.ZodOptional<z.ZodObject<{
            type: z.ZodEnum<["text", "json_object", "json_schema"]>;
            name: z.ZodOptional<z.ZodString>;
            strict: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
            schema: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
            type: z.ZodEnum<["text", "json_object", "json_schema"]>;
            name: z.ZodOptional<z.ZodString>;
            strict: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
            schema: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
            type: z.ZodEnum<["text", "json_object", "json_schema"]>;
            name: z.ZodOptional<z.ZodString>;
            strict: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
            schema: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.ZodTypeAny, "passthrough">>>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        format: z.ZodOptional<z.ZodObject<{
            type: z.ZodEnum<["text", "json_object", "json_schema"]>;
            name: z.ZodOptional<z.ZodString>;
            strict: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
            schema: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
            type: z.ZodEnum<["text", "json_object", "json_schema"]>;
            name: z.ZodOptional<z.ZodString>;
            strict: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
            schema: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
            type: z.ZodEnum<["text", "json_object", "json_schema"]>;
            name: z.ZodOptional<z.ZodString>;
            strict: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
            schema: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.ZodTypeAny, "passthrough">>>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        format: z.ZodOptional<z.ZodObject<{
            type: z.ZodEnum<["text", "json_object", "json_schema"]>;
            name: z.ZodOptional<z.ZodString>;
            strict: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
            schema: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
            type: z.ZodEnum<["text", "json_object", "json_schema"]>;
            name: z.ZodOptional<z.ZodString>;
            strict: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
            schema: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
            type: z.ZodEnum<["text", "json_object", "json_schema"]>;
            name: z.ZodOptional<z.ZodString>;
            strict: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
            schema: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.ZodTypeAny, "passthrough">>>;
    }, z.ZodTypeAny, "passthrough">>>>;
    top_k: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    min_p: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    seed: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    presence_penalty: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    frequency_penalty: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    repetition_penalty: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    logit_bias: z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodNumber>>>;
    logprobs: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
    top_logprobs: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    response_format: z.ZodOptional<z.ZodNullable<z.ZodObject<{
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
    max_completion_tokens: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    model: z.ZodOptional<z.ZodString>;
    instructions: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    input: z.ZodUnion<[z.ZodString, z.ZodArray<z.ZodUnion<[z.ZodObject<{
        type: z.ZodLiteral<"function_call">;
        call_id: z.ZodString;
        name: z.ZodString;
        arguments: z.ZodString;
        id: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        type: "function_call";
        name: string;
        arguments: string;
        call_id: string;
        id?: string | undefined;
    }, {
        type: "function_call";
        name: string;
        arguments: string;
        call_id: string;
        id?: string | undefined;
    }>, z.ZodObject<{
        type: z.ZodLiteral<"function_call_output">;
        call_id: z.ZodString;
        output: z.ZodUnion<[z.ZodString, z.ZodArray<z.ZodObject<{
            type: z.ZodString;
        }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
            type: z.ZodString;
        }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
            type: z.ZodString;
        }, z.ZodTypeAny, "passthrough">>, "many">, z.ZodRecord<z.ZodString, z.ZodUnknown>]>;
    }, "strip", z.ZodTypeAny, {
        output: string | Record<string, unknown> | z.objectOutputType<{
            type: z.ZodString;
        }, z.ZodTypeAny, "passthrough">[];
        type: "function_call_output";
        call_id: string;
    }, {
        output: string | Record<string, unknown> | z.objectInputType<{
            type: z.ZodString;
        }, z.ZodTypeAny, "passthrough">[];
        type: "function_call_output";
        call_id: string;
    }>, z.ZodObject<{
        type: z.ZodOptional<z.ZodLiteral<"message">>;
        role: z.ZodEnum<["system", "developer", "user", "assistant"]>;
        content: z.ZodUnion<[z.ZodString, z.ZodArray<z.ZodObject<{
            type: z.ZodString;
        }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
            type: z.ZodString;
        }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
            type: z.ZodString;
        }, z.ZodTypeAny, "passthrough">>, "many">]>;
    }, "strip", z.ZodTypeAny, {
        content: string | z.objectOutputType<{
            type: z.ZodString;
        }, z.ZodTypeAny, "passthrough">[];
        role: "system" | "user" | "assistant" | "developer";
        type?: "message" | undefined;
    }, {
        content: string | z.objectInputType<{
            type: z.ZodString;
        }, z.ZodTypeAny, "passthrough">[];
        role: "system" | "user" | "assistant" | "developer";
        type?: "message" | undefined;
    }>]>, "many">]>;
    stream: z.ZodOptional<z.ZodBoolean>;
    temperature: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    top_p: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    max_output_tokens: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    tools: z.ZodOptional<z.ZodArray<z.ZodObject<{
        type: z.ZodString;
        name: z.ZodOptional<z.ZodString>;
        description: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        parameters: z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>;
        strict: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        type: z.ZodString;
        name: z.ZodOptional<z.ZodString>;
        description: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        parameters: z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>;
        strict: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        type: z.ZodString;
        name: z.ZodOptional<z.ZodString>;
        description: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        parameters: z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>;
        strict: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
    }, z.ZodTypeAny, "passthrough">>, "many">>;
    tool_choice: z.ZodOptional<z.ZodUnion<[z.ZodEnum<["none", "auto", "required"]>, z.ZodObject<{
        type: z.ZodLiteral<"function">;
        name: z.ZodString;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        type: z.ZodLiteral<"function">;
        name: z.ZodString;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        type: z.ZodLiteral<"function">;
        name: z.ZodString;
    }, z.ZodTypeAny, "passthrough">>]>>;
    parallel_tool_calls: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
}, z.ZodTypeAny, "passthrough">>;
type ResponsesRequest = z.infer<typeof responsesRequestSchema>;
export declare function responsesInputHasImage(req: ResponsesRequest): boolean;
export declare function toChatMessages(req: ResponsesRequest): ChatMessage[];
export declare function toChatTools(tools?: ResponsesRequest['tools']): ChatToolDefinition[] | undefined;
export declare function toChatToolChoice(tc?: ResponsesRequest['tool_choice']): ChatToolChoice | undefined;
export declare function buildResponseObject(opts: {
    id: string;
    model: string;
    text: string;
    toolCalls: ChatToolCall[];
    promptTokens: number;
    completionTokens: number;
}): {
    id: string;
    object: string;
    created_at: number;
    status: string;
    model: string;
    output: any[];
    output_text: string;
    usage: {
        input_tokens: number;
        input_tokens_details: {
            cached_tokens: number;
        };
        output_tokens: number;
        output_tokens_details: {
            reasoning_tokens: number;
        };
        total_tokens: number;
    };
};
export {};
//# sourceMappingURL=responses.d.ts.map