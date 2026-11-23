// Checks a libFuzzer dictionary before it is handed to the fuzzer. libFuzzer
// stops at the first line it cannot parse, and Jazzer.js then exits 0, so a
// bad dictionary would otherwise look like a clean run that fuzzed nothing.
//
// The syntax libFuzzer accepts (FuzzerUtil.cpp, ParseDictionaryFile): blank
// lines, # comments, and entries of the form  name="value"  or  "value". Inside
// the quotes only \\, \" and \xHH are escapes; any other backslash is an error.
// So a literal backslash is written \\ (or \x5c), never left bare.
// An empty value is rejected here as well: it gives the mutator nothing.
const ENTRY = /^(?:[^\s"=#][^"=]*=)?"(?:[^"\\]|\\\\|\\"|\\x[0-9a-fA-F]{2})+"$/;

/** Returns one `{ line, text }` per line libFuzzer would reject (1-based). */
export function dictErrors(source) {
  const errors = [];
  source.split(/\r?\n/).forEach((raw, index) => {
    const text = raw.trim();
    if (text === '' || text.startsWith('#')) return;
    if (!ENTRY.test(text)) errors.push({ line: index + 1, text });
  });
  return errors;
}
