import { useEffect, useRef, useState } from 'react';
import BackgroundPanel from './panels/BackgroundPanel';
import CameraPanel from './panels/CameraPanel';
import MobilePanel from './panels/MobilePanel';
import CursorPanel from './panels/CursorPanel';
import AudioPanel from './panels/AudioPanel';
import ShortcutsPanel from './panels/ShortcutsPanel';
import PlaceholderPanel from './panels/PlaceholderPanel';
import IntroOutroPanel from './panels/IntroOutroPanel';
import type {
  AudioFxOptions,
  Background,
  BackgroundMusic,
  BlurRegion,
  CameraOptions,
  Crop,
  CursorOptions,
  FrameOptions,
  KlipeMouseEvent,
  MobileOptions,
} from '../types';
import type { CardSet } from '../cards/types';

type CategoryId =
  | 'scene'
  | 'cursor'
  | 'camera'
  | 'mobile'
  | 'introOutro'
  | 'captions'
  | 'audio'
  | 'shortcuts'
  | 'connections';

interface Category {
  id: CategoryId;
  label: string;
}

const CATEGORIES: Category[] = [
  { id: 'scene',       label: 'Scene' },
  { id: 'cursor',      label: 'Cursor' },
  { id: 'camera',      label: 'Camera' },
  { id: 'mobile',      label: 'Phone' },
  { id: 'introOutro',  label: 'Intro / Outro' },
  { id: 'captions',    label: 'Captions' },
  { id: 'audio',       label: 'Audio' },
  { id: 'shortcuts',   label: 'Shortcuts' },
  { id: 'connections', label: 'Connections' },
];

const SCROLL_STEP_PX = 140;

interface SidebarPanelProps {
  background: Background;
  onBackgroundChange: (next: Background) => void;
  frame: FrameOptions;
  onFrameChange: (next: FrameOptions) => void;
  crop: Crop | null;
  onCropChange: (next: Crop | null) => void;
  cameraOptions: CameraOptions;
  onCameraOptionsChange: (next: CameraOptions) => void;
  cameraAvailable: boolean;
  mobileOptions: MobileOptions;
  onMobileOptionsChange: (next: MobileOptions) => void;
  mobileAvailable: boolean;
  /** Output aspect (width/height) so the phone position preview is WYSIWYG. Null = auto. */
  mobileStageAspect?: number | null;
  cursorOptions: CursorOptions;
  onCursorOptionsChange: (next: CursorOptions) => void;
  audioFxOptions: AudioFxOptions;
  onAudioFxOptionsChange: (next: AudioFxOptions) => void;
  backgroundMusic: BackgroundMusic | null;
  onBackgroundMusicChange: (next: BackgroundMusic | null) => void;
  micVolume: number;
  systemVolume: number;
  onMicVolumeChange: (v: number) => void;
  onSystemVolumeChange: (v: number) => void;
  hasMicAudio: boolean;
  hasSystemAudio: boolean;
  inputEvents: ReadonlyArray<KlipeMouseEvent>;
  blurRegions: BlurRegion[];
  blurMode: boolean;
  onBlurModeChange: (next: boolean) => void;
  selectedBlurId: string | null;
  onSelectBlur: (id: string | null) => void;
  onAddBlurAtPlayhead: () => void;
  onRemoveBlur: (id: string) => void;
  cards: CardSet;
  onCardsChange: (next: CardSet) => void;
  onAddMidCardAtPlayhead: () => void;
  onCaptureRecordingFrame: (position: 'start' | 'end' | number) => Promise<string | null>;
}

export default function SidebarPanel({
  background,
  onBackgroundChange,
  frame,
  onFrameChange,
  crop,
  onCropChange,
  cameraOptions,
  onCameraOptionsChange,
  cameraAvailable,
  mobileOptions,
  onMobileOptionsChange,
  mobileAvailable,
  mobileStageAspect,
  cursorOptions,
  onCursorOptionsChange,
  audioFxOptions,
  onAudioFxOptionsChange,
  backgroundMusic,
  onBackgroundMusicChange,
  micVolume,
  systemVolume,
  onMicVolumeChange,
  onSystemVolumeChange,
  hasMicAudio,
  hasSystemAudio,
  inputEvents,
  blurRegions,
  blurMode,
  onBlurModeChange,
  selectedBlurId,
  onSelectBlur,
  onAddBlurAtPlayhead,
  onRemoveBlur,
  cards,
  onCardsChange,
  onAddMidCardAtPlayhead,
  onCaptureRecordingFrame,
}: SidebarPanelProps): JSX.Element {
  const [activeId, setActiveId] = useState<CategoryId>('scene');
  const tabsRef = useRef<HTMLDivElement | null>(null);
  const tabRefs = useRef<Partial<Record<CategoryId, HTMLButtonElement | null>>>({});
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const updateScrollState = (): void => {
    const el = tabsRef.current;
    if (!el) return;
    const maxScroll = el.scrollWidth - el.clientWidth;
    setCanScrollLeft(el.scrollLeft > 1);
    setCanScrollRight(el.scrollLeft < maxScroll - 1);
  };

  useEffect(() => {
    const el = tabsRef.current;
    if (!el) return;
    updateScrollState();
    const onScroll = (): void => updateScrollState();
    el.addEventListener('scroll', onScroll, { passive: true });
    const ro = new ResizeObserver(() => updateScrollState());
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', onScroll);
      ro.disconnect();
    };
  }, []);

  useEffect(() => {
    const btn = tabRefs.current[activeId];
    if (btn && typeof btn.scrollIntoView === 'function') {
      btn.scrollIntoView({ behavior: 'smooth', inline: 'nearest', block: 'nearest' });
    }
  }, [activeId]);

  const scrollBy = (delta: number): void => {
    const el = tabsRef.current;
    if (!el) return;
    el.scrollBy({ left: delta, behavior: 'smooth' });
  };

  const renderPanel = (): JSX.Element | null => {
    switch (activeId) {
      case 'scene':
        return (
          <BackgroundPanel
            value={background}
            onChange={onBackgroundChange}
            frame={frame}
            onFrameChange={onFrameChange}
            crop={crop}
            onCropChange={onCropChange}
            blurRegions={blurRegions}
            blurMode={blurMode}
            onBlurModeChange={onBlurModeChange}
            selectedBlurId={selectedBlurId}
            onSelectBlur={onSelectBlur}
            onAddBlurAtPlayhead={onAddBlurAtPlayhead}
            onRemoveBlur={onRemoveBlur}
          />
        );
      case 'cursor':
        return <CursorPanel value={cursorOptions} onChange={onCursorOptionsChange} />;
      case 'camera':
        return (
          <CameraPanel
            value={cameraOptions}
            onChange={onCameraOptionsChange}
            available={cameraAvailable}
          />
        );
      case 'mobile':
        return (
          <MobilePanel
            value={mobileOptions}
            onChange={onMobileOptionsChange}
            available={mobileAvailable}
            stageAspect={mobileStageAspect}
          />
        );
      case 'introOutro':
        return (
          <IntroOutroPanel
            cards={cards}
            onChange={onCardsChange}
            onAddMidCardAtPlayhead={onAddMidCardAtPlayhead}
            onCaptureRecordingFrame={onCaptureRecordingFrame}
          />
        );
      case 'captions':
        return <PlaceholderPanel title="Captions" description="Auto-generated subtitles and styling." />;
      case 'audio':
        return (
          <AudioPanel
            value={audioFxOptions}
            onChange={onAudioFxOptionsChange}
            backgroundMusic={backgroundMusic}
            onBackgroundMusicChange={onBackgroundMusicChange}
            events={inputEvents}
            micVolume={micVolume}
            systemVolume={systemVolume}
            onMicVolumeChange={onMicVolumeChange}
            onSystemVolumeChange={onSystemVolumeChange}
            hasMicAudio={hasMicAudio}
            hasSystemAudio={hasSystemAudio}
          />
        );
      case 'shortcuts':
        return <ShortcutsPanel />;
      case 'connections':
        return <PlaceholderPanel title="Connections" description="External integrations and webhooks." />;
      default:
        return null;
    }
  };

  return (
    <div className="sidebar open">
      <div className="sidebar-tabs-bar">
        <button
          type="button"
          className="sidebar-tabs-arrow left"
          onClick={() => scrollBy(-SCROLL_STEP_PX)}
          disabled={!canScrollLeft}
          aria-label="Scroll tabs left"
          tabIndex={-1}
        >
          <ChevronLeft />
        </button>
        <div
          className={`sidebar-tabs ${canScrollLeft ? 'fade-left' : ''} ${canScrollRight ? 'fade-right' : ''}`}
          ref={tabsRef}
          role="tablist"
        >
          {CATEGORIES.map((c) => (
            <button
              key={c.id}
              type="button"
              role="tab"
              ref={(el) => { tabRefs.current[c.id] = el; }}
              className={`sidebar-tab ${activeId === c.id ? 'active' : ''}`}
              onClick={() => setActiveId(c.id)}
              aria-selected={activeId === c.id}
            >
              {c.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="sidebar-tabs-arrow right"
          onClick={() => scrollBy(SCROLL_STEP_PX)}
          disabled={!canScrollRight}
          aria-label="Scroll tabs right"
          tabIndex={-1}
        >
          <ChevronRight />
        </button>
      </div>
      <div className="sidebar-content">{renderPanel()}</div>
    </div>
  );
}

function ChevronLeft(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="15 18 9 12 15 6" />
    </svg>
  );
}

function ChevronRight(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}
