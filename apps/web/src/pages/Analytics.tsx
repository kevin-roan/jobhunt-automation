import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  Briefcase,
  MessageSquareReply,
  RefreshCw,
  Send,
  Sparkles,
  Target,
  Users,
} from 'lucide-react';
import type { AnalyticsPayload, CountByLabel, TimeSeriesPoint } from '@deedy/shared';
import { api } from '@/lib/api';
import { formatDay, formatNumber, truncate } from '@/lib/utils';
import {
  CHART_AXIS,
  CHART_COLORS,
  CHART_GRID,
  ChartTooltipContent,
  ErrorState,
  PageHeader,
  StatCard,
} from '@/components/common';
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  Progress,
  Select,
  Skeleton,
} from '@/components/ui/primitives';
import { TBody, TD, TH, THead, TR, Table, TableWrapper } from '@/components/ui/table';

const RANGES = [7, 30, 90, 365] as const;

export default function AnalyticsPage(): JSX.Element {
  const queryClient = useQueryClient();
  const [days, setDays] = React.useState<number>(30);

  const analytics = useQuery({
    queryKey: ['analytics', days],
    queryFn: () => api.analytics.full(days),
  });

  const data = analytics.data;
  const overview = data?.overview;
  const loading = analytics.isLoading;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Analytics"
        description="Everything the pipeline has learned about your search, computed locally from your own database."
        actions={
          <>
            <Select
              value={String(days)}
              onChange={(event) => setDays(Number(event.target.value))}
              className="h-8 w-36 text-xs"
              aria-label="Time range"
            >
              {RANGES.map((range) => (
                <option key={range} value={range}>
                  Last {range} days
                </option>
              ))}
            </Select>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void queryClient.invalidateQueries({ queryKey: ['analytics'] })}
            >
              <RefreshCw />
              Refresh
            </Button>
          </>
        }
      />

      {analytics.isError ? <ErrorState error={analytics.error} /> : null}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <StatCard
          label="Applications / day"
          value={formatAverage(averagePerDay(data?.applicationsPerDay, days))}
          hint={`${formatNumber(overview?.totalApplications)} total`}
          icon={<Send />}
          loading={loading}
        />
        <StatCard
          label="Jobs / day"
          value={formatAverage(averagePerDay(data?.jobsPerDay, days))}
          hint={`${formatNumber(overview?.totalJobs)} collected`}
          icon={<Briefcase />}
          loading={loading}
        />
        <StatCard
          label="Success rate"
          value={formatPercent(overview?.successRate)}
          hint={`${formatNumber(overview?.submittedApplications)} submitted`}
          tone="success"
          icon={<Target />}
          loading={loading}
        />
        <StatCard
          label="Response rate"
          value={formatPercent(overview?.responseRate)}
          hint={`${formatNumber(overview?.offers)} offer(s)`}
          icon={<MessageSquareReply />}
          loading={loading}
        />
        <StatCard
          label="Interview rate"
          value={formatPercent(overview?.interviewRate)}
          hint={`${formatNumber(overview?.interviews)} interview(s)`}
          tone="warning"
          icon={<Users />}
          loading={loading}
        />
        <StatCard
          label="Average score"
          value={overview ? overview.averageScore.toFixed(1) : '—'}
          hint={`${formatNumber(overview?.scoredJobs)} scored`}
          icon={<Sparkles />}
          loading={loading}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard
          title="Applications per day"
          className="lg:col-span-2"
          loading={loading}
          hasData={hasPoints(data?.applicationsPerDay)}
        >
          <AreaChart data={data?.applicationsPerDay ?? []}>
            <defs>
              <linearGradient id="analyticsApplicationsFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={CHART_COLORS[1]} stopOpacity={0.45} />
                <stop offset="100%" stopColor={CHART_COLORS[1]} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke={CHART_GRID} strokeDasharray="3 3" vertical={false} />
            <XAxis
              dataKey="date"
              tickFormatter={formatDay}
              stroke={CHART_AXIS}
              fontSize={11}
              tickLine={false}
              axisLine={false}
              minTickGap={16}
            />
            <YAxis stroke={CHART_AXIS} fontSize={11} tickLine={false} axisLine={false} width={36} />
            <Tooltip content={<ChartTooltipContent />} />
            <Area
              type="monotone"
              dataKey="value"
              name="Applications"
              stroke={CHART_COLORS[1]}
              fill="url(#analyticsApplicationsFill)"
              strokeWidth={2}
            />
          </AreaChart>
        </ChartCard>

        <ChartCard
          title="Jobs scraped per day"
          className="lg:col-span-2"
          loading={loading}
          hasData={hasPoints(data?.jobsPerDay)}
        >
          <AreaChart data={data?.jobsPerDay ?? []}>
            <defs>
              <linearGradient id="analyticsJobsFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={CHART_COLORS[0]} stopOpacity={0.45} />
                <stop offset="100%" stopColor={CHART_COLORS[0]} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke={CHART_GRID} strokeDasharray="3 3" vertical={false} />
            <XAxis
              dataKey="date"
              tickFormatter={formatDay}
              stroke={CHART_AXIS}
              fontSize={11}
              tickLine={false}
              axisLine={false}
              minTickGap={16}
            />
            <YAxis stroke={CHART_AXIS} fontSize={11} tickLine={false} axisLine={false} width={36} />
            <Tooltip content={<ChartTooltipContent />} />
            <Area
              type="monotone"
              dataKey="value"
              name="Jobs collected"
              stroke={CHART_COLORS[0]}
              fill="url(#analyticsJobsFill)"
              strokeWidth={2}
            />
          </AreaChart>
        </ChartCard>

        <ChartCard
          title="Average AI score per day"
          className="lg:col-span-2"
          loading={loading}
          hasData={hasPoints(data?.averageScorePerDay)}
        >
          <LineChart data={data?.averageScorePerDay ?? []}>
            <CartesianGrid stroke={CHART_GRID} strokeDasharray="3 3" vertical={false} />
            <XAxis
              dataKey="date"
              tickFormatter={formatDay}
              stroke={CHART_AXIS}
              fontSize={11}
              tickLine={false}
              axisLine={false}
              minTickGap={16}
            />
            <YAxis
              stroke={CHART_AXIS}
              fontSize={11}
              tickLine={false}
              axisLine={false}
              width={36}
              domain={[0, 100]}
            />
            <Tooltip content={<ChartTooltipContent />} />
            <Line
              type="monotone"
              dataKey="value"
              name="Average score"
              stroke={CHART_COLORS[5]}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4 }}
            />
          </LineChart>
        </ChartCard>

        <ChartCard
          title="LLM tokens per day"
          className="lg:col-span-2"
          loading={loading}
          hasData={hasPoints(data?.tokensPerDay)}
        >
          <AreaChart data={data?.tokensPerDay ?? []}>
            <defs>
              <linearGradient id="analyticsTokensFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={CHART_COLORS[4]} stopOpacity={0.45} />
                <stop offset="100%" stopColor={CHART_COLORS[4]} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke={CHART_GRID} strokeDasharray="3 3" vertical={false} />
            <XAxis
              dataKey="date"
              tickFormatter={formatDay}
              stroke={CHART_AXIS}
              fontSize={11}
              tickLine={false}
              axisLine={false}
              minTickGap={16}
            />
            <YAxis
              stroke={CHART_AXIS}
              fontSize={11}
              tickLine={false}
              axisLine={false}
              width={48}
              tickFormatter={(value: number) => formatNumber(value)}
            />
            <Tooltip content={<ChartTooltipContent />} />
            <Area
              type="monotone"
              dataKey="value"
              name="Tokens"
              stroke={CHART_COLORS[4]}
              fill="url(#analyticsTokensFill)"
              strokeWidth={2}
            />
          </AreaChart>
        </ChartCard>

        <ChartCard title="Application funnel" loading={loading} hasData={hasCounts(data?.funnel)}>
          <BarChart data={data?.funnel ?? []} layout="vertical" margin={{ left: 8, right: 12 }}>
            <CartesianGrid stroke={CHART_GRID} strokeDasharray="3 3" horizontal={false} />
            <XAxis type="number" stroke={CHART_AXIS} fontSize={11} tickLine={false} axisLine={false} />
            <YAxis
              type="category"
              dataKey="label"
              stroke={CHART_AXIS}
              fontSize={11}
              width={96}
              tickLine={false}
              axisLine={false}
            />
            <Tooltip content={<ChartTooltipContent />} cursor={{ fill: 'hsl(var(--secondary))' }} />
            <Bar dataKey="count" name="Count" radius={[0, 4, 4, 0]}>
              {(data?.funnel ?? []).map((_, index) => (
                <Cell key={index} fill={CHART_COLORS[index % CHART_COLORS.length]} />
              ))}
            </Bar>
          </BarChart>
        </ChartCard>

        <ChartCard
          title="Job source distribution"
          loading={loading}
          hasData={hasCounts(data?.sourceDistribution)}
        >
          <PieChart>
            <Pie
              data={data?.sourceDistribution ?? []}
              dataKey="count"
              nameKey="label"
              innerRadius={54}
              outerRadius={90}
              paddingAngle={2}
              stroke="hsl(var(--card))"
            >
              {(data?.sourceDistribution ?? []).map((_, index) => (
                <Cell key={index} fill={CHART_COLORS[index % CHART_COLORS.length]} />
              ))}
            </Pie>
            <Tooltip content={<ChartTooltipContent />} />
          </PieChart>
        </ChartCard>

        <ChartCard
          title="Top companies"
          loading={loading}
          hasData={hasCounts(data?.topCompanies)}
          height="h-[26rem]"
        >
          <BarChart
            data={topN(data?.topCompanies, 15)}
            layout="vertical"
            margin={{ left: 8, right: 12 }}
          >
            <CartesianGrid stroke={CHART_GRID} strokeDasharray="3 3" horizontal={false} />
            <XAxis type="number" stroke={CHART_AXIS} fontSize={11} tickLine={false} axisLine={false} />
            <YAxis
              type="category"
              dataKey="label"
              stroke={CHART_AXIS}
              fontSize={11}
              width={128}
              tickLine={false}
              axisLine={false}
              tickFormatter={(value: string) => truncate(value, 18)}
            />
            <Tooltip content={<ChartTooltipContent />} cursor={{ fill: 'hsl(var(--secondary))' }} />
            <Bar dataKey="count" name="Jobs" fill={CHART_COLORS[0]} radius={[0, 4, 4, 0]} />
          </BarChart>
        </ChartCard>

        <ChartCard
          title="Top skills in demand"
          loading={loading}
          hasData={hasCounts(data?.topSkills)}
          height="h-[26rem]"
        >
          <BarChart
            data={topN(data?.topSkills, 20)}
            layout="vertical"
            margin={{ left: 8, right: 12 }}
          >
            <CartesianGrid stroke={CHART_GRID} strokeDasharray="3 3" horizontal={false} />
            <XAxis type="number" stroke={CHART_AXIS} fontSize={11} tickLine={false} axisLine={false} />
            <YAxis
              type="category"
              dataKey="label"
              stroke={CHART_AXIS}
              fontSize={11}
              width={128}
              tickLine={false}
              axisLine={false}
              tickFormatter={(value: string) => truncate(value, 18)}
            />
            <Tooltip content={<ChartTooltipContent />} cursor={{ fill: 'hsl(var(--secondary))' }} />
            <Bar dataKey="count" name="Mentions" fill={CHART_COLORS[2]} radius={[0, 4, 4, 0]} />
          </BarChart>
        </ChartCard>

        <ChartCard
          title="Location demand"
          loading={loading}
          hasData={hasCounts(data?.locationDemand)}
          height="h-[26rem]"
        >
          <BarChart
            data={data?.locationDemand ?? []}
            layout="vertical"
            margin={{ left: 8, right: 12 }}
          >
            <CartesianGrid stroke={CHART_GRID} strokeDasharray="3 3" horizontal={false} />
            <XAxis type="number" stroke={CHART_AXIS} fontSize={11} tickLine={false} axisLine={false} />
            <YAxis
              type="category"
              dataKey="label"
              stroke={CHART_AXIS}
              fontSize={11}
              width={128}
              tickLine={false}
              axisLine={false}
              tickFormatter={(value: string) => truncate(value, 18)}
            />
            <Tooltip content={<ChartTooltipContent />} cursor={{ fill: 'hsl(var(--secondary))' }} />
            <Bar dataKey="count" name="Jobs" fill={CHART_COLORS[4]} radius={[0, 4, 4, 0]} />
          </BarChart>
        </ChartCard>

        <ChartCard
          title="Score distribution"
          loading={loading}
          hasData={hasCounts(data?.scoreHistogram)}
          height="h-[26rem]"
        >
          <BarChart data={data?.scoreHistogram ?? []} margin={{ left: 0, right: 12 }}>
            <CartesianGrid stroke={CHART_GRID} strokeDasharray="3 3" vertical={false} />
            <XAxis
              dataKey="label"
              stroke={CHART_AXIS}
              fontSize={11}
              tickLine={false}
              axisLine={false}
              interval={0}
              angle={-30}
              textAnchor="end"
              height={48}
            />
            <YAxis stroke={CHART_AXIS} fontSize={11} tickLine={false} axisLine={false} width={36} />
            <Tooltip content={<ChartTooltipContent />} cursor={{ fill: 'hsl(var(--secondary))' }} />
            <Bar dataKey="count" name="Jobs" radius={[4, 4, 0, 0]}>
              {(data?.scoreHistogram ?? []).map((_, index) => (
                <Cell key={index} fill={CHART_COLORS[index % CHART_COLORS.length]} />
              ))}
            </Bar>
          </BarChart>
        </ChartCard>

        <ChartCard
          title="Application status breakdown"
          loading={loading}
          hasData={hasCounts(data?.statusBreakdown)}
        >
          <PieChart>
            <Pie
              data={data?.statusBreakdown ?? []}
              dataKey="count"
              nameKey="label"
              innerRadius={54}
              outerRadius={90}
              paddingAngle={2}
              stroke="hsl(var(--card))"
            >
              {(data?.statusBreakdown ?? []).map((_, index) => (
                <Cell key={index} fill={CHART_COLORS[index % CHART_COLORS.length]} />
              ))}
            </Pie>
            <Tooltip content={<ChartTooltipContent />} />
          </PieChart>
        </ChartCard>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Resume effectiveness</CardTitle>
          </CardHeader>
          <CardContent>
            <ResumeEffectivenessTable rows={data?.resumeEffectiveness} loading={loading} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

/** Card + ResponsiveContainer wrapper so every chart shares identical loading and empty handling. */
function ChartCard({
  title,
  className,
  height = 'h-72',
  loading,
  hasData,
  children,
}: {
  title: string;
  className?: string;
  height?: string;
  loading: boolean;
  hasData: boolean;
  children: React.ReactElement;
}): JSX.Element {
  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className={height}>
        {loading ? (
          <Skeleton className="size-full" />
        ) : hasData ? (
          <ResponsiveContainer width="100%" height="100%">
            {children}
          </ResponsiveContainer>
        ) : (
          <div className="grid size-full place-items-center">
            <p className="text-xs text-muted-foreground">No data for this range yet</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ResumeEffectivenessTable({
  rows,
  loading,
}: {
  rows: AnalyticsPayload['resumeEffectiveness'] | undefined;
  loading: boolean;
}): JSX.Element {
  if (loading) return <Skeleton className="h-40 w-full" />;
  if (!rows || rows.length === 0) {
    return (
      <EmptyState
        title="No resume usage yet"
        description="Once applications go out with a resume attached, per-resume outcomes appear here."
      />
    );
  }

  return (
    <TableWrapper>
      <Table>
        <THead>
          <TR>
            <TH>Resume</TH>
            <TH className="text-right">Used</TH>
            <TH className="text-right">Submitted</TH>
            <TH className="text-right">Interviews</TH>
            <TH className="w-48">Success rate</TH>
          </TR>
        </THead>
        <TBody>
          {rows.map((row) => (
            <TR key={row.resumeId}>
              <TD className="font-medium">{row.name}</TD>
              <TD className="tabular text-right">{formatNumber(row.used)}</TD>
              <TD className="tabular text-right">{formatNumber(row.submitted)}</TD>
              <TD className="tabular text-right">{formatNumber(row.interviews)}</TD>
              <TD>
                <div className="flex items-center gap-2">
                  <Progress
                    value={row.successRate}
                    tone={successTone(row.successRate)}
                    className="flex-1"
                  />
                  <span className="tabular w-12 shrink-0 text-right text-xs text-muted-foreground">
                    {formatPercent(row.successRate)}
                  </span>
                </div>
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </TableWrapper>
  );
}

/* -------------------------------------------------------------------------- */
/* Derivations                                                                 */
/* -------------------------------------------------------------------------- */

/** Averages a series over the selected window, not just the days that reported data. */
function averagePerDay(points: TimeSeriesPoint[] | undefined, days: number): number | null {
  if (!points || points.length === 0) return null;
  const total = points.reduce((sum, point) => sum + point.value, 0);
  const divisor = Math.max(1, days);
  return total / divisor;
}

function hasPoints(points: TimeSeriesPoint[] | undefined): boolean {
  return Boolean(points && points.some((point) => point.value !== 0));
}

function hasCounts(counts: CountByLabel[] | undefined): boolean {
  return Boolean(counts && counts.length > 0);
}

function topN(counts: CountByLabel[] | undefined, limit: number): CountByLabel[] {
  if (!counts) return [];
  return [...counts].sort((a, b) => b.count - a.count).slice(0, limit);
}

function formatAverage(value: number | null): string {
  if (value === null) return '—';
  return value >= 10 ? value.toFixed(0) : value.toFixed(1);
}

function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return `${Math.round(value)}%`;
}

function successTone(rate: number): 'default' | 'success' | 'warning' | 'destructive' {
  if (rate >= 60) return 'success';
  if (rate >= 25) return 'warning';
  return 'destructive';
}
