export type Role = 'admin' | 'member';
export type RsvpStatus = 'yes' | 'maybe' | 'no';

export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
}

export interface Member extends User {
  createdAt: string;
}

export interface Channel {
  id: string;
  name: string;
  description: string;
  adminOnly: boolean;
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

export interface Meeting {
  id: string;
  title: string;
  description: string;
  location: string;
  startsAt: string;
  createdBy: { id: string; name: string };
  attendees: { userId: string; name: string; status: RsvpStatus }[];
  myStatus: RsvpStatus | null;
}

export interface DocFile extends FileRef {
  folder: string;
  createdAt: string;
  uploadedBy: { id: string; name: string };
}

export type RealtimeEvent =
  | { type: 'message'; message: Message }
  | { type: 'meeting'; meetingId: string }
  | { type: 'file'; fileId: string };
