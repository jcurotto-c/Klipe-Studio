import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import logo from '../assets/branding/klipe-icon.svg';
import './AboutModal.css';

// ── Your signature — edit to taste ───────────────────────────────────
// Use your real name (best for a portfolio) or a handle.
const AUTHOR_NAME = 'Jean Curotto';
const REPO_URL = 'https://github.com/jcurotto-c/Klipe-Studio';
const KOFI_URL = 'https://ko-fi.com/mrrobot01';
const LINKEDIN_URL = 'https://www.linkedin.com/in/jean-phier-curotto-cucho-571b441a0/';
// ─────────────────────────────────────────────────────────────────────

interface AboutModalProps {
  onClose: () => void;
}

function openExternal(url: string): void {
  void window.klipe?.openExternal?.(url);
}

export default function AboutModal({ onClose }: AboutModalProps): JSX.Element {
  const [version, setVersion] = useState<string>('');

  useEffect(() => {
    let alive = true;
    const p = window.klipe?.getVersion?.();
    if (p) void p.then((v) => { if (alive) setVersion(v); });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-card about-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="About Klipe Studio"
      >
        <button className="about-close" onClick={onClose} aria-label="Close" title="Close">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>

        <div className="about-head">
          <img className="about-logo" src={logo} alt="" aria-hidden />
          <div className="about-title-row">
            <h2 className="about-title">Klipe Studio</h2>
            {version && <span className="about-version">v{version}</span>}
          </div>
          <p className="about-tagline">
            Screen recorder &amp; cinematic editor for Windows. Fully open source, 100% local.
          </p>
        </div>

        <p className="about-author">
          Built by <span className="about-author-name">{AUTHOR_NAME}</span>
        </p>

        <div className="about-links">
          <button className="about-link" onClick={() => openExternal(REPO_URL)}>
            <GitHubIcon />
            <span>GitHub repository</span>
            <ArrowIcon />
          </button>
          <button className="about-link" onClick={() => openExternal(LINKEDIN_URL)}>
            <LinkedInIcon />
            <span>LinkedIn</span>
            <ArrowIcon />
          </button>
          <button className="about-link" onClick={() => openExternal(KOFI_URL)}>
            <KofiIcon />
            <span>Support on Ko-fi</span>
            <ArrowIcon />
          </button>
        </div>

        <div className="about-foot">
          <span>GPL-3.0-or-later</span>
          <span className="about-foot-dot" aria-hidden />
          <span>No telemetry · No uploads</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function GitHubIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor" aria-hidden>
      <path d="M12 .5A11.5 11.5 0 0 0 .5 12a11.5 11.5 0 0 0 7.86 10.92c.57.1.78-.25.78-.55v-1.94c-3.2.7-3.88-1.38-3.88-1.38-.52-1.33-1.28-1.68-1.28-1.68-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.56-.29-5.25-1.28-5.25-5.7 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.79 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.18 1.84 1.18 3.1 0 4.43-2.69 5.41-5.26 5.69.41.36.78 1.05.78 2.13v3.16c0 .31.21.66.79.55A11.5 11.5 0 0 0 23.5 12 11.5 11.5 0 0 0 12 .5Z" />
    </svg>
  );
}

function KofiIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 8h12v4.5A4.5 4.5 0 0 1 11.5 17h-3A4.5 4.5 0 0 1 4 12.5V8Z" />
      <path d="M16 9h2.2a2.4 2.4 0 0 1 0 4.8H16" />
      <path d="M7.5 3.2v1.6M11 3.2v1.6" />
    </svg>
  );
}

function LinkedInIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden>
      <path d="M20.45 20.45h-3.56v-5.57c0-1.33-.03-3.04-1.85-3.04-1.86 0-2.14 1.45-2.14 2.94v5.67H9.35V9h3.41v1.56h.05c.48-.9 1.63-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.45v6.29zM5.34 7.43a2.07 2.07 0 1 1 0-4.13 2.07 2.07 0 0 1 0 4.13zm1.78 13.02H3.55V9h3.57v11.45zM22.22 0H1.77C.8 0 0 .78 0 1.73v20.54C0 23.22.8 24 1.77 24h20.45c.98 0 1.78-.78 1.78-1.73V1.73C24 .78 23.2 0 22.22 0z" />
    </svg>
  );
}

function ArrowIcon(): JSX.Element {
  return (
    <svg className="about-link-arrow" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M7 17 17 7M9 7h8v8" />
    </svg>
  );
}
