export type Role = 'admin' | 'member' | 'guest';
export type RsvpStatus = 'yes' | 'maybe' | 'no';
export type Level = 'public' | 'internal' | 'confidential' | 'strict';
export type ProjectStatus = 'active' | 'paused' | 'done' | 'archived';
export type TaskStatus = 'todo' | 'doing' | 'review' | 'done';
export type Priority = 'urgent' | 'high' | 'medium' | 'low';

export const ROLE_LABEL: Record<Role, string> = { admin: 'Super Admin', member: 'Fondateur', guest: 'Invité interne' };
export const STATUS_LABEL: Record<ProjectStatus, string> = { active: 'Actif', paused: 'En pause', done: 'Terminé', archived: 'Archivé' };
export const TASK_STATUS_LABEL: Record<TaskStatus, string> = { todo: 'À faire', doing: 'En cours', review: 'En révision', done: 'Terminé' };
export const PRIORITY_LABEL: Record<Priority, string> = { urgent: 'Urgent', high: 'Élevée', medium: 'Moyenne', low: 'Basse' };
export const LEVEL_LABEL: Record<Level, string> = { public: 'Public', internal: 'Interne', confidential: 'Confidentiel', strict: 'Strictement confidentiel' };
export const LEVEL_HELP: Record<Level, string> = {
  public: 'Peut être diffusé à l’extérieur.',
  internal: 'Réservé à l’équipe.',
  confidential: 'Accessible uniquement aux personnes concernées (auteur, Super Admin, membres du projet).',
  strict: 'Stratégie, accès techniques, données sensibles : auteur et Super Admin seulement.',
};

export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
  emailNotif?: boolean;
}

export interface Member extends User {
  createdAt: string;
  online: boolean;
}

export interface Channel {
  id: string;
  kind: 'channel' | 'project' | 'dm';
  name: string;
  description: string;
  adminOnly: boolean;
  projectId: string | null;
  peer: { id: string; name: string } | null;
  unread: number;
  lastAt: string | null;
}

export interface FileRef {
  id: string;
  name: string;
  size: number;
  mime: string;
}

export interface Message {
  id: string;
  channelId: string;
  body: string;
  createdAt: string;
  user: { id: string; name: string };
  file: FileRef | null;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  color: string;
  status: ProjectStatus;
  createdAt: string;
  updatedAt: string;
  tasksTotal: number;
  tasksDone: number;
  progress: number;
  members: { id: string; name: string; role: Role }[];
  folderId: string | null;
  channelId: string | null;
}

export interface Task {
  id: string;
  projectId: string;
  project: { id: string; name: string; color: string; status: ProjectStatus };
  title: string;
  description: string;
  status: TaskStatus;
  priority: Priority;
  assignee: { id: string; name: string } | null;
  createdBy: { id: string; name: string } | null;
  dueDate: string | null;
  tags: string[];
  createdAt: string;
  completedAt: string | null;
  subtasksTotal: number;
  subtasksDone: number;
  commentCount: number;
  attachmentCount: number;
}

export interface TaskDetail extends Task {
  subtasks: { id: string; title: string; done: boolean }[];
  comments: { id: string; body: string; createdAt: string; user: { id: string; name: string } }[];
  attachments: { id: string; name: string; size: number; mime: string; createdAt: string; uploadedBy: string }[];
}

export interface Meeting {
  id: string;
  title: string;
  description: string;
  location: string;
  startsAt: string;
  project: { id: string; name: string; color: string } | null;
  createdBy: { id: string; name: string } | null;
  attendees: { userId: string; name: string; status: RsvpStatus }[];
  myStatus: RsvpStatus | null;
}

export interface Folder {
  id: string;
  name: string;
  parentId: string | null;
  projectId: string | null;
  system: 'general' | 'messages' | 'project' | null;
  fileCount: number;
}

export interface DocFile extends FileRef {
  folderId: string;
  level: Level;
  taskId: string | null;
  previewable: boolean;
  createdAt: string;
  uploadedBy: { id: string; name: string };
}

export interface Notif {
  id: string;
  type: string;
  title: string;
  body: string;
  link: string;
  createdAt: string;
  readAt: string | null;
}

export interface ActivityItem {
  id: string;
  userName: string;
  action: string;
  entity?: string;
  summary: string;
  createdAt: string;
}

export interface Dashboard {
  myTasksToday: { id: string; title: string; priority: Priority; status: TaskStatus; dueDate: string; overdue: boolean; project: { id: string; name: string; color: string } }[];
  upcomingMeetings: { id: string; title: string; startsAt: string; location: string }[];
  unreadChannels: { id: string; name: string; kind: string; unread: number }[];
  unreadTotal: number;
  kpis: { activeProjects: number; tasksDoneThisWeek: number; meetingsThisWeek: number; newFiles: number };
}

export type RealtimeEvent =
  | { type: 'message'; message: Message }
  | { type: 'channel'; channelId?: string }
  | { type: 'meeting'; meetingId: string }
  | { type: 'file'; fileId?: string }
  | { type: 'task'; taskId: string; projectId: string }
  | { type: 'project'; projectId: string }
  | { type: 'members' }
  | { type: 'notification'; notification: Notif }
  | { type: 'presence'; online: string[] };
