import React from 'react';

export default function PlaceholderPanel({ title, description }) {
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
