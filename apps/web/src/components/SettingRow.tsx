import type { ReactNode } from 'react';

export function SettingRow({ title, description, htmlFor, children }: { title: string; description?: ReactNode; htmlFor: string; children: ReactNode }) {
  return <div className="settings-row">
    <div className="settings-row__copy"><label htmlFor={htmlFor}>{title}</label>{description ? <p>{description}</p> : null}</div>
    <div className="settings-row__control">{children}</div>
  </div>;
}
