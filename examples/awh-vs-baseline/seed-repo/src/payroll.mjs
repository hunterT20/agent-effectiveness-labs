export function grossPayCents(hourlyRateCents, hours) {
  const regular = Math.min(hours, 40);
  const overtime = Math.max(hours - 40, 0);
  return Math.round(regular * hourlyRateCents + overtime * hourlyRateCents * 1.5);
}

export function withholdingCents(grossCents, percent) {
  return Math.round(grossCents * percent);
}
