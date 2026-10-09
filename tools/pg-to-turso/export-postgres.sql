-- Builds the SELECT list for one PostgreSQL table, converting each column to the
-- representation the Turso schema stores. Used by export-postgres.sh.
--   :'table_name'  the table to describe (psql variable, passed with -v)
-- Output: one line, e.g.  id, is_active::int as is_active, to_char(...) as created_at
select string_agg(
  case
    when data_type = 'boolean'
      then quote_ident(column_name) || '::int'
    when data_type = 'timestamp with time zone'
      then 'to_char(' || quote_ident(column_name) || ' at time zone ''UTC'', ''YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'')'
    when data_type = 'date'
      then 'to_char(' || quote_ident(column_name) || ', ''YYYY-MM-DD'')'
    when data_type = 'bytea'
      then 'encode(' || quote_ident(column_name) || ', ''hex'')'
    when data_type = 'inet'
      then 'host(' || quote_ident(column_name) || ')'
    when data_type in ('uuid', 'jsonb', 'json', 'numeric')
      then quote_ident(column_name) || '::text'
    else quote_ident(column_name)
  end || ' as ' || quote_ident(column_name),
  ', ' order by ordinal_position)
from information_schema.columns
where table_schema = 'public' and table_name = :'table_name';
