import * as React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Bell,
  BellOff,
  Briefcase,
  CheckCheck,
  CheckCircle2,
  ExternalLink,
  Info,
  KeyRound,
  RefreshCw,
  Trash2,
  XCircle,
} from 'lucide-react';
import { NOTIFICATION_KINDS, type NotificationDto, type NotificationKind, type NotificationLevel } from '@deedy/shared';
import { api } from '@/lib/api';
import { cn, formatDate, relativeTime } from '@/lib/utils';
import { ErrorState, LoadingRows, PageHeader } from '@/components/common';
import { Badge, Button, Card, EmptyState, Select } from '@/components/ui/primitives';
import { Pagination } from '@/components/ui/table';

const PAGE_SIZE = 25;

type ReadFilter = 'all' | 'unread';

const LEVEL_ICON: Record<NotificationLevel, React.ComponentType<{ className?: string }>> = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  error: XCircle,
};

const LEVEL_ICON_CLASS: Record<NotificationLevel, string> = {
  info: 'bg-primary/15 text-primary',
  success: 'bg-success/15 text-success',
  warning: 'bg-warning/15 text-warning',
  error: 'bg-destructive/15 text-destructive',
};

const LEVEL_TONE: Record<NotificationLevel, 'default' | 'success' | 'warning' | 'destructive'> = {
  info: 'default',
  success: 'success',
  warning: 'warning',
  error: 'destructive',
};

const KIND_LABEL: Record<NotificationKind, string> = {
  'application.submitted': 'Application submitted',
  'application.failed': 'Application failed',
  'application.needs_human': 'Needs a human',
  'job.high_score': 'High-scoring job',
  'credential.expired': 'Credential expired',
  'collector.failed': 'Collector failed',
  'queue.stalled': 'Queue stalled',
  system: 'System',
};

/** Deep link to whatever entity the notification was raised against, if any. */
function entityLink(notification: NotificationDto): { to: string; label: string } | null {
  const { entityType, entityId } = notification;
  if (entityId === null) return null;
  if (entityType === 'job') return { to: `/jobs/${entityId}`, label: 'View job' };
  if (entityType === 'application') {
    return { to: `/applications/${entityId}`, label: 'View application' };
  }
  return null;
}

/**
 * The call to action is derived from the kind rather than stored, so the
 * routing stays correct even for rows synced from an older build.
 */
function callToAction(notification: NotificationDto): { to: string; label: string } | null {
  if (!notification.actionable) return null;
  switch (notification.kind) {
    case 'application.needs_human':
      return notification.entityId !== null && notification.entityType === 'application'
        ? { to: `/applications/${notification.entityId}`, label: 'Finish this application' }
        : { to: '/applications?status=needs_human', label: 'Review applications' };
    case 'credential.expired':
      // Sessions are pasted and verified on the browser page, not in Settings.
      return { to: '/browser', label: 'Reconnect provider' };
    case 'application.failed':
      return notification.entityId !== null && notification.entityType === 'application'
        ? { to: `/applications/${notification.entityId}`, label: 'Inspect failure' }
        : { to: '/applications?status=failed', label: 'Inspect failures' };
    case 'queue.stalled':
      return { to: '/queue', label: 'Open queue' };
    case 'collector.failed':
      return { to: '/settings#search', label: 'Check collectors' };
    default:
      return null;
  }
}

function NotificationRow({
  notification,
  onMarkRead,
  onDelete,
  busy,
}: {
  notification: NotificationDto;
  onMarkRead: (id: number) => void;
  onDelete: (id: number) => void;
  busy: boolean;
}): JSX.Element {
  const Icon = LEVEL_ICON[notification.level];
  const link = entityLink(notification);
  const cta = callToAction(notification);

  return (
    <Card
      className={cn(
        'flex items-start gap-3 p-4 transition-colors',
        notification.read ? 'opacity-75' : 'border-l-2 border-l-primary',
      )}
    >
      <div
        className={cn(
          'mt-0.5 grid size-8 shrink-0 place-items-center rounded-md [&_svg]:size-4',
          LEVEL_ICON_CLASS[notification.level],
        )}
      >
        <Icon />
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className={cn('truncate text-sm', notification.read ? 'font-medium' : 'font-semibold')}>
            {notification.title}
          </p>
          <Badge variant={LEVEL_TONE[notification.level]}>{KIND_LABEL[notification.kind]}</Badge>
          {notification.read ? null : <Badge variant="outline">unread</Badge>}
        </div>

        <p className="mt-1 whitespace-pre-wrap break-words text-xs text-muted-foreground">
          {notification.body}
        </p>

        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="text-[11px] text-muted-foreground" title={formatDate(notification.createdAt)}>
            {relativeTime(notification.createdAt)}
          </span>
          {cta ? (
            <Button size="sm" asChild>
              <Link to={cta.to}>
                {notification.kind === 'credential.expired' ? <KeyRound /> : <AlertTriangle />}
                {cta.label}
              </Link>
            </Button>
          ) : null}
          {link && (!cta || cta.to !== link.to) ? (
            <Button size="sm" variant="outline" asChild>
              <Link to={link.to}>
                {link.label === 'View job' ? <Briefcase /> : <ExternalLink />}
                {link.label}
              </Link>
            </Button>
          ) : null}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        {notification.read ? null : (
          <Button
            variant="ghost"
            size="icon"
            disabled={busy}
            title="Mark as read"
            aria-label="Mark as read"
            onClick={() => onMarkRead(notification.id)}
          >
            <CheckCheck />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          disabled={busy}
          title="Delete notification"
          aria-label="Delete notification"
          onClick={() => onDelete(notification.id)}
        >
          <Trash2 />
        </Button>
      </div>
    </Card>
  );
}

export default function NotificationsPage(): JSX.Element {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const [readFilter, setReadFilter] = React.useState<ReadFilter>('all');
  const [kind, setKind] = React.useState('');
  const [page, setPage] = React.useState(1);

  const query = {
    page,
    pageSize: PAGE_SIZE,
    kind: kind ? (kind as NotificationKind) : undefined,
    unreadOnly: readFilter === 'unread' ? true : undefined,
  };

  const notifications = useQuery({
    queryKey: ['notifications', query],
    queryFn: () => api.notifications.list(query),
    refetchInterval: 30000,
  });

  const invalidate = React.useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['notifications'] });
  }, [queryClient]);

  const markRead = useMutation({
    mutationFn: (id: number) => api.notifications.markRead(id),
    onSuccess: invalidate,
  });

  const markAllRead = useMutation({
    mutationFn: () => api.notifications.markAllRead(),
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationFn: (id: number) => api.notifications.remove(id),
    onSuccess: invalidate,
  });

  const busy = markRead.isPending || remove.isPending || markAllRead.isPending;
  const mutationError = markRead.error ?? markAllRead.error ?? remove.error;
  const items = notifications.data?.items ?? [];
  const hasUnread = items.some((item) => !item.read);

  return (
    <div>
      <PageHeader
        title="Notifications"
        description="Everything the automation wants you to know. Generated and stored on this machine; only the title, body and kind are ever mirrored to your phone."
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              disabled={!hasUnread || busy}
              onClick={() => markAllRead.mutate()}
            >
              <CheckCheck />
              Mark all read
            </Button>
            <Button variant="outline" size="sm" onClick={invalidate}>
              <RefreshCw />
              Refresh
            </Button>
          </>
        }
      />

      <div className="mb-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <Select
          value={readFilter}
          onChange={(event) => {
            setReadFilter(event.target.value as ReadFilter);
            setPage(1);
          }}
        >
          <option value="all">All notifications</option>
          <option value="unread">Unread only</option>
        </Select>
        <Select
          value={kind}
          onChange={(event) => {
            setKind(event.target.value);
            setPage(1);
          }}
        >
          <option value="">All kinds</option>
          {NOTIFICATION_KINDS.map((value) => (
            <option key={value} value={value}>
              {KIND_LABEL[value]}
            </option>
          ))}
        </Select>
      </div>

      {notifications.isError ? <ErrorState error={notifications.error} /> : null}
      {mutationError ? <ErrorState error={mutationError} /> : null}

      {notifications.isLoading ? (
        <div className="rounded-lg border border-border bg-card">
          <LoadingRows rows={6} cols={3} />
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          icon={<BellOff />}
          title={
            readFilter === 'unread' && !kind
              ? 'You are all caught up'
              : 'No notifications match these filters'
          }
          description="Notifications appear when applications are submitted, need a human, or when a collector or credential needs attention."
          action={
            readFilter === 'all' && !kind ? (
              <Button variant="outline" size="sm" onClick={() => navigate('/queue')}>
                <Bell />
                Open automation queue
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setReadFilter('all');
                  setKind('');
                  setPage(1);
                }}
              >
                Clear filters
              </Button>
            )
          }
        />
      ) : (
        <div className="space-y-2">
          {items.map((notification) => (
            <NotificationRow
              key={notification.id}
              notification={notification}
              busy={busy}
              onMarkRead={(id) => markRead.mutate(id)}
              onDelete={(id) => remove.mutate(id)}
            />
          ))}
        </div>
      )}

      {notifications.data && items.length > 0 ? (
        <Pagination
          page={notifications.data.page}
          totalPages={notifications.data.totalPages}
          total={notifications.data.total}
          pageSize={notifications.data.pageSize}
          onPageChange={setPage}
        />
      ) : null}
    </div>
  );
}
