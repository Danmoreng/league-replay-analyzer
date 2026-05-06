I’m basing the project-specific parts on your question sheet: local-first/offline replay analyzer, C++ parser core, 47 replay/API fixture pairs, current `16.9 | 24672-0x60-h0` candidate family, supervised JS export, and C++ candidate export with `participantIdentity: "unassigned"`. 



\## Executive answer



Your model is \*\*directionally correct\*\*: modern `.rofl` files do appear to have separate game-chunk and keyframe streams, and the keyframe concept is consistent with “seek/join/restart from here” replay semantics. Public/community notes describe chunks and keyframes as separate data retrieval units, with keyframes used for skipping back or joining later and therefore expected to contain enough state to resume playback. Modern community container documentation also describes separate stream tags for game chunks, keyframes, an initial-keyframe singleton, and a start sentinel. (\[Gist]\[1])



The biggest risk is \*\*not\*\* the container model. The biggest risk is assuming that a keyframe sparse row slot is directly “participant N” or that a correlated scalar is already the semantic field. I would treat the `24672 / 16 = 1542` structure as a \*\*component or replicated-object table\*\*, not a participant table. The likely solution is: roster metadata → player/champion selection bootstrap → network object or actor handle → component rows → decoded fields.



My recommended next move is \*\*not to abandon supervised API parity\*\*, but to stop promoting fields to “solved” until you have replay-native identity evidence. Keep supervised parity as a discovery oracle, but shift serious effort toward descriptors, handle tables, owner references, and cross-family joins.



One suspicious detail worth checking immediately: `24672` decimal is `0x6060`. Your family key says length `24672` and first byte `0x60`. That may be coincidence, but if the first two or four bytes of the payload encode `0x6060`, you may be accidentally treating an inner length/header as row data. Before relying on 1542 semantic rows, verify whether the first bytes are a self-length, count, capacity, table id, or descriptor id.



\---



\# 1–4. ROFL container and segment semantics



\## 1. Are `startup`, `keyframe`, and `chunk` conceptually correct?



\*\*Mostly yes, with naming caveats.\*\*



For modern `.rofl` files, the conceptual split between \*\*game chunks\*\* and \*\*keyframes\*\* is well supported. A modern community format note identifies the chunk region as concatenated records and describes stream tags where `0x01` is the game-chunk stream, `0x02` is the keyframe stream, `0x03` is an initial-keyframe singleton, and `0x04` is a start sentinel. It also warns that the single-byte `chunk\_type` is better understood as a time-slot-like counter, not the actual stream discriminator. (\[GitHub]\[2])



So I would use these names internally:



```text

0x01  gameChunkStream       time-sliced replay deltas / packets

0x02  keyframeStream        restartable checkpoint stream

0x03  initialKeyframeLike   bootstrap / initial checkpoint singleton

0x04  startSentinelLike     opaque start/sentinel singleton

```



Your name \*\*`startup`\*\* is acceptable as a project-level abstraction, but I would avoid implying it is an official Riot segment kind unless you can show a stable role across many files. “Startup” may be a bundle of one or more singleton streams plus early chunk/keyframe bootstrap records.



\## 2. Is `segmentId - 1 == API timeline frame index` known/expected?



\*\*Expected enough to exploit, not safe enough to enshrine.\*\*



The mapping is plausible because keyframe IDs often start at `1`, while API timeline frames are indexed from `0`. Your observation that keyframe `segmentId - 1` maps to the Riot API frame index is exactly what I would expect if keyframe 1 corresponds to the game-start frame and later keyframes correspond to periodic checkpoint frames.



But I would store this as:



```text

candidateApiFrameIndex = keyframeId - 1

```



not as a fundamental invariant.



The reason is that Match-V5 timeline frame timing has had real-world irregularity. A Riot developer-relations issue opened in January 2026 reports that, after Patch 16.1, Match-V5 timeline frames were no longer evenly spaced by exactly 60,000 ms and could have sporadic gaps. (\[GitHub]\[3])



So for validation, prefer a two-part rule:



```text

primary: keyframe ordinal ≈ API frame ordinal

secondary: decoded/replay timestamp ≈ API frame timestamp

```



And keep explicit exceptions for:



```text

final API terminal frame

remakes

pauses

short games

aborted games

timeline service anomalies

patch transition bugs

non-Summoner's Rift queues

```



\## 3. Are keyframes full snapshots, partial snapshots, or deltas?



\*\*Best model: restartable snapshots composed of component baselines, not necessarily human-readable full world dumps.\*\*



A keyframe probably contains enough replicated state for the official client to resume replay playback without replaying all prior chunks. That does not mean it contains every semantic object in a simple flat schema.



Think of a keyframe as:



```text

static data from client assets

\+ metadata / bootstrap state

\+ network object baselines

\+ component baselines

\+ current replicated properties

\+ enough timing/path state to continue from that point

```



It may omit things the client can derive from static game data, earlier startup data, deterministic simulation, or asset definitions. It may also contain values in network serialization form rather than final UI/API form.



\## 4. Do chunks carry player state deltas, event deltas, or both?



\*\*Both, and the distinction may be artificial.\*\*



In a replay stream, “state” and “event” are often different views of the same network traffic. A kill may appear as an event packet, but its consequences also appear as state changes: HP reaches zero, gold changes, XP changes, death timer changes, buffs are added/removed, scoreboard counters increment, and the actor enters a death state.



So I would expect game chunks to contain:



```text

replicated property deltas

object creation/destruction

movement/path updates

spell casts and animation/event messages

damage/heal/resource deltas

scoreboard/player-stat updates

objective/turret/minion events

possibly client-visible cosmetic/audio/UI events

```



Public older spectator notes describe chunks as normal gameplay data and keyframes as heavier state checkpoints for seeking or late joining; that model still matches what you are observing, even though old encryption/compression details are not the same as your current zstd payloads. (\[Gist]\[1])



\---



\# 5–8. Sparse family layout



\## 5. Does `16.9 | 24672-0x60-h0` with 16-byte stride and \~1542 elements sound plausible?



\*\*Yes, structurally plausible; semantically not yet proven.\*\*



`24672 / 16 = 1542` is too clean to ignore. A 16-byte stride is very plausible for any of these:



```text

four u32 fields

two u64 fields

handle + value + flags + owner

compressed vector/position pair

component row metadata

object reference + scalar payload

small fixed replicated-property record

```



But I would not yet call it a “row table” without three checks:



```text

1\. Does the first 2/4/8 bytes encode length, count, capacity, or family id?

2\. Does row 0 behave like data or like a header?

3\. Do rows preserve the same interpretation across keyframes and replays?

```



The `0x6060` coincidence is important. If the payload begins with bytes like:



```text

60 60 00 00

```



then the first dword is literally `24672` in little-endian. In that case, the true table may be:



```text

header: 4 bytes

payload: 24668 bytes

```



or:



```text

length/count prefix + packed records

```



which would break the clean 16-byte row interpretation.



\## 6. What could the 1542 rows represent?



Most likely: \*\*not players\*\*.



A row count around 1542 is plausible for:



```text

replicated network object slots

component array elements

entity/component owner mappings

property baselines

handle table entries

object-state fragments

sparse table capacity rather than active count

```



League can easily have far more than 10 active replicated things when you include champions, minions, jungle camps, wards, missiles, plants, traps, pets, turrets, inhibitors, neutral objectives, shop/scoreboard/control objects, invisible server-side helpers, and temporary spell objects.



If the table is a component store, a champion might appear in several rows across several component families:



```text

champion actor/entity row

health/stat component row

resource component row

movement/path component row

inventory component row

buff manager row

scoreboard/player-state row

visibility/team component row

```



That would also explain why HP, gold, CS, XP, and movement speed are discoverable but not necessarily colocated or directly participant-labeled.



\## 7. Should player champions occupy stable row slots?



\*\*Champion entity handles are likely stable; component row slots may or may not be.\*\*



I would separate four concepts:



```text

participantId      Riot API identity, 1..10

roster index       statsJson / metadata order

actor handle       replay-native champion/player object id

component row      row in a particular replicated component family

```



The champion actor handle is likely stable for the match, including deaths and respawns. But a component row can be stable, relocated, reused, compacted, or re-bound depending on how the serialization layer stores component arrays.



For the 10 player champions, I would expect more stability than for minions or missiles, but I would still test:



```text

Does row X persist through death/respawn?

Does row X survive champion transformation, e.g. Kayn?

Does row X preserve team/champion identity across frames?

Does row X ever become all-zero or reused for a non-champion?

Does another family contain an owner handle pointing to row X?

```



\## 8. Are high slot numbers like `480`, `489..495` entity rows, component rows, or table/index rows?



\*\*They are probably table/component indices, not participant order.\*\*



High slot numbers do not bother me. In a component table with 1542 rows, champion-related rows landing around 480 is completely plausible. A contiguous run such as `489..495` could mean:



```text

several player champion components allocated together

team or spawn-order allocation

a group of static champion/player objects after map/bootstrap objects

component rows created in load order

related score/player-state entries

```



But a contiguous run can also be a false-positive trap. Seven adjacent rows correlating with participant metrics may reflect shared game phase, team state, or a component block that includes more than champions.



A strong test is to find \*\*cross-family joins\*\*. If slot 489 in family A has a handle also referenced by row 1203 in family B, and family B has champion/team/spell signals, then slot 489 becomes meaningful. Without that, it is just a correlated row.



\---



\# 9–13. Participant identity



\## 9. Most likely replay-native way to map rows to 10 players



The likely mapping is a handle chain:



```text

metadata roster entry

&#x20; -> champion selection / player loadout bootstrap

&#x20; -> player object or client slot

&#x20; -> champion actor / network object id

&#x20; -> component owner handle

&#x20; -> component row(s)

```



I would not expect the keyframe row slot to directly equal `participantId`, roster order, or team-local order. Your own finding that keyframe sparse row slot index is not participant order is exactly what I would expect. 



The native solution should eventually look like:



```json

{

&#x20; "participantId": 7,

&#x20; "metadataRosterIndex": 6,

&#x20; "teamId": 200,

&#x20; "championId": 145,

&#x20; "championName": "KaiSa",

&#x20; "playerHandle": "0x....",

&#x20; "actorHandle": "0x....",

&#x20; "components": {

&#x20;   "stats": {"familyKey": "...", "row": 492},

&#x20;   "movement": {"familyKey": "...", "row": 811},

&#x20;   "score": {"familyKey": "...", "row": 123}

&#x20; }

}

```



That is the artifact I would aim to generate before calling participant-labeled decoding solved.



\## 10. What should you look for?



Look for all of these, in this priority order:



```text

1\. team id: 100 / 200

2\. champion id or champion internal id

3\. summoner spell ids

4\. skin id / chroma / champion skin number

5\. player slot or client id

6\. actor/network object id

7\. component-owner handle

8\. inventory/item ids

9\. ability ids or spellbook references

10\. participant-like small ids 1..10

```



Champion IDs are useful because Riot’s static data ecosystem maps champion IDs/names through Data Dragon-style data, though Data Dragon is an asset/static-data source rather than a replay schema. (\[riot-api-libraries.readthedocs.io]\[4])



Do not only search for strings. Search for:



```text

u8/u16/u32 little-endian champion ids

u16/u32 summoner spell ids

u32 team ids: 100, 200

skin ids or champion-specific skin numbers

hashed champion names / asset paths

length-prefixed strings

string-table references

handle-looking integers repeated across families

```



\## 11. Is mapping likely in startup, first keyframe, or chunks?



\*\*All three, but with different roles.\*\*



Most likely:



```text

startup / singleton streams:

&#x20; roster-ish bootstrap, game metadata, champion/loadout/static references,

&#x20; maybe object-type registry or serializer setup



first keyframe:

&#x20; initial object/component baselines,

&#x20; initial actor handles,

&#x20; starting positions/resources/stats



chunks:

&#x20; object creation/destruction,

&#x20; property deltas,

&#x20; movement/path updates,

&#x20; later evidence to confirm handle ownership

```



If startup has no plain PUUID/summoner/champion strings, that does not imply identity is absent. It may be present as ids, hashes, handles, or indirect references.



\## 12. Are player/champion objects likely linked by a handle graph?



\*\*Yes. Treat handle graph traversal as the default model.\*\*



A plausible graph:



```text

player/client slot

&#x20; -> champion actor handle

&#x20; -> spellbook component

&#x20; -> inventory component

&#x20; -> stats component

&#x20; -> movement component

&#x20; -> buff manager

&#x20; -> scoreboard/participant state

```



The keyframe table you are studying may contain only one component layer. If so, participant identity will not be in the row itself; it will be in an owner field or a different family.



\## 13. If startup has no plain identifiers, what encodings/indirections should you expect?



Expect:



```text

little-endian numeric ids

packed varints

field masks

enum values

network object ids

entity handles with generation/index bits

component owner references

string table ids

hashed asset paths

hashed script names

champion ids rather than champion names

spell ids rather than spell names

skin/chroma numeric values

team ids as 100/200 or compact enums

```



I would specifically test whether handles are bit-packed, for example:



```text

low bits: table index

high bits: generation / type / salt

```



A repeated value like:



```text

0x000001e9

```



could be both an integer and a handle index. Cross-reference frequency and co-occurrence matters more than one-off decoding.



\---



\# 14–18. Metrics and field interpretation



\## 14. Correlated raw values: fixed-point, quantized, affine, bit-packed, or component-specific?



\*\*Likely a mixture.\*\*



For promoted fields that correlate strongly with Riot API timeline stats but are not directly meaningful, I would test in this order:



```text

u8 / i8

u16 / i16

u32 / i32

f32

half-float / fp16

fixed-point Q8, Q10, Q12, Q16

scaled integer with offset

bitfield subfields

packed pair of u16 values

delta from baseline

index into a separate value table

```



Affine transforms are useful for discovery, but I would be reluctant to ship them as final decoding unless the transform is simple and invariant:



```text

decoded = raw / 100

decoded = raw / 256

decoded = raw - constant

decoded = raw \* fixedScaleFromDescriptor

```



If a metric needs a replay-local affine fit, that is a signal that you have found a correlated field, not necessarily the true semantic field.



\## 15. Are HP/mana/gold/CS stored together or split?



\*\*Expect split components.\*\*



A likely split:



```text

champion stats component:

&#x20; health, healthMax, resource, resourceMax, movementSpeed, attack stats



player/score component:

&#x20; currentGold, totalGold, level, xp, kills, deaths, assists, CS



inventory component:

&#x20; item ids, item slots, trinket, consumables



movement component:

&#x20; position, velocity/path, facing, waypoint state



buff component:

&#x20; buffs, modifiers, temporary stat changes

```



The Match-V5 timeline itself distinguishes participant-frame fields, champion stats, damage stats, gold-per-second, and event records, which is consistent with “participant state” being a composed view rather than one flat physical row. (\[Gist]\[5])



\## 16. Could `currentGold`, `totalGold`, and `xp` be event-derived rather than direct state fields?



\*\*In the API, yes; in the replay, likely both direct and derivable.\*\*



The post-game timeline can be generated from server telemetry and does not need to mirror the `.rofl` file byte-for-byte. But the official replay client needs to render scoreboard/player state when seeking, so I would expect at least some direct or baseline representation of current gold, XP/level, CS, and scoreboard-like counters.



However:



```text

totalGold may be derivable from income events

currentGold may be direct because the shop/UI needs it

xp may be direct or tied to level/XP component

CS may be direct scoreboard state and also derivable from minion-kill events

```



A good test: look for exact step changes at purchase events, level-up events, and CS increments. True current-gold should drop on item purchases. Total-gold should not.



\## 17. Health and power: champion stats, buff components, or replicated entity components?



\*\*Current health/power are probably direct replicated state; max/effective stats may be composed.\*\*



Likely layout:



```text

current health:

&#x20; direct actor/stat component field



health max:

&#x20; base stat + level growth + items + buffs, but often also replicated as effective max



current power:

&#x20; direct resource field, but resource type varies by champion



power max:

&#x20; direct for mana/energy-like resources, special-cased for fury/heat/rage/none



buffs:

&#x20; separate modifier components that explain why effective stats changed

```



For analytics, it is fine to decode the direct effective values first. You do not need to reconstruct all buffs before showing HP/mana curves.



\## 18. Movement speed and position: near each other?



\*\*Probably separate.\*\*



Movement speed is a stat. Position/path is movement/navigation state. They may share the same owner handle, but I would not expect them to be adjacent fields in the same 16-byte row.



A likely relationship:



```text

stats component row:

&#x20; movementSpeed



movement/path component row:

&#x20; current position

&#x20; path target

&#x20; waypoint list

&#x20; velocity/facing

&#x20; movement flags

```



So your discovery of movement speed in a participant-state-like family does not imply position must be nearby.



\---



\# 19–21. Position extraction



\## 19. Position in chunks only, keyframes too, or separate family?



\*\*It should exist in keyframes somewhere, but probably not in your current family.\*\*



If the official client can seek to a keyframe and resume playback, it needs champion positions or enough pathing state to reconstruct them at that checkpoint. Therefore, I would expect keyframes to contain either:



```text

current position

or current path state from which position is recoverable

or object transform/component baseline

```



But it may be in a completely different family/component stream than HP/gold/CS. Since you already have decent movement candidates in chunks, use those to identify the corresponding keyframe family:



```text

1\. Find chunk movement packet/field owner handles.

2\. Track handles backward/forward around a keyframe boundary.

3\. Search the keyframe for those handles.

4\. Decode nearby fields as position/path baselines.

```



\## 20. Position encoding: float32, fixed-point integers, or compressed path/navmesh coordinates?



\*\*Any of the three is plausible. Test all.\*\*



Riot API event/timeline positions are map coordinates such as `{x, y}` integer pairs, with examples in official-ish Match-V5 changelog snippets showing positions like `8955, 8510`. (\[Gist]\[5])



Replay/internal coordinates may be:



```text

float32 x,z world coordinates

float32 x,y,z with vertical height

u16/u16 quantized map coordinates

i16/i16 local-cell coordinates

fixed-point u32 values

path waypoint lists

navmesh/poly references plus offset

compressed deltas from previous path point

```



Practical detection strategy:



```text

Scan keyframes for pairs that:

&#x20; decode to 0..16000 under u16/u32/f32/fixed interpretations

&#x20; move smoothly across adjacent keyframes

&#x20; match chunk-derived movement owners

&#x20; respect map bounds

&#x20; jump to fountain on death/recall only when expected

```



Also test axis swaps:



```text

API x = replay x

API y = replay z

```



because game engines often use `x,z` as the horizontal plane.



\## 21. Is Riot API timeline position sampled from replay state?



\*\*Probably same broad server truth, not necessarily the same serialized bytes.\*\*



Treat Match-V5 timeline as a supervised reference, not as byte-level ground truth. The `.rofl` file, spectator/replay backend, and Match-V5 timeline likely originate from related server-side telemetry, but they can differ in:



```text

sampling cadence

rounding

interpolation

frame timestamp selection

post-processing

missing terminal frame behavior

buggy timeline frame intervals

```



This matters especially after the reported Patch 16.1 timeline interval irregularities. (\[GitHub]\[3])



\---



\# 22–25. Validation strategy



\## 22. Is comparing decoded keyframes to Riot API timeline frames valid?



\*\*Yes, as supervised discovery and regression testing.\*\*



It is a good strategy for:



```text

finding candidate fields

ranking candidate decodes

detecting patch/schema changes

building confidence across corpus

catching impossible interpretations

creating visual overlays for review

```



But it is not sufficient for final proof because the API timeline is a derived public product, not a replay schema spec.



Use it as:



```text

candidate discovery: yes

field naming: provisional

participant identity proof: no

final decode proof: no, unless replay-native evidence also exists

```



\## 23. Main false-positive traps



The biggest traps are:



```text

game-time correlation:

&#x20; many values rise over time, especially XP, total gold, level, CS



participant covariance:

&#x20; teammates share objectives, waves, fights, and death timings



champion/class covariance:

&#x20; tanks have higher HP, junglers have more jungle CS, supports have lower CS



frame-index leakage:

&#x20; keyframe ordinal itself predicts many timeline values



final-stat leakage:

&#x20; final stats can make replay-local assignment look correct without proving row identity



affine overfit:

&#x20; a linear fit can make a wrong monotonic field look impressive



API timestamp anomalies:

&#x20; frame timing may not be exactly 60 seconds on affected patches



multiple true-ish fields:

&#x20; base stat, effective stat, displayed stat, rounded API stat, and UI stat may all correlate



team/side artifacts:

&#x20; blue/red allocation order can masquerade as participant order

```



\## 24. How to distinguish true state from correlation artifacts?



I would require all of these:



```text

1\. Out-of-sample validation

&#x20;  Fit on some replays, verify on held-out replays from other patches/champions/queues.



2\. Event-edge alignment

&#x20;  HP changes exactly at damage/heal events.

&#x20;  Current gold drops exactly at purchases.

&#x20;  Level changes exactly at level-up moments.

&#x20;  CS increments exactly on minion/jungle kills.



3\. Invariants

&#x20;  0 <= health <= healthMax

&#x20;  0 <= power <= powerMax, except known special resources

&#x20;  level is integer 1..18

&#x20;  CS is integer and nondecreasing

&#x20;  totalGold is nondecreasing

&#x20;  currentGold can decrease on purchases



4\. Replay-native ownership

&#x20;  The row has an owner handle that resolves to the champion/player object.



5\. Negative controls

&#x20;  Candidate fails when compared to the wrong participant.

&#x20;  Candidate fails when frame order is shuffled.

&#x20;  Candidate fails when matched to another replay.



6\. Patch robustness

&#x20;  Same descriptor or decode rule works across same version group,

&#x20;  and schema changes are explainable when they occur.

```



\## 25. Minimal replay-native evidence before calling participant-labeled decoding solved



For me, the minimum bar is:



```text

A. participant identity:

&#x20;  roster entry -> player/champion bootstrap -> actor handle -> component row



B. row ownership:

&#x20;  candidate row contains or is referenced by a stable owner/component handle



C. metric decode:

&#x20;  raw bytes -> typed value using a fixed rule, not replay-local affine fitting



D. lifecycle correctness:

&#x20;  survives death/respawn, purchases, level-ups, recalls, transformations



E. corpus validation:

&#x20;  holds across patches and champions, with held-out replay tests



F. independence from final stats:

&#x20;  final stats are only validation, not used to assign identity

```



Until then, I would label outputs like:



```json

"participantIdentity": "api-supervised-provisional"

```



or:



```json

"participantIdentity": "replay-native-handle-confirmed"

```



rather than a single boolean.



\---



\# 26–28. Versioning



\## 26. Should family keys/slot layouts change every patch?



\*\*Assume they can change every patch; expect many to remain stable for stretches.\*\*



League replays are version-sensitive in practice, and community tooling warns that backward compatibility should not be expected. Modern `.rofl` files also carry a version string in the header, which is a strong hint that parsers should treat version as part of the schema key. (\[Docs.rs]\[6])



I would expect:



```text

container format:

&#x20; relatively stable



compression/framing:

&#x20; relatively stable but not guaranteed



packet/family ids:

&#x20; may shift by patch/build



component layouts:

&#x20; may shift when gameplay/network serialization changes



field semantics:

&#x20; often stable conceptually, unstable physically



champion/item/spell static data:

&#x20; patch-dependent

```



\## 27. Per-patch schemas or stable descriptor/table format first?



\*\*Do both, but prioritize descriptor/handle work now.\*\*



Your current supervised parity has probably reached the point of diminishing returns. It is excellent for finding candidates, but participant identity will probably not be solved by adding more affine fits.



Recommended split:



```text

60% descriptor/handle/entity graph work

25% supervised parity and regression tests

15% export/API/frontend integration

```



Maintain per-patch manifests like:



```json

{

&#x20; "versionGroup": "16.9",

&#x20; "families": {

&#x20;   "24672-0x60-h0": {

&#x20;     "status": "candidate-component-table",

&#x20;     "stride": 16,

&#x20;     "rowCount": 1542,

&#x20;     "identity": "unresolved",

&#x20;     "fields": \[...]

&#x20;   }

&#x20; }

}

```



But aim to replace them with a more stable model:



```json

{

&#x20; "componentType": "ChampionStatsLike",

&#x20; "ownerHandleOffset": 0,

&#x20; "fields": {

&#x20;   "health": {"offset": 4, "type": "u16", "scale": 0.1}

&#x20; }

}

```



\## 28. Are first byte and length enough to identify a family?



\*\*No. Use a stronger signature.\*\*



Length and first byte are useful for exploration, but too collision-prone for production. Include:



```text

versionGroup

stream tag

record/subrecord path

packet id or opcode if available

subrecord length

first 16/32 bytes

zero/nonzero mask

entropy class

stride hypothesis

element count

neighboring subrecord signatures

stable bytes mask across frames

hash of masked structural bytes

field-layout fingerprint

```



For your current family, I would define something like:



```json

{

&#x20; "versionGroup": "16.9",

&#x20; "stream": "keyframe",

&#x20; "subrecordLength": 24672,

&#x20; "firstByte": "0x60",

&#x20; "first16": "...",

&#x20; "stableMaskHash": "...",

&#x20; "strideHypotheses": \[16],

&#x20; "elementCountHypotheses": \[1542],

&#x20; "recordOrdinalContext": {

&#x20;   "previousFamily": "...",

&#x20;   "nextFamily": "..."

&#x20; }

}

```



The first byte might be data, not a family tag. Treat it as a weak clue.



\---



\# Challenge to your current assumptions



\## Assumption 1: Keyframes are minute-boundary snapshots of world/entity state.



\*\*Mostly yes, but phrase as “periodic replay checkpoints.”\*\*



“Minute-boundary” may be a practical cadence, not the semantic contract. “World/entity state” may be component baselines plus references, not a complete human-readable world dump.



\## Assumption 2: `segmentId - 1` maps to Riot API timeline frame index.



\*\*Good empirical rule; not a schema invariant.\*\*



Keep it, but validate with timestamps and tolerate irregular API timeline intervals.



\## Assumption 3: `statsJson` roster order maps to API `participantId = rosterIndex + 1`.



\*\*Likely correct for your corpus; still separate from replay-native identity.\*\*



This is useful for API/metadata joins, but it does not solve row-to-player mapping.



\## Assumption 4: Keyframe sparse row slot index is not participant order.



\*\*Strongly agree.\*\*



Treat slot index as a component/table index.



\## Assumption 5: `16.9 | 24672-0x60-h0` contains participant-state-like rows.



\*\*Likely, but maybe one component of participant state.\*\*



It may contain rows for many entities, among which player-champion/player-score rows are present.



\## Assumption 6: 16-byte stride is right.



\*\*Plausible, but re-check for an inner header.\*\*



The `24672 = 0x6060` and first byte `0x60` coincidence deserves immediate scrutiny.



\## Assumption 7: Promoted fields are real state signals but need calibration/interpretation.



\*\*Agree.\*\*



Promoted fields are probably meaningful, but raw correlated values should remain provisional until decoded by a fixed typed rule.



\## Assumption 8: Startup contains indirect roster/entity/handle mapping, not plain strings.



\*\*Agree.\*\*



Expect numeric IDs, hashes, handles, or string-table indirections.



\## Assumption 9: Final `statsJson` alone is not enough.



\*\*Strongly agree.\*\*



Final stats can validate, but cannot prove time-series identity or row ownership.



\---



\# Concrete next experiments



\## Experiment A: handle/owner discovery in the 16-byte rows



For each 16-byte row, decode as:



```text

4 x u32

4 x i32

2 x u64

4 x f32

8 x u16

mixed: u32 handle + u32 value + u32 flags + u32 value

mixed: u16/u16/u32/u32/u32

```



Then compute:



```text

which columns have repeated values across families?

which values appear as row indices?

which values appear in startup?

which values are stable across frames?

which values change exactly when ownership-relevant events happen?

which values are plausible handles with high/low bit structure?

```



The target is to find columns that behave like:



```text

ownerHandle

componentId

entityId

typeId

rowIndex

generation

flags

```



\## Experiment B: identity token scan beyond strings



For each replay, build a search set from metadata/API:



```text

team ids: 100, 200

champion ids

summoner spell ids

skin ids

item ids at game start

participant ids: 1..10

roster indices: 0..9

known final levels

known starting HP/mana/move speed from static data

```



Search in startup, initial keyframe, first normal keyframe, and first few chunks using:



```text

u8/u16/u32/i32 little-endian

varint candidates

float32 equivalents

hashed names / asset paths if you can generate likely hashes

```



Do not search only for PUUIDs or names.



\## Experiment C: cross-family owner graph



Build a graph:



```text

node: family,row

edge: row contains value also appearing in another row/family

edge: row value equals candidate handle

edge: row changes at same timestamp as another row

edge: row has same stable id across keyframes

```



Then ask:



```text

Do the 10 promoted HP/gold/CS rows cluster with 10 champion/team/spell rows?

Do those clusters persist across frames?

Can each cluster be assigned to one roster entry without API metric correlation?

```



\## Experiment D: event-edge validation



Use events rather than smooth curves:



```text

currentGold:

&#x20; should drop on item purchases



totalGold:

&#x20; should not drop



level:

&#x20; should step at LEVEL\_UP



xp:

&#x20; should increase before level-up and reset/roll according to internal representation



health:

&#x20; should hit 0 or near 0 at death moments



CS:

&#x20; should increment at minion/jungle kill moments



movementSpeed:

&#x20; should change with boots, slows, haste buffs, homeguard, dead/respawn states

```



Smooth correlation is weak evidence. Step-edge alignment is strong evidence.



\## Experiment E: keyframe-position bridge from chunk movement



Since your chunk movement candidates are stronger than keyframe position candidates, work backward:



```text

1\. Identify chunk movement owner handles.

2\. Identify the same handles in keyframes near the boundary.

3\. Search adjacent keyframe rows/families for coordinates.

4\. Validate against API position with timestamp tolerance.

```



Do not start by scanning every keyframe value for plausible coordinates; that will create many false positives.



\---



\# My direct answers to “what we need most”



\## 1. Is the keyframe model directionally correct?



\*\*Yes.\*\* Use “periodic restartable replay checkpoint” rather than “API minute frame.” The latter is a useful observed alignment, not the underlying concept.



\## 2. How to find replay-native identity?



Find the handle graph:



```text

roster/loadout -> player/client slot -> champion actor handle -> component owner -> state rows

```



The winning artifact is not a better `slotIndex -> participantId` regression. It is a replay-native map of actor/component handles to metadata roster entries.



\## 3. How should raw correlated fields be decoded?



Assume fixed schemas with typed fields, fixed-point/quantized values, bitfields, and component-specific serializers. Use affine fits only as temporary labels.



\## 4. Extend supervised parity or reverse-engineer descriptors/handles first?



Keep supervised parity, but pause promotion of new “solved” fields until identity/handle evidence exists. The next major milestone should be:



```text

participantIdentity: "replay-native-handle-confirmed"

```



not just more API-supervised metric series.



\[1]: https://gist.github.com/elreco/e532e23f9de011ea5c55da77a0033e7a "unofficial docs of the LoL Spectator API · GitHub"

\[2]: https://github.com/Toastaspiring/RoflParserLeague/blob/main/docs/ROFL\_FORMAT.md "ROFL-X/docs/ROFL\_FORMAT.md at main · Toastaspiring/ROFL-X · GitHub"

\[3]: https://github.com/RiotGames/developer-relations/issues/1129 "\[BUG] Match-V5 Timeline Frames no longer evenly spaced by 1 minute. All gametime stats impacted. · Issue #1129 · RiotGames/developer-relations · GitHub"

\[4]: https://riot-api-libraries.readthedocs.io/en/latest/ddragon.html "Data Dragon — Riot API Libraries  documentation"

\[5]: https://gist.github.com/RiotTuxedo/758ee4d88693b768a880ece93cd78663 "match-v5 · GitHub"

\[6]: https://docs.rs/lolrofl/latest/lolrofl/ "lolrofl - Rust"



