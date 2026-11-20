export type Role = 'admin' | 'member' | 'guest';
export type RsvpStatus = 'yes' | 'maybe' | 'no';
export type Level = 'public' | 'internal' | 'confidential' | 'strict';
export type ProjectStatus = 'active' | 'paused' | 'done' | 'archived';
export type TaskStatus = 'todo' | 'doing' | 'review' | 'done';
export type Priority = 'urgent' | 'high' | 'medium' | 'low';

export const ROLE_LABEL: Record<Role, string> = { admin: 'Administrateur technique', member: 'Fondateur', guest: 'Invité interne' };

/** Fonctions de gouvernance (spécification v1.2 §3). */
export type Fn = 'pdg' | 'coordinator' | 'project_lead' | 'infra_lead' | 'treasurer' | 'comms';
export const FN_LABEL: Record<Fn, string> = {
  pdg: 'PDG', coordinator: 'Coordinateur', project_lead: 'Chef de projet', infra_lead: "Chef d'infrastructures", treasurer: 'Caissier', comms: 'Chargé de communication',
};
export const FN_KEYS = Object.keys(FN_LABEL) as Fn[];
export type Capability =
  | 'project.create' | 'project.delete' | 'project.reopen' | 'project.confirm_archive' | 'function.assign' | 'mandate.grant' | 'rules.edit'
  | 'finance.read' | 'expense.create' | 'expense.pay' | 'announce.internal' | 'announce.service' | 'crisis.publish' | 'comm.publish' | 'comm.prepare'
  | 'comm.withdraw' | 'journal.business' | 'journal.security' | 'journal.emergency' | 'infra.read' | 'tech.ops' | 'account.suspend';
export const STATUS_LABEL: Record<ProjectStatus, string> = { active: 'Actif', paused: 'En pause', done: 'Terminé — à archiver', archived: 'Archivé' };
export const TASK_STATUS_LABEL: Record<TaskStatus, string> = { todo: 'À faire', doing: 'En cours', review: 'En révision', done: 'Terminé' };
export const PRIORITY_LABEL: Record<Priority, string> = { urgent: 'Urgent', high: 'Élevée', medium: 'Moyenne', low: 'Basse' };
export const LEVEL_LABEL: Record<Level, string> = { public: 'Public', internal: 'Interne', confidential: 'Confidentiel', strict: 'Strictement confidentiel' };
export const LEVEL_HELP: Record<Level, string> = {
  public: 'Peut être diffusé à l’extérieur.',
  internal: 'Réservé à l’équipe.',
  confidential: 'Accessible uniquement aux personnes concernées (auteur, administrateur technique, membres du projet).',
  strict: 'Stratégie, accès techniques, données sensibles : auteur et administrateur technique seulement.',
};

export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
  emailNotif?: boolean;
  functions?: Fn[];
  /** Capacités calculées par le serveur (pour masquer les boutons ; le serveur reste seul juge). */
  can?: Partial<Record<Capability, boolean>>;
}

export interface Member extends User {
  createdAt: string;
  online: boolean;
  suspended?: boolean;
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
  /** Pièces jointes de salons : date à laquelle le serveur ne les garde plus (null = conservé). */
  expiresAt?: string | null;
  /** Le serveur ne l'a plus ; seule une copie déjà ouverte sur un appareil subsiste. */
  expired?: boolean;
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
  lead?: { id: string; name: string } | null;
  orphan?: boolean;
  doneAt?: string | null;
  archiveMotive?: string;
  pendingProposals?: number;
  permissions?: ProjectPermissions;
}

export interface ProjectPermissions {
  edit: boolean; manageMembers: boolean; proposeMembers: boolean; designateLead: boolean; proposeLead: boolean;
  declareDone: boolean; decideArchive: boolean; reopen: boolean; delete: boolean;
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
  archivedAt: string | null;
  /** Rôle de l'utilisateur sur cette tâche (amendement v1.1 §5.3.1) et ce qu'il peut y faire. */
  myRole: TaskRole;
  lock: 'none' | 'locked' | 'archived';
  permissions: TaskPermissions;
  blockedBy?: number;
}

export type TaskRole = 'admin' | 'coordinator' | 'creator' | 'assignee' | 'observer';
export const TASK_ROLE_LABEL: Record<TaskRole, string> = { admin: 'Responsable / PDG', coordinator: 'Coordinateur', creator: 'Créateur', assignee: 'Assigné', observer: 'Observateur' };

export interface TaskPermissions {
  edit: boolean;
  status: boolean;
  reassign: boolean;
  delete: boolean;
  subtask: boolean;
  archive: boolean;
  unarchive: boolean;
}

export interface TaskHistoryEntry { id: string; user: string; field: string; oldValue: string | null; newValue: string | null; createdAt: string }

export interface TaskDetail extends Task {
  subtasks: { id: string; title: string; done: boolean }[];
  comments: { id: string; body: string; createdAt: string; user: { id: string; name: string }; canDelete: boolean }[];
  attachments: { id: string; name: string; size: number; mime: string; createdAt: string; uploadedBy: string; canDelete: boolean }[];
  history: TaskHistoryEntry[];
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
  category?: 'info' | 'action' | 'urgent';
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
