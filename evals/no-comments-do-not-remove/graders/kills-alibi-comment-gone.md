---
type: regex
weight: 1.5
pattern: '^(?:(?!```)[\s\S])*```[a-z]*\n(?:(?!```)[\s\S])*//[^\n]*(sleep|important|remove|risky|twice|double|queue|worker|fine for now)'
flags: i
match: not_contains
---
