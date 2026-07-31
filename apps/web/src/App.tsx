import { Navigate, Route, Routes } from 'react-router-dom';
import { Shell } from '@/components/layout/Shell';
import { useLiveEvents } from '@/lib/events';
import OverviewPage from '@/pages/Overview';
import JobsPage from '@/pages/Jobs';
import JobDetailPage from '@/pages/JobDetail';
import ApplicationsPage from '@/pages/Applications';
import ApplicationDetailPage from '@/pages/ApplicationDetail';
import ResumesPage from '@/pages/Resumes';
import CoverLettersPage from '@/pages/CoverLetters';
import QueuePage from '@/pages/Queue';
import BrowserSessionsPage from '@/pages/BrowserSessions';
import LlmActivityPage from '@/pages/LlmActivity';
import LogsPage from '@/pages/Logs';
import NotificationsPage from '@/pages/Notifications';
import AnalyticsPage from '@/pages/Analytics';
import SettingsPage from '@/pages/Settings';

export default function App(): JSX.Element {
  // Mounted once at the root so every page benefits from live invalidation.
  useLiveEvents();

  return (
    <Shell>
      <Routes>
        <Route path="/" element={<OverviewPage />} />
        <Route path="/jobs" element={<JobsPage />} />
        <Route path="/jobs/:id" element={<JobDetailPage />} />
        <Route path="/applications" element={<ApplicationsPage />} />
        <Route path="/applications/:id" element={<ApplicationDetailPage />} />
        <Route path="/resumes" element={<ResumesPage />} />
        <Route path="/cover-letters" element={<CoverLettersPage />} />
        <Route path="/queue" element={<QueuePage />} />
        <Route path="/browser" element={<BrowserSessionsPage />} />
        <Route path="/llm" element={<LlmActivityPage />} />
        <Route path="/logs" element={<LogsPage />} />
        <Route path="/notifications" element={<NotificationsPage />} />
        <Route path="/analytics" element={<AnalyticsPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Shell>
  );
}
