import { jobsApi } from '../../services/endpoints.js';
import { useApi } from '../../hooks/useApi.js';
import { useToast } from '../../context/ToastContext.jsx';
import { Alert, Badge, Button, Card, Spinner, Table } from '../../components/ui.jsx';
import { formatDateTime } from '../../utils/format.js';

export function SystemStatus() {
  const toast = useToast();
  const { data, loading, error, reload } = useApi(() => jobsApi.status(), []);

  const run = async (name) => {
    try {
      const result = await jobsApi.run(name);
      toast.success(result?.ok === false ? `Job reported: ${result.error}` : `Ran ${name}`);
      reload();
    } catch (err) {
      toast.error(err.message);
    }
  };

  if (loading && !data) return <Spinner />;

  return (
    <>
      <div className="inline" style={{ marginBottom: 14 }}>
        <h1 style={{ margin: 0 }}>System & jobs</h1>
        <Badge status={data?.enabled ? 'ACTIVE' : 'INACTIVE'} label={data?.enabled ? 'scheduler on' : 'scheduler off'} />
        <div className="spacer" />
        <Button className="sm" onClick={reload}>
          ⟳ Refresh
        </Button>
      </div>

      <Alert tone="error">{error?.message}</Alert>
      <Alert tone="info">
        Jobs run inside this Node process (setInterval + Asia/Dhaka date logic) - no cron, no queue. Each run is keyed
        (job + Dhaka date or window) and recorded in <code>job_runs</code>, so a restart catches up without duplicating work.
      </Alert>

      <Card title="Scheduled jobs">
        <Table
          rows={data?.jobs ?? []}
          keyField="name"
          empty="No jobs registered (JOBS_ENABLED=false)."
          columns={[
            { key: 'name', header: 'Job', mono: true },
            { key: 'description', header: 'What it does' },
            {
              key: 'schedule',
              header: 'Schedule',
              render: (row) => (row.schedule.type === 'daily' ? `daily @ ${row.schedule.at} (Asia/Dhaka)` : `every ${row.schedule.everyMinutes} min`),
            },
            { key: 'runKey', header: 'Current run key', mono: true },
            {
              key: 'actions',
              header: '',
              align: 'right',
              render: (row) => (
                <Button className="sm" onClick={() => run(row.name)}>
                  Run now
                </Button>
              ),
            },
          ]}
        />
        <p className="muted small" style={{ marginTop: 10, marginBottom: 0 }}>
          Last tick: {data?.lastTick?.at ? `${formatDateTime(data.lastTick.at)} (Dhaka ${data.lastTick.dhakaDate} ${String(Math.floor((data.lastTick.minutes ?? 0) / 60)).padStart(2, '0')}:${String((data.lastTick.minutes ?? 0) % 60).padStart(2, '0')})` : '—'}
          {data?.running?.length ? ` · running: ${data.running.join(', ')}` : ''}
        </p>
      </Card>

      <Card title="Recent runs">
        <Table
          rows={data?.recentRuns ?? []}
          keyField={(row) => `${row.job_name}-${row.run_key}-${row.started_at}`}
          empty="No runs recorded yet."
          columns={[
            { key: 'job_name', header: 'Job', mono: true },
            { key: 'run_key', header: 'Run key', mono: true },
            { key: 'status', header: 'Status', render: (row) => <Badge status={row.status === 'SUCCESS' ? 'SUCCESS' : row.status === 'FAILED' ? 'FAILED' : 'PENDING'} label={row.status} /> },
            { key: 'started_at', header: 'Started', render: (row) => formatDateTime(row.started_at) },
            { key: 'duration_ms', header: 'Duration', align: 'right', render: (row) => (row.duration_ms ? `${row.duration_ms} ms` : '—') },
            { key: 'items_processed', header: 'Items', align: 'right' },
            { key: 'error', header: 'Error', render: (row) => (row.error ? <span style={{ color: 'var(--danger)' }} className="small">{row.error}</span> : '—') },
          ]}
        />
      </Card>
    </>
  );
}
