import type { AttachmentRef } from '@relay/contracts';
import { api } from '../lib/api';
import './attachment-history.css';

const sizeLabel = (bytes: number): string => bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/** Read-only links to attachments already owned by this message. */
export function AttachmentHistory({ attachments }: { attachments?: AttachmentRef[] }) {
  if (!attachments?.length) return null;
  return <div className="attachment-history" aria-label="Message attachments">
    {attachments.map((item) => <a key={item.id} className="attachment-history__item" href={api.attachmentUrl(item.id)} target="_blank" rel="noreferrer" title={`Open ${item.name}`}>
      {item.kind === 'image' ? <img src={api.attachmentUrl(item.id)} alt={item.name} loading="lazy" /> : <span className="attachment-history__file" aria-hidden="true">FILE</span>}
      <span className="attachment-history__meta"><span className="attachment-history__name">{item.name}</span><span className="attachment-history__size">{sizeLabel(item.size)}</span></span>
    </a>)}
  </div>;
}
