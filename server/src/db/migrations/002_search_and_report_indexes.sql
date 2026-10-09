-- 002_search_and_report_indexes.sql
-- Extra indexes and text-search helpers used by list/report queries.

-- Trigram-less fuzzy search: a normalised lowercase search column keeps the
-- name search index-friendly without the pg_trgm extension.
alter table investors add column if not exists search_text text;

update investors
   set search_text = lower(name || ' ' || mobile || ' ' || coalesce(address, ''))
 where search_text is null;

create or replace function investors_refresh_search_text() returns trigger
language plpgsql as $$
begin
  new.search_text := lower(new.name || ' ' || new.mobile || ' ' || coalesce(new.address, ''));
  return new;
end;
$$;

create trigger investors_search_text
  before insert or update of name, mobile, address on investors
  for each row execute function investors_refresh_search_text();

create index if not exists investors_search_text_idx on investors (search_text);

-- Dashboard / report access paths
create index if not exists installments_due_status_due_date_idx
  on installments (due_date, status);
create index if not exists payments_success_created_idx
  on payments (created_at desc) where status = 'SUCCESS';
create index if not exists payments_gateway_payment_idx on payments (gateway, gateway_payment_id);
create index if not exists investments_active_idx on investments (id) where status = 'ACTIVE';
