export function monthlyRate(annualPercent) {
  return annualPercent / 12;
}

export function projectBalance(principalCents, annualPercent, months) {
  let balance = principalCents;
  const rate = monthlyRate(annualPercent);
  for (let i = 0; i < months; i += 1) {
    balance = Math.round(balance * (1 + rate));
  }
  return balance;
}
