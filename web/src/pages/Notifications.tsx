import { useEffect } from 'react';
import { useApp } from '../data';
import { formatDateTime } from '../format';
import { go } from '../route';
import { Empty, Icon, PageHeader, type IconName } from '../ui';

const ICON: Record<string, IconName> = { assigned: 'tasks', mention: 'chat', due_soon: 'clock', due_today: 'clock', overdue: 'clock', meeting: 'calendar', meeting_reminder: 'calendar', project: 'projects', dm: 'chat', validation: 'check', finance: 'folder', communication: 'chat', security: 'shield', system: 'bell' };

export function Notifications() {
  const { notifications, unreadNotifs, markNotifsRead, refreshNotifs } = useApp();
  useEffect(() => { void refreshNotifs(); }, [refreshNotifs]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader title="Notifications">
        {unreadNotifs > 0 && <button className="btn btn-ghost btn-sm" onClick={() => void markNotifsRead()}><Icon name="check" className="h-4 w-4" /> Tout marquer comme lu</button>}
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto p-3 md:px-[max(0.75rem,calc((100%_-_42rem)/2))]">
        {notifications.length === 0 && <Empty icon="bell">Aucune notification pour l'instant.</Empty>}
        <ul className="space-y-2">
          {notifications.map((n) => (
            <li key={n.id}>
              <button
                onClick={() => { void markNotifsRead([n.id]); if (n.link) go(n.link.replace(/^#/, '')); }}
                className={`card flex w-full items-start gap-3 p-3 text-left hover:border-electric ${n.readAt ? '' : 'border-electric bg-blue-50/50'}`}
              >
                <span className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${n.readAt ? 'bg-mist text-slate' : 'bg-electric text-white'}`}><Icon name={ICON[n.type] ?? 'bell'} className="h-5 w-5" /></span>
                <span className="min-w-0 flex-1">
                  <span className={`block ${n.readAt ? 'font-medium' : 'font-bold'}`}>{n.category === 'urgent' && <span className="badge bd-danger mr-2">Urgent</span>}{n.category === 'action' && <span className="badge bd-electric mr-2">Action</span>}{n.title}</span>
                  {n.body && <span className="block truncate text-sm text-slate">{n.body}</span>}
                  <span className="text-xs text-slate">{formatDateTime(n.createdAt)}</span>
                </span>
                {!n.readAt && <span className="mt-2 h-2.5 w-2.5 shrink-0 rounded-full bg-electric" aria-label="Non lue" />}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
