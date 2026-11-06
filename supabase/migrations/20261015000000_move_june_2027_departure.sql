-- The June 1 – 9, 2027 departure moves to June 5 – 13, 2027 (decided 2026-10-15).
-- The old row is unpublished rather than deleted or re-dated, so any booking
-- already linked to it keeps its departure and capacity allocation. The new row
-- copies the old row's capacity enforcement so it is guarded the same way.
insert into public.departures(project_id,label,start_date,end_date,capacity_enforced)
select p.id,'June 5 – 13, 2027',date '2027-06-05',date '2027-06-13',coalesce(old.capacity_enforced,false)
from public.tour_projects p
left join public.departures old on old.project_id=p.id and old.label='June 1 – 9, 2027'
where p.slug='8-lakes-tours'
on conflict(project_id,label) do nothing;

update public.departures d set published=false
from public.tour_projects p
where d.project_id=p.id and p.slug='8-lakes-tours' and d.label='June 1 – 9, 2027';
