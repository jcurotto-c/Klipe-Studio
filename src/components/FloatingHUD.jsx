import React, { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';

const CAPTURE_MODES = [
  { id: 'display', label: 'Display', icon: DisplayIcon },
  { id: 'window', label: 'Window', icon: WindowIcon },
  { id: 'area', label: 'Area', icon: AreaIcon },
  { id: 'device', label: 'Device', icon: DeviceIcon }
];

const CAMERA_RESOLUTIONS = ['4K (2160p)', '1080p', '720p', '480p'];

export default function FloatingHUD() {
  const [mode, setMode] = useState('display');
  const [micId, setMicId] = useState('');
  const [camId, setCamId] = useState('');
  const [systemAudio, setSystemAudio] = useState(true);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [camResolution, setCamResolution] = useState('1080p');
  const [showCamPreview, setShowCamPreview] = useState(true);

  const [mics, setMics] = useState([]);
  const [cams, setCams] = useState([]);

  const emit = useCallback((type, data) => {
    if (window.klipeHud) window.klipeHud.emit({ type, ...data });
  }, []);

  useEffect(() => {
    if (!window.klipeHud) return;
    return window.klipeHud.onState((state) => {
      if (typeof state.recording === 'boolean') setRecording(state.recording);
      if (typeof state.mode === 'string') setMode(state.mode);
    });
  }, []);

  const refreshDevices = useCallback(async () => {
    try {
      const tmp = await navigator.mediaDevices.getUserMedia({ audio: true, video: true }).catch(() => null);
      const all = await navigator.mediaDevices.enumerateDevices();
      setMics(all.filter((d) => d.kind === 'audioinput'));
      setCams(all.filter((d) => d.kind === 'videoinput'));
      if (tmp) tmp.getTracks().forEach((t) => t.stop());
    } catch (e) {
      console.warn('Device enumeration failed:', e);
    }
  }, []);

  useEffect(() => {
    refreshDevices();
    const onChange = () => refreshDevices();
    navigator.mediaDevices?.addEventListener?.('devicechange', onChange);
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', onChange);
  }, [refreshDevices]);

  // Track whether any dropdown is currently open so the window can resize.
  const [openMenuCount, setOpenMenuCount] = useState(0);
  const incOpen = useCallback(() => setOpenMenuCount((n) => n + 1), []);
  const decOpen = useCallback(() => setOpenMenuCount((n) => Math.max(0, n - 1)), []);

  // Resize the HUD window to fit current content (bar only, or bar + menu).
  // Measured via getBoundingClientRect so it tracks dynamic menu heights.
  const measureRef = useRef(null);
  useLayoutEffect(() => {
    if (!window.klipeHud?.setSize) return;
    const measure = () => {
      const bar = document.querySelector('.hud-bar');
      const menus = Array.from(document.querySelectorAll('.hud-menu.is-ready'));
      const barRect = bar?.getBoundingClientRect();
      let bottom = (barRect?.bottom || 0) + 8;
      let rightMost = (barRect?.right || 0) + 8;
      let leftMost = (barRect?.left || 0) - 8;
      for (const m of menus) {
        const r = m.getBoundingClientRect();
        bottom = Math.max(bottom, r.bottom + 8);
        rightMost = Math.max(rightMost, r.right + 8);
        leftMost = Math.min(leftMost, r.left - 8);
      }
      const width = Math.ceil(Math.max(560, rightMost - Math.min(0, leftMost)));
      const height = Math.ceil(Math.max(64, bottom));
      window.klipeHud.setSize(width, height);
    };
    // Run on next frame so menus measured after they animate into is-ready
    const id = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(id);
  }, [openMenuCount, mode, micId, camId, systemAudio, recording, mics.length, cams.length]);

  useEffect(() => {
    if (!recording) { setElapsed(0); return; }
    const start = Date.now();
    const id = setInterval(() => setElapsed(Date.now() - start), 200);
    return () => clearInterval(id);
  }, [recording]);

  const onSelectMode = (id) => { setMode(id); emit('mode-change', { mode: id }); };
  const onPickMic = (id) => {
    setMicId(id === 'off' ? '' : id);
    emit('mic-change', { deviceId: id });
  };
  const onPickCam = (id) => {
    setCamId(id === 'off' ? '' : id);
    emit('camera-change', { deviceId: id });
  };
  const onToggleSystemAudio = () => {
    setSystemAudio((v) => { const n = !v; emit('system-audio-change', { enabled: n }); return n; });
  };

  const onToggleRecord = () => {
    if (recording) emit('stop-recording', {});
    else emit('start-recording', { mode, micId, camId: camId || null, systemAudio });
    setRecording((r) => !r);
  };

  // ── Menu definitions ────────────────────────────────────────────
  const micItems = [
    { type: 'item', id: 'off', label: 'Don’t record audio', selected: !micId },
    ...(mics.length ? [{ type: 'divider' }] : []),
    ...mics.map((d, i) => ({
      type: 'item',
      id: d.deviceId,
      label: d.label || `Microphone ${i + 1}`,
      selected: d.deviceId === micId,
      defaultMark: i === 0
    }))
  ];

  const camItems = [
    ...cams.map((d, i) => ({
      type: 'item',
      id: d.deviceId,
      label: d.label || `Camera ${i + 1}`,
      selected: d.deviceId === camId,
      defaultMark: i === 0
    })),
    ...(cams.length ? [{ type: 'divider' }] : []),
    { type: 'item', id: 'off', label: 'Don’t record camera', selected: !camId },
    { type: 'divider' },
    {
      type: 'submenu',
      id: 'res',
      label: 'Max camera resolution',
      submenu: CAMERA_RESOLUTIONS.map((r) => ({
        type: 'item',
        id: r,
        label: r,
        selected: r === camResolution
      })),
      onSelect: (id) => setCamResolution(id)
    },
    {
      type: 'item',
      id: 'preview',
      label: showCamPreview ? 'Hide camera preview' : 'Show camera preview'
    }
  ];

  const handleCamSelect = (id) => {
    if (id === 'preview') { setShowCamPreview((v) => !v); return; }
    onPickCam(id);
  };

  return (
    <div className="hud-shell" data-recording={recording ? '1' : '0'}>
      <div className="hud-bar">
        {/* Close button (Screen Studio uses one on the left) */}
        <button
          className="hud-close"
          onClick={() => window.klipeHud?.close?.()}
          title="Close"
        >
          <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>

        {/* Drag handle */}
        <div className="hud-drag" title="Drag to move"><span className="hud-drag-grip" /></div>

        {/* Capture modes */}
        <div className="hud-group hud-modes" role="tablist" aria-label="Capture mode">
          {CAPTURE_MODES.map((m) => {
            const Icon = m.icon;
            const active = mode === m.id;
            return (
              <button
                key={m.id}
                role="tab"
                aria-selected={active}
                className={`hud-mode ${active ? 'is-active' : ''}`}
                onClick={() => onSelectMode(m.id)}
                title={m.label}
              >
                <Icon />
                <span>{m.label}</span>
              </button>
            );
          })}
        </div>

        <div className="hud-divider" />

        <MenuTrigger
          className={`hud-icon-toggle ${micId ? 'is-on' : ''}`}
          icon={<MicIcon />}
          items={micItems}
          onSelect={onPickMic}
          onOpen={incOpen}
          onClose={decOpen}
          title="Microphone"
        />

        <MenuTrigger
          className={`hud-icon-toggle ${camId ? 'is-on' : ''}`}
          icon={<CamIcon />}
          items={camItems}
          onSelect={handleCamSelect}
          onOpen={incOpen}
          onClose={decOpen}
          title="Camera"
        />

        <button
          className={`hud-icon-toggle ${systemAudio ? 'is-on' : ''}`}
          onClick={onToggleSystemAudio}
          title={systemAudio ? 'System audio: On' : 'No system audio'}
          aria-pressed={systemAudio}
        >
          <SpeakerIcon muted={!systemAudio} />
          <span className="hud-icon-label">{systemAudio ? '' : 'No system audio'}</span>
        </button>

        <div className="hud-divider" />

        <button
          className={`hud-record ${recording ? 'is-recording' : ''}`}
          onClick={onToggleRecord}
          title={recording ? 'Stop recording' : 'Start recording'}
        >
          <span className="hud-record-dot" />
          <span className="hud-record-label">{recording ? formatTime(elapsed) : 'Record'}</span>
        </button>
      </div>
    </div>
  );
}

/* ─── MenuTrigger: button + caret + macOS-style menu via portal ──── */

function MenuTrigger({ className, icon, items, onSelect, title, onOpen, onClose }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef(null);

  // Notify parent when open state flips so the HUD window can resize.
  useEffect(() => {
    if (open) onOpen?.();
    else onClose?.();
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="hud-picker">
      <button
        ref={triggerRef}
        className={`${className || ''} ${open ? 'is-open' : ''}`}
        onClick={() => setOpen((v) => !v)}
        title={title}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {icon}
        <span className="hud-picker-caret" />
      </button>
      {open && (
        <HudMenu
          anchor={triggerRef}
          items={items}
          onSelect={(id) => { setOpen(false); onSelect?.(id); }}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

/* ─── HudMenu: portaled, viewport-aware, supports submenus ──────── */

function HudMenu({ anchor, items, onSelect, onClose, level = 0, parentRect }) {
  const menuRef = useRef(null);
  const [pos, setPos] = useState({ top: -9999, left: -9999, placement: 'bottom', ready: false });
  const [openSubId, setOpenSubId] = useState(null);
  const subItemRefs = useRef(new Map());
  const closeTimer = useRef(null);

  // Position the menu near the anchor (or to the side, for submenus)
  useLayoutEffect(() => {
    const place = () => {
      const m = menuRef.current?.getBoundingClientRect();
      if (!m) return;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const gap = 6;
      let top, left, placement;

      if (level === 0) {
        const t = anchor?.current?.getBoundingClientRect();
        if (!t) return;
        // Center under trigger, clamp horizontally
        left = Math.round(t.left + t.width / 2 - m.width / 2);
        left = Math.max(8, Math.min(left, vw - m.width - 8));

        const spaceBelow = vh - t.bottom - gap;
        const spaceAbove = t.top - gap;
        if (spaceBelow >= m.height || spaceBelow >= spaceAbove) {
          placement = 'bottom';
          top = Math.round(t.bottom + gap);
        } else {
          placement = 'top';
          top = Math.round(t.top - m.height - gap);
        }
        top = Math.max(8, Math.min(top, vh - m.height - 8));
      } else {
        // Submenu: open to the right of the parent item; flip to left if needed
        const r = parentRect;
        if (!r) return;
        placement = 'right';
        left = Math.round(r.right + 2);
        if (left + m.width > vw - 8) {
          left = Math.round(r.left - m.width - 2);
          placement = 'left';
        }
        left = Math.max(8, Math.min(left, vw - m.width - 8));
        top = Math.round(r.top - 6);
        top = Math.max(8, Math.min(top, vh - m.height - 8));
      }

      setPos({ top, left, placement, ready: true });
    };

    place();
    const raf = requestAnimationFrame(place);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [anchor, parentRect, items.length, level]);

  // Outside click + Escape to close (only the root menu listens)
  useEffect(() => {
    if (level !== 0) return;
    const onDown = (e) => {
      if (anchor?.current?.contains(e.target)) return;
      if (e.target.closest && e.target.closest('.hud-menu')) return;
      onClose?.();
    };
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [anchor, onClose, level]);

  const handleItemEnter = (item) => {
    clearTimeout(closeTimer.current);
    if (item.type === 'submenu') {
      setOpenSubId(item.id);
    } else {
      // Delay so cursor can travel diagonally into a submenu
      closeTimer.current = setTimeout(() => setOpenSubId(null), 80);
    }
  };

  const activeSubItem = items.find((it) => it.type === 'submenu' && it.id === openSubId);
  const activeSubRect = activeSubItem
    ? subItemRefs.current.get(activeSubItem.id)?.getBoundingClientRect()
    : null;

  const menu = (
    <div
      ref={menuRef}
      className={`hud-menu hud-menu--${pos.placement} ${pos.ready ? 'is-ready' : ''}`}
      role="menu"
      style={{ top: pos.top, left: pos.left }}
      onMouseLeave={() => {
        clearTimeout(closeTimer.current);
        closeTimer.current = setTimeout(() => setOpenSubId(null), 120);
      }}
    >
      {items.map((it, idx) => {
        if (it.type === 'divider') return <div key={`d-${idx}`} className="hud-menu-divider" />;
        if (it.type === 'submenu') {
          const isOpen = openSubId === it.id;
          return (
            <button
              key={it.id}
              ref={(el) => { if (el) subItemRefs.current.set(it.id, el); }}
              className={`hud-menu-item has-submenu ${isOpen ? 'is-open' : ''}`}
              role="menuitem"
              aria-haspopup="menu"
              aria-expanded={isOpen}
              onMouseEnter={() => handleItemEnter(it)}
              onClick={() => setOpenSubId((v) => (v === it.id ? null : it.id))}
            >
              <span className="hud-menu-check" aria-hidden />
              <span className="hud-menu-label">{it.label}</span>
              <span className="hud-menu-arrow">
                <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 6l6 6-6 6" />
                </svg>
              </span>
            </button>
          );
        }
        const isSel = !!it.selected;
        return (
          <button
            key={it.id}
            className={`hud-menu-item ${isSel ? 'is-selected' : ''}`}
            role="menuitemradio"
            aria-checked={isSel}
            onMouseEnter={() => handleItemEnter(it)}
            onClick={() => {
              if (it.disabled) return;
              onSelect?.(it.id);
            }}
            disabled={it.disabled}
            title={it.label}
          >
            <span className="hud-menu-check" aria-hidden>
              {isSel ? (
                <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 12.5l4.5 4.5L19 7.5" />
                </svg>
              ) : null}
            </span>
            <span className="hud-menu-label">{it.label}</span>
            {it.defaultMark && <span className="hud-menu-tag">default</span>}
          </button>
        );
      })}
    </div>
  );

  return createPortal(
    <>
      {menu}
      {activeSubItem && activeSubRect && (
        <HudMenu
          level={level + 1}
          parentRect={activeSubRect}
          items={activeSubItem.submenu}
          onSelect={(id) => {
            activeSubItem.onSelect?.(id);
            setOpenSubId(null);
            onSelect?.(null); // close everything
          }}
          onClose={() => setOpenSubId(null)}
        />
      )}
    </>,
    document.body
  );
}

/* ─── helpers ──────────────────────────────────────────────────── */

function formatTime(ms) {
  const total = Math.floor(ms / 1000);
  const m = String(Math.floor(total / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return `${m}:${s}`;
}

/* ─── icons ────────────────────────────────────────────────────── */

function DisplayIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="13" rx="2" />
      <path d="M9 20h6M12 17v3" />
    </svg>
  );
}
function WindowIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 9h18" />
    </svg>
  );
}
function AreaIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="3 2.5">
      <rect x="3.5" y="3.5" width="17" height="17" rx="2" />
    </svg>
  );
}
function DeviceIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="6" width="14" height="12" rx="2" />
      <path d="M17 10l4-2v8l-4-2z" />
    </svg>
  );
}
function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </svg>
  );
}
function CamIcon() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="7" width="13" height="10" rx="2" />
      <path d="M16 11l5-3v8l-5-3z" />
    </svg>
  );
}
function SpeakerIcon({ muted }) {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 10v4h3l5 4V6L7 10H4z" />
      {muted ? (
        <path d="M16 9l5 6M21 9l-5 6" />
      ) : (
        <path d="M16 8a6 6 0 0 1 0 8M18.5 5.5a9 9 0 0 1 0 13" />
      )}
    </svg>
  );
}
