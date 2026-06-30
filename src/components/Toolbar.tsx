// Toolbar.tsx
type Props = {
  query: string;
  onQuery: (q: string) => void;
  onExport: () => void;
  onBackup: () => void;
};

export function Toolbar({ query, onQuery, onExport, onBackup }: Props) {
  return (
    <div className="toolbar">
      <label className="search">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="11" cy="11" r="7" />
          <path d="M21 21l-4.3-4.3" />
        </svg>
        <input
          type="text"
          placeholder="Search your thoughts"
          aria-label="Search thoughts"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
        />
      </label>
      <button className="ghost-btn" onClick={onBackup} title="Save a restorable, encrypted backup file">
        Back up
      </button>
      <button className="ghost-btn" onClick={onExport} title="Download a readable Markdown copy">
        Export
      </button>
    </div>
  );
}
