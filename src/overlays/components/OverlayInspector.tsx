/**
 * OverlayInspector — right-panel editor for the currently selected overlay.
 *
 * Mirrors the existing ZoomInspector / BlurInspector layout & class names so
 * it inherits the editor's panel styling without new CSS.
 */

import type { ChangeEvent } from 'react';
import type { ImageOverlay, Overlay, TextOverlay } from '../types';
import {
  ANIMATION_PRESETS,
  detectAnimation,
  type AnimationKind,
} from '../factories';

interface OverlayInspectorProps {
  overlay: Overlay;
  onChange: (patch: Partial<Overlay>) => void;
  onRemove: () => void;
  onApplyAnimation: (kind: AnimationKind) => void;
  onClose: () => void;
}

export default function OverlayInspector({
  overlay,
  onChange,
  onRemove,
  onApplyAnimation,
  onClose,
}: OverlayInspectorProps): JSX.Element {
  const animation = detectAnimation(overlay);
  const setBase = <K extends keyof Overlay['base']>(key: K, value: number): void => {
    onChange({ base: { ...overlay.base, [key]: value } });
  };
  const presetsForType = ANIMATION_PRESETS.filter(
    (p) => !p.textOnly || overlay.type === 'text',
  );

  return (
    <aside className="zoom-inspector">
      <div className="zi-header">
        <div>
          <div className="zi-title">
            {overlay.type === 'text' ? 'Text overlay' : 'Image overlay'}
          </div>
          <div className="zi-sub">{overlay.name || overlay.id}</div>
        </div>
        <button className="ghost zi-close" onClick={onClose} title="Close">✕</button>
      </div>

      {overlay.type === 'text' && (
        <TextFields overlay={overlay} onChange={onChange} />
      )}

      {overlay.type === 'image' && (
        <ImageFields overlay={overlay} onChange={onChange} />
      )}

      {/* Position (percent of canvas) */}
      <div className="zi-field">
        <div className="zi-row">
          <label>Position</label>
          <span className="zi-value">
            {Math.round(overlay.base.x * 100)}% · {Math.round(overlay.base.y * 100)}%
          </span>
        </div>
        <div className="zi-help">Tip: drag the overlay on the canvas to reposition.</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            type="range"
            min="-0.2"
            max="1.2"
            step="0.005"
            value={overlay.base.x}
            onChange={(e) => setBase('x', Number(e.target.value))}
            style={{ flex: 1 }}
          />
          <input
            type="range"
            min="-0.2"
            max="1.2"
            step="0.005"
            value={overlay.base.y}
            onChange={(e) => setBase('y', Number(e.target.value))}
            style={{ flex: 1 }}
          />
        </div>
      </div>

      <div className="zi-field">
        <div className="zi-row">
          <label>Opacity</label>
          <span className="zi-value">{Math.round(overlay.base.opacity * 100)}%</span>
        </div>
        <input
          type="range"
          min="0"
          max="1"
          step="0.01"
          value={overlay.base.opacity}
          onChange={(e) => setBase('opacity', Number(e.target.value))}
        />
      </div>

      <div className="zi-field">
        <div className="zi-row">
          <label>Rotation</label>
          <span className="zi-value">{Math.round((overlay.base.rotation * 180) / Math.PI)}°</span>
        </div>
        <input
          type="range"
          min={-Math.PI}
          max={Math.PI}
          step="0.01"
          value={overlay.base.rotation}
          onChange={(e) => setBase('rotation', Number(e.target.value))}
        />
      </div>

      <div className="zi-field">
        <div className="zi-row">
          <label>Animation</label>
        </div>
        <div className="zi-help">Applied at the layer's start. Replaces any prior animation.</div>
        <select
          value={animation}
          onChange={(e) => onApplyAnimation(e.target.value as AnimationKind)}
          style={{
            width: '100%',
            padding: '6px 8px',
            background: 'var(--surface-2, #1a1c22)',
            color: 'inherit',
            border: '1px solid var(--border, #2a2d35)',
            borderRadius: 6,
          }}
        >
          {presetsForType.map((p) => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </select>
      </div>

      <div className="zi-actions">
        <button className="danger" onClick={onRemove}>Delete overlay</button>
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Text-specific fields
// ---------------------------------------------------------------------------

interface TextFieldsProps {
  overlay: TextOverlay;
  onChange: (patch: Partial<Overlay>) => void;
}

function TextFields({ overlay, onChange }: TextFieldsProps): JSX.Element {
  const set = <K extends keyof TextOverlay>(key: K, value: TextOverlay[K]): void => {
    onChange({ [key]: value } as Partial<Overlay>);
  };

  return (
    <>
      <div className="zi-field">
        <div className="zi-row"><label>Text</label></div>
        <textarea
          value={overlay.text}
          onChange={(e: ChangeEvent<HTMLTextAreaElement>) => {
            set('text', e.target.value);
            // Also keep the layer name in sync for the sidebar/list affordance.
            onChange({ name: e.target.value.slice(0, 24) });
          }}
          rows={2}
          style={{
            width: '100%',
            padding: '6px 8px',
            background: 'var(--surface-2, #1a1c22)',
            color: 'inherit',
            border: '1px solid var(--border, #2a2d35)',
            borderRadius: 6,
            resize: 'vertical',
            fontFamily: 'inherit',
          }}
        />
      </div>

      <div className="zi-field">
        <div className="zi-row">
          <label>Size</label>
          <span className="zi-value">{Math.round(overlay.sizeRel * 100)}% of height</span>
        </div>
        <input
          type="range"
          min="0.02"
          max="0.4"
          step="0.005"
          value={overlay.sizeRel}
          onChange={(e) => set('sizeRel', Number(e.target.value))}
        />
      </div>

      <div className="zi-field">
        <div className="zi-row">
          <label>Color</label>
          <span className="zi-value">{overlay.color.toUpperCase()}</span>
        </div>
        <input
          type="color"
          value={overlay.color}
          onChange={(e) => set('color', e.target.value)}
          style={{ width: '100%', height: 32, padding: 0, border: 'none', background: 'transparent', cursor: 'pointer' }}
        />
      </div>

      <div className="zi-field">
        <div className="zi-row"><label>Weight</label></div>
        <select
          value={String(overlay.weight ?? 700)}
          onChange={(e) => set('weight', Number(e.target.value) as TextOverlay['weight'])}
          style={{
            width: '100%',
            padding: '6px 8px',
            background: 'var(--surface-2, #1a1c22)',
            color: 'inherit',
            border: '1px solid var(--border, #2a2d35)',
            borderRadius: 6,
          }}
        >
          <option value="400">Regular (400)</option>
          <option value="500">Medium (500)</option>
          <option value="600">SemiBold (600)</option>
          <option value="700">Bold (700)</option>
          <option value="800">ExtraBold (800)</option>
          <option value="900">Black (900)</option>
        </select>
      </div>

      <div className="zi-field">
        <div className="zi-row"><label>Style</label></div>
        <div style={{ display: 'flex', gap: 6 }}>
          {(['left', 'center', 'right'] as const).map((a) => (
            <button
              key={a}
              type="button"
              onClick={() => set('align', a)}
              className={overlay.align === a || (!overlay.align && a === 'center') ? 'tool-btn active' : 'tool-btn'}
              style={{ flex: 1, justifyContent: 'center' }}
            >
              {a[0]!.toUpperCase() + a.slice(1)}
            </button>
          ))}
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8 }}>
          <input
            type="checkbox"
            checked={!!overlay.mono}
            onChange={(e) => set('mono', e.target.checked)}
          />
          Monospace
        </label>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Image-specific fields
// ---------------------------------------------------------------------------

interface ImageFieldsProps {
  overlay: ImageOverlay;
  onChange: (patch: Partial<Overlay>) => void;
}

function ImageFields({ overlay, onChange }: ImageFieldsProps): JSX.Element {
  return (
    <div className="zi-field">
      <div className="zi-row">
        <label>Size</label>
        <span className="zi-value">{Math.round(overlay.sizeRel * 100)}% of height</span>
      </div>
      <input
        type="range"
        min="0.05"
        max="1.5"
        step="0.01"
        value={overlay.sizeRel}
        onChange={(e) => onChange({ sizeRel: Number(e.target.value) } as Partial<Overlay>)}
      />
    </div>
  );
}
