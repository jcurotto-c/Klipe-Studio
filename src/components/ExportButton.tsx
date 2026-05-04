interface ExportButtonProps {
  onClick: () => void;
  disabled?: boolean;
}

export default function ExportButton({ onClick, disabled }: ExportButtonProps): JSX.Element {
  return (
    <button
      type="button"
      className="primary export-btn"
      onClick={onClick}
      disabled={disabled}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <polyline points="7 10 12 15 17 10" />
        <line x1="12" y1="15" x2="12" y2="3" />
      </svg>
      <span>Export</span>
    </button>
  );
}
