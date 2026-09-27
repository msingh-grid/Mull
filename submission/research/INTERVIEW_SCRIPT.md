# Interview and user-session scripts

Interview lead: **Lay Naik (PM)**. The first draft had over 40 questions.
Mohit Singh and Saaketh Koduri advised cutting it to 15–20, and Lay shared the
revised 15-question list on 23 Sep 2026; it was used on 25 Sep. The
observed-session protocol (§B) and the hypothesis table were added by Saaketh
Koduri for further sessions. Synthesis lives in [INTERVIEWS.md](INTERVIEWS.md) and
[USER_TRACES.md](USER_TRACES.md).

> Section A is the question list actually used in the interviews. Section B
> is the protocol for observed sessions.

---

## 0 · Consent (read aloud, record the answer)

> *Consent wording (confirm it matches what was said to each participant):*
> "We're a student team building a Mac app that turns speech into text and
> actions. We'd like to ask about how you write and work today. It takes about
> 25 minutes. We'll take notes; we won't record audio unless you say yes. Notes
> are anonymised — you'll be 'P3', not your name, and we won't include your
> employer's or clients' details. You can skip any question or stop at any time.
> Is that OK? And may we name you in our submission, or should you stay
> anonymous?"

Record for each participant: date · consent to notes (Y/N) · consent to audio
(Y/N) · consent to be named (Y/N) · consent to quote (Y/N).

---

## A · Stakeholder / client interview — the 15 questions as asked

These are the questions used in the interviews synthesised in
[INTERVIEWS.md](INTERVIEWS.md) (P1, P2, 25 Sep 2026). Both participants had
used the prototype (dictation, Slack messaging, the other features) before
answering.

**Current work and tools**
1. What kind of work do you usually do on your Mac, and which applications do
   you use most frequently?
2. Do you currently use AI assistants, voice dictation, voice notes, shortcuts,
   or automation tools? How do you use them?

**The current AI workflow** (H1, context friction)
3. Think about the last time you used AI to help with something already
   visible on your screen. Can you walk me through the complete process?
4. What information did you have to copy, paste, upload, or manually explain
   to the AI?
5. Which part of that workflow caused the most friction: typing, switching
   applications, providing context, reviewing the response, or applying the
   result?

**Voice** (H1)
6. Can you recall a situation where speaking your thoughts would have been
   easier or faster than typing them?
7. In which situations would you avoid using voice — for example, due to
   privacy, accuracy, workplace surroundings, or personal preference?

**Trust and control** (H2)
8. Tell me about the last time an AI assistant misunderstood your request or
   produced an incorrect result. How did you identify and correct it?
9. Before allowing AI to edit selected text or draft a reply, what would you
   need to see to feel confident approving it?
10. If Mull displayed what it heard, how it interpreted your request, and the
    exact proposed change, which of these would be most valuable to you?
11. Which actions could Mull perform without confirmation, and which should
    always require explicit approval?
12. How important would a journal and undo option be if Mull changed text or
    performed an action inside another application?

**Privacy** (H4)
13. What information would you permit Mull to access: selected text, the
    active window, or the entire screen? What information should it never
    access?

**Value and adoption** (H5)
14. After trying the prototype, which Mull workflow would be most useful in
    your regular work, and how often do you think you would use it?
15. What would prevent you from adopting or paying for Mull, and what would
    need to change for it to become valuable enough to use regularly?

**Gap found in synthesis:** no question asked for a price. For further
interviews add, after Q15: *"At what monthly price would this be a bargain /
getting expensive / too expensive? Would you pay yourself, or would your
employer?"*

---

## B · Observed user session (≈30 min, with the working app)

Goal: watch real use, not collect opinions. The observer **does not help**
unless the participant is stuck for > 60 s, and notes when help was given.

**Setup** — participant's own Mac if possible (their real apps), else a team
Mac. Note which, and which permissions they granted and where they hesitated.

**Tasks** (read one at a time; note time, errors, words used)
1. *Onboarding:* install/launch and grant permissions. Note drop-off point.
2. *Dictation:* hold ⌥Space and dictate a Slack/email reply you'd really send.
3. *Edit:* select a paragraph you wrote; hold Fn and ask Mull to change it
   ("make this shorter", "more polite"…). Do you apply or cancel the card? Why?
4. *Ask:* hold Fn and ask a question about what's on screen.
5. *Undo:* press ⌥Z after an insert. Did it do what you expected?
6. *Free use:* 5 minutes, anything you'd normally do.

**Measure per task:** success (Y / with help / N) · time · number of retries ·
which key they reached for first (⌥Space vs Fn) · exact words of any complaint.

**Debrief**
- What surprised you? What annoyed you?
- Did you trust the card before applying? What made you trust or not trust it?
- Would you keep this installed tomorrow? What would make you uninstall it?
- Same WTP question as A10, now that you've used it.

---

## Buyer and approver interviews

A separate 10-question script for the person who pays for or approves a team
tool: [BUYER_INTERVIEW_SCRIPT.md](BUYER_INTERVIEW_SCRIPT.md), hypotheses B1–B5.

## Hypotheses these scripts test

| ID | Hypothesis | Tested by | Result (after P1, P2) |
|---|---|---|---|
| H1 | Knowledge workers who write in many apps want voice input, but have tried and dropped dictation tools because of errors and cleanup cost | A2, A6–A7 | Not supported as stated: P1 and P2 never adopted voice. Reframed as H1′, where managers value it for written communication (2 of 3: P2, P3) ([INTERVIEWS](INTERVIEWS.md)) |
| H2 | Users will let an AI change text in their apps only if they can see the exact change first and undo it | A8–A12, B3, B5 | Preview supported 2/2; undo split 1/2; destination preview emerged |
| H3 | Two explicit keys (dictate vs request) are learnable in one session | B2–B4 | Early support: P3 reached for ⌥Space first for dictation, then used Fn in both modes (1 observed) |
| H4 | Local-only audio is a purchase driver | A7, A13 | Reframed: screen/data access matters more than audio |
| H5 | WTP is ~$8–15/month, with a meaningful share preferring one-time or BYOK | A15 | Unvalidated on price; value framed as time saved; team licence preferred (1/2) |
| H6 | Permission onboarding is the biggest drop-off | B1 | Untested — needs observed sessions |
