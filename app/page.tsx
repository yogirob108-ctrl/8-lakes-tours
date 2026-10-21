import HomePageClient from './HomePageClient';
import { getVisibleTourDates, TOUR_DATES } from '../lib/tour-dates.mjs';
import { isPriceHoldActive } from '../lib/price-hold.mjs';

export const revalidate = 3600;

export default function HomePage() {
  const tourDates = getVisibleTourDates(TOUR_DATES);
  // Recomputed on each hourly revalidation, so the hold message drops off on its own.
  return <HomePageClient tourDates={tourDates} priceHoldActive={isPriceHoldActive()} />;
}
