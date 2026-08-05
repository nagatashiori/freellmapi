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
  return entry.enabled && getUsableKeyCount(entry) > 0
}

function getUsableKeyCount(entry: Pick<PlaygroundModelEntry, 'keyCount' | 'routingHealth'>): number {
  return entry.routingHealth?.usableKeyCount ?? entry.keyCount
}

function getGroupKey(entry: PickerEntry): string {
  return entry.groupKey ?? entry.modelId
}

/**
 * Build one option per visible logical model. A group is visible when at least
 * one member is enabled and usable, but its provider badge keeps every member
 * that has usable keys. This shows the full provider composition without
 * making disabled route rows selectable by themselves.
 */
export function buildPlayableModelOptions(entries: PlaygroundModelEntry[]): ModelOption[] {
  const visibleGroups = new Set(
    entries.filter(isPlayableModelEntry).map(getGroupKey),
  )
  const providerEntries = entries.filter(entry =>
    visibleGroups.has(getGroupKey(entry)) && getUsableKeyCount(entry) > 0,
  )
  return buildModelOptions(providerEntries, true)
}

/**
 * A model can disappear between page refreshes. Never send that stale id to the
 * API; keep the two virtual choices (Auto/Fusion) available regardless.
 */
export function reconcilePlaygroundModel(selected: string, options: Array<Pick<ModelOption, 'value'>>): string {
  if (selected === 'auto' || selected === 'fusion') return selected
  return options.some(option => option.value === selected) ? selected : 'auto'
}
