# Data reference

`data/sentinel.db`, SQLite, 17.6 MB. Everything is local.

**Today is 2 March 2026.** Nothing is dated after it. The alert queue was
generated over the preceding weekend.

---

## The queue

### alerts, 411 rows
What the rules engine flagged. This is your work list.

| Column | Notes |
|---|---|
| `alert_id` | `AL0142` |
| `account_id` | the flagged account |
| `rule_id` | which rule fired, joins to `rules` |
| `triggered_at` | timestamp |
| `severity` | `high` or `medium` |
| `trigger_txn_id` | the transaction that tripped it |
| `status` | all `open` |

276 distinct accounts. Some are flagged by more than one rule.

### rules, 8 rows
`rule_id`, `name`, `description`

Read the descriptions. They tell you what each rule is looking for, which tells
you what a false positive of that rule looks like.

---

## Money movement

### transactions, 108,249 rows
| Column | Notes |
|---|---|
| `txn_id`, `account_id`, `card_id`, `merchant_id`, `device_id` | |
| `ts` | `YYYY-MM-DDTHH:MM:SS` |
| `amount` | in rupees |
| `channel` | `card_present`, `ecom`, `app` |
| `ip_country` | `IN` is home |
| `auth_result` | `approved` or `declined` |

Four months of history. Most of it is ordinary spending, which is the point:
you need a baseline before you can call something abnormal.

### merchants, 400 rows
`merchant_id`, `name`, `category`, `country`, `risk_score`

Categories include `crypto`, `giftcard` and `moneytransfer`, which carry
higher risk scores. They are also used by legitimate customers.

---

## People and devices

### customers, 1,200 rows
`customer_id`, `full_name`, `email`, `phone`, `signup_date`, `home_country`,
`kyc_level`, `segment`

Segments: `retail`, `affluent`, `student`, `business`. Segment drives the
credit limit and the normal spending pattern.

### accounts, 1,200 rows
`account_id`, `customer_id`, `opened_date`, `product`, `status`, `credit_limit`

### cards, 1,458 rows
`card_id`, `account_id`, `last4`, `issued_date`, `status`

### devices, 1,520 rows and customer_devices
`devices(device_id, os, device_type, first_seen)`
`customer_devices(customer_id, device_id, first_seen, last_seen)`

**16 devices are shared between customers.** Some of those are mule rings.
Some are married couples with a family tablet. Sharing a device is a signal,
not an answer.

---

## The free text

This is where the answer usually is.

### case_notes, 260 rows
`note_id`, `customer_id`, `created_at`, `author`, `channel`, `note`

Written by staff after speaking to the customer. Travel notices, device
changes, explanations of unusual spending, and customers reporting that they
did not make a transaction.

### disputes, 86 rows
`dispute_id`, `txn_id`, `filed_at`, `reason_code`, `customer_statement`, `status`

The customer's own words about a transaction they are challenging. Note that
disputing a charge is not proof of fraud: some are chargebacks over undelivered
goods, and some are a family member using the card.

### prior_cases, 200 rows
`case_id`, `customer_id`, `opened_date`, `closed_date`, `outcome`, `summary`

Previous investigations. `outcome` is `confirmed_fraud`, `false_positive` or
`insufficient_evidence`. A customer with three prior false positives is
different from one with a confirmed compromise last year.

---

## Two things worth knowing before you start

**No rule is reliable.** True positive rates by rule, measured:

| Rule | Fired | True positive |
|---|---:|---:|
| R01 Velocity spike | 66 | 59% |
| R07 Night time high value | 37 | 59% |
| R08 Limit approach | 47 | 51% |
| R04 Card testing pattern | 49 | 45% |
| R05 High risk merchant burst | 41 | 44% |
| R03 Impossible travel | 83 | 24% |
| R02 New device high value | 88 | 23% |

Every rule fires on both fraud and legitimate customers. You cannot shortcut
this by trusting a rule.

**The transaction table does not contain a fraud label.** There is no column to
select. The ground truth is held separately and used to grade you.

---

<sub>Synthetic data generated for teaching. Amounts follow Benford's law and
transaction times follow a realistic diurnal curve, so exploratory analysis
behaves the way it would on real payment data. No real customers exist here.</sub>
