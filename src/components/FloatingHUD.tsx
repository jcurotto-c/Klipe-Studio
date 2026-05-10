import {
  forwardRef,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useCallback,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import type { HudEvent, HudState, ScreenSource } from '../types';

const AUTO_ZOOM_KEY = 'klipe.autoZoom';

interface SourceCategory {
  label: string;
  bg: string;
  fg: string;
}

function categorize(source: ScreenSource): SourceCategory {
  if (source.kind === 'screen') {
    return { label: 'screen', bg: 'rgba(120, 130, 150, 0.22)', fg: '#b9c2d6' };
  }
  const n = source.name.toLowerCase();
  if (/(chrome|safari|firefox|edge|brave|opera|vivaldi|arc)/.test(n)) {
    return { label: 'browser', bg: 'rgba(122, 81, 247, 0.22)', fg: '#b59bff' };
  }
  if (/(figma|sketch|photoshop|illustrator|affinity|invision|procreate|canva)/.test(n)) {
    return { label: 'design', bg: 'rgba(240, 140, 70, 0.22)', fg: '#ffa86b' };
  }
  if (/(terminal|iterm|powershell|cmd|hyper|warp|alacritty|console)/.test(n)) {
    return { label: 'shell', bg: 'rgba(64, 196, 136, 0.22)', fg: '#4dd99c' };
  }
  if (/(visual studio code|vscode|code\b|cursor|intellij|webstorm|pycharm|xcode|atom|sublime|zed|fleet|nvim|neovim)/.test(n)) {
    return { label: 'editor', bg: 'rgba(96, 140, 240, 0.22)', fg: '#7fa4ff' };
  }
  if (/(notion|word|pages|docs|google docs|confluence|obsidian|evernote|onenote|bear|craft)/.test(n)) {
    return { label: 'docs', bg: 'rgba(180, 140, 220, 0.22)', fg: '#caa6e6' };
  }
  return { label: 'app', bg: 'rgba(255, 255, 255, 0.10)', fg: '#cfd6e3' };
}

interface NameParts {
  app: string;
  title: string | null;
}
function splitName(name: string): NameParts {
  const m = name.match(/^(.*?)\s[—–-]\s(.+)$/);
  if (m && m[1] && m[2]) {
    return { app: m[1].trim(), title: m[2].trim() };
  }
  return { app: name, title: null };
}

function loadAutoZoom(): boolean {
  try {
    const raw = localStorage.getItem(AUTO_ZOOM_KEY);
    if (raw == null) return true;
    return raw === 'true';
  } catch {
    return true;
  }
}

interface MicMenuItem {
  id: string;
  label: string;
  selected?: boolean;
  defaultMark?: boolean;
}

export default function FloatingHUD(): JSX.Element {
  const [sources, setSources] = useState<ScreenSource[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sourcePickerOpen, setSourcePickerOpen] = useState(false);

  const [micEnabled, setMicEnabled] = useState(true);
  const [micId, setMicId] = useState('');
  const [camEnabled, setCamEnabled] = useState(false);
  const [camId, setCamId] = useState('');
  const [autoZoom, setAutoZoom] = useState<boolean>(loadAutoZoom);

  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);

  const [countdown, setCountdown] = useState<number | null>(null);
  const countdownTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Extra padding above the bar inside the shell. Grows when a popover
  // opens above (bar near screen bottom) so the bar stays at its on-screen
  // position while the window expands upward to make room.
  const [shellTopOffset, setShellTopOffset] = useState(0);

  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [cams, setCams] = useState<MediaDeviceInfo[]>([]);

  const [micMenuOpen, setMicMenuOpen] = useState(false);
  const [camMenuOpen, setCamMenuOpen] = useState(false);
  const micBtnRef = useRef<HTMLButtonElement | null>(null);
  const camBtnRef = useRef<HTMLButtonElement | null>(null);

  const emit = useCallback(<E extends HudEvent>(event: E): void => {
    window.klipeHud?.emit(event);
  }, []);

  const refreshSources = useCallback(async () => {
    if (!window.klipe) return;
    try {
      const list = await window.klipe.getScreenSources();
      setSources(list);
      setSelectedId((prev) => {
        if (prev && list.some((s) => s.id === prev)) return prev;
        const screen0 = list.find((s) => s.kind === 'screen') || list[0];
        return screen0 ? screen0.id : null;
      });
    } catch (e) {
      console.warn('Failed to load screen sources:', e);
    }
  }, []);

  useEffect(() => { refreshSources(); }, [refreshSources]);

  useEffect(() => {
    if (!window.klipeHud) return;
    const off = window.klipeHud.onState((state: HudState) => {
      if (typeof state.recording === 'boolean') setRecording(state.recording);
    });
    return off;
  }, []);

  const refreshDevices = useCallback(async () => {
    try {
      const tmp = await navigator.mediaDevices
        .getUserMedia({ audio: true, video: true })
        .catch(() => null);
      const all = await navigator.mediaDevices.enumerateDevices();
      const audioInputs = all.filter((d) => d.kind === 'audioinput');
      const videoInputs = all.filter((d) => d.kind === 'videoinput');
      setMics(audioInputs);
      setCams(videoInputs);
      setMicId((prev) => prev || audioInputs[0]?.deviceId || '');
      setCamId((prev) => prev || videoInputs[0]?.deviceId || '');
      if (tmp) tmp.getTracks().forEach((t) => t.stop());
    } catch (e) {
      console.warn('Device enumeration failed:', e);
    }
  }, []);

  useEffect(() => {
    refreshDevices();
    const onChange = (): void => { refreshDevices(); };
    navigator.mediaDevices?.addEventListener?.('devicechange', onChange);
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', onChange);
  }, [refreshDevices]);

  useLayoutEffect(() => {
    if (!window.klipeHud?.setSize) return;
    const measure = (): void => {
      const bar = document.querySelector('.hud-bar');
      const popovers = Array.from(document.querySelectorAll<HTMLElement>('.hud-popover'));
      const barRect = bar?.getBoundingClientRect();
      if (!barRect) return;
      // Buffer space so the bar's drop shadow can fade out without being
      // clipped by the Electron window edge.
      const SHADOW_BOTTOM = 60;
      const SHADOW_SIDE = 36;
      let bottom = barRect.bottom + SHADOW_BOTTOM;
      let rightMost = barRect.right + SHADOW_SIDE;
      let leftMost = barRect.left - SHADOW_SIDE;
      // Extra room needed above the bar (in window coords) for popovers
      // that opened upward because the bar is near the screen bottom.
      let extraTopNeeded = 0;
      for (const m of popovers) {
        const r = m.getBoundingClientRect();
        if (m.dataset.placement === 'above') {
          // popover.top in current window coords would be: barRect.top - gap - r.height
          // For the popover to fit inside the window with an 8px buffer at the
          // top, we need barRect.top >= r.height + gap + 8.
          const need = r.height + 16 - barRect.top;
          if (need > extraTopNeeded) extraTopNeeded = need;
        } else {
          bottom = Math.max(bottom, r.bottom + 8, barRect.bottom + r.height + 16);
        }
        rightMost = Math.max(rightMost, r.right + 8);
        leftMost = Math.min(leftMost, r.left - 8);
      }
      // Sticky offset: while a popover is open, never shrink (avoids the bar
      // jumping mid-interaction). Reset to 0 when no popover is open.
      const anyPopoverOpen = popovers.length > 0;
      const desiredTop = anyPopoverOpen
        ? Math.max(shellTopOffset, extraTopNeeded)
        : 0;
      const dy = -(desiredTop - shellTopOffset);
      if (desiredTop !== shellTopOffset) setShellTopOffset(desiredTop);
      const width = Math.ceil(Math.max(720, rightMost - Math.min(0, leftMost)));
      const height = Math.ceil(Math.max(140, bottom));
      window.klipeHud!.setSize(width, height, dy);
    };
    const id = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(id);
  }, [
    sourcePickerOpen,
    micMenuOpen,
    camMenuOpen,
    selectedId,
    sources.length,
    micEnabled,
    camEnabled,
    autoZoom,
    recording,
    countdown,
    shellTopOffset,
  ]);

  useEffect(() => {
    if (!recording) { setElapsed(0); return; }
    const start = Date.now();
    const id = setInterval(() => setElapsed(Date.now() - start), 200);
    return () => clearInterval(id);
  }, [recording]);

  const cancelCountdown = useCallback(() => {
    if (countdownTimer.current) {
      clearTimeout(countdownTimer.current);
      countdownTimer.current = null;
    }
    setCountdown(null);
  }, []);

  useEffect(() => () => cancelCountdown(), [cancelCountdown]);

  const onSelectSource = useCallback((id: string) => {
    setSelectedId(id);
    setSourcePickerOpen(false);
    emit({ type: 'source-change', sourceId: id });
  }, [emit]);

  const onPickMic = (id: string): void => {
    if (id === 'off') {
      setMicEnabled(false);
      emit({ type: 'mic-change', deviceId: '' });
    } else {
      setMicId(id);
      setMicEnabled(true);
      emit({ type: 'mic-change', deviceId: id });
    }
    setMicMenuOpen(false);
  };
  const onPickCam = (id: string): void => {
    if (id === 'off') {
      setCamEnabled(false);
      emit({ type: 'camera-change', deviceId: '' });
    } else {
      setCamId(id);
      setCamEnabled(true);
      emit({ type: 'camera-change', deviceId: id });
    }
    setCamMenuOpen(false);
  };

  const onToggleMic = (): void => {
    setMicEnabled((v) => {
      const next = !v;
      emit({ type: 'mic-change', deviceId: next ? micId : '' });
      return next;
    });
  };
  const onToggleCam = (): void => {
    setCamEnabled((v) => {
      const next = !v;
      emit({ type: 'camera-change', deviceId: next ? camId : '' });
      return next;
    });
  };
  const onToggleAutoZoom = (): void => {
    setAutoZoom((v) => {
      const next = !v;
      try { localStorage.setItem(AUTO_ZOOM_KEY, String(next)); } catch { /* ignore */ }
      emit({ type: 'auto-zoom-change', enabled: next });
      return next;
    });
  };

  const startCountdown = useCallback(() => {
    if (!selectedId) return;
    const source = sources.find((s) => s.id === selectedId);
    if (!source) return;
    if (source.kind === 'window') {
      window.klipe?.focusWindowSource?.(source.id);
    }
    setCountdown(3);
    let n = 3;
    const tick = (): void => {
      n -= 1;
      if (n <= 0) {
        setCountdown(null);
        countdownTimer.current = null;
        if (source.kind === 'screen' && source.displayId) {
          window.klipeHud?.moveToDisplay?.(source.displayId);
        }
        emit({
          type: 'start-recording',
          sourceId: selectedId,
          micId: micEnabled ? micId : '',
          camId: camEnabled ? camId : null,
          autoZoom,
          display: {
            width: source.width,
            height: source.height,
            scaleFactor: source.scaleFactor,
          },
        });
        setRecording(true);
      } else {
        setCountdown(n);
        countdownTimer.current = setTimeout(tick, 1000);
      }
    };
    countdownTimer.current = setTimeout(tick, 1000);
  }, [
    selectedId, sources, micEnabled, micId, camEnabled, camId, autoZoom, emit,
  ]);

  const onRecordClick = (): void => {
    if (recording) {
      emit({ type: 'stop-recording' });
      setRecording(false);
      return;
    }
    if (countdown != null) {
      cancelCountdown();
      return;
    }
    startCountdown();
  };

  const selectedSource = sources.find((s) => s.id === selectedId) || null;
  const selectedParts = selectedSource ? splitName(selectedSource.name) : null;

  const micMenuItems: MicMenuItem[] = [
    { id: 'off', label: "Don’t record audio", selected: !micEnabled },
    ...mics.map((d, i) => ({
      id: d.deviceId,
      label: d.label || `Microphone ${i + 1}`,
      selected: micEnabled && d.deviceId === micId,
      defaultMark: i === 0,
    })),
  ];
  const camMenuItems: MicMenuItem[] = [
    ...cams.map((d, i) => ({
      id: d.deviceId,
      label: d.label || `Camera ${i + 1}`,
      selected: camEnabled && d.deviceId === camId,
      defaultMark: i === 0,
    })),
    { id: 'off', label: "Don’t record camera", selected: !camEnabled },
  ];

  const isCounting = countdown != null;
  const isLive = recording || isCounting;

  const onBarPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    // Don't start drag when the user clicked an interactive element.
    if (target.closest('button, [role="button"], input, a, .hud-popover')) return;
    if (!window.klipeHud?.dragBy) return;
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    let lastX = e.screenX;
    let lastY = e.screenY;
    const onMove = (ev: PointerEvent): void => {
      const dx = ev.screenX - lastX;
      const dy = ev.screenY - lastY;
      if (dx === 0 && dy === 0) return;
      lastX = ev.screenX;
      lastY = ev.screenY;
      window.klipeHud?.dragBy(dx, dy);
    };
    const onUp = (ev: PointerEvent): void => {
      try { el.releasePointerCapture(ev.pointerId); } catch { /* ignore */ }
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
    };
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
  }, []);

  return (
    <div
      className="hud-shell"
      data-recording={recording ? '1' : '0'}
      style={{ paddingTop: 16 + shellTopOffset }}
    >
      <div
        className={`hud-bar ${isLive ? 'is-live' : ''}`}
        onPointerDown={onBarPointerDown}
      >
        <div className="hud-traffic" aria-hidden={false}>
          <button
            className="hud-traffic-dot is-close"
            onClick={() => window.klipeHud?.quitApp?.()}
            title="Close"
            aria-label="Close"
          >
            <svg viewBox="0 0 12 12" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
              <path d="M3 3l6 6M9 3l-6 6" />
            </svg>
          </button>
          <button
            className="hud-traffic-dot is-min"
            onClick={() => window.klipeHud?.minimize?.()}
            title="Minimize"
            aria-label="Minimize"
          >
            <svg viewBox="0 0 12 12" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
              <path d="M2.5 6h7" />
            </svg>
          </button>
          <button
            className="hud-traffic-dot is-max"
            onClick={() => window.klipeHud?.showMain?.()}
            title="Open editor"
            aria-label="Open editor"
          >
            <svg viewBox="0 0 12 12" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 5V3h2M9 7v2H7M3 7v2h2M9 5V3H7" />
            </svg>
          </button>
        </div>

        <div className="hud-drag" title="Drag to move"><span className="hud-drag-grip" /></div>

        <SourceSelector
          source={selectedSource}
          parts={selectedParts}
          open={sourcePickerOpen}
          onToggle={() => setSourcePickerOpen((v) => !v)}
          onClose={() => setSourcePickerOpen(false)}
          sources={sources}
          selectedId={selectedId}
          onSelect={onSelectSource}
          onRefresh={refreshSources}
          disabled={isLive}
        />

        <div className="hud-divider" aria-hidden />

        <div className="hud-controls">
          <StackedToggle
            ref={micBtnRef}
            icon={<MicIcon />}
            label="Mic"
            active={micEnabled}
            recording={recording && micEnabled}
            onClick={onToggleMic}
            onContextMenu={(e) => { e.preventDefault(); setMicMenuOpen(true); }}
            onCaretClick={() => setMicMenuOpen(true)}
          />
          {micMenuOpen && (
            <DeviceMenu
              anchor={micBtnRef}
              items={micMenuItems}
              onSelect={onPickMic}
              onClose={() => setMicMenuOpen(false)}
            />
          )}

          <StackedToggle
            ref={camBtnRef}
            icon={<CamIcon />}
            label="Camera"
            active={camEnabled}
            recording={recording && camEnabled}
            onClick={onToggleCam}
            onContextMenu={(e) => { e.preventDefault(); setCamMenuOpen(true); }}
            onCaretClick={() => setCamMenuOpen(true)}
          />
          {camMenuOpen && (
            <DeviceMenu
              anchor={camBtnRef}
              items={camMenuItems}
              onSelect={onPickCam}
              onClose={() => setCamMenuOpen(false)}
            />
          )}

          <StackedToggle
            icon={<SparkleIcon />}
            label="Auto-zoom"
            active={autoZoom}
            variant="purple"
            onClick={onToggleAutoZoom}
          />
        </div>

        <div className="hud-divider hud-divider-soft" aria-hidden />

        <button
          className={`hud-record ${isCounting ? 'is-counting' : ''} ${recording ? 'is-recording' : ''}`}
          onClick={onRecordClick}
          disabled={!selectedId && !recording && !isCounting}
          title={isCounting ? 'Cancel countdown' : recording ? 'Stop recording' : 'Start recording'}
          aria-label={isCounting ? 'Cancel countdown' : recording ? 'Stop recording' : 'Start recording'}
        >
          <span className="hud-record-orb" aria-hidden>
            <span className="hud-record-halo" />
            <span className="hud-record-dot" />
          </span>
          {isLive && (
            <span className="hud-record-timer">
              {isCounting ? String(countdown) : formatTime(elapsed)}
            </span>
          )}
        </button>
      </div>
    </div>
  );
}

interface SourceSelectorProps {
  source: ScreenSource | null;
  parts: NameParts | null;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  sources: ScreenSource[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onRefresh: () => void;
  disabled?: boolean;
}

function SourceSelector({
  source, parts, open, onToggle, onClose, sources, selectedId, onSelect, onRefresh, disabled,
}: SourceSelectorProps): JSX.Element {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (open) onRefresh();
  }, [open, onRefresh]);

  const displayApp = parts?.app || source?.name || 'Select source';
  const resText = source && source.width > 0 && source.height > 0
    ? `${source.width} × ${source.height}`
    : (source?.kind === 'window' ? 'Window' : '');

  return (
    <>
      <button
        ref={triggerRef}
        className={`hud-source-trigger ${open ? 'is-open' : ''}`}
        onClick={onToggle}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={source?.name || 'Choose source'}
      >
        <span className="hud-source-trigger-icon">
          <DisplayIcon />
        </span>
        <span className="hud-source-trigger-text">
          <span className="hud-source-trigger-app">{displayApp}</span>
          <span className="hud-source-trigger-meta">{resText}</span>
        </span>
        <span className="hud-source-trigger-caret">
          <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </span>
      </button>
      {open && (
        <SourcePicker
          anchor={triggerRef}
          sources={sources}
          selectedId={selectedId}
          onSelect={onSelect}
          onClose={onClose}
        />
      )}
    </>
  );
}

interface SourcePickerProps {
  anchor: RefObject<HTMLElement | null>;
  sources: ScreenSource[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onClose: () => void;
}

interface PopoverPos {
  top: number;
  left: number;
  ready: boolean;
  placeAbove: boolean;
}

/** Decide whether a popover should open above or below its trigger,
 * based on actual screen-space room (not just the Electron window's
 * inner viewport — which is a moving target as the window resizes). */
function computePlacement(
  triggerRect: DOMRect,
  popoverHeight: number,
  gap: number,
  edge: number,
): { placeAbove: boolean; top: number } {
  const triggerScreenBottom = window.screenY + triggerRect.bottom;
  const triggerScreenTop = window.screenY + triggerRect.top;
  // `availTop` exists in Chromium but isn't in the DOM lib types.
  const screenAvailTop = (window.screen as { availTop?: number }).availTop ?? 0;
  const screenAvailBottom = screenAvailTop + window.screen.availHeight;
  const fitsBelow = triggerScreenBottom + gap + popoverHeight + edge <= screenAvailBottom;
  const fitsAbove = triggerScreenTop - gap - popoverHeight - edge >= screenAvailTop;
  const placeAbove = !fitsBelow && fitsAbove;
  const top = placeAbove
    ? Math.round(triggerRect.top - gap - popoverHeight)
    : Math.round(triggerRect.bottom + gap);
  return { placeAbove, top };
}

function SourcePicker({ anchor, sources, selectedId, onSelect, onClose }: SourcePickerProps): React.ReactPortal {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<PopoverPos>({ top: -9999, left: -9999, ready: false, placeAbove: false });

  useLayoutEffect(() => {
    const place = (settled: boolean): void => {
      const m = ref.current?.getBoundingClientRect();
      const t = anchor.current?.getBoundingClientRect();
      if (!m || !t) return;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const gap = 8;
      const edge = 12;
      const { placeAbove, top: rawTop } = computePlacement(t, m.height, gap, edge);
      let left = Math.round(t.left);
      left = Math.max(8, Math.min(left, vw - m.width - 8));
      let top = rawTop;
      // In-window fit check — used to decide whether to fade the popover in
      // immediately. The parent layout effect grows the window upward when
      // `placeAbove` is true, so the popover may render off-screen for a
      // single frame until that resize lands.
      const fitsInWindow = placeAbove ? top >= 8 : top + m.height + 8 <= vh;
      if (settled || fitsInWindow) {
        top = placeAbove
          ? Math.max(8, top)
          : Math.min(top, vh - m.height - 8);
      }
      setPos({ top, left, ready: settled || fitsInWindow, placeAbove });
    };
    place(false);
    let raf = 0;
    const onResize = (): void => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => place(true));
    };
    window.addEventListener('resize', onResize);
    const fallback = window.setTimeout(() => place(true), 220);
    return () => {
      window.removeEventListener('resize', onResize);
      window.clearTimeout(fallback);
      cancelAnimationFrame(raf);
    };
  }, [anchor, sources.length]);

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      const target = e.target as Node | null;
      if (target && anchor.current?.contains(target)) return;
      if (target && (target as HTMLElement).closest?.('.hud-popover')) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [anchor, onClose]);

  const screenSources = sources.filter((s) => s.kind === 'screen');
  const windowSources = sources.filter((s) => s.kind === 'window');

  const renderItem = (s: ScreenSource): JSX.Element => {
    const cat = categorize(s);
    const parts = splitName(s.name);
    const selected = s.id === selectedId;
    const meta = s.width > 0 && s.height > 0
      ? `${s.width} × ${s.height} · ${cat.label}`
      : cat.label;
    const iconStyle: CSSProperties = { background: cat.bg, color: cat.fg };
    return (
      <button
        key={s.id}
        className={`hud-source-item ${selected ? 'is-selected' : ''}`}
        onClick={() => onSelect(s.id)}
        role="option"
        aria-selected={selected}
      >
        <span className="hud-source-icon" style={iconStyle}>
          {s.kind === 'screen' ? <DisplayIcon /> : <WindowFrameIcon />}
        </span>
        <span className="hud-source-info">
          <span className="hud-source-title">
            <span className="hud-source-app">{parts.app}</span>
            {parts.title && (
              <>
                <span className="hud-source-sep"> — </span>
                <span className="hud-source-sub">{parts.title}</span>
              </>
            )}
          </span>
          <span className="hud-source-meta">{meta}</span>
        </span>
        {selected && (
          <span className="hud-source-check" aria-hidden>
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 12.5l4.5 4.5L19 7.5" />
            </svg>
          </span>
        )}
      </button>
    );
  };

  return createPortal(
    <div
      ref={ref}
      className={`hud-popover hud-source-picker ${pos.ready ? 'is-ready' : ''} ${pos.placeAbove ? 'is-above' : ''}`}
      data-placement={pos.placeAbove ? 'above' : 'below'}
      style={{ top: pos.top, left: pos.left }}
      role="listbox"
    >
      {sources.length === 0 && (
        <div className="hud-popover-empty">No sources available</div>
      )}

      {screenSources.length > 0 && (
        <>
          <div className="hud-source-section-label">
            {screenSources.length > 1 ? 'Displays' : 'Display'}
          </div>
          <div className="hud-source-screens">
            {screenSources.map((s) => {
              const selected = s.id === selectedId;
              return (
                <button
                  key={s.id}
                  className={`hud-source-screen-tile ${selected ? 'is-selected' : ''}`}
                  onClick={() => onSelect(s.id)}
                  role="option"
                  aria-selected={selected}
                  title={s.name}
                >
                  <span className="hud-source-screen-thumb">
                    {s.thumbnail
                      ? <img src={s.thumbnail} alt="" draggable={false} />
                      : <DisplayIcon />}
                    {s.primary && (
                      <span className="hud-source-screen-badge">Primary</span>
                    )}
                    {selected && (
                      <span className="hud-source-screen-check" aria-hidden>
                        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M5 12.5l4.5 4.5L19 7.5" />
                        </svg>
                      </span>
                    )}
                  </span>
                  <span className="hud-source-screen-info">
                    <span className="hud-source-screen-name">{s.name}</span>
                    <span className="hud-source-screen-meta">
                      {s.width > 0 && s.height > 0 ? `${s.width} × ${s.height}` : 'Screen'}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </>
      )}

      {windowSources.length > 0 && (
        <>
          {screenSources.length > 0 && <div className="hud-source-divider" />}
          <div className="hud-source-section-label">Windows</div>
          {windowSources.map(renderItem)}
        </>
      )}
    </div>,
    document.body,
  );
}

interface StackedToggleProps {
  icon: ReactNode;
  label: string;
  active: boolean;
  recording?: boolean;
  onClick: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  onCaretClick?: () => void;
  variant?: 'default' | 'purple';
}

const StackedToggle = forwardRef<HTMLButtonElement, StackedToggleProps>(
  function StackedToggle(
    { icon, label, active, recording = false, onClick, onContextMenu, onCaretClick, variant = 'default' },
    ref,
  ) {
    const wrapClass = [
      'hud-stacked-wrap',
      active ? 'is-on' : '',
      recording ? 'is-recording' : '',
      variant === 'purple' ? 'is-purple' : '',
    ].filter(Boolean).join(' ');
    return (
      <div className={wrapClass}>
        <button
          ref={ref}
          className="hud-stacked"
          onClick={onClick}
          onContextMenu={onContextMenu}
          aria-pressed={active}
          aria-label={label}
          title={label}
          type="button"
        >
          <span className="hud-stacked-icon">{icon}</span>
          <span className="hud-stacked-label">{label}</span>
          {active && (
            <span
              className={`hud-stacked-indicator ${recording ? 'is-recording' : ''}`}
              aria-hidden
            />
          )}
        </button>
        {onCaretClick && (
          <button
            className="hud-stacked-caret"
            type="button"
            onClick={(e) => { e.stopPropagation(); onCaretClick(); }}
            tabIndex={-1}
            aria-label={`${label} options`}
          >
            <svg viewBox="0 0 24 24" width="8" height="8" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>
        )}
      </div>
    );
  },
);

interface DeviceMenuProps {
  anchor: RefObject<HTMLElement | null>;
  items: MicMenuItem[];
  onSelect: (id: string) => void;
  onClose: () => void;
}

function DeviceMenu({ anchor, items, onSelect, onClose }: DeviceMenuProps): React.ReactPortal {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<PopoverPos>({ top: -9999, left: -9999, ready: false, placeAbove: false });

  useLayoutEffect(() => {
    const place = (settled: boolean): void => {
      const m = ref.current?.getBoundingClientRect();
      const t = anchor.current?.getBoundingClientRect();
      if (!m || !t) return;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const gap = 6;
      const edge = 12;
      const { placeAbove, top: rawTop } = computePlacement(t, m.height, gap, edge);
      let left = Math.round(t.left + t.width / 2 - m.width / 2);
      left = Math.max(8, Math.min(left, vw - m.width - 8));
      let top = rawTop;
      const fitsInWindow = placeAbove ? top >= 8 : top + m.height + 8 <= vh;
      if (settled || fitsInWindow) {
        top = placeAbove
          ? Math.max(8, top)
          : Math.min(top, vh - m.height - 8);
      }
      setPos({ top, left, ready: settled || fitsInWindow, placeAbove });
    };
    place(false);
    let raf = 0;
    const onResize = (): void => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => place(true));
    };
    window.addEventListener('resize', onResize);
    const fallback = window.setTimeout(() => place(true), 220);
    return () => {
      window.removeEventListener('resize', onResize);
      window.clearTimeout(fallback);
      cancelAnimationFrame(raf);
    };
  }, [anchor, items.length]);

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      const target = e.target as Node | null;
      if (target && anchor.current?.contains(target)) return;
      if (target && (target as HTMLElement).closest?.('.hud-popover')) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [anchor, onClose]);

  return createPortal(
    <div
      ref={ref}
      className={`hud-popover hud-device-menu ${pos.ready ? 'is-ready' : ''} ${pos.placeAbove ? 'is-above' : ''}`}
      data-placement={pos.placeAbove ? 'above' : 'below'}
      style={{ top: pos.top, left: pos.left }}
      role="menu"
    >
      {items.map((it, idx) => (
        <button
          key={`${it.id}-${idx}`}
          className={`hud-device-item ${it.selected ? 'is-selected' : ''}`}
          onClick={() => onSelect(it.id)}
          role="menuitemradio"
          aria-checked={!!it.selected}
        >
          <span className="hud-device-check" aria-hidden>
            {it.selected ? (
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 12.5l4.5 4.5L19 7.5" />
              </svg>
            ) : null}
          </span>
          <span className="hud-device-label">{it.label}</span>
          {it.defaultMark && <span className="hud-device-tag">default</span>}
        </button>
      ))}
    </div>,
    document.body,
  );
}

function formatTime(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = String(Math.floor(total / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return `${m}:${s}`;
}

function DisplayIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="13" rx="2" />
      <path d="M9 20h6M12 17v3" />
    </svg>
  );
}
function WindowFrameIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 9h18" />
    </svg>
  );
}
function MicIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </svg>
  );
}
function CamIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="6" width="14" height="12" rx="2.5" />
      <circle cx="10" cy="12" r="3" />
    </svg>
  );
}
function SparkleIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6L12 3z" />
      <path d="M19 14l.7 1.9L21.6 17l-1.9.7L19 19.6l-.7-1.9L16.4 17l1.9-.7L19 14z" />
    </svg>
  );
}
