import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { settingsService, type SettingItem } from '@/services/settings.service';
import { errorMessage } from '@/services/api';
import { useToast } from '@/hooks/useToast';
import { Alert, Field, Input, Loading, Spinner } from '@/components/ui';

export default function Settings() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: ['settings'], queryFn: settingsService.list });
  const [values, setValues] = useState<Record<string, string>>({});

  useEffect(() => {
    if (data) {
      setValues(Object.fromEntries(data.map((setting) => [setting.key, setting.value])));
    }
  }, [data]);

  const mutation = useMutation({
    mutationFn: () => settingsService.update(values),
    onSuccess: async () => {
      toast.success('Settings saved');
      await queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  if (isLoading) return <Loading label="Loading settings…" />;
  if (error || !data) return <Alert kind="error">{errorMessage(error)}</Alert>;

  const renderField = (setting: SettingItem) => (
    <Field key={setting.key} label={setting.label} hint={`${setting.description}${setting.isOverridden ? '' : ` (default: ${setting.defaultValue})`}`}>
      <Input
        type={setting.type === 'number' ? 'number' : 'text'}
        min={setting.min}
        max={setting.max}
        value={values[setting.key] ?? ''}
        onChange={(event) => setValues((current) => ({ ...current, [setting.key]: event.target.value }))}
        className="max-w-md"
      />
    </Field>
  );

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-semibold text-slate-900">Settings</h1>
        <p className="text-sm text-slate-500">Operational defaults. Changes are audited and take effect immediately.</p>
      </div>

      <div className="card">
        <div className="card-body space-y-5">
          {data.map(renderField)}
          <div className="flex items-center gap-2">
            <button type="button" className="btn-primary" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
              {mutation.isPending ? <Spinner className="h-4 w-4" /> : null}
              Save settings
            </button>
            <button type="button" className="btn-secondary" onClick={() => setValues(Object.fromEntries(data.map((setting) => [setting.key, setting.value])))}>
              Reset changes
            </button>
          </div>
        </div>
      </div>

      <Alert kind="info">
        Environment variables remain the fallback for these values, so clearing a row (or a fresh install) still works with sensible defaults.
      </Alert>
    </div>
  );
}
