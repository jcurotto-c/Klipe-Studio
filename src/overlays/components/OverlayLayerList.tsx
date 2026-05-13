/**
 * OverlayLayerList — sidebar list of overlays with reorder, hide/show,
 * rename, duplicate, delete. Top of the list = highest z = drawn on top.
 *
 * Reorder uses HTML5 drag-and-drop (vertical only) — the simplest API for a
 * one-dimensional list. We re-stamp z values in the parent after every drop
 * so list order stays canonical with stacking order.
 *
 * Rename is double-click → inline input → Enter/blur to commit, Escape to
 * cancel.
 */

import {
  useMemo,
  useState,
  type ChangeEvent,
  type DragEvent,
  type KeyboardEvent,
} from 'react';
import type { Overlay } from '../types';

interface OverlayLayerListProps {
  overlays: Overlay[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onToggleHide: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onDuplicate: (id: string) => void;
  onRemove: (id: string) => void;
  onReorder: (fromId: string, toIndex: number) => void;
}

export default function OverlayLayerList({
  overlays,
  selectedId,
  onSelect,
  onToggleHide,
  onRename,
  onDuplicate,
  onRemove,
  onReorder,
}: OverlayLayerListProps): JSX.Element {
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);

  // Sorted top-to-bottom by z descending so visually-on-top is first in list.
  const sorted = useMemo(() => [...overlays].sort((a, b) => b.z - a.z), [overlays]);

  const startRename = (overlay: Overlay): void => {
    setRenameId(overlay.id);
    setRenameValue(overlay.name ?? defaultLabel(overlay));
  };

  const commitRename = (): void => {
    if (renameId) onRename(renameId, renameValue.trim());
    setRenameId(null);
    setRenameValue('');
  };

  const cancelRename = (): void => {
    setRenameId(null);
    setRenameValue('');
  };

  const onRenameKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
    else if (e.key === 'Escape') { e.preventDefault(); cancelRename(); }
  };

  const onDragStart = (e: DragEvent<HTMLDivElement>, id: string): void => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', id);
    setDraggingId(id);
  };

  const onDragOver = (e: DragEvent<HTMLDivElement>, index: number): void => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dragOverIndex !== index) setDragOverIndex(index);
  };

  const onDrop = (e: DragEvent<HTMLDivElement>, index: number): void => {
    e.preventDefault();
    const id = e.dataTransfer.getData('text/plain') || draggingId;
    setDragOverIndex(null);
    setDraggingId(null);
    if (!id) return;
    onReorder(id, index);
  };

  const onDragEnd = (): void => {
    setDragOverIndex(null);
    setDraggingId(null);
  };

  return (
    <aside className="layer-list">
      <div className="layer-list-header">
        <span className="layer-list-title">Layers</span>
        <span className="layer-list-count">{overlays.length}</span>
      </div>
      {sorted.map((ov, i) => {
        const isSel = ov.id === selectedId;
        const isRenaming = ov.id === renameId;
        const isDragging = ov.id === draggingId;
        const isDragOver = dragOverIndex === i && !isDragging;
        return (
          <div
            key={ov.id}
            className={
              'layer-row'
              + (isSel ? ' selected' : '')
              + (ov.hidden ? ' hidden' : '')
              + (isDragging ? ' dragging' : '')
              + (isDragOver ? ' drag-over' : '')
            }
            draggable={!isRenaming}
            onDragStart={(e) => onDragStart(e, ov.id)}
            onDragOver={(e) => onDragOver(e, i)}
            onDrop={(e) => onDrop(e, i)}
            onDragEnd={onDragEnd}
            onClick={() => onSelect(ov.id)}
            onDoubleClick={() => startRename(ov)}
          >
            <button
              type="button"
              className="layer-eye"
              onClick={(e) => { e.stopPropagation(); onToggleHide(ov.id); }}
              title={ov.hidden ? 'Show layer' : 'Hide layer'}
            >
              {ov.hidden ? '◌' : '●'}
            </button>
            <span className="layer-type-glyph" aria-hidden="true">
              {ov.type === 'text' ? 'T' : '🖼'}
            </span>
            {isRenaming ? (
              <input
                className="layer-rename"
                value={renameValue}
                autoFocus
                onChange={(e: ChangeEvent<HTMLInputElement>) => setRenameValue(e.target.value)}
                onBlur={commitRename}
                onKeyDown={onRenameKey}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <span className="layer-name" title={ov.name ?? defaultLabel(ov)}>
                {ov.name?.trim() || defaultLabel(ov)}
              </span>
            )}
            <button
              type="button"
              className="layer-action"
              onClick={(e) => { e.stopPropagation(); onDuplicate(ov.id); }}
              title="Duplicate"
            >
              ⧉
            </button>
            <button
              type="button"
              className="layer-action danger"
              onClick={(e) => { e.stopPropagation(); onRemove(ov.id); }}
              title="Delete"
            >
              ×
            </button>
          </div>
        );
      })}
    </aside>
  );
}

function defaultLabel(overlay: Overlay): string {
  if (overlay.type === 'text') return overlay.text.slice(0, 24) || 'Text';
  return 'Image';
}
