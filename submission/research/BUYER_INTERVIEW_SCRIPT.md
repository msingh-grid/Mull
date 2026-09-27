# Buyer / stakeholder interview — script

Owner: Saaketh Koduri (Sales) · ~20 minutes · one interviewee at a time.

**Why this script exists.** Both users we interviewed said adoption is decided
above them. P2: "a team license would be easier to justify than paying
personally", and Mull "has to pass our security review and respect client
data restrictions" ([INTERVIEWS.md](INTERVIEWS.md), trace T4). So the next
interview is with the person who **pays for** or **approves** a tool like
this, not the person who uses it.

**Who to interview** (one or two of these):

- a team lead or delivery head who approves tool spend for 5–30 people;
- an IT / information-security reviewer who signs off desktop apps;
- a practice or account head whose client contracts limit where data can go.

Do **not** demo before Q4. Buyers anchor on the demo, and we want their
buying rules first.

---

## Consent (read aloud, record the answer)

> "We're a student team building a Mac app that turns speech into text and
> previewed actions. We'd like to ask how your team decides to buy and approve
> tools like this. About 20 minutes. We'll take notes, no recording unless you
> agree. Notes are anonymised, and we won't record your company, clients or
> colleagues by name. You can skip anything. Is that OK? May we quote you
> anonymously?"

Record: date · role (generalised) · notes Y/N · quote Y/N · named Y/N.

---

## The 10 questions

**How buying works**

1. **The last tool you approved.** Think about the last software tool your
   team started paying for. Who asked for it, who approved it, and how long
   did it take from "we want this" to people using it?
2. **Budget.** For a tool used by your team every day, whose budget does it
   come from, and above what price per person do you need someone else's
   sign-off?

**Security and data** (tests: is data handling the real gate?)

3. **The review.** What does a desktop app that reads what's on screen have to
   show before your security or IT team allows it? Which answer would be an
   instant "no"?
4. **Client data.** *(Show one slide: what Mull reads, what leaves the Mac,
   and that audio stays local.)* Would this pass for your team? Which
   applications or data would you require it to never read?

**Value and alternatives** (tests: does it beat what they already pay for?)

5. **What it replaces.** Your team already has AI tools. What would this need
   to do that they can't, for you to pay for it on top?
6. **Proof.** Two users told us it only matters if it saves 45–60 minutes a
   day. How would you measure that during a trial, and what number would
   convince you?

*(Short demo here, 3 minutes: dictation, an edit preview, undo.)*

**Price** (tests: $15/seat team pilot, and the price metric)

7. **Price range.** For your team, per person per month: at what price would
   this be *a bargain*, *getting expensive*, and *too expensive to consider*?
8. **How to charge.** Would you rather pay per seat per month, pay per use,
   buy once per person, or have people bring their own AI key? Why?

**Pilot and blockers**

9. **Pilot.** If we offered a four-week pilot for five people, what would it
   need to include (admin controls, a data-handling document, invoicing), and
   what result at the end would make you roll it out?
10. **The blocker.** What is the single most likely reason this would *not* be
    approved at your company, even if your team loved it?

**Close:** Who else is involved in a decision like this? May we follow up
with a pilot offer?

---

## What each answer tests

| ID | Hypothesis | Questions | Decision it could change |
|---|---|---|---|
| B1 | The buyer, not the user, decides, and the budget is a team budget | Q1, Q2 | Lead with Team pilot vs individual Pro (PRICING §2) |
| B2 | Security and data-handling review is the main gate, and a clear one-pager passes it | Q3, Q4, Q10 | ROADMAP N5 (text-only default, "never read" list), N6 (data statement) |
| B3 | Buyers will pay on top of existing AI tools only for in-app context and previewed actions | Q5, Q6 | Positioning (T3, T5); what the pilot measures |
| B4 | $15/seat/month for a team is inside the acceptable range | Q7, Q8 | Team pilot price and metric; rejected-alternative check |
| B5 | A five-person, four-week pilot with admin controls is a realistic first sale | Q9 | ROADMAP X1 pilot design; pipeline |

---

## Notes template (one per interview)

| Field | Answer |
|---|---|
| ID / date / role (generalised) | B-P1 · · |
| Consent: notes / quote / named | |
| Last tool approved: who, how long (Q1) | |
| Budget owner, sign-off threshold (Q2) | |
| Security must-haves; instant "no" (Q3) | |
| Would the data slide pass? Never-read list (Q4) | |
| Must beat: which existing tools, on what (Q5) | |
| Proof metric and number (Q6) | |
| Bargain / expensive / too expensive, per seat (Q7) | $ / $ / $ |
| Preferred price metric (Q8) | |
| Pilot must-haves; rollout criterion (Q9) | |
| Most likely blocker (Q10) | |
| Who else decides; follow-up agreed? | |

## Synthesis (fill after interviews)

| Hyp. | Supported by | Contradicted by | Verdict | What changes |
|---|---|---|---|---|
| B1 | | | | |
| B2 | | | | |
| B3 | | | | |
| B4 | | | | |
| B5 | | | | |

Record results in [INTERVIEWS.md](INTERVIEWS.md) under a "Buyer interviews"
heading. Add a trace (T7…) to [USER_TRACES.md](USER_TRACES.md) for every
decision that changes, and update PRICING §3 with the price answers. Keep any
answer that contradicts us.
