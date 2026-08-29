# Worked cases

Three accounts, run through the full system exactly as the sweep runs them
(fresh, isolated specialist calls, then Disposition, on Claude Haiku 4.5).
Chosen to show the three verdicts: obvious fraud, a convincing false
positive, and a case the system honestly could not resolve.

One of these (A00985) is also the case that caught a real quality issue
during development: on first testing, Haiku's Context specialist conflated
"the new device is explained" with "the transaction is explained" and called
this case `legitimate`. The system prompt was tightened to explicitly treat
those as two separate claims a device-upgrade note does not automatically
cover both of, and the case below reflects the corrected, verified output.
See `WRITEUP.md` for the full account of that regression.

---

## A00513 -- `fraud`, high confidence, `escalate_case`

**Alerts:** four open alerts, all high severity -- `AL0029`/`AL0030` (rule R05
"High risk merchant burst" + R07 "Night time high value", triggered
2026-02-27T02:19:57), `AL0403` (R05, 2026-02-27T08:50:06), `AL0402` (R05,
2026-03-01T03:11:46).

### Behaviour -- `anomalous`

Six transactions between 2026-02-27T02:19:57 and 2026-03-01T03:11:46, each
$47,908-$119,933 -- 96x to 241x the account's baseline p90 of $498.69 (median
$70.76 over prior history). Four of the six land inside the account's
00:00-05:59 night window, where the baseline shows **zero** prior night
activity. Two transactions (`T0107966`, `T0107965`) used devices `DR002` and
`DR001`, neither in the account's known device list -- new-device-plus-high-
amount, which the loaded anomaly-threshold policy treats as a CLEAR anomaly
outright, independent of the amount alone.

### Context -- `unexplained`

The only note on file (`N00017`, 2026-02-28) is not exculpatory -- it's
incriminating. It records the customer as *"evasive when asked about the
source of the incoming transfers"* and claiming *"a friend asked them to
receive money and forward it on"* -- a money-mule narrative, logged by staff
as high risk. No disputes were filed against any of the flagged transactions.
A prior case (`PC0082`, October 2025) shows this account was previously
compromised by card fraud -- prior victimhood, not an explanation for the
current pattern.

### Network -- `linked`

Two devices, shared with **six** other customers total: `DR001` with
`C00638`, `C00619`, `C00594`, `C01039`; `DR002` with `C00779`, `C00925` --
both windows open from 2026-01-21 through the flagged activity. Only 16 of
1,520 devices bank-wide are ever shared at all. The same transactions also
show 14-27 other accounts coincidentally active at the same high-risk
money-transfer merchants (risk score 0.75-0.88) within a 48-hour window of
each transaction -- for comparison, an ordinary low-risk merchant in the same
account's history showed single-digit coincidence.

### Disposition

**Verdict: `fraud`, confidence `high`.** All three specialists converge:
anomalous behaviour, no legitimate explanation (an evasive statement, not an
alibi), and hard network linkage to a six-account cluster via shared devices
and coincident high-risk merchant timing.

**Recommended action: `escalate_case`**, not `block_card` -- per the loaded
escalation policy, `block_card` requires the exposure to be *current* (within
48 hours of the flagged burst) with nothing suggesting it has stopped. The
most recent transaction was several days before this run, and the case is
fundamentally a multi-account pattern that needs a human to map the wider
ring rather than a single-account block resolving it.

---

## A00090 -- `legitimate`, high confidence, `none`

**Alerts:** `AL0341` (R02 "New device high value") and `AL0342` (R07 "Night
time high value"), both triggered 2026-02-27T01:22:02 on transaction
`T0107809`, $79,760.34.

### Behaviour -- `anomalous`

The single flagged transaction is 255x the account's baseline p90 ($312.74),
at 01:22 local against a baseline night-transaction fraction of 1.7% -- both
individually clear the CLEAR-anomaly bar in the loaded policy. Taken purely
on the numbers, this looks like a textbook takeover.

### Context -- `explained`

Note `N00205`, logged the *previous afternoon* (2026-02-26T15:22:02) during
an in-branch visit, records the customer telling staff in person that they
intended to buy wedding jewellery worth approximately $79,760 that week --
and staff explicitly warned them the purchase might trigger a fraud alert and
to keep their phone available for OTP. The amount and timing match the
flagged transaction almost exactly.

### Network -- `isolated`

The account's one device (`D000900`) has an empty `sharedWith` list -- no
cross-customer link. The trigger transaction shows 9 coincident other
accounts at the merchant, but it's a jewellery merchant with risk score 0.04
-- unremarkable overlap at an ordinary retailer, not a signal.

### Disposition

**Verdict: `legitimate`, confidence `high`.** The supervisor's synthesis:
*"the combination of prior disclosure, exact amount match, known exclusive
device, and proactive staff coordination strongly indicates legitimate,
anticipated activity."* Device `D000900` is the same one used across the
account's history -- R02 fired on amount and timing, not on an actual new
device; the real signal was a large, pre-announced, staff-witnessed purchase.

**Recommended action: `none`.**

This is the pair the assignment brief is built around: identical rule
signature to a takeover (new-device-flavoured high-value alert, night-time
window), resolved in opposite directions purely by what staff wrote down.

---

## A00985 -- `insufficient_evidence`, medium confidence, `escalate_case`

**Alerts:** `AL0170` (R02 "New device high value", triggered
2026-02-27T12:46:44, trigger transaction `T0107306`).

### Behaviour -- `anomalous`

Four transactions in a 3-hour window (`T0107303`-`T0107306`,
12:46-15:46) totalling $216,091.17, each 80x-144x the baseline p90 ($459.62),
all from device `DX01444` -- not in the account's known device list.
New-device-plus-clear-amount-anomaly is a CLEAR signal under the loaded
policy.

### Context -- `partially_explained`

Note `N00080`, logged the same morning (07:46:44), explains the *device*:
the customer upgraded their phone on the 14th, couldn't log in, and was
walked through re-registration with video KYC. It does **not** mention or
justify the transaction burst that happened hours later. This is the
specific gap the system was built to catch: the note explains why a new
device exists, not why $216,091 moved through it.

### Network -- `inconclusive`

All three of the account's devices, including the new one, are exclusive --
no shared-device signal. Merchant coincidence on the actual burst
transactions is unremarkable (low/moderate-risk merchants, 12 coincident
accounts at most). Network data neither indicts nor clears the account.

### Disposition

**Verdict: `insufficient_evidence`, confidence `medium`.** The supervisor's
reasoning states it plainly: *"Context explicitly documents that device
legitimacy does NOT address transaction legitimacy -- the four transactions
themselves remain undocumented in amount, merchant, or purpose."* Forcing
this to `legitimate` because the device is explained would be exactly the
"hiding place" the rubric warns against -- the device and the $216k burst are
two different claims, and only one of them has evidence behind it.

**Recommended action: `escalate_case`** -- given $216,091 of unexplained
exposure, this is not a case to close with no action just because it can't be
resolved automatically. What would resolve it: a note, dispute, or customer
contact addressing the four large transactions specifically, not just the
device change.
