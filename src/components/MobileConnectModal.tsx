import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import {
  listMobileBackends,
  type MobileDevice,
  type MobileSessionBackend,
} from '../lib/mobile-session';
import './MobileConnectModal.css';

interface MobileConnectPopoverProps {
  /** Trigger element the popover anchors to. */
  anchor: RefObject<HTMLElement | null>;
  open: boolean;
  /** Called with the deviceId once the user picks one and the stream opens. */
  onConnect: (deviceId: string) => void;
  /** Called for Escape / outside click / Cancel. */
  onClose: () => void;
  /** Highlights the previously-paired device, if it's still in the list. */
  initialDeviceId?: string | null;
}

interface PopoverPos {
  top: number;
  left: number;
  ready: boolean;
  placeAbove: boolean;
}

/**
 * Decide whether the popover should open above or below the trigger based
 * on actual screen-space room — not just the Electron window's inner
 * viewport, which grows/shrinks with the HUD. Same algorithm as the
 * SourcePicker so the placement behavior feels identical across popovers.
 */
function computePlacement(
  triggerRect: DOMRect,
  popoverHeight: number,
  gap: number,
  edge: number,
): { placeAbove: boolean; top: number } {
  const triggerScreenBottom = window.screenY + triggerRect.bottom;
  const triggerScreenTop = window.screenY + triggerRect.top;
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

export default function MobileConnectModal({
  anchor,
  open,
  onConnect,
  onClose,
  initialDeviceId = null,
}: MobileConnectPopoverProps): React.ReactPortal | null {
  const backendsRef = useRef<MobileSessionBackend[]>(listMobileBackends());
  const [activeBackendId, setActiveBackendId] = useState<string>(
    backendsRef.current[0]?.id ?? '',
  );
  const activeBackend = backendsRef.current.find((b) => b.id === activeBackendId)
    ?? backendsRef.current[0]!;

  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<PopoverPos>({ top: -9999, left: -9999, ready: false, placeAbove: false });
  const [busy, setBusy] = useState(false);

  useLayoutEffect(() => {
    if (!open) return undefined;
    const place = (settled: boolean): void => {
      const m = ref.current?.getBoundingClientRect();
      const t = anchor.current?.getBoundingClientRect();
      if (!m || !t) return;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const gap = 8;
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
    const ro = ref.current ? new ResizeObserver(onResize) : null;
    if (ro && ref.current) ro.observe(ref.current);
    return () => {
      window.removeEventListener('resize', onResize);
      window.clearTimeout(fallback);
      cancelAnimationFrame(raf);
      ro?.disconnect();
    };
  }, [anchor, open, activeBackendId]);

  // Outside click + Escape, gated on `busy` so dismissing doesn't yank
  // the user out of an in-flight connection.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: MouseEvent): void => {
      const target = e.target as Node | null;
      if (target && anchor.current?.contains(target)) return;
      if (target && (target as HTMLElement).closest?.('.hud-popover')) return;
      if (busy) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onClose, anchor, busy]);

  if (!open) return null;

  const showTabs = backendsRef.current.length > 1;

  return createPortal(
    <div
      ref={ref}
      className={`hud-popover hud-mobile-popover ${pos.ready ? 'is-ready' : ''} ${pos.placeAbove ? 'is-above' : ''}`}
      data-placement={pos.placeAbove ? 'above' : 'below'}
      style={{ top: pos.top, left: pos.left }}
      role="dialog"
      aria-label="Connect a phone"
    >
      <div className="hud-mobile-pop-head">
        <div className="hud-mobile-pop-eyebrow">
          <span className="hud-mobile-pop-eyebrow-dot" />
          MOBILE
        </div>
        <div className="hud-mobile-pop-title">Connect a phone</div>
        <div className="hud-mobile-pop-sub">
          {activeBackend.id === 'scrcpy-android'
            ? 'Plug in an Android phone via USB with Developer Options → USB debugging enabled.'
            : "Your phone shows up as a camera input. We'll mirror it into an iPhone frame in the editor."}
        </div>
      </div>

      {showTabs && (
        <div className="hud-mobile-tabs" role="tablist">
          {backendsRef.current.map((b) => (
            <button
              key={b.id}
              type="button"
              role="tab"
              aria-selected={b.id === activeBackend.id}
              className={`hud-mobile-tab ${b.id === activeBackend.id ? 'is-active' : ''}`}
              onClick={() => {
                if (busy) return;
                setActiveBackendId(b.id);
              }}
              disabled={busy && b.id !== activeBackend.id}
            >
              {b.label}
            </button>
          ))}
        </div>
      )}

      <DeviceListView
        backend={activeBackend}
        initialDeviceId={initialDeviceId}
        onConnect={onConnect}
        onBusyChange={setBusy}
      />
    </div>,
    document.body,
  );
}

// ─── Device-list view (shared by LocalDevice + Scrcpy backends) ─────────

interface DeviceListViewProps {
  backend: MobileSessionBackend;
  initialDeviceId: string | null;
  onConnect: (deviceId: string) => void;
  onBusyChange: (busy: boolean) => void;
}

function DeviceListView({
  backend, initialDeviceId, onConnect, onBusyChange,
}: DeviceListViewProps): JSX.Element {
  const [devices, setDevices] = useState<MobileDevice[]>([]);
  const [listing, setListing] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [successId, setSuccessId] = useState<string | null>(null);
  const [errorId, setErrorId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string>('');

  useEffect(() => { onBusyChange(busyId !== null); }, [busyId, onBusyChange]);

  const refresh = useCallback(async () => {
    setListing(true);
    setErrorId(null);
    setErrorMsg('');
    try {
      const list = await backend.listDevices();
      setDevices(list);
    } catch (err) {
      console.warn('[mobile-popover] listDevices failed:', err);
      setDevices([]);
    } finally {
      setListing(false);
    }
  }, [backend]);

  useEffect(() => {
    setBusyId(null);
    setSuccessId(null);
    refresh();
  }, [refresh]);

  const handleSelect = useCallback(async (d: MobileDevice) => {
    if (d.selectable === false) return;
    setBusyId(d.id);
    setErrorId(null);
    setErrorMsg('');
    try {
      const stream = await backend.start(d.id);
      stream.getTracks().forEach((t) => t.stop());
      setBusyId(null);
      setSuccessId(d.id);
      window.setTimeout(() => onConnect(d.id), 320);
    } catch (err) {
      console.warn('[mobile-popover] start failed:', err);
      setBusyId(null);
      setErrorId(d.id);
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  }, [backend, onConnect]);

  const isScrcpy = backend.id === 'scrcpy-android';

  return (
    <>
      <div className="hud-mobile-pop-list" role="listbox" aria-label="Available devices">
        {listing && (
          <div className="hud-mobile-pop-loading">
            <SpinnerIcon /> {isScrcpy ? 'Looking for phones…' : 'Looking for devices…'}
          </div>
        )}

        {!listing && devices.length === 0 && (
          <div className="hud-mobile-pop-empty">
            <div className="hud-mobile-pop-empty-title">
              {isScrcpy ? 'No phones detected' : 'No video devices found'}
            </div>
            <div className="hud-mobile-pop-empty-sub">
              {isScrcpy
                ? 'Plug an Android phone in via USB, enable Developer Options → USB debugging, and tap Allow on the first prompt.'
                : 'Connect your phone and grant camera access, then refresh.'}
            </div>
            <button
              type="button"
              className="hud-mobile-pop-link"
              onClick={refresh}
            >
              Refresh
            </button>
          </div>
        )}

        {!listing && devices.map((d) => {
          const isBusy = busyId === d.id;
          const isSuccess = successId === d.id;
          const isError = errorId === d.id;
          const isInitial = initialDeviceId === d.id;
          const isUnselectable = d.selectable === false;
          const label = d.label || (isScrcpy ? 'Phone' : 'Camera');
          // Prefer the backend-supplied sub when present (scrcpy uses it
          // for state-specific copy). Otherwise compose from booleans.
          let sub: string;
          if (isError) sub = errorMsg || 'Connection failed';
          else if (isBusy) sub = 'Opening…';
          else if (isSuccess) sub = 'Connected';
          else if (isInitial) sub = d.sub ?? 'Currently connected';
          else if (d.sub) sub = d.sub;
          else if (d.likelyPhone) sub = 'Phone-like input';
          else sub = 'Camera input';

          const classes = [
            'hud-mobile-row',
            d.likelyPhone ? 'phone-like' : '',
            isSuccess ? 'is-success' : '',
            isError ? 'is-error' : '',
            isUnselectable && !isError ? 'is-warning' : '',
            isInitial && !isBusy && !isSuccess && !isError ? 'is-current' : '',
          ].filter(Boolean).join(' ');

          return (
            <button
              key={d.id}
              type="button"
              role="option"
              aria-selected={isInitial}
              className={classes}
              onClick={() => handleSelect(d)}
              disabled={(busyId != null && busyId !== d.id) || isUnselectable}
              title={label}
            >
              <span className="hud-mobile-row-icon">
                {d.likelyPhone ? <SmallPhoneIcon /> : <SmallCameraIcon />}
              </span>
              <span className="hud-mobile-row-info">
                <span className="hud-mobile-row-name">{label}</span>
                <span className="hud-mobile-row-sub">{sub}</span>
              </span>
              <span className="hud-mobile-row-state" aria-hidden>
                {isBusy && <SpinnerIcon />}
                {isSuccess && <CheckIcon />}
                {isError && <RetryIcon />}
                {!isBusy && !isSuccess && !isError && isInitial && <DotIcon />}
                {!isBusy && !isSuccess && !isError && !isInitial && isUnselectable && <WarnIcon />}
              </span>
            </button>
          );
        })}
      </div>

      <div className="hud-mobile-pop-footer">
        {isScrcpy ? (
          <span className="hud-mobile-pop-hint">
            iPhone screen recording isn't supported on Windows.
          </span>
        ) : <span />}
        <button type="button" className="hud-mobile-pop-link" onClick={refresh}>
          Refresh
        </button>
      </div>
    </>
  );
}

// ─── Icons ──────────────────────────────────────────────────────────────

function SpinnerIcon(): JSX.Element {
  return (
    <svg className="hud-mobile-spin" width="14" height="14" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="9" stroke="rgba(255,255,255,0.15)" strokeWidth="2.4" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
}

function CheckIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

function DotIcon(): JSX.Element {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="5" fill="currentColor" />
    </svg>
  );
}

function RetryIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12a9 9 0 1 0 3-6.7" />
      <path d="M3 4v5h5" />
    </svg>
  );
}

function WarnIcon(): JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 9v4M12 17h.01" />
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
    </svg>
  );
}

function SmallPhoneIcon(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <rect x="7" y="2.5" width="10" height="19" rx="2.5" />
      <path d="M11 18.5h2" />
    </svg>
  );
}

function SmallCameraIcon(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="6" width="14" height="12" rx="2.5" />
      <circle cx="10" cy="12" r="3" />
    </svg>
  );
}
