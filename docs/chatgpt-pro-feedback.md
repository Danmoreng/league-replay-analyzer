The biggest new insight I would pursue is this:



\*\*`241-0x02` and `241-0x04` should be tested first as fixed 10-participant table records, not as arbitrary token streams.\*\*



The reason is simple but important: \*\*241 = 1 + 10 × 24\*\*.



That shape is suspiciously aligned with League’s 10 participants. A plausible first-pass grammar is:



```text

241-byte payload

&#x20; byte 0       = table kind / opcode / subtype, e.g. 0x02 or 0x04

&#x20; bytes 1-240  = 10 fixed rows × 24 bytes each

```



That does not prove participant identity, but it gives you a much better hypothesis than “random enriched family.” It suggests `241-0x02` and `241-0x04` may be compact per-participant state/update tables, possibly with six 4-byte fields per participant row, twelve 2-byte fields, or a mixed layout.



I would make that the next focused decoding target.



\---



\## 1. Reinterpret the recurring byte patterns carefully



The repeated sequence:



```text

F1 00 02 00

```



is very likely \*\*not semantic API data by itself\*\*.



`F1 00` is little-endian `0x00F1 = 241`.



Given the family key `241-0x02`, this may simply be:



```text

F1 00        length = 241

02           first payload byte

00 ...       second payload byte / start of payload

```



Likewise:



```text

C7 19 F1 00 02 00 C7 C1

```



may be a neighborhood-boundary pattern:



```text

C7 19        previous tiny 2-byte record payload, maybe family 2-0xC7

F1 00        next record length = 241

02 00 C7 C1  start of 241-byte payload

```



So before treating `F1 00 02 00` or `C7 19 F1 00...` as an internal grammar, the next script should explicitly distinguish:



```text

recordStartOffset

lengthFieldOffset

payloadStartOffset

payloadLength

payloadEndOffset

headerHex

payloadHexPreview

```



Right now, the top recurring sequences may be telling you more about \*\*subrecord framing\*\* than about game semantics.



That is still valuable. It may reveal local compound structures like:



```text

2-0xC7 -> 241-0x02 -> 241-0x04 -> ...

```



or:



```text

small delimiter/control record -> fixed 10-row table -> companion table

```



\---



\## 2. Ranked grammar hypotheses for `241-0x02`



I would rank the hypotheses like this.



\### Hypothesis A: fixed 10-participant table



This is the strongest first hypothesis.



Shape:



```text

byte 0       table kind, e.g. 0x02

row 0        24 bytes

row 1        24 bytes

...

row 9        24 bytes

```



Possible interpretations:



```text

10 participants × 6 uint32

10 participants × 6 int32

10 participants × 6 float32

10 participants × 12 uint16

10 participants × mixed 24-byte struct

```



Why it is promising:



```text

241 = 1 + 10 \* 24

```



That is too clean to ignore.



Tests:



1\. Split every `241-0x02` payload into ten 24-byte rows after byte 0.

2\. Track each row index across chunks in the same replay.

3\. Check whether row `i` changes smoothly over time compared with row `j`.

4\. Interpret each 24-byte row as:



&#x20;  \* six little-endian `u32`

&#x20;  \* six little-endian `i32`

&#x20;  \* six little-endian `f32`

&#x20;  \* twelve little-endian `u16`

&#x20;  \* mixed layouts

5\. Look for fields with League-like ranges:



&#x20;  \* level: `1..18`

&#x20;  \* map position: roughly `0..16000`

&#x20;  \* gold/XP/damage/minions: non-negative, often monotonic or mostly monotonic

&#x20;  \* booleans/flags: low-cardinality values

&#x20;  \* IDs: stable high-ish integers per row



This could become the first real path toward non-final participant-frame metrics.



\### Hypothesis B: fixed participant table plus companion table



`241-0x02` and `241-0x04` having the same length is also suspicious.



They may be two variants of the same row structure:



```text

241-0x02 = participant scalar/update table A

241-0x04 = participant scalar/update table B

```



or:



```text

241-0x02 = previous state

241-0x04 = current state

```



or:



```text

241-0x02 = table for one team/side/category

241-0x04 = table for another category

```



The neighborhood artifact should check whether they appear near each other, in a stable order, and with similar chunk/interval distribution.



\### Hypothesis C: compound record group with tiny delimiters



The tiny family `2-0xC7` may be a control token, delimiter, local opcode, or group marker.



The sequence:



```text

2-0xC7 -> 241-0x02

```



would be especially interesting if it repeats across chunks and replays.



This would suggest that the actual grammar is not just individual records, but local groups such as:



```text

\[group marker]

\[table A]

\[table B]

\[bulk payload]

\[terminator]

```



So the neighborhood script should aggregate k-grams of family keys, not just immediate previous/next counts.



Example signatures to count:



```text

prev2, prev1, target, next1, next2

prev1, target, next1

target, next1

prev1, target

```



\### Hypothesis D: object-delta packet



A 24-byte row could be an object/entity delta row rather than a participant row.



For example:



```text

entityId

fieldMask

valueA

valueB

valueC

flags

```



This would still be useful. If there are exactly ten rows, those entities may still be champion-controlled units, but you would need to prove that using ROFL-only evidence.



\### Hypothesis E: bit-packed update set



Possible, but I would not test this first.



A true bit-packed structure usually produces less clean `1 + 10 × 24` sizing unless the game engine deliberately emits fixed-size rows.



\### Hypothesis F: protobuf-like / varint-like payload



Less likely as the top-level format.



The repeated `F1 00` looks more like a little-endian length field than a protobuf tag/value pattern. You can still run a varint parser as a negative check, but I would not prioritize it.



\---



\## 3. What the neighborhood artifact should capture



Your proposed artifact is exactly the right next step, but I would expand it slightly.



Suggested schema:



```json

{

&#x20; "schema": "rofl-reconstruction-target-neighborhood/v1",

&#x20; "familyKey": "241-0x02",

&#x20; "mode": "offline-decoder-target-neighborhood",

&#x20; "runtimeInput": false,

&#x20; "status": "decoder\_context\_only\_not\_runtime\_api\_data",

&#x20; "inputDossierPath": "artifacts-keyframes/reconstruction-target-dossier-241-0x02-16.9.json",

&#x20; "windowSize": 6,

&#x20; "rows": \[],

&#x20; "aggregates": {}

}

```



Each row should include more than just family keys:



```json

{

&#x20; "replayId": "EUW1-7843571343",

&#x20; "chunkId": 8,

&#x20; "targetOffset": 12345,

&#x20; "targetIndex": 17,

&#x20; "targetFamilyKey": "241-0x02",



&#x20; "recordStartOffset": 12343,

&#x20; "lengthFieldOffset": 12343,

&#x20; "payloadStartOffset": 12345,

&#x20; "payloadLength": 241,

&#x20; "payloadEndOffset": 12586,



&#x20; "previous": \[],

&#x20; "target": {

&#x20;   "index": 17,

&#x20;   "offset": 12345,

&#x20;   "length": 241,

&#x20;   "firstByte": "0x02",

&#x20;   "familyKey": "241-0x02",

&#x20;   "headerHex": "f100",

&#x20;   "hexPreview": "...",

&#x20;   "hexSuffix": "..."

&#x20; },

&#x20; "next": \[],



&#x20; "centeredFamilySequence": \[

&#x20;   "2-0xC7",

&#x20;   "241-0x02",

&#x20;   "241-0x04"

&#x20; ]

}

```



The important addition is that the artifact should preserve enough information to answer:



```text

Is F1 00 part of the payload, or is it the length prefix immediately before the payload?

```



That distinction matters a lot.



\---



\## 4. Add a table-shape analyzer immediately after the neighborhood script



I would add this as a separate offline script:



```bash

npm run analyze:reconstruction-target-table -- --family-key 241-0x02 --row-count 10 --row-size 24

npm run analyze:reconstruction-target-table -- --family-key 241-0x04 --row-count 10 --row-size 24

```



Suggested artifact:



```text

artifacts-keyframes/reconstruction-target-table-analysis-241-0x02-16.9.json

```



Suggested schema:



```json

{

&#x20; "schema": "rofl-reconstruction-target-table-analysis/v1",

&#x20; "familyKey": "241-0x02",

&#x20; "mode": "offline-decoder-target-table-analysis",

&#x20; "runtimeInput": false,

&#x20; "status": "decoder\_hypothesis\_only\_not\_runtime\_api\_data",

&#x20; "hypothesis": {

&#x20;   "payloadLength": 241,

&#x20;   "headerBytes": 1,

&#x20;   "rowCount": 10,

&#x20;   "rowSize": 24

&#x20; },

&#x20; "rows": \[],

&#x20; "fieldInterpretations": \[],

&#x20; "coherenceScores": {}

}

```



For every sampled record, split it like this:



```js

const tableKind = payload\[0];

const rows = \[];



for (let i = 0; i < 10; i++) {

&#x20; const start = 1 + i \* 24;

&#x20; const row = payload.subarray(start, start + 24);

&#x20; rows.push(row);

}

```



Then emit candidate interpretations per row:



```text

u16\[12]

i16\[12]

u32\[6]

i32\[6]

f32\[6]

bytes\[24]

```



For each offset/column, calculate:



```text

min

max

distinct count

zero count

monotonicity by row over chunks

small-integer likelihood

map-coordinate likelihood

float-likelihood

stable-id likelihood

```



The most important score is \*\*row coherence over time\*\*:



```text

For each row index i, is row i in chunk N+1 more similar to row i in chunk N than to other rows?

```



If yes, the rows are probably stable entity/participant tracks.



That can be tested without Riot API data.



\---



\## 5. How to test whether rows are participants without overfitting



Do not start by asking:



```text

Does row 0 equal Riot participant 1?

```



Start with ROFL-only invariants.



A row is participant-like if:



```text

there are exactly 10 rows

row tracks are stable over time

some columns are smooth or monotonic

rows persist across chunks/keyframe intervals

rows have team-like grouping, maybe 0-4 and 5-9

values are not random/filler

the same row index behaves consistently across 241-0x02 and 241-0x04

```



Then use offline Riot fixtures only as validation:



```text

Does row index i correlate with participant i, roster order, team/champion order, or some stable permutation?

```



A safe progression would be:



```text

candidate\_table

candidate\_entity\_track

candidate\_participant\_track

candidate\_participant\_identity

decoded\_runtime\_field

```



Only the last stage should ever feed API-shaped runtime output.



\---



\## 6. How to analyze neighboring subrecords



For the target neighborhood artifact, I would compute these aggregates:



\### Immediate adjacency



```json

{

&#x20; "previousFamilyFrequency": {

&#x20;   "2-0xC7": 8

&#x20; },

&#x20; "nextFamilyFrequency": {

&#x20;   "241-0x04": 6,

&#x20;   "512-0x00": 2

&#x20; }

}

```



\### Centered k-grams



Example:



```json

{

&#x20; "centered3GramFrequency": {

&#x20;   "2-0xC7 > 241-0x02 > 241-0x04": 5

&#x20; },

&#x20; "centered5GramFrequency": {

&#x20;   "2-0xC7 > 241-0x02 > 241-0x04 > 512-0x00 > 61724-0x00": 2

&#x20; }

}

```



\### Offset regularity



For each target:



```text

target index within chunk

target byte offset within chunk

distance from chunk start

distance from chunk end

number of records before target

number of records after target

```



If `241-0x02` always appears at similar structural positions, it may be part of a deterministic update block.



\### Companion-family detection



Explicitly ask:



```text

Does 241-0x04 occur within +/- N records of 241-0x02?

Does 2-0xC7 occur immediately before 241-0x02?

Does 512-0x00 occur after the 241 families?

Do large 0x65-heavy families surround or contain these records?

```



This helps distinguish:



```text

standalone semantic record

member of compound update group

payload fragment

container/filler neighbor

```



\---



\## 7. Event correlation should come after neighborhood and table tests



Yes, correlate `241-0x02` occurrences with Riot API event intervals, but treat that as offline evidence only.



I would add:



```bash

npm run correlate:reconstruction-families-events -- --version-group 16.9

npm run verify:reconstruction-family-event-correlation

```



Suggested artifact:



```text

artifacts-keyframes/reconstruction-family-event-correlation-16.9.json

```



For each API interval, compute:



```text

family counts

centered k-gram counts

target table counts

target byte/value summaries

Riot event category counts

```



Labels from Riot fixture, offline only:



```text

CHAMPION\_KILL count

ITEM\_PURCHASED count

ITEM\_DESTROYED count

ITEM\_UNDO count

SKILL\_LEVEL\_UP count

WARD\_PLACED count

WARD\_KILL count

ELITE\_MONSTER\_KILL count

BUILDING\_KILL count

```



Then calculate:



```text

Spearman correlation

mutual information

precision/recall for eventful vs quiet intervals

leave-one-replay-out stability

```



Important: do not just look for “appears in eventful windows.” Almost everything may appear in eventful windows if those windows have more chunk activity. Normalize by:



```text

records per chunk

bytes per chunk

total subrecords in interval

game time

chunk count

```



A useful score is:



```text

specific\_enrichment = target\_family\_rate\_in\_category\_intervals / target\_family\_rate\_in\_all\_eventful\_intervals

```



That helps distinguish “generic activity” from “item-event-like” or “kill-event-like.”



\---



\## 8. Best first offline validation target



I would not make participant scalar metrics the first target.



The identity problem makes those easy to overclaim.



I would use this order:



\### Target 1: structural table validation



Goal:



```text

Prove or reject 241 = 1 + 10 × 24 as a stable table.

```



This is the best next target because it may unlock participant identity later.



Runtime export:



```text

none

```



Artifact status:



```text

decoder\_hypothesis\_only\_not\_runtime\_api\_data

```



\### Target 2: interval-level event count correlation



Goal:



```text

Can family/k-gram counts predict event category counts per Riot interval?

```



This is useful even without actor identity.



Runtime export:



```text

none

```



Artifact status:



```text

offline\_validation\_only\_not\_runtime\_api\_data

```



\### Target 3: non-identity-dependent API event type



The first real API-shaped runtime win should ideally be an event where actor identity can remain absent or low-confidence at first.



Possible candidates:



```text

ELITE\_MONSTER\_KILL timing/type, if decodable

BUILDING\_KILL timing/type, if decodable

objective spawn/kill marker

global event marker

```



But Riot timeline events generally want participant IDs. So you may need a temporary internal artifact before promoting to API shape.



\### Target 4: participant row identity



Only after the 10-row table hypothesis shows stable row tracks should you try mapping rows to participants.



\---



\## 9. How to infer participant identity without Riot fixtures



The safest route is not “match one metric.”



You already proved single-metric matching is dangerous.



A better model is a constrained assignment problem.



For each candidate replay-local row/entity track, build evidence from ROFL-only sources:



```text

roster order

team/champion metadata

final statsJson

keyframe row evidence

cross-metric consistency

team grouping

row continuity across chunks

possible spawn/base-side behavior

possible champion-specific stat signatures

```



Then solve a bipartite matching:



```text

candidate row/entity track -> participant slot

```



But require multi-evidence support.



A candidate assignment should only become `decoded` if it satisfies things like:



```text

same row/entity track maps consistently across multiple metrics

assignment is unique under threshold

nearest alternative is much worse

team/champion constraints are not violated

no duplicate participant assignment

holds across multiple chunks/intervals

does not rely on Riot API fixture

```



Otherwise mark:



```text

unstable\_identity

duplicate\_rejected

noisy

not\_found

```



This is where the 10-row table hypothesis could be huge. If rows are already in roster order, participant identity becomes much easier. But that must be proven, not assumed.



\---



\## 10. How to avoid false positives while still making progress



I would formalize a promotion ladder.



\### Level 0: byte evidence



```text

family appears in eventful chunks

payload has recurring bytes

```



Status:



```text

decoder\_context\_only\_not\_runtime\_api\_data

```



\### Level 1: structural hypothesis



```text

payload has stable table/record layout

fields have plausible primitive types

```



Status:



```text

decoder\_hypothesis\_only\_not\_runtime\_api\_data

```



\### Level 2: semantic candidate



```text

field appears to be position/gold/xp/event marker

validated offline on several replays

```



Status:



```text

semantic\_candidate\_offline\_only

```



\### Level 3: runtime candidate, low confidence



```text

can be decoded from ROFL only

identity or semantics still unstable

```



Exporter status:



```text

noisy

unstable\_identity

```



Do not expose as normal API value.



\### Level 4: runtime decoded



```text

ROFL-only decode

stable field meaning

stable identity mapping if needed

offline validation passes on holdout replays

negative controls fail

```



Exporter status:



```text

decoded

```



This ladder keeps you from turning “interesting bytes” into fake API parity.



\---



\## 11. How to distinguish filler/bulk payload from meaningful grammar



For the large `0x65`-dominated families, I would score them with a filler/bulk classifier.



Signals of filler/bulk/container data:



```text

long repeated byte runs

low entropy

weak correlation with event category after normalizing for chunk size

poor row/field interpretability

no stable local grammar

appears broadly in both eventful and quiet chunks

length too large or too variable without clear substructure

```



Signals of meaningful state grammar:



```text

stable length

repeated local family sequence

clean divisibility by 10 participants or known game entities

plausible primitive fields

smooth per-row changes over time

specific event-category enrichment

cross-family companion behavior

```



`241-0x02` and `241-0x04` currently look much more promising than the large `0x65` families because their length is small, fixed, and participant-count-compatible.



\---



\## 12. Keyframe baseline plus chunk deltas: practical reconstruction model



I would implement reconstruction as an event-sourced state machine, but with unknown fields allowed.



Conceptually:



```text

initial baseline from keyframe K

apply decoded chunk records between K and K+1

sample reconstructed state at Riot frame boundary

compare offline against Riot timeline frame K+1

```



Internally:



```js

state = loadKeyframeBaseline(keyframe);



for (const chunk of chunksBetweenKeyframes) {

&#x20; const records = decodeSubrecords(chunk);



&#x20; for (const record of records) {

&#x20;   const decoded = decodeKnownRecord(record);



&#x20;   if (decoded.status === "decoded") {

&#x20;     applyDelta(state, decoded);

&#x20;   } else {

&#x20;     recordUnknownEvidence(record);

&#x20;   }

&#x20; }

}



frame = sampleState(state);

```



But early on, `decodeKnownRecord` may only emit internal candidates:



```json

{

&#x20; "familyKey": "241-0x02",

&#x20; "status": "semantic\_candidate\_offline\_only",

&#x20; "hypothesis": "ten\_row\_table",

&#x20; "rows": \[...]

}

```



That should not touch `timeline.info.frames\[].participantFrames` yet.



\---



\## 13. Minimal first non-final parity win



My recommendation:



\### First real decoder win



Prove `241-0x02` / `241-0x04` are or are not 10-row tables.



This is not yet API parity, but it is the highest-leverage step.



\### First API-shaped runtime win



After that, the best first non-final runtime field would be one of:



```text

participantFrames.\* scalar from a proven 10-row table

```



only if row identity becomes stable, or:



```text

timeline event type/timestamp for a non-participant-dependent event

```



if the event grammar is easier to isolate.



Given your current blocker, I would not start with:



```text

currentGold

xp

level

position

```



unless the 10-row table hypothesis succeeds.



If it succeeds, those become much more attractive because row identity may be recoverable from stable row order plus roster/team/champion evidence.



If it fails, I would pivot to interval-level event detection and objective/event markers.



\---



\## 14. Concrete next script sequence



I would do the next work in this order:



```bash

npm run build:reconstruction-target-neighborhood -- --family-key 241-0x02

npm run verify:reconstruction-target-neighborhood -- --family-key 241-0x02

```



Then immediately:



```bash

npm run analyze:reconstruction-target-table -- --family-key 241-0x02 --row-count 10 --row-size 24

npm run analyze:reconstruction-target-table -- --family-key 241-0x04 --row-count 10 --row-size 24

npm run verify:reconstruction-target-table-analysis -- --family-key 241-0x02

npm run verify:reconstruction-target-table-analysis -- --family-key 241-0x04

```



Then:



```bash

npm run correlate:reconstruction-families-events -- --version-group 16.9

npm run verify:reconstruction-family-event-correlation

```



Only after those:



```bash

npm run infer:reconstruction-row-identity -- --family-key 241-0x02

```



The row-identity inference should remain offline and should not write runtime API values.



\---



\## 15. Suggested verifier checks



For `verify:reconstruction-target-neighborhood`:



```text

schema is correct

runtimeInput is false

status is decoder\_context\_only\_not\_runtime\_api\_data

input dossier exists

familyKey matches CLI argument

rows are non-empty

every row has target family 241-0x02

every target has previous/next windows

offsets are numeric and sorted

no Riot API fixture path is used as runtime input

artifact is deterministic

```



For `verify:reconstruction-target-table-analysis`:



```text

schema is correct

runtimeInput is false

status is decoder\_hypothesis\_only\_not\_runtime\_api\_data

payload length is 241

row hypothesis is 1 + 10 \* 24

all sampled records split cleanly into 10 rows

primitive interpretations are present

coherence scores are present

no decoded runtime fields are emitted

```



For `verify:reconstruction-family-event-correlation`:



```text

schema is correct

mode is offline validation only

Riot fixture usage is explicitly marked validation-only

no output claims decoded API parity

holdout/cross-replay metrics are present

normalization by chunk size or record count is present

```



\---



\## 16. The main recommendation



Do not jump straight from enriched family to event decoding.



First answer this:



```text

Is 241-0x02 a 1-byte header plus 10 fixed 24-byte rows?

```



That is the most important next question because it could connect three blockers at once:



```text

chunk-delta grammar

participant-frame reconstruction

participant identity linkage

```



The strongest near-term path is:



```text

neighborhood context

\-> framing confirmation

\-> 10-row table analysis

\-> row stability/coherence

\-> offline row-to-participant validation

\-> conservative runtime candidate fields

```



The project is already correctly conservative. The next useful breakthrough is likely not another broader family ranking pass; it is a narrow structural attack on `241-0x02` and `241-0x04`, especially the `241 = 1 + 10 × 24` table hypothesis.



