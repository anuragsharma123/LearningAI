# Scoring rubric

**100 points. Due 31 August.**

---

## What this rubric refuses to reward

**Raw accuracy is not scored.** Grid-searching simple numeric rules over this
queue reaches 78% accuracy with no language model involved at all. Rewarding
accuracy would reward writing that grid search.

What is scored is whether your system **read**, whether its reasoning
**survives inspection**, and whether it **knows when it does not know**.

---

## 1 · The five requirements work (35 points)

Judged by running your system, not by reading your code.

| # | Requirement | Points | Full marks |
|:-:|---|:-:|---|
| 1 | Four specialists | 7 | Four agents. Each holds only its own domain's tools. Each has a distinct prompt. Swapping two prompts would visibly break it. |
| 2 | Wrapped as tools | 7 | The supervisor calls specialists as tools. Only the final message returns, and it carries the finding rather than a description of the work. |
| 3 | Supervisor routes only | 7 | Four tools, no database access. Ordering is deliberate: context is consulted before disposition. |
| 4 | Policy in documents | 7 | Typologies and thresholds live in editable files, loaded on demand. Editing a file changes behaviour with no code change. Demonstrate this. |
| 5 | Background queue sweep | 7 | Starting the sweep returns in under five seconds with a job id. Other questions are answered while it runs. Accounts are read in isolated contexts. |

Half marks where a requirement works with a caveat.

---

## 2 · Did it read, or did it count? (35 points)

The heart of the assignment. Graded from `CASES.md` and a sample of
`DISPOSITIONS.md`.

### 2a · Context is actually used (14 points)

| Band | Pts | What it looks like |
|---|:-:|---|
| Strong | 14 | Dispositions cite the case note or dispute that decided them, by content. "Travel notice filed 9 days before the flagged transactions" appears in the reasoning. |
| Adequate | 9 | Notes are consulted but summarised vaguely. "Customer had contacted us previously." |
| Weak | 4 | Notes are mentioned as having been checked, with nothing drawn from them. |
| Absent | 0 | Reasoning references only amounts, counts and rule ids. |

### 2b · The lookalike pairs are separated (12 points)

The queue contains matched pairs: the same signature, one fraud, one not.
A new device with high-value spend is account takeover *and* somebody who
bought a new phone. Six foreign transactions in an hour is a card spree *and*
a family holiday.

| Band | Pts | What it looks like |
|---|:-:|---|
| Strong | 12 | Both members of at least two such pairs are called correctly, and the reasoning names the deciding evidence. |
| Adequate | 7 | One pair separated correctly. |
| Weak | 3 | Pairs are called identically because the signature is identical. |
| Absent | 0 | No evidence the distinction was noticed. |

### 2c · Uncertainty is honest (9 points)

About 30% of the difficult cases cannot be resolved from what is on file.

| Band | Pts | What it looks like |
|---|:-:|---|
| Strong | 9 | *Needs more information* is used where the file is genuinely silent, and each such case names what would resolve it. |
| Adequate | 5 | Used, but as a general hedge rather than for specific gaps. |
| Weak | 2 | Never used, so every case is forced into a binary. |
| Absent | 0 | Used on most of the queue, which is a refusal to decide. |

---

## 3 · Are the dispositions defensible? (20 points)

| | Pts | Full marks |
|---|:-:|---|
| Evidence is traceable | 6 | Every claim resolves to a row in the database. Transaction ids, note ids, amounts that match. |
| Nothing invented | 5 | No fabricated amounts, dates, merchant names or customer statements. Spot-checked against the data. |
| Severity is proportionate | 5 | Card blocks are reserved for cases where money is still moving. A confirmed one-off does not get the same response as an active takeover. |
| Approval respected | 4 | No irreversible action taken before sign-off. Rejections are honoured, not retried. |

---

## 4 · Write-up (10 points)

`WRITEUP.md`, one page.

| Band | Pts | What it looks like |
|---|:-:|---|
| Strong | 10 | Reports the measured token cost of the sweep, estimates the single-agent figure, and dissects one case the system got wrong: which specialist saw the deciding evidence, and why it did not reach the supervisor. |
| Adequate | 6 | Token numbers present, weakness described generally. |
| Weak | 3 | Describes what was built. |
| Absent | 0 | Missing, or claims everything worked. |

---

## Deductions

| | |
|---|:-:|
| Database modified | -20 |
| Network call at run time beyond the model API | -10 |
| Supervisor queries the database directly | -8 |
| Irreversible action taken without approval | -8 |
| Fewer than four specialists | -6 |

---

## Grade bands

| Total | | Means |
|---|:-:|---|
| 85 to 100 | **A** | Architecture sound, reasoning defensible, knows its limits |
| 70 to 84 | **B** | Architecture sound, reasoning thin in places |
| 55 to 69 | **C** | System runs end to end, one requirement missing |
| 40 to 54 | **D** | Specialists and supervisor work, sweep or approval absent |
| below 40 | **F** | Does not run end to end |

---

## Before you submit

- [ ] I can name the case note that decided at least five of my dispositions
- [ ] I found at least one pair with the same signature and opposite verdicts
- [ ] Every number in `CASES.md` can be found in the database
- [ ] *Needs more information* names what would resolve it, every time
- [ ] A specialist's final message alone tells the supervisor what it found
- [ ] Starting the sweep returns immediately
- [ ] I measured my sweep's token count and wrote it down
