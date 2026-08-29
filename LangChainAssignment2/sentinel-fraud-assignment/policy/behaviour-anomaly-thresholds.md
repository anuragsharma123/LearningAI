# Behaviour Anomaly Thresholds

Editable by fraud ops. Behaviour loads this on demand when it needs to classify
how anomalous a transaction or burst is, relative to the account's own baseline.

## Amount thresholds (relative to the account's baseline p90)

- **Above 20x baseline p90**: CLEAR anomaly on its own.
- **Between 5x and 20x baseline p90**: MODERATE anomaly -- worth noting, not
  decisive by itself.
- **Below 5x baseline p90**: NORMAL variation, even if it happens to be the
  largest transaction the account has made in months.

## Device compounding rule

A transaction from a device NOT in the baseline's `knownDeviceIds`, combined
with a MODERATE or CLEAR amount anomaly, should be treated as CLEAR overall --
new-device-plus-elevated-amount is a materially stronger signal than either
alone.

## Night-time compounding rule

Activity between 00:00 and 05:59, when the baseline's `nightTxnFraction` is
under 5%, raises a MODERATE amount anomaly to CLEAR.
