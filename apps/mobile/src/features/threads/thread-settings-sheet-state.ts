import type { ModelOption, ProviderGroup } from "../../lib/modelOptions";
import type { ModelSelection, ProviderInstanceId } from "@t3tools/contracts";

export type ModelFavorite = {
  readonly provider: ProviderInstanceId;
  readonly model: string;
};

export function modelFavoriteKey(provider: ProviderInstanceId, model: string): string {
  return `${provider}:${model}`;
}

export function toggleModelFavorite(
  favorites: ReadonlyArray<ModelFavorite>,
  option: ModelOption,
): ReadonlyArray<ModelFavorite> {
  const provider = option.selection.instanceId;
  const model = option.selection.model;
  return favorites.some((favorite) => favorite.provider === provider && favorite.model === model)
    ? favorites.filter((favorite) => favorite.provider !== provider || favorite.model !== model)
    : [...favorites, { provider, model }];
}

export type ModelUse = ModelFavorite & { readonly usedAt: string };

export function recentModelUses(
  threads: ReadonlyArray<{ readonly modelSelection: ModelSelection; readonly updatedAt: string }>,
): ReadonlyArray<ModelUse> {
  const uses = new Map<string, ModelUse>();
  for (const thread of threads) {
    const { instanceId: provider, model } = thread.modelSelection;
    const key = modelFavoriteKey(provider, model);
    if (!uses.has(key) || thread.updatedAt > uses.get(key)!.usedAt)
      uses.set(key, { provider, model, usedAt: thread.updatedAt });
  }
  return [...uses.values()].sort((a, b) => b.usedAt.localeCompare(a.usedAt));
}

export function visiblePickerModels(
  models: ReadonlyArray<ModelOption>,
  hidden: ReadonlySet<string>,
  selected: ModelSelection | null,
  showHidden: boolean,
): ReadonlyArray<ModelOption> {
  return models.filter((option) =>
    showHidden
      ? hidden.has(option.key)
      : !hidden.has(option.key) ||
        (option.selection.instanceId === selected?.instanceId &&
          option.selection.model === selected.model),
  );
}

/** Favorites retain catalog order; other models follow their last thread use. */
export function favoritesFirst(
  models: ReadonlyArray<ModelOption>,
  favoriteKeys: ReadonlySet<string>,
  recent: ReadonlyArray<ModelUse> = [],
): ReadonlyArray<ModelOption> {
  const favorites: ModelOption[] = [];
  const others: ModelOption[] = [];
  for (const model of models) {
    (favoriteKeys.has(model.key) ? favorites : others).push(model);
  }
  const rank = new Map(
    recent.map((use, index) => [modelFavoriteKey(use.provider, use.model), index]),
  );
  others.sort((a, b) => (rank.get(a.key) ?? Infinity) - (rank.get(b.key) ?? Infinity));
  return [...favorites, ...others];
}

/** Match the terms a user can actually see or recognize in the model picker. */
export function modelMatchesCatalogQuery(input: {
  readonly model: ModelOption;
  readonly providerLabel: string;
  readonly query: string;
}): boolean {
  const query = input.query.trim().toLocaleLowerCase();
  if (query.length === 0) {
    return true;
  }

  return [
    input.model.label,
    input.model.subtitle,
    input.model.selection.model,
    input.providerLabel,
  ].some((value) => value.toLocaleLowerCase().includes(query));
}

/** Preserve staged provider options when the highlighted model is tapped again. */
export function pendingModelAfterPress(input: {
  readonly current: ModelOption | null;
  readonly pressed: ModelOption;
  readonly pressedIsApplied: boolean;
}): ModelOption | null {
  if (input.pressedIsApplied) {
    return null;
  }
  return input.current?.key === input.pressed.key ? input.current : input.pressed;
}

/** A model can disappear while the picker is open. */
export function canCommitPendingModel(
  pending: ModelOption,
  groups: ReadonlyArray<ProviderGroup>,
): boolean {
  return groups.some((group) =>
    group.models.some((model) => model.key === pending.key && !model.isUnavailable),
  );
}

/**
 * Primary and selected providers start open; all other catalogs start closed.
 * A user's disclosure tap inverts that default until the picker is dismissed.
 */
export function providerSectionIsCollapsed(input: {
  readonly defaultExpanded: boolean;
  readonly hasExpansionOverride: boolean;
  readonly isNarrowed: boolean;
}): boolean {
  if (input.isNarrowed) {
    return false;
  }
  return input.defaultExpanded ? input.hasExpansionOverride : !input.hasExpansionOverride;
}
