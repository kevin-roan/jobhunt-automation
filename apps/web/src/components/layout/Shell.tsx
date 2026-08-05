import * as React from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  BarChart3,
  Bell,
  Bot,
  Briefcase,
  ChevronLeft,
  FileText,
  Globe,
  LayoutDashboard,
  ListChecks,
  Mail,
  Menu,
  Radar,
  ScrollText,
  Settings as SettingsIcon,
  Sparkles,
  Tags,
} from 'lucide-react';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Badge, Button } from '@/components/ui/primitives';
import { PipelineStatusPill } from '@/components/PipelineControls';

interface NavItem {
  to: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  group: 'Pipeline' | 'Documents' | 'Operations';
}

const NAV: NavItem[] = [
  { to: '/', label: 'Overview', icon: LayoutDashboard, group: 'Pipeline' },
  { to: '/jobs', label: 'Jobs', icon: Briefcase, group: 'Pipeline' },
  { to: '/sources', label: 'Sources', icon: Radar, group: 'Pipeline' },
  { to: '/keywords', label: 'Keywords', icon: Tags, group: 'Pipeline' },
  { to: '/applications', label: 'Applications', icon: ListChecks, group: 'Pipeline' },
  { to: '/analytics', label: 'Analytics', icon: BarChart3, group: 'Pipeline' },
  { to: '/resumes', label: 'Resume Manager', icon: FileText, group: 'Documents' },
  { to: '/cover-letters', label: 'Cover Letters', icon: Mail, group: 'Documents' },
  { to: '/queue', label: 'Automation Queue', icon: Activity, group: 'Operations' },
  { to: '/browser', label: 'Browser Sessions', icon: Globe, group: 'Operations' },
  { to: '/llm', label: 'LLM Activity', icon: Sparkles, group: 'Operations' },
  { to: '/notifications', label: 'Notifications', icon: Bell, group: 'Operations' },
  { to: '/logs', label: 'Logs', icon: ScrollText, group: 'Operations' },
  { to: '/settings', label: 'Settings', icon: SettingsIcon, group: 'Operations' },
];

const GROUPS: NavItem['group'][] = ['Pipeline', 'Documents', 'Operations'];

function HealthPill(): JSX.Element {
  const { data, isError } = useQuery({
    queryKey: ['health'],
    queryFn: api.health,
    refetchInterval: 20000,
  });

  if (isError || !data) {
    return (
      <Badge variant="destructive" className="gap-1.5">
        <span className="size-1.5 rounded-full bg-current" />
        API unreachable
      </Badge>
    );
  }

  const healthy = data.status === 'ok';
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Badge variant={healthy ? 'success' : 'warning'} className="gap-1.5">
        <span className="size-1.5 rounded-full bg-current" />
        {healthy ? 'Healthy' : 'Degraded'}
      </Badge>
      <Badge variant={data.llm.reachable ? 'outline' : 'destructive'} title={data.llm.error ?? ''}>
        LLM {data.llm.reachable ? (data.llm.model || 'no model set') : 'offline'}
      </Badge>
      <Badge variant="outline" className="tabular">
        Queue {data.queue.active}/{data.queue.pending}
        {data.queue.paused ? ' · paused' : ''}
      </Badge>
    </div>
  );
}

function NotificationBell(): JSX.Element {
  const { data } = useQuery({
    queryKey: ['notifications', 'unread-count'],
    queryFn: api.notifications.unreadCount,
    refetchInterval: 30000,
  });

  const unread = data?.count ?? 0;
  const label = unread > 0 ? `Notifications (${unread} unread)` : 'Notifications';

  return (
    <Button variant="ghost" size="icon" className="relative" asChild>
      <Link to="/notifications" aria-label={label} title={label}>
        <Bell />
        {unread > 0 ? (
          <span className="tabular absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-destructive px-1 text-[10px] font-semibold leading-none text-destructive-foreground">
            {unread > 99 ? '99+' : unread}
          </span>
        ) : null}
      </Link>
    </Button>
  );
}

export function Shell({ children }: { children: React.ReactNode }): JSX.Element {
  const [open, setOpen] = React.useState(false);
  const location = useLocation();

  React.useEffect(() => {
    setOpen(false);
  }, [location.pathname]);

  return (
    <div className="flex min-h-screen bg-background">
      {/* Mobile overlay */}
      {open ? (
        <button
          type="button"
          aria-label="Close navigation"
          className="fixed inset-0 z-30 bg-black/60 lg:hidden"
          onClick={() => setOpen(false)}
        />
      ) : null}

      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-40 flex w-64 shrink-0 flex-col border-r border-border bg-card transition-transform lg:static lg:translate-x-0',
          open ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="flex h-14 items-center gap-2.5 border-b border-border px-5">
          <div className="grid size-7 place-items-center rounded-md bg-primary text-primary-foreground">
            <Bot className="size-4" />
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold leading-tight">Deedy Automation</p>
            <p className="truncate text-[10px] uppercase tracking-wider text-muted-foreground">
              Local · Autonomous
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="ml-auto lg:hidden"
            onClick={() => setOpen(false)}
            aria-label="Close navigation"
          >
            <ChevronLeft />
          </Button>
        </div>

        <nav className="scrollbar-thin flex-1 space-y-6 overflow-y-auto p-3">
          {GROUPS.map((group) => (
            <div key={group}>
              <p className="px-3 pb-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                {group}
              </p>
              <ul className="space-y-0.5">
                {NAV.filter((item) => item.group === group).map((item) => (
                  <li key={item.to}>
                    <NavLink
                      to={item.to}
                      end={item.to === '/'}
                      className={({ isActive }) =>
                        cn(
                          'flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors',
                          isActive
                            ? 'bg-accent font-medium text-accent-foreground'
                            : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
                        )
                      }
                    >
                      <item.icon className="size-4 shrink-0" />
                      <span className="truncate">{item.label}</span>
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>

        <div className="border-t border-border p-3 text-[10px] leading-relaxed text-muted-foreground">
          Everything runs on this machine. No job data or credentials leave the host.
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-border bg-background/85 px-4 backdrop-blur lg:px-6">
          <Button
            variant="ghost"
            size="icon"
            className="lg:hidden"
            onClick={() => setOpen(true)}
            aria-label="Open navigation"
          >
            <Menu />
          </Button>
          <h1 className="truncate text-sm font-medium">
            {NAV.find((item) =>
              item.to === '/' ? location.pathname === '/' : location.pathname.startsWith(item.to),
            )?.label ?? 'Deedy Automation'}
          </h1>
          <div className="ml-auto flex items-center gap-2">
            <PipelineStatusPill />
            <HealthPill />
            <NotificationBell />
          </div>
        </header>

        <main className="scrollbar-thin flex-1 p-4 lg:p-6">{children}</main>
      </div>
    </div>
  );
}
