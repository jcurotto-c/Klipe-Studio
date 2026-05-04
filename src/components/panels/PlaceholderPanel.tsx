interface PlaceholderPanelProps {
  title: string;
  description?: string;
}

export default function PlaceholderPanel({ title, description }: PlaceholderPanelProps): JSX.Element {
  return (
    <div className="panel">
      <div className="panel-section">
        <div className="panel-label">{title}</div>
        <div className="panel-empty">
          {description || 'Settings for this category are coming soon.'}
        </div>
      </div>
    </div>
  );
}
