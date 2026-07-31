// URL/URLSearchParams are incomplete in the Hermes runtime and supabase-js
// parses both, so the polyfill has to be installed before the client is built.
import 'react-native-url-polyfill/auto';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

import type { CommandStatus, RemoteCommand } from './types';

/* -------------------------------------------------------------------------- */
/* Database types                                                             */
/* -------------------------------------------------------------------------- */
/* Mirrors supabase/schema.sql. Every table here holds operational metadata    */
/* only: no resume or cover letter text, no candidate PII, no provider         */
/* credentials, no LLM output, no artifacts. If a column that could carry one  */
/* of those ever appears in this type, it is a bug in the sync layer.          */
/*                                                                            */
/* These duplicate SyncedJobRow / SyncedApplicationRow / RemoteCommandRow in   */
/* packages/shared/src/dto.ts rather than importing them: @deedy/shared        */
/* resolves to compiled ESM under packages/shared/dist, which Metro will not   */
/* bundle from a sibling workspace, and a type-only import that Metro happens  */
/* to erase today is a trap for whoever adds the first value import.           */
/*                                                                            */
/* Enum-ish columns are typed `string`, not the narrowed unions in ./types:    */
/* PostgREST's filter builders demand the column's own type, and the screens   */
/* hold filter values as plain strings. ./types carries the narrow unions for  */
/* rendering; these are the wire shapes.                                       */

export interface SyncedJobRow {
  id: number;
  user_id: string;
  title: string;
  company: string;
  location: string | null;
  source: string;
  remote_type: string;
  employment_type: string;
  experience_level: string;
  salary_min: number | null;
  salary_max: number | null;
  salary_currency: string | null;
  score: number | null;
  recommendation: string | null;
  status: string;
  application_url: string;
  posted_at: string | null;
  collected_at: string;
  updated_at: string;
}

export interface SyncedApplicationRow {
  id: number;
  user_id: string;
  job_id: number;
  job_title: string | null;
  company: string | null;
  provider: string;
  status: string;
  current_step: string | null;
  attempts: number;
  max_attempts: number;
  /** Short failure reason only. Never a page snapshot, form payload or LLM output. */
  error: string | null;
  dry_run: boolean;
  started_at: string | null;
  submitted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface RemoteCommandRow {
  id: string;
  user_id: string;
  kind: RemoteCommand;
  payload: Record<string, unknown>;
  status: CommandStatus;
  result: string | null;
  created_at: string;
  claimed_at: string | null;
  completed_at: string | null;
}

export interface SyncedNotificationRow {
  id: number;
  user_id: string;
  kind: string;
  level: string;
  title: string;
  body: string;
  entity_type: string | null;
  entity_id: number | null;
  read: boolean;
  actionable: boolean;
  created_at: string;
}

export interface SyncedQueueStatsRow {
  user_id: string;
  pending: number;
  active: number;
  completed: number;
  failed: number;
  // The host pushes `delayed` as its own counter (see pushQueueStats in
  // apps/api/src/services/sync/sync.service.ts); public.queue_stats carries a
  // matching column. Dropping it here would mis-describe the wire shape.
  delayed: number;
  cancelled: number;
  worker_running: boolean;
  updated_at: string;
}

export interface SyncedDeviceRow {
  id: string;
  user_id: string;
  expo_push_token: string;
  platform: string | null;
  last_seen_at: string;
}

/** The phone only ever inserts commands; the host stamps the rest. */
export type RemoteCommandInsert = Pick<RemoteCommandRow, 'user_id' | 'kind'> &
  Partial<Pick<RemoteCommandRow, 'id' | 'payload' | 'status'>>;

export type DeviceInsert = Pick<SyncedDeviceRow, 'user_id' | 'expo_push_token'> &
  Partial<Pick<SyncedDeviceRow, 'platform' | 'last_seen_at'>>;

export interface Database {
  public: {
    Tables: {
      jobs: {
        Row: SyncedJobRow;
        Insert: SyncedJobRow;
        Update: Partial<SyncedJobRow>;
        Relationships: [];
      };
      applications: {
        Row: SyncedApplicationRow;
        Insert: SyncedApplicationRow;
        Update: Partial<SyncedApplicationRow>;
        Relationships: [];
      };
      notifications: {
        Row: SyncedNotificationRow;
        Insert: SyncedNotificationRow;
        Update: Partial<SyncedNotificationRow>;
        Relationships: [];
      };
      queue_stats: {
        Row: SyncedQueueStatsRow;
        Insert: SyncedQueueStatsRow;
        Update: Partial<SyncedQueueStatsRow>;
        Relationships: [];
      };
      commands: {
        Row: RemoteCommandRow;
        Insert: RemoteCommandInsert;
        Update: Partial<RemoteCommandRow>;
        Relationships: [];
      };
      devices: {
        Row: SyncedDeviceRow;
        Insert: DeviceInsert;
        Update: Partial<SyncedDeviceRow>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}

/* -------------------------------------------------------------------------- */
/* Configuration                                                              */
/* -------------------------------------------------------------------------- */

interface MobileExtra {
  supabaseUrl?: string;
  supabasePublishableKey?: string;
}

function readExtra(): MobileExtra {
  const extra = Constants.expoConfig?.extra;
  return extra === undefined || extra === null ? {} : (extra as MobileExtra);
}

const extra = readExtra();

/**
 * EXPO_PUBLIC_* env vars are inlined at build time and win over app.json, so a
 * developer can point a build at another project without editing the config.
 *
 * Only the publishable (anon) key belongs here. It is deliberately public: row
 * level security on user_id = auth.uid() is what protects the data. The service
 * role key bypasses RLS entirely and must never be shipped in the bundle -
 * anyone can unzip an app binary and read it.
 */
export const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL ?? extra.supabaseUrl ?? '';
export const supabasePublishableKey =
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? extra.supabasePublishableKey ?? '';

/** False until both values are present, so the UI can show setup instructions instead of failing requests. */
export function isConfigured(): boolean {
  return supabaseUrl.trim().length > 0 && supabasePublishableKey.trim().length > 0;
}

/* -------------------------------------------------------------------------- */
/* Auth storage                                                               */
/* -------------------------------------------------------------------------- */

/**
 * SecureStore rejects values over 2048 bytes, and a Supabase session (access
 * token + refresh token + user object) routinely exceeds that. Values are
 * therefore split across numbered slots, with slot 0 holding the chunk count
 * so a read knows how many to reassemble.
 */
const CHUNK_SIZE = 1800;
const MAX_CHUNKS = 32;

function slotKey(key: string, index: number): string {
  // SecureStore keys must be alphanumeric plus . - _ ; Supabase keys already are.
  return `${key}.${index}`;
}

async function readChunked(key: string): Promise<string | null> {
  const head = await SecureStore.getItemAsync(key);
  if (head === null) return null;

  const count = Number.parseInt(head, 10);
  if (!Number.isInteger(count) || count < 1 || count > MAX_CHUNKS) return null;

  const parts: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const part = await SecureStore.getItemAsync(slotKey(key, i));
    // A missing chunk means a half-written session; treat it as no session at
    // all so supabase-js re-authenticates rather than parsing truncated JSON.
    if (part === null) return null;
    parts.push(part);
  }
  return parts.join('');
}

async function writeChunked(key: string, value: string): Promise<void> {
  await clearChunked(key);

  const parts: string[] = [];
  for (let i = 0; i < value.length; i += CHUNK_SIZE) {
    parts.push(value.slice(i, i + CHUNK_SIZE));
  }
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (part === undefined) continue;
    await SecureStore.setItemAsync(slotKey(key, i), part);
  }
  await SecureStore.setItemAsync(key, String(parts.length));
}

async function clearChunked(key: string): Promise<void> {
  const head = await SecureStore.getItemAsync(key);
  const count = head === null ? 0 : Number.parseInt(head, 10);
  const upTo = Number.isInteger(count) && count > 0 && count <= MAX_CHUNKS ? count : MAX_CHUNKS;
  for (let i = 0; i < upTo; i += 1) {
    await SecureStore.deleteItemAsync(slotKey(key, i));
  }
  await SecureStore.deleteItemAsync(key);
}

interface AuthStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

const secureStorage: AuthStorage = {
  getItem: readChunked,
  setItem: writeChunked,
  removeItem: clearChunked,
};

/**
 * `expo start --web` has no SecureStore implementation. The web target is a
 * development convenience only, so it falls back to localStorage guarded for
 * SSR/prerender where `window` does not exist.
 */
const webStorage: AuthStorage = {
  getItem: (key) => Promise.resolve(typeof window === 'undefined' ? null : window.localStorage.getItem(key)),
  setItem: (key, value) => {
    if (typeof window !== 'undefined') window.localStorage.setItem(key, value);
    return Promise.resolve();
  },
  removeItem: (key) => {
    if (typeof window !== 'undefined') window.localStorage.removeItem(key);
    return Promise.resolve();
  },
};

const authStorage = Platform.OS === 'web' ? webStorage : secureStorage;

/* -------------------------------------------------------------------------- */
/* Client                                                                     */
/* -------------------------------------------------------------------------- */

export type DeedySupabaseClient = SupabaseClient<Database, 'public'>;

/**
 * Built even when unconfigured so imports stay static and screens can render;
 * callers gate on `isConfigured()` before issuing a request.
 */
export const supabase: DeedySupabaseClient = createClient<Database, 'public'>(
  supabaseUrl.length > 0 ? supabaseUrl : 'http://localhost:54321',
  supabasePublishableKey,
  {
    auth: {
      storage: authStorage,
      autoRefreshToken: true,
      persistSession: true,
      // There is no OAuth redirect to parse in a native app, and leaving this on
      // makes supabase-js touch window.location, which does not exist here.
      detectSessionInUrl: false,
    },
  },
);
