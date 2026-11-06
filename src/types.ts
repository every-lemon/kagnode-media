export type MediaKind = "video" | "audio" | "image" | "file";
export type DeliveryMode = "viewer" | "inline" | "download";
export type Visibility = "public" | "unlisted" | "private";
export type PublicationState =
  | "draft"
  | "submitted"
  | "published"
  | "withdrawn"
  | "removed";
export type ProcessingState =
  | "queued"
  | "processing"
  | "ready"
  | "failed"
  | "cancelled";
export type Role = "viewer" | "creator" | "admin";
export type Acceleration = "software" | "vaapi" | "qsv" | "nvenc";
export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  active: number;
  creator_status: string;
  trusted: number;
  quota: number;
  password: string;
}
export interface MediaMetadata {
  title: string;
  description: string;
  tags: string[];
  kind: MediaKind;
  visibility: Visibility;
  delivery: DeliveryMode;
  category: "movie" | "series" | "video" | "music" | "photo" | "file";
  collection: string;
  season: number;
  episode: number;
  duration?: number;
  width?: number;
  height?: number;
  mime?: string;
  artwork?: string;
}
export interface Profile {
  id: string;
  width: number;
  height: number;
  bitrate: number;
}
export interface Policy {
  allowInline: boolean;
  allowDownload: boolean;
  uploadLimit: number;
  creatorQuota: number;
  globalQuota: number;
  registration: boolean;
  acceleration: Acceleration;
  device: string;
  threads: number;
  concurrency: number;
  jobTimeout: number;
  maxQueuedJobs: number;
  maxOutputBytes: number;
  profiles: Profile[];
}
export interface ProcessingInput {
  source: string;
  destination: string;
  metadata: MediaMetadata;
  policy: Policy;
}
export interface ProcessingResult {
  metadata: MediaMetadata;
  files: string[];
  profiles: string[];
}
export interface Processor {
  process(
    input: ProcessingInput,
    signal: AbortSignal,
    progress: (percent: number) => void,
  ): Promise<ProcessingResult>;
}
