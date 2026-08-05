import { buildModelOptions, type ModelOption, type PickerEntry } from './model-groups'

/** The part of a fallback row needed to decide whether Playground can show it. */
export interface PlaygroundModelEntry extends PickerEntry {
  enabled: boolean
  /** Healthy/enabled keys for this exact model (not just its provider). */
  keyCount: number
  routingHealth?: {
    usableKeyCount: number
  }
}

/**
 * Keep the picker aligned with the router's current model-level availability.
 * `keyCount` is retained as a compatibility fallback for older API responses;
 * new responses use the more precise routing-health count when it is present.
 */
export function isPlayableModelEntry(entry: Pick<PlaygroundModelEntry, 'enabled' | 'keyCount' | 'routingHealth'>): boolean {
  const usableKeyCount = entry.routingHealth?.usableKeyCount ?? entry.keyCount
  return entry.enabled && usableKeyCount > 0
}

/** Build one option per currently playable logical model. */
export function buildPlayableModelOptions(entries: PlaygroundModelEntry[]): ModelOption[] {
  return buildModelOptions(entries.filter(isPlayableModelEntry), true)
}

/**
 * A model can disappear between page refreshes. Never send that stale id to the
 * API; keep the two virtual choices (Auto/Fusion) available regardless.
 */
export function reconcilePlaygroundModel(selected: string, options: Array<Pick<ModelOption, 'value'>>): string {
  if (selected === 'auto' || selected === 'fusion') return selected
  return options.some(option => option.value === selected) ? selected : 'auto'
}
