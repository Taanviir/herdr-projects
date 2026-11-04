"use strict";

// Every letter of each word in order, anywhere in the text. A word that
// appears whole, letters that run together, and letters at the start of a
// word score higher. Null when any word does not match.

const BOUNDARY = /[\s/_\-.]/;

function scoreWord(word, text) {
  let total = 0;
  let at = -1;
  for (const char of word) {
    const found = text.indexOf(char, at + 1);
    if (found < 0) return null;
    total += found === at + 1 ? 3 : 1;
    if (found === 0 || BOUNDARY.test(text[found - 1])) total += 2;
    at = found;
  }
  if (text.includes(word)) total += word.length * 2;
  return total;
}

function score(query, text) {
  const haystack = text.toLowerCase();
  let total = 0;
  for (const word of query.toLowerCase().split(/\s+/).filter(Boolean)) {
    const points = scoreWord(word, haystack);
    if (points === null) return null;
    total += points;
  }
  return total;
}

module.exports = { score };
