/** Platforms with a media adapter below. catalog-sync gates media rows on this
 *  (decoupled from the chat provider registry — e.g. SiliconFlow is media-only). */
export declare const MEDIA_PLATFORMS: Set<string>;
export type MediaModality = 'image' | 'audio';
export interface MediaModelRow {
    id: number;
    platform: string;
    model_id: string;
    display_name: string;
    modality: MediaModality;
    priority: number;
    enabled: number;
    quota_label: string;
    key_id: number | null;
}
export declare class MediaError extends Error {
    status: number;
    constructor(message: string, status: number);
}
export interface ImageResult {
    platform: string;
    modelId: string;
    images: Array<{
        b64_json?: string;
        url?: string;
    }>;
}
export interface SpeechResult {
    platform: string;
    modelId: string;
    audio: Buffer;
    contentType: string;
}
export interface ImageParams {
    prompt: string;
    n?: number;
    size?: string;
}
export interface SpeechParams {
    input: string;
    voice?: string;
    format?: string;
}
export declare function listMediaModels(modality: MediaModality): MediaModelRow[];
/** All media models (both modalities, including disabled) for the dashboard. */
export declare function listAllMediaModels(): MediaModelRow[];
/** Generate image(s), failing over across providers serving the modality. */
export declare function runImageGeneration(model: string | undefined, params: ImageParams): Promise<ImageResult>;
/** Synthesize speech, failing over across providers serving the modality. */
export declare function runSpeech(model: string | undefined, params: SpeechParams): Promise<SpeechResult>;
//# sourceMappingURL=media.d.ts.map