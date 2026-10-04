import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { investorService } from '@/services/investor.service';
import { errorMessage } from '@/services/api';
import { useAuth } from '@/hooks/useAuth';
import { useDebounce } from '@/hooks/useDebounce';
import { formatDate } from '@/lib/format';
import { Alert, EmptyState, Field, Input, Loading, Modal, Pagination, Select, Spinner, StatusBadge } from '@/components/ui';
import { useToast } from '@/hooks/useToast';

const schema = z.object({
  name: z.string().min(3, 'Full name is required').max(120),
  mobile: z
    .string()
    .trim()
    .regex(/^(01[3-9]\d{8}|\+?8801[3-9]\d{8})$/, 'Enter a valid Bangladeshi mobile (e.g. 01712345678)'),
  nid: z
    .string()
    .trim()
    .regex(/^\d{10,17}$/, 'NID must be 10 to 17 digits')
    .optional()
    .or(z.literal('')),
  address: z.string().max(300).optional(),
});
type FormValues = z.infer<typeof schema>;

export default function InvestorsList() {
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { canWrite } = useAuth();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [sort, setSort] = useState('createdAt:desc');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState(false);
  const debouncedSearch = useDebounce(search);

  const params = useMemo(
    () => ({ search: debouncedSearch || undefined, status: status || undefined, sort, page, pageSize: 20 }),
    [debouncedSearch, status, sort, page],
  );

  const { data, isLoading, error } = useQuery({ queryKey: ['investors', params], queryFn: () => investorService.list(params) });

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(schema) });

  const createMutation = useMutation({
    mutationFn: (values: FormValues) =>
      investorService.create({
        name: values.name,
        mobile: values.mobile,
        address: values.address ?? null,
        nid: values.nid ? values.nid : null,
      }),
    onSuccess: async (investor) => {
      toast.success('Investor created');
      await queryClient.invalidateQueries({ queryKey: ['investors'] });
      setOpen(false);
      reset();
      navigate(`/investors/${investor.id}`);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">Investors</h1>
          <p className="text-sm text-slate-500">Search, create and manage investor profiles.</p>
        </div>
        {canWrite ? (
          <button type="button" className="btn-primary" onClick={() => setOpen(true)}>
            + New investor
          </button>
        ) : null}
      </div>

      <div className="card">
        <div className="card-header flex-wrap gap-2">
          <input
            className="input max-w-xs"
            placeholder="Search name, mobile or NID…"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
          />
          <div className="flex items-center gap-2">
            <Select
              value={status}
              onChange={(event) => {
                setStatus(event.target.value);
                setPage(1);
              }}
              className="w-36"
            >
              <option value="">All statuses</option>
              <option value="ACTIVE">Active</option>
              <option value="INACTIVE">Inactive</option>
            </Select>
            <Select value={sort} onChange={(event) => setSort(event.target.value)} className="w-44">
              <option value="createdAt:desc">Newest first</option>
              <option value="createdAt:asc">Oldest first</option>
              <option value="name:asc">Name A→Z</option>
              <option value="name:desc">Name Z→A</option>
            </Select>
          </div>
        </div>

        {isLoading ? (
          <Loading label="Loading investors…" />
        ) : error ? (
          <div className="p-4">
            <Alert kind="error">{errorMessage(error)}</Alert>
          </div>
        ) : data && data.items.length === 0 ? (
          <EmptyState title="No investors found" description="Adjust the filters or create the first investor." />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-slate-100">
                <thead className="bg-slate-50">
                  <tr>
                    <th className="th">Name</th>
                    <th className="th">Mobile</th>
                    <th className="th">NID</th>
                    <th className="th">Investments</th>
                    <th className="th">Nominees</th>
                    <th className="th">Status</th>
                    <th className="th">Created</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data?.items.map((investor) => (
                    <tr key={investor.id} className="hover:bg-slate-50">
                      <td className="td">
                        <Link to={`/investors/${investor.id}`} className="link font-medium">
                          {investor.name}
                        </Link>
                      </td>
                      <td className="td">{investor.mobile}</td>
                      <td className="td">{investor.nid ? investor.nid : investor.hasNid ? '•••• (masked)' : '—'}</td>
                      <td className="td">{investor.investmentCount}</td>
                      <td className="td">{investor.nomineeCount}/3</td>
                      <td className="td">
                        <StatusBadge status={investor.status} />
                      </td>
                      <td className="td">{formatDate(investor.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {data ? <Pagination page={data.page} totalPages={data.totalPages} total={data.total} onChange={setPage} /> : null}
          </>
        )}
      </div>

      <Modal
        open={open}
        title="New investor"
        onClose={() => setOpen(false)}
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button type="submit" form="investor-form" className="btn-primary" disabled={isSubmitting || createMutation.isPending}>
              {createMutation.isPending ? <Spinner className="h-4 w-4" /> : null}
              Create investor
            </button>
          </>
        }
      >
        <form id="investor-form" className="space-y-4" onSubmit={handleSubmit((values) => createMutation.mutate(values))}>
          <Field label="Full name" error={errors.name?.message}>
            <Input placeholder="Md. Rahim Uddin" {...register('name')} />
          </Field>
          <Field label="Mobile number" error={errors.mobile?.message} hint="Used for payment links and reminders (bKash: 01XXXXXXXXX)">
            <Input placeholder="01712345678" {...register('mobile')} />
          </Field>
          <Field label="NID number (optional)" error={errors.nid?.message} hint="Encrypted at rest (AES-256-GCM); only super admins can view it">
            <Input placeholder="1990123456789" {...register('nid')} />
          </Field>
          <Field label="Address (optional)" error={errors.address?.message}>
            <Input placeholder="House, road, city" {...register('address')} />
          </Field>
        </form>
      </Modal>
    </div>
  );
}
