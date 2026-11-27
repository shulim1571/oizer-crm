-- AppSheet gap review (2026-11-19): confirm Donary's collector is still stored on incoming gifts. The Make feed keeps
-- it (collector_label); the direct Donary webhook didn't. It's kept now on both, for history (collectors aren't shown
-- on screens, per Moshe). Nothing else about the gift changes.
do $$
declare v_def text; v_new text;
begin
  select pg_get_functiondef('public.donary_record_charge'::regproc) into v_def;
  v_new := replace(v_def,
    $s$                                name, anonymous, notes, created_at, created_by)$s$,
    $s$                                name, anonymous, notes, created_at, created_by, collector_label)$s$);
  if v_new = v_def then raise exception 'donary_record_charge: column list not found'; end if;
  v_def := v_new;
  -- The values list ends with created_by; add the collector's name after it.
  v_new := regexp_replace(v_def, $r$(insert into public\.donations \(.*?collector_label\)\s+values \(.*?)\)\s*returning$r$,
                          $r$\1, nullif(trim(coalesce(public.dobj(p, 'collectorInfo') ->> 'collectorName', '')), '')) returning$r$, 's');
  if v_new = v_def then raise exception 'donary_record_charge: values list not found'; end if;
  execute v_new;
end $$;
