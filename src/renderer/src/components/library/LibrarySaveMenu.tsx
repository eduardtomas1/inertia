import { Trash2 } from "lucide-react";
import type { LibraryCategory } from "@shared/library";

import { LibraryMenu, type LibraryMenuAnchor, type LibraryMenuEntry } from "./LibraryMenu";

export function libraryCategoryEntries({
  categories,
  currentCategoryId,
  onMove,
  onCreate,
}: {
  categories: readonly LibraryCategory[];
  currentCategoryId: string | null;
  onMove: (categoryId: string | null) => void;
  onCreate: (name: string) => Promise<string | null>;
}): LibraryMenuEntry[] {
  return [
    {
      kind: "item",
      id: "unsorted",
      label: "Unsorted",
      checked: currentCategoryId === null,
      onSelect: () => {
        if (currentCategoryId !== null) onMove(null);
      },
    },
    ...categories.map((category): LibraryMenuEntry => ({
      kind: "item",
      id: category.id,
      label: category.name,
      checked: currentCategoryId === category.id,
      onSelect: () => {
        if (currentCategoryId !== category.id) onMove(category.id);
      },
    })),
    {
      kind: "create",
      id: "create",
      label: "New category…",
      inputLabel: "New category name",
      onCreate,
    },
  ];
}

export interface LibrarySaveMenuProps {
  categories: readonly LibraryCategory[];
  currentCategoryId: string | null;
  anchor: LibraryMenuAnchor;
  trigger: HTMLElement | null;
  onMove: (categoryId: string | null) => void;
  onCreate: (name: string) => Promise<string | null>;
  onRemove: () => void;
  onDismiss: () => void;
}

export function LibrarySaveMenu({
  categories,
  currentCategoryId,
  anchor,
  trigger,
  onMove,
  onCreate,
  onRemove,
  onDismiss,
}: LibrarySaveMenuProps): React.JSX.Element {
  return (
    <LibraryMenu
      label="Saved to"
      anchor={anchor}
      trigger={trigger}
      className="library-save-menu"
      onDismiss={onDismiss}
      entries={[
        { kind: "heading", id: "heading", label: "Saved to" },
        ...libraryCategoryEntries({ categories, currentCategoryId, onMove, onCreate }),
        { kind: "separator", id: "separator" },
        {
          kind: "item",
          id: "remove",
          label: "Remove from Library",
          icon: <Trash2 size={14} aria-hidden="true" />,
          danger: true,
          onSelect: onRemove,
        },
      ]}
    />
  );
}
