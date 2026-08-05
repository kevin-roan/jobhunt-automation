import { sql, type SQL } from 'drizzle-orm';
import type { AnalyticsPayload, CountByLabel, OverviewStats, TimeSeriesPoint } from '@deedy/shared';
import type { Db } from '../db/client.js';
import { percent } from '../core/utils.js';

interface LabelCountRow {
  label: string | null;
  count: number;
}
interface SeriesRow {
  date: string;
  value: number;
}
interface SourceJobRow {
  source: string;
  totalJobs: number;
  jobsToday: number;
  scoredJobs: number;
  averageScore: number | null;
}
interface SourceApplicationRow {
  source: string;
  applications: number;
}

export interface SourceJobStats {
  totalJobs: number;
  jobsToday: number;
  scoredJobs: number;
  averageScore: number | null;
  applications: number;
}

/**
 * All analytics are computed from the durable tables on demand — there is no
 * derived cache to drift or to rebuild after a restart.
 */
export class AnalyticsRepository {
  constructor(private readonly db: Db) {}

  private labelCounts(query: SQL): CountByLabel[] {
    return this.db
      .all<LabelCountRow>(query)
      .map((row) => ({ label: row.label ?? 'unknown', count: Number(row.count) }));
  }

  private series(query: SQL): TimeSeriesPoint[] {
    return this.db
      .all<SeriesRow>(query)
      .map((row) => ({ date: row.date, value: Number(row.value) }));
  }

  overview(): OverviewStats {
    const today = new Date().toISOString().slice(0, 10);

    const jobStats = this.db.get<{
      total: number;
      newJobs: number;
      scored: number;
      avgScore: number | null;
      today: number;
    }>(sql`
      SELECT
        count(*) AS total,
        sum(CASE WHEN status = 'new' THEN 1 ELSE 0 END) AS newJobs,
        sum(CASE WHEN score IS NOT NULL THEN 1 ELSE 0 END) AS scored,
        avg(score) AS avgScore,
        sum(CASE WHEN substr(collected_at, 1, 10) = ${today} THEN 1 ELSE 0 END) AS today
      FROM jobs WHERE archived = 0
    `);

    const appStats = this.db.get<{
      total: number;
      submitted: number;
      failed: number;
      needsHuman: number;
      interview: number;
      offer: number;
      rejected: number;
      today: number;
    }>(sql`
      SELECT
        count(*) AS total,
        sum(CASE WHEN status = 'submitted' THEN 1 ELSE 0 END) AS submitted,
        sum(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
        sum(CASE WHEN status = 'needs_human' THEN 1 ELSE 0 END) AS needsHuman,
        sum(CASE WHEN status = 'interview' THEN 1 ELSE 0 END) AS interview,
        sum(CASE WHEN status = 'offer' THEN 1 ELSE 0 END) AS offer,
        sum(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected,
        sum(CASE WHEN substr(created_at, 1, 10) = ${today} THEN 1 ELSE 0 END) AS today
      FROM applications
    `);

    const queueStats = this.db.get<{ pending: number; active: number; failed: number }>(sql`
      SELECT
        sum(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
        sum(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
        sum(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
      FROM queue_jobs
    `);

    const llmStats = this.db.get<{ calls: number; tokens: number }>(sql`
      SELECT count(*) AS calls, coalesce(sum(total_tokens), 0) AS tokens FROM llm_calls
    `);

    const totalApps = Number(appStats?.total ?? 0);
    const submitted = Number(appStats?.submitted ?? 0);
    const failed = Number(appStats?.failed ?? 0);
    const interview = Number(appStats?.interview ?? 0);
    const offer = Number(appStats?.offer ?? 0);
    const rejected = Number(appStats?.rejected ?? 0);

    return {
      totalJobs: Number(jobStats?.total ?? 0),
      newJobs: Number(jobStats?.newJobs ?? 0),
      scoredJobs: Number(jobStats?.scored ?? 0),
      totalApplications: totalApps,
      submittedApplications: submitted,
      failedApplications: failed,
      needsHuman: Number(appStats?.needsHuman ?? 0),
      interviews: interview,
      offers: offer,
      rejections: rejected,
      averageScore: Math.round((jobStats?.avgScore ?? 0) * 10) / 10,
      successRate: percent(submitted, totalApps),
      failureRate: percent(failed, totalApps),
      responseRate: percent(interview + offer + rejected, submitted),
      interviewRate: percent(interview + offer, submitted),
      applicationsToday: Number(appStats?.today ?? 0),
      jobsToday: Number(jobStats?.today ?? 0),
      queuePending: Number(queueStats?.pending ?? 0),
      queueActive: Number(queueStats?.active ?? 0),
      queueFailed: Number(queueStats?.failed ?? 0),
      llmTokensTotal: Number(llmStats?.tokens ?? 0),
      llmCallsTotal: Number(llmStats?.calls ?? 0),
    };
  }

  /**
   * Per-source job counts, scored counts and mean score, for the sources
   * dashboard. Two grouped queries rather than one pair per source: the
   * registry can hold a dozen collectors and plugins add more.
   */
  perSourceJobStats(): Map<string, SourceJobStats> {
    const today = new Date().toISOString().slice(0, 10);

    const jobRows = this.db.all<SourceJobRow>(sql`
      SELECT
        source AS source,
        count(*) AS totalJobs,
        sum(CASE WHEN substr(collected_at, 1, 10) = ${today} THEN 1 ELSE 0 END) AS jobsToday,
        sum(CASE WHEN score IS NOT NULL THEN 1 ELSE 0 END) AS scoredJobs,
        avg(score) AS averageScore
      FROM jobs WHERE archived = 0
      GROUP BY source
    `);

    // Applications are counted regardless of `archived`: archiving the job does
    // not un-send the application, and the tile reports what the source produced.
    const applicationRows = this.db.all<SourceApplicationRow>(sql`
      SELECT j.source AS source, count(*) AS applications
      FROM applications a
      INNER JOIN jobs j ON j.id = a.job_id
      GROUP BY j.source
    `);

    const stats = new Map<string, SourceJobStats>();
    for (const row of jobRows) {
      const average = row.averageScore;
      stats.set(row.source, {
        totalJobs: Number(row.totalJobs),
        jobsToday: Number(row.jobsToday),
        scoredJobs: Number(row.scoredJobs),
        averageScore: average === null ? null : Math.round(Number(average) * 10) / 10,
        applications: 0,
      });
    }
    for (const row of applicationRows) {
      const existing = stats.get(row.source);
      if (existing) {
        existing.applications = Number(row.applications);
        continue;
      }
      // A source whose jobs are all archived still has applications to report.
      stats.set(row.source, {
        totalJobs: 0,
        jobsToday: 0,
        scoredJobs: 0,
        averageScore: null,
        applications: Number(row.applications),
      });
    }
    return stats;
  }

  full(days: number): AnalyticsPayload {
    const since = new Date(Date.now() - days * 86400000).toISOString();

    const applicationsPerDay = this.series(sql`
      SELECT substr(created_at, 1, 10) AS date, count(*) AS value
      FROM applications WHERE created_at >= ${since}
      GROUP BY date ORDER BY date
    `);

    const jobsPerDay = this.series(sql`
      SELECT substr(collected_at, 1, 10) AS date, count(*) AS value
      FROM jobs WHERE collected_at >= ${since}
      GROUP BY date ORDER BY date
    `);

    const averageScorePerDay = this.series(sql`
      SELECT substr(created_at, 1, 10) AS date, round(avg(score), 1) AS value
      FROM job_scores WHERE created_at >= ${since}
      GROUP BY date ORDER BY date
    `);

    const tokensPerDay = this.series(sql`
      SELECT substr(created_at, 1, 10) AS date, coalesce(sum(total_tokens), 0) AS value
      FROM llm_calls WHERE created_at >= ${since}
      GROUP BY date ORDER BY date
    `);

    const sourceDistribution = this.labelCounts(sql`
      SELECT source AS label, count(*) AS count FROM jobs WHERE archived = 0
      GROUP BY source ORDER BY count DESC
    `);

    const topCompanies = this.labelCounts(sql`
      SELECT company AS label, count(*) AS count FROM jobs WHERE archived = 0
      GROUP BY company ORDER BY count DESC LIMIT 15
    `);

    const topSkills = this.labelCounts(sql`
      SELECT skill AS label, count(*) AS count FROM job_skills
      GROUP BY normalized ORDER BY count DESC LIMIT 20
    `);

    const locationDemand = this.labelCounts(sql`
      SELECT coalesce(nullif(trim(location), ''), 'Unspecified') AS label, count(*) AS count
      FROM jobs WHERE archived = 0
      GROUP BY label ORDER BY count DESC LIMIT 15
    `);

    const statusBreakdown = this.labelCounts(sql`
      SELECT status AS label, count(*) AS count FROM applications GROUP BY status ORDER BY count DESC
    `);

    const scoreHistogram = this.labelCounts(sql`
      SELECT
        CASE
          WHEN score < 20 THEN '0-19'
          WHEN score < 40 THEN '20-39'
          WHEN score < 60 THEN '40-59'
          WHEN score < 80 THEN '60-79'
          ELSE '80-100'
        END AS label,
        count(*) AS count
      FROM jobs WHERE score IS NOT NULL
      GROUP BY label ORDER BY label
    `);

    const funnelRow = this.db.get<{
      collected: number;
      scored: number;
      recommended: number;
      started: number;
      submitted: number;
      interview: number;
      offer: number;
    }>(sql`
      SELECT
        (SELECT count(*) FROM jobs) AS collected,
        (SELECT count(*) FROM jobs WHERE score IS NOT NULL) AS scored,
        (SELECT count(*) FROM jobs WHERE recommendation = 'apply') AS recommended,
        (SELECT count(*) FROM applications) AS started,
        (SELECT count(*) FROM applications WHERE status = 'submitted') AS submitted,
        (SELECT count(*) FROM applications WHERE status = 'interview') AS interview,
        (SELECT count(*) FROM applications WHERE status = 'offer') AS offer
    `);

    const funnel: CountByLabel[] = [
      { label: 'Collected', count: Number(funnelRow?.collected ?? 0) },
      { label: 'Scored', count: Number(funnelRow?.scored ?? 0) },
      { label: 'Recommended', count: Number(funnelRow?.recommended ?? 0) },
      { label: 'Started', count: Number(funnelRow?.started ?? 0) },
      { label: 'Submitted', count: Number(funnelRow?.submitted ?? 0) },
      { label: 'Interview', count: Number(funnelRow?.interview ?? 0) },
      { label: 'Offer', count: Number(funnelRow?.offer ?? 0) },
    ];

    const resumeRows = this.db.all<{
      resumeId: number;
      name: string;
      used: number;
      submitted: number;
      interviews: number;
    }>(sql`
      SELECT r.id AS resumeId, r.name AS name,
        count(a.id) AS used,
        sum(CASE WHEN a.status = 'submitted' THEN 1 ELSE 0 END) AS submitted,
        sum(CASE WHEN a.status IN ('interview','offer') THEN 1 ELSE 0 END) AS interviews
      FROM resumes r
      INNER JOIN applications a ON a.resume_id = r.id
      GROUP BY r.id ORDER BY used DESC LIMIT 20
    `);

    return {
      overview: this.overview(),
      applicationsPerDay,
      jobsPerDay,
      averageScorePerDay,
      tokensPerDay,
      funnel,
      sourceDistribution,
      topCompanies,
      topSkills,
      locationDemand,
      scoreHistogram,
      statusBreakdown,
      resumeEffectiveness: resumeRows.map((row) => ({
        resumeId: row.resumeId,
        name: row.name,
        used: Number(row.used),
        submitted: Number(row.submitted),
        interviews: Number(row.interviews),
        successRate: percent(Number(row.submitted), Number(row.used)),
      })),
    };
  }
}
